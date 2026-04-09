/**
 * ASCII Camera：仅 UI 层（DOM 引用、控件事件绑定、纯展示状态更新）。
 * 核心取景/抓拍/画廊/雨效算法仍在 `camera.html`。
 * @file
 */
(function (global) {
  'use strict';

  /** @type {null | { get videoMode(): boolean, get stream(): MediaStream | null, get previewCaptureActive(): boolean }} */
  var stateAccess = null;

  /** @type {{ VIDEO_DEFAULT_COLS: number }} */
  var captureConstants = { VIDEO_DEFAULT_COLS: 72 };

  var Ui = {};

  /**
   * 由 `camera.html` 在声明 `VIDEO_DEFAULT_COLS` 等常量后注入，避免魔法数字分叉。
   * @param {{ VIDEO_DEFAULT_COLS: number }} c
   * @returns {void}
   */
  Ui.setCaptureConstants = function (c) {
    if (c && typeof c.VIDEO_DEFAULT_COLS === 'number') {
      captureConstants.VIDEO_DEFAULT_COLS = c.VIDEO_DEFAULT_COLS;
    }
  };

  /**
   * 对 `videoMode` / `stream` / `previewCaptureActive` 等使用 getter，保持与主脚本闭包同步。
   * @param {{ get videoMode(): boolean, get stream(): MediaStream | null, get previewCaptureActive(): boolean }} accessors
   * @returns {void}
   */
  Ui.initStateAccess = function (accessors) {
    stateAccess = accessors;
  };

  function getVideoMode() {
    return stateAccess ? !!stateAccess.videoMode : false;
  }

  function getStream() {
    return stateAccess ? stateAccess.stream : null;
  }

  function getPreviewCaptureActive() {
    return stateAccess ? !!stateAccess.previewCaptureActive : false;
  }

  /**
   * 缓存 `#video` … `#iframe-open-tab` 等节点引用。
   * @returns {void}
   */
  Ui.initDom = function () {
    Ui.video = document.getElementById('video');
    Ui.canvas = document.getElementById('canvas');
    Ui.out = document.getElementById('ascii-out');
    Ui.asciiOffHelper = document.getElementById('asciiOffHelper');
    Ui.asciiCellProbe = document.getElementById('ascii-cell-probe');
    Ui.asciiWrap = document.getElementById('ascii-wrap');
    Ui.startBtn = document.getElementById('startBtn');
    Ui.snapBtn = document.getElementById('snapBtn');
    Ui.submitGalleryBtn = document.getElementById('submitGalleryBtn');
    Ui.statusEl = document.getElementById('status');
    Ui.savedMsg = document.getElementById('saved-msg');
    Ui.camSubmitStatusSlot = document.getElementById('camSubmitStatusSlot');
    Ui.loopCoverUi = document.getElementById('loop-cover-ui');
    Ui.loopCoverSlider = document.getElementById('loopCoverSlider');
    Ui.loopCoverLabel = document.getElementById('loopCoverLabel');
    Ui.colorPicker = document.getElementById('colorPicker');
    Ui.densityPicker = document.getElementById('densityPicker');
    Ui.resPicker = document.getElementById('resPicker');
    Ui.aspectPicker = document.getElementById('aspectPicker');
    Ui.flashOutsideRoot = document.getElementById('flash-outside-root');
    Ui.flashStripTop = document.getElementById('flash-strip-top');
    Ui.flashStripLeft = document.getElementById('flash-strip-left');
    Ui.flashStripRight = document.getElementById('flash-strip-right');
    Ui.flashStripBottom = document.getElementById('flash-strip-bottom');
    Ui.flashToggle = document.getElementById('flashToggle');
    Ui.cameraShell = document.getElementById('camera-shell');
    Ui.camTabPhoto = document.getElementById('camTabPhoto');
    Ui.camTabVideo = document.getElementById('camTabVideo');
    Ui.videoProgressRoot = document.getElementById('video-progress-root');
    Ui.videoProgressBar = document.getElementById('video-progress-bar');
    Ui.resPickerStack = document.getElementById('resPickerStack');
    Ui.aspectPickerStack = document.getElementById('aspectPickerStack');
    Ui.asciiActiveFrame = document.getElementById('asciiActiveFrame');
    Ui.asciiActiveColumn = document.getElementById('asciiActiveColumn');
    Ui.asciiOutScaleWrap = document.getElementById('asciiOutScaleWrap');
    Ui.requestRainCanvas = document.getElementById('requestRainCanvas');
    Ui.iframeHint = document.getElementById('iframe-hint');
    Ui.iframeOpenTab = document.getElementById('iframe-open-tab');
  };

  /**
   * 按 `#ascii-wrap` 在视口中的矩形，布置四块闪白条带（不覆盖取景内容）。
   * @returns {void}
   */
  Ui.layoutFlashOutsideStrips = function () {
    var flashStripTop = Ui.flashStripTop;
    var asciiWrap = Ui.asciiWrap;
    if (!flashStripTop || !asciiWrap) return;
    var flashStripLeft = Ui.flashStripLeft;
    var flashStripRight = Ui.flashStripRight;
    var flashStripBottom = Ui.flashStripBottom;
    var r = asciiWrap.getBoundingClientRect();
    var vw = global.innerWidth;
    var vh = global.innerHeight;
    var topH = Math.max(0, r.top);
    var leftW = Math.max(0, r.left);
    var rightW = Math.max(0, vw - r.right);
    var bottomH = Math.max(0, vh - r.bottom);
    flashStripTop.style.left = '0px';
    flashStripTop.style.top = '0px';
    flashStripTop.style.width = vw + 'px';
    flashStripTop.style.height = topH + 'px';
    if (flashStripLeft) {
      flashStripLeft.style.left = '0px';
      flashStripLeft.style.top = r.top + 'px';
      flashStripLeft.style.width = leftW + 'px';
      flashStripLeft.style.height = Math.max(0, r.height) + 'px';
    }
    if (flashStripRight) {
      flashStripRight.style.left = r.right + 'px';
      flashStripRight.style.top = r.top + 'px';
      flashStripRight.style.width = rightW + 'px';
      flashStripRight.style.height = Math.max(0, r.height) + 'px';
    }
    if (flashStripBottom) {
      flashStripBottom.style.left = '0px';
      flashStripBottom.style.top = r.bottom + 'px';
      flashStripBottom.style.width = vw + 'px';
      flashStripBottom.style.height = bottomH + 'px';
    }
  };

  /**
   * 同步 Photo / Video 标签高亮状态。
   * @returns {void}
   */
  Ui.updateModeTabsUi = function () {
    var camTabPhoto = Ui.camTabPhoto;
    var camTabVideo = Ui.camTabVideo;
    var videoMode = getVideoMode();
    if (camTabPhoto && camTabVideo) {
      camTabPhoto.classList.toggle('active', !videoMode);
      camTabPhoto.setAttribute('aria-selected', videoMode ? 'false' : 'true');
      camTabVideo.classList.toggle('active', videoMode);
      camTabVideo.setAttribute('aria-selected', videoMode ? 'true' : 'false');
    }
  };

  /**
   * Photo：显示 48/72/96/120；Loop：仅显示 72。须在写入 `resPicker.value` 之后调用。
   * @returns {void}
   */
  Ui.syncResPickerOptionsVisibility = function () {
    var resPicker = Ui.resPicker;
    if (!resPicker) return;
    var videoMode = getVideoMode();
    var opts = resPicker.querySelectorAll('option');
    var i;
    for (i = 0; i < opts.length; i++) {
      var o = opts[i];
      var v = o.value;
      if (videoMode) {
        o.hidden = v !== '72';
      } else {
        o.hidden = false;
      }
    }
    var vdc = captureConstants.VIDEO_DEFAULT_COLS;
    if (videoMode && resPicker.value !== String(vdc)) resPicker.value = String(vdc);
  };

  /**
   * Video 且摄像头开时显示进度条；否则隐藏条但保留占位，避免顶动布局。
   * @returns {void}
   */
  Ui.syncVideoProgressBarForMode = function () {
    var videoProgressRoot = Ui.videoProgressRoot;
    var videoProgressBar = Ui.videoProgressBar;
    if (!videoProgressRoot || !videoProgressBar) return;
    if (getPreviewCaptureActive()) {
      videoProgressRoot.classList.add('video-progress-root--inactive');
      videoProgressRoot.setAttribute('aria-hidden', 'true');
      videoProgressBar.style.width = '100%';
      return;
    }
    if (getVideoMode() && getStream()) {
      videoProgressRoot.classList.remove('video-progress-root--inactive');
      videoProgressRoot.setAttribute('aria-hidden', 'false');
      videoProgressBar.style.width = '100%';
    } else {
      videoProgressRoot.classList.add('video-progress-root--inactive');
      videoProgressRoot.setAttribute('aria-hidden', 'true');
      videoProgressBar.style.width = '100%';
    }
  };

  /**
   * 视频进度条填充色与当前「Color」下拉及 `#ascii-out` 一致。
   * @returns {void}
   */
  Ui.syncVideoProgressBarColor = function () {
    var videoProgressBar = Ui.videoProgressBar;
    var colorPicker = Ui.colorPicker;
    if (!videoProgressBar || !colorPicker) return;
    videoProgressBar.style.backgroundColor = colorPicker.value;
  };

  /**
   * @returns {void}
   */
  Ui.setStatusOffline = function () {
    var statusEl = Ui.statusEl;
    if (!statusEl) return;
    statusEl.classList.remove('live');
    statusEl.removeAttribute('aria-label');
    var st = statusEl.querySelector('.status-text');
    if (st) st.textContent = 'CAMERA OFF';
  };

  /**
   * @returns {void}
   */
  Ui.setStatusLive = function () {
    var statusEl = Ui.statusEl;
    if (!statusEl) return;
    statusEl.classList.add('live');
    statusEl.setAttribute('aria-label', 'Camera on');
    var st = statusEl.querySelector('.status-text');
    if (st) st.textContent = '';
  };

  /**
   * 嵌入页（如 Notion）时显示提示并绑定「新标签打开」。
   * @param {boolean} isEmbedded
   * @param {(e: Event) => void} onOpenTabClick
   * @returns {void}
   */
  Ui.setupIframeEmbedUi = function (isEmbedded, onOpenTabClick) {
    if (!Ui.iframeHint || !Ui.iframeOpenTab || !isEmbedded) return;
    Ui.iframeHint.hidden = false;
    Ui.iframeOpenTab.addEventListener('click', onOpenTabClick);
  };

  /**
   * 绑定底部与 overlay 控件事件（具体逻辑由 `camera.html` 传入的回调执行）。
   * @param {{
   *   onColorPickerChange: () => void,
   *   onResPickerChange: () => void,
   *   onAspectPickerChange: () => void,
   *   onDensityPickerChange: () => void,
   *   onCamTabPhotoClick: () => void,
   *   onCamTabVideoClick: () => void,
   *   onWindowResize: () => void,
   *   onFontsReady: () => void,
   *   onAsciiFrameResizeObserved: () => void
   * }} h
   * @returns {void}
   */
  Ui.wireEventBindings = function (h) {
    if (Ui.colorPicker) Ui.colorPicker.addEventListener('change', h.onColorPickerChange);
    if (Ui.resPicker) Ui.resPicker.addEventListener('change', h.onResPickerChange);
    if (Ui.aspectPicker) Ui.aspectPicker.addEventListener('change', h.onAspectPickerChange);
    if (Ui.densityPicker) Ui.densityPicker.addEventListener('change', h.onDensityPickerChange);
    if (Ui.camTabPhoto) Ui.camTabPhoto.addEventListener('click', h.onCamTabPhotoClick);
    if (Ui.camTabVideo) Ui.camTabVideo.addEventListener('click', h.onCamTabVideoClick);

    global.addEventListener('resize', function () {
      Ui.layoutFlashOutsideStrips();
      h.onWindowResize();
    });

    if (global.document.fonts && global.document.fonts.ready) {
      global.document.fonts.ready.then(h.onFontsReady);
    }

    if (typeof global.ResizeObserver !== 'undefined') {
      var asciiFrameResizeObserver = new global.ResizeObserver(function () {
        h.onAsciiFrameResizeObserved();
      });
      if (Ui.asciiActiveFrame) asciiFrameResizeObserver.observe(Ui.asciiActiveFrame);
      if (Ui.asciiActiveColumn) asciiFrameResizeObserver.observe(Ui.asciiActiveColumn);
    }
  };

  Ui.initDom();
  global.AsciiCameraUi = Ui;
})(window);
