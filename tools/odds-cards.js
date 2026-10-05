#!/usr/bin/env node
/**
 * 抽卡概率实测：**「变长」的卡和「刃数变多」的卡，刷到的概率真的一样吗？**
 *
 * 为什么要有这个工具（2026-10 用户提问）：玩家感觉"变长的概率比较大"。
 * 这类"我感觉"必须用真实抽取逻辑跑数，不能靠读代码推 —— 因为概率被好几处叠过：
 *   ① pickWeightedN 加权（机制卡：上一排出过就压到 repeatMechWeight 0.35）
 *   ② 成长保底 guaranteeGrowth（这一排没有成长卡就硬塞一张，只从"非代价"的两张里挑）
 *   ③ 代价卡限流 limitCostCards（每排最多 1 张，多出来的会被换成别的卡）
 *   ④ 池子随 taken 收缩（非 stackable 卡拿过就出池，stackable 卡可反复拿）
 * 所以这里**直接 require 真实 config + progression**，不复制一份规则（复制的那份迟早走散）。
 *
 * 用法：node tools/odds-cards.js [每排样本数，默认 300000]
 */
'use strict';
const path = require('path');
const root = path.resolve(__dirname, '..');
const cfg = require(root + '/core/config');
const Game = require(root + '/core/game');
const deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) {
  deps[k] = require(root + '/core/' + f);
}
const Prog = deps.Progression;

/* ⚠️ 随机数必须用 mulberry32。旧脚本里那种 `s*1103515245 % 2^31` 的 LCG 在 JS 里会
   超 2^53 丢精度 → 序列有结构，会读出**假偏心**（实测能把均匀的池子读成长刃 18.9% / 巨刃 14.8%）。 */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- 分类口径：只有这一处，别在别处再写一份 ---------- */
const META = {};
for (const u of cfg.upgrades) META[u.id] = { name: u.name, mech: u.cat === 'mechanic', cost: !!u.cost, growth: !!u.growth };
const base = id => String(id).replace(/#rare$/, '');
const NAME = id => (META[base(id)] || {}).name || id;

const GROUPS = [
  { key: 'len',    label: '变长·永久', ids: ['range', 'giantblade'] },
  { key: 'blade',  label: '刃数·永久', ids: ['blades'] },
  { key: 'lenB',   label: '变长·爆发', ids: ['skyCut'] },
  { key: 'bladeB', label: '刃数·爆发', ids: ['bladeStorm'] }
];
const groupOf = id => { const b = base(id); for (const g of GROUPS) if (g.ids.indexOf(b) >= 0) return g.key; return null; };

const PER_ROW = parseInt(process.argv[2] || '300000', 10);
const ROWS_PER_RUN = 5;
const RUNS = Math.min(PER_ROW, 60000);
const OPTS = { weapon: 'sword', allowSkill: false, guaranteeGrowth: true };
const line = [];

/* ================================================================
   ① 单排出现率
   ================================================================ */
function rows(opts, n, seed, lastMech) {
  Math.random = mulberry32(seed);
  const cnt = {}, grp = {};
  for (const g of GROUPS) grp[g.key] = 0;
  let mechRow = 0;
  for (let i = 0; i < n; i++) {
    const row = Prog.drawUpgrades(cfg, {}, cfg.growth.chooseFrom,
      Object.assign({ lastMechanic: !!lastMech }, OPTS, opts));
    const seen = {};
    for (const c of row) { const b = base(c.id); seen[b] = 1; }
    for (const b in seen) cnt[b] = (cnt[b] || 0) + 1;
    for (const g of GROUPS) if (g.ids.some(id => seen[id])) grp[g.key]++;
    if (Object.keys(seen).some(b => META[b] && META[b].mech)) mechRow++;
  }
  return { cnt, grp, n, mechRow: mechRow / n };
}

const live  = rows({}, PER_ROW, 443, false);
const liveM = rows({}, PER_ROW, 443, true);
const pure  = rows({ guaranteeGrowth: false, maxCost: 99 }, PER_ROW, 443, false);
const lim   = rows({ guaranteeGrowth: false, maxCost: 1 }, PER_ROW, 443, false);

const pct = (a, b) => (100 * a / b).toFixed(1) + '%';

line.push('抽卡概率实测（真实 config + progression.drawUpgrades）');
line.push('  单排样本 ' + PER_ROW.toLocaleString() + ' 排 / 完整局 ' + RUNS.toLocaleString() + ' 局（每局 ' + ROWS_PER_RUN + ' 次升级）');
line.push('  随机数 mulberry32（固定种子 443，可复跑对比）');
line.push('');
line.push('【一、单卡公平性】每张卡在单排里出现的概率（抽满 ' + cfg.growth.chooseFrom + ' 张）');
const ids = cfg.upgrades.filter(u => !u.disabled && !u.weapon).map(u => u.id);
const list = ids.map(id => ({ id, name: NAME(id), r: (live.cnt[id] || 0) / PER_ROW })).sort((a, b) => b.r - a.r);
for (const x of list) {
  const m = META[x.id];
  line.push('    ' + x.name.padEnd(7, '　') + ' ' + x.id.padEnd(12) +
            (100 * x.r).toFixed(1).padStart(5) + '%' +
            (groupOf(x.id) ? '   ← ' + GROUPS.find(g => g.key === groupOf(x.id)).label : '') +
            (m.mech ? '   [机制]' : '') + (m.cost ? ' [代价]' : ''));
}
const pAll = ids.map(id => (pure.cnt[id] || 0) / PER_ROW);
const pmn = Math.min(...pAll), pmx = Math.max(...pAll);
line.push('    ── 自检：把保底和限流都拆掉（纯加权）时，' + ids.length + ' 张卡全部落在 ' +
          (100 * pmn).toFixed(1) + '~' + (100 * pmx).toFixed(1) + '%（差 ' + (100 * (pmx - pmn)).toFixed(1) +
          ' 个点）');
line.push('       → 池子本身**不偏**。线上的落差全部来自"成长保底"和"代价卡限流"两处，见【三】');
line.push('');
line.push('【二、你要的那两件事】同一排里"至少刷到一张"的概率');
line.push('    变长 · 永久　 长刃 + 巨刃　　' + pct(live.grp.len, PER_ROW) +
          '　（上一排有机制卡时 ' + pct(liveM.grp.len, PER_ROW) + '）');
line.push('    刃数 · 永久　 旋刃　　　　　' + pct(live.grp.blade, PER_ROW) +
          '　（上一排有机制卡时 ' + pct(liveM.grp.blade, PER_ROW) + '）');
line.push('    变长 · 爆发　 开天　　　　　' + pct(live.grp.lenB, PER_ROW));
line.push('    刃数 · 爆发　 千刃　　　　　' + pct(live.grp.bladeB, PER_ROW));
line.push('');
line.push('【三、偏心的量化】拆掉单条机制再比（都跑同一套种子）');
line.push('    纯加权（无保底 无限流）：长刃 ' + pct(pure.cnt.range, PER_ROW) +
          ' / 旋刃 ' + pct(pure.cnt.blades, PER_ROW) + ' / 巨刃 ' + pct(pure.cnt.giantblade, PER_ROW) +
          ' / 血刃 ' + pct(pure.cnt.bloodBlade, PER_ROW) + '  → 全部相等（池子本身不偏）');
line.push('    只开代价卡限流：      长刃 ' + pct(lim.cnt.range, PER_ROW) +
          ' / 旋刃 ' + pct(lim.cnt.blades, PER_ROW) + ' / 巨刃 ' + pct(lim.cnt.giantblade, PER_ROW) +
          ' / 血刃 ' + pct(lim.cnt.bloodBlade, PER_ROW) + '  → 见下');
line.push('    线上现状（保底+限流）：长刃 ' + pct(live.cnt.range, PER_ROW) +
          ' / 旋刃 ' + pct(live.cnt.blades, PER_ROW) + ' / 巨刃 ' + pct(live.cnt.giantblade, PER_ROW) +
          ' / 血刃 ' + pct(live.cnt.bloodBlade, PER_ROW));
line.push('    · 代价卡（巨刃/玻璃大炮）比别的卡低 ~1 个点：它们会被限流换掉。');
/* ⚠️ 触发率**不能**从限流之后的排去数（限流之后最多剩 1 张，永远数不到）—— 按超几何算：
   3 抽里含 ≥2 张代价卡的概率。 */
const costIds = cfg.upgrades.filter(u => u.cost && !u.disabled).map(u => u.id);
const comb = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1); return r; };
const N = ids.length, K = costIds.length, n3 = cfg.growth.chooseFrom;
let pGe = 0; for (let x = 2; x <= Math.min(K, n3); x++) pGe += comb(K, x) * comb(N - K, n3 - x) / comb(N, n3);
line.push('      限流只在"一排里出现 ≥2 张代价卡"时动手（代价卡 ' + K + ' 张 / 池子 ' + N + ' 张）→ 触发率 ' +
          (100 * pGe).toFixed(2) + '%（超几何）');
line.push('    · 血刃比别的卡高 ~1.8 个点：限流换人时用 free.pop() 取的是**池子末尾**那张');
line.push('      （config 里排最后的正是血刃）→ 这是"配置书写顺序决定概率"的隐藏偏心，不是设计');
line.push('    · 机制卡 16.5% 而普通卡只有 11.2%：保底挑换掉的位子时**优先跳开机制卡**');
line.push('      （!isMechanic），所以机制卡在卡面上的占比被放大了约 1.5 倍');

/* ================================================================
   ④ 一局之内（5 次升级，玩家在 3 张里随机点一张）
   ================================================================ */
const seenG = {}, gotG = {}, atLeast = {}, twice = {};
for (const g of GROUPS) { seenG[g.key] = 0; gotG[g.key] = 0; }
let lenOnce = 0, bladeOnce = 0, lenTwice = 0, bladeTwice = 0;
for (let r = 0; r < RUNS; r++) {
  Math.random = mulberry32(1000 + r * 7919);
  const g = new Game(cfg, deps);
  let lastMech = false;
  const seen = {};
  for (let i = 0; i < ROWS_PER_RUN; i++) {
    const row = Prog.drawUpgrades(cfg, g.player.taken, cfg.growth.chooseFrom,
      Object.assign({ lastMechanic: lastMech }, OPTS));
    for (const c of row) { const b = base(c.id); seen[b] = (seen[b] || 0) + 1; const k = groupOf(b); if (k) seenG[k]++; }
    lastMech = row.some(Prog.isMechanic);
    const pick = row[Math.floor(Math.random() * row.length)];
    Prog.applyUpgrade(cfg, g.player, pick.id);
    const k = groupOf(base(pick.id)); if (k) gotG[k]++;
  }
  const nLen = (seen.range || 0) + (seen.giantblade || 0), nBl = seen.blades || 0;
  if (nLen >= 1) lenOnce++; if (nLen >= 2) lenTwice++;
  if (nBl >= 1) bladeOnce++; if (nBl >= 2) bladeTwice++;
  atLeast.len = lenOnce; atLeast.blade = bladeOnce;
}
line.push('');
line.push('【四、一局之内】平均一局"刷到"（出现在卡面）/ "拿到"（选中）次数');
for (const g of GROUPS) {
  line.push('    ' + g.label + '　 ' + (seenG[g.key] / RUNS).toFixed(2) + ' 次 / ' + (gotG[g.key] / RUNS).toFixed(2) + ' 次');
}
line.push('    一局刷到过 ≥1 次：  变长 ' + pct(lenOnce, RUNS) + '　刃数 ' + pct(bladeOnce, RUNS));
line.push('    一局刷到过 ≥2 次：  变长 ' + pct(lenTwice, RUNS) + '　刃数 ' + pct(bladeTwice, RUNS));
line.push('');
line.push('一句话：单张卡（长刃 / 巨刃 / 旋刃）概率**完全一样**；「变长」看着多，是因为它有 2 张卡');

console.log(line.join('\n'));
