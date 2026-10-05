'use strict';
/*
 * 挥刀充能环（收刃期，脚下）的验收。
 *
 * 用户口径（六版，最后定了「只在收刃期、颜色 A」）：
 *   ① 「把饰品光环改造成收刃期」+「饰品的光环就不用了」+「涨满的时候闪」
 *   ② 「从 6 点开始吧」+「不要做的那么明显的转圈，做成之前那种饰品一样，有一个小点点在脚下转」
 *   ③ 「参考之前的饰品光环，那个做得很好，看起来也不明显，一条浅色透明的实圈，
 *       还有那个点点也是一个小小的」
 *   ④ 「不够明显，小点经过的圈可以直接变成小点的颜色吗?」→ 圈自己当进度条
 *   ⑤ 「小点扫过的实圈换一个不是很明显的颜色吧，现在这个纯白太白了，透明一点吧」→ alpha 0.55
 *   ⑥ 「转的时候这个圈不显示吧，只有收刃期间才进行转圈」
 *      ← 撤销中间那版"整圈 = 转动 + 收刃"；环**只在收刃期出现**，在收刃那 0.90s 里填满一圈。
 *
 * 背景：攻击是**自动循环**（转动 orbitSpin 2.20s 输出窗口 / 收刃 orbitRest 0.90s 空档）。
 * 环表达的是"还要等多久才再起转"：收刃期从 0 填到满，填满 = 起转挥刀 → 环整个消失。
 *
 * 这份文件盯十件事（都是"写歪了不报错、只是难看/骗人/对不上"的地方）：
 *   ① **时间准确性**：真实跑主循环量出来的转动/收刃时长必须和 config 对得上，
 *      而且环必须在收刃最后一帧接近填满（差一帧以内）—— 这是用户点名要核的
 *   ② 只在**收刃期**画；转动期（2.2s）脚下什么都不画（用户口径"转的时候不显示"）
 *   ③ 进度 = 1 - orbT/orbTotal；orbTotal 必须由**核心层**在换阶段时写（不写 → NaN）
 *   ④ 圈 = 淡底整圈 + 已扫过的一段：**同一条圈、同一个 lineWidth**，只换透明度
 *   ⑤ **不许加深色底衬**（"好丑"那版的根因）；已扫过的段**不许比底粗**
 *   ⑥ 已扫过的段要**半透明**（alpha < 1）—— 用户否过"纯白太白了"
 *   ⑦ 点要**小**（= config.dotR）、走在圈**外侧**；起点 6 点、角度 = 6 点 + 2π×进度
 *   ⑧ 填满那一下点闪一下（变大+变亮+光晕），闪完环消失（不能变成"一直亮"）
 *   ⑨ 渲染层只在 state==='play' 时画（否则暂停/升级面板后面会挂一圈冻住的环）
 *   ⑩ 防回归：饰品光环**已按用户要求删掉** —— 装了饰品也不许再画原来那圈 + 3 颗珠子
 */
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..');
const cfg = require(root + '/core/config'), Game = require(root + '/core/game');
const Renderer = require(root + '/render/renderer.js');
const deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) {
  deps[k] = require(root + '/core/' + f);
}
const DT = 1 / 60;

function make() {
  const g = new Game(cfg, deps);
  g.setViewport(812, 375);
  g.spawnFoe = function () {}; g.updateSpawns = function () {};
  g.world.rocks.length = 0; g.world.walls.length = 0;
  g.foes = [];
  return g;
}

/* ==================== ① 配置 ==================== */
const RING = cfg.feel && cfg.feel.attackRing;
assert(RING, 'cfg.feel.attackRing 必须存在（渲染层从这里读尺寸/透明度/闪光时长，不许在渲染层硬编码）');
assert(RING.rx > 17, '环要比影子(rx 17)大一档，否则绕到两侧时会蹭进影子里（实测 rx=' + RING.rx + '）');
assert(RING.dotR > 0 && RING.dotR <= 3, '点要**小**（旧饰品珠子 2.6），实测 ' + RING.dotR);
assert(RING.dotOut > 0, '点路径要比圈大一点（旧代码大 4px），点走在圈外侧不压线');
assert(RING.ringAlpha > 0 && RING.ringAlpha < 0.35, '未扫过的底要很淡，实测 ' + RING.ringAlpha);
assert(RING.sweepAlpha > 0 && RING.sweepAlpha < 1,
  '已扫过的那段要**半透明**（用户口径"现在这个纯白太白了，透明一点吧"），实测 ' + RING.sweepAlpha);
assert(RING.sweepAlpha > RING.ringAlpha, '已扫过的段要比底更亮，否则读不出进度');
assert(RING.flash > 0 && RING.flash <= 0.4, '闪光时长要在 0~0.4s 之间（太长会盖住起转本身的反馈）');

/* ==================== ② 核心层：换阶段写 orbTotal，起转点闪光 ==================== */
{
  const g = make(), P = g.player, op = g.orbitParams();
  assert.equal(P.orbTotal, 0, '开局还没进任何阶段（分母 0 → 渲染层不画）');
  assert.equal(P.orbChargeFlash, 0, '开局不该带着闪光');

  g.updateOrbit(DT);                          // 第一帧：orbT=0 → 起转
  assert(P.orbOn, '第一帧就应该起转（攻击是自动的，不用按键）');
  assert.equal(P.orbTotal, op.spin, '起转时 orbTotal 要写成**转动**时长');
  assert(P.orbChargeFlash > 0, '起转 = 收刃填满的那一下，必须点闪光（用户口径"涨满的时候闪"）');

  let guard = 0;
  while (P.orbOn && guard++ < 4000) g.updateOrbit(DT);
  assert(!P.orbOn, '转动时长走完要收刃');
  assert.equal(P.orbTotal, op.rest, '收刃时 orbTotal 要写成**收刃**时长（环的分母换成它）');
  assert.equal(P.orbChargeFlash, 0, '收刃阶段不该还在闪（闪光只属于起转后那一小段）');

  /* 收刃走完 → 又起转：闪光要**再点一次**（每圈都闪，不是只有第一次） */
  guard = 0;
  while (!P.orbOn && guard++ < 4000) g.updateOrbit(DT);
  assert(P.orbOn && P.orbChargeFlash > 0, '第二圈填满也要闪（不是"只闪一次就哑了"）');
  assert.equal(P.orbTotal, op.spin, '第二轮的 orbTotal 要回到转动时长');
}

/* ==================== ③ 时间实测（用户点名要核的） ==================== */
{
  const g = make(), P = g.player, op = g.orbitParams();

  /* (a) 真实跑主循环，量出每个阶段的时长 */
  let cur = P.orbOn ? 'spin' : 'rest', acc = 0;
  const spins = [], rests = [];
  for (let i = 0; i < Math.ceil(30 / DT); i++) {          // 跑 30 秒 ≈ 9~10 个周期
    g.updateOrbit(DT);
    const now = P.orbOn ? 'spin' : 'rest';
    acc += DT;
    if (now !== cur) { (cur === 'spin' ? spins : rests).push(acc); acc = 0; cur = now; }
  }
  assert(spins.length >= 3 && rests.length >= 3,
    '要跑出至少 3 个完整周期才能量时长，实测 转动段 ' + spins.length + ' / 收刃段 ' + rests.length);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mSpin = mean(spins.slice(1)), mRest = mean(rests.slice(1));   // 丢掉第一个可能不完整的
  assert(Math.abs(mSpin - op.spin) < DT * 1.5,
    '转动实测 ' + mSpin.toFixed(3) + 's 要和 config 的 ' + op.spin + 's 对得上（差 ≤ 一帧）');
  assert(Math.abs(mRest - op.rest) < DT * 1.5,
    '收刃实测 ' + mRest.toFixed(3) + 's 要和 config 的 ' + op.rest + 's 对得上（差 ≤ 一帧）—— '
    + '环就是在这段时间里填满的，对不上就是"环转满了但刀还没动"');
  const mCycle = mSpin + mRest;
  assert(Math.abs(mCycle - (op.spin + op.rest)) < DT * 2,
    '一整圈实测 ' + mCycle.toFixed(3) + 's 要 ≈ ' + (op.spin + op.rest).toFixed(2) + 's');

  /* (b) 环必须在收刃的**最后一帧**接近填满（差 ≤ 一帧），否则"填满了"是骗人的 */
  const g2 = make(), P2 = g2.player;
  g2.updateOrbit(DT);
  let guard = 0;
  while (P2.orbOn && guard++ < 4000) g2.updateOrbit(DT);       // 走到收刃
  assert(!P2.orbOn, '前置：应该已经进入收刃期');
  let maxProg = 0, lastProg = 0, mono = true, frames = 0;
  while (!P2.orbOn && guard++ < 8000) {
    const p = 1 - P2.orbT / P2.orbTotal;
    if (p < lastProg - 1e-9) mono = false;
    lastProg = p; if (p > maxProg) maxProg = p;
    frames++;
    g2.updateOrbit(DT);
  }
  assert(mono, '收刃期进度必须单调不减（中途掉回去 = 分母不对）');
  /* ⚠️ 帧数要用**这一把武器**的 op.rest 算，不能用 config.player.base.orbitRest（那是裸装基准）：
     武器自己在 orbit.rest 上还乘了倍率（长剑 0.55 / 双刀 0.30 / 大剑 1.70）。 */
  const wantFrames = op.rest / DT;
  assert(Math.abs(frames - wantFrames) <= 1.5,
    '收刃期帧数应 ≈ ' + wantFrames.toFixed(1) + ' 帧（op.rest=' + op.rest.toFixed(3) + 's），实测 ' + frames);
  assert(maxProg > 0.97,
    '收刃最后一帧进度要 >0.97（差一帧以内就填满），实测 ' + maxProg.toFixed(3)
    + ' —— 太小的话画面上是"还差一截，刀却已经转了"');

  /* (c) 每种武器都核一遍：环的时长 = **那种武器**的真实收刃时长（换武器环必须跟着变） */
  Object.keys(cfg.weapons).forEach(function (kind) {
    const gw = new Game(cfg, deps);
    gw.setViewport(812, 375);
    gw.spawnFoe = function () {}; gw.updateSpawns = function () {};
    const Pw = gw.player;
    Pw.equip.weapon = { id: 't-' + kind, slot: 'weapon', slotName: '武器', kind: kind,
                        name: cfg.weapons[kind].name, rarity: 1, rarityName: '普通', color: '#fff', affixes: [], score: 0 };
    gw.Prog.recompute(Pw, cfg);
    const opw = gw.orbitParams();
    let cur2 = 'rest', acc2 = 0; const rs = [];
    for (let i = 0; i < Math.ceil(20 / DT); i++) {
      gw.updateOrbit(DT);
      const now = Pw.orbOn ? 'spin' : 'rest';
      acc2 += DT;
      if (now !== cur2) { if (cur2 === 'rest') rs.push(acc2); acc2 = 0; cur2 = now; }
    }
    assert(rs.length >= 3, '武器「' + cfg.weapons[kind].name + '」没跑出足够的收刃段（实测 ' + rs.length + '）');
    const mRestW = mean(rs.slice(1));
    assert(Math.abs(mRestW - opw.rest) < DT * 1.5,
      '武器「' + cfg.weapons[kind].name + '」的收刃实测 ' + mRestW.toFixed(3) + 's 要和它的 op.rest '
      + opw.rest.toFixed(3) + 's 对上（环就是在这段时间里转满一圈，对不上＝环的时长和刀对不上）');
  });
}

/* 闪光计时接进主循环了吗（漏了 update() 里那一行 = 闪一次就永久亮着） */
{
  const g = make(), P = g.player;
  /* ⚠️ 必须摆在"正在转动"再点闪光：停在收刃末尾的话，update() 里第一件事就是起转，
     起转会把 orbChargeFlash 重新写成满值 —— 那样测出来的是"重置"不是"衰减"。 */
  g.state = 'play';
  P.orbOn = true; P.orbT = 1.0; P.orbTotal = 2.2;
  P.orbChargeFlash = RING.flash;
  g.update(DT, { moveX: 0, moveY: 0 });
  assert(P.orbChargeFlash < RING.flash, 'game.update() 必须扣闪光计时（不扣的话闪一次就永久亮着）');
}

/* ==================== ④ 渲染层：录制绘制调用 ==================== */
function fakeCtx() {
  const ops = [];
  const noop = function () {};
  const c = { canvas: { width: 812, height: 375 } };
  ['save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arcTo',
   'strokeRect', 'clearRect', 'clip', 'quadraticCurveTo', 'bezierCurveTo', 'setTransform', 'scale',
   'rotate', 'setLineDash', 'fillRect', 'fillText', 'strokeText', 'drawImage'].forEach((k) => { c[k] = noop; });
  c.arc = function (x, y, r) { ops.push({ op: 'arc', x: x, y: y, r: r, style: c.fillStyle, alpha: c.globalAlpha }); };
  c.ellipse = function (x, y, rx, ry, rot, a0, a1) {
    ops.push({ op: 'ellipse', x: x, y: y, rx: rx, ry: ry, a0: a0, a1: a1,
               style: c.strokeStyle, alpha: c.globalAlpha, width: c.lineWidth });
  };
  c.fill = function () { ops.push({ op: 'fill', style: c.fillStyle, alpha: c.globalAlpha }); };
  c.stroke = function () { ops.push({ op: 'stroke', style: c.strokeStyle, width: c.lineWidth, alpha: c.globalAlpha }); };
  c.measureText = function () { return { width: 10 }; };
  const grad = { addColorStop: noop };
  c.createLinearGradient = function () { return grad; };
  c.createRadialGradient = function () { return grad; };
  return { ctx: c, ops: ops };
}

/** 画一帧 drawPlayer（frameState 不传 = 模拟被测试/工具直接调用的情形，应当照画） */
function drawPlayerWith(setup, frameState) {
  const g = make(), P = g.player;
  if (setup) setup(g, P);
  const f = fakeCtx();
  const r = new Renderer(f.ctx, { cfg: cfg, createCanvas: function () { return null; } });
  r.resize(812, 375); r.lastT = 1;
  if (frameState !== undefined) r.frameState = frameState;
  r.drawPlayer(P, 1.0);
  return { ops: f.ops, P: P };
}
const near = (a, b) => Math.abs(a - b) < 0.6;
const RY = RING.ry === undefined ? 0.4 : RING.ry;
const DOUT = RING.dotOut === undefined ? 4 : RING.dotOut;
const REST = cfg.player.base.orbitRest;

/** 摆一个"收刃期走了 frac"的局面（环只在收刃期画，所以分母固定是收刃时长） */
function restAt(P, frac, total) {
  P.orbOn = false;
  P.orbTotal = total === undefined ? REST : total;
  P.orbT = P.orbTotal * (1 - Math.max(0, Math.min(1, frac)));
  P.orbChargeFlash = 0;
}
/** 环那一整圈（脚下，rx = RING.rx） */
const ringEllipseAt = (r) => r.ops.filter((o) => o.op === 'ellipse' && near(o.y, r.P.y + 2) && near(o.rx, RING.rx));
const sweepOf = (r) => ringEllipseAt(r).filter((e) => near(e.a0, Math.PI * 0.5))[0];
const baseOf = (r) => ringEllipseAt(r).filter((e) => e.a0 === 0 && e.a1 - e.a0 >= 6.2831)[0];
/** 小点：r = RING.dotR **且**用 config 的颜色那一笔
    （⚠️ 角色美术里也有 r≈2.6 的小圆 —— 只按半径找会混进来，这是实测踩到的） */
const dotAt_ = (r) => r.ops.filter((o) => o.op === 'arc' && near(o.r, RING.dotR) && o.style === RING.color);
/** 点的理论位置：6 点（canvas +90°）出发，顺时针走 2π×frac，走在圈**外侧** */
function dotPos(P, frac) {
  const ax = RING.rx + DOUT, ay = RING.rx * RY + DOUT * RY;
  const A = Math.PI * 0.5 + 6.2832 * frac;
  return { x: P.x + Math.cos(A) * ax, y: P.y + 2 + Math.sin(A) * ay };
}
const TRINKET = { id: 't1', slot: 'trinket', kind: 'trinket', name: '护符', rarity: 4, rarityName: '史诗', color: '#c07ae0', affixes: [] };

/* ② 转动期：圈和点都不画（用户口径"转的时候这个圈不显示"） */
{
  const r0 = drawPlayerWith((g, P) => {
    P.orbOn = true; P.orbTotal = cfg.player.base.orbitSpin; P.orbT = 1.1; P.orbChargeFlash = 0;
  });
  assert.equal(ringEllipseAt(r0).length, 0, '转动期不许画环（"转的时候这个圈不显示吧"）');
  assert.equal(dotAt_(r0).length, 0, '转动期不许画点');
}

/* ④ 圈 = 淡底整圈 + 已扫过的一段（同一条圈、同线宽，只换透明度） */
{
  const r0 = drawPlayerWith((g, P) => restAt(P, 0.4));
  const es = ringEllipseAt(r0);
  assert.equal(es.length, 2, '收刃期脚下要有 2 笔：淡底(整圈) + 已扫过的一段，实测 ' + es.length);
  const base = baseOf(r0), sweep = sweepOf(r0);
  assert(base, '要有整圈的淡底（从 0 画满 2π）');
  assert(sweep, '要有"已扫过的那一段"（从 6 点起）');

  assert.equal(base.style, RING.color, '颜色要从 config.feel.attackRing.color 来');
  assert(Math.abs(base.alpha - RING.ringAlpha) < 1e-9, '淡底的 alpha 要 = config.ringAlpha，实测 ' + base.alpha);
  assert(near(base.ry, RING.rx * RY), '环必须是**扁椭圆**（ry = rx×' + RY + '），实测 ry=' + base.ry.toFixed(2));

  assert.equal(sweep.style, RING.color, '已扫过的段要和小点同色');
  assert(Math.abs(sweep.alpha - RING.sweepAlpha) < 1e-9, '已扫过的段要 = config.sweepAlpha，实测 ' + sweep.alpha);
  assert(near(sweep.rx, base.rx) && near(sweep.ry, base.ry), '已扫过的段必须走**同一条圈**（rx/ry 和底一样）');
  assert.equal(sweep.width, base.width,
    '已扫过的段**不许比底圈粗**（' + sweep.width + ' vs ' + base.width + '）—— 变粗就又是"明显的转圈"了');
  const stroked = r0.ops.filter((o) => o.op === 'stroke' && o.style === RING.color);
  assert(stroked.length >= 2, '底和已扫过的段都必须是 stroke（描边），实测 ' + stroked.length + ' 笔');
}

/* ③ 已扫过的段长度 = 收刃进度 */
{
  [[0.25, 0.25], [0.75, 0.75], [1, 1]].forEach(function (c) {
    const r0 = drawPlayerWith((g, P) => restAt(P, c[0]));
    const sweep = sweepOf(r0);
    assert(sweep, '进度 ' + c[0] + ' 时要有已扫过的段');
    const span = sweep.a1 - sweep.a0;
    assert(Math.abs(span - 6.2832 * c[1]) < 0.03, '已扫过的段要占 ' + c[1] + ' 圈（span ' + span.toFixed(3) + '）');
  });
  /* 刚开始（进度≈0）不画那 0.004 圈以内的一小截，免得起点冒一个小疙瘩 */
  const r0 = drawPlayerWith((g, P) => restAt(P, 0));
  assert.equal(ringEllipseAt(r0).filter((e) => near(e.a0, Math.PI * 0.5)).length, 0,
    '进度 0 时不画已扫过的段（否则圆点起点处会有一个小疙瘩）');
}

/* ⑦ 起点 6 点 + 角度随进度：0.25→9 点、0.5→12 点、0.75→3 点 */
{
  [[0, '6 点（正下方）'], [0.25, '9 点（左）'], [0.5, '12 点（上）'], [0.75, '3 点（右）']].forEach(function (c) {
    const r0 = drawPlayerWith((g, P) => restAt(P, c[0]));
    const d = dotAt_(r0);
    assert.equal(d.length, 1, '进度 ' + c[0] + ' 时要正好 1 个小点，实测 ' + d.length);
    const want = dotPos(r0.P, c[0]);
    assert(near(d[0].x, want.x) && near(d[0].y, want.y),
      '进度 ' + c[0] + ' 的点要在 ' + c[1] + ' (' + want.x.toFixed(1) + ',' + want.y.toFixed(1) + ')，实测 ('
      + d[0].x.toFixed(1) + ',' + d[0].y.toFixed(1) + ')');
    assert.equal(d[0].style, RING.color, '点要和圈同色（config.color）');
    assert(Math.abs(d[0].alpha - RING.dotAlpha) < 1e-9, '点的 alpha 要 = config.dotAlpha');
  });
  const r6 = drawPlayerWith((g, P) => restAt(P, 0));
  assert(dotAt_(r6)[0].y > r6.P.y, '6 点必须在脚下（y > P.y）—— 就是"从 6 点开始"这条口径');
}

/* ⑦ 点要小，而且走在圈外侧（不压线） */
{
  const r0 = drawPlayerWith((g, P) => restAt(P, 0.25));       // 9 点：点在圈的最左侧
  const d = dotAt_(r0)[0], P = r0.P;
  assert(Math.abs(d.x - (P.x - (RING.rx + DOUT))) < 0.6,
    '9 点时点要在圈的**外侧**（x ≈ P.x-' + (RING.rx + DOUT) + '），实测 ' + d.x.toFixed(1));
}

/* ⑤ **不许加深色底衬**（"好丑"那版的根因：圈/点外圈套一层深色） */
{
  const r0 = drawPlayerWith((g, P) => restAt(P, 0.4));
  const dark = r0.ops.filter((o) => (o.op === 'arc' || o.op === 'ellipse' || o.op === 'fill')
    && String(o.style).indexOf('rgba(8,12,16') === 0);
  assert.equal(dark.length, 0,
    '圈/点不许加深色底衬（用户口径："你参考之前的饰品光环…我这个好丑"）—— 实测 ' + dark.length + ' 笔深色');
}

/* ⑧ 填满那一下点要闪（变大 + 变亮 + 光晕）；闪完环整个消失（起转开始） */
{
  const at = (flash) => drawPlayerWith((g, P) => { restAt(P, 1); P.orbChargeFlash = flash; });
  const f1 = at(RING.flash);
  const big = f1.ops.filter((o) => o.op === 'arc' && o.style === RING.color && o.r >= RING.dotR - 1e-9);
  assert.equal(big.length, 2, '闪光要两层（光晕 + 亮核），实测 ' + big.length);
  assert(Math.max(big[0].r, big[1].r) > RING.dotR + 0.5, '要有明显比点大的那层（光晕）');
  const want = dotPos(f1.P, 1);                 // 填满 = 点回到出发点（6 点）
  assert(near(big[0].x, want.x) && near(big[0].y, want.y), '闪在出发点（6 点）');

  const f2 = at(RING.flash * 0.5);
  const big2 = f2.ops.filter((o) => o.op === 'arc' && o.style === RING.color && o.r >= RING.dotR - 1e-9);
  assert(Math.max.apply(null, big2.map((o) => o.r)) > Math.max.apply(null, big.map((o) => o.r)),
    '闪光中途要更大（"炸开"的过程感）');

  /* 闪完（起转开始）：环和点都彻底消失 */
  const after = drawPlayerWith((g, P) => {
    P.orbOn = true; P.orbTotal = cfg.player.base.orbitSpin; P.orbT = cfg.player.base.orbitSpin;
    P.orbChargeFlash = 0;
  });
  assert.equal(ringEllipseAt(after).length, 0, '起转后环要整个消失（"转的时候不显示"）');
  assert.equal(dotAt_(after).length, 0, '起转后点要整个消失');
}

/* ③ 没有分母（orbTotal = 0）时不画 */
{
  const r0 = drawPlayerWith((g, P) => { P.orbOn = false; P.orbTotal = 0; P.orbT = 0; });
  assert.equal(ringEllipseAt(r0).length, 0, 'orbTotal=0 时不许画环（分母 0 = NaN）');
  assert.equal(dotAt_(r0).length, 0, 'orbTotal=0 时不许画点');
}

/* ⑨ 只在 state==='play' 时画（不然暂停/升级面板后面会挂一圈冻住的环） */
{
  const setup = (g, P) => restAt(P, 0.4);
  assert.equal(ringEllipseAt(drawPlayerWith(setup, 'play')).length, 2, 'state=play 要画');
  ['paused', 'levelup', 'dead', 'bag', 'clear', 'title'].forEach(function (st) {
    const r0 = drawPlayerWith(setup, st);
    assert.equal(ringEllipseAt(r0).length, 0, 'state=' + st + ' 不该画环（会挂一圈冻住的环在面板后面）');
    assert.equal(dotAt_(r0).length, 0, 'state=' + st + ' 不该画点');
  });
  /* frameState 为空 = 渲染器被测试/工具直接调 drawPlayer，应当照画 */
  assert.equal(ringEllipseAt(drawPlayerWith(setup)).length, 2, 'frameState 为空时要照画（测试/工具直接用）');
}

/* ⑥ 图层：圈和点都必须在**影子之前**（= 角色下层），否则压在腿上 */
{
  const r0 = drawPlayerWith((g, P) => restAt(P, 0.3));
  const dotIdx = r0.ops.findIndex((o) => o.op === 'arc' && near(o.r, RING.dotR) && o.style === RING.color);
  const ringIdx = r0.ops.findIndex((o) => o.op === 'ellipse' && near(o.rx, RING.rx));
  const shadowIdx = r0.ops.findIndex((o) => o.op === 'ellipse' && near(o.y, r0.P.y + 3));   // 影子固定 P.y+3
  assert(ringIdx >= 0 && dotIdx >= 0, '这一格没画圈/点');
  assert(shadowIdx >= 0, '没找到影子那一笔（找不到就说明影子的位置改了，这条断言的依据要跟着改）');
  assert(ringIdx < shadowIdx && dotIdx < shadowIdx,
    '圈/点必须先画（= 画在影子/角色下层），实测 圈@' + ringIdx + ' 点@' + dotIdx + ' 影子@' + shadowIdx);
  assert(ringIdx < dotIdx, '圈先画、点后画');
}

/* ⑩ 防回归：饰品光环已删 —— 装了饰品不许再画那一圈 + 3 颗珠子 */
{
  const plain = drawPlayerWith((g, P) => restAt(P, 0.3));
  const withTrinket = drawPlayerWith((g, P) => { P.equip.trinket = TRINKET; restAt(P, 0.3); });
  const usedTrinketColor = withTrinket.ops.some((o) => (o.op === 'stroke' || o.op === 'fill' || o.op === 'arc') && o.style === TRINKET.color);
  assert.equal(usedTrinketColor, false, '饰品光环已经删掉了（用户口径"饰品的光环就不用了"），不许再画饰品稀有度色那一圈/珠子');
  assert.equal(dotAt_(withTrinket).length, dotAt_(plain).length, '装了饰品不该多出/少掉点');
  assert.equal(ringEllipseAt(withTrinket).length, ringEllipseAt(plain).length, '装了饰品不该多出/少掉圈');
}

/* 报告里用的实测时长：取**开局这把长剑**的真实值（不是裸装基准 —— 武器自己还乘了倍率） */
const DEF = (function () { const g = make(); return g.orbitParams(); })();

console.log('PASS: 挥刀充能环（收刃期，脚下）—— 只在收刃期出现、转动期不画 / '
  + '淡底整圈(alpha ' + RING.ringAlpha + ') + 已扫过的一段(alpha ' + RING.sweepAlpha + '，同圈同线宽只换透明度) / '
  + '进度 = 1-orbT/orbTotal，起点 6 点 / 点 r=' + RING.dotR + ' 走在圈外侧 / 填满点闪一下、起转后整个消失 / '
  + '时间实测（开局长剑）：转动 ' + DEF.spin.toFixed(2) + 's、收刃 ' + DEF.rest.toFixed(2) + 's、一圈 '
  + (DEF.spin + DEF.rest).toFixed(2) + 's，和 op 一致且最后一帧填满；5 把武器各核一遍 / '
  + '不许深色底衬、不许比底粗 / 只在 state=play 画 / 饰品光环已删');
