/**
 * @file 可选：云端同步用户作品列表（与 `gallery-storage.js` 的 localStorage 合并）。
 * - **Supabase**：每幅作品为 `ascii_photos` 独立一行（`owner_id`＝`ascii_camera_device_id_v1`；点赞用独立 `client_id`；insert/delete + 拉取列表），不再整包覆盖 JSON blob，避免移动端覆盖全库。
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
  /**
   * 仅用于 Supabase `ascii_photos` 列表 GET 的 `limit` / 画廊分页每批条数。
   */
  var SUPABASE_ASCII_PHOTOS_FETCH_LIMIT = 60;
  /**
   * `ascii_photos.preview_ascii` 最大长度（由完整 `ascii` 截断生成；与插入逻辑一致）。
   * @type {number}
   */
  var PREVIEW_ASCII_MAX_LENGTH = 8192;

  /**
   * 由完整 ASCII 生成列表/预览用短文本（不修改 `ascii` 字段本身）。
   * @param {string} full
   * @returns {string}
   */
  function derivePreviewAsciiFromAscii(full) {
    if (typeof full !== 'string') return '';
    if (full.length <= PREVIEW_ASCII_MAX_LENGTH) return full;
    return full.slice(0, PREVIEW_ASCII_MAX_LENGTH);
  }

  /** @type {boolean} 与 `gallery.html` 当前标签同步：Loop 为 true（轮询首屏用 `is_animated=eq.true`） */
  var galleryFeedLoopOnly = false;
  /** @type {number} 下一批 range 请求的 offset（由画廊写入，供日志/未来扩展） */
  var galleryFeedNextOffset = 0;
  /** @type {boolean} 策展模式：列表含已软删行（`is_deleted=true`） */
  var galleryCuratorIncludeDeleted = false;

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

  var CLIENT_ID_STORAGE_KEY = 'ascii_gallery_client_id_v1';
  /** 作品归属 `owner_id` 专用；与点赞 `client_id` 分离。 */
  var DEVICE_ID_STORAGE_KEY = 'ascii_camera_device_id_v1';
  /**
   * 埋点用：当前浏览器稳定 visitor_id（长期保留在 localStorage）。
   * @returns {string}
   */
  function getOrCreateVisitorId() {
    var key = 'ascii_camera_visitor_id';
    try {
      var ls = global.localStorage;
      var existing = ls && ls.getItem(key);
      if (existing && typeof existing === 'string' && existing.length > 4) return existing;
      var id =
        global.crypto && typeof global.crypto.randomUUID === 'function'
          ? global.crypto.randomUUID()
          : 'vid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
      if (ls) ls.setItem(key, id);
      return id;
    } catch (e) {
      return 'vid_volatile_' + Date.now();
    }
  }

  /**
   * 埋点用：当前标签页 session_id（保留在 sessionStorage）。
   * @returns {string}
   */
  function getOrCreateSessionId() {
    var key = 'ascii_camera_session_id';
    try {
      var ss = global.sessionStorage;
      var existing = ss && ss.getItem(key);
      if (existing && typeof existing === 'string' && existing.length > 4) return existing;
      var id =
        global.crypto && typeof global.crypto.randomUUID === 'function'
          ? global.crypto.randomUUID()
          : 'sid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
      if (ss) ss.setItem(key, id);
      return id;
    } catch (e) {
      return 'sid_volatile_' + Date.now();
    }
  }
  /**
   * 写入一条产品行为埋点到 analytics_events。
   * @param {string} eventName
   * @param {{
   *   photoId?: string,
   *   meta?: Record<string, unknown>
   * }} [extra]
   * @returns {Promise<boolean>}
   */
  function trackEvent(eventName, extra) {
    extra = extra || {};
    if (!eventName || typeof eventName !== 'string') {
      return Promise.resolve(false);
    }
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(false);
    }

    var c = getSupabaseConfig();
    var url = c.url + '/rest/v1/analytics_events';

    var payload = {
      event_name: eventName,
      photo_id: typeof extra.photoId === 'string' ? extra.photoId : null,
      visitor_id: getOrCreateVisitorId(),
      session_id: getOrCreateSessionId(),
      page_path: global.location && global.location.pathname ? String(global.location.pathname) : null,
      referrer:
        global.document && typeof global.document.referrer === 'string' && global.document.referrer
          ? global.document.referrer
          : null,
      user_agent:
        global.navigator && typeof global.navigator.userAgent === 'string'
          ? global.navigator.userAgent
          : null,
      meta: extra.meta && typeof extra.meta === 'object' ? extra.meta : {}
    };

    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (res.ok) return true;
        return readFetchErrorText(res).then(function (detail) {
          throw new Error('analytics_events insert ' + res.status + (detail ? ': ' + detail : ''));
        });
      })
      .catch(function (err) {
        if (typeof global.console !== 'undefined' && global.console.warn) {
          global.console.warn('[gallery-sync] trackEvent failed', eventName, err);
        }
        return false;
      });
  }

  /**
   * 本机稳定设备 id，写入 `ascii_photos.owner_id`；与 `mine` 判定同源。
   * 优先读专用键；若无则迁移旧版 `ascii_gallery_client_id_v1` 一次；仍无则 `randomUUID`。
   * @returns {string}
   */
  function getOrCreateDeviceId() {
    try {
      var ls = global.localStorage;
      if (ls) {
        var d = ls.getItem(DEVICE_ID_STORAGE_KEY);
        if (d && typeof d === 'string' && d.length > 4) return d;
        var legacy = ls.getItem(CLIENT_ID_STORAGE_KEY);
        if (legacy && typeof legacy === 'string' && legacy.length > 4) {
          ls.setItem(DEVICE_ID_STORAGE_KEY, legacy);
          return legacy;
        }
      }
      var id =
        global.crypto && typeof global.crypto.randomUUID === 'function'
          ? global.crypto.randomUUID()
          : 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
      if (ls) ls.setItem(DEVICE_ID_STORAGE_KEY, id);
      return id;
    } catch (e) {
      return 'dev_volatile_' + Date.now();
    }
  }

  /**
   * 点赞表 `client_id` 用（与 `owner_id` / device_id 独立）。
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
   * 复用 `gallery.html` 里 `ensureAnonymousSession` 挂载的 `window.__ASCII_GALLERY_SUPABASE__`，供 REST 写入携带 JWT 与 `user_id`（满足 `user_id = auth.uid()`）。
   * @returns {Promise<{ accessToken: string, userId: string } | null>}
   */
  function getGallerySupabaseAuthForRest() {
    var sb = global.__ASCII_GALLERY_SUPABASE__;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') {
      return Promise.resolve(null);
    }
    return sb.auth
      .getSession()
      .then(function (result) {
        var sess = result && result.data && result.data.session;
        var uid = sess && sess.user && sess.user.id;
        if (!sess || !sess.access_token || uid == null || uid === '') {
          return null;
        }
        return { accessToken: sess.access_token, userId: String(uid) };
      })
      .catch(function () {
        return null;
      });
  }

  /**
   * 将 `ascii_photos` 行转为画廊 UI 用条目：`time` 来自 `created_at`；列表拉取不含 `frames`（悬停时再取）。
   * 列表请求不 select `preview_ascii`，仅用完整 `ascii` 渲染，与灯箱一致。
   * `owner_id` 缺失或空时 `mine` 为 false（不猜测历史行归属）。
   * @param {{ id?: unknown, ascii?: string, color?: string, created_at?: string, owner_id?: unknown, is_animated?: unknown, frame_count?: unknown, fps?: unknown, duration_ms?: unknown, is_deleted?: unknown }} row
   * @returns {{ id: string, ascii: string, color: string, time: number, mine: boolean, isDeleted?: boolean, isAnimated?: boolean, frameCount?: number, fps?: number, durationMs?: number } | null}
   */
  function mapAsciiPhotoRow(row) {
    if (!row || typeof row.ascii !== 'string') return null;
    var id = row.id != null ? String(row.id).trim() : '';
    if (!id) return null;
    var t = row.created_at ? Date.parse(String(row.created_at)) : NaN;
    if (!Number.isFinite(t)) t = Date.now();
    var ownerRaw = row.owner_id;
    var owner =
      ownerRaw != null && typeof ownerRaw === 'string' && ownerRaw.trim() ? ownerRaw.trim() : '';
    var cur = getOrCreateDeviceId();
    var mine = owner.length > 0 && owner === cur;
    var isAnimated = row.is_animated === true;
    var isDel = row.is_deleted === true;
    /** @type {{ id: string, ascii: string, color: string, time: number, mine: boolean, isDeleted?: boolean, isAnimated?: boolean, frameCount?: number, fps?: number, durationMs?: number }} */
    var out = {
      id: id,
      ascii: row.ascii,
      color: typeof row.color === 'string' ? row.color : '#00ff41',
      time: t,
      mine: mine
    };
    if (isDel) {
      out.isDeleted = true;
    }
    if (isAnimated) {
      out.isAnimated = true;
      var fc = row.frame_count;
      out.frameCount = typeof fc === 'number' && Number.isFinite(fc) ? fc : undefined;
      var fp = row.fps;
      out.fps = typeof fp === 'number' && Number.isFinite(fp) ? fp : undefined;
      var dm = row.duration_ms;
      out.durationMs = typeof dm === 'number' && Number.isFinite(dm) ? dm : undefined;
    }
    return out;
  }

  /**
   * 拉取 `ascii_photos` 一页（offset/limit）；不含 `frames` 列。
   * Loop 时在查询串加 `is_animated=eq.true`（服务端过滤）。
   * @param {number} limit
   * @param {number} [offset]
   * @param {boolean} [loopOnly]
   * @returns {Promise<Array<{ id: string, ascii: string, color: string, time: number, mine: boolean, isDeleted?: boolean, isAnimated?: boolean, frameCount?: number, fps?: number, durationMs?: number }>>}
   */
  function fetchAsciiPhotosPageFromSupabase(limit, offset, loopOnly, includeDeleted) {
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var lim = Math.max(
      1,
      Math.min(500, typeof limit === 'number' ? limit : SUPABASE_ASCII_PHOTOS_FETCH_LIMIT)
    );
    var off = Math.max(0, typeof offset === 'number' && Number.isFinite(offset) ? offset : 0);
    var cols =
      'id,ascii,color,created_at,owner_id,is_animated,frame_count,fps,duration_ms,is_deleted';
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?select=' +
      encodeURIComponent(cols) +
      '&order=created_at.desc&limit=' +
      encodeURIComponent(String(lim)) +
      '&offset=' +
      encodeURIComponent(String(off));
    if (includeDeleted !== true) {
      url += '&or=(is_deleted.is.null,is_deleted.eq.false)';
    }
    if (loopOnly === true) {
      url += '&is_animated=eq.true';
    }
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
   * 供画廊分页：`offset`/`limit` 与当前标签的 Loop 过滤。
   * @param {number} offset PostgREST `offset`
   * @param {number} limit PostgREST `limit`
   * @param {boolean} loopOnly 仅 `is_animated=true`
   * @returns {Promise<Array<{ id: string, ascii: string, color: string, time: number, mine: boolean, isAnimated?: boolean, frameCount?: number, fps?: number, durationMs?: number }>>}
   */
  function fetchGalleryPage(offset, limit, loopOnly) {
    return fetchAsciiPhotosPageFromSupabase(
      limit,
      offset,
      loopOnly === true,
      galleryCuratorIncludeDeleted === true
    );
  }

  /**
   * 策展模式：是否拉取含 `is_deleted=true` 的行（与 `gallery.html` 策展开关同步）。
   * @param {boolean} include
   * @returns {void}
   */
  function setGalleryCuratorIncludeDeleted(include) {
    galleryCuratorIncludeDeleted = include === true;
  }

  /**
   * 从内存缓存与 localStorage 移除一条（软删成功后立即更新 UI）。
   * @param {string} photoId
   * @returns {void}
   */
  function removePhotoFromGalleryCacheById(photoId) {
    if (!photoId || typeof photoId !== 'string') return;
    var next = [];
    for (var i = 0; i < supabaseGalleryUserCache.length; i++) {
      var r = supabaseGalleryUserCache[i];
      if (r && String(r.id) !== photoId) next.push(r);
    }
    supabaseGalleryUserCache = next;
    if (global.AsciiCameraGalleryStorage && typeof global.AsciiCameraGalleryStorage.saveUserPhotos === 'function') {
      global.AsciiCameraGalleryStorage.saveUserPhotos(supabaseGalleryUserCache);
    }
  }

  /**
   * 覆盖内存与 localStorage 用户列表（切换标签或首屏加载）。
   * @param {Array<{ id?: string, ascii?: string }>} photos
   * @returns {void}
   */
  function replaceSupabaseGalleryUserCache(photos) {
    var list = Array.isArray(photos) ? photos.slice() : [];
    supabaseGalleryUserCache = list;
    if (global.AsciiCameraGalleryStorage && typeof global.AsciiCameraGalleryStorage.saveUserPhotos === 'function') {
      global.AsciiCameraGalleryStorage.saveUserPhotos(list);
    }
  }

  /**
   * 追加一页并按 `id` 去重（保留既有顺序，仅追加新 id）。
   * @param {Array<{ id?: string, ascii?: string }>} photos
   * @returns {void}
   */
  function appendSupabaseGalleryUserCache(photos) {
    if (!Array.isArray(photos) || photos.length === 0) return;
    if (!supabaseGalleryUserCache.length) {
      replaceSupabaseGalleryUserCache(photos);
      return;
    }
    var seen = {};
    var i;
    for (i = 0; i < supabaseGalleryUserCache.length; i++) {
      var r = supabaseGalleryUserCache[i];
      if (r && r.id) seen[String(r.id)] = true;
    }
    var add = [];
    for (i = 0; i < photos.length; i++) {
      var p = photos[i];
      if (!p || p.id == null) continue;
      var id = String(p.id);
      if (seen[id]) continue;
      seen[id] = true;
      add.push(p);
    }
    if (!add.length) return;
    supabaseGalleryUserCache = supabaseGalleryUserCache.concat(add);
    if (global.AsciiCameraGalleryStorage && typeof global.AsciiCameraGalleryStorage.saveUserPhotos === 'function') {
      global.AsciiCameraGalleryStorage.saveUserPhotos(supabaseGalleryUserCache);
    }
  }

  /**
   * 画廊同步轮询上下文（`pullOnceSupabase` 合并策略与查询过滤用）。
   * @param {{ loopOnly?: boolean, nextOffset?: number }} ctx
   * @returns {void}
   */
  function setGalleryFeedPollContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    galleryFeedLoopOnly = ctx.loopOnly === true;
    var n = ctx.nextOffset;
    galleryFeedNextOffset =
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /**
   * 供 `gallery.html` 渲染：用户区 = `ascii_photos` 缓存（无内置示例拼接）。
   * @returns {{ photos: Array<{id:string,ascii:string,color?:string,time?:number,mine?:boolean,isDefault?:boolean}>, userCount: number }}
   */
  function getPhotosForGalleryRender() {
    var user = supabaseGalleryUserCache.slice();
    return { photos: user, userCount: user.length };
  }

  /**
   * 按主键仅拉取 `frames`（悬停 / 导出 GIF）；非 UUID 或失败时返回 null。
   * @param {string} photoId
   * @returns {Promise<string[] | null>}
   */
  function fetchAsciiPhotoFramesById(photoId) {
    if (!photoId || typeof photoId !== 'string' || !isUuidString(photoId)) {
      return Promise.resolve(null);
    }
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?id=eq.' +
      encodeURIComponent(photoId) +
      '&select=frames&limit=1';
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
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows[0]) return null;
        var f = rows[0].frames;
        if (!Array.isArray(f)) return null;
        var out = [];
        for (var i = 0; i < f.length; i++) {
          if (typeof f[i] === 'string') out.push(f[i]);
        }
        return out.length ? out : null;
      })
      .catch(function () {
        return null;
      });
  }

  /**
   * 向 `ascii_photos` 插入一行（不整包覆盖）；`id` 为 UUID 时与本地 `prependUserPhoto` 对齐。
   * 写入前从 `window.__ASCII_GALLERY_SUPABASE__` 取 session，设置 `Authorization: Bearer <access_token>` 与 body `user_id`；无会话则返回 false（静默）。
   * @param {{ ascii: string, preview_ascii?: string, color?: string, time?: number, id?: string, isAnimated?: boolean, frames?: string[], frameCount?: number, fps?: number, durationMs?: number }} photo
   * @returns {Promise<boolean>}
   */
  function insertPhotoRowSupabase(photo) {
    if (!photo || typeof photo.ascii !== 'string') return Promise.resolve(false);
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var url = c.url + '/rest/v1/' + encodeURIComponent(table);
    var prefer = isUuidString(photo.id) ? 'return=minimal' : 'return=representation';
    pushInFlight = true;
    return getGallerySupabaseAuthForRest()
      .then(function (auth) {
        if (!auth) {
          return false;
        }
        var createdIso =
          typeof photo.time === 'number' && Number.isFinite(photo.time)
            ? new Date(photo.time).toISOString()
            : new Date().toISOString();
        var isAnim = photo.isAnimated === true;
        var previewAscii = derivePreviewAsciiFromAscii(
          typeof photo.preview_ascii === 'string' && photo.preview_ascii.length > 0
            ? photo.preview_ascii
            : photo.ascii
        );
        /** @type {{ ascii: string, preview_ascii: string, color: string, created_at: string, owner_id: string, user_id: string, id?: string, is_animated: boolean, frames: string[] | null, frame_count: number | null, fps: number | null, duration_ms: number | null }} */
        var body = {
          ascii: photo.ascii,
          preview_ascii: previewAscii,
          color: typeof photo.color === 'string' ? photo.color : '#00ff41',
          created_at: createdIso,
          owner_id: getOrCreateDeviceId(),
          user_id: auth.userId,
          is_animated: isAnim,
          frames: null,
          frame_count: null,
          fps: null,
          duration_ms: null
        };
        if (isAnim && Array.isArray(photo.frames) && photo.frames.length > 0) {
          body.frames = photo.frames;
          body.frame_count =
            typeof photo.frameCount === 'number' && Number.isFinite(photo.frameCount)
              ? photo.frameCount
              : photo.frames.length;
          body.fps =
            typeof photo.fps === 'number' && Number.isFinite(photo.fps) ? photo.fps : 6;
          body.duration_ms =
            typeof photo.durationMs === 'number' && Number.isFinite(photo.durationMs)
              ? photo.durationMs
              : 2000;
        }
        if (isUuidString(photo.id)) {
          body.id = photo.id;
        }
        return fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            apikey: c.anonKey,
            Authorization: 'Bearer ' + auth.accessToken,
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
          });
      })
      .finally(function () {
        pushInFlight = false;
      });
  }

  /**
   * 按主键删除 `ascii_photos` 一行；非 UUID 的遗留 id 仅跳过远端（本地已删）。
   * @param {string} photoId
   * @param {{ accessToken: string, userId: string } | null} [authOpt] 来自 {@link getGallerySupabaseAuthForRest}；缺省则回退 anon JWT
   * @returns {Promise<boolean>}
   */
  function deletePhotoRowSupabase(photoId, authOpt) {
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
    var useJwt = !!(authOpt && authOpt.accessToken);
    var bearer = useJwt ? authOpt.accessToken : c.anonKey;
    // #region agent log
    fetch('http://127.0.0.1:7520/ingest/be823198-74c3-4055-9412-4c580ba8a956', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '12e1b7' },
      body: JSON.stringify({
        sessionId: '12e1b7',
        location: 'gallery-cloud-sync.js:deletePhotoRowSupabase',
        message: 'DELETE request about to send',
        data: {
          hypothesisId: 'A',
          table: table,
          photoId8: photoId.slice(0, 8),
          authHeaderKind: useJwt ? 'user_jwt' : 'anon_key',
          hasWindowGallerySupabase: !!global.__ASCII_GALLERY_SUPABASE__
        },
        timestamp: Date.now()
      })
    }).catch(function () {});
    // #endregion
    pushInFlight = true;
    return fetch(url, {
      method: 'DELETE',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + bearer
      }
    })
      .then(function (res) {
        // #region agent log
        fetch('http://127.0.0.1:7520/ingest/be823198-74c3-4055-9412-4c580ba8a956', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '12e1b7' },
          body: JSON.stringify({
            sessionId: '12e1b7',
            location: 'gallery-cloud-sync.js:deletePhotoRowSupabase',
            message: 'DELETE response',
            data: {
              hypothesisId: 'A',
              httpStatus: res.status,
              ok: res.ok
            },
            timestamp: Date.now()
          })
        }).catch(function () {});
        // #endregion
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
   * PATCH `ascii_photos` 单行（软删 / 恢复等）。
   * @param {string} photoId
   * @param {Record<string, unknown>} body
   * @param {{ accessToken: string, userId: string } | null} [authOpt]
   * @returns {Promise<boolean>}
   */
  function patchAsciiPhotoRowSupabase(photoId, body, authOpt) {
    if (!photoId || typeof photoId !== 'string' || !isUuidString(photoId)) {
      return Promise.resolve(false);
    }
    var c = getSupabaseConfig();
    var table = getSupabasePhotosTable();
    var url =
      c.url +
      '/rest/v1/' +
      encodeURIComponent(table) +
      '?id=eq.' +
      encodeURIComponent(photoId);
    var useJwt = !!(authOpt && authOpt.accessToken);
    var bearer = useJwt ? authOpt.accessToken : c.anonKey;
    pushInFlight = true;
    return fetch(url, {
      method: 'PATCH',
      cache: 'no-store',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + bearer,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        if (res.ok || res.status === 204) {
          if (typeof global.console !== 'undefined' && global.console.info) {
            global.console.info(
              '[gallery-sync] ascii_photos PATCH success id=' + photoId + ' http=' + res.status
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
            new Error('ascii_photos PATCH ' + res.status + (detail ? ': ' + detail : ''))
          );
        });
      })
      .catch(function (err) {
        if (typeof global.console !== 'undefined' && global.console.warn) {
          global.console.warn('[gallery-sync] ascii_photos PATCH failed id=' + photoId, err);
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
   * 合并更新内存与 localStorage 中的某条缓存（恢复后刷新 UI）。
   * @param {string} photoId
   * @param {Record<string, unknown>} fields
   * @returns {void}
   */
  function mergePhotoFieldsInGalleryCache(photoId, fields) {
    if (!photoId || typeof photoId !== 'string' || !fields || typeof fields !== 'object') return;
    var changed = false;
    for (var i = 0; i < supabaseGalleryUserCache.length; i++) {
      var r = supabaseGalleryUserCache[i];
      if (r && String(r.id) === photoId) {
        var k;
        for (k in fields) {
          if (Object.prototype.hasOwnProperty.call(fields, k)) {
            if (k === 'isDeleted' && fields[k] === false) {
              delete r.isDeleted;
            } else {
              r[k] = fields[k];
            }
          }
        }
        changed = true;
        break;
      }
    }
    if (changed && global.AsciiCameraGalleryStorage && typeof global.AsciiCameraGalleryStorage.saveUserPhotos === 'function') {
      global.AsciiCameraGalleryStorage.saveUserPhotos(supabaseGalleryUserCache);
    }
  }

  /**
   * 软删：仅 PATCH，不从点赞表删行。
   * @param {string} photoId
   * @param {{ bypassOwnershipCheck?: boolean, deleteReason?: string }} [opts]
   * @returns {Promise<boolean>}
   */
  function softDeletePhotoRow(photoId, opts) {
    opts = opts || {};
    var bypass = opts.bypassOwnershipCheck === true;
    var reason =
      typeof opts.deleteReason === 'string' && opts.deleteReason.trim()
        ? opts.deleteReason.trim()
        : 'owner_remove';
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(true);
    }
    return getGallerySupabaseAuthForRest().then(function (auth) {
      if (isUuidString(photoId) && !bypass) {
        if (!isSupabasePhotoMineById(photoId)) {
          if (typeof global.console !== 'undefined' && global.console.warn) {
            global.console.warn(
              '[gallery-sync] ascii_photos soft delete skipped (not owner) id=' + photoId
            );
          }
          return Promise.resolve(false);
        }
      }
      var deletedBy = auth && auth.userId ? auth.userId : getOrCreateDeviceId();
      /** @type {Record<string, unknown>} */
      var body = {
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: deletedBy,
        delete_reason: reason,
        delete_mode: 'soft'
      };
      return patchAsciiPhotoRowSupabase(photoId, body, auth).then(function (ok) {
        if (!ok) return false;
        removePhotoFromGalleryCacheById(photoId);
        return true;
      });
    });
  }

  /**
   * 恢复软删行（策展/管理员；由页面用 `bypassOwnershipCheck` 控制）。
   * @param {string} photoId
   * @param {{ bypassOwnershipCheck?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  function restorePhotoRow(photoId, opts) {
    opts = opts || {};
    var bypass = opts.bypassOwnershipCheck === true;
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(true);
    }
    return getGallerySupabaseAuthForRest().then(function (auth) {
      if (isUuidString(photoId) && !bypass && !isSupabasePhotoMineById(photoId)) {
        if (typeof global.console !== 'undefined' && global.console.warn) {
          global.console.warn(
            '[gallery-sync] ascii_photos restore skipped (not owner) id=' + photoId
          );
        }
        return Promise.resolve(false);
      }
      /** @type {Record<string, unknown>} */
      var body = {
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
        delete_reason: 'restore',
        delete_mode: 'soft'
      };
      return patchAsciiPhotoRowSupabase(photoId, body, auth).then(function (ok) {
        if (!ok) return false;
        mergePhotoFieldsInGalleryCache(photoId, { isDeleted: false });
        return true;
      });
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
   * 临时轮询校验日志：列表首条 `id`（与网格顺序一致）。
   * @param {unknown[] | null | undefined} rows
   * @returns {string}
   */
  function firstRowIdForPollLog(rows) {
    if (!rows || !rows.length) return '(none)';
    var r = rows[0];
    if (!r || typeof r !== 'object' || r.id == null || r.id === '') return '(no-id)';
    return String(r.id);
  }

  /**
   * Supabase：仅以 `ascii_photos` 覆盖缓存与 `localStorage` 用户列表（不合并旧本地、不用 JSON blob）。
   * 拉取失败时保留上次成功缓存。
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
    var save = global.AsciiCameraGalleryStorage.saveUserPhotos;
    var beforeSnap = JSON.stringify(supabaseGalleryUserCache);
    return fetchAsciiPhotosPageFromSupabase(
      SUPABASE_ASCII_PHOTOS_FETCH_LIMIT,
      0,
      galleryFeedLoopOnly,
      galleryCuratorIncludeDeleted === true
    )
      .then(function (remotePhotos) {
        if (pushInFlight) {
          return false;
        }
        var beforeCount = supabaseGalleryUserCache.length;
        var beforeFirstId = firstRowIdForPollLog(supabaseGalleryUserCache);
        var first = Array.isArray(remotePhotos) ? remotePhotos : [];
        var useMerge = supabaseGalleryUserCache.length > SUPABASE_ASCII_PHOTOS_FETCH_LIMIT;
        if (useMerge) {
          var firstIds = {};
          var j;
          for (j = 0; j < first.length; j++) {
            var fr = first[j];
            if (fr && fr.id != null) firstIds[String(fr.id)] = true;
          }
          var tail = [];
          for (j = 0; j < supabaseGalleryUserCache.length; j++) {
            var row = supabaseGalleryUserCache[j];
            if (!row || row.id == null) continue;
            if (!firstIds[String(row.id)]) tail.push(row);
          }
          supabaseGalleryUserCache = first.concat(tail);
        } else {
          supabaseGalleryUserCache = first.slice();
        }
        save(supabaseGalleryUserCache);
        var afterSnap = JSON.stringify(supabaseGalleryUserCache);
        var changed = beforeSnap !== afterSnap;
        var afterCount = supabaseGalleryUserCache.length;
        var afterFirstId = firstRowIdForPollLog(supabaseGalleryUserCache);
        if (typeof global.console !== 'undefined' && global.console.info) {
          global.console.info('[gallery-sync poll] supabase pull', {
            changed: changed,
            beforeCount: beforeCount,
            afterCount: afterCount,
            beforeFirstId: beforeFirstId,
            afterFirstId: afterFirstId
          });
        }
        return changed;
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
   * @param {{ ascii: string, preview_ascii?: string, color?: string, time?: number, id?: string, isAnimated?: boolean, frames?: string[], frameCount?: number, fps?: number, durationMs?: number }} photo
   * @returns {Promise<boolean>}
   */
  function insertPhotoRow(photo) {
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(true);
    }
    return insertPhotoRowSupabase(photo).then(function (ok) {
      if (!ok) return false;
      var photoId = '';
      if (
        global.AsciiCameraGalleryStorage &&
        typeof global.AsciiCameraGalleryStorage.loadUserPhotos === 'function'
      ) {
        var list = global.AsciiCameraGalleryStorage.loadUserPhotos();
        if (list && list[0] && typeof list[0].id === 'string' && list[0].id) {
          photoId = list[0].id;
        }
      }
      if (!photoId && photo && typeof photo.id === 'string') {
        photoId = photo.id;
      }
      if (photoId) {
        trackEvent('upload_photo', { photoId: photoId });
      }
      return pullOnce().then(function () {
        return true;
      });
    });
  }

  /**
   * 在 `ascii_photos` 缓存中按主键查找一行（用于删除前校验归属）。
   * @param {string} photoId
   * @returns {{ id: string, ascii: string, color: string, time: number, mine: boolean } | null}
   */
  function findCachedSupabasePhotoById(photoId) {
    if (!photoId || typeof photoId !== 'string') return null;
    for (var i = 0; i < supabaseGalleryUserCache.length; i++) {
      var row = supabaseGalleryUserCache[i];
      if (row && String(row.id) === photoId) return row;
    }
    return null;
  }

  /**
   * 是否允许当前客户端以「本人作品」删除该行：先查内存缓存，再查 `localStorage` 用户列表（与 pull 后数据应对齐）。
   * @param {string} photoId
   * @returns {boolean}
   */
  function isSupabasePhotoMineById(photoId) {
    var fromCache = findCachedSupabasePhotoById(photoId);
    if (fromCache) return fromCache.mine === true;
    if (!global.AsciiCameraGalleryStorage || typeof global.AsciiCameraGalleryStorage.loadUserPhotos !== 'function') {
      return false;
    }
    var list = global.AsciiCameraGalleryStorage.loadUserPhotos();
    for (var j = 0; j < list.length; j++) {
      var p = list[j];
      if (p && String(p.id) === photoId) return p.mine === true;
    }
    return false;
  }

  /**
   * 从 Supabase 删除一行：`hardDelete` 默认 `true` 为物理 DELETE；`hardDelete=false` 为软删 PATCH。
   * 物理删除前先从缓存移除该行，避免分页 tail 残留旧 id。
   * @param {string} photoId
   * @param {{ bypassOwnershipCheck?: boolean, hardDelete?: boolean, deleteReason?: string }} [opts]
   * @returns {Promise<boolean>}
   */
  function deletePhotoRow(photoId, opts) {
    opts = opts || {};
    if (!isEnabled() || getProvider() !== 'supabase') {
      return Promise.resolve(true);
    }
    if (opts.hardDelete === false) {
      return softDeletePhotoRow(photoId, opts);
    }
    var bypass = opts.bypassOwnershipCheck === true;
    return getGallerySupabaseAuthForRest()
      .then(function (auth) {
        // #region agent log
        fetch('http://127.0.0.1:7520/ingest/be823198-74c3-4055-9412-4c580ba8a956', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '12e1b7' },
          body: JSON.stringify({
            sessionId: '12e1b7',
            location: 'gallery-cloud-sync.js:deletePhotoRow',
            message: 'deletePhotoRow after getSession',
            data: {
              hypothesisId: 'B',
              photoId8: photoId ? String(photoId).slice(0, 8) : '',
              isUuid: isUuidString(photoId),
              bypass: bypass,
              hasAuth: !!auth,
              mineIfChecked:
                isUuidString(photoId) && !bypass && !auth ? isSupabasePhotoMineById(photoId) : null
            },
            timestamp: Date.now()
          })
        }).catch(function () {});
        // #endregion
        if (isUuidString(photoId) && !bypass && !auth) {
          if (!isSupabasePhotoMineById(photoId)) {
            if (typeof global.console !== 'undefined' && global.console.warn) {
              global.console.warn(
                '[gallery-sync] ascii_photos DELETE skipped (not owner) id=' + photoId
              );
            }
            // #region agent log
            fetch('http://127.0.0.1:7520/ingest/be823198-74c3-4055-9412-4c580ba8a956', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '12e1b7' },
              body: JSON.stringify({
                sessionId: '12e1b7',
                location: 'gallery-cloud-sync.js:deletePhotoRow',
                message: 'DELETE blocked by ownership gate',
                data: { hypothesisId: 'B', photoId8: photoId ? String(photoId).slice(0, 8) : '' },
                timestamp: Date.now()
              })
            }).catch(function () {});
            // #endregion
            return Promise.resolve(false);
          }
        }
        return deletePhotoRowSupabase(photoId, auth);
      })
      .then(function (ok) {
        if (!ok) return false;
        removePhotoFromGalleryCacheById(photoId);
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
      if (typeof global.console !== 'undefined' && global.console.info) {
        global.console.info('[gallery-sync poll] tick');
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (typeof global.console !== 'undefined' && global.console.info) {
          global.console.info('[gallery-sync poll] tick skipped (document hidden)');
        }
        return;
      }
      pullOnce().then(function (changed) {
        if (typeof global.console !== 'undefined' && global.console.info) {
          global.console.info('[gallery-sync poll] tick complete', {
            changed: changed,
            refreshUi: changed === true
          });
        }
        if (changed) {
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
    return getGallerySupabaseAuthForRest().then(function (auth) {
      if (!auth) return;
      return fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          apikey: c.anonKey,
          Authorization: 'Bearer ' + auth.accessToken,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          photo_id: photoId,
          client_id: getOrCreateClientId(),
          user_id: auth.userId
        })
      }).then(function (res) {
        if (res.ok || res.status === 409) return;
        return readFetchErrorText(res).then(function (detail) {
          return Promise.reject(new Error('like POST ' + res.status + (detail ? ': ' + detail : '')));
        });
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
    /** 与 `PREVIEW_ASCII_MAX_LENGTH` 一致：由 `ascii` 生成 `preview_ascii`（供本页保存与插入共用）。 */
    derivePreviewAscii: derivePreviewAsciiFromAscii,
    isEnabled: isEnabled,
    getProvider: getProvider,
    getSyncStatus: getSyncStatus,
    setStatusListener: setStatusListener,
    pullOnce: pullOnce,
    pushFromLocal: pushFromLocal,
    insertPhotoRow: insertPhotoRow,
    deletePhotoRow: deletePhotoRow,
    restorePhotoRow: restorePhotoRow,
    setGalleryCuratorIncludeDeleted: setGalleryCuratorIncludeDeleted,
    removePhotoFromGalleryCacheById: removePhotoFromGalleryCacheById,
    getPhotosForGalleryRender: getPhotosForGalleryRender,
    /** 画廊分页每批条数（与内部 `SUPABASE_ASCII_PHOTOS_FETCH_LIMIT` 相同） */
    GALLERY_PAGE_SIZE: SUPABASE_ASCII_PHOTOS_FETCH_LIMIT,
    fetchGalleryPage: fetchGalleryPage,
    replaceSupabaseGalleryUserCache: replaceSupabaseGalleryUserCache,
    appendSupabaseGalleryUserCache: appendSupabaseGalleryUserCache,
    setGalleryFeedPollContext: setGalleryFeedPollContext,
    /** @type {(s: string) => boolean} */
    isUuidPhotoId: isUuidString,
    schedulePush: schedulePush,
    startPolling: startPolling,
    stopPolling: stopPolling,
    /** @type {number} */
    DEFAULT_POLL_MS: DEFAULT_POLL_MS,
    likesApiEnabled: likesApiEnabled,
    getOrCreateClientId: getOrCreateClientId,
    getOrCreateDeviceId: getOrCreateDeviceId,
    getOrCreateVisitorId: getOrCreateVisitorId,
    getOrCreateSessionId: getOrCreateSessionId,
    trackEvent: trackEvent,
    fetchPhotoLikeState: fetchPhotoLikeState,
    addPhotoLike: addPhotoLike,
    removePhotoLike: removePhotoLike,
    deleteAllLikesForPhotoId: deleteAllLikesForPhotoId,
    fetchAsciiPhotoFramesById: fetchAsciiPhotoFramesById
  };
})(typeof window !== 'undefined' ? window : globalThis);
