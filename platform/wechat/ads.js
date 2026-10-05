/**
 * 微信小游戏适配层：激励视频广告（IAA，唯一能立刻落地的收入口）。
 *
 * 为什么默认不生效：激励视频要先在微信后台开通「流量主」才拿得到广告位 id。
 * 没配（cfg.ads.enabled=false 或 rewardedUnitId 为空）时这个适配器**等于不存在**
 * —— 核心层 game.adsReady() 返回 false，结算页上连按钮都不会出现。
 *
 * 任何一步失败（没实例 / 加载失败 / 播放中断 / 超时）都回调 false：
 * 核心层收到 false **什么都不给**，玩家不会"看了广告没拿到东西"。
 */
'use strict';

var LOAD_TIMEOUT_MS = 8000;    // 加载+播放的总超时：宁可说"这次没广告"，也别让按钮点下去石沉大海

function WechatAds(wxApi, cfg) {
  this.wx = wxApi;
  this.cfg = cfg || {};
  this.ad = null;
  this.ready = false;
  this.pending = null;         // { cb, timer }

  if (!this.cfg.enabled || !this.cfg.rewardedUnitId) return;   // 没配广告位 = 整个适配器不工作
  if (!wxApi.createRewardedVideoAd) return;

  var self = this;
  try {
    this.ad = wxApi.createRewardedVideoAd({ adUnitId: this.cfg.rewardedUnitId });
  } catch (e) {
    this.ad = null;
    return;
  }

  this.ad.onLoad(function () { self.ready = true; });
  this.ad.onError(function (err) {
    self.ready = false;
    console.warn('[ads] 激励视频加载失败', err);   // 真机没广告时先看这条
  });
  /* ⚠️ 只有 res.isEnded === true 才算"看完"；旧基础库不带 res → 视为看完（否则老设备永远拿不到奖励） */
  this.ad.onClose(function (res) {
    var ok = !res || res.isEnded === undefined || !!res.isEnded;
    self._settle(ok);
  });

  var p = this.ad.load();
  if (p && p.catch) p.catch(function () { /* 失败就算了，show 的时候还会再试一次 */ });
}

/**
 * 播一条激励视频。cb(ok) 保证**只回调一次**（onClose / 超时 / 出错都走同一条路）。
 */
WechatAds.prototype.showRewarded = function (kind, cb) {
  if (!this.ad) { cb(false); return false; }
  if (this.pending) { cb(false); return false; }        // 一次只播一条

  var self = this;
  var timer = setTimeout(function () { self._settle(false); }, LOAD_TIMEOUT_MS);
  this.pending = { cb: cb, timer: timer, kind: kind };

  var shown = this.ad.show();
  if (shown && shown.catch) {
    shown.catch(function () {
      /* 常见原因：还没加载好。官方推荐的兜底是"重新 load 再 show 一次" */
      var lp = self.ad.load();
      if (!lp || !lp.then) { self._settle(false); return; }
      lp.then(function () { return self.ad.show(); })
        .catch(function () { self._settle(false); });
    });
  }
  return true;
};

WechatAds.prototype._settle = function (ok) {
  var p = this.pending;
  if (!p) return;                       // 已经结算过（重复回调直接忽略）
  this.pending = null;
  clearTimeout(p.timer);
  try { p.cb(ok); } catch (e) { /* 核心层的回调不该把这里带崩 */ }
};

module.exports = WechatAds;
