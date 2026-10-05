/**
 * 微信小游戏适配层：存档介质（wx.setStorageSync）
 *
 * ⚠️ 未真机验证。注意两点：
 *  1. wx.getStorageSync 在 key 不存在时返回空字符串 ''（不是 null），要归一化
 *  2. 小游戏本地存储有容量上限（10MB），存一个几百字节的 JSON 完全没压力
 */
'use strict';

function WechatStorage(wxApi) {
  this.wx = wxApi;
}

WechatStorage.prototype.get = function (k) {
  try {
    var v = this.wx.getStorageSync(k);
    if (v === '' || v === undefined || v === null) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch (e) {
    return null;
  }
};

WechatStorage.prototype.set = function (k, v) {
  try { this.wx.setStorageSync(k, v); return true; } catch (e) { return false; }
};

WechatStorage.prototype.remove = function (k) {
  try { this.wx.removeStorageSync(k); return true; } catch (e) { return false; }
};

module.exports = WechatStorage;
