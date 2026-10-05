/**
 * 微信小游戏入口（⚠️ 未真机验证）
 *
 * 目录放法见 platform/wechat/README.md。差异一共只有这几件事：
 *   1. 画布：wx.createCanvas() 替代 document.getElementById
 *   2. 尺寸：wx.getWindowInfo() 替代 window.innerWidth（并且要用 safeArea 避开刘海/底部横条）
 *   3. 输入：触摸摇杆 + 攻击/冲刺键 替代键盘
 *   4. 音效：InnerAudioContext 播 wav 文件替代 Web Audio；BGM 走同一条路（mp3 + loop）
 *   5. 存档：wx.setStorageSync 替代 localStorage
 * 核心逻辑、渲染、HUD、升级卡全是共用的。
 */
'use strict';

/* 1) 挂载核心层与渲染层（等价于网页端的 <script> 标签顺序） */
GameGlobal.__GAME__ = GameGlobal.__GAME__ || {};
require('./core/config.js');
require('./core/world.js');
require('./core/entities.js');
require('./core/progression.js');
require('./core/save.js');
require('./core/game.js');
require('./render/renderer.js');

var TouchInput = require('./platform/wechat/input.js');
var WechatAudio = require('./platform/wechat/audio.js');
var WechatStorage = require('./platform/wechat/storage.js');
var WechatAds = require('./platform/wechat/ads.js');
var WechatShare = require('./platform/wechat/share.js');
var FriendRanking=require('./platform/wechat/ranking.js');
var NS = GameGlobal.__GAME__;

/* 2) 画布与尺寸 */
var canvas = wx.createCanvas();
var ctx = canvas.getContext('2d');
var info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
var W = info.windowWidth, H = info.windowHeight;
var dpr = Math.min(info.pixelRatio || 2, 2);

canvas.width = Math.round(W * dpr);
canvas.height = Math.round(H * dpr);
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后一律用逻辑像素思考

/* 手机安全区：状态栏/刘海/底部横条会遮住 HUD，必须避让 */
var insets = { top: 0, left: 0, right: 0, bottom: 0 };
if (info.safeArea) {
  var sa = info.safeArea;
  insets.top = sa.top || 0;
  insets.left = sa.left || 0;
  insets.right = Math.max(0, W - (sa.left + sa.width));
  insets.bottom = Math.max(0, H - (sa.top + sa.height));
}

/* 3) 组装（核心三件套 + 存档 + 音效 + 广告/分享） */
var storage = new WechatStorage(wx);
/* 广告/分享适配器：没配广告位 id 时 ads 内部是空转的，核心层 adsReady() 直接 false
   → 结算页上不会有"点了没反应"的广告按钮。分享同理。 */
var ads = new WechatAds(wx, NS.Config.ads);
var share = new WechatShare(wx, { title: (NS.Config.share && NS.Config.share.title) || '' });

var game = new NS.Game(NS.Config, {
  World: NS.World,
  Entities: NS.Entities,
  Progression: NS.Progression,
  Save: NS.Save,
  storage: storage,
  ads: ads,
  share: share
});
game.setViewport(W, H, insets);     // 安全区也要给核心层：武器库按钮贴左下角，得避开刘海/横条
/* ⚠️ 启动进**首页**（标题 + 开始游戏 / 继续上次），而不是直接开打。
   这一步显式放在平台层、不塞进 reset()：reset() 保持"一局全新且立刻可玩"，
   所有既有测试和 tools 都是 new Game() 之后直接开打。 */
game.toTitle({ keep: false });      // keep:false —— 刚启动时别拿一局空档把真存档冲掉
// 暴露出来方便在开发者工具/真机的控制台里直接调试：
//   __GAME__.game.player.hp = 999      ← 调数值
//   __GAME__.audio.stats()             ← 音效没声时先看这个（见 platform/wechat/audio.js）
game.ranking=new FriendRanking(wx);
NS.game = game;
NS.storage = storage;

var input = new TouchInput(wx, {
  width: W, height: H,
  safeArea: info.safeArea
});
/* BGM 的配置（音量/淡入淡出/曲目表）从核心层传进来 —— 适配器里不写死任何曲目名 */
var audio = new WechatAudio(wx, 'assets/audio/', { bgm: NS.Config.audio.bgm });
// 音效没声时在控制台执行 __GAME__.audio.stats()，一眼看出是"没发事件"还是"实例死了"
NS.audio = audio;
// 触屏 UI（摇杆/攻击/冲刺）也暴露出来：真机上看不到按钮时可以直接查它的坐标
NS.input = input;

var renderer = new NS.Renderer(ctx, {
  cfg: NS.Config,
  createCanvas: function (w, h) {
    var c = wx.createCanvas();     // 离屏画布：小游戏里同一个 API
    c.width = w; c.height = h;
    return c;
  },
  hint: '',                        // 手机端不显示键盘提示
  restartHint: ''
});
renderer.setInsets(insets);
applyMenuReserve();
/* ⚠️ 必须设尺寸：HUD（血条/经验条/关卡栏/小地图/Boss 血条）**全部**按 this.w/this.h 定位。
   漏了这行的话 this.w=0 → 血条宽度算出来是 0 → 真机上"看不到血量和经验"，
   而网页版 platform/web/main.js 里有 resize，所以一直没暴露。（2026-10 抓到） */
renderer.resize(W, H);
NS.renderer = renderer;      // 控制台可查 __GAME__.renderer.w/h，确认尺寸有没有设上
NS.ads = ads;                // 广告/分享也暴露出来：结算页按钮没出现时先查 __GAME__.ads.ready / cfg.enabled
NS.share = share;

/* Reconcile dimensions after orientation settles and when WeChat restores a cached process. */
function syncViewport(size) {
  var current=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync();
  var w=size&&size.windowWidth||current.windowWidth,h=size&&size.windowHeight||current.windowHeight;
  if(!(w>0&&h>0))return;
  var ratio=Math.max(1,Math.min(current.pixelRatio||2,2));
  var sa=current.safeArea,edges={top:0,left:0,right:0,bottom:0};
  // An orientation event can precede fresh safe-area metrics. Never apply portrait insets to landscape.
  if(sa&&sa.width>0&&sa.height>0&&sa.left>=0&&sa.top>=0&&sa.left+sa.width<=w+1&&sa.top+sa.height<=h+1){
    edges={top:sa.top,left:sa.left,right:Math.max(0,w-sa.left-sa.width),bottom:Math.max(0,h-sa.top-sa.height)};
  }else sa=null;
  var changed=w!==W||h!==H||ratio!==dpr||Object.keys(edges).some(function(k){return edges[k]!==insets[k];});
  W=w;H=h;dpr=ratio;insets=edges;
  if(canvas.width!==Math.round(W*dpr))canvas.width=Math.round(W*dpr);
  if(canvas.height!==Math.round(H*dpr))canvas.height=Math.round(H*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  renderer.resize(W,H);renderer.setInsets(insets);renderer.setMenuReserve(menuReserve());game.setViewport(W,H,insets);game.setMenuReserve(menuReserve());
  if(changed)input.resize({width:W,height:H,safeArea:sa});
  if(changed&&game.rankOpen&&game.ranking)game.ranking.show(game.rankRects().list);
}
var viewportChecks=30;
if(typeof wx.onWindowResize==='function')wx.onWindowResize(function(event){syncViewport(event&&event.size);viewportChecks=30;});
syncViewport();

/* 4) 前后台生命周期
   切后台随时可能被杀掉：先把这一局落盘（下次进来能「继续上次」），并停成暂停面板
   —— 回来时不会发现自己"在怪堆里继续挨打"。 */
wx.onHide(function () {
  game.pause();
  game.saveNow();
});
wx.onShow(function () {
  last=0;
  syncViewport();viewportChecks=30;
  input.resize({width:W,height:H,safeArea:{top:insets.top,height:H-insets.top-insets.bottom}});
  /* 故意不自动继续：回来时停在暂停面板上，玩家自己点「继续」。
     （音频的恢复不在这里 —— 那是 audio 适配器自己处理的，见 platform/wechat/audio.js） */
});

/* 微信**原生胶囊按钮**（右上角 ⋯／⊙）的避让高度 —— safeArea 完全不管它，必须单独量。
   量不到（开发者工具/网页/老基础库）就是 0：版式和以前一样，不会莫名多出一块空白。
   ⚠️ 横屏时胶囊就在右上角，而暂停键 + 击杀/金币卡也在那儿 —— 不避让的话真机上一进游戏
      右上角就压住平台自己的按钮（点到会弹微信的退出菜单，玩家以为"暂停键坏了"）。
   ⚠️ 这两个函数故意写在 syncViewport **下面**：tools/verify-viewport.js 只切
      「function syncViewport → 主循环」这一段来跑，写在外面那个切片里就没有它 → ReferenceError。
      函数声明会提升，所以上面初始化的 applyMenuReserve() 照样能用。 */
function menuReserve() {
  try {
    if (typeof wx.getMenuButtonBoundingClientRect !== 'function') return { top: 0 };
    var mb = wx.getMenuButtonBoundingClientRect();
    if (mb && mb.width > 0 && mb.bottom > 0) return { top: Math.round(mb.bottom + 8) };
  } catch (e) { /* 忽略：拿不到就不避让 */ }
  return { top: 0 };
}
function applyMenuReserve() {
  var mr = menuReserve();
  renderer.setMenuReserve(mr); game.setMenuReserve(mr);
}

/* 5) 主循环 */
var last = 0;
function loop(now) {
  if(viewportChecks>0){viewportChecks--;syncViewport();}
  if (!last) last = now;
  var rawDt=Math.max(0,(now-last)/1000);
  var dt = Math.min(rawDt, 0.04);
  last = now;

  /* 音效/震动开关：核心层存着（存档里也有），每帧同步给适配器 —— 幂等，不产生额外分配 */
  audio.setMuted(!game.settings.sound);
  audio.setVibrate(game.settings.vibrate);
  /* BGM：核心层只回答"该放哪一首"（首页/Boss/关音乐都在那一处判定），
     怎么淡入淡出、什么时候停是适配器的事。两行都幂等。 */
  audio.setBgmTrack(game.bgmTrack());
  audio.tickMusic(dt);
  /* 试炼场入口已改成首页右上角的「试炼」按钮（只在 debug.enabled 时存在）——
     平台层这里不再有"长按进试炼场"的一次性信号。 */

  var events = game.drainEvents();
  audio.handle(events);
  renderer.handleEvents(events);

  game.tickRankClock(rawDt);
  game.update(dt, input.read(game));
  renderer.draw(game, now / 1000);
  input.draw(ctx, game);           // 摇杆/按键画在最上层
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
