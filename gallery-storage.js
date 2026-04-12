/**
 * @file 画廊本地存储（用户作品）；无内置示例图。
 */
(function (global) {
  var STORAGE_KEY = 'ascii_camera_local_photos_v1';
  var MAX_USER_PHOTOS = 24;

  /**
   * @returns {string} 新作品用随机 id（与 dedupe 无关）。
   */
  function generatePhotoId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }

  /**
   * 无 `id` 的旧数据：由 time + ascii 前缀生成稳定 id，便于多端与云端一致。
   * @param {{ ascii?: string, time?: number }} p
   * @returns {string}
   */
  function stableLegacyPhotoId(p) {
    var ascii = String((p && p.ascii) || '');
    var t = p && typeof p.time === 'number' ? p.time : 0;
    var key = t + '\n' + ascii.length + '\n' + ascii.slice(0, 120);
    var h = 2166136261;
    for (var i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'photo_' + (h >>> 0).toString(16);
  }

  /**
   * Camera 新标签页向 `window.opener`（嵌入中的 Gallery）同步作品时使用的 `postMessage` 类型。
   * 用于绕过第三方 iframe 与顶层标签页的存储分区（Storage Partitioning）隔离。
   * @type {string}
   */
  var GALLERY_PREPEND_MESSAGE_TYPE = 'ASCII_CAMERA_GALLERY_PREPEND';

  /**
   * 嵌入 iframe 内保存作品后，由 `gallery-bridge.html`（顶层弹窗）接收 `postMessage`，写入首方分区的 `localStorage`。
   * 与 `GALLERY_PREPEND_MESSAGE_TYPE`（Camera → 嵌入 Gallery）互补。
   * @type {string}
   */
  var GALLERY_MIRROR_TOP_MESSAGE_TYPE = 'ASCII_CAMERA_MIRROR_FIRST_PARTY';

  /**
   * 从嵌入页打开 Camera 时使用的 `window.open` 窗口名；避免 `_blank` 被宿主注入 `noopener` 导致丢失 `opener`。
   * @type {string}
   */
  var CAMERA_POPUP_WINDOW_NAME = 'ascii_camera_notion_embed';

  /**
   * 是否应向 `window.opener` 发 `postMessage` 同步作品（嵌入 iframe 内 Gallery ↔ 顶层 Camera 的存储分区不同）。
   * @param {Window | null | undefined} openerWin `camera` 页上的 `window.opener`
   * @returns {boolean}
   */
  function galleryOpenerNeedsPostMessage(openerWin) {
    if (!openerWin || openerWin.closed) return false;
    try {
      if (openerWin === openerWin.top) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  /**
   * 兼容 `scripts/build-gallery-defaults.js`；画廊不再嵌入内置示例图。
   * @type {Array<{id:string,ascii:string,color:string,time:number,isDefault:boolean}>}
   */
  var DEFAULT_GALLERY_PHOTOS = [];


  /**
   * @returns {Array<{id?:string,ascii:string,color?:string,time:number,mine?:boolean}>}
   */
  function loadUserPhotos() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      var changed = false;
      var next = arr.map(function (p) {
        if (!p || typeof p !== 'object') return p;
        if (typeof p.id === 'string' && p.id) return p;
        changed = true;
        return Object.assign({}, p, { id: stableLegacyPhotoId(p) });
      });
      if (changed) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (e2) {
          return arr;
        }
        return next;
      }
      return arr;
    } catch (e) {
      return [];
    }
  }

  /**
   * @param {Array<{ascii:string,color?:string,time:number}>} arr
   */
  function saveUserPhotos(arr) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  }

  /**
   * @param {{ascii:string,color?:string,preview_ascii?:string,time?:number,mine?:boolean,id?:string,isAnimated?:boolean,frameCount?:number,fps?:number,durationMs?:number}} photo 单条用户作品；默认 `mine: true`；无 `id` 时生成新 id。动画帧仅存云端，本地仅存元数据。
   */
  function prependUserPhoto(photo) {
    var list = loadUserPhotos();
    /** @type {{ascii:string,color:string,time:number,mine:boolean,id:string,preview_ascii?:string,isAnimated?:boolean,frameCount?:number,fps?:number,durationMs?:number}} */
    var row = {
      ascii: String(photo.ascii || ''),
      color: photo.color || '#00ff41',
      time: typeof photo.time === 'number' ? photo.time : Date.now(),
      mine: typeof photo.mine === 'boolean' ? photo.mine : true,
      id: typeof photo.id === 'string' && photo.id ? photo.id : generatePhotoId()
    };
    if (typeof photo.preview_ascii === 'string' && photo.preview_ascii.length > 0) {
      row.preview_ascii = photo.preview_ascii;
    }
    if (photo.isAnimated === true) {
      row.isAnimated = true;
      if (typeof photo.frameCount === 'number' && Number.isFinite(photo.frameCount)) {
        row.frameCount = photo.frameCount;
      }
      if (typeof photo.fps === 'number' && Number.isFinite(photo.fps)) row.fps = photo.fps;
      if (typeof photo.durationMs === 'number' && Number.isFinite(photo.durationMs)) {
        row.durationMs = photo.durationMs;
      }
    }
    list.unshift(row);
    while (list.length > MAX_USER_PHOTOS) list.pop();
    try {
      saveUserPhotos(list);
    } catch (e) {
      while (list.length > 1) {
        list.pop();
        try {
          saveUserPhotos(list);
          return;
        } catch (e2) { /* continue */ }
      }
      if (list.length === 1 && list[0].ascii.length > 400) {
        list[0].ascii = list[0].ascii.slice(0, Math.floor(list[0].ascii.length * 0.75));
        saveUserPhotos(list);
      }
    }
  }

  /**
   * 云端 insert 返回新 UUID 时写回列表首条（与 `prependUserPhoto` 后下标 0 对齐）。
   * @param {number} index
   * @param {string} id
   * @returns {void}
   */
  function setUserPhotoIdAt(index, id) {
    if (typeof id !== 'string' || !id) return;
    var list = loadUserPhotos();
    if (index < 0 || index >= list.length) return;
    list[index] = Object.assign({}, list[index], { id: id });
    saveUserPhotos(list);
  }

  /**
   * @param {number} index 仅用户照片区下标（0 … userCount-1）
   */
  function deleteUserPhotoAt(index) {
    var list = loadUserPhotos();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    saveUserPhotos(list);
  }

  /**
   * 已不再使用内置示例；恒为空数组（保留 API 兼容）。
   * @returns {Array<{id:string,ascii:string,color?:string,time:number,mine?:boolean,isDefault?:boolean}>}
   */
  function getBuiltinGalleryCards() {
    return [];
  }

  /**
   * 用户照片（新在前）；无内置示例拼接。
   * @returns {Array<{id:string,ascii:string,color?:string,time:number,mine?:boolean,isDefault?:boolean}>}
   */
  function getMergedGalleryPhotos() {
    return loadUserPhotos();
  }

  /**
   * @returns {number} 当前用户照片数量（用于区分可删范围）
   */
  function getUserPhotoCount() {
    return loadUserPhotos().length;
  }

  global.AsciiCameraGalleryStorage = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_USER_PHOTOS: MAX_USER_PHOTOS,
    GALLERY_PREPEND_MESSAGE_TYPE: GALLERY_PREPEND_MESSAGE_TYPE,
    GALLERY_MIRROR_TOP_MESSAGE_TYPE: GALLERY_MIRROR_TOP_MESSAGE_TYPE,
    CAMERA_POPUP_WINDOW_NAME: CAMERA_POPUP_WINDOW_NAME,
    galleryOpenerNeedsPostMessage: galleryOpenerNeedsPostMessage,
    DEFAULT_GALLERY_PHOTOS: DEFAULT_GALLERY_PHOTOS,
    loadUserPhotos: loadUserPhotos,
    saveUserPhotos: saveUserPhotos,
    prependUserPhoto: prependUserPhoto,
    setUserPhotoIdAt: setUserPhotoIdAt,
    deleteUserPhotoAt: deleteUserPhotoAt,
    getMergedGalleryPhotos: getMergedGalleryPhotos,
    getBuiltinGalleryCards: getBuiltinGalleryCards,
    getUserPhotoCount: getUserPhotoCount,
    generatePhotoId: generatePhotoId,
    stableLegacyPhotoId: stableLegacyPhotoId
  };
})(typeof window !== 'undefined' ? window : globalThis);
