'use strict';

const LS_CLIENT_ID = 'ytlf_client_id';
const LS_VIDEOS = 'ytlf_videos';
const LS_LAST_SYNC = 'ytlf_last_sync';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// Baked-in default so friends visiting the hosted page don't need to
// paste their own OAuth client ID. A per-browser override in localStorage
// (set via the setup screen) still takes precedence.
const DEFAULT_CLIENT_ID = '1001754550036-02mep0n7rgqkm93g1hkbc0agqqtkm6qg.apps.googleusercontent.com';

let allVideos = [];
let accessToken = null;
let tokenClient = null;
let typeFilter = 'all'; // 'all' | 'video' | 'short'

const $ = (id) => document.getElementById(id);

const els = {};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

function showToast(msg, ms = 2600) {
  const t = els.toast;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
}

function getClientId() {
  const stored = (localStorage.getItem(LS_CLIENT_ID) || '').trim();
  return stored || DEFAULT_CLIENT_ID;
}

function loadCachedVideos() {
  try {
    const raw = localStorage.getItem(LS_VIDEOS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function updateSyncStatus() {
  const last = localStorage.getItem(LS_LAST_SYNC);
  if (!last) {
    els.syncStatus.textContent = '아직 동기화하지 않았어요';
    return;
  }
  const d = new Date(Number(last));
  els.syncStatus.textContent = `${d.toLocaleString('ko-KR')} 동기화`;
}

// ---------- Google OAuth ----------

function ensureTokenClient(clientId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const start = Date.now();
    (function poll() {
      if (settled) return;
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        settled = true;
        if (!tokenClient || tokenClient._clientId !== clientId) {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: SCOPE,
            callback: () => {},
          });
          tokenClient._clientId = clientId;
        }
        resolve(tokenClient);
        return;
      }
      if (Date.now() - start > 10000) {
        settled = true;
        reject(new Error('Google 로그인 스크립트를 불러오지 못했어요. 새로고침 후 다시 시도해주세요.'));
        return;
      }
      setTimeout(poll, 100);
    })();
  });
}

async function requestAccessToken() {
  const clientId = getClientId();
  if (!clientId) throw new Error('클라이언트 ID가 설정되지 않았어요.');
  const client = await ensureTokenClient(clientId);
  return new Promise((resolve, reject) => {
    client.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      accessToken = resp.access_token;
      resolve(accessToken);
    };
    try {
      client.requestAccessToken({ prompt: '' });
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- YouTube Data API ----------

async function fetchAllLiked(onProgress) {
  const videos = [];
  let pageToken;
  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', 'LL');
    url.searchParams.set('maxResults', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      let message = `요청 실패 (${res.status})`;
      try {
        const err = await res.json();
        if (err?.error?.message) message = err.error.message;
      } catch {}
      const e = new Error(message);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    for (const item of data.items || []) {
      const sn = item.snippet;
      if (!sn) continue;
      const title = sn.title || '';
      videos.push({
        videoId: sn.resourceId ? sn.resourceId.videoId : undefined,
        title,
        channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle || '',
        thumbnail: (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default || {}).url) || '',
        likedAt: sn.publishedAt,
        unavailable: title === 'Private video' || title === 'Deleted video',
      });
    }
    if (onProgress) onProgress(videos.length);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return videos;
}

// ---------- Shorts vs regular video ----------
// The YouTube Data API has no "is Short" field. oEmbed, asked about the
// /shorts/<id> URL, reports a portrait player (height > width) for Shorts and
// a landscape one for regular videos, and it allows cross-origin requests.
// Returns 'short' | 'video' | null (unknown: private/deleted or request failed).

async function probeKind(videoId) {
  const url = 'https://www.youtube.com/oembed?format=json&url=' +
    encodeURIComponent('https://www.youtube.com/shorts/' + videoId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const j = await res.json();
        if (j.width && j.height) return j.height > j.width ? 'short' : 'video';
        return null;
      }
      // 4xx (private, removed, invalid id...) will not change on retry; only 429/5xx may.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return null;
    } catch {
      // network hiccup: retry once below
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// Fills v.kind for every video. A kind never changes once known, so kinds
// already in the cache are reused and only new videos are probed.
async function classifyKinds(videos, onProgress) {
  const known = new Map();
  for (const v of allVideos) if (v.kind) known.set(v.videoId, v.kind);
  const todo = [];
  for (const v of videos) {
    v.kind = known.get(v.videoId) || null;
    if (!v.kind && !v.unavailable && v.videoId) todo.push(v);
  }
  let done = 0;
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length) {
      const v = queue.shift();
      v.kind = await probeKind(v.videoId);
      done++;
      if (onProgress) onProgress(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  return { total: todo.length, failed: todo.filter((v) => !v.kind).length };
}

// ---------- Rendering ----------

function populateChannelFilter() {
  const counts = new Map();
  for (const v of allVideos) {
    const c = v.channelTitle || '(알 수 없음)';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const prev = els.channelFilter.value;
  const names = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, 'ko'));
  els.channelFilter.innerHTML = '<option value="">모든 채널</option>' +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)} (${counts.get(n)})</option>`).join('');
  if (names.includes(prev)) els.channelFilter.value = prev;
}

function renderCard(v) {
  const a = document.createElement('a');
  a.className = 'video-card' + (v.unavailable ? ' unavailable' : '');
  if (!v.unavailable && v.videoId) {
    a.href = `https://www.youtube.com/watch?v=${v.videoId}`;
    a.target = '_blank';
    a.rel = 'noopener';
  } else {
    a.href = 'javascript:void(0)';
  }
  a.innerHTML = `
    <img class="video-thumb" src="${escapeHtml(v.thumbnail || '')}" loading="lazy" alt="" />
    <div class="video-info">
      <div class="video-title">${escapeHtml(v.title || '(제목 없음)')}</div>
      ${v.kind === 'short' ? '<span class="video-kind">SHORTS</span>' : ''}<div class="video-channel">${escapeHtml(v.channelTitle || '')}</div>
      <div class="video-date">${v.likedAt ? formatDate(v.likedAt) : ''}</div>
    </div>
  `;
  return a;
}

// "전체 / 일반 / Shorts" tabs with counts for the whole synced list.
function updateKindTabs() {
  const counts = { all: allVideos.length, video: 0, short: 0 };
  for (const v of allVideos) if (v.kind) counts[v.kind]++;
  els.kindTabs.querySelectorAll('[data-kind]').forEach((b) => {
    b.classList.toggle('on', b.dataset.kind === typeFilter);
    b.querySelector('i').textContent = counts[b.dataset.kind];
  });
}

let renderTimer = null;
function renderListDebounced() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderList, 120);
}

// The visible text inside each filter box mirrors the selected <option>.
function syncSelectText() {
  const label = (sel) => (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '');
  els.channelFilterText.textContent = label(els.channelFilter);
  els.sortSelectText.textContent = label(els.sortSelect);
}

function renderList() {
  syncSelectText();
  const q = els.searchInput.value.trim().toLowerCase();
  const channel = els.channelFilter.value;
  const sort = els.sortSelect.value;

  let filtered = allVideos.map((v, i) => Object.assign({ _i: i }, v));
  if (typeFilter !== 'all') filtered = filtered.filter((v) => v.kind === typeFilter);
  if (channel) filtered = filtered.filter((v) => (v.channelTitle || '(알 수 없음)') === channel);
  if (q) {
    filtered = filtered.filter((v) =>
      (v.title || '').toLowerCase().includes(q) || (v.channelTitle || '').toLowerCase().includes(q)
    );
  }

  switch (sort) {
    case 'oldest':
      filtered.sort((a, b) => b._i - a._i);
      break;
    case 'title':
      filtered.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
      break;
    case 'channel':
      filtered.sort((a, b) =>
        (a.channelTitle || '').localeCompare(b.channelTitle || '', 'ko') ||
        (a.title || '').localeCompare(b.title || '', 'ko')
      );
      break;
    default:
      filtered.sort((a, b) => a._i - b._i);
  }

  updateKindTabs();
  // Always the total number of liked videos, regardless of search/filter/tab.
  els.resultNum.textContent = allVideos.length;
  els.resultCount.textContent = allVideos.length ? `검색된 영상 · 총 ${allVideos.length}개` : '';

  els.videoList.innerHTML = '';
  if (!filtered.length) {
    const msg = allVideos.length
      ? '검색 결과가 없어요'
      : '좋아요한 영상이 아직 없어요.';
    els.videoList.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const v of filtered) frag.appendChild(renderCard(v));
  els.videoList.appendChild(frag);
}

// ---------- Sync flow ----------

async function performSync() {
  showScreen('screen-syncing');
  els.syncingText.textContent = '좋아요 목록을 불러오는 중...';
  els.syncingCount.textContent = '0개';
  try {
    const videos = await fetchAllLiked((count) => {
      els.syncingCount.textContent = `${count}개 불러옴`;
    });
    els.syncingText.textContent = 'Shorts / 일반 영상을 구분하는 중...';
    els.syncingCount.textContent = `${videos.length}개 불러옴`;
    const kinds = await classifyKinds(videos, (done, total) => {
      els.syncingCount.textContent = `${done} / ${total}`;
    });
    allVideos = videos;
    localStorage.setItem(LS_VIDEOS, JSON.stringify(videos));
    localStorage.setItem(LS_LAST_SYNC, String(Date.now()));
    populateChannelFilter();
    renderList();
    updateSyncStatus();
    showScreen('screen-main');
    if (kinds.total && kinds.failed > kinds.total / 2) {
      showToast('영상 종류를 확인하지 못한 항목이 많아요. 잠시 후 다시 동기화해보세요');
    } else {
      showToast(`${videos.length}개의 좋아요 영상을 불러왔어요`);
    }
  } catch (e) {
    if (e.status === 401) {
      accessToken = null;
      showToast('로그인이 만료됐어요. 다시 로그인해주세요.');
      if (allVideos.length) {
        showScreen('screen-main');
      } else {
        showScreen('screen-login');
      }
      return;
    }
    showScreen(allVideos.length ? 'screen-main' : 'screen-login');
    showToast('동기화 실패: ' + e.message);
  }
}

async function startSyncFlow() {
  try {
    if (!accessToken) await requestAccessToken();
    await performSync();
  } catch (e) {
    showToast('로그인 실패: ' + e.message);
  }
}

// Revoke the Google token and wipe everything this app stored about the
// signed-in user (cached list + last-sync time), so the next visitor on a
// shared device sees nothing.
function logout() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  localStorage.removeItem(LS_VIDEOS);
  localStorage.removeItem(LS_LAST_SYNC);
  allVideos = [];
  els.searchInput.value = '';
  els.sortSelect.value = 'recent';
  typeFilter = 'all';
  populateChannelFilter();
  renderList();
  updateSyncStatus();
  showToast('로그아웃 되었고 저장된 데이터를 삭제했어요');
  showScreen('screen-login');
}

// ---------- Setup / events ----------

function bindEvents() {
  els.clientIdInput.addEventListener('input', () => {
    els.saveClientIdBtn.disabled = !els.clientIdInput.value.trim();
  });

  els.saveClientIdBtn.addEventListener('click', () => {
    const v = els.clientIdInput.value.trim();
    if (!v) return;
    localStorage.setItem(LS_CLIENT_ID, v);
    tokenClient = null;
    accessToken = null;
    showToast('클라이언트 ID가 저장됐어요');
    showScreen(allVideos.length ? 'screen-main' : 'screen-login');
  });

  els.loginBtn.addEventListener('click', async () => {
    els.loginBtn.disabled = true;
    try {
      await requestAccessToken();
      await performSync();
    } catch (e) {
      showToast('로그인 실패: ' + e.message);
    } finally {
      els.loginBtn.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', logout);

  els.searchInput.addEventListener('input', renderListDebounced);
  els.channelFilter.addEventListener('change', renderList);
  els.sortSelect.addEventListener('change', renderList);
  els.kindTabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    typeFilter = b.dataset.kind;
    renderList();
  });
}

function init() {
  [
    'screen-setup', 'screen-login', 'screen-main', 'screen-syncing',
    'clientIdInput', 'saveClientIdBtn', 'originHint',
    'loginBtn',
    'syncStatus', 'searchInput', 'channelFilter', 'sortSelect', 'channelFilterText', 'sortSelectText', 'kindTabs', 'resultNum', 'resultCount', 'videoList', 'logoutBtn',
    'syncingText', 'syncingCount', 'toast',
  ].forEach((id) => (els[id] = $(id)));

  els.originHint.textContent = window.location.origin || els.originHint.textContent;

  const clientId = getClientId();
  const cached = loadCachedVideos();
  if (cached && cached.length) {
    allVideos = cached;
    populateChannelFilter();
    renderList();
    updateSyncStatus();
  }

  els.clientIdInput.value = clientId;
  els.saveClientIdBtn.disabled = !clientId;

  bindEvents();

  if (!clientId) {
    showScreen('screen-setup');
  } else if (allVideos.length) {
    showScreen('screen-main');
  } else {
    showScreen('screen-login');
  }
}

document.addEventListener('DOMContentLoaded', init);
