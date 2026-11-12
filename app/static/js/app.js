// 全局状态
const state = {
  currentTab: 'discover',
  category: 'popular_movie',
  region: 'all',
  page: 1,
  loading: false,
  items: [],
  totalPages: 1,
  error: null,
  config: {
    tmdb_api_key: '',
    tmdb_base_url: 'https://api.themoviedb.org',
    tmdb_image_base_url: 'https://image.tmdb.org',
    proxy: '',
    qas_base_url: 'http://localhost:5005',
    qas_token: '',
    path_movie: 'nas/movie/{片名} ({年份})',
    path_tv: 'nas/TV/{剧名} ({年份})/{剧名} - S{季数}',
    path_anime: 'nas/动画/{剧名} ({年份})/{剧名} - S{季数}',
    path_variety: 'nas/综艺/{剧名} ({年份})/{剧名} - S{季数}',
    path_doc: '纪录片/{剧名} ({年份})/{剧名} - S{季数}',
  },
  tmdbStatus: 'unknown',
  qasStatus: 'unknown',
  currentMedia: null,
  tasks: [],
  searchCandidates: [],
  magicRegex: {},
  // Auto-Pilot 低延迟流水线状态
  pilotDecision: null,
  pilotLogs: [],
  pilotError: '',
  pilotStreaming: false,
  submittingTask: false,
  drawerFilter: 'all',
  drawerSort: 'score',
  drawerItems: [],
  // 顶栏全局搜索状态
  searchQuery: '',
  isSearchMode: false,
  searchSuggestions: [],
  // 移动端全屏搜索
  mobileSearchQuery: '',
  mobileSearchItems: [],
  mobileSearchFilter: 'all',
  // 盘搜快速筛选
  searchQuickFilter: 'all',
  searchAiActive: false,
  browser: {
    baseShareUrl: '',
    currentUrl: '',
    shareTitle: '',
    candidateIndex: -1,
    breadcrumbs: [],
  },
};

// ============================================================
// 管理员密钥：从 URL / sessionStorage 读取，统一附加到 /api 请求
// ============================================================
function getAdminKey() {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlKey = (params.get('key') || params.get('admin_key') || '').trim();
    if (urlKey) {
      sessionStorage.setItem('cinenaut_admin_key', urlKey);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('key');
        url.searchParams.delete('admin_key');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      } catch (e) {}
      return urlKey;
    }
    return (sessionStorage.getItem('cinenaut_admin_key') || '').trim();
  } catch (e) {
    return '';
  }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = function (input, init = {}) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('/api/')) {
    const key = getAdminKey();
    if (key) {
      const headers = new Headers(init.headers || {});
      headers.set('X-Admin-Key', key);
      init = { ...init, headers };
    }
  }
  return nativeFetch(input, init);
};

// 工具函数：Toast 提示
function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// 模拟预览数据
const SAMPLE_DATA = {
  movie: { 片名: '星际穿越', 年份: '2014', 分辨率: '4K' },
  tv: { 剧名: '繁花', 年份: '2023', 季数: '01', 分辨率: '1080P' },
  anime: { 剧名: '死神 千年血战篇', 年份: '2022', 季数: '01', 分辨率: '1080P' },
  variety: { 剧名: '歌手2024', 年份: '2024', 季数: '01', 分辨率: '1080P' },
  doc: { 剧名: '地球脉动', 年份: '2023', 季数: '03', 分辨率: '4K' },
};

function formatTemplate(template, vars) {
  let res = template || '';
  for (const [k, v] of Object.entries(vars)) {
    res = res.replaceAll(`{${k}}`, v);
  }
  return res;
}

// 移动端侧边栏抽屉控制
function openSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sidebar-backdrop')?.classList.add('active');
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-backdrop')?.classList.remove('active');
}

// 切换 Tab
function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.nav-item[data-tab]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-tab') === tab);
  });

  document.getElementById('view-discover').style.display = tab === 'discover' ? 'block' : 'none';
  document.getElementById('view-tasks').style.display = tab === 'tasks' ? 'block' : 'none';
  document.getElementById('view-settings').style.display = tab === 'settings' ? 'block' : 'none';

  const titleMap = {
    discover: '影视发现',
    tasks: '转存任务列表',
    settings: '系统配置',
  };
  document.getElementById('topbar-title').innerText = titleMap[tab] || '影视发现';

  // 状态指示灯仅在【系统配置】界面展示，保持发现页和任务列表清爽
  const statusGroup = document.getElementById('topbar-status-group');
  if (statusGroup) {
    statusGroup.style.display = tab === 'settings' ? 'flex' : 'none';
  }

  // ArtCraft 全屏精密直尺滚动轨：仅在系统配置界面吸附展示
  const rulerRail = document.getElementById('settings-ruler-rail');
  if (rulerRail) {
    rulerRail.style.display = tab === 'settings' ? 'flex' : 'none';
  }

  closeSidebar();

  if (tab === 'discover' && state.items.length === 0) {
    loadDiscover();
  } else if (tab === 'tasks') {
    loadTasks();
  } else if (tab === 'settings') {
    loadConfig();
    checkTmdbStatusQuietly();
    checkQasStatusQuietly();
    window.requestAnimationFrame(() => {
      updateSettingsRulerRail();
      setTimeout(updateSettingsRulerRail, 50);
      setTimeout(updateSettingsRulerRail, 200);
    });
  }
}

// 更新顶栏 TMDB 状态显示
function updateTmdbBadge(status, text) {
  const dot = document.getElementById('tmdb-status-dot');
  const label = document.getElementById('tmdb-status-text');
  if (!dot || !label) return;

  dot.className = 'status-dot';
  if (status === 'online') {
    dot.classList.add('online');
    label.innerText = text || 'TMDB 正常';
  } else if (status === 'offline') {
    dot.classList.add('offline');
    label.innerText = text || 'TMDB 异常';
  } else {
    label.innerText = text || 'TMDB 未配置';
  }
}

// 更新顶栏 QAS 状态显示
function updateQasBadge(status, text) {
  const dot = document.getElementById('qas-status-dot');
  const label = document.getElementById('qas-status-text');
  if (!dot || !label) return;

  dot.className = 'status-dot';
  if (status === 'online') {
    dot.classList.add('online');
    label.innerText = text || 'QAS 在线';
  } else if (status === 'offline') {
    dot.classList.add('offline');
    label.innerText = text || 'QAS 异常';
  } else {
    label.innerText = text || 'QAS 未连接';
  }
}

// 静默按需检查 TMDB 状态
async function checkTmdbStatusQuietly() {
  if (!state.config.tmdb_api_key) {
    updateTmdbBadge('unconfigured', 'TMDB 未配置');
    return;
  }
  try {
    const res = await fetch('/api/tmdb/verify', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      updateTmdbBadge('online', `TMDB 在线 (${data.latency_ms}ms)`);
    } else {
      updateTmdbBadge('offline', 'TMDB 异常');
    }
  } catch {
    updateTmdbBadge('offline', 'TMDB 断连');
  }
}

// 静默按需检查 QAS 状态
async function checkQasStatusQuietly() {
  if (!state.config.qas_base_url) {
    updateQasBadge('unconfigured', 'QAS 未配置');
    return;
  }
  try {
    const res = await fetch('/api/qas/verify', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const cookieTip = data.has_cookie ? '账号就绪' : '无Cookie';
      updateQasBadge('online', `QAS 在线 (${cookieTip})`);
    } else {
      updateQasBadge('offline', 'QAS 异常');
    }
  } catch {
    updateQasBadge('offline', 'QAS 断连');
  }
}

// ============================================================
// 顶栏全局 TMDB 影片搜索 (Instant Search & Full Grid Search)
// ============================================================
let searchDebounceTimer = null;

function initGlobalSearch() {
  const searchInput = document.getElementById('topbar-search-input');
  const clearBtn = document.getElementById('topbar-search-clear');
  const dropdown = document.getElementById('topbar-search-dropdown');

  if (!searchInput) return;

  // 1. 输入即时防抖联想
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (clearBtn) clearBtn.style.display = val ? 'flex' : 'none';

    if (!val) {
      if (dropdown) dropdown.style.display = 'none';
      clearTimeout(searchDebounceTimer);
      return;
    }

    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      fetchSearchSuggestions(val);
    }, 280);
  });

  // 2. 键盘回车与 Esc
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = searchInput.value.trim();
      if (val) {
        executeGlobalSearch(val);
      }
    } else if (e.key === 'Escape') {
      if (dropdown) dropdown.style.display = 'none';
      searchInput.blur();
    }
  });

  // 3. 点击外部自动隐藏联想下拉
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('topbar-search-wrap');
    if (wrap && !wrap.contains(e.target)) {
      if (dropdown) dropdown.style.display = 'none';
    }
  });

  // 4. 输入框获取焦点时若有内容重新展开
  searchInput.addEventListener('focus', () => {
    const val = searchInput.value.trim();
    if (val && state.searchSuggestions && state.searchSuggestions.length > 0) {
      if (dropdown) dropdown.style.display = 'block';
    }
  });

  // 5. 全局快捷键 (/ 或 Cmd/Ctrl + K)
  document.addEventListener('keydown', (e) => {
    if (
      (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) ||
      ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'))
    ) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });
}

async function fetchSearchSuggestions(query) {
  const dropdown = document.getElementById('topbar-search-dropdown');
  const list = document.getElementById('search-dropdown-list');
  const status = document.getElementById('search-dropdown-status');
  if (!dropdown || !list) return;

  try {
    if (status) status.innerText = `正在搜索 “${query}”...`;
    dropdown.style.display = 'block';

    const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(query)}&page=1`);
    const data = await res.json();

    if (data.error) {
      list.innerHTML = `<div class="search-dropdown-empty" style="color:var(--cg-danger);">${data.error}</div>`;
      return;
    }

    const items = data.items || [];
    state.searchSuggestions = items;
    const totalResults = data.total_results || items.length;

    if (items.length === 0) {
      if (status) status.innerText = '搜索结果';
      list.innerHTML = `<div class="search-dropdown-empty">未找到相关影视作品</div>`;
      return;
    }

    if (status) status.innerText = `即时联想 (共找到 ${totalResults} 部)`;

    // 渲染前 6 条
    const previewItems = items.slice(0, 6);
    const html = previewItems
      .map((item, idx) => {
        const posterHtml = item.poster_url
          ? `<img class="search-item-poster" src="${item.poster_url}" alt="${item.title}" onerror="this.onerror=null;this.outerHTML='<div class=\\'search-item-poster-empty\\'>暂无封面</div>';">`
          : `<div class="search-item-poster-empty">暂无封面</div>`;
        const typeBadge = item.media_type === 'tv' ? '剧集' : '电影';
        const ratingText = item.rating > 0 ? `★ ${item.rating}` : '';

        return `
        <div class="search-dropdown-item" onclick="onSuggestionItemClick(${idx})" title="${item.title} (${item.year || '未知'})\n点击直接转存">
          ${posterHtml}
          <div class="search-item-info">
            <div class="search-item-top">
              <span class="search-item-title">${item.title}</span>
              <span class="search-item-badge">${typeBadge}</span>
            </div>
            <div class="search-item-meta">
              <span>${item.year || '未知年份'}</span>
              <span>•</span>
              <span>${item.genres || '综合'}</span>
              ${ratingText ? `<span>•</span><span style="color:var(--cg-badge-gold);font-weight:700;">${ratingText}</span>` : ''}
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    const footerHtml = `
      <div class="search-dropdown-footer" onclick="executeGlobalSearch('${query.replace(/'/g, "\\'")}')">
        查看全部 ${totalResults} 个搜索结果 (按 Enter) ➔
      </div>
    `;

    list.innerHTML = html + footerHtml;
  } catch (err) {
    list.innerHTML = `<div class="search-dropdown-empty">搜索请求异常: ${err.message}</div>`;
  }
}

// 点击联想候选直接弹出转存 Modal
function onSuggestionItemClick(index) {
  const item = state.searchSuggestions[index];
  if (!item) return;

  const dropdown = document.getElementById('topbar-search-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  openTransferModal(item);
}

// 执行全量搜索模式 (海报墙展现)
async function executeGlobalSearch(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return;

  const dropdown = document.getElementById('topbar-search-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  // 保证切换到影视发现 Tab
  if (state.currentTab !== 'discover') {
    switchTab('discover');
  }

  state.isSearchMode = true;
  state.searchQuery = cleanQuery;
  state.page = 1;
  state.loading = true;
  state.error = null;

  // 更新搜索横幅
  const banner = document.getElementById('search-active-banner');
  const kwLabel = document.getElementById('search-keyword-label');
  const countLabel = document.getElementById('search-count-label');
  if (banner) banner.style.display = 'flex';
  if (kwLabel) kwLabel.innerText = cleanQuery;
  if (countLabel) countLabel.innerText = '(检索中...)';

  // 将分类胶囊轻微半透明，提示当前处于搜索覆盖状态
  const filterSec = document.querySelector('.filter-section');
  if (filterSec) filterSec.style.opacity = '0.55';

  renderDiscoverState();

  try {
    const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(cleanQuery)}&page=1`);
    const data = await res.json();

    if (data.error) {
      state.error = data.error;
      state.items = [];
    } else {
      state.items = data.items || [];
      state.totalPages = data.total_pages || 1;
      state.searchTotal = data.total_results || state.items.length;
      if (countLabel) countLabel.innerText = `(共找到 ${state.searchTotal} 部作品)`;
    }
  } catch (err) {
    state.error = `搜索请求异常: ${err.message}`;
    state.items = [];
  } finally {
    state.loading = false;
    renderDiscoverList();
  }
}

// 退出搜索模式，恢复推荐流
function exitGlobalSearch(reload = true) {
  state.isSearchMode = false;
  state.searchQuery = '';
  state.searchTotal = 0;

  const searchInput = document.getElementById('topbar-search-input');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('topbar-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  const dropdown = document.getElementById('topbar-search-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  const banner = document.getElementById('search-active-banner');
  if (banner) banner.style.display = 'none';

  const filterSec = document.querySelector('.filter-section');
  if (filterSec) filterSec.style.opacity = '1';

  if (reload) {
    loadDiscover(true);
  }
}

// 清空输入框内容并重新聚焦
function clearGlobalSearchInput() {
  const searchInput = document.getElementById('topbar-search-input');
  const clearBtn = document.getElementById('topbar-search-clear');
  const dropdown = document.getElementById('topbar-search-dropdown');
  if (searchInput) {
    searchInput.value = '';
    searchInput.focus();
  }
  if (clearBtn) clearBtn.style.display = 'none';
  if (dropdown) dropdown.style.display = 'none';

  if (state.isSearchMode) {
    exitGlobalSearch(true);
  }
}

// ============================================================
// 移动端全屏搜索（B）+ 结果列表化（C）
// ============================================================
const MOBILE_RECENT_KEY = 'cinenaut_recent_searches';
const MOBILE_HOT_FALLBACK = ['庆余年', '默杀', '死侍与金刚狼', '头脑特工队2', '周处除三害', '繁花'];

let mobileSearchTimer = null;
let mobileSuggestToken = 0;
let mobileResultsToken = 0;
let mobileSuggestItems = [];
let mobileResultItems = [];

function readRecentSearches() {
  try {
    const raw = localStorage.getItem(MOBILE_RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((q) => typeof q === 'string' && q.trim()).slice(0, 8)
      : [];
  } catch (e) {
    return [];
  }
}

function saveRecentSearch(query) {
  const clean = String(query || '').trim();
  if (!clean) return;
  try {
    const list = readRecentSearches().filter((q) => q !== clean);
    list.unshift(clean);
    localStorage.setItem(MOBILE_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch (e) {}
}

function renderMobileRecent() {
  const wrap = document.getElementById('mobile-recent-wrap');
  const box = document.getElementById('mobile-recent-chips');
  if (!wrap || !box) return;
  const list = readRecentSearches();
  if (!list.length) {
    wrap.hidden = true;
    box.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  box.innerHTML = list
    .map((q) => `<button type="button" class="mobile-search-chip" data-mquery="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
    .join('');
}

function renderMobileHot() {
  const wrap = document.getElementById('mobile-hot-wrap');
  const box = document.getElementById('mobile-hot-chips');
  if (!wrap || !box) return;
  let list = (state.items || []).slice(0, 6).map((it) => it.title).filter(Boolean);
  if (!list.length) list = MOBILE_HOT_FALLBACK.slice();
  box.innerHTML = list
    .map((q) => `<button type="button" class="mobile-search-chip" data-mquery="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
    .join('');
}

function showMobileSuggestState() {
  const suggest = document.getElementById('mobile-search-suggest');
  const results = document.getElementById('mobile-search-results');
  const sugWrap = document.getElementById('mobile-suggest-wrap');
  const allBtn = document.getElementById('mobile-search-all');
  const body = document.querySelector('.mobile-search-body');
  if (suggest) suggest.hidden = false;
  if (results) results.hidden = true;
  if (sugWrap) sugWrap.hidden = true;
  if (allBtn) allBtn.hidden = true;
  if (body) body.scrollTop = 0;
  renderMobileRecent();
  renderMobileHot();
}

function openMobileSearch() {
  const overlay = document.getElementById('mobile-search-overlay');
  const input = document.getElementById('mobile-search-input');
  const clearBtn = document.getElementById('mobile-search-clear');
  if (!overlay) return;
  state.mobileSearchQuery = '';
  state.mobileSearchItems = [];
  state.mobileSearchFilter = 'all';
  clearTimeout(mobileSearchTimer);
  if (input) input.value = '';
  if (clearBtn) clearBtn.hidden = true;
  showMobileSuggestState();
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if (input) input.focus();
}

function closeMobileSearch() {
  const overlay = document.getElementById('mobile-search-overlay');
  const input = document.getElementById('mobile-search-input');
  if (overlay) overlay.hidden = true;
  if (input) input.blur();
  clearTimeout(mobileSearchTimer);
  document.body.style.overflow = '';
  mobileSuggestToken += 1;
  mobileResultsToken += 1;
}

function clearMobileSearchInput() {
  const input = document.getElementById('mobile-search-input');
  const clearBtn = document.getElementById('mobile-search-clear');
  if (input) {
    input.value = '';
    input.focus();
  }
  if (clearBtn) clearBtn.hidden = true;
  mobileSuggestToken += 1;
  showMobileSuggestState();
}

function onMobileSearchInput() {
  const input = document.getElementById('mobile-search-input');
  const clearBtn = document.getElementById('mobile-search-clear');
  const q = input ? input.value.trim() : '';
  if (clearBtn) clearBtn.hidden = !q;
  clearTimeout(mobileSearchTimer);

  // 从结果态继续编辑时，回到联想态
  const results = document.getElementById('mobile-search-results');
  const suggest = document.getElementById('mobile-search-suggest');
  if (results && !results.hidden) {
    results.hidden = true;
    if (suggest) suggest.hidden = false;
  }

  if (!q) {
    mobileSuggestToken += 1;
    showMobileSuggestState();
    return;
  }
  mobileSearchTimer = setTimeout(() => fetchMobileSuggestions(q), 280);
}

async function fetchMobileSuggestions(query) {
  const token = ++mobileSuggestToken;
  const sugWrap = document.getElementById('mobile-suggest-wrap');
  const list = document.getElementById('mobile-suggest-list');
  const allBtn = document.getElementById('mobile-search-all');
  const recent = document.getElementById('mobile-recent-wrap');
  const hot = document.getElementById('mobile-hot-wrap');
  if (recent) recent.hidden = true;
  if (hot) hot.hidden = true;
  if (sugWrap) sugWrap.hidden = false;
  if (allBtn) allBtn.hidden = true;
  if (list) list.innerHTML = '<div class="mobile-search-empty">正在搜索…</div>';

  try {
    const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(query)}&page=1`);
    const data = await res.json();
    if (token !== mobileSuggestToken) return;
    if (data.error) {
      if (list) list.innerHTML = `<div class="mobile-search-empty">${escapeHtml(data.error)}</div>`;
      return;
    }
    const items = data.items || [];
    renderMobileSuggestions(items.slice(0, 6), data.total_results || items.length);
  } catch (err) {
    if (token !== mobileSuggestToken) return;
    if (list) list.innerHTML = `<div class="mobile-search-empty">搜索异常：${escapeHtml(err.message)}</div>`;
  }
}

function renderMobileSuggestions(items, total) {
  const list = document.getElementById('mobile-suggest-list');
  const allBtn = document.getElementById('mobile-search-all');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="mobile-search-empty">未找到相关影视作品</div>';
    if (allBtn) allBtn.hidden = true;
    return;
  }
  mobileSuggestItems = items;
  list.innerHTML = items
    .map((item, idx) => {
      const poster = item.poster_url
        ? `<img class="mobile-sug-poster" src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">`
        : '<div class="mobile-sug-poster"></div>';
      const meta = `${item.year || '未知'} · ${item.genres || '影视'}`;
      const rating = item.rating > 0 ? `<span class="mobile-sug-rating">★ ${item.rating}</span>` : '';
      return `<div class="mobile-sug-row" data-midx="${idx}">
        ${poster}
        <div class="mobile-sug-info">
          <div class="mobile-sug-title">${escapeHtml(item.title)}</div>
          <div class="mobile-sug-meta">${escapeHtml(meta)}</div>
        </div>
        ${rating}
      </div>`;
    })
    .join('');
  if (allBtn) {
    allBtn.hidden = false;
    allBtn.textContent = `查看全部 ${total} 条结果 →`;
  }
}

async function submitMobileSearch() {
  const input = document.getElementById('mobile-search-input');
  const clearBtn = document.getElementById('mobile-search-clear');
  const query = input ? input.value.trim() : '';
  if (!query) return;

  saveRecentSearch(query);
  state.mobileSearchQuery = query;
  state.mobileSearchFilter = 'all';
  clearTimeout(mobileSearchTimer);
  if (clearBtn) clearBtn.hidden = false;
  if (input) input.blur();

  const suggest = document.getElementById('mobile-search-suggest');
  const results = document.getElementById('mobile-search-results');
  const list = document.getElementById('mobile-results-list');
  const meta = document.getElementById('mobile-results-meta');
  const body = document.querySelector('.mobile-search-body');
  if (suggest) suggest.hidden = true;
  if (results) results.hidden = false;
  if (body) body.scrollTop = 0;
  if (list) list.innerHTML = `<div class="mobile-search-empty">正在检索《${escapeHtml(query)}》…</div>`;
  if (meta) meta.textContent = '正在检索…';

  const token = ++mobileResultsToken;
  try {
    const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(query)}&page=1`);
    const data = await res.json();
    if (token !== mobileResultsToken) return;
    if (data.error) {
      if (list) list.innerHTML = `<div class="mobile-search-empty">${escapeHtml(data.error)}</div>`;
      if (meta) meta.textContent = '';
      return;
    }
    state.mobileSearchItems = data.items || [];
    renderMobileResults();
  } catch (err) {
    if (token !== mobileResultsToken) return;
    if (list) list.innerHTML = `<div class="mobile-search-empty">搜索异常：${escapeHtml(err.message)}</div>`;
    if (meta) meta.textContent = '';
  }
}

function mobileFilterMatch(item, filter) {
  if (filter === 'movie') return item.media_type === 'movie';
  if (filter === 'tv') return item.media_type === 'tv';
  if (filter === 'anime') return String(item.genres || '').includes('动画');
  return true;
}

function renderMobileResults() {
  const list = document.getElementById('mobile-results-list');
  const meta = document.getElementById('mobile-results-meta');
  const filters = document.getElementById('mobile-results-filters');
  if (!list) return;

  const all = state.mobileSearchItems || [];
  const filtered = all.filter((it) => mobileFilterMatch(it, state.mobileSearchFilter));
  if (meta) meta.textContent = `关键词 “${state.mobileSearchQuery}” · 共 ${filtered.length} 部`;
  if (filters) {
    filters.querySelectorAll('[data-mfilter]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mfilter === state.mobileSearchFilter);
    });
  }

  if (!filtered.length) {
    mobileResultItems = [];
    list.innerHTML = '<div class="mobile-search-empty">该筛选下没有结果，换个分类试试。</div>';
    return;
  }

  mobileResultItems = filtered;
  list.innerHTML = filtered
    .map((item, idx) => {
      const poster = item.poster_url
        ? `<img class="mobile-result-poster" src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">`
        : '<div class="mobile-result-poster"></div>';
      const typeLabel = item.media_type === 'tv' ? '剧集' : '电影';
      const rating = item.rating > 0 ? `★ ${item.rating}` : '★ 暂无';
      return `<div class="mobile-result-row" data-mridx="${idx}">
        ${poster}
        <div class="mobile-result-main">
          <div class="mobile-result-title">${escapeHtml(item.title)}</div>
          <div class="mobile-result-meta">${escapeHtml(item.year || '未知')} · ${escapeHtml(item.genres || typeLabel)}<br>${rating} · ${typeLabel}</div>
        </div>
        <button type="button" class="mobile-result-cta">转存</button>
      </div>`;
    })
    .join('');
}

function initMobileSearch() {
  const overlay = document.getElementById('mobile-search-overlay');
  const input = document.getElementById('mobile-search-input');
  if (!overlay || !input) return;

  input.addEventListener('input', onMobileSearchInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitMobileSearch();
    }
  });

  const suggestList = document.getElementById('mobile-suggest-list');
  if (suggestList) {
    suggestList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-midx]');
      if (!row) return;
      const item = mobileSuggestItems[Number(row.dataset.midx)];
      if (!item) return;
      closeMobileSearch();
      openTransferModal(item);
    });
  }

  const resultsList = document.getElementById('mobile-results-list');
  if (resultsList) {
    resultsList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-mridx]');
      if (!row) return;
      const item = mobileResultItems[Number(row.dataset.mridx)];
      if (!item) return;
      closeMobileSearch();
      openTransferModal(item);
    });
  }

  const filters = document.getElementById('mobile-results-filters');
  if (filters) {
    filters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mfilter]');
      if (!btn) return;
      state.mobileSearchFilter = btn.dataset.mfilter;
      renderMobileResults();
    });
  }

  ['mobile-recent-chips', 'mobile-hot-chips'].forEach((id) => {
    const box = document.getElementById(id);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-mquery]');
      if (!chip) return;
      if (input) input.value = chip.dataset.mquery;
      submitMobileSearch();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeMobileSearch();
  });
}

// 加载影视发现数据
async function loadDiscover(resetPage = false) {
  if (resetPage) state.page = 1;
  state.loading = true;
  state.error = null;
  renderDiscoverState();

  try {
    const url = `/api/tmdb/discover?category=${state.category}&region=${state.region}&page=${state.page}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      state.error = data.error;
      state.items = [];
    } else {
      state.items = data.items || [];
      state.totalPages = data.total_pages || 1;
    }
  } catch (err) {
    state.error = `请求接口异常: ${err.message}`;
    state.items = [];
  } finally {
    state.loading = false;
    renderDiscoverList();
  }
}

// 渲染影视发现内容
function renderDiscoverState() {
  const container = document.getElementById('media-container');
  if (state.loading) {
    container.innerHTML = `
      <div class="state-box">
        <div class="state-title">正在加载 TMDB 资源...</div>
        <div class="state-desc">通过后端加速通道连接中，请稍候</div>
      </div>
    `;
  }
}

function renderDiscoverList() {
  const container = document.getElementById('media-container');
  if (state.error) {
    container.innerHTML = `
      <div class="state-box">
        <div class="state-title" style="color: var(--cg-danger);">获取数据异常</div>
        <div class="state-desc">${state.error}</div>
        <button class="btn btn-primary" onclick="switchTab('settings')">前往配置 TMDB API 密钥</button>
      </div>
    `;
    return;
  }

  if (state.items.length === 0) {
    if (state.isSearchMode) {
      container.innerHTML = `
        <div class="state-box">
          <div class="state-title">未找到与 “${state.searchQuery}” 相关的影视作品</div>
          <div class="state-desc">请尝试精简关键词、输入原名或英文名称重新检索</div>
          <button class="btn" style="margin-top: 0.8rem;" onclick="exitGlobalSearch()">返回热门影视推荐</button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="state-box">
          <div class="state-title">未发现匹配的影视资源</div>
          <div class="state-desc">请尝试切换分类或语言过滤条件</div>
        </div>
      `;
    }
    return;
  }

  const html = state.items
    .map((item, index) => {
      const posterHtml = item.poster_url
        ? `<img class="poster-img" src="${item.poster_url}" alt="${item.title}" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'poster-empty\\'>暂无封面</div>';">`
        : `<div class="poster-empty">暂无封面</div>`;

      const typeLabel = item.media_type === 'tv' ? '剧集' : (item.media_type === 'movie' ? '电影' : '');
      const metaText = `${typeLabel ? typeLabel + ' • ' : ''}${item.genres || '影视'} (${item.year || '未知'})`;

      return `
      <div class="media-card" onclick="openTransferModal(${index})" title="${item.title} (${item.year || '未知'})\n点击转存">
        <div class="poster-wrapper">
          ${posterHtml}
          ${item.rating > 0 ? `<div class="rating-badge">★ ${item.rating}</div>` : ''}
        </div>
        <div class="card-info">
          <div class="card-title" title="${item.title}">${item.title}</div>
          <div class="card-meta">${metaText}</div>
        </div>
      </div>
    `;
    })
    .join('');

  container.innerHTML = `<div class="media-grid">${html}</div>`;
}

// ============================================================
// 转存助手弹窗交互 & 整套转存模式
// ============================================================

let patternPresetsLoaded = false;
async function loadPatternPresets() {
  const select = document.getElementById('modal-pattern');
  if (!select) return;
  try {
    const res = await fetch('/api/qas/patterns');
    const data = await res.json();
    if (data.success && data.presets && data.presets.length > 0) {
      state.magicRegex = data.magic_regex || {};
      const currentVal = select.value || '.*';
      select.innerHTML = data.presets
        .map((p) => `<option value="${p.pattern}">${p.name}</option>`)
        .join('');
      // 若 Auto-Pilot 已给出 AI 命名规则，保留它，避免异步预设加载把它覆盖掉
      if (state.currentAiRename) {
        setPilotPatternOption(state.currentAiRename.pattern, state.currentAiRename.replace);
      } else if (data.presets.some((p) => p.pattern === currentVal)) {
        select.value = currentVal;
      } else {
        select.value = '.*';
      }
      patternPresetsLoaded = true;
    }
  } catch (err) {
    console.error('加载正则预设失败:', err);
  }
}

// 子目录透传模式下拉管理与自定义输入联动
function onSubdirSelectChange() {
  const select = document.getElementById('modal-subdir');
  const customWrap = document.getElementById('modal-subdir-custom-wrap');
  const customInput = document.getElementById('modal-subdir-custom');
  if (!select) return;
  if (select.value === '__custom__') {
    if (customWrap) customWrap.style.display = 'block';
    if (customInput) customInput.focus();
  } else {
    if (customWrap) customWrap.style.display = 'none';
  }
}

function getSubdirValue() {
  const select = document.getElementById('modal-subdir');
  if (!select) return '.*';
  if (select.value === '__custom__') {
    const customInput = document.getElementById('modal-subdir-custom');
    return (customInput && customInput.value.trim()) || '.*';
  }
  return select.value || '.*';
}

function resetSubdirSelect() {
  const select = document.getElementById('modal-subdir');
  const customWrap = document.getElementById('modal-subdir-custom-wrap');
  const customInput = document.getElementById('modal-subdir-custom');
  if (select) select.value = '.*';
  if (customWrap) customWrap.style.display = 'none';
  if (customInput) customInput.value = '';
}


// ============================================================
// 智能托管 (Auto-Pilot) 与专家手动微调模式切换
// ============================================================
function isAiEnabled() {
  return !(state.config && state.config.llm_enabled === false);
}

function applyAiAvailability() {
  const enabled = isAiEnabled();
  const btnPilot = document.getElementById('tab-btn-pilot');
  if (btnPilot) btnPilot.style.display = enabled ? '' : 'none';

  if (!enabled) {
    state.transferMode = 'manual';
    const btnManual = document.getElementById('tab-btn-manual');
    if (btnManual) btnManual.classList.add('active');
    const panelPilot = document.getElementById('modal-panel-pilot');
    const panelManual = document.getElementById('modal-panel-manual');
    const modalFooter = document.getElementById('transfer-modal-footer');
    if (panelPilot) panelPilot.style.display = 'none';
    if (panelManual) panelManual.style.display = 'block';
    if (modalFooter) modalFooter.style.display = 'flex';
  }
}

function switchTransferMode(mode) {
  if (mode === 'pilot' && !isAiEnabled()) mode = 'manual';
  state.transferMode = mode;
  const btnPilot = document.getElementById('tab-btn-pilot');
  const btnManual = document.getElementById('tab-btn-manual');
  const panelPilot = document.getElementById('modal-panel-pilot');
  const panelManual = document.getElementById('modal-panel-manual');
  const modalFooter = document.getElementById('transfer-modal-footer');

  if (mode === 'manual') {
    if (btnPilot) btnPilot.classList.remove('active');
    if (btnManual) btnManual.classList.add('active');
    if (panelPilot) panelPilot.style.display = 'none';
    if (panelManual) panelManual.style.display = 'block';
    if (modalFooter) modalFooter.style.display = 'flex';
    // 复用 Auto-Pilot 已检索到的候选，避免手动模式再搜一次
    if (state.searchCandidates && state.searchCandidates.length > 0) {
      const resultsContainer = document.getElementById('modal-search-results');
      if (resultsContainer && !resultsContainer.querySelector('.search-item')) {
        renderSearchResultsList(state.searchCandidates, isAiEnabled());
      }
    }
  } else {
    if (btnPilot) btnPilot.classList.add('active');
    if (btnManual) btnManual.classList.remove('active');
    if (panelPilot) panelPilot.style.display = 'block';
    if (panelManual) panelManual.style.display = 'none';
    if (modalFooter) modalFooter.style.display = 'none';
    // 首次进入或上次失败时启动低延迟流水线；已有决策则直接渲染
    if (!state.pilotDecision && !state.pilotStreaming) {
      startPilotPipeline();
    } else {
      renderPilotDecisionCard();
    }
  }
}

// ============================================================
// Auto-Pilot 低延迟流水线：初判秒出，最终结果随后修正
// ============================================================
let pilotAbortController = null;
let taskAbortController = null;

function abortTaskExecution() {
  if (taskAbortController) {
    try { taskAbortController.abort(); } catch (e) {}
    taskAbortController = null;
  }
  state.submittingTask = false;
}

function abortPilotPipeline() {
  if (pilotAbortController) {
    try { pilotAbortController.abort(); } catch (e) {}
    pilotAbortController = null;
  }
  state.pilotStreaming = false;
  stopRulerAnimation();
}

function setPilotPatternOption(pattern, replace) {
  const apply = (sel) => {
    if (!sel) return;
    let opt = sel.querySelector('option[data-ai="true"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.setAttribute('data-ai', 'true');
      sel.appendChild(opt);
    }
    opt.value = pattern;
    opt.setAttribute('data-replace', replace);
    opt.innerText = `AI 规范重命名 (${pattern})`;
    opt.selected = true;
  };
  apply(document.getElementById('modal-pattern'));
  apply(document.getElementById('browser-pattern-select'));
}

function applyPilotDecision(data) {
  state.pilotDecision = data;
  state.pilotError = '';
  state.searchingResources = false;
  stopRulerAnimation();

  const shareInput = document.getElementById('modal-shareurl');
  const saveInput = document.getElementById('modal-savepath');
  if (shareInput && data.shareurl) shareInput.value = data.shareurl;
  if (saveInput && data.savepath) saveInput.value = data.savepath;

  if (data.pattern || data.replace) {
    state.currentAiRename = { pattern: data.pattern || '.*', replace: data.replace || '' };
    setPilotPatternOption(data.pattern || '.*', data.replace || '');
  }

  // 把真正选中的候选置于首位，避免自愈降级后仍展示原始第一条
  const sel = data.selected_resource || {};
  const chosen = {
    taskname: sel.title || data.taskname || '夸克资源',
    shareurl: data.shareurl || data.original_shareurl || '',
    ai_score: sel.score || 80,
    ai_tags: sel.tags || [],
    ai_reason: sel.reason || '',
    is_recommended: true,
    is_spam: false,
  };
  const rest = (Array.isArray(data.candidates) ? data.candidates : [])
    .filter((c) => c.shareurl !== chosen.shareurl)
    .map((c) => ({ ...c, is_recommended: false }));
  state.searchCandidates = [chosen, ...rest];

  // 让手动面板下次进入时重新渲染当前 AP 候选，而不是保留旧搜索 DOM
  const searchResults = document.getElementById('modal-search-results');
  if (searchResults) searchResults.innerHTML = '';

  renderPilotDecisionCard();
}

// 精工刻度等待态：每个阶段一个区间，阶段内按时间连续爬升，事件到达后再推进
const PILOT_RULER_RANGE = { 1: [8, 62], 2: [62, 78], 3: [78, 90], 4: [90, 98] };
const PILOT_RULER_TITLE = {
  1: { active: '正在检索全网分享源', done: '已锁定候选资源' },
  2: { active: '正在评估画质与纯净度', done: '已完成画质评分' },
  3: { active: '正在并发校验正片目录', done: '已完成目录校验' },
  4: { active: '正在生成规范命名与路径', done: '方案已就绪' },
};

let pilotRulerTimer = null;
let pilotRulerStep = 0;

function setRulerPercent(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const fill = document.getElementById('pr-fill');
  const marker = document.getElementById('pr-marker');
  const percent = document.getElementById('pr-percent');
  if (fill) fill.style.width = clamped + '%';
  if (marker) marker.style.left = clamped + '%';
  if (percent) percent.textContent = Math.round(clamped) + '%';
}

function stopRulerAnimation() {
  if (pilotRulerTimer) {
    clearInterval(pilotRulerTimer);
    pilotRulerTimer = null;
  }
  pilotRulerStep = 0;
}

function startRulerStep(step) {
  const range = PILOT_RULER_RANGE[step];
  if (!range) return;

  const percentEl = document.getElementById('pr-percent');
  const current = percentEl ? parseFloat(percentEl.textContent) || range[0] : range[0];
  const from = Math.max(range[0], Math.min(current, range[1]));
  const startTs = Date.now();
  pilotRulerStep = step;

  if (pilotRulerTimer) clearInterval(pilotRulerTimer);

  const tick = () => {
    const elapsed = (Date.now() - startTs) / 1000;
    // 8 秒时间常数：等待越久越接近本阶段上限，但不会提前到顶
    const pct = from + (range[1] - from) * (1 - Math.exp(-elapsed / 8));
    setRulerPercent(pct);
  };
  tick();
  pilotRulerTimer = setInterval(tick, 200);
}

function finishRulerStep(step) {
  if (pilotRulerTimer) {
    clearInterval(pilotRulerTimer);
    pilotRulerTimer = null;
  }
  const range = PILOT_RULER_RANGE[step];
  if (range) setRulerPercent(range[1]);
}

function updatePilotRuler(step, status, subText) {
  const stepEl = document.getElementById('pr-step');
  const statusEl = document.getElementById('pr-status');
  const titleEl = document.getElementById('pr-title');
  if (stepEl && step) stepEl.textContent = 'STEP 0' + step + ' / 04';
  if (statusEl && subText) statusEl.textContent = subText;
  const titles = PILOT_RULER_TITLE[step];
  if (titleEl && titles) titleEl.textContent = status === 'done' ? titles.done : titles.active;

  if (!step) return;
  if (status === 'error') {
    stopRulerAnimation();
  } else if (status === 'done') {
    finishRulerStep(step);
  } else if (pilotRulerStep !== step) {
    startRulerStep(step);
  }
}

function handlePilotEvent(evt) {
  if (!evt || !evt.type) return;
  if (evt.type === 'bus') {
    if (evt.sub) state.pilotPhaseText = evt.sub;
    const capsuleText = document.getElementById('capsule-running-text');
    if (capsuleText && evt.sub) capsuleText.innerText = evt.sub;
    if (evt.step) updatePilotRuler(evt.step, evt.status, evt.sub);
    return;
  }
  if (evt.type === 'node') {
    state.pilotLogs.push({ title: evt.title || '', content: evt.content || '' });
    return;
  }
  if (evt.type === 'final' && evt.data) {
    applyPilotDecision(evt.data);
    return;
  }
  if (evt.type === 'error') {
    state.pilotError = evt.message || '未能完成 Auto-Pilot 决策';
    state.searchingResources = false;
    state.pilotStreaming = false;
    stopRulerAnimation();
    renderPilotDecisionCard();
  }
}

async function startPilotPipeline() {
  const current = state.currentMedia;
  if (!current) return;
  if (!isAiEnabled()) {
    switchTransferMode('manual');
    return;
  }
  abortPilotPipeline();

  state.pilotDecision = null;
  state.pilotLogs = [];
  state.pilotError = '';
  state.searchCandidates = [];
  state.currentAiRename = null;
  state.searchingResources = true;
  state.pilotStreaming = true;
  state.pilotPhaseText = 'AI 正在全网检索优质资源...';
  state.pilotStartTs = Date.now();
  const prSub = document.getElementById('pr-sub');
  if (prSub) {
    prSub.textContent = `《${current.title || '影视'}》${current.year ? ' ' + current.year : ''} · 正在建立检索…`;
  }
  stopRulerAnimation();
  setRulerPercent(0);
  updatePilotRuler(1, 'active', '全网检索中');
  renderPilotDecisionCard();

  // 上游盘搜可能耗时 10~25 秒，用计时器让用户确认没有卡死
  const elapsedTimer = setInterval(() => {
    if (!state.pilotStreaming) return;
    const sec = Math.max(0, (Date.now() - state.pilotStartTs) / 1000);
    const el = document.getElementById('capsule-running-text');
    if (el) el.innerText = `${state.pilotPhaseText}（${Math.round(sec)}s）`;
    const prEl = document.getElementById('pr-elapsed');
    if (prEl) prEl.textContent = sec.toFixed(1).padStart(4, '0');
  }, 1000);

  const controller = new AbortController();
  pilotAbortController = controller;

  try {
    const res = await fetch('/api/qas/auto-pilot-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: current.title || '',
        year: current.year || '',
        media_type: current.media_type || 'movie',
        season: current.season || '01',
        deep: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try { handlePilotEvent(JSON.parse(raw)); } catch (e) {}
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    state.pilotError = `Auto-Pilot 连接异常: ${err.message}`;
    state.searchingResources = false;
    renderPilotDecisionCard();
  } finally {
    clearInterval(elapsedTimer);
    state.pilotStreaming = false;
    if (pilotAbortController === controller) pilotAbortController = null;
  }
}

function renderPilotDecisionCard() {
  const container = document.getElementById('pilot-decision-container');
  const skelCard = document.getElementById('pilot-skeleton-card');
  const capsuleRunning = document.getElementById('capsule-running');
  const capsuleFinished = document.getElementById('capsule-finished');
  const capsuleText = document.getElementById('capsule-running-text');
  const capsuleBody = document.getElementById('capsule-thought-body');

  if (!container) return;

  const current = state.currentMedia || {};
  const candidates = state.searchCandidates || [];
  const savePathInput = document.getElementById('modal-savepath');
  const savePath = (savePathInput && savePathInput.value) ? savePathInput.value : ('/nas/movie/' + (current.title || '影视'));

  if (state.searchingResources) {
    if (capsuleRunning) {
      capsuleRunning.style.display = 'inline-flex';
      if (capsuleText) {
        capsuleText.innerText = state.pilotPhaseText || ('AI 正在全网检索《' + (current.title || '影视') + '》优质资源...');
      }
    }
    if (capsuleFinished) capsuleFinished.style.display = 'none';
    if (skelCard) skelCard.style.display = 'block';
    container.innerHTML = '';
    return;
  }

  if (state.pilotError) {
    if (capsuleRunning) capsuleRunning.style.display = 'none';
    if (capsuleFinished) capsuleFinished.style.display = 'none';
    if (skelCard) skelCard.style.display = 'none';
    container.innerHTML = '<div class="pilot-decision-card" style="text-align:center; padding:2rem 1rem;">' +
      '<div style="font-size:0.9rem; color:var(--cg-ink); font-weight:700; margin-bottom:0.4rem;">Auto-Pilot 未完成</div>' +
      '<div style="font-size:0.78rem; color:var(--cg-ink-2); margin-bottom:1rem;">' + escapeHtml(state.pilotError) + '</div>' +
      '<div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">' +
        '<button type="button" class="pilot-btn-primary" onclick="startPilotPipeline()">重新尝试</button>' +
        '<button type="button" class="pilot-btn-secondary" onclick="switchTransferMode(\'manual\')">切换至手动微调 ➔</button>' +
      '</div>' +
      '</div>';
    return;
  }

  if (skelCard) skelCard.style.display = 'none';

  if (!candidates || candidates.length === 0) {
    if (capsuleRunning) capsuleRunning.style.display = 'none';
    if (capsuleFinished) {
      capsuleFinished.style.display = 'block';
      const summary = document.getElementById('capsule-finished-summary');
      if (summary) summary.innerText = '全网检索未发现匹配网盘资源';
    }
    container.innerHTML = '<div class="pilot-decision-card" style="text-align:center; padding:2rem 1rem;">' +
      '<div style="font-size:0.9rem; color:var(--cg-ink); font-weight:700; margin-bottom:0.4rem;">暂未自动匹配到可用夸克网盘链接</div>' +
      '<div style="font-size:0.78rem; color:var(--cg-ink-2); margin-bottom:1rem;">可点击上方【专家手动微调】手动粘贴分享链接或更改关键词检索</div>' +
      '<button type="button" class="pilot-btn-secondary" style="margin:0 auto;" onclick="switchTransferMode(\'manual\')">切换至手动微调 ➔</button>' +
      '</div>';
    return;
  }

  const best = candidates[0];
  const shareInput = document.getElementById('modal-shareurl');
  if (shareInput) shareInput.value = best.shareurl;

  if (capsuleRunning) capsuleRunning.style.display = 'none';
  if (capsuleFinished) {
    capsuleFinished.style.display = 'block';
    const isProvisional = Boolean(state.pilotDecision && state.pilotDecision.provisional);
    const summary = document.getElementById('capsule-finished-summary');
    if (summary) {
      summary.innerText = isProvisional
        ? '初判已生成，正在后台校验目录…'
        : '已完成深度推理决策：锁定最佳资源 (' + (best.ai_score ? best.ai_score + '分' : '优质推荐') + ')';
    }
    if (capsuleBody) {
      capsuleBody.innerHTML = '<div style="font-size:0.75rem; color:var(--cg-ink-2); line-height:1.6; padding:0.4rem 0;">' +
        '<div>• <strong>全网检索</strong>：共并发聚合 ' + candidates.length + ' 条网盘候选资源</div>' +
        '<div>• <strong>AI 质检</strong>：锁定最优候选 <code>' + sanitizeCleanTitle(best.taskname) + '</code></div>' +
        '<div>• <strong>落地规划</strong>：已规划目标路径并套用命名规则</div>' +
        (state.pilotDecision && state.pilotDecision.summary
          ? '<div style="margin-top:4px;color:var(--cg-ink-3);">' + escapeHtml(state.pilotDecision.summary) + '</div>'
          : '') +
        '</div>';
    }
  }

  let tagsHtml = '';
  if (best.ai_tags && best.ai_tags.length > 0) {
    tagsHtml = best.ai_tags.map(t => '<span class="ai-tag ai-tag-quality">' + escapeHtml(t) + '</span>').join(' ');
  } else {
    tagsHtml = '<span class="ai-tag ai-tag-best">智能置顶首推</span> <span class="ai-tag ai-tag-quality">优质画质</span>';
  }
  if (best.ai_score) {
    tagsHtml += ' <span class="ai-tag ai-tag-default" style="font-family:var(--font-mono);font-weight:700;">★ ' + best.ai_score + '分</span>';
  }

  container.innerHTML = '<div class="pilot-decision-card">' +
    '<span class="pilot-card-badge">AI PILOT DECISION</span>' +
    '<div>' +
      '<div class="pilot-spec-row">' +
        '<div class="pilot-spec-title">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9 12 2"/></svg>' +
          '<span title="' + sanitizeCleanTitle(best.taskname) + '">' + sanitizeCleanTitle(best.taskname) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="pilot-tags-row">' +
        tagsHtml +
      '</div>' +
    '</div>' +
    '<div class="pilot-preview-grid">' +
      '<div class="pilot-preview-box">' +
        '<span class="pilot-section-title">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
          '分享链接来源' +
        '</span>' +
        '<div class="pilot-path-badge" title="' + escapeHtml(best.shareurl) + '">' + escapeHtml(best.shareurl) + '</div>' +
      '</div>' +
      '<div class="pilot-preview-box">' +
        '<span class="pilot-section-title">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '目标网盘保存路径' +
        '</span>' +
        '<div class="pilot-path-badge" title="' + escapeHtml(savePath) + '">' + escapeHtml(savePath) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="pilot-action-row">' +
      '<button type="button" class="pilot-btn-primary" onclick="submitModalTask(true, this)">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
        '<span>立即执行转存</span>' +
      '</button>' +
      '<button type="button" class="pilot-btn-secondary" onclick="submitModalTask(false, this)">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        '<span>加入后台追更</span>' +
      '</button>' +
    '</div>' +
  '</div>';
}

async function openTransferModal(itemOrIndex) {
  const item = typeof itemOrIndex === 'number' ? state.items[itemOrIndex] : itemOrIndex;
  if (!item) return;
  state.currentMedia = item;

  // 重置上一部影片的托管状态，避免串台
  abortPilotPipeline();
  abortTaskExecution();
  state.pilotDecision = null;
  state.pilotLogs = [];
  state.pilotError = '';
  state.searchCandidates = [];
  state.currentAiRename = null;
  state.drawerFilter = 'all';
  state.drawerSort = 'score';
  state.drawerItems = [];
  state.searchQuickFilter = 'all';
  document.querySelectorAll('[data-result-filter]').forEach((btn) => btn.classList.remove('active'));

  // 清空上一次搜索的结果 DOM，避免切到手动面板时看到上一部影片的列表
  const searchResults = document.getElementById('modal-search-results');
  if (searchResults) {
    searchResults.innerHTML = '<div style="padding:1.5rem;text-align:center;font-size:0.82rem;color:var(--cg-ink-3);">点击【检索资源】开始全网搜索夸克分享链接...</div>';
  }
  const searchAiBadge = document.getElementById('modal-search-ai-badge');
  if (searchAiBadge) searchAiBadge.style.display = 'none';

  // 填充头部信息 (Scheme A: 画报大卡流 + 顶部宽幅剧照)
  const heroBg = document.getElementById('modal-hero-bg');
  if (heroBg) {
    if (item.backdrop_url) {
      heroBg.style.backgroundImage = `url("${item.backdrop_url}")`;
      heroBg.style.opacity = '1';
    } else if (item.poster_url) {
      heroBg.style.backgroundImage = `url("${item.poster_url}")`;
      heroBg.style.opacity = '0.4';
    } else {
      heroBg.style.backgroundImage = 'none';
      heroBg.style.opacity = '0';
    }
  }

  document.getElementById('modal-poster').src = item.poster_url || '';
  document.getElementById('modal-title').innerText = item.title;
  document.getElementById('modal-year').innerText = item.year || '2024';
  document.getElementById('modal-category').innerText = item.genres || '影视';
  document.getElementById('modal-rating').innerText = item.rating > 0 ? `★ ${item.rating}` : '★ 暂无评分';
  document.getElementById('modal-overview').innerText = item.overview || '暂无详细剧情简介。';
  document.getElementById('modal-search-kw').value = item.title;
  document.getElementById('modal-shareurl').value = '';
  resetSubdirSelect();
  document.getElementById('modal-console-section').style.display = 'none';

  // 区分电影还是电视剧 (优先根据影视自身 media_type，否则按分类回退)
  let mediaType = 'movie';
  if (item.media_type) {
    mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
  } else if (state.category) {
    const isMovie = state.category.includes('movie');
    mediaType = isMovie ? 'movie' : state.category.includes('anime') ? 'anime' : state.category.includes('variety') ? 'variety' : state.category.includes('doc') ? 'doc' : 'tv';
  }

  // 动态加载正则预设（从 QAS 获取真实的魔法变量）
  loadPatternPresets();

  // 计算目标落地路径（整套转存模式）
  try {
    const res = await fetch('/api/qas/resolve-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: mediaType,
        title: item.title,
        year: item.year || '2024',
        season: '01',
        resolution: '4K',
        whole_folder: true,
      }),
    });
    const pathData = await res.json();
    document.getElementById('modal-savepath').value = pathData.resolved_path || `/影视/${item.title}`;
  } catch {
    document.getElementById('modal-savepath').value = `/影视/${item.title}`;
  }

  // 控制 AI 质检勾选框展示：仅在全局【启用AI】开启时展示
  const isGlobalAiEnabled = Boolean(state.config && state.config.llm_enabled !== false);
  const aiRankCheck = document.getElementById('modal-ai-rank');
  const aiRankLabel = aiRankCheck ? aiRankCheck.closest('label') : null;
  if (aiRankLabel) {
    aiRankLabel.style.display = isGlobalAiEnabled ? 'inline-flex' : 'none';
  }

  // 显示弹窗并锁定背景页面滚动，杜绝背景双滚动条
  document.body.style.overflow = 'hidden';
  document.getElementById('modal-transfer').classList.add('active');

  // 自动触发一次决策/检索：托管模式走低延迟流水线，手动模式走盘搜列表
  const mode = isAiEnabled() ? (state.transferMode || 'pilot') : 'manual';
  switchTransferMode(mode);
  if (mode === 'manual') {
    searchModalResources();
  }
}

function closeTransferModal() {
  abortPilotPipeline();
  abortTaskExecution();
  closeResultsDrawer();
  document.body.style.overflow = '';
  document.getElementById('modal-transfer').classList.remove('active');
  state.currentMedia = null;
}

// 盘搜结果的快速筛选（仅 4K / 全集）
function filterCandidatesByQuick(items) {
  const filter = state.searchQuickFilter;
  if (!filter || filter === 'all') return items;
  return items.filter((it) => {
    const hay = `${(it.ai_tags || []).join(' ')} ${it.taskname || ''} ${it.content || ''}`;
    if (filter === '4k') return /4K|2160|UHD/i.test(hay);
    if (filter === 'complete') return /全集|完结|全\d+集|全季/i.test(hay);
    return true;
  });
}

// 渲染夸克盘搜结果列表
function renderSearchResultsList(items, isAiActive) {
  const resultsContainer = document.getElementById('modal-search-results');
  if (!resultsContainer) return;

  items = filterCandidatesByQuick(items || []);

  if (!items || items.length === 0) {
    if (state.searchQuickFilter !== 'all' && (state.searchCandidates || []).length > 0) {
      resultsContainer.innerHTML = `
        <div style="padding:1.5rem;text-align:center;font-size:0.82rem;color:var(--cg-ink-3);">
          当前筛选下没有结果，点击上方「仅 4K / 全集」可取消筛选。
        </div>
      `;
      return;
    }
    resultsContainer.innerHTML = `
      <div style="padding:1.5rem;text-align:center;font-size:0.82rem;color:var(--cg-ink-3);">
        未检索到相关的夸克网盘资源，可勾选【深度搜索】重新检索或手动输入分享链接。
      </div>
    `;
    return;
  }

  // 主面板只展示 Top 3，其余统一进入结果弹窗（桌面/移动端一致）
  const initialVisibleCount = 3;
  const itemsHtml = items
    .slice(0, initialVisibleCount)
    .map((item, idx) => {
      const timeStr = item.datetime ? `• 更新时间: ${escapeHtml(item.datetime)}` : '';
      const safeTitle = (item.taskname || '夸克资源').replace(/'/g, "\\'");

      const isRecommended = isAiActive && Boolean(item.is_recommended);
      const isSpam = isAiActive && Boolean(item.is_spam);

      // 标签胶囊生成 (完全采用 ArtCraft 纸质工匠矢量图标)
      let tagsHtml = '';
      if (isAiActive && item.ai_tags && item.ai_tags.length > 0) {
        const pills = item.ai_tags.map(tag => {
          let tagClass = 'ai-tag-default';
          let iconSvg = '';
          if (tag.includes('推荐') || tag.includes('优选')) {
            tagClass = 'ai-tag-best';
            iconSvg = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="margin-right:2px;vertical-align:-0.5px;"><polygon points="12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9 12 2"/></svg>`;
          } else if (tag.includes('广告') || tag.includes('引流') || tag.includes('枪版')) {
            tagClass = 'ai-tag-spam';
            iconSvg = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:2px;vertical-align:-0.5px;"><polygon points="12 2 2 22 22 22 12 2"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
          } else if (tag.includes('4K') || tag.includes('杜比') || tag.includes('原盘') || tag.includes('完结')) {
            tagClass = 'ai-tag-quality';
          }
          return `<span class="ai-tag ${tagClass}">${iconSvg}${escapeHtml(tag)}</span>`;
        }).join('');
        const scorePill = item.ai_score ? `<span class="ai-tag ai-tag-default" style="font-family:var(--font-mono);">${item.ai_score}分</span>` : '';
        tagsHtml = `<div class="search-tag-group">${pills}${scorePill}</div>`;
      }

      // AI 评语
      const reasonHtml = (isAiActive && item.ai_reason)
        ? `<div class="ai-reason-text"><span style="opacity:0.45;font-family:var(--font-mono);font-size:0.68rem;margin-right:3px;">›</span>${escapeHtml(item.ai_reason)}</div>`
        : '';

      const itemClasses = [
        'search-item',
        isRecommended ? 'search-item-recommended' : '',
        isSpam ? 'search-item-spam' : '',
      ].filter(Boolean).join(' ');

      // 只要全局启用了 AI，无论搜索时是否勾选“AI质检”，卡片上始终展示“AI透视”按钮（两者互不影响）
      const isGlobalAiEnabled = Boolean(state.config && state.config.llm_enabled !== false);
      const aiBtnHtml = isGlobalAiEnabled
        ? `<button type="button" class="btn btn-inline-insight" id="btn-insight-${idx}" style="padding:0.18rem 0.5rem;font-size:0.72rem;" data-insight-idx="${idx}">AI透视</button>`
        : '';

      return `
      <div class="${itemClasses}" id="search-item-${idx}" data-shareurl="${escapeHtml(item.shareurl)}">
        <div class="search-item-top-row" data-select-shareurl="${escapeHtml(item.shareurl)}">
          <div class="search-item-main" style="flex:1; min-width:0; overflow:hidden;">
            ${tagsHtml}
            <div class="search-item-title">${sanitizeCleanTitle(item.taskname)}</div>
            ${reasonHtml}
            <div class="search-item-sub">${escapeHtml(item.shareurl)} ${timeStr}</div>
          </div>
          <div class="search-item-actions">
            ${aiBtnHtml}
            <button type="button" class="btn search-item-btn search-item-select">选用链接</button>
          </div>
        </div>
      </div>
    `;
    })
    .join('');

  let toggleHtml = '';
  if (items.length > initialVisibleCount) {
    toggleHtml = `
      <div class="search-more-bar" id="search-more-toggle" onclick="openResultsDrawer()">
        查看全部 ${items.length} 条结果 →
      </div>
    `;
  }

  resultsContainer.innerHTML = itemsHtml + toggleHtml;

  // 事件委托：避免把分享链接拼进内联 onclick
  resultsContainer.onclick = (e) => {
    const insightBtn = e.target.closest('[data-insight-idx]');
    if (insightBtn) {
      openAiInsightModal(Number(insightBtn.dataset.insightIdx));
      return;
    }
    const row = e.target.closest('[data-select-shareurl]');
    if (row) selectSearchResource(row.dataset.selectShareurl, row.closest('.search-item'));
  };

  // 抽屉打开时同步刷新（例如 AI 精审结果返回）
  const drawer = document.getElementById('results-drawer-backdrop');
  if (drawer && drawer.classList.contains('active')) {
    renderResultsDrawer();
  }

  // 默认静默选中首条推荐项
  if (isAiActive && items[0] && (items[0].is_recommended || items[0].ai_score >= 60)) {
    const firstEl = resultsContainer.querySelector('.search-item');
    if (firstEl) {
      selectSearchResource(items[0].shareurl, firstEl, true);
    }
  }
}

// 盘搜快速筛选：仅 4K / 全集
function initManualSearchFilters() {
  const bar = document.querySelector('.modal-search-filters');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-result-filter]');
    if (!btn) return;
    const searchBtn = document.getElementById('modal-search-btn');
    if (searchBtn && searchBtn.disabled) return;
    const value = btn.dataset.resultFilter;
    state.searchQuickFilter = state.searchQuickFilter === value ? 'all' : value;
    bar.querySelectorAll('[data-result-filter]').forEach((b) => {
      b.classList.toggle('active', b.dataset.resultFilter === state.searchQuickFilter);
    });
    renderSearchResultsList(state.searchCandidates, state.searchAiActive);
    const drawer = document.getElementById('results-drawer-backdrop');
    if (drawer && drawer.classList.contains('active')) renderResultsDrawer();
  });
}

// 检索夸克分享资源 (秒级首屏 + 异步 LLM 深度精审)
async function searchModalResources() {
  const kw = document.getElementById('modal-search-kw').value.trim();
  if (!kw) {
    showToast('请输入搜索关键词');
    return;
  }
  closeResultsDrawer();
  state.drawerFilter = 'all';
  state.drawerSort = 'score';
  state.searchQuickFilter = 'all';
  document.querySelectorAll('[data-result-filter]').forEach((btn) => btn.classList.remove('active'));
  const deep = document.getElementById('modal-deep-search').checked;
  const aiRank = document.getElementById('modal-ai-rank') ? document.getElementById('modal-ai-rank').checked : true;
  const btn = document.getElementById('modal-search-btn');
  const resultsContainer = document.getElementById('modal-search-results');
  const aiBadge = document.getElementById('modal-search-ai-badge');
  const aiStatus = document.getElementById('modal-search-ai-status');
  const aiEvaluator = document.getElementById('modal-search-ai-evaluator');

  btn.disabled = true;
  btn.innerText = '检索中...';
  const kwInput = document.getElementById('modal-search-kw');
  if (kwInput && window.innerWidth <= 768) kwInput.blur();
  resultsContainer.innerHTML = '<div style="padding:1.5rem;text-align:center;font-size:0.82rem;color:var(--cg-ink-3);">全网检索夸克网盘资源中，请稍候...</div>';
  state.searchingResources = true;
  if (!state.transferMode || state.transferMode === 'pilot') renderPilotDecisionCard();

  try {
    const current = state.currentMedia || {};
    const queryParams = new URLSearchParams({
      q: kw,
      deep: deep ? '1' : '0',
      ai_rank: aiRank ? 'true' : 'false',
      media_title: current.title || kw,
      media_year: current.year || '',
      media_type: current.media_type || 'movie',
      season: current.season || '01',
    });

    const res = await fetch(`/api/qas/search?${queryParams.toString()}`);
    const data = await res.json();
    state.searchCandidates = data.items || [];

    const isAiActive = aiRank && data.evaluator !== 'off';
    state.searchAiActive = isAiActive;

    // 1. 毫秒级首屏渲染 (用户瞬间看到精准的画质与防引流分类结果)
    renderSearchResultsList(state.searchCandidates, isAiActive);
    state.searchingResources = false;
    if (!state.transferMode || state.transferMode === 'pilot') renderPilotDecisionCard();

    if (aiBadge) {
      if (isAiActive && data.items && data.items.length > 0) {
        aiBadge.style.display = 'flex';
        if (data.can_refine) {
          aiStatus.innerHTML = `<strong>规格质检已就绪</strong>：正在调用 LLM 进行深度语义核验...`;
          aiEvaluator.innerText = 'CHECKING...';

          // 2. 异步触发 LLM 深度语义精审（绝不阻塞界面浏览）
          fetch('/api/qas/ai-refine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: state.searchCandidates.slice(0, 5),
              media_info: {
                title: current.title || kw,
                year: current.year || '',
                media_type: current.media_type || 'movie',
                season: current.season || '01',
              },
            }),
          })
            .then((r) => r.json())
            .then((refineRes) => {
              if (refineRes && refineRes.success && refineRes.items && refineRes.items.length > 0) {
                state.searchCandidates = refineRes.items.concat(state.searchCandidates.slice(5));
                renderSearchResultsList(state.searchCandidates, true);
                aiStatus.innerHTML = `<strong>AI 深度质检完成</strong>：已按画质与纯净度完成置顶推荐`;
                aiEvaluator.innerText = 'LLM';
              }
            })
            .catch((err) => {
              console.log('[AI Refine] Skipped:', err);
              aiStatus.innerHTML = `<strong>规格质检已完成</strong>：已按 4K/HDR 画质与规则完成优选排序`;
              aiEvaluator.innerText = 'FAST';
            });
        } else {
          aiStatus.innerHTML = `<strong>规格质检已完成</strong>：已按 4K/HDR 画质与规则完成优选排序`;
          aiEvaluator.innerText = 'FAST';
        }
      } else {
        aiBadge.style.display = 'none';
      }
    }
  } catch (err) {
    resultsContainer.innerHTML = `<div style="padding:1.2rem;text-align:center;font-size:0.82rem;color:var(--cg-danger);">检索异常: ${escapeHtml(err.message)}</div>`;
  } finally {
    state.searchingResources = false;
    btn.disabled = false;
    btn.innerText = '检索资源';
  }
}

// ============================================================
// 搜索结果弹窗（桌面居中弹窗 / 移动端底部抽屉）
// ============================================================
function drawerMatchFilter(item, filter) {
  const hay = `${(item.ai_tags || []).join(' ')} ${item.taskname || ''} ${item.content || ''}`;
  if (filter === '4k') return /4K|2160|UHD/i.test(hay);
  if (filter === '1080') return /1080/i.test(hay);
  if (filter === 'other') return !(/4K|2160|UHD|1080/i.test(hay));
  return true;
}

function openResultsDrawer() {
  const items = state.searchCandidates || [];
  if (!items.length) {
    showToast('暂无搜索结果');
    return;
  }
  state.drawerFilter = state.drawerFilter || 'all';
  state.drawerSort = state.drawerSort || 'score';
  renderResultsDrawer();
  const backdrop = document.getElementById('results-drawer-backdrop');
  if (backdrop) backdrop.classList.add('active');
}

function closeResultsDrawer() {
  const backdrop = document.getElementById('results-drawer-backdrop');
  if (backdrop) backdrop.classList.remove('active');
}

function renderResultsDrawer() {
  const list = document.getElementById('results-drawer-list');
  const count = document.getElementById('results-drawer-count');
  if (!list) return;

  const all = filterCandidatesByQuick(state.searchCandidates || []);
  const filter = state.drawerFilter || 'all';
  const sort = state.drawerSort || 'score';

  let items = all.filter((it) => drawerMatchFilter(it, filter));
  if (sort === 'date') {
    items = items.slice().sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
  } else {
    items = items.slice().sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));
  }

  state.drawerItems = items;
  if (count) count.textContent = `${items.length} / ${all.length} 条`;

  const currentUrl = (document.getElementById('modal-shareurl') || {}).value || '';
  if (!items.length) {
    list.innerHTML = '<div class="drawer-empty">该筛选下没有结果</div>';
  } else {
    list.innerHTML = items.map((item, idx) => {
      const tags = (item.ai_tags || []).slice(0, 4).map((tag) => {
        let cls = 'ai-tag-default';
        if (tag.includes('推荐') || tag.includes('优选')) cls = 'ai-tag-best';
        else if (tag.includes('广告') || tag.includes('引流') || tag.includes('枪版')) cls = 'ai-tag-spam';
        else if (tag.includes('4K') || tag.includes('杜比') || tag.includes('原盘') || tag.includes('完结') || tag.includes('1080')) cls = 'ai-tag-quality';
        return `<span class="ai-tag ${cls}">${escapeHtml(tag)}</span>`;
      }).join('');
      const score = item.ai_score ? `<span class="ai-tag ai-tag-default">${item.ai_score}分</span>` : '';
      const selected = currentUrl && item.shareurl === currentUrl ? ' selected' : '';
      return `<div class="drawer-res-item${selected}" data-i="${idx}">
        <div class="drawer-tags">${tags}${score}</div>
        <div class="drawer-title">${sanitizeCleanTitle(item.taskname)}</div>
        <div class="drawer-sub">${escapeHtml(item.shareurl)}${item.datetime ? ' · ' + escapeHtml(item.datetime) : ''}</div>
      </div>`;
    }).join('');
  }

  document.querySelectorAll('#results-drawer-filters .drawer-chip').forEach((btn) => {
    if (btn.dataset.filter) btn.classList.toggle('active', btn.dataset.filter === filter);
    if (btn.dataset.sort) btn.classList.toggle('active', btn.dataset.sort === sort);
  });

  list.onclick = (e) => {
    const row = e.target.closest('.drawer-res-item');
    if (!row) return;
    const item = (state.drawerItems || [])[Number(row.dataset.i)];
    if (item) selectDrawerResult(item.shareurl);
  };
}

function selectDrawerResult(shareurl) {
  const mainMatch = Array.from(document.querySelectorAll('.search-item')).find(
    (el) => el.getAttribute('data-shareurl') === shareurl
  ) || null;
  selectSearchResource(shareurl, mainMatch, true);
  closeResultsDrawer();
  showToast('✓ 已选用该分享链接');
}

// 选用分享资源，直接载入链接并智能定位
function selectSearchResource(shareurl, el, silent = false) {
  document.querySelectorAll('.search-item').forEach((item) => {
    item.classList.remove('selected');
    const btn = item.querySelector('.search-item-btn');
    if (btn) btn.innerText = '选用链接';
  });
  if (el) {
    el.classList.add('selected');
    const btn = el.querySelector('.search-item-btn');
    if (btn) btn.innerText = '✓ 已选用';
  }
  const input = document.getElementById('modal-shareurl');
  if (input) {
    input.value = shareurl;
    // 移动端贴心平滑微调视口，防止用户找不到下方配置
    if (window.innerWidth <= 640) {
      input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  if (!silent) {
    showToast('已选用该分享链接');
  }
}

// ============================================================
// AI 结构透视与直达建议 (独立弹出窗口 Modal 体验)
// ============================================================

function closeAiInsightModal() {
  const modal = document.getElementById('modal-ai-insight');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = '';
  }
}

async function openAiInsightModal(arg, optIdx) {
  let shareurl = '';
  let idx = 0;
  if (typeof arg === 'number') {
    idx = arg;
    const item = state.searchCandidates && state.searchCandidates[idx];
    shareurl = item ? item.shareurl : '';
  } else if (typeof arg === 'string') {
    shareurl = arg;
    idx = typeof optIdx === 'number' ? optIdx : 0;
  }
  if (!shareurl && state.searchCandidates && state.searchCandidates[idx]) {
    shareurl = state.searchCandidates[idx].shareurl;
  }

  const modal = document.getElementById('modal-ai-insight');
  const body = document.getElementById('ai-insight-modal-body');
  const btnApply = document.getElementById('btn-ai-insight-apply');
  if (!modal || !body) return;

  modal.classList.add('active');
  modal.style.display = 'flex';
  if (btnApply) btnApply.style.display = 'none';

  body.innerHTML = `
    <div style="padding: 3rem 1rem; text-align: center; color: var(--cg-ink-3); font-size: 0.85rem; display: flex; flex-direction: column; align-items: center; gap: 0.75rem;">
      <div style="font-family: var(--font-mono); font-size: 0.9rem; color: var(--cg-ink-2);">◇ 正在深度下探目录树...</div>
      <div style="font-size: 0.75rem;">分析空壳层级、正片文件分布与标准重命名规则</div>
    </div>
  `;

  try {
    const current = state.currentMedia || {};
    const res = await fetch('/api/qas/explore-share-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shareurl: shareurl,
        max_depth: 4,
        media_info: {
          title: current.title || '',
          year: current.year || '',
          season: current.season || '01',
          media_type: current.media_type || 'movie',
        },
      }),
    });
    const data = await res.json();
    if (!data.success || !data.diagnosis) {
      body.innerHTML = `<div style="padding: 2.5rem 1rem; color: var(--cg-danger); font-size: 0.85rem; text-align: center;">获取结构透视失败: ${escapeHtml(data.message || '未知错误')}</div>`;
      return;
    }

    const d = data.diagnosis;

    let treeHtml = '';
    if (d.levels_skipped > 0) {
      treeHtml += `<div class="tree-node-line tree-node-waste">/ (根目录) ${d.spam_files_count > 0 ? `<span style="color:#b3261e;font-size:0.7rem;margin-left:auto;">含 ${d.spam_files_count} 个广告引流文件(已自动隔离)</span>` : ''}</div>`;
      treeHtml += `<div class="tree-node-line tree-node-waste" style="padding-left:14px;">└── 外层嵌套包装 (已穿透跳过 ${d.levels_skipped} 层空壳)</div>`;
      treeHtml += `<div class="tree-node-line tree-node-target" style="padding-left:28px;">└── 【${escapeHtml(d.target_name)}】 <span style="margin-left:auto;font-size:0.72rem;">★ 正片所在地 (${d.video_count} 个视频)</span></div>`;
    } else {
      treeHtml += `<div class="tree-node-line tree-node-target">/ 【${escapeHtml(d.target_name)}】 <span style="margin-left:auto;font-size:0.72rem;">★ 正片所在地 (${d.video_count} 个视频)</span></div>`;
    }

    body.innerHTML = `
      <div style="font-size: 0.82rem; color: var(--cg-ink); font-weight: 700; display: flex; align-items: center; justify-content: space-between;">
        <span style="display:flex; align-items:center; gap:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9 12 2"/></svg>
          目录树穿透结构
        </span>
        <span style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--cg-ink-3);">
          ${d.levels_skipped > 0 ? `已安全穿透 ${d.levels_skipped} 层无意义套娃` : '单层目录直达'}
        </span>
      </div>

      <div class="tree-visual-box" style="padding: 0.85rem 1rem;">
        ${treeHtml}
      </div>

      <div class="rename-compare-grid">
        <div style="display:flex;flex-direction:column;gap:4px;">
          <span style="font-size:0.72rem;font-weight:700;color:var(--cg-ink-2);">原始混乱文件名 (样本):</span>
          <div style="background:var(--cg-paper-press);padding:7px 9px;border-radius:2px;font-family:var(--font-mono);font-size:0.75rem;word-break:break-all;border:1px solid var(--cg-rule-soft);line-height:1.45;">
            ${escapeHtml(d.sample_filename)}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <span style="font-size:0.72rem;font-weight:700;color:var(--cg-ink-2);">Emby/Plex 标准重命名效果:</span>
          <div style="background:#e6f4ea;color:#137333;padding:7px 9px;border-radius:2px;font-family:var(--font-mono);font-size:0.75rem;font-weight:600;word-break:break-all;border:1px solid #ceead6;line-height:1.45;">
            ${escapeHtml(d.suggested_filename)}
          </div>
        </div>
      </div>

      <div style="background:var(--cg-paper-2);padding:0.75rem 0.9rem;border:1px solid var(--cg-rule-soft);font-size:0.76rem;color:var(--cg-ink-2);line-height:1.5;">
        ${escapeHtml(d.summary)}
      </div>
    `;

    if (btnApply) {
      btnApply.style.display = 'inline-flex';
      btnApply.onclick = () => {
        applyDirectShareUrl(d.target_sub_url, encodeURIComponent(d.pattern), encodeURIComponent(d.replace), idx);
        closeAiInsightModal();
      };
    }
  } catch (err) {
    body.innerHTML = `<div style="padding: 2.5rem 1rem; color: var(--cg-danger); font-size: 0.85rem; text-align: center;">透视异常: ${escapeHtml(err.message)}</div>`;
  }
}

function applyDirectShareUrl(subUrl, encodedPattern, encodedReplace, idx) {
  const pattern = decodeURIComponent(encodedPattern || '.*');
  const replace = decodeURIComponent(encodedReplace || '');

  // 记录 AI 规范重命名配置
  state.currentAiRename = { pattern, replace };

  const inputShare = document.getElementById('modal-shareurl');
  if (inputShare) {
    inputShare.value = subUrl;
    inputShare.classList.add('flash-highlight');
    setTimeout(() => inputShare.classList.remove('flash-highlight'), 1200);
  }

  const selectPattern = document.getElementById('modal-pattern');
  if (selectPattern) {
    let aiOpt = selectPattern.querySelector('option[data-ai="true"]');
    if (!aiOpt) {
      aiOpt = document.createElement('option');
      aiOpt.setAttribute('data-ai', 'true');
      selectPattern.appendChild(aiOpt);
    }
    aiOpt.value = pattern;
    aiOpt.setAttribute('data-replace', replace);
    aiOpt.innerText = `AI 规范重命名 (${pattern})`;
    aiOpt.selected = true;
  }

  // 同步到内容浏览器下拉框中
  const browserSelect = document.getElementById('browser-pattern-select');
  if (browserSelect) {
    let bOpt = browserSelect.querySelector('option[data-ai="true"]');
    if (!bOpt) {
      bOpt = document.createElement('option');
      bOpt.setAttribute('data-ai', 'true');
      browserSelect.appendChild(bOpt);
    }
    bOpt.value = pattern;
    bOpt.setAttribute('data-replace', replace);
    bOpt.innerText = `AI 规范重命名 (${pattern})`;
    bOpt.selected = true;
  }

  const card = document.getElementById(`search-item-${idx}`);
  if (card) {
    document.querySelectorAll('.search-item').forEach(it => it.classList.remove('selected'));
    card.classList.add('selected');
    const btn = card.querySelector('.search-item-btn');
    if (btn) btn.innerText = '✓ 已选用直达';
  }

  showToast('✓ 已套用直达正片链接与 AI 规范重命名模板');

  if (inputShare) {
    inputShare.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ============================================================
// 分享内容浏览与正则预览模块 (Share Browser)
// ============================================================

function extractPwdId(url) {
  const m = url.match(/\/s\/(\w+)/);
  return m ? m[1] : '';
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '-';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function openShareBrowserFromInput() {
  const url = document.getElementById('modal-shareurl').value.trim();
  if (!url) {
    showToast('请先输入或从上方选用夸克分享链接');
    return;
  }
  const title = state.currentMedia ? state.currentMedia.title : '夸克分享';
  openShareBrowser(url, title, -1);
}

function syncBrowserPatternOptions() {
  const mainSelect = document.getElementById('modal-pattern');
  const browserSelect = document.getElementById('browser-pattern-select');
  if (mainSelect && browserSelect) {
    browserSelect.innerHTML = mainSelect.innerHTML;
    browserSelect.value = mainSelect.value || '.*';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeCleanTitle(str) {
  if (!str) return '夸克资源';
  let clean = String(str)
    .replace(/<[^>]*>/g, '') // 清理完整 HTML 标签如 <span></span>
    .replace(/^[^<>\n]*["']\s*>/g, '') // 清理截断残留的 HTML 属性尾部如 ;border-radius:6px;">
    .replace(/^[>\s"';]+/, '') // 清理开头残留的引号或尖括号
    .trim();
  return escapeHtml(clean) || '夸克资源';
}

function simulateRegex(filename, pattern, replace = '') {
  if (!pattern || pattern === '.*') return filename;
  let p = pattern;
  let r = replace;

  // 如果是魔法变量（如 $TV），从缓存的 magicRegex 中获取其实际规则
  if (p.startsWith('$') && state.magicRegex && state.magicRegex[p]) {
    const rule = state.magicRegex[p];
    p = rule.pattern || '.*';
    r = rule.replace || '';
  }

  try {
    const regex = new RegExp(p, 'i');
    if (!regex.test(filename)) {
      return null; // 不匹配
    }
    if (!r) return filename;
    // 将 Python 捕获组引用 \1, \2 转换为 JS 字符串替换支持的 $1, $2
    const jsReplace = r.replace(/\\(\d+)/g, '$$$1');
    return filename.replace(regex, jsReplace);
  } catch (e) {
    return filename;
  }
}

function updateBrowserTableRenamePreview() {
  const browserSelect = document.getElementById('browser-pattern-select');
  const mainSelect = document.getElementById('modal-pattern');
  const activeSelect = browserSelect || mainSelect;
  const pattern = activeSelect ? activeSelect.value : '.*';
  const selectedOpt = activeSelect && activeSelect.selectedIndex >= 0 ? activeSelect.options[activeSelect.selectedIndex] : null;
  const replace = selectedOpt ? (selectedOpt.getAttribute('data-replace') || '') : (state.currentAiRename ? state.currentAiRename.replace : '');

  const rows = document.querySelectorAll('#browser-table-wrapper tbody tr');

  rows.forEach((tr) => {
    if (tr.classList.contains('is-dir')) return;
    const fileName = tr.dataset.filename;
    if (!fileName) return;

    const renameCell = tr.querySelector('.rename-preview-cell');
    if (!renameCell) return;

    const preview = simulateRegex(fileName, pattern, replace);
    if (preview) {
      if (preview !== fileName) {
        renameCell.innerHTML = `<span class="preview-tag-renamed" title="规则匹配重命名为">${escapeHtml(preview)}</span>`;
      } else {
        renameCell.innerHTML = `<span class="preview-tag-unchanged">${escapeHtml(preview)}</span>`;
      }
    } else {
      renameCell.innerHTML = `<span style="color:var(--cg-danger);font-size:0.74rem;">未匹配 (将被忽略)</span>`;
    }
  });
}

function onBrowserPatternChange() {
  // 零延迟本地更新：无需重新发请求拉取网盘文件，直接在当前表格行内即时刷新重命名预览
  updateBrowserTableRenamePreview();
}

function openShareBrowser(shareurl, title = '', candidateIndex = -1) {
  const pwdId = extractPwdId(shareurl);
  if (!pwdId) {
    showToast('无效的夸克网盘分享链接');
    return;
  }
  const rootUrl = `https://pan.quark.cn/s/${pwdId}`;

  // 同步主弹窗中的命名规则选项与当前选值
  syncBrowserPatternOptions();

  state.browser = {
    baseShareUrl: rootUrl,
    currentUrl: shareurl,
    shareTitle: title || (state.currentMedia ? state.currentMedia.title : '夸克分享'),
    candidateIndex: candidateIndex,
    breadcrumbs: [{ name: '🏠 根目录', fid: '0', url: rootUrl }],
  };

  document.getElementById('browser-share-title').innerText = state.browser.shareTitle;
  document.getElementById('browser-share-url-text').innerText = shareurl;

  // 翻页组状态
  const pagerGroup = document.getElementById('browser-pager-group');
  if (pagerGroup) {
    if (candidateIndex >= 0 && state.searchCandidates.length > 1) {
      pagerGroup.style.display = 'inline-flex';
      updateBrowserPagerButtons();
    } else {
      pagerGroup.style.display = 'none';
    }
  }

  document.getElementById('modal-share-browser').classList.add('active');
  loadBrowserDirectory(shareurl);
}

function closeShareBrowser() {
  document.getElementById('modal-share-browser').classList.remove('active');
}

function updateBrowserPagerButtons() {
  const btnPrev = document.getElementById('btn-browser-prev');
  const btnNext = document.getElementById('btn-browser-next');
  if (btnPrev && btnNext) {
    btnPrev.disabled = state.browser.candidateIndex <= 0;
    btnNext.disabled = state.browser.candidateIndex >= state.searchCandidates.length - 1;
  }
}

function navigateBrowserCandidate(delta) {
  const newIndex = state.browser.candidateIndex + delta;
  if (newIndex < 0 || newIndex >= state.searchCandidates.length) return;
  const candidate = state.searchCandidates[newIndex];
  if (!candidate) return;
  openShareBrowser(candidate.shareurl, candidate.taskname || '', newIndex);
}

async function loadBrowserDirectory(url, pushCrumb = null) {
  const wrapper = document.getElementById('browser-table-wrapper');
  wrapper.innerHTML = '<div style="padding:2.5rem;text-align:center;font-size:0.85rem;color:var(--cg-ink-3);">正在拉取目录清单与模拟正则重命名...</div>';

  if (pushCrumb) {
    state.browser.breadcrumbs.push(pushCrumb);
  }
  state.browser.currentUrl = url;
  renderBrowserBreadcrumbs();

  const browserSelect = document.getElementById('browser-pattern-select');
  const pattern = browserSelect ? browserSelect.value : (document.getElementById('modal-pattern').value || '.*');

  try {
    const res = await fetch('/api/qas/share-detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shareurl: url,
        task: { pattern: pattern, replace: '' },
      }),
    });
    const resData = await res.json();

    if (!resData.success) {
      wrapper.innerHTML = `<div style="padding:2rem;text-align:center;font-size:0.85rem;color:var(--cg-danger);">无法加载文件: ${resData.message || '未知错误'}</div>`;
      return;
    }

    const shareData = resData.data || {};
    const fileList = shareData.list || [];

    if (shareData.share && shareData.share.title) {
      document.getElementById('browser-share-title').innerText = shareData.share.title;
    }

    renderBrowserTable(fileList);
  } catch (err) {
    wrapper.innerHTML = `<div style="padding:2rem;text-align:center;font-size:0.85rem;color:var(--cg-danger);">请求异常: ${err.message}</div>`;
  }
}

function renderBrowserBreadcrumbs() {
  const bar = document.getElementById('browser-breadcrumb');
  if (!bar) return;
  const crumbs = state.browser.breadcrumbs;
  bar.innerHTML = crumbs
    .map((c, idx) => {
      const isLast = idx === crumbs.length - 1;
      if (isLast) {
        return `<span class="breadcrumb-crumb active">${c.name}</span>`;
      }
      return `<span class="breadcrumb-crumb" onclick="clickCrumb(${idx})">${c.name}</span> <span style="color:var(--cg-rule-soft);">/</span>`;
    })
    .join('');
}

function clickCrumb(index) {
  const crumbs = state.browser.breadcrumbs;
  if (index >= 0 && index < crumbs.length) {
    const target = crumbs[index];
    state.browser.breadcrumbs = crumbs.slice(0, index + 1);
    loadBrowserDirectory(target.url);
  }
}

function renderBrowserTable(list) {
  const wrapper = document.getElementById('browser-table-wrapper');
  if (!list || list.length === 0) {
    wrapper.innerHTML = '<div style="padding:2.5rem;text-align:center;font-size:0.85rem;color:var(--cg-ink-3);">📁 此文件夹为空</div>';
    document.getElementById('browser-footer-status').innerText = '当前目录：空文件夹';
    return;
  }

  // 文件夹排在最前，随后按名称自然排序
  const dirs = list.filter((f) => f.dir);
  const files = list.filter((f) => !f.dir);

  dirs.sort((a, b) => a.file_name.localeCompare(b.file_name, undefined, { numeric: true }));
  files.sort((a, b) => a.file_name.localeCompare(b.file_name, undefined, { numeric: true }));

  const sortedList = [...dirs, ...files];
  const pwdId = extractPwdId(state.browser.baseShareUrl);

  const rows = sortedList
    .map((item) => {
      if (item.dir) {
        const subUrl = `https://pan.quark.cn/s/${pwdId}#/list/share/${item.fid}-${encodeURIComponent(item.file_name)}`;
        const safeName = item.file_name.replace(/'/g, "\\'");
        return `
        <tr class="is-dir" onclick="enterDirectory('${item.fid}', '${safeName}', '${subUrl}')">
          <td>
            <div style="display:flex;align-items:center;gap:0.5rem;font-weight:600;">
              <span style="font-size:1.1rem;">📁</span>
              <span style="color:var(--cg-accent);">${item.file_name}</span>
            </div>
          </td>
          <td>
            <span style="color:var(--cg-ink-3);font-size:0.75rem;">(目录层级)</span>
          </td>
          <td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--cg-ink-2);">文件夹</td>
          <td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--cg-ink-3);">${formatDate(item.l_updated_at || item.updated_at)}</td>
        </tr>
      `;
      } else {
        const isVideo = item.file_type === 1 || Boolean(item.duration);
        const icon = isVideo ? '🎬' : '📄';
        let renameCol = '';

        const browserSelect = document.getElementById('browser-pattern-select');
        const mainSelect = document.getElementById('modal-pattern');
        const activeSelect = browserSelect || mainSelect;
        const pattern = activeSelect ? activeSelect.value : '.*';
        const selectedOpt = activeSelect && activeSelect.selectedIndex >= 0 ? activeSelect.options[activeSelect.selectedIndex] : null;
        const replace = selectedOpt ? (selectedOpt.getAttribute('data-replace') || '') : (state.currentAiRename ? state.currentAiRename.replace : '');
        const preview = simulateRegex(item.file_name, pattern, replace);

        if (preview) {
          if (preview !== item.file_name) {
            renameCol = `<span class="preview-tag-renamed" title="规则匹配重命名为">${escapeHtml(preview)}</span>`;
          } else {
            renameCol = `<span class="preview-tag-unchanged">${escapeHtml(preview)}</span>`;
          }
        } else {
          renameCol = `<span style="color:var(--cg-danger);font-size:0.74rem;">未匹配 (将被忽略)</span>`;
        }

        return `
        <tr data-filename="${escapeHtml(item.file_name)}">
          <td>
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <span style="font-size:1.05rem;">${icon}</span>
              <span style="font-size:0.83rem;">${escapeHtml(item.file_name)}</span>
            </div>
          </td>
          <td class="rename-preview-cell">${renameCol}</td>
          <td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--cg-ink-2);">${formatBytes(item.size)}</td>
          <td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--cg-ink-3);">${formatDate(item.l_updated_at || item.updated_at)}</td>
        </tr>
      `;
      }
    })
    .join('');

  wrapper.innerHTML = `
    <table class="browser-table">
      <thead>
        <tr>
          <th>文件名</th>
          <th style="min-width:180px;">正则处理 (重命名预览)</th>
          <th style="width:110px;">大小 / 类型</th>
          <th style="width:140px;">修改日期</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  const curCrumb = state.browser.breadcrumbs[state.browser.breadcrumbs.length - 1];
  document.getElementById('browser-footer-status').innerText = `当前目录：${curCrumb ? curCrumb.name : '/'} (共 ${dirs.length} 个文件夹，${files.length} 个文件)`;
}

function enterDirectory(fid, name, subUrl) {
  loadBrowserDirectory(subUrl, { name: name, fid: fid, url: subUrl });
}

function confirmBrowserSelection() {
  const chosenUrl = state.browser.currentUrl;
  if (!chosenUrl) return;

  document.getElementById('modal-shareurl').value = chosenUrl;

  // 将预览时选择的命名匹配规则回写到主页面
  const browserSelect = document.getElementById('browser-pattern-select');
  const chosenPattern = browserSelect ? browserSelect.value : '.*';
  const mainPatternSelect = document.getElementById('modal-pattern');
  if (mainPatternSelect && chosenPattern) {
    mainPatternSelect.value = chosenPattern;
  }

  const crumbs = state.browser.breadcrumbs;
  const isSub = crumbs.length > 1;
  const currentFolderName = isSub ? crumbs[crumbs.length - 1].name : '';

  // 如果是在子目录（如 S01, Season 02），智能微调主界面的目标保存路径
  if (isSub && currentFolderName) {
    const savePathInput = document.getElementById('modal-savepath');
    const curPath = savePathInput.value.trim();
    if (!curPath.endsWith(currentFolderName)) {
      savePathInput.value = `${curPath.replace(/\/+$/, '')}/${currentFolderName}`;
    }
    showToast(`✓ 已定位子目录【${currentFolderName}】并同步命名规则【${chosenPattern}】`);
  } else {
    showToast(`✓ 已定位整套根目录并同步命名规则【${chosenPattern}】`);
  }

  closeShareBrowser();
}

// 提交转存任务（加入追更或立即执行）
async function submitModalTask(runNow = false, btnEl = null) {
  if (state.submittingTask) return;

  const shareurl = document.getElementById('modal-shareurl').value.trim();
  const savepath = document.getElementById('modal-savepath').value.trim();
  const browserSelect = document.getElementById('browser-pattern-select');
  const mainSelect = document.getElementById('modal-pattern');
  const activeSelect = browserSelect || mainSelect;
  const pattern = activeSelect ? activeSelect.value : '.*';
  const selectedOpt = activeSelect && activeSelect.selectedIndex >= 0 ? activeSelect.options[activeSelect.selectedIndex] : null;
  const replace = selectedOpt ? (selectedOpt.getAttribute('data-replace') || '') : (state.currentAiRename ? state.currentAiRename.replace : '');
  const update_subdir = getSubdirValue();
  const baseTitle = state.currentMedia ? state.currentMedia.title : '转存任务';

  if (!shareurl) {
    showToast('请先选择或输入夸克分享链接');
    return;
  }
  if (!savepath) {
    showToast('目标保存路径不能为空');
    return;
  }

  const taskPayload = {
    taskname: baseTitle,
    shareurl,
    savepath,
    pattern,
    replace,
    update_subdir,
    ignore_extension: false,
    runweek: [1, 2, 3, 4, 5, 6, 7],
  };

  const btnAdd = document.getElementById('btn-add-qas-task');
  const btnRun = document.getElementById('btn-run-qas-now');
  const activeBtn = btnEl || (runNow ? btnRun : btnAdd);
  const originalHtml = activeBtn ? activeBtn.innerHTML : '';
  const consoleSec = document.getElementById('modal-console-section');
  const consoleBox = document.getElementById('modal-console');

  state.submittingTask = true;
  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.innerHTML = runNow ? '正在执行转存…' : '正在提交…';
  }
  const controller = new AbortController();
  taskAbortController = controller;

  try {
    if (runNow) {
      // 日志区已移出专家面板，Pilot 模式下也能看到实时反馈
      if (consoleSec) consoleSec.style.display = 'block';
      if (consoleBox) {
        consoleBox.innerText = `>>> 正在向 QAS 调度转存任务 [${baseTitle}]...\n`;
        consoleBox.scrollTop = consoleBox.scrollHeight;
      }
      if (consoleSec) {
        requestAnimationFrame(() => consoleSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
      showToast('已提交转存，正在执行…');

      const response = await fetch('/api/qas/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasklist: [taskPayload] }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).detail || ''; } catch (e) {}
        const msg = `HTTP ${response.status}${detail ? '：' + detail : ''}`;
        if (consoleBox) consoleBox.innerText += `\n[ERROR] 请求被拒绝：${msg}\n`;
        showToast(`执行失败：${msg}`);
        return;
      }
      if (!response.body) {
        if (consoleBox) consoleBox.innerText += '\n[ERROR] 浏览器未收到流式响应。\n';
        showToast('执行失败：无响应流');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let sawDone = false;

      const appendLine = (line) => {
        const text = line.replace(/\r$/, '');
        if (!text) return;
        let content = text;
        if (content.startsWith('data:')) content = content.slice(5).trim();
        if (content === '[DONE]') {
          sawDone = true;
          if (consoleBox) consoleBox.innerText += '>>> 转存流程执行完毕。\n';
          return;
        }
        if (consoleBox) consoleBox.innerText += content + '\n';
        if (consoleBox) consoleBox.scrollTop = consoleBox.scrollHeight;
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(appendLine);
      }
      if (buffer.trim()) appendLine(buffer);
      if (!sawDone && consoleBox) consoleBox.innerText += '>>> 连接已关闭。\n';
      showToast(sawDone ? '✓ 转存执行完毕' : '转存连接已结束');
    } else {
      showToast('正在提交转存任务…');
      const res = await fetch('/api/qas/add-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskPayload),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).detail || ''; } catch (e) {}
        showToast(`提交失败：HTTP ${res.status}${detail ? '：' + detail : ''}`);
        return;
      }
      const data = await res.json();
      if (data.success) {
        showToast('✓ 已成功加入 QAS 自动追更队列！');
        setTimeout(() => closeTransferModal(), 1200);
      } else {
        showToast(`添加失败: ${data.message || '未知错误'}`);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (consoleBox) consoleBox.innerText += `\n[ERROR] 执行异常: ${err.message}\n`;
    showToast(`执行异常: ${err.message}`);
  } finally {
    state.submittingTask = false;
    if (taskAbortController === controller) taskAbortController = null;
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.innerHTML = originalHtml;
    }
  }
}

// ============================================================
// 任务列表模块 (QAS)
// ============================================================

async function loadTasks(forceToast = false) {
  const container = document.getElementById('tasks-table-wrapper');
  container.innerHTML = '<div class="state-box"><div class="state-title">正在拉取转存任务列表...</div></div>';
  clearSelectedTasks();

  try {
    const res = await fetch('/api/qas/tasks');
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `
        <div class="state-box">
          <div class="state-title" style="color:var(--cg-danger);">无法拉取任务</div>
          <div class="state-desc">${escapeHtml(data.message || '请确认转存服务是否正常运行与 Token 是否有效')}</div>
          <button type="button" class="btn btn-primary" onclick="switchTab('settings')">前往检查系统配置</button>
        </div>
      `;
      return;
    }

    state.tasks = data.tasklist || [];

    if (state.tasks.length === 0) {
      container.innerHTML = `
        <div class="state-box">
          <div class="state-title">当前暂无转存任务</div>
          <div class="state-desc">可在【影视发现】中浏览影视封面直接创建转存任务</div>
          <button type="button" class="btn btn-primary" onclick="switchTab('discover')">浏览影视库</button>
        </div>
      `;
      return;
    }

    const rows = state.tasks
      .map((t) => {
        const isBanned = Boolean(t.shareurl_ban);
        const statusBadge = isBanned
          ? `<span class="task-badge-ban" title="${escapeHtml(t.shareurl_ban || '')}">链接失效</span>`
          : '<span class="task-badge-ok">正常运行</span>';

        return `
        <tr data-taskname="${encodeURIComponent(t.taskname || '')}">
          <td class="task-col-check">
            <input type="checkbox" class="task-checkbox" value="${escapeHtml(t.taskname || '')}" onchange="updateSelectedTasksCount()">
          </td>
          <td class="task-col-main">
            <div class="task-name">${escapeHtml(t.taskname || '未命名')}</div>
            <div class="task-url" title="${escapeHtml(t.shareurl || '')}">${escapeHtml(t.shareurl || '')}</div>
          </td>
          <td class="task-col-path">
            <span class="cell-label">保存路径:</span>
            <span class="cell-val">${escapeHtml(t.savepath || '/')}</span>
          </td>
          <td class="task-col-rule">
            <span class="cell-label">匹配规则:</span>
            <span class="cell-val">${escapeHtml(t.pattern || '.*')}</span>
          </td>
          <td class="task-col-status">
            ${statusBadge}
          </td>
          <td class="task-col-actions">
            <div class="task-btn-group">
              <button type="button" class="btn" style="padding:0.25rem 0.55rem;font-size:0.75rem;" data-task-action="run">运行</button>
              <button type="button" class="btn" style="padding:0.25rem 0.55rem;font-size:0.75rem;color:var(--cg-danger);" data-task-action="delete">删除</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');

    container.innerHTML = `
      <div class="task-mobile-select-bar">
        <label style="display:flex;align-items:center;gap:0.45rem;cursor:pointer;font-size:0.82rem;font-weight:700;">
          <input type="checkbox" id="tasks-check-all-mobile" onchange="toggleSelectAllTasks(this.checked)">
          <span>全选所有任务</span>
        </label>
        <span style="font-size:0.75rem;color:var(--cg-ink-3);font-family:var(--font-mono);">共 ${state.tasks.length} 条</span>
      </div>
      <div class="task-table-container">
        <table class="task-table">
          <thead>
            <tr>
              <th style="text-align:center;width:40px;">
                <input type="checkbox" id="tasks-check-all" onchange="toggleSelectAllTasks(this.checked)" title="全选 / 反选">
              </th>
              <th>任务名称与链接</th>
              <th>网盘保存路径</th>
              <th>规则</th>
              <th>状态</th>
              <th style="width:110px;">操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    // 事件委托：任务名可能含单引号等字符，不能再拼进内联 onclick
    container.onclick = (e) => {
      const btn = e.target.closest('[data-task-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const taskname = tr ? decodeURIComponent(tr.dataset.taskname || '') : '';
      if (!taskname) return;
      if (btn.dataset.taskAction === 'run') {
        runSingleTask(taskname, btn);
      } else if (btn.dataset.taskAction === 'delete') {
        deleteQasTask(taskname, btn);
      }
    };

    updateSelectedTasksCount();
    if (forceToast) showToast(`成功同步 ${state.tasks.length} 个转存任务`);
  } catch (err) {
    container.innerHTML = `<div class="state-box"><div class="state-title" style="color:var(--cg-danger);">加载失败: ${escapeHtml(err.message)}</div></div>`;
  }
}

function toggleSelectAllTasks(checked) {
  const desktopAll = document.getElementById('tasks-check-all');
  const mobileAll = document.getElementById('tasks-check-all-mobile');
  if (desktopAll) desktopAll.checked = checked;
  if (mobileAll) mobileAll.checked = checked;

  const checkboxes = document.querySelectorAll('.task-checkbox');
  checkboxes.forEach((cb) => (cb.checked = checked));
  updateSelectedTasksCount();
}

function updateSelectedTasksCount() {
  const checkedBoxes = Array.from(document.querySelectorAll('.task-checkbox:checked'));
  const count = checkedBoxes.length;
  const allBoxes = document.querySelectorAll('.task-checkbox');

  const checkAll = document.getElementById('tasks-check-all');
  const checkAllMobile = document.getElementById('tasks-check-all-mobile');
  const isAllChecked = allBoxes.length > 0 && count === allBoxes.length;
  const isIndeterminate = count > 0 && count < allBoxes.length;

  if (checkAll) {
    checkAll.checked = isAllChecked;
    checkAll.indeterminate = isIndeterminate;
  }
  if (checkAllMobile) {
    checkAllMobile.checked = isAllChecked;
    checkAllMobile.indeterminate = isIndeterminate;
  }

  const batchBar = document.getElementById('tasks-batch-bar');
  const countLabel = document.getElementById('tasks-selected-count');
  if (batchBar && countLabel) {
    if (count > 0) {
      batchBar.style.display = 'inline-flex';
      countLabel.innerText = `已选 ${count} 项`;
    } else {
      batchBar.style.display = 'none';
    }
  }
}

function clearSelectedTasks() {
  const checkboxes = document.querySelectorAll('.task-checkbox');
  checkboxes.forEach((cb) => (cb.checked = false));
  const checkAll = document.getElementById('tasks-check-all');
  if (checkAll) {
    checkAll.checked = false;
    checkAll.indeterminate = false;
  }
  const checkAllMobile = document.getElementById('tasks-check-all-mobile');
  if (checkAllMobile) {
    checkAllMobile.checked = false;
    checkAllMobile.indeterminate = false;
  }
  updateSelectedTasksCount();
}

async function batchDeleteSelectedTasks() {
  const checkedBoxes = Array.from(document.querySelectorAll('.task-checkbox:checked'));
  const tasknames = checkedBoxes.map((cb) => cb.value);
  if (tasknames.length === 0) {
    showToast('请先勾选需要删除的任务');
    return;
  }

  if (!confirm(`确定要从 QAS 中批量删除选中的 ${tasknames.length} 个转存任务吗？此操作不可恢复。`)) {
    return;
  }

  const batchBtn = document.querySelector('#tasks-batch-bar button');
  if (batchBtn) batchBtn.disabled = true;

  try {
    const res = await fetch('/api/qas/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasknames }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ 已成功批量删除 ${data.deleted_count || tasknames.length} 个任务`);
      // 平滑移除选中的表格行，无刷新闪烁
      checkedBoxes.forEach((cb) => {
        const tr = cb.closest('tr');
        if (tr) tr.remove();
      });
      const deletedSet = new Set(tasknames);
      state.tasks = state.tasks.filter((t) => !deletedSet.has(t.taskname));
      clearSelectedTasks();
      if (state.tasks.length === 0) {
        loadTasks();
      }
    } else {
      showToast(`批量删除失败: ${data.message}`);
    }
  } catch (err) {
    showToast(`批量删除异常: ${err.message}`);
  } finally {
    if (batchBtn) batchBtn.disabled = false;
  }
}

async function runSingleTask(taskname, btnEl) {
  showToast(`正在触发任务 [${taskname}]...`);
  if (btnEl) btnEl.disabled = true;
  try {
    const res = await fetch('/api/qas/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasklist: [{ taskname }] }),
    });
    if (res.ok) {
      showToast(`任务 [${taskname}] 已在 QAS 启动执行`);
    } else {
      showToast('触发执行失败');
    }
  } catch (err) {
    showToast(`触发异常: ${err.message}`);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function deleteQasTask(taskname, btnEl) {
  if (!confirm(`确定要从 QAS 中删除转存任务【${taskname}】吗？`)) return;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerText = '删除中...';
  }
  try {
    const res = await fetch(`/api/qas/task/${encodeURIComponent(taskname)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.success) {
      showToast(`已删除任务: ${taskname}`);
      // 平滑无刷新局部移除当前行
      const tr = btnEl ? btnEl.closest('tr') : document.querySelector(`tr[data-taskname="${encodeURIComponent(taskname)}"]`);
      if (tr) {
        tr.style.transition = 'all 0.25s ease';
        tr.style.opacity = '0';
        tr.style.transform = 'translateX(20px)';
        setTimeout(() => {
          tr.remove();
          state.tasks = state.tasks.filter((t) => t.taskname !== taskname);
          updateSelectedTasksCount();
          if (state.tasks.length === 0) {
            loadTasks();
          }
        }, 250);
      } else {
        state.tasks = state.tasks.filter((t) => t.taskname !== taskname);
        updateSelectedTasksCount();
      }
    } else {
      showToast(`删除失败: ${data.message}`);
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerText = '删除';
      }
    }
  } catch (err) {
    showToast(`删除异常: ${err.message}`);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerText = '删除';
    }
  }
}

// ============================================================
// 系统配置模块
// ============================================================

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    state.config = { ...state.config, ...data };
    populateConfigForm();
    applyAiAvailability();
  } catch (err) {
    showToast(`读取配置失败: ${err.message}`);
  }
}

function populateConfigForm() {
  const tmdbKeyInput = document.getElementById('input-tmdb-key');
  tmdbKeyInput.value = '';
  tmdbKeyInput.placeholder = state.config.has_tmdb_api_key
    ? '已配置（留空保持不变）'
    : '在此粘贴您的 TMDB API 密钥';
  document.getElementById('input-tmdb-base').value = state.config.tmdb_base_url || 'https://api.themoviedb.org';
  document.getElementById('input-proxy').value = state.config.proxy || '';

  document.getElementById('input-qas-base').value = state.config.qas_base_url || 'http://localhost:5005';
  const qasTokenInput = document.getElementById('input-qas-token');
  qasTokenInput.value = '';
  qasTokenInput.placeholder = state.config.has_qas_token
    ? '已配置（留空保持不变）'
    : '可在 QAS WebUI【系统配置 -> API】处获取或填管理密码衍生的 Token';

  if (document.getElementById('input-llm-enabled')) {
    document.getElementById('input-llm-enabled').checked = state.config.llm_enabled !== false;
  }
  if (document.getElementById('input-llm-base')) {
    document.getElementById('input-llm-base').value = state.config.llm_base_url || 'https://api.deepseek.com/v1';
  }
  if (document.getElementById('input-llm-key')) {
    const llmKeyInput = document.getElementById('input-llm-key');
    llmKeyInput.value = '';
    llmKeyInput.placeholder = state.config.has_llm_api_key
      ? '已配置（留空保持不变）'
      : '在此粘贴您的 DeepSeek / OpenAI / Kimi 等 API 密钥';
  }
  if (document.getElementById('input-llm-model')) {
    document.getElementById('input-llm-model').value = state.config.llm_model || 'deepseek-chat';
  }

  document.getElementById('input-path-movie').value = state.config.path_movie || '';
  document.getElementById('input-path-tv').value = state.config.path_tv || '';
  document.getElementById('input-path-anime').value = state.config.path_anime || '';
  document.getElementById('input-path-variety').value = state.config.path_variety || '';
  document.getElementById('input-path-doc').value = state.config.path_doc || '';

  updateAllPreviews();
}

function updateAllPreviews() {
  const movieTpl = document.getElementById('input-path-movie').value;
  const tvTpl = document.getElementById('input-path-tv').value;
  const animeTpl = document.getElementById('input-path-anime').value;
  const varietyTpl = document.getElementById('input-path-variety').value;
  const docTpl = document.getElementById('input-path-doc').value;

  document.getElementById('preview-path-movie').innerText = `预览：${formatTemplate(movieTpl, SAMPLE_DATA.movie)}`;
  document.getElementById('preview-path-tv').innerText = `预览：${formatTemplate(tvTpl, SAMPLE_DATA.tv)}`;
  document.getElementById('preview-path-anime').innerText = `预览：${formatTemplate(animeTpl, SAMPLE_DATA.anime)}`;
  document.getElementById('preview-path-variety').innerText = `预览：${formatTemplate(varietyTpl, SAMPLE_DATA.variety)}`;
  document.getElementById('preview-path-doc').innerText = `预览：${formatTemplate(docTpl, SAMPLE_DATA.doc)}`;
}

function appendVariable(inputId, varText) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  input.value = val.substring(0, start) + varText + val.substring(end);
  input.focus();
  input.setSelectionRange(start + varText.length, start + varText.length);
  updateAllPreviews();
}

async function saveConfig() {
  const payload = {
    tmdb_api_key: document.getElementById('input-tmdb-key').value.trim(),
    tmdb_base_url: document.getElementById('input-tmdb-base').value.trim() || 'https://api.themoviedb.org',
    proxy: document.getElementById('input-proxy').value.trim(),
    qas_base_url: document.getElementById('input-qas-base').value.trim() || 'http://localhost:5005',
    qas_token: document.getElementById('input-qas-token').value.trim(),
    llm_enabled: document.getElementById('input-llm-enabled') ? document.getElementById('input-llm-enabled').checked : true,
    llm_base_url: document.getElementById('input-llm-base') ? document.getElementById('input-llm-base').value.trim() : 'https://api.deepseek.com/v1',
    llm_api_key: document.getElementById('input-llm-key') ? document.getElementById('input-llm-key').value.trim() : '',
    llm_model: document.getElementById('input-llm-model') ? (document.getElementById('input-llm-model').value.trim() || 'deepseek-chat') : 'deepseek-chat',
    path_movie: document.getElementById('input-path-movie').value.trim(),
    path_tv: document.getElementById('input-path-tv').value.trim(),
    path_anime: document.getElementById('input-path-anime').value.trim(),
    path_variety: document.getElementById('input-path-variety').value.trim(),
    path_doc: document.getElementById('input-path-doc').value.trim(),
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      state.config = await res.json();
      populateConfigForm();
      applyAiAvailability();
      showToast('系统配置已持久化至 config.json');
      checkTmdbStatusQuietly();
      checkQasStatusQuietly();
    } else {
      showToast('保存失败，请检查输入');
    }
  } catch (err) {
    showToast(`保存出错: ${err.message}`);
  }
}

async function verifyTmdb() {
  const btn = document.getElementById('btn-verify-tmdb');
  const resultEl = document.getElementById('verify-result');
  btn.disabled = true;
  btn.innerText = '正在测试连通性...';
  resultEl.style.display = 'none';

  await saveConfig();

  try {
    const res = await fetch('/api/tmdb/verify', { method: 'POST' });
    const data = await res.json();
    resultEl.style.display = 'block';
    if (data.success) {
      resultEl.style.color = 'var(--cg-success)';
      resultEl.innerHTML = `<strong>✓ 连通正常</strong> (${data.latency_ms}ms)`;
      updateTmdbBadge('online', `TMDB 在线 (${data.latency_ms}ms)`);
      showToast('TMDB 验证成功！');
    } else {
      resultEl.style.color = 'var(--cg-danger)';
      resultEl.innerHTML = `<strong>✗ 连通失败</strong>: ${data.message}`;
      updateTmdbBadge('offline', 'TMDB 异常');
    }
  } catch (err) {
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--cg-danger)';
    resultEl.innerHTML = `<strong>✗ 请求异常</strong>: ${err.message}`;
    updateTmdbBadge('offline', 'TMDB 断连');
  } finally {
    btn.disabled = false;
    btn.innerText = '测试 TMDB 连通性';
  }
}

async function verifyQas() {
  const btn = document.getElementById('btn-verify-qas');
  const resultEl = document.getElementById('verify-qas-result');
  btn.disabled = true;
  btn.innerText = '正在测试连通性...';
  resultEl.style.display = 'none';

  await saveConfig();

  try {
    const res = await fetch('/api/qas/verify', { method: 'POST' });
    const data = await res.json();
    resultEl.style.display = 'block';
    if (data.success) {
      resultEl.style.color = 'var(--cg-success)';
      const cookieText = data.has_cookie ? '夸克 Cookie 有效' : '未配置夸克 Cookie';
      resultEl.innerHTML = `<strong>✓ QAS 正常</strong> (${data.latency_ms}ms) • 现有任务: ${data.task_count} 个 • ${cookieText}`;
      updateQasBadge('online', `QAS 在线 (${data.latency_ms}ms)`);
      showToast('QAS 连通验证成功！');
    } else {
      resultEl.style.color = 'var(--cg-danger)';
      resultEl.innerHTML = `<strong>✗ 连通失败</strong>: ${data.message}`;
      updateQasBadge('offline', 'QAS 异常');
    }
  } catch (err) {
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--cg-danger)';
    resultEl.innerHTML = `<strong>✗ 请求异常</strong>: ${err.message}`;
    updateQasBadge('offline', 'QAS 断连');
  } finally {
    btn.disabled = false;
    btn.innerText = '测试 QAS 连通性';
  }
}

async function verifyLlm() {
  const btn = document.getElementById('btn-verify-llm');
  const resultEl = document.getElementById('verify-llm-result');
  if (!btn || !resultEl) return;

  btn.disabled = true;
  btn.innerText = '正在测试 LLM...';
  resultEl.style.display = 'none';

  await saveConfig();

  try {
    const res = await fetch('/api/config/test-llm', { method: 'POST' });
    const data = await res.json();
    resultEl.style.display = 'block';
    if (data.success) {
      resultEl.style.color = 'var(--cg-success)';
      resultEl.innerHTML = `<strong>✓ 连通正常</strong> (${data.latency_ms}ms) • ${data.message}`;
      showToast('LLM 连通测试成功！');
    } else {
      resultEl.style.color = 'var(--cg-danger)';
      resultEl.innerHTML = `<strong>✗ 连通失败</strong>: ${data.message}`;
    }
  } catch (err) {
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--cg-danger)';
    resultEl.innerHTML = `<strong>✗ 请求异常</strong>: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerText = '测试 LLM 连通性';
  }
}

// ============================================================
// ArtCraft 签名级全屏精密直尺滚动轨道控制器 (Precision Ruler Rail)
// ============================================================

function scrollToSettingCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ============================================================
// ArtCraft 官方 1:1 签名级全屏精密直尺与圆弧动力学文字系统
// (Expanded Precision Ruler Tape & Kinetic Arc Typography)
// ============================================================

const SETTING_SECTIONS = [
  { id: 'card-setting-paths', label: 'PATHS' },
  { id: 'card-setting-qas', label: 'QAS ENGINE' },
  { id: 'card-setting-tmdb', label: 'TMDB NETWORK' },
  { id: 'card-setting-llm', label: 'AI AGENT' },
];

const RULER_PX_PER_PERCENT = 42; // 每 1% 占 42px，0%~100% 卷尺总高 4200px，大尺度自然展开

function scrollToSettingCard(cardId) {
  const card = document.getElementById(cardId);
  const contentArea = document.querySelector('.content-area');
  if (card && contentArea) {
    const cardTop = card.offsetTop - 20;
    contentArea.scrollTo({ top: Math.max(0, cardTop), behavior: 'smooth' });
  }
}

function generateRulerTicks() {
  const layer = document.getElementById('ruler-ticks-layer');
  if (!layer || layer.children.length > 0) return;

  layer.style.height = `${100 * RULER_PX_PER_PERCENT}px`;
  let html = '';
  // 每 5% 一个长刻度与数字，中间穿插 4 根细短线，1:1 复刻 ArtCraft 原版
  for (let i = 0; i <= 100; i += 5) {
    const y = i * RULER_PX_PER_PERCENT;
    html += `
      <div class="ruler-tick-mark tick-major" data-percent="${i}" style="top:${y}px;">
        <span class="ruler-tick-label">${i}</span>
        <span class="ruler-tick-line" style="width:14px;"></span>
      </div>
    `;
    if (i < 100) {
      for (let s = 1; s <= 4; s++) {
        const sub = i + s;
        const subY = sub * RULER_PX_PER_PERCENT;
        html += `
          <div class="ruler-tick-mark tick-minor" data-percent="${sub}" style="top:${subY}px;">
            <span class="ruler-tick-line" style="width:6px;opacity:0.4;"></span>
          </div>
        `;
      }
    }
  }
  layer.innerHTML = html;
}

function renderKineticTypography(activeIndex, ratio, trackHeight) {
  const topDock = document.getElementById('kinetic-dock-top');
  const arcStage = document.getElementById('kinetic-arc-stage');
  const bottomDock = document.getElementById('kinetic-dock-bottom');
  if (!topDock || !arcStage || !bottomDock) return;

  const currentSec = SETTING_SECTIONS[activeIndex] || SETTING_SECTIONS[0];
  const nextSec = SETTING_SECTIONS[activeIndex + 1] || null;

  // 1. 顶部堆叠栈：已滚过的章节整齐排在顶部
  const pastSections = SETTING_SECTIONS.slice(0, activeIndex);
  topDock.innerHTML = pastSections
    .map(
      (sec) => `
    <div class="kinetic-top-item" onclick="scrollToSettingCard('${sec.id}')" title="回滚至 ${sec.label}">
      ${sec.label}
    </div>
  `
    )
    .join('');

  // 2. 底部堆叠栈：尚未开始进入动画的未来章节整齐排在底部
  const futureSections = SETTING_SECTIONS.slice(activeIndex + 2);
  bottomDock.innerHTML = futureSections
    .map(
      (sec) => `
    <div class="kinetic-bottom-item" onclick="scrollToSettingCard('${sec.id}')" title="直达 ${sec.label}">
      ${sec.label}
    </div>
  `
    )
    .join('');

  // 3. 中央圆弧粒子动画舞台 (Arc Stage)
  // 支持一个字母一个字母沿弧线升起与沉淀（参考用户原版动效图）
  let stageHtml = '';

  // (A) 当前活跃标题的字符渲染
  const curChars = currentSec.label.split('');
  const curCenterY = Math.max(90, Math.min(trackHeight - 200, 110 + ratio * (trackHeight - 260)));

  // 当 ratio > 0.65 时，当前标题开始逐字沿圆弧向上 peel 出视口
  const isExiting = ratio > 0.65 && nextSec;
  const exitProgress = isExiting ? (ratio - 0.65) / 0.35 : 0;

  curChars.forEach((ch, idx) => {
    let charX = (curChars.length - 1 - idx) * 18 + 12; // 默认水平靠右排列
    let charY = curCenterY;
    let rotateDeg = 0;
    let opacity = 1;
    let fontSize = 24;
    let color = '#121210';

    if (isExiting) {
      // 字母级阶梯延迟 (Stagger)
      const charDelay = idx * 0.08;
      const t = Math.max(0, Math.min(1, (exitProgress - charDelay) / (1 - idx * 0.04)));

      if (t > 0) {
        // 沿圆弧向右上翻转脱离
        const arcAngle = t * (Math.PI * 0.42); // 0 ~ 75 度
        const arcR = 120 + idx * 12;
        charX = Math.max(8, charX - Math.sin(arcAngle) * 45);
        charY = curCenterY - Math.sin(arcAngle) * (arcR * 0.85);
        rotateDeg = -arcAngle * (180 / Math.PI) * 0.8;
        opacity = Math.max(0.2, 1 - t * 0.7);
        color = t > 0.5 ? 'rgba(28,27,24,0.45)' : '#121210';
        fontSize = Math.max(14, 24 - t * 8);
      }
    }

    stageHtml += `
      <span class="kinetic-char" 
            onclick="scrollToSettingCard('${currentSec.id}')" 
            title="${currentSec.label}"
            style="right:${charX.toFixed(1)}px; top:${charY.toFixed(1)}px; transform:translateY(-50%) rotate(${rotateDeg.toFixed(1)}deg); opacity:${opacity.toFixed(2)}; font-size:${fontSize.toFixed(1)}px; color:${color};">
        ${ch === ' ' ? '&nbsp;' : ch}
      </span>
    `;
  });

  // (B) 下一个章节的字符渲染：当 ratio > 0.25 时，从底部沿圆弧一个字母一个字母升起沉淀
  if (nextSec) {
    const nextChars = nextSec.label.split('');
    const enterProgress = Math.max(0, Math.min(1, (ratio - 0.25) / 0.75));
    const bottomBaseY = trackHeight - 48;

    nextChars.forEach((ch, idx) => {
      // 字符反向阶梯延迟：靠右侧的字母（词尾）先起弧度，靠左侧的字母后起，形成如 ArtCraft 原版 COMMUNITY 的圆弧
      const staggerIndex = nextChars.length - 1 - idx;
      const charDelay = staggerIndex * 0.09;
      const t = Math.max(0, Math.min(1, (enterProgress - charDelay) / (1 - staggerIndex * 0.05)));

      let charX = (nextChars.length - 1 - idx) * 14 + 10;
      let charY = bottomBaseY;
      let rotateDeg = 0;
      let opacity = 0.35;
      let fontSize = 14;
      let color = 'rgba(28, 27, 24, 0.35)';

      if (t <= 0) {
        // 未脱离底部沉淀池：整齐排在底部
        charY = bottomBaseY;
        charX = (nextChars.length - 1 - idx) * 14 + 10;
        rotateDeg = 0;
        opacity = 0.35;
        fontSize = 14;
      } else {
        // 沿圆弧运动轨迹（Right-Convex Arc Kinetic Typography）
        const arcR = 160 + staggerIndex * 14;
        const maxAngle = Math.PI * 0.45; // 最大倾斜弧度
        const currentAngle = (1 - t) * maxAngle * (staggerIndex / (nextChars.length || 1));

        // 垂直高度平滑上浮
        charY = bottomBaseY - t * (bottomBaseY - curCenterY);
        // 水平向右弧凸
        const arcShift = Math.sin(currentAngle) * (arcR * 0.45);
        charX = Math.max(8, ((nextChars.length - 1 - idx) * 18 + 12) + arcShift * 0.6);
        // 旋转角度切线对齐
        rotateDeg = currentAngle * (180 / Math.PI) * 0.75;
        // 字号与颜色渐变
        fontSize = 14 + t * 10;
        opacity = 0.35 + t * 0.65;
        color = t > 0.85 ? '#121210' : `rgba(28, 27, 24, ${(0.35 + t * 0.55).toFixed(2)})`;
      }

      stageHtml += `
        <span class="kinetic-char" 
              onclick="scrollToSettingCard('${nextSec.id}')" 
              title="${nextSec.label}"
              style="right:${charX.toFixed(1)}px; top:${charY.toFixed(1)}px; transform:translateY(-50%) rotate(${rotateDeg.toFixed(1)}deg); opacity:${opacity.toFixed(2)}; font-size:${fontSize.toFixed(1)}px; color:${color};">
          ${ch === ' ' ? '&nbsp;' : ch}
        </span>
      `;
    });
  }

  arcStage.innerHTML = stageHtml;
}

function updateSettingsRulerRail() {
  const contentArea = document.querySelector('.content-area');
  const railTrack = document.getElementById('ruler-rail-track');
  const tape = document.getElementById('ruler-tape-scroll');
  const percentTag = document.getElementById('ruler-percent-tag');
  const rulerRail = document.getElementById('settings-ruler-rail');
  if (!contentArea || !railTrack || !rulerRail || !tape) return;
  if (state.currentTab !== 'settings') return;

  const scrollTop = contentArea.scrollTop;
  const maxScroll = Math.max(1, contentArea.scrollHeight - contentArea.clientHeight);
  const percent = Math.min(1, Math.max(0, scrollTop / maxScroll));

  const trackHeight = railTrack.clientHeight;
  const needleY = trackHeight * 0.68; // 原版固定位置：视口偏下方 68% 高度处

  // 1. 真实大尺度长卷尺上下平移（使当前百分比刻度线穿梭对齐至固定游标）
  const tapeY = needleY - (percent * 100 * RULER_PX_PER_PERCENT);
  tape.style.transform = `translateY(${tapeY.toFixed(1)}px)`;

  // 2. ArtCraft 标志性等宽纯蓝高精度百分比 (如 023%, 037%, 071%)
  if (percentTag) {
    const pStr = String(Math.round(percent * 100)).padStart(3, '0') + '%';
    percentTag.innerText = pStr;
  }

  // 3. 物理透镜动态放大：当游标停留在任何刻度时，周围刻度线与数字都会产生强烈的凸透镜放大
  const ticks = tape.querySelectorAll('.ruler-tick-mark');
  ticks.forEach((tick) => {
    const p = parseFloat(tick.getAttribute('data-percent') || '0');
    const tickScreenY = p * RULER_PX_PER_PERCENT + tapeY;
    const dist = Math.abs(tickScreenY - needleY);
    const line = tick.querySelector('.ruler-tick-line');
    const label = tick.querySelector('.ruler-tick-label');
    const isMajor = tick.classList.contains('tick-major');

    if (dist <= 65) {
      const k = Math.exp(-Math.pow(dist, 2) / (2 * Math.pow(22, 2)));
      if (line) {
        const w = (isMajor ? 14 : 6) + (isMajor ? 28 : 16) * k;
        line.style.width = `${w.toFixed(1)}px`;
        line.style.background = '#000000';
        line.style.height = `${(1 + 1.2 * k).toFixed(1)}px`;
        line.style.opacity = '1';
      }
      if (label) {
        label.style.fontSize = `${(8 + 3.5 * k).toFixed(1)}px`;
        label.style.color = '#000000';
        label.style.fontWeight = '800';
      }
    } else {
      if (line) {
        line.style.width = isMajor ? '14px' : '6px';
        line.style.background = isMajor ? 'rgba(28,27,24,0.32)' : 'rgba(28,27,24,0.18)';
        line.style.height = '1px';
        line.style.opacity = isMajor ? '0.85' : '0.4';
      }
      if (label) {
        label.style.fontSize = '8px';
        label.style.color = 'rgba(28,27,24,0.4)';
        label.style.fontWeight = 'normal';
      }
    }
  });

  // 4. 驱动字符级圆弧动力学文字排布
  const viewRect = contentArea.getBoundingClientRect();
  const viewTriggerLine = viewRect.top + viewRect.height * 0.48;
  let activeIndex = 0;
  let activeCardRatio = 0;

  SETTING_SECTIONS.forEach((sec, idx) => {
    const el = document.getElementById(sec.id);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top <= viewTriggerLine && r.bottom >= viewTriggerLine) {
        activeIndex = idx;
        const total = r.height || 1;
        activeCardRatio = Math.max(0, Math.min(1, (viewTriggerLine - r.top) / total));
      }
    }
  });

  renderKineticTypography(activeIndex, activeCardRatio, trackHeight);
}

function initSettingsRulerRail() {
  const contentArea = document.querySelector('.content-area');
  const railTrack = document.getElementById('ruler-rail-track');
  const ghost = document.getElementById('ruler-ghost');
  if (!contentArea || !railTrack) return;

  generateRulerTicks();

  let isDraggingRail = false;

  function scrubRailTo(e) {
    const rect = railTrack.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const ratio = y / rect.height;
    const maxScroll = contentArea.scrollHeight - contentArea.clientHeight;
    contentArea.scrollTop = ratio * maxScroll;
  }

  contentArea.addEventListener('scroll', () => {
    window.requestAnimationFrame(updateSettingsRulerRail);
  }, { passive: true });
  window.addEventListener('scroll', () => {
    window.requestAnimationFrame(updateSettingsRulerRail);
  }, { passive: true });
  document.addEventListener('scroll', () => {
    window.requestAnimationFrame(updateSettingsRulerRail);
  }, { passive: true });
  window.addEventListener('resize', () => {
    window.requestAnimationFrame(updateSettingsRulerRail);
  });

  railTrack.addEventListener('pointerenter', () => {
    if (ghost) ghost.style.opacity = '0.5';
  });
  railTrack.addEventListener('pointerleave', () => {
    if (ghost && !isDraggingRail) ghost.style.opacity = '0';
  });
  railTrack.addEventListener('pointermove', (e) => {
    if (ghost) {
      const rect = railTrack.getBoundingClientRect();
      const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      ghost.style.transform = `translateY(${y}px)`;
    }
    if (isDraggingRail) {
      scrubRailTo(e);
    }
  });

  railTrack.addEventListener('pointerdown', (e) => {
    isDraggingRail = true;
    railTrack.setPointerCapture(e.pointerId);
    scrubRailTo(e);
  });

  railTrack.addEventListener('pointerup', (e) => {
    isDraggingRail = false;
    try { railTrack.releasePointerCapture(e.pointerId); } catch (_) {}
    if (ghost) ghost.style.opacity = '0';
  });

  railTrack.addEventListener('pointercancel', (e) => {
    isDraggingRail = false;
    try { railTrack.releasePointerCapture(e.pointerId); } catch (_) {}
    if (ghost) ghost.style.opacity = '0';
  });
}

// 初始化绑定事件
document.addEventListener('DOMContentLoaded', () => {
  initSettingsRulerRail();
  initGlobalSearch();
  initMobileSearch();
  initManualSearchFilters();
  document.getElementById('menu-toggle-btn')?.addEventListener('click', openSidebar);
  document.getElementById('sidebar-close-btn')?.addEventListener('click', closeSidebar);
  document.getElementById('sidebar-backdrop')?.addEventListener('click', closeSidebar);

  // 绑定侧边栏 Tab
  document.querySelectorAll('.nav-item[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      switchTab(el.getAttribute('data-tab'));
    });
  });

  // 绑定分类标签切换
  document.querySelectorAll('#filter-category .filter-pill').forEach((el) => {
    el.addEventListener('click', () => {
      if (state.isSearchMode) {
        exitGlobalSearch(false);
      }
      document.querySelectorAll('#filter-category .filter-pill').forEach((p) => p.classList.remove('active'));
      el.classList.add('active');
      state.category = el.getAttribute('data-category');
      loadDiscover(true);
    });
  });

  // 绑定地区语言标签切换
  document.querySelectorAll('#filter-region .filter-pill').forEach((el) => {
    el.addEventListener('click', () => {
      if (state.isSearchMode) {
        exitGlobalSearch(false);
      }
      document.querySelectorAll('#filter-region .filter-pill').forEach((p) => p.classList.remove('active'));
      el.classList.add('active');
      state.region = el.getAttribute('data-region');
      loadDiscover(true);
    });
  });

  // 绑定输入框变化事件更新预览
  ['input-path-movie', 'input-path-tv', 'input-path-anime', 'input-path-variety', 'input-path-doc'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', updateAllPreviews);
    }
  });

  // 绑定 AI 透视弹窗背景点击关闭
  const aiInsightModal = document.getElementById('modal-ai-insight');
  if (aiInsightModal) {
    aiInsightModal.addEventListener('click', (e) => {
      if (e.target === aiInsightModal) closeAiInsightModal();
    });
  }

  // 全部结果抽屉：筛选/排序、背景点击关闭、Esc 关闭
  const resultsDrawerFilters = document.getElementById('results-drawer-filters');
  if (resultsDrawerFilters) {
    resultsDrawerFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.drawer-chip');
      if (!btn) return;
      if (btn.dataset.filter) state.drawerFilter = btn.dataset.filter;
      if (btn.dataset.sort) state.drawerSort = btn.dataset.sort;
      renderResultsDrawer();
    });
  }
  const resultsDrawerBackdrop = document.getElementById('results-drawer-backdrop');
  if (resultsDrawerBackdrop) {
    resultsDrawerBackdrop.addEventListener('click', (e) => {
      if (e.target === resultsDrawerBackdrop) closeResultsDrawer();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeResultsDrawer();
  });

  // 默认启动
  loadConfig().then(() => {
    loadDiscover();
  });
});
