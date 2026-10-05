#!/usr/bin/env node
/**
 * 叠刃（长剑 · 熟练度 Lv3 解锁的机制卡）验收。
 * 口径见 config.bladeUnity；这里守它的**结论**：
 *
 *   ① 每次**起转**刃数 +1（不是"下次起转才生效"—— 卡本身是起转时才生效的）
 *   ② 上限 12 把（**总刃数**，含旋刃卡给的那些）；到顶之后不再涨
 *   ③ 代价：收刃时长 +5%/把，封顶 ×1.55（到顶之后**代价也跟着停**，否则会出现
 *      "刃数不涨了却越转越慢"）
 *   ④ 加出来的刃数走**普通刃数**那条归一化（每把刃总伤害 +15%，线性）——
 *      这就是"进普通桶而不是 burst 桶"的判据：走错桶的话总伤害会超线性涨
 *   ⑤ 不碰转速（转速一变"一次攻击转一圈"就不成立）
 *   ⑥ 进 run 存档：退出→继续上次，刃数不清零
 *   ⑦ 没有这张卡的时候一点都不涨
 *
 * 用法：node tools/verify-blade-unity.js
 */
'use strict';
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);
const Prog = deps.Progression, U = cfg.bladeUnity;

function make() { const g = new Game(cfg, deps); g.setViewport(812, 375); return g; }
/** 触发一次"起转"（updateOrbit 的 else if (orbT<=0) 那条分支） */
function spin(g) { g.player.orbOn = false; g.player.orbT = 0; g.updateOrbit(0.016); }
/** 把这张卡发给玩家（走和抽卡同一条 apply 路径） */
function grantCard(g) { assert(Prog.applyUpgrade(cfg, g.player, 'bladeUnity'), '卡要能发到手上'); }

/* ==================== ⑦ 没这张卡：一点都不涨 ==================== */
{
  const g = make();
  assert.equal(g.player.bladeUnityStacks, 0, '开局 0 把额外刃');
  for (let i = 0; i < 20; i++) spin(g);
  assert.equal(g.player.bladeUnityStacks, 0, '没有叠刃的时候不涨');
  assert.equal(g.orbitParams().blades, 1, '长剑还是 1 把刃');
}

/* ==================== ① 一转 +1 ==================== */
{
  const g = make(); grantCard(g);
  assert(g.player.stats.bladeUnity, '卡生效之后 stats 上要有这个开关（orbitParams 靠它判断）');
  const base0 = g.orbitParams();
  spin(g);
  assert.equal(g.player.bladeUnityStacks, 1, '**第一次起转就 +1**（不等下一轮）');
  assert.equal(g.orbitParams().blades, 2, '画面上的刃数也跟着是 2');
  for (let i = 0; i < 4; i++) spin(g);
  assert.equal(g.player.bladeUnityStacks, 5);
  assert.equal(g.orbitParams().blades, 6);
  assert(base0.blades === 1);   // 对照：没涨之前是 1
}

/* ==================== ② 上限 12（总刃数） ==================== */
{
  const g = make(); grantCard(g);
  for (let i = 0; i < 40; i++) spin(g);
  assert.equal(g.player.bladeUnityStacks, U.bladesMax - 1, '自增上限 = bladesMax-1（12-1）');
  assert.equal(g.orbitParams().blades, U.bladesMax, '总刃数封顶在 12');
  /* 旋刃卡叠上来时，12 是**总数**的上限（不然"旋刃卡 + 叠刃"能冲破上限） */
  const g2 = make(); grantCard(g2);
  Prog.applyUpgrade(cfg, g2.player, 'blades');     // 旋刃卡 +1
  Prog.applyUpgrade(cfg, g2.player, 'blades');
  for (let i = 0; i < 40; i++) spin(g2);
  assert.equal(g2.orbitParams().blades, U.bladesMax, '旋刃卡 + 叠刃 一起也不能超过 12');
}

/* ==================== ③ 代价：收刃 +5%/把，封顶 ×1.55 ==================== */
{
  const g = make(); grantCard(g);
  const rest0 = g.orbitParams().rest;
  const r = [];
  for (let i = 0; i < 11; i++) { spin(g); r.push(g.orbitParams().rest / rest0); }
  for (let i = 0; i < r.length; i++) {
    assert(Math.abs(r[i] - (1 + U.restPer * (i + 1))) < 1e-9,
      '第 ' + (i + 1) + ' 把刃的收刃倍率应该是 ×' + (1 + U.restPer * (i + 1)) + '（实测 ×' + r[i].toFixed(4) + '）');
  }
  assert(Math.abs(r[10] - U.restMax) < 1e-9, '到 11 把时正好顶到封顶 ×1.55');
  /* 到顶之后再转：刃数不涨、代价也不涨（"刃数停涨却越转越慢"是 bug） */
  const restFull = g.orbitParams().rest;
  for (let i = 0; i < 10; i++) spin(g);
  assert.equal(g.orbitParams().rest, restFull, '到顶之后代价也要停住');
  /* 脏数据保护：手改一个超大的 stacks，倍率也不许超过封顶 */
  g.player.bladeUnityStacks = 99;
  assert(Math.abs(g.orbitParams().rest / rest0 - U.restMax) < 1e-9, '代价封顶 ×1.55 兜住');
  g.player.bladeUnityStacks = U.bladesMax - 1;
}

/* ==================== ④ 伤害走普通桶（每把 +15%，线性） ==================== */
{
  const g0 = make(); grantCard(g0);
  const p0 = g0.orbitParams();
  const total0 = p0.blades * p0.dmg;
  const ratios = [];
  for (let n = 1; n <= 11; n++) {
    const g = make(); grantCard(g);
    for (let i = 0; i < n; i++) spin(g);
    const p = g.orbitParams();
    const ratio = (p.blades * p.dmg) / total0;
    ratios.push(ratio);
    assert(Math.abs(ratio - (1 + 0.15 * n)) < 1e-9,
      n + ' 把额外刃时总伤害应该是裸装的 ×' + (1 + 0.15 * n) + '（实测 ×' + ratio.toFixed(4) + '）');
  }
  /* 线性而不是指数：走 burst 桶的话这里会明显超出（同一个坑千刃踩过） */
  assert(ratios[10] < 1 + 0.15 * 11 + 1e-9, '总伤害必须是线性 +15%/把，不是乘法爆炸');
  assert.equal(p0.blades, 1, '对照：没额外刃时就是 1 把');
}

/* ==================== ⑤ 不碰转速（"一次攻击转一圈"不破） ==================== */
{
  const g0 = make(); grantCard(g0);
  const sp0 = g0.orbitParams().spin, rest0 = g0.orbitParams().rest;
  const g = make(); grantCard(g);
  for (let i = 0; i < 11; i++) spin(g);
  assert.equal(g.orbitParams().spin, sp0, '转动时长/转速不受叠刃影响（参数写"一次攻击转一圈"）');
  assert(g.orbitParams().rest > rest0, '代价加在收刃上（循环变长，但圈数还是 1）');
  assert(Math.abs(g.orbitParams().rest / rest0 - U.restMax) < 1e-9, '到顶正好 ×1.55');
}

/* ==================== ⑥ 千刃交互：窗口内取 max，不会把刃数打回去 ==================== */
{
  const g = make(); grantCard(g);
  for (let i = 0; i < 11; i++) spin(g);
  g.player.burst = { id: 'bladeStorm', name: '千刃', left: 1, active: true, bladesSet: 6, healed: 0 };
  assert.equal(g.orbitParams().blades, U.bladesMax, '12 把 + 千刃(6把) 取 max → 还是 12，不会变少');
}

/* ==================== ⑦ 进 run 存档 ==================== */
{
  const g = make(); grantCard(g);
  for (let i = 0; i < 5; i++) spin(g);
  const snap = JSON.parse(JSON.stringify(deps.Save.snapshot(g, true)));
  assert.equal(snap.run.bladeUnityStacks, 5, 'run 块里要存刃数（不然退出继续就清零）');
  const g2 = make(); grantCard(g2);
  assert(deps.Save.applyRun(g2, snap), '继续上次');
  assert.equal(g2.player.bladeUnityStacks, 5, '继续上次：刃数接着上次');
  assert.equal(g2.orbitParams().blades, 6, '画面和判定都要是接着的刃数');
  /* 老存档没有这个字段 → 0，不崩 */
  const g3 = make();
  const old = JSON.parse(JSON.stringify(snap)); delete old.run.bladeUnityStacks;
  assert(deps.Save.applyRun(g3, old));
  assert.equal(g3.player.bladeUnityStacks, 0, '老存档没这个字段 → 0，不崩');
}

/* ==================== ⑧ 属性页那一行读的是运行时计数 ==================== */
{
  const g = make(); grantCard(g);
  spin(g); spin(g);
  const rows = Prog.statRows(cfg, g.player);
  assert(rows.some(r => r.label.indexOf('叠刃') >= 0), '属性页要有叠刃那一行');
  assert(g.player.taken.bladeUnity === 1, '卡本身记在 taken 里（和别的卡同一套）');
  assert(g.player.base.bladeUnity === 1, 'base 上那个只是"有没有这张卡"的开关');
  assert.equal(g.player.bladeUnityStacks, 2, '运行时计数和 base 上那个开关是**两个东西**（别合并）');
}

/* ==================== ⑨ 渲染层：画出来的刃数必须 == orbitParams().blades ====================
   ⚠️ 这一条是**补上来的**，因为 2026-10 那次 bug 就是被玩家先发现的：
      核心层 orbitParams() 加了叠刃的刃数、**渲染层自己又算了一遍、没跟上** →
      表现是"只有效果、视觉还是一把剑"。当时验收只断言了 orbitParams().blades（核心层），
      没有任何一条去看"到底画出来几把"。
      同一个根因历史上还有两次（开天的半径、千刃的刃数），都是靠出图才发现的。
      现在渲染层改成**只读 orbitParams**，这条断言就钉住"以后别再分裂成两份"。
   另外这里顺带证明"没改坏老逻辑"：把老公式原样重算一遍，和 op 上的值逐个武器对齐 ——
   老公式和新来源在**没有叠刃/爆发**时必须**一模一样**（唯一差别是老的多了个 `|| 62` 兜底，
   而 orbitRadius 永远是真数，所以等价）。 */
{
  const Renderer = require(root + '/render/renderer.js');
  const baseCtx = () => {
    const angles = [], orbs = [];
    const base = {
      rotate: (a) => { angles.push(a); },
      /* 法杖光球的第一圈（半径 15 的那层）每颗光球一次 —— 用它数光球颗数。
         ⚠️ 改了法杖光球的画法（比如不再画那圈光晕）就得跟着改这里。 */
      arc: (x, y, r) => { if (Math.abs(r - 15) < 1e-6) orbs.push(x.toFixed(3) + ',' + y.toFixed(3)); },
      measureText: () => ({ width: 0 }), canvas: { width: 812, height: 375 }
    };
    const ctx = new Proxy(base, {
      get: (t, k) => (k in t) ? t[k] : (typeof k === 'string' ? function () {} : undefined),
      set: (t, k, v) => { t[k] = v; return true; }
    });
    return { ctx: ctx, angles: angles, orbs: orbs };
  };
  /** 真调 drawOrbit 两层，数它画了几把。两种武器画法不同，所以两路都收：
        常规武器：每把刀一次 `ctx.rotate(a)` → 角度去重就是刃数
        法杖：**三颗光球、不 rotate**，位置由 cos/sin 算 → 数光球中心去重
      取非零的那一路（常规武器不会命中法杖那一路，反之亦然）。 */
  function drawnBlades(g) {
    const rec = baseCtx();
    const R = new Renderer(rec.ctx, { cfg: cfg, createCanvas: () => null });
    R.resize(812, 375);
    R.drawOrbit(g, g.player, 0, 'behind');
    R.drawOrbit(g, g.player, 0, 'front');
    return new Set(rec.angles).size || new Set(rec.orbs).size;
  }
  /* ① 老逻辑没被改坏：五个武器、裸装 + 成长卡之后，op 上的半径/刃数 == 老公式 */
  for (const kind of Object.keys(cfg.weapons)) {
    for (const extra of [[], ['range', 'range', 'giantblade']]) {
      const g = make();
      const w = deps.Progression.makeDefaultWeapon(cfg); w.kind = kind; w.id = 'w-' + kind;
      g.player.equip.weapon = w; g.player.bag = [w];
      for (const id of extra) Prog.applyUpgrade(cfg, g.player, id);
      Prog.recompute(g.player, cfg);
      const S = g.player.stats, wdef = cfg.weapons[kind], o = wdef.orbit || {};
      const rgRatio = S.attackRange / (cfg.player.base.attackRange || 1);
      const oldRadius = (S.orbitRadius || 62) * rgRatio * (o.radius !== undefined ? o.radius : wdef.range);
      const oldBlades = Math.max(1, (o.blades || 1) + Math.max(0, Math.round(S.orbitBlades || 1) - 1));
      const op = g.orbitParams();
      assert(Math.abs(op.radius - oldRadius) < 1e-9,
        kind + '（' + (extra.length ? '带成长卡' : '裸装') + '）半径没变：新 ' + op.radius + ' vs 老 ' + oldRadius);
      assert.equal(op.blades, oldBlades, kind + ' 刃数没变（没有叠刃/爆发时）');
      g.player.orbOn = true;
      assert.equal(drawnBlades(g), op.blades, kind + '：画出来的刃数 == orbitParams().blades');
    }
  }
  /* ② 叠刃：涨了几把就必须画几把（就是这次报上来的那个 bug） */
  const g = make(); grantCard(g);
  g.player.orbOn = true;
  assert.equal(drawnBlades(g), 1, '长剑基线上画面就是 1 把');
  for (let i = 0; i < 6; i++) spin(g);
  assert.equal(g.orbitParams().blades, 7);
  assert.equal(drawnBlades(g), 7, '叠刃 6 层之后画面必须真的画出 7 把 —— "只有效果、视觉还是一把剑"就是这条没守住');
  /* ③ 千刃（历史坑）也过一遍：判定 6 把、画面也必须 6 把 */
  const g2 = make();
  g2.player.orbOn = true;
  g2.player.burst = { id: 'bladeStorm', name: '千刃', left: 1, active: true, bladesSet: 6, healed: 0 };
  assert.equal(g2.orbitParams().blades, 6);
  assert.equal(drawnBlades(g2), 6, '千刃：判定 6 把、画面也必须 6 把（老坑）');
}

console.log('PASS: 叠刃 —— 每次起转 +1 把（第一次就生效）/ 总刃数上限 12（含旋刃卡）'
  + ' / 收刃时长 +5%/把封顶 ×1.55、到顶后代价跟着停 / 总伤害线性 +15%/把（走普通桶，不走 burst 桶）'
  + ' / 不碰转速 / 千刃取 max 不会把刃数打回去 / 进 run 存档、老存档=0 / 属性页读数与 base 开关分离'
  + ' / 渲染层画出来的刃数 == orbitParams().blades（叠刃 7 层画 7 把、千刃 6 把画 6 把）'
  + ' / 老公式没被改坏：5 个武器 × 裸装/带成长卡，半径和刃数与老算法逐个对齐');
