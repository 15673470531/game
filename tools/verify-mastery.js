#!/usr/bin/env node
/**
 * 武器熟练度（2026-10）验收。数值口径全在 config.mastery 那一段，这里守它的**结论**：
 *
 *   ① 门槛表与用户的三条硬约束
 *      · 数字是"百级"、满级是"几百"（不上千）
 *      · **每一级都不能一把刷满，至少两把**（门槛间隔 > 一局上限）
 *      · 而且这一版是"每级恰好两把"（间隔 = 2 × 一局上限）
 *   ② 等级换算（等级不存盘，只由点数算；满级时进度条画满）
 *   ③ 三个来源：教学精英 +15 / 精英 +45 / 通关 +90，一局上限 150
 *      ⚠️ 教学精英（eliteTips）给得最少 —— 它是唯一能"打完就送死重开"刷的
 *   ④ 防重领：同一只精英一局只结算一次；「打死精英 → 强杀进程 → 继续上次」不能再给
 *   ⑤ 熟练度**不吃 keepOnDeath**（连 'none' 也留）—— 这是"成长性"成立的前提
 *   ⑥ 存档：老存档没有 mastery 字段 → 0，不崩；不认得的武器 kind 丢掉
 *   ⑦ 解锁生效：叠刃 Lv3 才进卡池（且长剑专属，重刷也拦）；剑阵回响 Lv2 才进掉落池
 *   ⑧ 满级奖励：长剑 Lv4 → 打完 Boss 有几率掉双刀（库里没有才掉）
 *   ⑨ 面板：结算页 / 通关面板都显示"当前 / 本级上限 + 本局获得 + 下一级解锁什么"
 *
 * 用法：node tools/verify-mastery.js
 */
'use strict';
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);
const Prog = deps.Progression, M = cfg.mastery;

/* 随机数钉死（技能/装备掉落是随机的，测试不能靠碰运气） */
let seed = 20267;
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const fixed = (v) => { Math.random = () => v; };

function make(disk) {
  const g = new Game(cfg, disk ? Object.assign({}, deps, { storage: disk }) : deps);
  g.setViewport(812, 375);
  return g;
}
/** 造一只精英并让它死掉（走真实 onFoeDeath 这条路，别直接调 gainMastery）。
    `wave` 是它出生的波次 —— 熟练度的去重键就用它（真实对局里两只精英分别在第 1、2 波）。 */
function killElite(g, tutorials, x, wave) {
  const f = deps.Entities.makeFoe(cfg, 'tank', g.player.x + (x || 40), g.player.y, 1, 1);
  f.trialElite = true; f.eliteTips = !!tutorials; f.hp = 0; f.trialWave = wave || 1;
  g.foes.push(f); g.onFoeDeath(f);
  return f;
}

/* ==================== ① 门槛表：三条硬约束 ==================== */
assert.deepEqual(M.levels, [0, 300, 600, 900], '门槛表：Lv1 起始 0，Lv2/3/4 = 300/600/900');
const perRun = M.gains.tutorialElite + M.gains.elite + M.gains.clear;
assert.equal(perRun, 150, '一局全清 = 教学15 + 精英45 + 通关90 = 150');
for (let lv = 1; lv < M.levels.length; lv++) {
  const gap = M.levels[lv] - M.levels[lv - 1];
  assert(gap > perRun, 'Lv' + (lv + 1) + ' 的门槛间隔必须大于一局上限（否则一把就能刷满）');
}
for (let lv = 1; lv < M.levels.length; lv++) {
  assert.equal(M.levels[lv] - M.levels[lv - 1], perRun * 2,
    'Lv' + (lv + 1) + ' 的门槛间隔 = 2 × 一局上限 → 每级恰好两把（用户口径"至少两把"）');
}
assert(M.levels[M.levels.length - 1] < 1000 && M.levels[M.levels.length - 1] >= 100,
  '满级门槛是"几百"（不是 1 点 2 点，也不上千）');

/* ==================== ② 等级换算 ==================== */
assert.equal(Prog.masteryLevel(0, cfg), 1);
assert.equal(Prog.masteryLevel(299, cfg), 1);
assert.equal(Prog.masteryLevel(300, cfg), 2);
assert.equal(Prog.masteryLevel(599, cfg), 2);
assert.equal(Prog.masteryLevel(600, cfg), 3);
assert.equal(Prog.masteryLevel(899, cfg), 3);
assert.equal(Prog.masteryLevel(900, cfg), 4);
assert.equal(Prog.masteryLevel(99999, cfg), 4, '超出门槛也只到满级（不是第 5 级）');
{
  const a = Prog.masteryInfo(150, cfg);
  assert.equal(a.level, 1); assert.equal(a.from, 0); assert.equal(a.to, 300);
  assert.equal(a.remain, 150); assert(!a.maxed, '150/300 没满级');
  const b = Prog.masteryInfo(450, cfg);
  assert.equal(b.level, 2); assert.equal(b.from, 300); assert.equal(b.to, 600,
    '分母是**本级上限**（用户口径：不用满级大数当分母，否则刚起步就看着没戏）');
  const z = Prog.masteryInfo(900, cfg);
  assert(z.maxed && z.from === 900 && z.to === 900 && z.remain === 0, '满级：进度条画满、不再有"还差"');
}

/* ==================== ③ 三个来源 + 一把刷不满 ==================== */
{
  const g = make();
  assert.equal(g.masteryOf('sword'), 0, '起始 Lv1 = 0 点');
  killElite(g, true);
  assert.equal(g.masteryOf('sword'), M.gains.tutorialElite, '教学精英给得最少（15）');
  killElite(g, false, 60);
  assert.equal(g.masteryOf('sword'), M.gains.tutorialElite + M.gains.elite, '精英 +45');
  g.stageClear();
  assert.equal(g.masteryOf('sword'), perRun, '通关 +90 → 一局全清 150');
  assert.equal(g.masteryInfo('sword').level, 1, '**一把全清也升不到 Lv2**（用户口径：至少两把）');
  assert.equal(g.masteryInfo('sword').gainedRun, perRun, '结算页要读到"本局 +150"');
}

/* ==================== ④ 防重领 ==================== */
{
  const g = make();
  killElite(g, true); killElite(g, false, 60);
  const before = g.masteryOf('sword');
  killElite(g, true); killElite(g, false, 80);        // 同一波次的精英"又死了一次"
  assert.equal(g.masteryOf('sword'), before, '同一只精英（同波次）一局只结算一次');
}
{
  /* 「打死精英 → 强杀进程 → 继续上次」：真实走一遍存档往返 */
  let raw = null;
  const disk = { get: () => raw, set: (k, v) => { raw = v; }, remove: () => { raw = null; } };
  const g = make(disk);
  g.startRun(false);                                   // 真开局（会立刻存一次，带 run 块）
  killElite(g, true);
  const pts = g.masteryOf('sword');
  assert.equal(pts, M.gains.tutorialElite);
  g.saveNow();                                         // 强杀进程前落盘的就是这一份
  const saved = JSON.parse(raw);
  assert(saved.run && saved.run.masteryClaimed, 'run 块里要带"已经领过谁"的标记');
  const g2 = make(disk);
  assert(g2.Save.applyRun(g2, saved), '继续上次');
  assert.equal(g2.masteryOf('sword'), pts, '继续上次：点数接着上次，不掉');
  killElite(g2, true);
  assert.equal(g2.masteryOf('sword'), pts, '继续上次之后不能再领一次同一只精英（防重领）');
}

/* ==================== ⑤ 不吃 keepOnDeath（连 none 也留） ==================== */
{
  const g = make();
  g.gainMastery(400, 'test');
  const snap = JSON.parse(JSON.stringify(deps.Save.snapshot(g, false)));
  assert.equal(snap.mastery.sword, 400, '存档里要有 mastery');
  const keepNone = make();
  deps.Save.applyMeta(keepNone, JSON.parse(JSON.stringify(snap)), 'none');
  assert.equal(keepNone.masteryOf('sword'), 400, 'keep=none 也要留熟练度（它是元进度，不是这局的战利品）');
  const keepLoot = make();
  deps.Save.applyMeta(keepLoot, JSON.parse(JSON.stringify(snap)), 'loot');
  assert.equal(keepLoot.masteryOf('sword'), 400);
  /* 但等级/卡/装备照旧清掉 —— 死亡该有的代价不能因为加了熟练度就松掉 */
  assert.equal(keepLoot.player.level, 1);
  assert.deepEqual(keepLoot.player.taken, {});
}

/* ==================== ⑥ 老存档兼容 ==================== */
{
  const g = make(); g.gainMastery(50, 't');
  const snap = JSON.parse(JSON.stringify(deps.Save.snapshot(g, false)));
  delete snap.mastery;
  const old = make();
  deps.Save.applyMeta(old, snap, 'loot');
  assert.equal(old.masteryOf('sword'), 0, '老存档没有 mastery 字段 → 0，不崩');
  const dirty = make();
  deps.Save.applyMeta(dirty, { v: 1, mastery: { scythe: 999, sword: 10, dagger: -5 } }, 'loot');
  assert.equal(dirty.masteryOf('sword'), 10);
  assert.equal(dirty.masteryOf('scythe'), 0, '已经删掉的武器（scythe）不认');
  assert.equal(dirty.masteryOf('dagger'), 0, '负数/脏数据不认');
}

/* ==================== ⑦ 解锁门槛生效 ==================== */
{
  /* 叠刃：Lv3（600 点）才进卡池，且**长剑专属** */
  const row = (opts) => Prog.drawUpgrades(cfg, {}, 3, Object.assign({ weapon: 'sword', allowSkill: false }, opts));
  for (let i = 0; i < 400; i++) {
    assert(!row({ masteryPts: 0 }).some(c => c.id === 'bladeUnity'), 'Lv1 抽不到叠刃');
    assert(!row({ masteryPts: 599 }).some(c => c.id === 'bladeUnity'), '差 1 点到 Lv3 也抽不到');
  }
  let seen = false;
  for (let i = 0; i < 600 && !seen; i++) if (row({ masteryPts: 600 }).some(c => c.id === 'bladeUnity')) seen = true;
  assert(seen, 'Lv3 之后叠刃要能进卡池');
  for (let i = 0; i < 400; i++) {
    assert(!Prog.drawUpgrades(cfg, {}, 3, { weapon: 'staff', allowSkill: false, masteryPts: 900 })
      .some(c => c.id === 'bladeUnity'), '叠刃是长剑专属，别的武器抽不到');
  }
  /* 走游戏层也验一遍（openLevelUp 有没有把 masteryPts 传下去） */
  const g = make();
  let gameSeen = false;
  for (let i = 0; i < 600 && !gameSeen; i++) {
    g.player.mastery.sword = 600; g.player.taken = {}; g.player.pendingLevels = 1;
    g.state = 'play'; g.openLevelUp();
    if (g.cards.some(c => c.id === 'bladeUnity')) gameSeen = true;
    g.player.pendingLevels = 0; g.cards = []; g.state = 'play';
  }
  assert(gameSeen, 'openLevelUp 必须把熟练度传进抽卡（不传的话那张卡永远抽不到）');
  const g1 = make();
  for (let i = 0; i < 400; i++) {
    g1.player.mastery.sword = 0; g1.player.taken = {}; g1.player.pendingLevels = 1;
    g1.state = 'play'; g1.openLevelUp();
    assert(!g1.cards.some(c => c.id === 'bladeUnity'), 'Lv1 的 openLevelUp 抽不到叠刃');
    g1.player.pendingLevels = 0; g1.cards = []; g1.state = 'play';
  }
}
{
  /* 剑阵回响：Lv2（300 点）才进长剑的技能掉落池 */
  const g = make();
  for (let i = 0; i < 300; i++) {
    const id = g.dropSkillScroll(0, 0);
    assert(['sword_wave', 'sword_return'].indexOf(id) >= 0, 'Lv1 掉不到剑阵回响');
  }
  const g2 = make();
  g2.player.mastery.sword = 300;
  let hit = false;
  for (let i = 0; i < 600 && !hit; i++) { g2.player.taken = {}; if (g2.dropSkillScroll(0, 0) === 'sword_echo') hit = true; }
  assert(hit, 'Lv2 之后剑阵回响要进掉落池（而且是"有几率"，见 dropSkillScroll）');
  /* 技能页状态要能区分"没解锁"和"解锁了只是还没掉出来" */
  const g3 = make();
  const rows1 = g3.weaponSkillRows('sword');
  assert(rows1.some(r => r.status === '未解锁 · 需长剑熟练度 Lv2'), 'Lv1 时剑阵回响写"未解锁 · 需长剑熟练度 Lv2"');
  assert(!rows1.some(r => r.status === '未获得'), '不许再出现笼统的"未获得"');
  g3.player.mastery.sword = 300;
  assert(g3.weaponSkillRows('sword').some(r => r.status === '可获取 · 局内精英掉落'), 'Lv2 之后改成"可获取 · 局内精英掉落"');
}

/* ==================== ⑧ 满级奖励：打完 Boss 有几率掉双刀 ==================== */
{
  const g = make();
  fixed(0);                                     // 0 < chance → 只要够条件就必掉
  assert.equal(g.grantMasteryWeaponReward(), null, '没满级不给双刀');

  const g2 = make();
  g2.player.mastery.sword = M.levels[3];         // 满级
  fixed(0);
  const it = g2.grantMasteryWeaponReward();
  assert(it && it.kind === 'dagger', '满级 + 命中几率 → 掉一把双刀');
  assert(g2.pickups.some(p => p.item && p.item.kind === 'dagger'), '双刀是掉在地上（走 Boss 那条掉落管线）');
  g2.collectAll();
  assert((g2.player.bag || []).some(x => x.kind === 'dagger'), '收走之后进武器库');
  fixed(0);
  assert.equal(g2.grantMasteryWeaponReward(), null, '库里已经有双刀了 → 不再掉（反复掉重复武器没意义）');

  const g3 = make();
  g3.player.mastery.sword = M.levels[3];
  fixed(0.99);                                  // 99% > 20% → 不掉
  assert.equal(g3.grantMasteryWeaponReward(), null, '几率没中就不掉（不是必掉）');
}
{
  /* 通关那条路：stageClear 里"先入账、再判满级奖励" —— 差一点满级的那一把就该吃到 */
  const g = make();
  g.player.mastery.sword = M.levels[3] - M.gains.clear;   // 差一个通关的分
  fixed(0);
  g.stageClear();
  assert.equal(g.masteryOf('sword'), M.levels[3], '通关分把熟练度顶到满级');
  assert(g.pickups.some(p => p.item && p.item.kind === 'dagger'),
    '顺序要对：先入账再判奖励，不然"差一点满级"的那一把会白等一整把');
}
{
  /* 试炼场（沙盒）不练熟练度、不掉奖励武器 */
  const g = make(); g.setTraining(true);
  g.stageClear();
  assert.equal(g.masteryOf('sword'), 0, '试炼场不练熟练度');
}

/* ==================== ⑨ 面板显示（结算页 / 通关面板） ==================== */
function recordingCtx() {
  const texts = [];
  const base = {
    fillText: (s) => { texts.push(String(s)); },
    strokeText: (s) => { texts.push(String(s)); },
    measureText: (s) => ({ width: String(s).length * 6 }),
    canvas: { width: 812, height: 375 }
  };
  const ctx = new Proxy(base, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop: function () {} });
      }
      return function () {};
    },
    set: (t, k, v) => { t[k] = v; return true; }
  });
  return { ctx: ctx, texts: texts };
}
{
  const Renderer = require(root + '/render/renderer.js');
  const rec = recordingCtx();
  const R = new Renderer(rec.ctx, { cfg: cfg, createCanvas: () => null });
  R.resize(812, 375);
  const g = make();
  killElite(g, true); killElite(g, false, 60, 2);
  g.stageClear();                       // 通关 +90 → 一局全清 150（这就是玩家在结算页看到的数）
  g.state = 'dead';
  R.drawGameOver(g);
  const all = rec.texts.join('|');
  assert(all.indexOf('长剑熟练度　150 / 300') >= 0, '结算页要写「当前 / 本级上限」（实测："' + all + '"）');
  assert(all.indexOf('本局 +150') >= 0, '结算页要写这把拿了多少');
  assert(all.indexOf('下一级 Lv2：解锁专属技能「剑阵回响」') >= 0,
    '结算页要把"下一级解锁什么"写全（第几级 / 解锁 / 类别 / 名字），实测："' + all + '"');
  assert(all.indexOf('这局的问题是') < 0 && all.indexOf('buildHint') < 0, '腾位：buildHint 那行让给熟练度');

  const rec2 = recordingCtx();
  const R2 = new Renderer(rec2.ctx, { cfg: cfg, createCanvas: () => null });
  R2.resize(812, 375);
  const g2 = make();
  g2.stageSummary = { stage: 1, name: '荒原', kills: 70, time: 61.5, hits: 3, gained: [] };
  g2.clearInfo = { stage: 2, name: '石林' };
  g2.state = 'clear';
  R2.drawClearPanel(g2);
  const all2 = rec2.texts.join('|');
  assert(all2.indexOf('长剑熟练度') >= 0 && all2.indexOf('下一级 Lv2：解锁专属技能「剑阵回响」') >= 0,
    '通关面板共用同一个熟练度块');
  assert(all2.indexOf('下一关：第 2 关') >= 0, '加了熟练度块之后"下一关"那行不能被挤掉');
}
{
  /* 满级：那半行改成"满级奖励"；奖励内容还没定（双刀）时**不画** —— 不许露出"待开发" */
  const Renderer = require(root + '/render/renderer.js');
  const rec = recordingCtx();
  const R = new Renderer(rec.ctx, { cfg: cfg, createCanvas: () => null });
  R.resize(812, 375);
  const g = make();
  g.player.mastery.sword = M.levels[3];
  g.player.masteryGainRun = { sword: 150 };
  g.state = 'dead'; g.deathLostTo = '铁甲母蟹还剩 40% 生命';
  R.drawGameOver(g);
  const all = rec.texts.join('|');
  assert(all.indexOf('长剑熟练度　900 / 900') >= 0, '满级写 900 / 900');
  assert(all.indexOf('满级奖励：打完 Boss 有几率掉「双刀」') >= 0, '满级那行改说满级奖励');
  const g2 = make();
  g2.player.mastery.dagger = M.levels[3];                 // 双刀满级：奖励内容还没定
  g2.player.equip.weapon = { kind: 'dagger', affixes: [], id: 'd1' };
  g2.player.bag = [g2.player.equip.weapon];
  g2.state = 'dead'; g2.deathLostTo = null;
  const rec3 = recordingCtx();
  const R3 = new Renderer(rec3.ctx, { cfg: cfg, createCanvas: () => null });
  R3.resize(812, 375);
  R3.drawGameOver(g2);
  const all3 = rec3.texts.join('|');
  assert(all3.indexOf('双刀熟练度　900 / 900') >= 0);
  assert(all3.indexOf('待开发') < 0 && all3.indexOf('敬请期待') < 0,
    '奖励还没定的武器：不画"下一级解锁"那半行，也不许写"待开发/敬请期待"（实测："' + all3 + '"）');
}

/* ==================== ⑩ 首页「开局武器」面板文案 ==================== */
{
  const g = make();
  const rows = g.loadoutRects().rows;
  const dagger = rows.filter(r => r.id === 'dagger')[0];
  assert(dagger && dagger.note.indexOf('长剑熟练度 Lv4') >= 0 && dagger.note.indexOf('打完 Boss') >= 0,
    '双刀那行要写"长剑熟练度 Lv4 后 · 打完 Boss 有几率掉落"（面板必须和真正发武器的地方一致），实测："' + (dagger && dagger.note) + '"');
}

/* ==================== ⑪ 结算页装得下（"腾位"这件事的护栏） ==================== */
{
  /* 熟练度块是**顶掉** buildHint 那一行的，DEAD_TEXT_H 一点没涨。
     为什么这条必须有：812x375 上结算页本来就刚好塞满（132 + 12 + 按钮 ≈ 362 / 375），
     这块要是"加高"而不是"腾位"，最后一排按钮会直接掉出屏幕 —— 而那在真机上只是
     "按钮点不到"，截单页图还看不出来。 */
  const g = make(); g.setViewport(812, 375); g.state = 'dead';
  const R = g.deadRects();
  const bottom = Math.max.apply(null, R.rows.map(r => r.y + r.h));
  assert(bottom <= 375, '结算页整块必须装得进 812x375（实测底边 y=' + bottom + '）');
  assert.equal(R.textH, 132, 'DEAD_TEXT_H 还是 132：熟练度块是"腾位"，不是加高');
}

/* ============ ⑫ 那句"下一级解锁什么"：类别词跟 kind 走 + 装得下 + 只有一个来源 ============ */
{
  /* 用户口径（原话「结算页面还得优化, 写清楚, 下一级:解锁剑阵回响专属技能 这种描述」）：
     这句话要把 第几级 / 解锁 / 类别 / 名字 四件事一次说全。
     旧写法 `→ Lv2 · 剑阵回响` 只有个名字 —— 玩家看不出是技能还是卡。 */
  const g = make();
  g.player.mastery.sword = 0;
  assert.equal(g.masteryRewardText(g.masteryInfo('sword').reward, false),
    '下一级 Lv2：解锁专属技能「剑阵回响」', '技能那档说"专属技能"');
  g.player.mastery.sword = 300;
  assert.equal(g.masteryRewardText(g.masteryInfo('sword').reward, false),
    '下一级 Lv3：解锁专属机制卡「叠刃」', '卡那档说"专属机制卡"（别也说成技能）');
  g.player.mastery.sword = 600;
  assert.equal(g.masteryRewardText(g.masteryInfo('sword').reward, false),
    '下一级 Lv4：打完 Boss 有几率掉「双刀」', '武器那档说"有几率掉"，不说"解锁"');
  g.player.mastery.sword = 900;
  const mi = g.masteryInfo('sword');
  assert(mi.maxed, '（前置）900 点就是满级');
  assert.equal(g.masteryRewardText(mi.rewardNow, true),
    '满级奖励：打完 Boss 有几率掉「双刀」', '满级那档改说"满级奖励"');
  /* 长度预算：那半行约 258px。按**渲染宽度**估，不能按字数 ——
     拉丁字母/空格约半个汉字宽（"下一级 Lv4：打完 Boss 有几率掉「双刀」" 24 个字符但只有约 196px）。
     超了渲染层会降字号，但那时它比旁边的字小一号，看着就是"塞不下"。 */
  function estWidth(t) {
    let w = 0;
    for (let i = 0; i < t.length; i++) w += t.charCodeAt(i) < 128 ? 5.6 : 10;
    return w;
  }
  ['下一级 Lv2：解锁专属技能「剑阵回响」', '下一级 Lv3：解锁专属机制卡「叠刃」',
    '下一级 Lv4：打完 Boss 有几率掉「双刀」', '满级奖励：打完 Boss 有几率掉「双刀」'].forEach(function (t) {
      const w = estWidth(t);
      assert(w <= 258, '「' + t + '」约 ' + Math.round(w) + 'px，超了那半行的预算（258px）');
    });
  /* 句式只有一个来源：渲染层不许再自己拼那句话（这次"没写清楚"的根因就是一处两套写法） */
  const src = require('fs').readFileSync(root + '/render/renderer.js', 'utf8');
  assert(src.indexOf("'→ Lv'") < 0,
    '渲染层不许再自己拼「→ LvN · 名字」—— 那句话一律走 game.masteryRewardText 一个来源');
}

/* ============ ⑬ 死亡页：常驻提示行去掉、只留"输在哪"那条真信息 ============ */
{
  /* 用户口径两轮：①「把下局目标去掉, 让他们排版更好一点」②「有 Boss 时的『还剩 X% 生命』
     这条是真信息（我输在哪）」⇒ 常驻套话去掉，真信息留着、但不占那四块排好的间距。
     注：`g.deathLostTo` 由核心层在死亡那一刻算好（game.js 里扫活着的 Boss）。 */
  const Renderer = require(root + '/render/renderer.js');
  const rec = recordingCtx();
  const R = new Renderer(rec.ctx, { cfg: cfg, createCanvas: () => null });
  R.resize(812, 375);
  const g = make();
  g.player.mastery.sword = 150; g.player.masteryGainRun = { sword: 150 };
  g.state = 'dead'; g.deathLostTo = null;              // 没死在 Boss 手上
  R.drawGameOver(g);
  const all = rec.texts.join('|');
  assert(all.indexOf('下局目标') < 0 && all.indexOf('换种搭配') < 0,
    '死亡页不许再有"下局目标/换种搭配"那种每次死都出现的常驻套话（实测："' + all + '"）');
  assert(all.indexOf('还剩') < 0, '没死在 Boss 手上时不画"还剩多少血"');
  assert(all.indexOf('长剑熟练度') >= 0, '熟练度块照旧在');

  const rec2 = recordingCtx();
  const R2 = new Renderer(rec2.ctx, { cfg: cfg, createCanvas: () => null });
  R2.resize(812, 375);
  const g2 = make();
  g2.player.mastery.sword = 150;
  g2.state = 'dead'; g2.deathLostTo = '铁甲母蟹还剩 40% 生命';
  R2.drawGameOver(g2);
  const all2 = rec2.texts.join('|');
  assert(all2.indexOf('铁甲母蟹还剩 40% 生命') >= 0,
    '死在一只 Boss 手上要写清"输在哪"（用户点名要留的真信息）');
  assert(all2.indexOf('长剑熟练度') >= 0 && all2.indexOf('等级 ') >= 0,
    '多了那行也不能把战绩/熟练度挤掉（整体下压 12~15px，仍在 DEAD_TEXT_H=132 里）');
}

console.log('PASS: 武器熟练度 —— 门槛 300/600/900 与一局 150（每级恰好两把、一把刷不满、满级几百）'
  + ' / 教学精英 15 < 精英 45 < 通关 90，一局上限 150'
  + ' / 防重领（同波次只结算一次 + 存档继续不能再领）'
  + ' / 不吃 keepOnDeath（连 none 也留，而等级/卡照旧清）'
  + ' / 老存档无字段=0、脏数据与已删武器不认'
  + ' / 叠刃 Lv3 才进卡池（长剑专属，openLevelUp 与重刷都拦）、剑阵回响 Lv2 才进掉落池'
  + ' / 满级通关有几率掉双刀（库里没有才掉，且"先入账再判奖励"）'
  + ' / 结算页与通关面板显示"当前/本级上限 + 本局获得 + 下一级解锁什么"，满级改说满级奖励，未定内容不画那半行'
  + ' / 试炼场是沙盒不练熟练度'
  + ' / 结算页是"腾位"不是"加高"（DEAD_TEXT_H 仍 132，整块装得进 812x375）'
  + ' / 首页「开局武器」面板文案跟真正发武器的地方一致（双刀 = 长剑熟练度 Lv4）');
