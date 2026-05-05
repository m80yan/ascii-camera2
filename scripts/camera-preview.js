/**
 * ASCII Camera：预览态（本地静帧 / Loop 循环 / 封面滑块）状态与 UI 流。
 * 抓拍生成 payload、Supabase、实时取景 RAF 仍在 `camera.html`。
 * @file
 */
(function (global) {
  'use strict';

  /** @type {null | Record<string, unknown>} */
  var core = null;

  /**
   * @returns {Record<string, unknown>}
   */
  function C() {
    return /** @type {Record<string, unknown>} */ (core);
  }

  var P = {};

  /** @type {boolean} */
  P.previewCaptureActive = false;

  /** @type {string | object | null} */
  P.pendingGalleryPayload = null;

  /** @type {ReturnType<typeof setInterval> | null} */
  P.previewAnimTimer = null;

  /** @type {number} */
  P.loopCoverFrameIndex = 0;

  /** @type {boolean} */
  P.loopCoverHoverLatch = false;

  /** @type {boolean} */
  P.loopCoverPointerDown = false;

  /**
   * 由 `camera.html` 在声明 `restartLiveAsciiPreview` 等之后调用一次。
   * @param {Record<string, unknown>} c
   * @returns {void}
   */
  P.bindCore = function (c) {
    core = c;
  };

  /**
   * @returns {boolean}
   */
  P.isLoopCoverSliderPauseActive = function () {
    return P.loopCoverHoverLatch || P.loopCoverPointerDown;
  };

  /**
   * @returns {void}
   */
  P.syncLoopCoverPreviewPlayback = function () {
    var p = P.pendingGalleryPayload;
    if (!P.previewCaptureActive || !p || !p.isAnimated || !p.frames || !p.frames.length) return;
    var ui = C().loopCoverUi;
    if (!ui || ui.hidden) return;
    P.clearPreviewAnimLoop();
    C().out.textContent = p.frames[0] || '';
    if (!P.isLoopCoverSliderPauseActive()) {
      P.startPreviewAnimLoop(p.frames);
    }
  };

  /**
   * @returns {void}
   */
  P.applyLoopCoverRotationFromCanonical = function () {
    var p = P.pendingGalleryPayload;
    if (!p || !p.isAnimated || !p.frames || !p.frames.length) return;
    var k = P.loopCoverFrameIndex;
    var chars = /** @type {() => string} */ (C().getChars)();
    if (p._loopCaptureLumas && p._loopCaptureLumas.length && p.previewCols && p.previewRows) {
      var tempFrames = [];
      var l2a = /** @type {(l: Float32Array, c: number, r: number, ch: string) => string} */ (C().luminanceToAscii);
      for (var i = 0; i < p._loopCaptureLumas.length; i++) {
        tempFrames.push(l2a(p._loopCaptureLumas[i], p.previewCols, p.previewRows, chars));
      }
      p.frames = global.AsciiCameraLoop.rotateStringArrayForLoopCover(tempFrames, k);
      p.frameLumas = global.AsciiCameraLoop.rotateFloat32ArrayArrayForLoopCover(p._loopCaptureLumas, k);
      p.ascii = p.frames[0] || '';
    } else if (p._loopCaptureFramesOnly && p._loopCaptureFramesOnly.length) {
      p.frames = global.AsciiCameraLoop.rotateStringArrayForLoopCover(p._loopCaptureFramesOnly, k);
      p.ascii = p.frames[0] || '';
    } else {
      return;
    }
    p.coverFrameIndex = k;
    P.clearPreviewAnimLoop();
    C().out.textContent = p.frames[0] || '';
    if (!P.isLoopCoverSliderPauseActive()) {
      P.startPreviewAnimLoop(p.frames);
    }
    /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
    /** @type {() => void} */ (C().syncAsciiLayout)();
    P.updateLoopCoverLabelPosition();
  };

  /**
   * @returns {void}
   */
  P.updateLoopCoverLabelPosition = function () {
    var loopCoverSlider = C().loopCoverSlider;
    var loopCoverLabel = C().loopCoverLabel;
    if (!loopCoverSlider || !loopCoverLabel) return;
    var min = parseFloat(loopCoverSlider.min);
    var max = parseFloat(loopCoverSlider.max);
    var v = parseFloat(loopCoverSlider.value);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    if (!Number.isFinite(v)) v = 0;
    var pct = max <= min ? 0 : ((v - min) / (max - min)) * 100;
    loopCoverLabel.style.left = pct + '%';
  };

  /**
   * @returns {boolean}
   */
  P.shouldShowLoopCoverUi = function () {
    return (
      P.previewCaptureActive === true &&
      /** @type {boolean} */ (C().videoMode) === true &&
      P.pendingGalleryPayload != null &&
      typeof P.pendingGalleryPayload === 'object' &&
      P.pendingGalleryPayload.isAnimated === true &&
      Array.isArray(P.pendingGalleryPayload.frames) &&
      P.pendingGalleryPayload.frames.length > 0
    );
  };

  /**
   * @returns {void}
   */
  P.syncLoopCoverUiVisibility = function () {
    if (P.shouldShowLoopCoverUi()) {
      var p = P.pendingGalleryPayload;
      P.setupLoopCoverUi(p.frames.length, P.loopCoverFrameIndex);
    } else {
      P.hideLoopCoverUi();
    }
  };

  /**
   * @param {number} frameCount
   * @param {number} [preserveIndex]
   * @returns {void}
   */
  P.setupLoopCoverUi = function (frameCount, preserveIndex) {
    var loopCoverUi = C().loopCoverUi;
    var loopCoverSlider = C().loopCoverSlider;
    var camSubmitStatusSlot = C().camSubmitStatusSlot;
    if (!loopCoverUi || !loopCoverSlider || !camSubmitStatusSlot) return;
    var n = Math.max(1, Math.floor(frameCount));
    loopCoverSlider.min = '0';
    loopCoverSlider.max = String(Math.max(0, n - 1));
    loopCoverSlider.step = '1';
    if (arguments.length >= 2 && preserveIndex != null && Number.isFinite(preserveIndex)) {
      var pi = Math.max(0, Math.min(n - 1, Math.floor(preserveIndex)));
      P.loopCoverFrameIndex = pi;
      loopCoverSlider.value = String(pi);
    } else {
      loopCoverSlider.value = '0';
      P.loopCoverFrameIndex = 0;
    }
    loopCoverSlider.style.setProperty('--loop-cover-n', String(n));
    if (n <= 1) {
      loopCoverSlider.classList.add('loop-cover-slider--single');
    } else {
      loopCoverSlider.classList.remove('loop-cover-slider--single');
    }
    loopCoverUi.hidden = false;
    loopCoverUi.setAttribute('aria-hidden', 'false');
    camSubmitStatusSlot.classList.add('cam-submit-status-slot--loop-cover');
    global.requestAnimationFrame(P.updateLoopCoverLabelPosition);
  };

  /**
   * @returns {void}
   */
  P.restoreLoopCoverUiAfterFailedSubmit = function () {
    P.syncLoopCoverUiVisibility();
  };

  /**
   * @returns {void}
   */
  P.hideLoopCoverUi = function () {
    P.loopCoverHoverLatch = false;
    P.loopCoverPointerDown = false;
    var loopCoverUi = C().loopCoverUi;
    if (loopCoverUi) {
      loopCoverUi.hidden = true;
      loopCoverUi.setAttribute('aria-hidden', 'true');
    }
    var camSubmitStatusSlot = C().camSubmitStatusSlot;
    if (camSubmitStatusSlot) {
      camSubmitStatusSlot.classList.remove('cam-submit-status-slot--loop-cover');
    }
  };

  /**
   * @returns {void}
   */
  P.clearPreviewAnimLoop = function () {
    if (P.previewAnimTimer != null) {
      global.clearInterval(P.previewAnimTimer);
      P.previewAnimTimer = null;
    }
  };

  /**
   * @param {string[]} frames
   * @returns {void}
   */
  P.startPreviewAnimLoop = function (frames) {
    P.clearPreviewAnimLoop();
    if (!frames || !frames.length) return;
    var idx = 0;
    var out = C().out;
    out.textContent = frames[0];
    var fps = /** @type {number} */ (C().VIDEO_FPS);
    P.previewAnimTimer = global.setInterval(function () {
      idx = (idx + 1) % frames.length;
      out.textContent = frames[idx];
    }, Math.round(1000 / fps));
  };

  /**
   * @param {string | object} payload
   * @returns {void}
   */
  P.enterPreviewState = function (payload) {
    var lockOpt = /** @type {unknown} */ (C().setLoopPreviewDistortingMirrorOptionLocked);
    if (typeof lockOpt === 'function') {
      /** @type {(v: boolean) => void} */ (lockOpt)(false);
    }
    P.hideLoopCoverUi();
    P.loopCoverFrameIndex = 0;
    P.previewCaptureActive = true;
    P.pendingGalleryPayload = payload;
    var cameraShell = C().cameraShell;
    if (cameraShell) cameraShell.classList.add('cam-preview-capture');
    P.clearPreviewAnimLoop();
    var aid = /** @type {number | null} */ (C().animId);
    if (aid != null) {
      global.cancelAnimationFrame(aid);
      /** @type {(v: number | null) => void} */ (C().setAnimId)(null);
    }
    var out = C().out;
    out.removeAttribute('aria-hidden');
    if (typeof payload === 'string') {
      out.textContent = payload;
    } else if (payload && payload.isPhotoPreview === true) {
      var recAsp = /** @type {unknown} */ (C().recordPhotoPreviewLiveAspectSnapshot);
      if (typeof recAsp === 'function') {
        /** @type {() => void} */ (recAsp)();
      }
      out.textContent = payload.ascii || '';
    } else if (payload && payload.isAnimated && payload.frames && payload.frames.length) {
      global.AsciiCameraLoop.attachCanonicalLoopCaptureBuffers(payload);
      if (typeof lockOpt === 'function') {
        /** @type {(v: boolean) => void} */ (lockOpt)(true);
      }
      out.textContent = payload.frames[0] || '';
      P.startPreviewAnimLoop(payload.frames);
    }
    out.style.color = /** @type {HTMLSelectElement} */ (C().colorPicker).value;
    var asciiWrap = C().asciiWrap;
    var stream = C().stream;
    if (asciiWrap && stream) asciiWrap.classList.remove('ascii-wrap--offline');
    /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
    /** @type {() => void} */ (C().syncAsciiLayout)();
    var submitGalleryBtn = C().submitGalleryBtn;
    if (submitGalleryBtn) submitGalleryBtn.disabled = false;
    var snapBtn = C().snapBtn;
    var videoMode = /** @type {boolean} */ (C().videoMode);
    snapBtn.textContent = videoMode
      ? /** @type {string} */ (C().SNAP_LABEL_RETAKE_VIDEO)
      : /** @type {string} */ (C().SNAP_LABEL_RETAKE_PHOTO);
    snapBtn.disabled = false;
    /** @type {() => void} */ (C().syncVideoProgressBarForMode)();
    /** @type {() => void} */ (C().applyCaptureModeUi)();
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(/** @type {() => void} */ (C().syncAsciiLayout));
    });
  };

  /**
   * @returns {void}
   */
  P.retakeFromPreview = function () {
    var lockOptRet = /** @type {unknown} */ (C().setLoopPreviewDistortingMirrorOptionLocked);
    if (typeof lockOptRet === 'function') {
      /** @type {(v: boolean) => void} */ (lockOptRet)(false);
    }
    var restAsp = /** @type {unknown} */ (C().restorePhotoPreviewLiveAspectAfterRetake);
    if (typeof restAsp === 'function') {
      /** @type {() => void} */ (restAsp)();
    }
    P.hideLoopCoverUi();
    P.loopCoverFrameIndex = 0;
    P.clearPreviewAnimLoop();
    P.previewCaptureActive = false;
    P.pendingGalleryPayload = null;
    var cameraShell = C().cameraShell;
    if (cameraShell) cameraShell.classList.remove('cam-preview-capture');
    var submitGalleryBtn = C().submitGalleryBtn;
    if (submitGalleryBtn) submitGalleryBtn.disabled = true;
    var camTabPhoto = C().camTabPhoto;
    if (camTabPhoto) camTabPhoto.disabled = false;
    var camTabVideo = C().camTabVideo;
    if (camTabVideo) camTabVideo.disabled = false;
    /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
    /** @type {() => void} */ (C().restartLiveAsciiPreview)();
    var snapBtn = C().snapBtn;
    var videoMode = /** @type {boolean} */ (C().videoMode);
    var stream = C().stream;
    snapBtn.textContent = videoMode
      ? /** @type {string} */ (C().SNAP_LABEL_VIDEO)
      : /** @type {string} */ (C().SNAP_LABEL_READY);
    snapBtn.disabled = !stream;
    /** @type {() => void} */ (C().applyCaptureModeUi)();
  };

  /**
   * @returns {void}
   */
  P.exitPreviewAfterSuccessfulSubmit = function () {
    var lockOptEx = /** @type {unknown} */ (C().setLoopPreviewDistortingMirrorOptionLocked);
    if (typeof lockOptEx === 'function') {
      /** @type {(v: boolean) => void} */ (lockOptEx)(false);
    }
    var clrAsp = /** @type {unknown} */ (C().clearPhotoPreviewLiveAspectSnapshot);
    if (typeof clrAsp === 'function') {
      /** @type {() => void} */ (clrAsp)();
    }
    P.hideLoopCoverUi();
    P.loopCoverFrameIndex = 0;
    P.clearPreviewAnimLoop();
    P.previewCaptureActive = false;
    P.pendingGalleryPayload = null;
    var cameraShell = C().cameraShell;
    if (cameraShell) cameraShell.classList.remove('cam-preview-capture');
    var submitGalleryBtn = C().submitGalleryBtn;
    if (submitGalleryBtn) submitGalleryBtn.disabled = true;
    var camTabPhoto = C().camTabPhoto;
    if (camTabPhoto) camTabPhoto.disabled = false;
    var camTabVideo = C().camTabVideo;
    if (camTabVideo) camTabVideo.disabled = false;
    /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
    /** @type {() => void} */ (C().restartLiveAsciiPreview)();
    var snapBtn = C().snapBtn;
    var videoMode = /** @type {boolean} */ (C().videoMode);
    var stream = C().stream;
    snapBtn.textContent = videoMode
      ? /** @type {string} */ (C().SNAP_LABEL_VIDEO)
      : /** @type {string} */ (C().SNAP_LABEL_READY);
    snapBtn.disabled = !stream;
    /** @type {() => void} */ (C().applyCaptureModeUi)();
  };

  /**
   * 预览态下切换 Style：按已保存的亮度格重算 ASCII/GIF，并写回 `pendingGalleryPayload`（提交时即最新样式）。
   * - Photo 预览：`regeneratePhotoPreviewFromCanonical`（`lumaCanonical` + 畸变镜档）。
   * - Loop 预览：仅 `_loopCaptureLumas` / `frameLumas` 路径重算 ASCII，**不**含 Loop 预览畸变镜专用重算。
   * @returns {void}
   */
  P.applyPreviewStyleFromDensity = function () {
    if (!P.previewCaptureActive || !P.pendingGalleryPayload) return;
    var p = P.pendingGalleryPayload;
    if (
      p &&
      typeof p === 'object' &&
      p.usedDistortingMirror === true &&
      p.isPhotoPreview !== true
    ) {
      return;
    }
    var chars = /** @type {() => string} */ (C().getChars)();
    if (p && typeof p === 'object' && p.isPhotoPreview === true && p.lumaCanonical && p.cols && p.rows) {
      var regen = /** @type {unknown} */ (C().regeneratePhotoPreviewFromCanonical);
      if (typeof regen === 'function') {
        /** @type {() => void} */ (regen)();
        return;
      }
    }
    if (p && typeof p === 'object' && p.isPhotoPreview === true && p.luma && p.cols && p.rows) {
      var l2a0 = /** @type {(l: Float32Array, c: number, r: number, ch: string) => string} */ (C().luminanceToAscii);
      var ascii = l2a0(p.luma, p.cols, p.rows, chars);
      p.ascii = ascii;
      C().out.textContent = ascii;
      /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
      /** @type {() => void} */ (C().syncAsciiLayout)();
      return;
    }
    if (p && p.isAnimated === true && Array.isArray(p.frameLumas) && p.previewCols && p.previewRows) {
      if (p._loopCaptureLumas && p._loopCaptureLumas.length) {
        var framesOutCanon = [];
        var l2a1 = /** @type {(l: Float32Array, c: number, r: number, ch: string) => string} */ (C().luminanceToAscii);
        for (var ci = 0; ci < p._loopCaptureLumas.length; ci++) {
          framesOutCanon.push(l2a1(p._loopCaptureLumas[ci], p.previewCols, p.previewRows, chars));
        }
        p.frames = global.AsciiCameraLoop.rotateStringArrayForLoopCover(framesOutCanon, P.loopCoverFrameIndex);
        p.frameLumas = global.AsciiCameraLoop.rotateFloat32ArrayArrayForLoopCover(
          p._loopCaptureLumas,
          P.loopCoverFrameIndex
        );
        p.ascii = p.frames[0] || '';
        p.coverFrameIndex = P.loopCoverFrameIndex;
        C().out.textContent = p.frames[0] || '';
        P.clearPreviewAnimLoop();
        if (!P.isLoopCoverSliderPauseActive()) {
          P.startPreviewAnimLoop(p.frames);
        }
        /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
        /** @type {() => void} */ (C().syncAsciiLayout)();
        P.updateLoopCoverLabelPosition();
        return;
      }
      var framesOut = [];
      var l2a2 = /** @type {(l: Float32Array, c: number, r: number, ch: string) => string} */ (C().luminanceToAscii);
      for (var i = 0; i < p.frameLumas.length; i++) {
        framesOut.push(l2a2(p.frameLumas[i], p.previewCols, p.previewRows, chars));
      }
      p.frames = framesOut;
      p.ascii = framesOut[0] || '';
      C().out.textContent = framesOut[0] || '';
      P.clearPreviewAnimLoop();
      if (!P.isLoopCoverSliderPauseActive()) {
        P.startPreviewAnimLoop(framesOut);
      }
      /** @type {() => void} */ (C().invalidateAsciiCellMetrics)();
      /** @type {() => void} */ (C().syncAsciiLayout)();
    }
  };

  global.AsciiCameraPreview = P;
})(window);
