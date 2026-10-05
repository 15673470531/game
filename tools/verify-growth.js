'use strict';
/*
 * 「一局打完，武器得跟最开始天差地别」的验收（2026-10 用户口径）。
 *
 * 背景（用户的怀疑完全正确）：当时**拿满尺寸卡也只长 24%**。
 *   实测：一局 8 次升级、每次优先挑尺寸卡，最多拿到 2 张（长刃 + 巨刃）= ×1.24（70→87px）。
 *   根因不是数值小，而是**每张卡一局只能拿一次**（抽卡会排除已拿过的卡）——成长维度根本堆不起来。
 *
 * 这次的改法四条，本文件逐条钉住（改坏了哪条都要报出来）：
 *   ① stackable    —— 成长卡（长刃/巨刃/旋刃）不受"已拿过"限制，一局可以连拿好几张
 *   ② guaranteeGrowth —— 三选一里**至少一张**成长卡（保底，不靠运气）
 *   ③ 幅度         —— 长刃 +18%（金 +25%）、巨刃 +25%（金 +32%）
 *   ④ 代价         —— 用户选"代价"而不是硬上限：尺寸越大**收刃越久**
 *      ⚠️ 代价必须加在收刃上，不能加在转速上：转速一变，"一次攻击转一圈"立刻不成立
 *         （曾试过转速 −8% → 每次转 1.08 圈，刀转不到一整圈就收）。所以这里专门钉"圈数恒为 1"。
 *   另外钉一条反向的：可叠的只许是成长卡 —— 一次性卡（处决/机制卡）拿了就不许再出现。
 */
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);

/** 跑一局"刻意堆长度"的抽卡：优先长刃/巨刃，其次别的成长卡，最后随便拿 */
function run(levels, seed0) {
  let seed = seed0;
  Math.random = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const g = new Game(cfg, deps);
  g.setViewport(812, 375);
  const rows = [], got = [];
  let lastMech = false;
  for (let i = 0; i < levels; i++) {
    const cards = g.Prog.drawUpgrades(cfg, g.player.taken, cfg.growth.chooseFrom,
      { weapon: 'sword', allowSkill: false, lastMechanic: lastMech, guaranteeGrowth: true });
    rows.push(cards);
    const pick = cards.find(c => /^(range|giantblade)/.test(c.id)) || cards.find(g.Prog.isGrowth) || cards[0];
    got.push(pick.id);
    g.Prog.applyUpgrade(cfg, g.player, pick.id);
    lastMech = cards.some(c => g.Prog.isMechanic(c));
  }
  const op = g.orbitParams();
  const mul = g.player.stats.attackRange / cfg.player.base.attackRange;
  return {
    rows, got, g, op, mul,
    radius: cfg.player.base.orbitRadius * mul,
    sizeCards: got.filter(id => /^(range|giantblade)/.test(id)).length,
    turns: op.omega * op.spin / (Math.PI * 2)
  };
}

/* ==================== ① 成长卡可叠：一局能反复拿到同一种 ==================== */
{
  const r = run(8, 99);
  const rangeCount = r.got.filter(id => /^range/.test(id)).length;
  assert(r.sizeCards >= 3, '刻意堆长度时尺寸卡应该能拿到 ≥3 张（实测 ' + r.sizeCards + ' 张：' + r.got.join(',') + '）');
  assert(rangeCount >= 2 || r.sizeCards >= 4, '同一种成长卡要能连拿（长刃拿了 ' + rangeCount + ' 次）—— stackable 是不是失效了');
}

/* ==================== ② 保底：每一排至少一张成长卡（多跑几个种子） ==================== */
{
  let bad = 0;
  for (const s of [1, 7, 99, 2026, 555, 31337]) {
    const r = run(8, s);
    const miss = r.rows.filter(cards => !cards.some(c => c.growth)).length;
    if (miss) bad++;
    assert.equal(miss, 0, 'seed ' + s + ' 有 ' + miss + ' 排没有成长卡（保底失效）');
  }
  assert.equal(bad, 0);
}

/* ==================== ③ 幅度：一局刻意堆长度至少翻一倍 ==================== */
{
  const muls = [1, 7, 99, 2026, 555, 31337, 42, 1024].map(s => run(8, s).mul).sort((a, b) => a - b);
  const median = muls[4], best = muls[muls.length - 1];
  assert(best >= 2.5, '运气最好的一局要能到 ×2.5 以上（实测最好 ×' + best.toFixed(2) + '）');
  assert(median >= 1.8, '中位数要 ≥ ×1.8（实测中位 ×' + median.toFixed(2) + '）—— 数值被谁吃掉了？');
}

/* ==================== ④ 代价：尺寸越大收刃越久，但**圈数必须恒为 1** ==================== */
{
  const base = new Game(cfg, deps); base.setViewport(812, 375);
  const baseOp = base.orbitParams();
  const r = run(8, 42);                                  // 堆到 ×3.5 左右
  assert(r.mul > 1.5, '（前提）这一局得真的堆起来了，实测 ×' + r.mul.toFixed(2));
  /* ⚠️ 容差 0.005 而不是 1e-6：config 里的 spin 是**四舍五入过**的倍率（长剑 0.453 而不是 0.45336），
     所以基准状态本身就是 0.9994 圈。要钉的是"代价没把它推到 0.9 或 1.1 那种肉眼能看出的偏差"。 */
  assert(Math.abs(r.turns - 1) < 0.005,
    '一次攻击转一圈是**口径**，代价不许破坏它（实测 ' + r.turns.toFixed(3) + ' 圈）—— 代价是不是被加到转速上了？');
  assert(r.op.rest > baseOp.rest * 1.05,
    '尺寸涨了收刃要跟着变久（代价）：基础 ' + baseOp.rest.toFixed(2) + 's → 实测 ' + r.op.rest.toFixed(2) + 's');
}

/* ==================== ⑤ 反向保险：可叠的只能是成长卡 ==================== */
{
  /* 一次性卡（处决/灼痕/机制卡）拿了之后不许再出现 —— stackable 只许开给成长卡这一小撮 */
  const oneShot = cfg.upgrades.filter(u => !u.weapon && !u.stackable && !u.disabled && !u.rare).map(u => u.id);
  const r = run(12, 2026);                               // 12 排，够把所有一次性卡拿一遍
  const dup = {};
  r.got.forEach(id => { dup[id] = (dup[id] || 0) + 1; });
  /* 只统计"一次性卡"的重复：把 #rare 后缀归到本体 */
  const norm = id => id.replace(/#rare$/, '');
  const dupOneShot = Object.keys(dup).filter(id => oneShot.indexOf(norm(id)) >= 0 && dup[id] > 2);
  assert.equal(dupOneShot.length, 0,
    '一次性卡被重复发了：' + dupOneShot.join(',') + '（每种最多普通版 + 金色版各一次）');
  /* 保底也不许把代价卡限流挤破：每排最多 1 张代价卡 */
  r.rows.forEach((cards, i) => {
    assert(cards.filter(c => c.cost).length <= 1, '第 ' + (i + 1) + ' 排出现了 ' + cards.filter(c => c.cost).length + ' 张代价卡（限流是每排最多 1 张）');
  });
}

console.log('PASS: 成长卡可叠（一局能连拿） / 每排至少一张成长卡 / 刻意堆长度至少 ×1.8（最好 ≥×2.5） / '
  + '代价加在收刃上且**圈数恒为 1** / 可叠只开给成长卡、一次性卡不重复、代价卡每排最多 1 张');
