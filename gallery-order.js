/* Shared ordering model. Image payloads stay in the existing Gallery cache. */
(function (global) {
  'use strict';
  function move(rows, operation) {
    var next = rows.slice();
    var source = next.findIndex(function (p) { return p.id === operation.id; });
    if (source < 0 || operation.id === operation.anchor) return next;
    var item = next.splice(source, 1)[0];
    var target = next.findIndex(function (p) { return p.id === operation.anchor; });
    if (target < 0) return rows.slice();
    next.splice(target + (operation.after ? 1 : 0), 0, item);
    return next;
  }

  function Queue(options) {
    this.options = options;
    this.pending = [];
    this.inflight = [];
    this.timer = null;
    this.held = false;
  }
  Queue.prototype.busy = function () { return !!(this.pending.length || this.inflight.length || this.held); };
  Queue.prototype.apply = function (rows) { return this.inflight.concat(this.pending).reduce(move, rows); };
  Queue.prototype.schedule = function () {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length || this.inflight.length || this.held) return;
    var self = this;
    this.timer = setTimeout(function () { self.flush(); }, 500);
  };
  Queue.prototype.hold = function (held) {
    this.held = held;
    this.options.busy(this.busy());
    this.schedule();
  };
  Queue.prototype.add = function (operation) {
    this.pending.push(operation);
    this.options.busy(true);
    this.options.status('Order pending…');
    this.schedule();
  };
  Queue.prototype.flush = async function () {
    if (this.inflight.length || this.held || !this.pending.length) return;
    if (this.options.wait && this.options.wait()) { this.schedule(); return; }
    this.inflight = this.pending.splice(0, 100);
    this.options.status('Saving order…');
    try {
      await this.options.save(this.inflight);
      this.inflight = [];
      this.options.changed();
      this.options.status(this.pending.length ? 'Order pending…' : 'Order saved');
    } catch (error) {
      this.pending = [];
      this.inflight = [];
      this.options.failed(error);
    } finally {
      this.options.busy(this.busy());
      this.schedule();
    }
  };
  var api = { move: move, Queue: Queue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AsciiGalleryOrder = api;
})(typeof window !== 'undefined' ? window : globalThis);
