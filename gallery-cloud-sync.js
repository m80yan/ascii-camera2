/**
 * @file 可选：云端同步用户作品列表（与 `gallery-storage.js` 的 localStorage 合并）。
 * 支持 Supabase（推荐，免费层较宽裕）或 JSONBin v3（易遇请求额度限制）。
 * 配置见 `config.local.js` / Vercel 环境变量（`scripts/inject-config.js`）。
 */
(function (global) {
  var JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';
  /** @type {number | null} */
  var pollTimerId = null;
  /** @type {number | null} */
  var pushDebounceId = null;
  var PUSH_DEBOUNCE_MS = 700;
  var DEFAULT_POLL_MS = 22000;

  /**
   * @returns {'supabase' | 'jsonbin' | null}
   */
  function getProvider() {
    var w = global;
    var su = (w.ASCII_CAMERA_SUPABASE_URL && String(w.ASCII_CAMERA_SUPABASE_URL).trim()) || '';
    var sk = (w.ASCII_CAMERA_SUPABASE_ANON_KEY && String(w.ASCII_CAMERA_SUPABASE_ANON_KEY).trim()) || '';
    if (su && sk) return 'supabase';
    var binId = (w.ASCII_CAMERA_BIN_ID && String(w.ASCII_CAMERA_BIN_ID).trim()) || '';
    var apiKey = (w.ASCII_CAMERA_API_KEY && String(w.ASCII_CAMERA_API_KEY).trim()) || '';
    if (binId && apiKey) return 'jsonbin';
    return null;
  }

  /**
   * @returns {boolean}
   */
  function isEnabled() {
    return getProvider() !== null;
  }

  /**
   * @returns {{ url: string, anonKey: string, table: string, rowId: string }}
   */
  function getSupabaseConfig() {
    var w = global;
    return {
      url: String(w.ASCII_CAMERA_SUPABASE_URL || '').replace(/\/$/, ''),
      anonKey: String(w.ASCII_CAMERA_SUPABASE_ANON_KEY || '').trim(),
      table: (w.ASCII_CAMERA_SUPABASE_TABLE && String(w.ASCII_CAMERA_SUPABASE_TABLE).trim()) || 'ascii_gallery_sync',
      rowId: (w.ASCII_CAMERA_SUPABASE_ROW_ID && String(w.ASCII_CAMERA_SUPABASE_ROW_ID).trim()) || 'default'
    };
  }

  /**
   * @returns {{ binId: string, apiKey: string }}
   */
  function getJsonBinConfig() {
    var w = global;
    return {
      binId: (w.ASCII_CAMERA_BIN_ID && String(w.ASCII_CAMERA_BIN_ID).trim()) || '',
      apiKey: (w.ASCII_CAMERA_API_KEY && String(w.ASCII_CAMERA_API_KEY).trim()) || ''
    };
  }

  /**
   * @param {{ ascii: string, color?: string, time?: number }} p
   * @returns {string}
   */
  function photoDedupeKey(p) {
    if (!p || typeof p.ascii !== 'string') return '';
    var t = typeof p.time === 'number' ? p.time : 0;
    return t + '\n' + p.ascii.length + '\n' + p.ascii.slice(0, 120);
  }

  /**
   * 合并两组用户照片：按 time 降序，去重，截断为 max 条。
   * @param {Array<{ascii:string,color?:string,time?:number}>} a
   * @param {Array<{ascii:string,color?:string,time?:number}>} b
   * @param {number} max
   * @returns {Array<{ascii:string,color:string,time:number}>}
   */
  function mergePhotoLists(a, b, max) {
    var map = Object.create(null);
    function add(p) {
      if (!p || typeof p.ascii !== 'string') return;
      var k = photoDedupeKey(p);
      if (!k || map[k]) return;
      map[k] = {
        ascii: p.ascii,
        color: typeof p.color === 'string' ? p.color : '#00ff41',
        time: typeof p.time === 'number' ? p.time : Date.now()
      };
    }
    (a || []).forEach(add);
    (b || []).forEach(add);
    var out = Object.keys(map).map(function (k) {
      return map[k];
    });
    out.sort(function (x, y) {
      return (y.time || 0) - (x.time || 0);
    });
    return out.slice(0, max);
  }

  /**
   * @param {unknown} rec
   * @returns {{ schema: number, updatedAt: number, photos: Array<{ascii:string,color?:string,time?:number}> }}
   */
  function normalizePayloadRecord(rec) {
    if (!rec || typeof rec !== 'object') {
      return { schema: 1, updatedAt: 0, photos: [] };
    }
    var r = /** @type {{ schema?: number, updatedAt?: number, photos?: unknown }} */ (rec);
    var photos = Array.isArray(r.photos) ? r.photos : [];
    return {
      schema: typeof r.schema === 'number' ? r.schema : 1,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      photos: photos
    };
  }

  /**
   * @returns {Promise<{ schema: number, updatedAt: number, photos: Array<{ascii:string,color?:string,time?:number}> }>}
   */
  function fetchRemotePayloadSupabase() {
    var c = getSupabaseConfig();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(c.table) +
      '?id=eq.' +
      encodeURIComponent(c.rowId) +
      '&select=body&_=' +
      Date.now();
    return fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        Accept: 'application/json'
      }
    })
      .then(function (res) {
        if (!res.ok) return Promise.reject(new Error('Supabase GET ' + res.status));
        return res.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
          return { schema: 1, updatedAt: 0, photos: [] };
        }
        var body = rows[0].body;
        return normalizePayloadRecord(body);
      });
  }

  /**
   * @param {{ schema: number, updatedAt: number, photos: Array<{ascii:string,color:string,time:number}> }} payload
   * @returns {Promise<void>}
   */
  function putRemotePayloadSupabase(payload) {
    var c = getSupabaseConfig();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(c.table) +
      '?on_conflict=id';
    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify([{ id: c.rowId, body: payload }])
    }).then(function (res) {
      if (!res.ok) return Promise.reject(new Error('Supabase upsert ' + res.status));
    });
  }

  /**
   * @returns {Promise<{ schema: number, updatedAt: number, photos: Array<{ascii:string,color?:string,time?:number}> }>}
   */
  function fetchRemotePayloadJsonBin() {
    var c = getJsonBinConfig();
    var url = JSONBIN_BASE + '/' + encodeURIComponent(c.binId) + '/latest?_=' + Date.now();
    return fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'X-Master-Key': c.apiKey,
        Accept: 'application/json'
      }
    })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) return Promise.reject(new Error('JSONBin GET ' + res.status));
        return res.json();
      })
      .then(function (body) {
        if (body === null || body === undefined) {
          return { schema: 1, updatedAt: 0, photos: [] };
        }
        if (!body || typeof body !== 'object') {
          return { schema: 1, updatedAt: 0, photos: [] };
        }
        var rec = /** @type {{ record?: unknown }} */ (body).record != null ? /** @type {{ record?: unknown }} */ (body).record : body;
        return normalizePayloadRecord(rec);
      });
  }

  /**
   * @param {{ schema: number, updatedAt: number, photos: Array<{ascii:string,color:string,time:number}> }} payload
   * @returns {Promise<void>}
   */
  function putRemotePayloadJsonBin(payload) {
    var c = getJsonBinConfig();
    var url = JSONBIN_BASE + '/' + encodeURIComponent(c.binId);
    return fetch(url, {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        'X-Master-Key': c.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) return Promise.reject(new Error('JSONBin PUT ' + res.status));
    });
  }

  /**
   * @returns {Promise<{ schema: number, updatedAt: number, photos: Array<{ascii:string,color?:string,time?:number}> }>}
   */
  function fetchRemotePayload() {
    var p = getProvider();
    if (p === 'supabase') return fetchRemotePayloadSupabase();
    if (p === 'jsonbin') return fetchRemotePayloadJsonBin();
    return Promise.resolve({ schema: 1, updatedAt: 0, photos: [] });
  }

  /**
   * @param {{ schema: number, updatedAt: number, photos: Array<{ascii:string,color:string,time:number}> }} payload
   * @returns {Promise<void>}
   */
  function putRemotePayload(payload) {
    var p = getProvider();
    if (p === 'supabase') return putRemotePayloadSupabase(payload);
    if (p === 'jsonbin') return putRemotePayloadJsonBin(payload);
    return Promise.resolve();
  }

  /**
   * 从云端拉取并与本机合并；若有变化则写入 localStorage。
   * @returns {Promise<boolean>} 本机用户列表是否发生变化（需刷新 UI）
   */
  function pullOnce() {
    if (!isEnabled() || !global.AsciiCameraGalleryStorage) return Promise.resolve(false);
    var max = global.AsciiCameraGalleryStorage.MAX_USER_PHOTOS || 24;
    var load = global.AsciiCameraGalleryStorage.loadUserPhotos;
    var save = global.AsciiCameraGalleryStorage.saveUserPhotos;
    var before = JSON.stringify(load());
    return fetchRemotePayload()
      .then(function (remote) {
        var remotePhotos = remote && remote.photos ? remote.photos : [];
        var local = load();
        var merged = mergePhotoLists(local, remotePhotos, max);
        var after = JSON.stringify(merged);
        if (before !== after) {
          save(merged);
          return true;
        }
        return false;
      })
      .catch(function (err) {
        console.warn('[gallery-cloud-sync] pull failed', err);
        return false;
      });
  }

  /**
   * 读取本机与云端合并后写回远端（读-改-写）。
   * @returns {Promise<void>}
   */
  function pushFromLocal() {
    if (!isEnabled() || !global.AsciiCameraGalleryStorage) return Promise.resolve();
    var max = global.AsciiCameraGalleryStorage.MAX_USER_PHOTOS || 24;
    var load = global.AsciiCameraGalleryStorage.loadUserPhotos;
    var local = load();
    return fetchRemotePayload()
      .then(function (remote) {
        var remotePhotos = remote && remote.photos ? remote.photos : [];
        var merged = mergePhotoLists(local, remotePhotos, max);
        return putRemotePayload({
          schema: 1,
          updatedAt: Date.now(),
          photos: merged
        });
      })
      .catch(function (err) {
        console.warn('[gallery-cloud-sync] push failed', err);
      });
  }

  /**
   * @returns {void}
   */
  function schedulePush() {
    if (!isEnabled()) return;
    if (pushDebounceId != null) clearTimeout(pushDebounceId);
    pushDebounceId = setTimeout(function () {
      pushDebounceId = null;
      pushFromLocal();
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * @param {() => void} onRemoteChanged 合并后需刷新 UI 时调用（由 Gallery 传入 `refreshGallery`）
   * @param {number} [intervalMs]
   * @returns {void}
   */
  function startPolling(onRemoteChanged, intervalMs) {
    stopPolling();
    if (!isEnabled() || typeof onRemoteChanged !== 'function') return;
    var ms = typeof intervalMs === 'number' && intervalMs >= 5000 ? intervalMs : DEFAULT_POLL_MS;
    function tick() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      pullOnce().then(function (changed) {
        if (changed) onRemoteChanged();
      });
    }
    pollTimerId = setInterval(tick, ms);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') tick();
      });
    }
  }

  /**
   * @returns {void}
   */
  function stopPolling() {
    if (pollTimerId != null) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  }

  global.AsciiCameraGalleryCloudSync = {
    isEnabled: isEnabled,
    getProvider: getProvider,
    pullOnce: pullOnce,
    pushFromLocal: pushFromLocal,
    schedulePush: schedulePush,
    startPolling: startPolling,
    stopPolling: stopPolling,
    /** @type {number} */
    DEFAULT_POLL_MS: DEFAULT_POLL_MS
  };
})(typeof window !== 'undefined' ? window : globalThis);
