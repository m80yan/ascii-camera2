/**
 * @file 可选：云端同步用户作品列表（与 `gallery-storage.js` 的 localStorage 合并）。
 * - **Supabase**：每幅作品为 `ascii_photos` 独立一行（insert/delete + 拉取列表），不再整包覆盖 JSON blob，避免移动端覆盖全库。
 * - **JSONBin**：仍使用单 bin 整包读写（旧路径，易撞额度）。
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
  /** 与 `localStorage` 键同步：最近一次成功推送或已采纳的远端 `updatedAt`，用于忽略更旧的 GET。 */
  var LAST_PUSH_UPDATED_AT_LS_KEY = 'ascii_gallery_last_push_updated_at';

  /**
   * @returns {number}
   */
  function readLastSuccessfulPushUpdatedAtFromStorage() {
    try {
      var v = global.localStorage.getItem(LAST_PUSH_UPDATED_AT_LS_KEY);
      if (!v) return 0;
      var n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * @param {number} ts
   * @returns {void}
   */
  function writeLastSuccessfulPushUpdatedAtToStorage(ts) {
    try {
      global.localStorage.setItem(LAST_PUSH_UPDATED_AT_LS_KEY, String(ts));
    } catch (e) {
      /* ignore */
    }
  }

  /** 最近一次成功 PUT 的 `updatedAt`；拉取到更旧快照时丢弃；刷新页面后从 localStorage 恢复。 */
  var lastSuccessfulPushUpdatedAt = readLastSuccessfulPushUpdatedAtFromStorage();
  /** Supabase：用户作品区与 `ascii_photos` 同步的缓存（画廊渲染读此路径，不读 `ascii_gallery_sync.body`）。 */
  var supabaseGalleryUserCache = [];
  /** 是否已打印「仅 ascii_photos」调试说明 */
  var loggedAsciiPhotosSsoNotice = false;
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
      /** 仅 JSONBin 时代遗留；Supabase 作品已改用 {@link getSupabasePhotosTable}。 */
      table: (w.ASCII_CAMERA_SUPABASE_TABLE && String(w.ASCII_CAMERA_SUPABASE_TABLE).trim()) || 'ascii_gallery_sync',
      rowId: (w.ASCII_CAMERA_SUPABASE_ROW_ID && String(w.ASCII_CAMERA_SUPABASE_ROW_ID).trim()) || 'default'
    };
  }

  /**
   * @returns {string} PostgREST 表名，每行一张照片。
   */
  function getSupabasePhotosTable() {
    var w = global;
    var t = w.ASCII_CAMERA_SUPABASE_PHOTOS_TABLE && String(w.ASCII_CAMERA_SUPABASE_PHOTOS_TABLE).trim();
    return t || 'ascii_photos';
  }

  /**
   * @param {string | undefined} s
   * @returns {boolean}
   */
  function isUuidString(s) {
    return (
      typeof s === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    );
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
   * 拉取专用合并：先采纳远端列表（删除会从服务端传播到所有客户端），再并入本机「尚未在远端出现」的条目。
   * 忽略本地 `mine === false`（来自旧版「本地优先」合并的缓存），避免把已在云端删掉的作品并回。
   * @param {Array<{ascii:string,color?:string,time?:number,mine?:boolean,id?:string}>} remotePhotos
   * @param {Array<{ascii:string,color?:string,time?:number,mine?:boolean,id?:string}>} local
   * @param {number} max
   * @returns {Array<{ascii:string,color:string,time:number,mine:boolean,id:string}>}
   */
  function mergePullRemoteFirst(remotePhotos, local, max) {
    var map = Object.create(null);
    /**
     * @param {{ ascii?: string, color?: string, time?: number, mine?: boolean, id?: string }} p
     * @param {boolean} fromRemote
     * @returns {void}
     */
    function addOne(p, fromRemote) {
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
    (remotePhotos || []).forEach(function (pr) {
      addOne(pr, true);
    });
    (local || []).forEach(function (pr) {
      if (pr && typeof pr.mine === 'boolean' && pr.mine === false) return;
      addOne(pr, false);
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
   * 将 `ascii_photos` 行（`select=*`）转为画廊 UI 用条目：`time` 来自 `created_at`。
   * @param {{ id?: unknown, ascii?: string, color?: string, created_at?: string }} row
   * @returns {{ id: string, ascii: string, color: string, time: number, mine: boolean } | null}
   */
  function mapAsciiPhotoRow(row) {
    if (!row || typeof row.ascii !== 'string') return null;
    var id = row.id != null ? String(row.id).trim() : '';
    if (!id) return null;
    var t = row.created_at ? Date.parse(String(row.created_at)) : NaN;
    if (!Number.isFinite(t)) t = Date.now();
    return {
      id: id,
      ascii: row.ascii,
      color: typeof row.color === 'string' ? row.color : '#00ff41',
      time: t,
      mine: true
    };
  }

  /**
   * 拉取 `ascii_photos`：`select=*`，`order=created_at.desc`（与 Supabase JS 客户端语义一致）。
   * @param {number} limit
   * @returns {Promise<Array<{ id: string, ascii: string, color: string, time: number, mine: boolean }>>}
   */
  function fetchAsciiPhotosFromSupabase(limit) {
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var lim = Math.max(1, Math.min(500, typeof limit === 'number' ? limit : 24));
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?select=*&order=created_at.desc&limit=' +
      encodeURIComponent(String(lim));
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
              new Error('Supabase ascii_photos GET ' + res.status + (detail ? ': ' + detail : ''))
            );
          });
        }
        return res.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows)) return [];
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var m = mapAsciiPhotoRow(rows[i]);
          if (m) out.push(m);
        }
        if (typeof global.console !== 'undefined' && global.console.info) {
          global.console.info(
            '[gallery-sync] ascii_photos GET ok mappedRows=' +
              out.length +
              ' rawJsonRows=' +
              rows.length +
              ' (NOT ascii_gallery_sync)'
          );
        }
        return out;
      });
  }

  /**
   * 供 `gallery.html` 渲染：用户区 = 缓存表数据，示例图仅表为空时视觉上只有内置卡（仍 concat 示例）。
   * @returns {{ photos: Array<{id:string,ascii:string,color?:string,time?:number,mine?:boolean,isDefault?:boolean}>, userCount: number }}
   */
  function getPhotosForGalleryRender() {
    var builtins =
      global.AsciiCameraGalleryStorage && typeof global.AsciiCameraGalleryStorage.getBuiltinGalleryCards === 'function'
        ? global.AsciiCameraGalleryStorage.getBuiltinGalleryCards()
        : [];
    var user = supabaseGalleryUserCache.slice();
    return { photos: user.concat(builtins), userCount: user.length };
  }

  /**
   * 向 `ascii_photos` 插入一行（不整包覆盖）；`id` 为 UUID 时与本地 `prependUserPhoto` 对齐。
   * @param {{ ascii: string, color?: string, time?: number, id?: string }} photo
   * @returns {Promise<boolean>}
   */
  function insertPhotoRowSupabase(photo) {
    if (!photo || typeof photo.ascii !== 'string') return Promise.resolve(false);
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var url = c.url + '/rest/v1/' + encodeURIComponent(table);
    var createdIso =
      typeof photo.time === 'number' && Number.isFinite(photo.time)
        ? new Date(photo.time).toISOString()
        : new Date().toISOString();
    /** @type {{ ascii: string, color: string, created_at: string, id?: string }} */
    var body = {
      ascii: photo.ascii,
      color: typeof photo.color === 'string' ? photo.color : '#00ff41',
      created_at: createdIso
    };
    if (isUuidString(photo.id)) {
      body.id = photo.id;
    }
    var prefer = isUuidString(photo.id) ? 'return=minimal' : 'return=representation';
    pushInFlight = true;
    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        'Content-Type': 'application/json',
        Prefer: prefer
      },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        if (res.ok || res.status === 409) {
          if (res.status === 409) return true;
          if (prefer === 'return=representation') {
            return res.json().then(function (rows) {
              var row = Array.isArray(rows) && rows[0] ? rows[0] : null;
              var newId = row && row.id != null ? String(row.id) : '';
              if (
                newId &&
                global.AsciiCameraGalleryStorage &&
                typeof global.AsciiCameraGalleryStorage.setUserPhotoIdAt === 'function'
              ) {
                global.AsciiCameraGalleryStorage.setUserPhotoIdAt(0, newId);
              }
              return true;
            });
          }
          return true;
        }
        return readFetchErrorText(res).then(function (detail) {
          return Promise.reject(
            new Error('ascii_photos insert ' + res.status + (detail ? ': ' + detail : ''))
          );
        });
      })
      .catch(function (err) {
        if (typeof global.console !== 'undefined' && global.console.warn) {
          global.console.warn('[gallery-sync] ascii_photos INSERT failed', err);
        }
        syncStatus.lastPushAt = Date.now();
        syncStatus.lastPushOk = false;
        syncStatus.lastPushError = err && err.message ? String(err.message) : String(err);
        emitStatus();
        return false;
      })
      .then(function (ok) {
        if (ok) {
          if (typeof global.console !== 'undefined' && global.console.info) {
            global.console.info('[gallery-sync] ascii_photos INSERT success');
          }
          syncStatus.lastPushAt = Date.now();
          syncStatus.lastPushOk = true;
          syncStatus.lastPushError = '';
          emitStatus();
        }
        return ok;
      })
      .finally(function () {
        pushInFlight = false;
      });
  }

  /**
   * 按主键删除 `ascii_photos` 一行；非 UUID 的遗留 id 仅跳过远端（本地已删）。
   * @param {string} photoId
   * @returns {Promise<boolean>}
   */
  function deletePhotoRowSupabase(photoId) {
    if (!photoId || typeof photoId !== 'string') return Promise.resolve(true);
    if (!isUuidString(photoId)) return Promise.resolve(true);
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?id=eq.' +
      encodeURIComponent(photoId);
    pushInFlight = true;
    return fetch(url, {
      method: 'DELETE',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey
      }
    })
      .then(function (res) {
        if (res.ok || res.status === 404) {
          if (typeof global.console !== 'undefined' && global.console.info) {
            global.console.info(
              '[gallery-sync] ascii_photos DELETE success id=' + photoId + ' http=' + res.status
            );
          }
          syncStatus.lastPushAt = Date.now();
          syncStatus.lastPushOk = true;
          syncStatus.lastPushError = '';
          emitStatus();
          return true;
        }
        return readFetchErrorText(res).then(function (detail) {
          return Promise.reject(
            new Error('ascii_photos DELETE ' + res.status + (detail ? ': ' + detail : ''))
          );
        });
      })
      .catch(function (err) {
        if (typeof global.console !== 'undefined' && global.console.warn) {
          global.console.warn('[gallery-sync] ascii_photos DELETE failed id=' + photoId, err);
        }
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
    if (p === 'jsonbin') return fetchRemotePayloadJsonBin();
    return Promise.resolve({ schema: 1, updatedAt: 0, photos: [] });
  }

  /**
   * @param {{ schema: number, updatedAt: number, photos: Array<{ascii:string,color:string,time:number}> }} payload
   * @returns {Promise<void>}
   */
  function putRemotePayload(payload) {
    var p = getProvider();
    if (p === 'jsonbin') return putRemotePayloadJsonBin(payload);
    return Promise.resolve();
  }

  /**
   * Supabase：仅以 `ascii_photos` 覆盖缓存与 `localStorage` 用户列表（不合并旧本地、不用 JSON blob）。
   * 拉取失败时保留上次成功缓存，不把画廊替换成「仅示例」。
   * @returns {Promise<boolean>}
   */
  function pullOnceSupabase() {
    if (pushInFlight) {
      if (typeof global.console !== 'undefined' && global.console.info) {
        global.console.info('[gallery-sync] ascii_photos pull skipped (pushInFlight)');
      }
      return Promise.resolve(false);
    }
    if (
      !loggedAsciiPhotosSsoNotice &&
      typeof global.console !== 'undefined' &&
      global.console.info
    ) {
      loggedAsciiPhotosSsoNotice = true;
      global.console.info(
        '[gallery-sync] gallery data source = ascii_photos only (ascii_gallery_sync.body unused)'
      );
    }
    var max = global.AsciiCameraGalleryStorage.MAX_USER_PHOTOS || 24;
    var save = global.AsciiCameraGalleryStorage.saveUserPhotos;
    var beforeSnap = JSON.stringify(supabaseGalleryUserCache);
    return fetchAsciiPhotosFromSupabase(max)
      .then(function (remotePhotos) {
        if (pushInFlight) {
          return false;
        }
        supabaseGalleryUserCache = remotePhotos.slice();
        save(remotePhotos);
        var afterSnap = JSON.stringify(supabaseGalleryUserCache);
        if (typeof global.console !== 'undefined' && global.console.info) {
          global.console.info(
            '[gallery-sync] ascii_photos applied to gallery cache rows=' + supabaseGalleryUserCache.length
          );
        }
        return beforeSnap !== afterSnap;
      })
      .then(function (changed) {
        syncStatus.lastPullAt = Date.now();
        syncStatus.lastPullOk = true;
        syncStatus.lastPullError = '';
        emitStatus();
        return changed;
      })
      .catch(function (err) {
        if (typeof global.console !== 'undefined' && global.console.warn) {
          global.console.warn(
            '[gallery-sync] ascii_photos pull FAILED — keeping last good cache rows=' +
              supabaseGalleryUserCache.length,
            err
          );
        }
        syncStatus.lastPullAt = Date.now();
        syncStatus.lastPullOk = false;
        syncStatus.lastPullError = err && err.message ? String(err.message) : String(err);
        emitStatus();
        return false;
      });
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
    if (getProvider() === 'supabase') {
      return pullOnceSupabase();
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
        var merged = mergePullRemoteFirst(remotePhotos, local, max);
        var after = JSON.stringify(merged);
        if (pushInFlight) {
          return false;
        }
        lastSuccessfulPushUpdatedAt = Math.max(lastSuccessfulPushUpdatedAt, rUpdated);
        writeLastSuccessfulPushUpdatedAtToStorage(lastSuccessfulPushUpdatedAt);
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
   * 将当前本机列表写回远端。Supabase 已改为逐行 insert/delete，此处对 Supabase 为 no-op（成功）。
   * JSONBin 仍为整包 PUT。
   * @returns {Promise<boolean>} 已启用云端且 PUT 成功为 true；未配置云端视为成功；失败为 false
   */
  function pushFromLocal() {
    if (!isEnabled() || !global.AsciiCameraGalleryStorage) {
      emitStatus();
      return Promise.resolve(true);
    }
    if (getProvider() === 'supabase') {
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
        writeLastSuccessfulPushUpdatedAtToStorage(pushUpdatedAt);
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
   * 新增一幅作品到 Supabase（单行 insert）；非 Supabase 或未启用时视为成功。
   * @param {{ ascii: string, color?: string, time?: number, id?: string }} photo
   * @returns {Promise<boolean>}
   */
  function insertPhotoRow(photo) {
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(true);
    }
    return insertPhotoRowSupabase(photo).then(function (ok) {
      if (!ok) return false;
      return pullOnce().then(function () {
        return true;
      });
    });
  }

  /**
   * 从 Supabase 按 UUID 删除一行；非 UUID 或未启用时视为成功。
   * @param {string} photoId
   * @returns {Promise<boolean>}
   */
  function deletePhotoRow(photoId) {
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(true);
    }
    return deletePhotoRowSupabase(photoId).then(function (ok) {
      if (!ok) return false;
      return pullOnce().then(function () {
        return true;
      });
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
        if (changed || getProvider() === 'supabase') {
          onRemoteChanged();
        }
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
    insertPhotoRow: insertPhotoRow,
    deletePhotoRow: deletePhotoRow,
    getPhotosForGalleryRender: getPhotosForGalleryRender,
    /** @type {(s: string) => boolean} */
    isUuidPhotoId: isUuidString,
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
