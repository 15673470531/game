'use strict';

// Anonymous local UUID and bounded persistent queue; only server acknowledgements remove events.
var QUEUE_KEY = 'kdtl-analytics-http-v1';
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var n=Math.floor(Math.random()*16); return (c==='x'?n:(n&3)|8).toString(16); }); }
var TEST_KEY = 'kdtl-analytics-test-device-v1';
var EVENTS = ['run_start', 'run_resume', 'wave_complete', 'run_death',
  'run_complete', 'settle_action', 'run_leave', 'run_revive', 'app_hide', 'app_show'];
function Analytics(wxApi, config) {
  this.wx = wxApi || {};
  this.config = config || {};
  this.recent = [];
  this.testDevice = false;
  this.environment = 'unknown';
  this.storageError = false;
  try { this.testDevice = this.wx.getStorageSync(TEST_KEY) === true; } catch (_) {}
  try { this.environment = this.wx.getAccountInfoSync().miniProgram.envVersion || 'unknown'; } catch (_) {}
  try { if (this.wx.getSystemInfoSync().platform === 'devtools') this.environment = 'devtools'; } catch (_) {}
  this.queue = []; this.seqs = {}; this.inflight = false; this.timer = null;
  this.failures = 0; this.retryAt = 0; this.lastError = ''; this.acknowledged = 0; this.dropped = 0;
  var saved;
  try { saved = this.wx.getStorageSync(QUEUE_KEY); } catch (_) {}
  this.playerId = saved && typeof saved.playerId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.playerId) ? saved.playerId : uuid();
  if (saved && Array.isArray(saved.queue)) this.queue = saved.queue.filter(function(e) {
    return e && typeof e.run_id === 'string' && Number.isInteger(e.seq) && e.seq > 0 && typeof e.event_name === 'string';
  }).slice(-200);
  if (saved && saved.seqs && typeof saved.seqs === 'object' && !Array.isArray(saved.seqs)) this.seqs = saved.seqs;
  this.prune(); this.persist();

}
Analytics.prototype.setTestDevice = function (enabled) {
  this.testDevice = !!enabled;
  this.storageError = false;
  try { this.wx.setStorageSync(TEST_KEY, this.testDevice); }
  catch (_) { this.storageError = true; }
  return this.status();
};
Analytics.prototype.configureTestDevice = function () {
  var self = this;
  if (this.dialogOpen || typeof this.wx.showModal !== 'function') return;
  this.dialogOpen = true;
  try {
    this.wx.showModal({ title: '测试设备',
      content: this.testDevice ? '本机已排除新增行为统计。要恢复统计吗？' : '将本机排除新增行为统计？微信自带的活跃和时长统计不受影响。',
      confirmText: this.testDevice ? '恢复统计' : '排除本机',
      success: function (res) {
        if (!res.confirm) return;
        var status = self.setTestDevice(!self.testDevice);
        if (self.wx.showToast) self.wx.showToast({ title: status.testFlagPersisted ? '已设置，下局生效' : '保存失败，仅本次有效', icon: 'none' });
      },
      complete: function () { self.dialogOpen = false; }
    });
  } catch (_) { this.dialogOpen = false; }
};
Analytics.prototype.persist = function () {
  try {
    this.wx.setStorageSync(QUEUE_KEY, { playerId: this.playerId, queue: this.queue, seqs: this.seqs });
    this.queueStorageError = false;
  } catch (_) { this.queueStorageError = true; }
};
Analytics.prototype.prune = function () {
  var cutoff = Date.now() - 7 * 86400000, before = this.queue.length;
  this.queue = this.queue.filter(function(e) { return Date.parse(e.occurred_at) >= cutoff; }).slice(-200);
  this.dropped += before - this.queue.length;
};
Analytics.prototype.status = function () {
  return { reportingEnabled: this.config.reportingEnabled === true,
    endpoint: this.config.endpoint, apiAvailable: typeof this.wx.request === 'function', environment: this.environment,
    testDevice: this.testDevice, testFlagPersisted: !this.storageError, queuePersisted: !this.queueStorageError,
    pending: this.queue.length, inflight: this.inflight, acknowledged: this.acknowledged,
    lastError: this.lastError, retryAt: this.retryAt, dropped: this.dropped };
};
Analytics.prototype.schedule = function (delay) {
  var self = this;
  if (this.timer || !this.queue.length || !this.config.reportingEnabled) return;
  this.timer = setTimeout(function () { self.timer = null; self.flush(); }, Math.max(delay, this.retryAt - Date.now(), 0));
  if (this.timer && this.timer.unref) this.timer.unref();
};
Analytics.prototype.flush = function () {
  var self = this;
  if (this.inflight || !this.config.reportingEnabled) return;
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this.prune(); this.persist();
  if (!this.queue.length) return;
  if (Date.now() < this.retryAt) { this.schedule(this.retryAt - Date.now()); return; }
  if (typeof this.wx.request !== 'function') { this.lastError = 'wx.request unavailable'; return; }
  if (this.config.endpoint !== 'https://eat.guozeshui.top/api/game-analytics/events') {
    this.lastError = 'Invalid analytics endpoint'; return;
  }
  var batch = this.queue.slice(0, 20);
  this.inflight = true;
  var finished = false;
  function done(error) {
    if (finished) return; finished = true; self.inflight = false;
    self.lastError = error || '';
    self.failures = error ? self.failures + 1 : 0;
    self.retryAt = Date.now() + (error ? Math.min(300000, 5000 * Math.pow(2, Math.min(self.failures - 1, 6))) : 2000);
    self.persist(); self.schedule(self.retryAt - Date.now());
  }
  try {
    this.wx.request({ url: this.config.endpoint, method: 'POST', timeout: 10000,
      header: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      data: { game_id: 'kdtl', player_id: this.playerId, events: batch },
      success: function (res) {
        if (res.statusCode === 200 && res.data && res.data.code === 0 && res.data.data && Array.isArray(res.data.data.acknowledged)) {
          var ack = res.data.data.acknowledged, accepted = {};
          batch.forEach(function(e) {
            if (ack.some(function(a) { return a.run_id === e.run_id && a.seq === e.seq; })) accepted[e.run_id + ':' + e.seq] = true;
          });
          var before = self.queue.length;
          self.queue = self.queue.filter(function(e) { return !accepted[e.run_id + ':' + e.seq]; });
          self.acknowledged += before - self.queue.length;
          done(before === self.queue.length ? 'No matching acknowledgement' : '');
        } else if (res.statusCode === 422 && res.data && res.data.errors) {
          // Quarantine only the invalid entries identified by Laravel; keep all other entries.
          var bad = {};
          Object.keys(res.data.errors).forEach(function(k) { var m = /^events\.(\d+)(?:\.|$)/.exec(k); if(m && batch[Number(m[1])]) { var e=batch[Number(m[1])]; bad[e.run_id+':'+e.seq]=true; } });
          var before = self.queue.length;
          self.queue = self.queue.filter(function(e) { return !bad[e.run_id+':'+e.seq]; });
          self.dropped += before - self.queue.length;
          done('HTTP 422: invalid events ' + (before - self.queue.length));
        } else done('HTTP ' + res.statusCode);
      },
      fail: function (err) { done(err && err.errMsg || 'Network failure'); }
    });
  } catch (err) { done(err.message || 'Request failed'); }
};
Analytics.prototype.begin = function (game, resumed) {
  var r = game.analyticsRun;
  var restored = resumed && r && typeof r.id === 'string' && r.id.length <= 64;
  if (!restored) {
    r = game.analyticsRun = { id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
      seq: 0, seen: {}, test: false, previous: this.lastResult || '' };
  }
  r.seen = r.seen && typeof r.seen === 'object' ? r.seen : {};
  r.seq = Number.isFinite(r.seq) && r.seq >= 0 ? r.seq : 0;
  r.test = !!r.test || this.testDevice;
  this.track(game, resumed ? 'run_resume' : 'run_start',
    { detail: resumed ? (restored ? 'saved' : 'legacy_or_migrated') : 'new' });
};
Analytics.prototype.track = function (game, event, extra) {
  var r = game.analyticsRun;
  if (!r || game.training || EVENTS.indexOf(event) < 0) return;
  extra = extra || {};
  r.test = !!r.test || this.testDevice; // A run containing testing remains excluded after toggling off.
  var once = '';
  if (event === 'wave_complete') once = 'wave:' + game.stage + ':' + game.wave;
  if (event === 'run_complete') once = 'clear:' + game.stage;
  if (event === 'run_death') once = 'death:' + (game.revives || 0);
  if (event === 'settle_action') once = 'choice:' + game.state + ':' + (game.revives || 0);
  if (once && r.seen[once]) return;
  if (once) r.seen[once] = true;
  if (event === 'run_death' || event === 'run_complete') this.lastResult = r.id;
  if (event === 'run_revive' || event === 'run_start') this.lastResult = '';
  r.seq = Math.max(r.seq, Number(this.seqs[r.id]) || 0) + 1;
  delete this.seqs[r.id]; this.seqs[r.id] = r.seq;
  var ids = Object.keys(this.seqs); if (ids.length > 200) delete this.seqs[ids[0]];
  var data = { run_id: r.id, seq: r.seq, build: String(this.config.build || 'unknown'),
    stage: game.stage || 1, wave: game.wave || 1, weapon: game.weaponKind(),
    seconds: Math.max(0, Math.round(game.elapsed || 0)),
    detail: String(extra.detail || '').slice(0, 64), test_device: r.test ? 1 : 0,
    previous_run_id: event === 'run_start' ? (r.previous || '') : '' };
  var record = { event: 'kdtl_' + event, data: data, status: 'disabled' };
  // Development/preview builds upload explicitly marked test data for end-to-end verification.
  if (this.environment !== 'release') data.test_device = 1;
  if (r.test) record.status = 'excluded';
  else if (this.config.reportingEnabled === true) {
    var entry = Object.assign({}, data, { event_name: record.event,
      occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    this.queue.push(entry); this.prune(); record.status = 'queued';
  }
  this.persist();
  this.recent.push(record);
  if (this.recent.length > 100) this.recent.shift();
  if (event === 'run_start' || event === 'run_death' || event === 'run_complete' || event === 'app_hide') this.flush();
  else this.schedule(5000);

};
module.exports = Analytics;
