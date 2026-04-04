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
  /** 上传进行中时跳过拉取，避免旧远端合并把本机已删作品写回。 */
  var pushInFlight = false;
  /** 最近一次成功 PUT 的 `updatedAt`；拉取到更旧快照时丢弃，避免慢 GET 晚到覆盖删除。 */
  var lastSuccessfulPushUpdatedAt = 0;
  /** 轮询间隔（毫秒）；嵌入页可较快看到相机页上传的更新 */
  var DEFAULT_POLL_MS = 16000;

  /** @type {((s: object) => void) | null} */
  var statusListener = null;

  var syncStatus = {
    lastPullAt: 0,
    /** @type {boolean | null} */
    lastPullOk: null,
    lastPullError: '',
    lastPushAt: 0,
    /** @type {boolean | null} */
    lastPushOk: null,
    lastPushError: ''
  };

  /**
   * @returns {{
   *   enabled: boolean,
   *   provider: 'supabase' | 'jsonbin' | null,
   *   lastPullAt: number,
   *   lastPullOk: boolean | null,
   *   lastPullError: string,
   *   lastPushAt: number,
   *   lastPushOk: boolean | null,
   *   lastPushError: string,
   *   pollIntervalMs: number
   * }}
   */
  function getSyncStatus() {
    return {
      enabled: isEnabled(),
      provider: getProvider(),
      lastPullAt: syncStatus.lastPullAt,
      lastPullOk: syncStatus.lastPullOk,
      lastPullError: syncStatus.lastPullError,
      lastPushAt: syncStatus.lastPushAt,
      lastPushOk: syncStatus.lastPushOk,
      lastPushError: syncStatus.lastPushError,
      pollIntervalMs: DEFAULT_POLL_MS
    };
  }

  /**
   * @param {((s: object) => void) | null} fn
   * @returns {void}
   */
  function setStatusListener(fn) {
    statusListener = typeof fn === 'function' ? fn : null;
    emitStatus();
  }

  /**
   * @returns {void}
   */
  function emitStatus() {
    if (typeof statusListener !== 'function') return;
    try {
      statusListener(getSyncStatus());
    } catch (e) {
      /* ignore */
    }
  }

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
   * `a` 为本机列表（无 `mine` 时视为本人）；`b` 为远端（无 `mine` 时视为非本人）。
   * @param {Array<{ascii:string,color?:string,time?:number,mine?:boolean}>} a
   * @param {Array<{ascii:string,color?:string,time?:number,mine?:boolean}>} b
   * @param {number} max
   * @returns {Array<{ascii:string,color:string,time:number,mine:boolean}>}
   */
  function mergePhotoLists(a, b, max) {
    var map = Object.create(null);
    /**
     * @param {{ ascii?: string, color?: string, time?: number, mine?: boolean }} p
     * @param {boolean} fromRemote 仅经远端进入本机的条目一律 `mine: false`（忽略 JSON 中的 `mine`，避免他机把他人作品当成本地可 REMOVE）。
     */
    function add(p, fromRemote) {
      if (!p || typeof p.ascii !== 'string') return;
      var k = photoDedupeKey(p);
      if (!k || map[k]) return;
      var mine = fromRemote
        ? false
        : typeof p.mine === 'boolean'
          ? p.mine
          : true;
      var sid =
        typeof p.id === 'string' && p.id
          ? p.id
          : global.AsciiCameraGalleryStorage && typeof global.AsciiCameraGalleryStorage.stableLegacyPhotoId === 'function'
            ? global.AsciiCameraGalleryStorage.stableLegacyPhotoId(p)
            : 'photo_fallback';
      map[k] = {
        ascii: p.ascii,
        color: typeof p.color === 'string' ? p.color : '#00ff41',
        time: typeof p.time === 'number' ? p.time : Date.now(),
        mine: mine,
        id: sid
      };
    }
    (a || []).forEach(function (pr) {
      add(pr, false);
    });
    (b || []).forEach(function (pr) {
      add(pr, true);
    });
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
   * 从 fetch Response 读取可读错误信息（Supabase 常返回 JSON `{ message, hint }`）。
   * @param {Response} res
   * @returns {Promise<string>}
   */
  function readFetchErrorText(res) {
    return res
      .clone()
      .text()
      .then(function (t) {
        var s = (t || '').trim().slice(0, 400);
        if (!s) return '';
        try {
          var j = JSON.parse(s);
          if (j && typeof j === 'object') {
            var msg = j.message || j.error_description || j.hint || '';
            if (typeof msg === 'string' && msg) return msg.slice(0, 300);
          }
        } catch (e) {
          /* 非 JSON */
        }
        return s;
      })
      .catch(function () {
        return '';
      });
  }

  /**
   * @returns {Promise<{ schema: number, updatedAt: number, photos: Array<{ascii:string,color?:string,time?:number}> }>}
   */
  function fetchRemotePayloadSupabase() {
    var c = getSupabaseConfig();
    /** @note 勿加 `&_=Date.now()`：PostgREST 会把 `_` 当成列名解析，导致 400 failed to parse filter。 */
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(c.table) +
      '?id=eq.' +
      encodeURIComponent(c.rowId) +
      '&select=body';
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
        if (!res.ok) {
          return readFetchErrorText(res).then(function (detail) {
            return Promise.reject(
              new Error('Supabase GET ' + res.status + (detail ? ': ' + detail : ''))
            );
          });
        }
        return res.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
          return { schema: 1, updatedAt: 0, photos: [] };
        }
        var body = rows[0].body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch (e) {
            body = {};
          }
        }
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
      if (!res.ok) {
        return readFetchErrorText(res).then(function (detail) {
          return Promise.reject(
            new Error('Supabase upsert ' + res.status + (detail ? ': ' + detail : ''))
          );
        });
      }
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
    if (!isEnabled() || !global.AsciiCameraGalleryStorage) {
      emitStatus();
      return Promise.resolve(false);
    }
    if (pushInFlight) {
      return Promise.resolve(false);
    }
    var max = global.AsciiCameraGalleryStorage.MAX_USER_PHOTOS || 24;
    var load = global.AsciiCameraGalleryStorage.loadUserPhotos;
    var save = global.AsciiCameraGalleryStorage.saveUserPhotos;
    var before = JSON.stringify(load());
    return fetchRemotePayload()
      .then(function (remote) {
        if (pushInFlight) {
          return false;
        }
        var rUpdated =
          remote && typeof remote.updatedAt === 'number' ? remote.updatedAt : 0;
        if (lastSuccessfulPushUpdatedAt > rUpdated) {
          return false;
        }
        var remotePhotos = remote && remote.photos ? remote.photos : [];
        var local = load();
        var merged = mergePhotoLists(local, remotePhotos, max);
        var after = JSON.stringify(merged);
        if (pushInFlight) {
          return false;
        }
        if (before !== after) {
          save(merged);
          return true;
        }
        return false;
      })
      .then(function (changed) {
        syncStatus.lastPullAt = Date.now();
        syncStatus.lastPullOk = true;
        syncStatus.lastPullError = '';
        emitStatus();
        return changed;
      })
      .catch(function (err) {
        console.warn('[gallery-cloud-sync] pull failed', err);
        syncStatus.lastPullAt = Date.now();
        syncStatus.lastPullOk = false;
        syncStatus.lastPullError = err && err.message ? String(err.message) : String(err);
        emitStatus();
        return false;
      });
  }

  /**
   * 将当前本机列表写回远端（不再先 GET 再合并，否则删除后旧远端会把已删作品并回 PUT）。
   * @returns {Promise<boolean>} 已启用云端且 PUT 成功为 true；未配置云端视为成功；失败为 false
   */
  function pushFromLocal() {
    if (!isEnabled() || !global.AsciiCameraGalleryStorage) {
      emitStatus();
      return Promise.resolve(true);
    }
    var max = global.AsciiCameraGalleryStorage.MAX_USER_PHOTOS || 24;
    var load = global.AsciiCameraGalleryStorage.loadUserPhotos;
    pushInFlight = true;
    var local = load();
    var photos = mergePhotoLists(local, [], max);
    var pushUpdatedAt = Date.now();
    return putRemotePayload({
      schema: 1,
      updatedAt: pushUpdatedAt,
      photos: photos
    })
      .then(function () {
        lastSuccessfulPushUpdatedAt = pushUpdatedAt;
        syncStatus.lastPushAt = Date.now();
        syncStatus.lastPushOk = true;
        syncStatus.lastPushError = '';
        emitStatus();
        return true;
      })
      .catch(function (err) {
        console.warn('[gallery-cloud-sync] push failed', err);
        syncStatus.lastPushAt = Date.now();
        syncStatus.lastPushOk = false;
        syncStatus.lastPushError = err && err.message ? String(err.message) : String(err);
        emitStatus();
        return false;
      })
      .finally(function () {
        pushInFlight = false;
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

  var CLIENT_ID_STORAGE_KEY = 'ascii_gallery_client_id_v1';

  /**
   * @returns {string}
   */
  function getLikesTable() {
    var w = global;
    return (
      (w.ASCII_CAMERA_SUPABASE_LIKES_TABLE && String(w.ASCII_CAMERA_SUPABASE_LIKES_TABLE).trim()) ||
      'ascii_photo_likes'
    );
  }

  /**
   * @returns {boolean}
   */
  function likesApiEnabled() {
    return getProvider() === 'supabase';
  }

  /**
   * @returns {string}
   */
  function getOrCreateClientId() {
    try {
      var existing = global.localStorage && global.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
      if (existing && typeof existing === 'string' && existing.length > 4) return existing;
      var id =
        global.crypto && typeof global.crypto.randomUUID === 'function'
          ? global.crypto.randomUUID()
          : 'cid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
      if (global.localStorage) global.localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
      return id;
    } catch (e) {
      return 'cid_volatile_' + Date.now();
    }
  }

  /**
   * @param {string} photoId
   * @returns {Promise<{ count: number, likedByMe: boolean }>}
   */
  function fetchPhotoLikeState(photoId) {
    if (!photoId || typeof photoId !== 'string') {
      return Promise.resolve({ count: 0, likedByMe: false });
    }
    if (!likesApiEnabled()) {
      return Promise.resolve({ count: 0, likedByMe: false });
    }
    var c = getSupabaseConfig();
    var table = getLikesTable();
    var clientId = getOrCreateClientId();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?photo_id=eq.' +
      encodeURIComponent(photoId) +
      '&select=client_id';
    var headers = {
      apikey: c.anonKey,
      Authorization: 'Bearer ' + c.anonKey,
      Accept: 'application/json'
    };
    return fetch(url, { method: 'GET', cache: 'no-store', headers: headers }).then(function (res) {
      if (!res.ok) {
        return Promise.reject(new Error('likes list ' + res.status));
      }
      return res.json();
    }).then(function (rows) {
      var list = Array.isArray(rows) ? rows : [];
      var count = list.length;
      var likedByMe = list.some(function (r) {
        return r && r.client_id === clientId;
      });
      return { count: count, likedByMe: likedByMe };
    });
  }

  /**
   * @param {string} photoId
   * @returns {Promise<void>}
   */
  function addPhotoLike(photoId) {
    if (!likesApiEnabled() || !photoId) return Promise.resolve();
    var c = getSupabaseConfig();
    var table = getLikesTable();
    var url = c.url + '/rest/v1/' + encodeURIComponent(table);
    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ photo_id: photoId, client_id: getOrCreateClientId() })
    }).then(function (res) {
      if (res.ok || res.status === 409) return;
      return readFetchErrorText(res).then(function (detail) {
        return Promise.reject(new Error('like POST ' + res.status + (detail ? ': ' + detail : '')));
      });
    });
  }

  /**
   * @param {string} photoId
   * @returns {Promise<void>}
   */
  function removePhotoLike(photoId) {
    if (!likesApiEnabled() || !photoId) return Promise.resolve();
    var c = getSupabaseConfig();
    var table = getLikesTable();
    var cid = getOrCreateClientId();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?photo_id=eq.' +
      encodeURIComponent(photoId) +
      '&client_id=eq.' +
      encodeURIComponent(cid);
    return fetch(url, {
      method: 'DELETE',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey
      }
    }).then(function (res) {
      if (!res.ok && res.status !== 404) {
        return readFetchErrorText(res).then(function (detail) {
          return Promise.reject(new Error('like DELETE ' + res.status + (detail ? ': ' + detail : '')));
        });
      }
    });
  }

  /**
   * 从点赞表移除某作品的全部点赞（作品从画廊同步删除后调用，避免云端残留 likes）。
   * @param {string} photoId
   * @returns {Promise<boolean>}
   */
  function deleteAllLikesForPhotoId(photoId) {
    if (!photoId || typeof photoId !== 'string') return Promise.resolve(true);
    if (!likesApiEnabled()) return Promise.resolve(true);
    var c = getSupabaseConfig();
    var table = getLikesTable();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?photo_id=eq.' +
      encodeURIComponent(photoId);
    return fetch(url, {
      method: 'DELETE',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey
      }
    }).then(function (res) {
      if (!res.ok && res.status !== 404) {
        return readFetchErrorText(res).then(function (detail) {
          return Promise.reject(
            new Error('likes cleanup DELETE ' + res.status + (detail ? ': ' + detail : ''))
          );
        });
      }
      return true;
    });
  }

  global.AsciiCameraGalleryCloudSync = {
    isEnabled: isEnabled,
    getProvider: getProvider,
    getSyncStatus: getSyncStatus,
    setStatusListener: setStatusListener,
    pullOnce: pullOnce,
    pushFromLocal: pushFromLocal,
    schedulePush: schedulePush,
    startPolling: startPolling,
    stopPolling: stopPolling,
    /** @type {number} */
    DEFAULT_POLL_MS: DEFAULT_POLL_MS,
    likesApiEnabled: likesApiEnabled,
    getOrCreateClientId: getOrCreateClientId,
    fetchPhotoLikeState: fetchPhotoLikeState,
    addPhotoLike: addPhotoLike,
    removePhotoLike: removePhotoLike,
    deleteAllLikesForPhotoId: deleteAllLikesForPhotoId
  };
})(typeof window !== 'undefined' ? window : globalThis);
