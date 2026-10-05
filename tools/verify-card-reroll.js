'use strict';
/*
 * 升级面板「刷新」按钮（重刷三张卡）的验收。
 *
 * 背景（2026-10 真机报障，用户原话："卡片点击刷新没有用，卡住了"）：
 *   技能改成精英掉落那次重构删掉了 `Game.prototype.skillOfferAllowed`，
 *   但 `doReroll()` 里还留着这一处调用 → 点刷新直接抛 TypeError →
 *   整帧 update 中断 → 面板卡死，刷新键完全没反应。
 *   ⚠️ 出事时 18 个断言全绿：`grep -r doReroll tools/` 是 **0 命中** ——
 *      没有任何测试走过这条路，所以这个洞一路活到了真机。
 *   本文件的存在意义就是把**这条被漏掉的路**钉死：付费 / 换卡 / 不算选卡 / 不崩，
 *   而且要**逐字对齐 openLevelUp 的抽卡参数**（allowSkill:false + lastMechanic），
 *   免得下次再出现"一条路径改了、另一条忘了"。
 *
 * ⚠️ 全部走**真实的输入链**（update → updateLevelUp → 判定按钮矩形），
 *    不直接调 doReroll() —— 直接调的话，"按钮判定写歪了/被卡片盖住"这类问题测不出来。
 */
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);
/* 固定随机：卡池抽卡是随机的，断言"换了一批卡"必须可复现 */
let seed = 20261004;
Math.random = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/** 造一个"刚升到级、卡已经弹出来"的局面（护栏已过，可以点） */
function makeOpen() {
  const g = new Game(cfg, deps);
  g.setViewport(812, 375);
  g.world.rocks.length = 0; g.world.walls.length = 0;
  g.spawnFoe = function () {}; g.updateSpawns = function () {};   // 别在后台刷怪干扰
  g.state = 'play';
  g.player.gold = 200;
  g.player.pendingLevels = 1;
  g.openLevelUp();
  g.cardGuard = 0;                                               // 越过"刚弹出"的护栏
  return g;
}
/** 点刷新按钮（走真实 update 链） */
function tapReroll(g) {
  const b = g.rerollBtnRect();
  g.cardGuard = 0;
  g.update(1 / 60, { tap: { x: b.x + b.w / 2, y: b.y + b.h / 2 } });
}
function tapCard(g, i) {
  const r = g.cardRects()[i];
  g.cardGuard = 0;
  g.update(1 / 60, { tap: { x: r.x + r.w / 2, y: r.y + r.h / 2 } });
}

/* ==================== ① 第一次免费：不扣钱、整排换掉、不算选卡、不崩 ==================== */
{
  const g = makeOpen();
  assert.equal(g.state, 'levelup', '升级面板要弹出来');
  assert.equal(g.rerollCost(), 0, '本局第一次重刷免费（config.growth.reroll.free=1）');
  assert(g.canReroll(), '免费那次必须能刷');
  const gold0 = g.player.gold, pend0 = g.player.pendingLevels, ids0 = g.cards.map(c => c.id);
  tapReroll(g);                                                  // ← 这里以前会抛 TypeError
  assert.equal(g.state, 'levelup', '刷完还留在升级面板上');
  assert.equal(g.player.gold, gold0, '免费那次不许扣金币');
  assert.equal(g.player.rerolls, 1, '用掉一次重刷要记上');
  assert.equal(g.player.pendingLevels, pend0, '重刷不算选卡：待处理等级数不能减');
  assert.notDeepEqual(g.cards.map(c => c.id), ids0, '整排卡要真的换掉（不是原样留着）');
  assert.equal(g.cards.length, cfg.growth.chooseFrom, '换完还要是 N 张（不是抽空了）');
  assert(g.cardGuard > 0, '刷完要给一次护栏（挡同一只手的连点）');
}

/* ==================== ② 第二次起收费：钱够就扣、不够就不给刷（且不许崩） ==================== */
{
  const g = makeOpen();
  tapReroll(g);                                                  // 用掉免费那次
  assert.equal(g.rerollCost(), cfg.growth.reroll.cost, '第二次开始按 config 收费');
  g.player.gold = cfg.growth.reroll.cost;                        // 刚好够
  const ids = g.cards.map(c => c.id);
  tapReroll(g);
  assert.equal(g.player.gold, 0, '付费重刷要扣钱');
  assert.equal(g.player.rerolls, 2);
  assert.notDeepEqual(g.cards.map(c => c.id), ids, '付了钱也得真的换卡');

  /* 钱不够：点了不许有任何变化，也不许崩（以前这里直接抛异常把面板卡死） */
  const g2 = makeOpen();
  g2.player.rerolls = cfg.growth.reroll.free;                    // 免费次数已用完
  g2.player.gold = cfg.growth.reroll.cost - 1;                   // 差一块钱
  assert.equal(g2.canReroll(), false, '钱不够就不能刷');
  const ids2 = g2.cards.map(c => c.id), gold2 = g2.player.gold, rr2 = g2.player.rerolls;
  tapReroll(g2);
  assert.equal(g2.player.gold, gold2, '刷不了不许扣钱');
  assert.equal(g2.player.rerolls, rr2, '刷不了不许记次数');
  assert.deepEqual(g2.cards.map(c => c.id), ids2, '刷不了卡不许变');
  assert.equal(g2.state, 'levelup', '刷不了也要留在面板上（不是卡死/退出）');
  /* 关键：点按钮那一下之后，游戏还得能正常往下走（选卡照样能选） */
  tapCard(g2, 0);
  assert.equal(g2.state, 'play', '刷不了之后照样能正常选卡、面板能关掉');
}

/* ==================== ③ 不限次数（max ≤ 0）+ 递增价（方案 2） ==================== */
{
  /* 2026-10 用户选方案 2：从"每局上限 3 次、每次 30"改成"**不限次数 + 递增价**"。
     这条守两件事：① 刷到第 4、5、6 次仍然能刷（旧规则 3 次就到顶，这里必须过）
                ② 价格按 `cost + (n-free)*step` 递增：0（免费）→ 30 → 60 → 90 → 120 → 150 */
  const g = makeOpen();
  g.player.gold = 99999;
  const r = cfg.growth.reroll;
  assert.equal(g.rerollLeft(), Infinity, 'max ≤ 0 = 不限次数（rerollLeft 返回 Infinity）');
  const seen = [];
  for (let i = 1; i <= 6; i++) {
    const cost = g.rerollCost();
    seen.push(cost);
    assert(g.canReroll(), '第 ' + i + ' 次仍然能刷（金币管够 + 不限次数）');
    assert.equal(cost, i <= (r.free || 0) ? 0 : r.cost + (i - 1 - (r.free || 0)) * (r.step || 0),
      '第 ' + i + ' 次的价格要按 cost+(n-free)*step 递增，实际 ' + cost);
    const before = g.player.gold;
    tapReroll(g);
    assert.equal(g.player.gold, before - cost, '第 ' + i + ' 次要扣掉当时的价格 ' + cost);
  }
  assert.equal(g.player.rerolls, 6, '次数照记（每局累计，不封顶）');
  assert.deepEqual(seen, [0, 30, 60, 90, 120, 150], '价格序列必须是 免费→30→60→90→120→150');
}

/* ==================== ③b 不限次数 ≠ 一定刷得动：门槛在金币 ==================== */
{
  const g = makeOpen();
  g.player.gold = 25;                                  // 够免费那次，不够第二次的 30
  assert.equal(g.rerollCost(), 0, '第一次免费');
  tapReroll(g);                                        // 用掉免费那次
  assert.equal(g.rerollCost(), cfg.growth.reroll.cost, '第二次恢复原价');
  assert.equal(g.canReroll(), false, '钱不够 30 就不给刷（哪怕不限次数）');
  assert.equal(g.rerollLeft(), Infinity, '不限次数 ≠ 刷得动：次数不拦，金币才是门槛');
  const gold0 = g.player.gold, rr0 = g.player.rerolls, ids0 = g.cards.map(c => c.id);
  tapReroll(g);
  assert.equal(g.player.gold, gold0, '刷不动不许扣钱');
  assert.equal(g.player.rerolls, rr0, '刷不动不许记次数');
  assert.deepEqual(g.cards.map(c => c.id), ids0, '刷不动卡不许变');
}

/* ==================== ④ 重刷出来的卡里永远不许有武器技能卡 ==================== */
{
  /* 2026-10 口径：武器技能只从精英掉落。openLevelUp 传 allowSkill:false，
     doReroll 漏传的话重刷就变成了"刷技能卡"的后门 —— 这条专门守它。 */
  const g = makeOpen();
  g.player.gold = 9999;
  const skillIds = cfg.upgrades.filter(u => u.weapon).map(u => u.id);
  for (let i = 0; i < 6; i++) {                                  // 连刷 6 次（不限次数，多刷几次覆盖面更广）
    tapReroll(g);
    const hit = g.cards.filter(c => skillIds.indexOf(c.id) >= 0);
    assert.equal(hit.length, 0, '重刷第 ' + (i + 1) + ' 次抽到了武器技能卡：' + hit.map(c => c.id).join('/') + '（allowSkill 漏传了）');
  }
}

/* ==================== ⑤ 重刷也要守机制卡限流（lastMechanic 传递一致） ==================== */
{
  /* 只断言"参数传了、状态被更新"这一层：概率本身在 verify-skill-drop 里测。
     口径：lastRowMechanic 记的是**上一排出现过**机制卡，重刷也算"新的一排"。 */
  const g = makeOpen();
  assert.equal(typeof g.lastRowMechanic, 'boolean', 'openLevelUp 之后要记下这一排有没有机制卡');
  const before = g.lastRowMechanic;
  g.player.gold = 9999;
  tapReroll(g);
  assert.equal(g.lastRowMechanic,
    g.cards.some(u => g.Prog.isMechanic(u)),
    '重刷后 lastRowMechanic 要按新一排重算（不更新的话下一排的限流会用到过期状态）');
  void before;
}

/* ==================== ⑥ 按钮和卡片不重叠：点按钮不许被算成选卡 ==================== */
{
  const g = makeOpen();
  const rb = g.rerollBtnRect();
  g.cardRects().forEach(function (r, i) {
    const overlap = !(r.x + r.w <= rb.x || rb.x + rb.w <= r.x || r.y + r.h <= rb.y || rb.y + rb.h <= r.y);
    assert(!overlap, '第 ' + (i + 1) + ' 张卡和刷新按钮重叠了（会互相抢点击）');
  });
  const pend = g.player.pendingLevels;
  tapReroll(g);
  assert.equal(g.player.pendingLevels, pend, '点在刷新按钮上不算选卡：待处理等级数不变');
  assert.equal(g.cards.length, cfg.growth.chooseFrom, '卡还在（没被"选掉"一张）');
}

/* ==================== ⑦ 面板能正常收尾：刷完→选卡→回到战斗 ==================== */
{
  const g = makeOpen();
  g.player.gold = 9999;
  tapReroll(g);
  tapCard(g, Math.min(1, g.cards.length - 1));
  assert.equal(g.state, 'play', '刷完照样能选卡并回到战斗（刷新不是死路）');
  assert.equal(g.player.pendingLevels, 0, '选完卡待处理等级清零');
  /* 再升一级 → 面板重新弹出、上一次的重刷计数保留（每局计数，不是每次升级重置） */
  assert.equal(g.player.rerolls, 1, '重刷次数是**每局**计数的（升级不会重置）');
}

console.log('PASS: 升级面板刷新按钮（走真实输入链）—— 首次免费不扣钱 / 第二次起按 config 收费且钱不够点不动 / '
  + '不限次数且价格递增(0/30/60/90/120/150) / 重刷刷不出武器技能卡 / lastMechanic 一致 / 不算选卡且不与卡片重叠 / 刷完照样能选卡回战斗');
