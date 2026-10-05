'use strict';
/*
 * 低血警报的验收（2026-10 用户口径：血条/经验条从角色头顶挪到左上角卡之后，
 * "低血看不见"必须补回来 —— 用户挑的方案是 1+2+4）：
 *   1. 屏幕四边泛红**分档**（轻档 ≤30% / 重档 ≤15%），比原来那一档明显得多
 *   2. 角色身上的**红色心跳脉冲**（描身体剪影；另有"脚下红圈"备选样式，出图对比用）
 *   4. 真机**震动 + 心跳音**（lowhp.wav）
 *
 * 这份文件盯的是三层里最容易假的那几处：
 *   · 核心层只该在**跨进档位**和**每隔 repeat 秒**发事件 —— 写成"每帧都发"会在真机上
 *     变成连续震动 + 音效一直响（断言必须覆盖"档内不许连发"）
 *   · 滞回：0.30 上下抖一下不许连发（单阈值就会连发）
 *   · 音效接线的老坑（audio.js 里专门写过）：**事件名映射对了、但 .wav 没打进包**
 *     → 静默无声，而"断言事件名"是绿的。所以这里同时校验文件真的在磁盘上。
 *   · 渲染层和核心层不许各写一个阈值：两边都读 cfg.feel.lowHp
 */
const assert = require('assert'), path = require('path'), fs = require('fs');
const root = path.resolve(__dirname, '..');
const cfg = require(root + '/core/config'), Game = require(root + '/core/game');
const Renderer = require(root + '/render/renderer.js'), WechatAudio = require(root + '/platform/wechat/audio.js');
const deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) {
  deps[k] = require(root + '/core/' + f);
}

function make() {
  const g = new Game(cfg, deps);
  g.setViewport(812, 375);
  g.spawnFoe = function () {}; g.updateSpawns = function () {}; g.updateSpawnsTraining = function () {};
  return g;
}
const lows = (events) => events.filter((e) => e.type === 'lowHp');

/* ==================== ① 配置：阈值一处定义 ==================== */
const LH = cfg.feel && cfg.feel.lowHp;
assert(LH, 'cfg.feel.lowHp 必须存在（渲染层和核心层都从这里读，不许各写一个数）');
assert(LH.heavy < LH.ratio, '重档(' + LH.heavy + ') 必须比进档(' + LH.ratio + ') 更低');
assert(LH.release > LH.ratio, '重新武装的阈值(' + LH.release + ') 必须高于进档(' + LH.ratio + ') —— 这就是滞回');
assert(LH.repeat > 1 && LH.repeat < 10, '重复间隔要在 1~10 秒之间（太短=烦，太长=没提醒作用）');

/* ==================== ② 核心层状态机 ==================== */
{
  const g = make(), P = g.player, max = P.stats.maxhp;
  assert.equal(g.lowHpAlarm, false, '开局不该已经在警报状态');
  g.drainEvents();

  /* 满血：一直不响 */
  for (let i = 0; i < 120; i++) g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 0, '满血时不许响');

  /* 掉进低血档：立刻响一次 */
  P.hp = max * 0.25;
  g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 1, '进低血档要立刻响一次（不然等 3 秒才提醒就晚了）');

  /* 档内：repeat 秒之内不许再响（这是"一直响"最容易写出来的地方） */
  for (let i = 0; i < Math.floor(LH.repeat * 60) - 3; i++) g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 0, 'repeat 秒之内不许重复（重复=真机上连续震动）');

  /* 过了 repeat：再提醒一次（心跳感） */
  for (let i = 0; i < 10; i++) g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 1, '过了 repeat 秒要再提醒一次');

  /* 加血加回 release 之上：静默 + 重新武装 */
  P.hp = max * 0.5;
  g.updateLowHp(1 / 60);
  assert.equal(g.lowHpAlarm, false, '回到 release 之上要重新武装');
  assert.equal(lows(g.drainEvents()).length, 0, '血够的时候不许响');

  /* 重新武装后：再掉进去要再响（不是"响过一次就永久哑了"） */
  P.hp = max * 0.2;
  g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 1, '重新武装后掉回低血档要再响一次');

  /* 滞回：卡在进档阈值上下抖 不许连发（单阈值写法这里会连发） */
  g.drainEvents();
  P.hp = max * 0.31; g.updateLowHp(1 / 60);
  P.hp = max * 0.29; g.updateLowHp(1 / 60);
  P.hp = max * 0.31; g.updateLowHp(1 / 60);
  P.hp = max * 0.29; g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 0, '在进档线上下抖动不许连发（滞回没生效）');

  /* 选卡 / 暂停：不响 */
  g.state = 'levelup'; g.drainEvents();
  P.hp = max * 0.1;
  for (let i = 0; i < 300; i++) g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 0, '升级选卡暂停时不许响（正在看卡却一直咚）');
  g.state = 'play';

  /* 倒地：不响（倒在结算页还在"咚"很怪） */
  P.dead = true; g.state = 'dead'; g.drainEvents();
  for (let i = 0; i < 300; i++) g.updateLowHp(1 / 60);
  assert.equal(lows(g.drainEvents()).length, 0, '倒地后不许响');
}

/* 接进主循环没有（漏了 update() 里那一行 = 整个机制等于不存在） */
{
  const g = make();
  g.player.hp = g.player.stats.maxhp * 0.1;
  g.drainEvents();
  g.update(1 / 60, { moveX: 0, moveY: 0 });
  assert(lows(g.drainEvents()).length === 1, 'game.update() 必须把它接上');
}

/* 死亡重开 / 换场景 / 复活：警报状态要清掉（残留会让重开第一帧就响） */
{
  const g = make();
  g.player.hp = 1; g.updateLowHp(1 / 60);
  assert(g.lowHpAlarm, '前置：应该已经在警报状态');
  g.reset();
  assert.equal(g.lowHpAlarm, false, 'reset 要把警报状态清掉');
  assert.equal(g.lowHpTimer, 0);
}

/* ==================== ③ 渲染层：角色脉冲 + 四边泛红分档 ==================== */
function fakeCtx() {
  const rec = { fills: [], strokes: [], texts: [], ellipses: 0 };
  const noop = function () {};
  const c = { canvas: { width: 812, height: 375 } };
  ['save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo', 'closePath',
   'arc', 'arcTo', 'fill', 'strokeRect', 'clearRect', 'clip', 'quadraticCurveTo',
   'bezierCurveTo', 'setTransform', 'scale', 'rotate', 'setLineDash'].forEach((k) => { c[k] = noop; });
  c.fillRect = function (x, y, w, h) { rec.fills.push({ x: x, y: y, w: w, h: h, c: c.fillStyle }); };
  c.stroke = function () { rec.strokes.push(c.strokeStyle); };
  c.ellipse = function () { rec.ellipses++; };
  c.fillText = function (s, x, y) { rec.texts.push({ s: String(s), x: x, y: y }); };
  c.strokeText = noop;
  c.measureText = function () { return { width: 10 }; };
  const grad = { addColorStop: noop };
  c.createLinearGradient = function () { return grad; };
  c.createRadialGradient = function () { return grad; };
  return { ctx: c, rec: rec };
}
const RED = '#ff4b3a';                       // 低血角色信号的专用色（renderer 里就这一处用）
function playerStrokes(hpFrac, style) {
  const g = make(), P = g.player;
  P.hp = P.stats.maxhp * hpFrac;
  const f = fakeCtx();
  const r = new Renderer(f.ctx, { cfg: cfg, createCanvas: function () { return null; }, lowHpStyle: style });
  r.resize(812, 375); r.lastT = 1;
  r.drawPlayer(P, 1.0);
  return f.rec.strokes.filter((c) => c === RED).length;
}
assert.equal(playerStrokes(0.8), 0, '血够的时候不许在角色身上挂红色信号');
assert.equal(playerStrokes(0.15), 2, '低血要描两遍剪影（宽柔光 + 细亮边），实测 ' + playerStrokes(0.15));
assert.equal(playerStrokes(0.32), 0, '刚过进档线（32%）就不该画');
assert.equal(playerStrokes(0.15, 'ring'), 1, 'ring 备选样式只画一个圈（1 笔）');
assert.equal(playerStrokes(0.8, 'ring'), 0, 'ring 样式同样只在低血时出现');

const VIGNETTE = 'rgba(198,28,22,';
const redFills = (rec) => rec.fills.filter((x) => String(x.c).indexOf(VIGNETTE) === 0);
const alphaOf = (x) => parseFloat(String(x.c).split(',')[3]);
function hudRed(hpFrac, opts) {
  const g = make();
  if (opts && opts.training) g.setTraining(true);
  g.player.hp = g.player.stats.maxhp * hpFrac;
  const f = fakeCtx();
  const r = new Renderer(f.ctx, { cfg: cfg, createCanvas: function () { return null; } });
  r.resize(812, 375); r.lastT = 0.1848;      // 让红边的脉冲取到接近最大值（sin=1），读数才可比
  r.drawHud(g, g.player);
  return redFills(f.rec);
}
assert.equal(hudRed(0.5).length, 0, '血够的时候屏幕四边不许泛红');
const light = hudRed(LH.ratio - 0.02);
assert.equal(light.length, 12, '轻档 3 圈 × 4 条边 = 12 条，实测 ' + light.length);
const heavy = hudRed(LH.heavy - 0.02);
assert.equal(heavy.length, 16, '重档 4 圈 × 4 条边 = 16 条，实测 ' + heavy.length);
assert(Math.max.apply(null, light.map(alphaOf)) <= 0.16, '轻档要淡（≤0.16，就是个淡淡的边）');
assert(Math.max.apply(null, heavy.map(alphaOf)) >= 0.25, '重档要明显（≥0.25）—— 这是"角落血条看不见"的兜底');
assert.equal(hudRed(0.1, { training: true }).length, 0, '试炼场不放四边泛红（满屏红边会干扰看机制）');

/* ==================== ④ 平台层：震动 + 心跳音 ==================== */
assert.equal(WechatAudio.EVENT_SOUND.lowHp, 'lowhp', 'lowHp 事件要映射到 lowhp 这个音');
const wav = path.join(root, 'assets', 'audio', 'lowhp.wav');
assert(fs.existsSync(wav), 'assets/audio/lowhp.wav 不在包里 —— 事件名对了、文件没有 = 静默无声（这个坑踩过一次）');
const kb = fs.statSync(wav).size / 1024;
assert(kb > 5 && kb < 80, '心跳音体积 ' + kb.toFixed(1) + 'KB 不合理（空文件 / 大得离谱）');
assert(WechatAudio.GAIN.lowHp < WechatAudio.GAIN.hurt,
  '低血心跳(' + WechatAudio.GAIN.lowHp + ') 要比 hurt(' + WechatAudio.GAIN.hurt + ') 轻 —— 它每隔几秒响一次，不能比挨打还响');

function fakeWx() {
  const w = { instances: [], vibes: [], opts: [] };
  w.createInnerAudioContext = function () {
    const a = {
      src: '', loop: false, volume: 1, plays: 0, _on: {},
      play() { this.plays++; }, stop() {}, pause() {}, destroy() {},
      onPlay(f) { this._on.play = f; }, onEnded(f) { this._on.ended = f; }, onError(f) { this._on.error = f; }
    };
    w.instances.push(a);
    return a;
  };
  w.setInnerAudioOption = function (o) { w.opts.push(o); };
  w.vibrateShort = function (o) { w.vibes.push(o && o.type); };
  ['onAudioInterruptionBegin', 'onAudioInterruptionEnd', 'onHide', 'onShow'].forEach((k) => { w[k] = function () {}; });
  return w;
}
{
  const wx = fakeWx();
  const au = new WechatAudio(wx, 'assets/audio/', { bgm: cfg.audio.bgm });
  au.handle([{ type: 'lowHp' }]);
  assert.equal(wx.vibes[wx.vibes.length - 1], 'medium', '低血要 medium 震（light 在手机上基本感觉不到）');
  assert(wx.instances.some((a) => a.src.indexOf('lowhp') >= 0),
    'lowHp 事件要真的去播 lowhp.wav（src 里没有它就是接线断了）');

  /* 设置里关掉震动：声音照旧（别把声音一起关掉） */
  const wx2 = fakeWx();
  const au2 = new WechatAudio(wx2, 'assets/audio/', { bgm: cfg.audio.bgm });
  au2.setVibrate(false);
  au2.handle([{ type: 'lowHp' }]);
  assert.equal(wx2.vibes.length, 0, '关掉震动后不许再震');
  assert(wx2.instances.some((a) => a.src.indexOf('lowhp') >= 0), '关震动不该把声音也关掉');

  /* 原来的行为别改坏：受伤还是轻震 */
  const wx3 = fakeWx();
  const au3 = new WechatAudio(wx3, 'assets/audio/', { bgm: cfg.audio.bgm });
  au3.handle([{ type: 'hurt' }]);
  assert.equal(wx3.vibes[0], 'light', '受伤仍然是 light（这次改动只是多了一档，不是把所有震动加重）');
}

console.log('PASS: 低血警报 = 三层接线（核心只在该响时发 lowHp 事件：进档一次 + 每 ' + LH.repeat + 's 一次 + 滞回不连发 + 选卡/倒地不响）'
  + ' · 渲染（角色红色心跳脉冲描剪影 / 另有 ring 备选；四边泛红轻档 ≤' + LH.ratio + ' 三圈、重档 ≤' + LH.heavy + ' 四圈更明显、试炼场不放）'
  + ' · 平台（medium 震动 + lowhp.wav 真在包里、音量比 hurt 轻、关震动不影响声音）');
