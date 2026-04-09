/**
 * ASCII Camera：Loop 录制（多帧采集）、封面帧旋转与动画 payload 规范数据。
 * 摄像头开关、抓拍入口、`persistPhotoToGallery` 仍在 `camera.html`。
 * @file
 */
(function (global) {
  'use strict';

  /** @type {null | Record<string, unknown>} */
  var loopCapture = null;

  var L = {};

  /** 动画录制列数（与 Supabase / UI 约定） */
  L.VIDEO_COLS = 72;

  /** 6 FPS × 2s = 12 帧 */
  L.VIDEO_FRAME_COUNT = 12;

  L.VIDEO_FPS = 6;

  L.VIDEO_DURATION_MS = 2000;

  /**
   * @param {{ sleep: function(number): Promise<void>, toAsciiWithLuminance: function(number, (number|null|undefined)): { ascii: string, luma: Float32Array, cols: number, rows: number }, getCols: function(): number, VIDEO_DEFAULT_COLS: number }} c
   * @returns {void}
   */
  L.bindLoopCapture = function (c) {
    loopCapture = c;
  };

  /**
   * @returns {Record<string, unknown>}
   */
  function LC() {
    return /** @type {Record<string, unknown>} */ (loopCapture);
  }

  /**
   * 将数组旋转为以索引 `k` 的元素为首（Loop 封面帧序）。
   * @param {string[]} arr
   * @param {number} k
   * @returns {string[]}
   */
  L.rotateStringArrayForLoopCover = function (arr, k) {
    if (!arr || !arr.length) return [];
    var n = arr.length;
    var kk = ((k % n) + n) % n;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = arr[(kk + i) % n];
    }
    return out;
  };

  /**
   * @param {Float32Array[]} arr
   * @param {number} k
   * @returns {Float32Array[]}
   */
  L.rotateFloat32ArrayArrayForLoopCover = function (arr, k) {
    if (!arr || !arr.length) return [];
    var n = arr.length;
    var kk = ((k % n) + n) % n;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = arr[(kk + i) % n];
    }
    return out;
  };

  /**
   * 为预览/换 Style 建立与录制时间序对齐的规范缓存：`_loopCaptureLumas` 或 `_loopCaptureFramesOnly`。
   * @param {{ frames: string[], frameLumas?: Float32Array[], [key: string]: unknown }} payload
   * @returns {void}
   */
  L.attachCanonicalLoopCaptureBuffers = function (payload) {
    if (payload.frameLumas && payload.frameLumas.length) {
      payload._loopCaptureLumas = payload.frameLumas.map(function (f) {
        var c = new Float32Array(f.length);
        c.set(f);
        return c;
      });
      payload._loopCaptureFramesOnly = null;
    } else {
      payload._loopCaptureFramesOnly = payload.frames.slice();
      payload._loopCaptureLumas = null;
    }
    payload.coverFrameIndex = 0;
  };

  /**
   * 录制多帧 ASCII（6 FPS × 2s = 12 帧）及每帧亮度格，供预览态换 Style 重算；不停止实时取景 RAF。
   * @returns {Promise<{ frames: string[], frameLumas: Float32Array[], cols: number, rows: number }>}
   */
  L.captureVideoAsciiFrames = async function () {
    var c = LC();
    var sleep = /** @type {(ms: number) => Promise<void>} */ (c.sleep);
    var toAsciiWithLuminance = /** @type {(cols: number, a: number | null | undefined) => { ascii: string, luma: Float32Array, cols: number, rows: number }} */ (
      c.toAsciiWithLuminance
    );
    var getCols = /** @type {() => number} */ (c.getCols);
    var vdc = /** @type {number} */ (c.VIDEO_DEFAULT_COLS);
    var frames = [];
    var frameLumas = [];
    var cols = 0;
    var rows = 0;
    var videoCols = getCols();
    if (videoCols !== 72) videoCols = vdc;
    var t0 = global.performance.now();
    for (var i = 0; i < L.VIDEO_FRAME_COUNT; i++) {
      var targetMs = (i / L.VIDEO_FPS) * 1000;
      var now;
      for (;;) {
        now = global.performance.now() - t0;
        if (now >= targetMs - 0.5) break;
        var wait = Math.min(32, targetMs - now);
        if (wait > 1) await sleep(wait);
      }
      var pack = toAsciiWithLuminance(videoCols, 1);
      frames.push(pack.ascii);
      frameLumas.push(pack.luma);
      cols = pack.cols;
      rows = pack.rows;
    }
    return { frames: frames, frameLumas: frameLumas, cols: cols, rows: rows };
  };

  global.AsciiCameraLoop = L;
})(window);
