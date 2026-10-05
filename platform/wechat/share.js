/**
 * 微信小游戏适配层：分享。
 *
 * 两件事：
 *   ① 右上角菜单转发（onShareAppMessage）—— 不注册的话转发出去是一张白卡
 *   ② 结算页「晒战绩」按钮主动调起（shareAppMessage）
 *
 * 文案由**核心层**给（game.shareText()，配置在 cfg.share.title），
 * 这里只负责发出去 —— 内容和平台 API 分开，改文案不用碰这个文件。
 */
'use strict';

function WechatShare(wxApi, opts) {
  this.wx = wxApi;
  this.opts = opts || {};
  this.title = this.opts.title || '';
  this.imageUrl = this.opts.imageUrl || '';
  var self = this;

  if (wxApi.onShareAppMessage) {
    wxApi.onShareAppMessage(function () { return self.message(); });
  }
  if (wxApi.showShareMenu) {
    try { wxApi.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] }); } catch (e) {}
  }
}

/** 组一条转发消息（被动转发用固定文案，主动晒战绩用带分数的文案） */
WechatShare.prototype.message = function (text) {
  var m = { title: text || this.title || '来试试这个' };
  if (this.imageUrl) m.imageUrl = this.imageUrl;    // 没配图就让微信自己截屏（默认行为）
  return m;
};

WechatShare.prototype.share = function (payload) {
  var msg = this.message(payload && payload.title);
  if (this.wx.shareAppMessage) this.wx.shareAppMessage(msg);
  return true;
};

module.exports = WechatShare;
