/**
 * 微信小游戏适配层：音效。
 *
 * 小游戏侧的音频只有能播文件的 InnerAudioContext（WebAudioContext 要基础库 2.19.0+，
 * 见文件末尾"可选升级"，当前先用 InnerAudioContext）—— 音效因此必须落成
 * assets/audio/*.wav 文件（网页端用同一批文件的 base64）。
 *
 * 真机实测踩过的两个坑（都是"没声"，但成因完全不同）：
 *   1. 变体名解析不出来 → 去播不存在的 hit.wav → 静默无声。见下面的 FALLBACK_VARIANTS。
 *   2. 玩着玩着就没声：系统中断（来电/其他 App 抢音频焦点）和退后台回来之后，
 *      池里的实例会失效，但代码从不清池、也不重建。官方 InnerAudioContext 文档明确
 *      要求处理 wx.onAudioInterruptionBegin / End；音频指南还写明「Android 上最多同时
 *      播放 10 个音频，超过的部分会做有损处理（开发者不感知）」以及「及时销毁不用的
 *      实例」。这三条以前一条都没做，于是实例越攒越死、最后整局哑掉。
 *
 * 现在的做法：池子复用 + 死实例自愈 + 中断/前后台整池重建 + stats() 真机自检。
 *
 * BGM（背景音乐）在同一个文件里，但**不是**音效池的一部分 —— 见下面的「BGM 通道」，
 * 两者最大的差别是：音效是打一枪换个地方的短音（池子轮着复用没问题），
 * BGM 是一直挂着的那一条（进池子就会被别的音效抢走）。
 */
'use strict';

/* ==================== 挥刀音策略 ====================
 * 手机端是 AUTO_ATTACK 自动攻击，每秒挥 ~3 刀，一局几千刀。
 * 空挥的"咻"没有任何信息量，每刀都响一定会烦。
 *
 *   'off'    完全不播挥刀音。
 *   'onHit'  只在真的打到东西那一刀响 —— 当前用的就是这个：有挥砍反馈，但不吵。
 *   'always' 每刀都响（只有手动点击攻击的玩法才合适）。
 */
var SWING_MODE = 'onHit';

/* 各音效音量。
 * ⚠️ 'onHit' 模式下挥刀音和命中音会**同一瞬间叠放**（核心层先算判定再发事件），
 *    所以两者要分工：挥刀负责高频"脆"，命中负责低频"重"。
 *    音量也要留出余量 —— 两个音峰值相加超过 1.0 会在手机外放上削波发糊。 */
var GAIN = {
  entranceRumble:.50,entranceWell:.55,entranceDoor:.55,entranceStone:.65,entranceBreak:.75,
  swing: 0.48, hit: 0.74, kill: 0.90, hurt: 1.00,
  pickup: 0.65, equip: 0.70, levelup: 0.90, boss: 1.00,
  /* 低血心跳：比打击音轻一档。它每隔几秒就会响一次（背景性提醒），
     给到和 hit 一样大就会变成"一直在捶耳朵"。 */
  lowHp: 0.78
};

/* 同音效最小间隔（秒）。一刀打中一堆怪时，别叠成一串。 */
var MIN_GAP = { swing: 0.18, hit: 0.07, kill: 0.06, default: 0.03 };

var POOL_SIZE = 4;          // 同一音效最多同时播几个

/* BGM 起播失败重试：iOS 上第一下没有用户手势、文件没打进包，都会失败。
   ⚠️ 上限必须是有限的：某机型 onPlay 不回调的话，无限重试就是"每 1.5 秒把音乐重置回第一拍"，
      比干脆没声还难查。宁可不放，也不要在耳朵里反复重启。 */
var BGM_MAX_RETRY = 3;

/* ==================== 自愈参数 ====================
 * 真机上音频实例是会被系统弄死的（中断、回收、错误）。死实例不清理的话，
 * 那个音效就永久哑 —— "玩着玩着就没声"就是这么来的。 */
var MAX_FAILS = 2;          // 同一实例连续出错几次就判死（下次取用时销毁重建）
var STALE_SECONDS = 3;      // 标了"在播"但这么久还没有结束事件 = 卡死，强制回收
                            // （最长的 boss.wav 也才 0.4 秒，3 秒绝对是死了不是还在响）

/* 是否跟随系统静音键。
 * false = 手机拨到静音档也出声（游戏的标准做法；真机测试时不关这个，
 *         会被误判成"音效坏了"）。改成 true 就跟随系统静音。 */
var OBEY_MUTE_SWITCH = false;

/* 事件 → 音效文件名前缀（可能有变体，播放时随机挑一个） */
var EVENT_SOUND = {
  entranceRumble:'entrance-rumble',entranceWell:'entrance-scrape',entranceDoor:'entrance-door',entranceStone:'entrance-stone',entranceBreak:'entrance-break',
  swing: 'swing', hit: 'hit', kill: 'kill', hurt: 'hurt',
  /* 旋刃：起转用"咻"（= 刀甩起来）。**收刃不出声**（真机："金属声音去掉"）——
     收刃完全没有音画提示，靠"刀刃消失"本身传达。 */
  spin: 'swing',
  pickup: 'pickup', equip: 'equip', levelup: 'levelup',
  // 处决：复用击杀音（它就是"一刀带走"，不需要单独一类反馈）
  execute: 'kill',
  // 重刷卡片（花金币）：复用升级音 —— 它是"卡又换了一批"，和升级是同一类反馈
  frenzyStart: 'frenzyStart', frenzyEnd: 'frenzyEnd', frenzyReady: 'equip',
  reroll: 'levelup',
  boss: 'boss', bossDown: 'levelup', die: 'hurt', slam: 'hit',
  // 甲壳兽合壳挡下攻击：金属"当"。**没有这张表 = 完全没声音**（血条不动又没声，玩家会以为卡了）
  block: 'block',
  // 敌群预警：没声音的话玩家经常是"被围住了才反应过来"（真机反馈"提示不够明显"）
  swarmWarn: 'boss', swarm: 'boss', harvestWarn: 'levelup',
  /* 低血心跳（2026-10：血条挪到左上角之后补的一层听觉提醒）。
     ⚠️ 单独一个 lowhp.wav，**不复用 hurt**：hurt 是"刚被打"的一次性反应，
        低血心跳是"你一直很危险"的背景提醒，两者语义不同，共用会让玩家分不清。 */
  lowHp: 'lowhp',
  // 法杖开火：不算"挥刀"，所以不受上面的 SWING_MODE 策略限制 ——
  // 每次施法都是玩家有意识的一击，必须给反馈
  skillHeavy: 'hit', skillPierce: 'swing',
  cast: 'swing'
};

/* ==================== 变体兜底表 ====================
 * 变体表（hit1/hit2/hit3）本来是 assets/audio/index.js 挂到 __GAME__.SfxGroups 上的，
 * 但那个文件是网页端的 base64 内联，部署脚本**故意不带到小游戏包里**（小游戏只读 .wav）。
 * 于是小游戏里 variants 恒为空表 → pick('hit') 原样返回 'hit' → 去播不存在的
 * assets/audio/hit.wav → onError、静默无声。实测踩过：命中/挥刀/击杀的音全哑，
 * 而烟雾测试只断言"播过名字里带 hit 的 src"，所以一直是绿的 —— 名字对、文件不存在。
 *
 * 这里内置一份兜底表，小游戏侧不依赖 index.js 也能挑到变体。
 * ⚠️ 改音效文件名时必须同步改这里：tools/smoke-wechat.js 会校验表里每个文件
 *    在打包目录里真实存在，漏改即测试失败。
 * SfxGroups 存在时（混合/网页侧路径）一律以它为准，这里只补空缺。 */
var FALLBACK_VARIANTS = {
  swing: ['swing1', 'swing2', 'swing3'],
  hit:   ['hit1', 'hit2', 'hit3'],
  kill:  ['kill1', 'kill2'],
  block: ['block1', 'block2'],
  hurt: ['hurt'],
  frenzyStart: ['frenzyStart'], frenzyEnd: ['frenzyEnd'],
  pickup: ['pickup'], equip: ['equip'], levelup: ['levelup'], boss: ['boss']
};

function WechatAudio(wxApi, basePath, opts) {
  this.wx = wxApi;
  this.base = basePath || 'assets/audio/';
  // 策略挂到实例上（也能构造时覆盖），这样测试可以按当前配置推导预期，不用手改断言
  this.swingMode = (opts && opts.swingMode) || SWING_MODE;
  this.pool = {};           // 文件名 -> [InnerAudioContext]
  this.variants = {};       // 前缀 -> [文件名]
  this.last = {};
  this.muted = false;
  /* 震动开关：由核心层的 settings.vibrate 驱动（platform 每帧 setVibrate 同步） */
  this.vibrate = true;

  /* ---- BGM（背景音乐）----
     配置（音量/淡入淡出/曲目表）由核心层传进来，适配器里**不许**写死任何曲目名。 */
  this.bgmCfg = (opts && opts.bgm) || null;
  this.bgmWant = null;         // 核心层说"该放哪一首"（null = 不该有音乐）
  this.bgmTrack = null;        // 当前实际载入的那一首
  this.bgm = null;             // 独立实例（不进音效池）
  this.bgmVol = 0;             // 当前音量（淡入淡出过程中）
  this.bgmTarget = 0;          // 目标音量
  this.bgmNext = null;         // 淡出到底之后要切过去的那一首
  this.bgmPlaying = false;     // 底层确认在播（onPlay 才算）
  this.bgmSuspended = false;   // 退后台/中断中：一律不推进，回来整体重建
  this.bgmRetryAt = 0;         // 起播失败后的重试时间（iOS 首次没手势会失败）
  this.bgmRetryLeft = 0;       // 还能重试几次
  this.bgmRetryPending = false;// 只有"真的报错了"才置位（不是"onPlay 没回调"就重试）
  this.bgmPlays = 0;           // 真正 play() 出去几次
  this.bgmErr = 0;             // 起播失败次数

  // 自检计数（真机上 __GAME__.audio.stats() 看得到）
  this.createdCount = 0;    // 建过多少实例
  this.destroyedCount = 0;  // 销毁过多少（自愈 + 重建）
  this.recoveredCount = 0;  // 重建过几次池子（中断/前后台）
  this.staleCount = 0;      // 抓到几个卡死实例
  this.deadCount = 0;       // 判死并回收了几个实例
  this.throttledCount = 0;  // 被最小间隔挡掉的播放次数（挡太多说明打击音会被吞）
  this.tryByKey = {};       // 事件 key -> 尝试播放次数

  // 从生成好的音效索引里读出变体表（index.js 会挂 __GAME__.SfxGroups）
  var NS = (typeof GameGlobal !== 'undefined' ? GameGlobal.__GAME__ : null);
  var groups = (NS && NS.SfxGroups) || [];
  for (var i = 0; i < groups.length; i++) this.variants[groups[i].key] = groups[i].files;
  // 小游戏包里没有 index.js（SfxGroups 恒空）→ 用兜底表补齐，否则会去播不存在的 hit.wav
  for (var k in FALLBACK_VARIANTS) {
    if (!this.variants[k]) this.variants[k] = FALLBACK_VARIANTS[k];
  }

  this._bindLifecycle();
}

/** 有变体就随机挑一个 —— InnerAudioContext 没有 playbackRate，只能靠这个避免重复感 */
WechatAudio.prototype.pick = function (key) {
  var list = this.variants[key];
  if (list && list.length) {
    if (list.length === 1) return list[0];
    return list[Math.floor(Math.random() * list.length)];
  }
  return key;
};

/* ==================== 生命周期：中断 / 前后台 ====================
 * 官方 InnerAudioContext 文档原文：「音频播放过程中，可能被系统中断，可通过
 * wx.onAudioInterruptionBegin、wx.onAudioInterruptionEnd 事件来处理这种情况。」
 * 不处理的话，来一通电话、被别的 App 抢走音频焦点，池里的实例就全废了 ——
 * 而玩家看到的现象就是"玩着玩着就没声了"，且再也不会自己好。
 *
 * 所以中断开始/结束、退后台、回前台，一律整池销毁重建（实例不贵，337KB 音效而已）。 */
WechatAudio.prototype._bindLifecycle = function () {
  var wx = this.wx, self = this;
  if (!wx) return;
  var on = function (api, fn) {
    if (typeof wx[api] !== 'function') return;
    try { wx[api](fn); } catch (e) { /* 老基础库没有就当没这回事 */ }
  };
  /* 音效池：这几件事之后池里实例一律不可信 → 整池重建（原有做法，没变）
     BGM：中断/退后台要停住（否则来电时音乐继续响），回来后**整体重建再放** ——
          跟音效池同一个道理：中断过的实例不能信。 */
  on('onAudioInterruptionBegin', function () { self.recover('中断开始'); self._bgmSuspend(); });
  on('onAudioInterruptionEnd', function () { self.recover('中断结束'); self._bgmResume(); });
  on('onHide', function () { self.recover('退后台'); self._bgmSuspend(); });
  on('onShow', function () { self.recover('回前台'); self._bgmResume(); });
};

/** 整池销毁 —— 中断过/退过后台的实例一律不可信，只能重建 */
WechatAudio.prototype._destroyAll = function () {
  var names = Object.keys(this.pool);
  for (var i = 0; i < names.length; i++) {
    var list = this.pool[names[i]];
    for (var j = 0; j < list.length; j++) {
      var a = list[j];
      try {
        if (a.stop) a.stop();
        if (a.destroy) a.destroy();
      } catch (e) { /* 已经失效的实例，销毁失败无所谓 */ }
      this.destroyedCount++;
    }
  }
  this.pool = {};
};

/**
 * 重建音频池。触发场景：系统中断开始/结束、退后台、回前台。
 * 不做这件事 = 真机上"玩着玩着就没声"且不会再恢复。
 */
WechatAudio.prototype.recover = function (reason) {
  var had = Object.keys(this.pool).length;
  this._destroyAll();
  this.last = {};            // 节流时间表也一起清掉，否则回来头几刀会被旧时间戳挡掉
  this.recoveredCount++;
  if (had) console.info('[sfx] 音频池已重建（' + (reason || '未知原因') + '）');
};

/** 静音键等全局选项：建实例之前设一次就全局生效 */
WechatAudio.prototype._ensureOption = function () {
  if (this._optionSet) return;
  this._optionSet = true;
  if (typeof this.wx.setInnerAudioOption !== 'function') return;
  try {
    this.wx.setInnerAudioOption({
      obeyMuteSwitch: OBEY_MUTE_SWITCH,   // 手机静音档也给游戏出声，否则真机容易被误判成没声
      mixWithOther: true                  // 别把微信里的语音/音乐掐断
    });
  } catch (e) { /* 老基础库不支持就算了，不影响播 */ }
};

/** 建一个实例，并把"播成功 / 播失败"都记下来 —— 判死靠的就是这两个回调 */
WechatAudio.prototype._create = function (name) {
  this._ensureOption();
  var a = this.wx.createInnerAudioContext();
  this.createdCount++;
  a.src = this.base + name + '.wav';
  a._busy = false;          // 标了 busy 的实例不会被复用
  a._dead = false;
  a._fails = 0;             // 连续失败次数
  a._plays = 0;
  a._ok = 0;                // 确认播出去的次数（onPlay/onEnded 都算）
  a._confirmed = false;     // 本次播放有没有被确认
  a._startedAt = 0;

  var confirm = function () {
    if (a._confirmed) return;
    a._confirmed = true;
    a._ok++;
    a._fails = 0;           // 能出声就说明实例还活着，失败计数清零
  };
  a.onPlay(confirm);
  a.onEnded(function () { a._busy = false; confirm(); });
  a.onError(function (e) {
    a._busy = false;
    a._fails++;
    console.warn('[sfx] 播放失败', name, e);
    // 错够了就判死：留在池里只会让这个音效永久哑
    if (a._fails >= MAX_FAILS) a._dead = true;
  });

  return a;
};

/** 回收一个实例：先销毁再移出池子，下次用时会新建 */
WechatAudio.prototype._retire = function (name, idx) {
  var list = this.pool[name];
  if (!list || !list[idx]) return;
  var a = list[idx];
  try {
    if (a.stop) a.stop();
    if (a.destroy) a.destroy();
  } catch (e) { /* 忽略 */ }
  list.splice(idx, 1);
  this.destroyedCount++;
  this.deadCount++;
};

WechatAudio.prototype._get = function (name) {
  var list = this.pool[name];
  if (!list) list = this.pool[name] = [];
  var now = Date.now() / 1000;

  // 先清扫死实例。倒着遍历是因为会 splice。
  for (var i = list.length - 1; i >= 0; i--) {
    var a = list[i];
    // 1) 标着"在播"但远超最长音效时长还没结束 → 卡死（onEnded 丢了），强制松开
    if (a._busy && now - a._startedAt > STALE_SECONDS) {
      a._busy = false;
      a._confirmed = false;
      this.staleCount++;
    }
    // 2) 出过错、或者播了两次一次都没确认出声 → 判死回收（不回收就是永久哑）
    var dead = a._dead || (!a._busy && a._plays >= 2 && a._ok === 0);
    if (dead && !a._busy) this._retire(name, i);
  }

  for (var j = 0; j < list.length; j++) {
    if (!list[j]._busy) return list[j];
  }
  if (list.length >= POOL_SIZE) return list[0];   // 池满就抢最早那个，比新建实例省内存

  var a = this._create(name);
  list.push(a);
  return a;
};

WechatAudio.prototype.play = function (key, gain) {
  if (this.muted) return;
  this.tryByKey[key] = (this.tryByKey[key] || 0) + 1;

  var gap = (MIN_GAP[key] !== undefined) ? MIN_GAP[key] : MIN_GAP.default;
  var now = Date.now() / 1000;
  if (this.last[key] && now - this.last[key] < gap) { this.throttledCount++; return; }
  this.last[key] = now;

  var name = this.pick(key);
  var a = this._get(name);
  try {
    a.volume = (gain === undefined ? 1 : gain);
    a._busy = true;
    a._startedAt = now;
    a._confirmed = false;
    a._plays++;
    a.stop();          // 复用实例必须先 stop，否则第二次 play 无声
    a.play();
  } catch (e) {
    a._busy = false;
  }
};

/**
 * 真机自检：控制台执行 __GAME__.audio.stats()
 *
 * 怎么用这份数据定位"没声"：
 *   - try 全是 0            → 上游没发事件，问题在核心层不在音频层
 *   - try 有、throttled 很大 → 打击音被最小间隔吞了，调 MIN_GAP
 *   - 某音效 instances 不涨而 plays 涨 → 池子里全是死实例（自愈没生效）
 *   - recovered 一直涨      → 手机在反复被中断/切后台，这是真机上很常见的情况
 */
WechatAudio.prototype.stats = function () {
  var sounds = {};
  var names = Object.keys(this.pool);
  for (var i = 0; i < names.length; i++) {
    var list = this.pool[names[i]], busy = 0, ok = 0, plays = 0;
    for (var j = 0; j < list.length; j++) {
      var a = list[j];
      if (a._busy) busy++;
      ok += a._ok;
      plays += a._plays;
    }
    sounds[names[i]] = { instances: list.length, playing: busy, plays: plays, ok: ok };
  }
  return {
    created: this.createdCount, destroyed: this.destroyedCount,
    recovered: this.recoveredCount, stale: this.staleCount, dead: this.deadCount,
    throttled: this.throttledCount, tries: this.tryByKey, muted: this.muted,
    /* BGM 自检：控制台 __GAME__.audio.stats().bgm
       track 有值但 playing=false → 起播失败（iOS 没手势 / 文件没打进包 / 域名没配）
       plays 一直涨而 playing=false → 每一帧都在重启（tickMusic 的幂等被破坏了） */
    bgm: {
      want: this.bgmWant, track: this.bgmTrack, playing: !!this.bgmPlaying,
      volume: Math.round(this.bgmVol * 1000) / 1000, suspended: !!this.bgmSuspended,
      plays: this.bgmPlays, errors: this.bgmErr, retryLeft: this.bgmRetryLeft
    },
    sounds: sounds
  };
};

WechatAudio.prototype.handle = function (events) {
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];

    // 挥刀音的策略判定：空挥永远不出声（'onHit' / 'off' 都一样）
    if (ev.type === 'swing') {
      if (this.swingMode === 'off') continue;
      if (this.swingMode === 'onHit' && !ev.connected) continue;
    }

    var key = EVENT_SOUND[ev.type];
    if (!key) continue;
    this.play(key, GAIN[ev.type]);

    /* 震动（可在设置里关掉）：
       hurt / kill / frenzyStart = 轻 —— 打击感的一半
       lowHp = 中 —— 低血心跳，几秒一次，要通过手感觉到（画面/声音都可能被漏掉） */
    var vib = ev.type === 'lowHp' ? 'medium'
            : (ev.type === 'hurt' || ev.type === 'kill' || ev.type === 'frenzyStart') ? 'light' : null;
    if (vib && this.vibrate && this.wx.vibrateShort &&
        (!this.lastVibrate || Date.now() - this.lastVibrate >= 100)) {
      this.lastVibrate = Date.now();
      try { this.wx.vibrateShort({ type: vib }); } catch (e) { /* 忽略 */ }
    }
  }
};

WechatAudio.prototype.toggleMute = function () {
  this.muted = !this.muted;
  return this.muted;
};

/** 由核心层的设置驱动（platform 每帧同步），和 toggleMute 的区别是它是幂等的 */
WechatAudio.prototype.setMuted = function (v) {
  this.muted = !!v;
  return this.muted;
};

/** 震动开关（设置面板里那个），同一个套路 */
WechatAudio.prototype.setVibrate = function (v) {
  this.vibrate = !!v;
  return this.vibrate;
};

/* ==================== BGM 通道 ====================
 * 音效是"打一枪换个地方"的短音，池子轮着复用没问题；BGM 是**一直挂着的那一条**，
 * 扔进池子会被别的音效抢走（表现就是音乐放两秒就没了）→ 必须有独立实例。
 *
 * 官方音频指南的示例本身就是「地址 + loop = true」，所以循环交给底层，
 * 我们只在切曲时换 src。三件必须自己处理的事：
 *   1. Android 最多同时 10 个音频 —— BGM 常驻占掉 1 个，音效池别再调大
 *   2. 切后台/来电中断：音乐要停，回来自动接上（中断过的实例不可信 → 重建）
 *   3. InnerAudioContext 没有 crossfade，"淡入淡出"只能自己按帧拉 volume（tickMusic）
 *
 * ⚠️ 曲目地址一律从 cfg.audio.bgm.tracks 里查（核心层给 track 名）——
 *    本文件**不许**出现写死的 BGM 文件名，否则"改曲目要改两处"。
 * ⚠️ 同一首重复 tickMusic 必须幂等：不判重的写法是每帧 restart，
 *    听起来就是"一直在第一拍飘"，比干脆没音乐还糟。
 */

/** 曲目名 → 真实地址（只认 cfg 里的表；没配 = null，调用方当"没这一首"处理） */
WechatAudio.prototype.bgmSrc = function (track) {
  var t = this.bgmCfg && this.bgmCfg.tracks;
  if (!track || !t) return null;
  return t[track] || null;
};

/** 由核心层每帧驱动：现在"该放"哪一首（null = 什么都别放） */
WechatAudio.prototype.setBgmTrack = function (track) {
  this.bgmWant = track || null;
};

WechatAudio.prototype._bgmDestroy = function () {
  var a = this.bgm;
  this.bgm = null;
  this.bgmTrack = null;
  this.bgmVol = 0;
  this.bgmTarget = 0;
  this.bgmNext = null;
  this.bgmPlaying = false;
  if (!a) return;
  try {
    if (a.stop) a.stop();
    if (a.destroy) a.destroy();
  } catch (e) { /* 已经失效的实例，销毁失败无所谓 */ }
  this.destroyedCount++;
};

/** 停掉音乐但**留着实例**（切曲/关音乐时用；真正不可信时才 _bgmDestroy） */
WechatAudio.prototype._bgmStop = function () {
  this.bgmTrack = null;
  this.bgmNext = null;
  this.bgmVol = 0;
  this.bgmTarget = 0;
  this.bgmPlaying = false;
  this.bgmRetryPending = false;
  if (!this.bgm) return;
  try { this.bgm.stop(); } catch (e) { /* 忽略 */ }
};

/** 起播一首（一律从音量 0 淡进来）。地址没配/建实例失败就返回 false，不抛。 */
WechatAudio.prototype._bgmStart = function (track) {
  var self = this;
  var src = this.bgmSrc(track);
  if (!src) { this.bgmTrack = null; this.bgmTarget = 0; return false; }
  if (!this.bgm) {
    try {
      this.bgm = this.wx.createInnerAudioContext();
    } catch (e) {
      return false;
    }
    this.createdCount++;
    this.bgm.loop = true;                      // 循环交给底层（官方音频指南的写法）
    this.bgm.onPlay(function () {
      self.bgmPlaying = true;
      self.bgmRetryPending = false;      // 确认响了：不用再试
      self.bgmRetryLeft = BGM_MAX_RETRY;
    });
    /* loop=true 理论上不会有 onEnded；真来了说明底层没认 loop，那就重放一次接上 */
    this.bgm.onEnded(function () {
      self.bgmPlaying = false;
      if (!self.bgmSuspended && self.bgmTrack) {
        try { self.bgm.play(); } catch (e) { /* 下次 tick 还会试 */ }
      }
    });
    this.bgm.onError(function (e) {
      self.bgmPlaying = false;
      self.bgmErr++;
      /* 起播失败的两个常见原因：iOS 上第一下没有用户手势、文件没打进包。
         不每帧重试（会把日志刷爆），1.5 秒后再试。 */
      self.bgmRetryAt = Date.now() + 1500;
      self.bgmRetryPending = true;
      if (self.bgmRetryLeft <= 0) {
        console.warn('[bgm] 播放失败且已放弃重试', self.bgmTrack, e);
      } else {
        self.bgmRetryLeft--;
        console.warn('[bgm] 播放失败，1.5 秒后重试（还剩 ' + self.bgmRetryLeft + ' 次）', self.bgmTrack, e);
      }
    });
  }
  var vol = (this.bgmCfg && this.bgmCfg.volume) || 0.34;
  try {
    this.bgm.src = src;
    this.bgm.volume = 0;
    this.bgmTrack = track;
    this.bgmVol = 0;
    this.bgmTarget = vol;
    this.bgmPlays++;
    /* 刚起播的先给 1.5 秒确认时间，别在同一帧又被下面的重试分支 play 一遍 */
    this.bgmRetryAt = Date.now() + 1500;
    this.bgmRetryLeft = BGM_MAX_RETRY;
    this.bgmRetryPending = false;
    this.bgmPlaying = false;                 // 等 onPlay 确认，别自欺欺人
    this.bgm.play();
  } catch (e) {
    this.bgmPlaying = false;
    this.bgmErr++;
    return false;
  }
  return true;
};

/** 退后台 / 来电中断：停住（留实例，位置还能保住） */
WechatAudio.prototype._bgmSuspend = function () {
  this.bgmSuspended = true;
  if (!this.bgm) return;
  try { this.bgm.pause(); } catch (e) { /* 忽略 */ }
};

/** 回前台 / 中断结束：中断过的实例不可信 → 整体重建，下一帧 tickMusic 自动接上 */
WechatAudio.prototype._bgmResume = function () {
  this.bgmSuspended = false;
  this._bgmDestroy();
  this.bgmRetryAt = 0;
};

/**
 * 每帧推进一次（平台层主循环喂 dt）。做三件事：
 *   ① 目标曲目变了 → 换（旧的先淡出，淡到底再切；关音乐也走这条路）
 *   ② 音量朝目标走（这就是 InnerAudioContext 缺失的 crossfade）
 *   ③ 起播失败的定期重试
 * 幂等：同一首反复调用只调整音量，不会重启播放。
 */
WechatAudio.prototype.tickMusic = function (dt) {
  var cfg = this.bgmCfg;
  if (!cfg || cfg.enabled === false) return;
  if (this.bgmSuspended) return;                 // 退后台/中断中：什么都不做

  var want = this.bgmWant;
  if (want && !this.bgmSrc(want)) want = null;   // cfg 里没配这首（如 boss 曲还没做）→ 别静音

  /* ① 换曲 */
  if (want !== this.bgmTrack) {
    if (!this.bgmTrack) {
      if (want) this._bgmStart(want);            // 从无到有：直接起
    } else if (this.bgmVol <= 0.001) {
      if (want) this._bgmStart(want);            // 已经淡到底了：直接切
      else this._bgmStop();
    } else {
      this.bgmNext = want;                       // 还在响：挂起，淡到底时由 ②' 执行
      this.bgmTarget = 0;
    }
  } else if (want) {
    this.bgmTarget = cfg.volume || 0.34;         // 同一首：只把音量推到目标（不重启）
  }

  /* ② 音量逼近目标 */
  if (this.bgm) {
    var d = this.bgmTarget - this.bgmVol;
    if (d !== 0) {
      var fade = (d > 0 ? (cfg.fadeIn || 0.8) : (cfg.fadeOut || 0.6));
      var step = ((cfg.volume || 0.34) / Math.max(fade, 0.05)) * (dt || 0);
      this.bgmVol += (Math.abs(d) <= step ? d : (d > 0 ? step : -step));
      if (this.bgmVol < 0) this.bgmVol = 0;
      try { this.bgm.volume = this.bgmVol; } catch (e) { /* 忽略 */ }
    }
  }

  /* ②' 淡到底 → 执行挂起的切换 / 收尾停掉 */
  if (this.bgmTarget <= 0.001 && this.bgmVol <= 0.001 && this.bgmTrack) {
    if (this.bgmNext) {
      var n = this.bgmNext;
      this.bgmNext = null;
      this._bgmStart(n);
    } else if (!this.bgmSrc(this.bgmWant)) {
      this._bgmStop();
    }
  }

  /* ③ 起播失败的重试（iOS 首次没手势 / 实例被系统弄死）
     ⚠️ 触发条件必须是"真的收到过 onError"，不能写成"onPlay 还没回调" ——
        后者在某些机型上会变成每 1.5 秒重放一次（一直在第一拍），比没声更难查。 */
  if (this.bgmRetryPending && this.bgmRetryLeft > 0 && this.bgmTrack && !this.bgmNext &&
      Date.now() >= this.bgmRetryAt) {
    this.bgmRetryAt = Date.now() + 1500;
    this.bgmRetryPending = false;            // 再失败会由 onError 重新置位
    this.bgmPlays++;
    try { if (this.bgm) this.bgm.play(); } catch (e) { /* 下次再说 */ }
  }
};

module.exports = WechatAudio;
// 暴露当前默认策略：测试要按它推导预期（翻了开关不用手改断言）
WechatAudio.DEFAULT_SWING_MODE = SWING_MODE;
// 暴露事件表和变体兜底表：烟雾测试要校验"每个事件都能解析到真实存在的 .wav"
WechatAudio.EVENT_SOUND = EVENT_SOUND;
WechatAudio.FALLBACK_VARIANTS = FALLBACK_VARIANTS;
WechatAudio.POOL_SIZE = POOL_SIZE;
WechatAudio.OBEY_MUTE_SWITCH = OBEY_MUTE_SWITCH;
/* 暴露音效音量表：测试要断言"BGM 音量低于所有音效"（BGM 一大打击感就糊） */
WechatAudio.GAIN = GAIN;
WechatAudio.MIN_GAP = MIN_GAP;

/* ==================== 可选升级：换 WebAudio 路线（根治） ====================
 * 小游戏从基础库 2.19.0 起支持 wx.createWebAudioContext()，官方音频指南也写明
 * 「WebAudio 播放性能好、能力丰富……建议短音频、播放频繁的音效使用」。
 * 换成它就没有实例池、没有 Android「同时最多播 10 个」的限制、命中音能真正叠放，
 * 是密集打击音效的正解（网页端已经是这个路子）。
 *
 * 没直接换的原因：官方同时给了几条注意事项，都得处理才算稳 ——
 *   1. 基础库 2.25.3 以上，createWebAudioContext() 之后要主动调用一次 ctx.resume()
 *   2. iOS 17.5+ 小游戏退后台后无法恢复播放，必须销毁后重新创建
 *   3. iOS 高性能模式不支持 useWebAudioImplement；低版本要留 InnerAudioContext 兜底
 *   4. 同一时间能解码/缓存的 buffer 更多，内存占用比播文件大（我们音效共 337KB，可忽略）
 * 等真机上确认现在这套（池子 + 自愈 + 中断重建）仍有丢音，再按上面几条迁过去。 */
