#!/usr/bin/env node
/**
 * 剑阵回响（长剑 · 熟练度 Lv2 解锁，有几率掉落）验收。
 * 用户给的设计原话："走过的路，变成你的杀招"：每完成一次普通攻击在脚下留一把虚幻小剑，
 * 三把连成三角区域，短暂预警后同时向内斩击一次；绕着怪群移动，把怪引进自己布的剑阵。
 * 用户自己定的三条限制（这里逐条守）：
 *   ① 「限制三角形最大范围」→ 超过 maxR 要整体等比压回来
 *   ② 「三把剑靠得太近时只形成小范围攻击，站着不动收益低」→ 靠在一起就是小三角、打不到远处的怪
 *   ③ 「不持续伤害、不无限留剑」→ 每只只吃一次；三把触发即清；场上最多 3 把剑 + 1 个三角
 * 攻击表现（2026-10 第 3 版，用户在 A/B/D 编排里选了 A）：
 *   「被剑阵围住的，我想换一种攻击方式，感觉现在这种不太好看」（原来那三下本质是"三道光"）
 *   → 地刺式：三角内依次炸起剑刺，**贴三条边的先冒、中心最后**，被围住的怪从下往上被穿透。
 * 另外守：预警时长、单次命中上限、换武器清场、没有技能时不攒剑、渲染有画、
 *        刺阵几何只在起阵时算一次（渲染层只读进度，不许自己算）。
 *
 * 用法：node tools/verify-sword-echo.js
 */
'use strict';
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);
const E = cfg.swordEcho;

let seed = 7717;
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

function make() { const g = new Game(cfg, deps); g.setViewport(812, 375); return g; }
/** 发技能 + "跑一帧"把 skillActiveKind 落到当前武器上。
    ⚠️ 必须先跑这一帧：updateWeaponSkills 里"武器变了就清场"那一段在**第一次**调用时就会清
    （skillActiveKind 从 null 变成 'sword'），不先热身的话刚摆好的三角会被它清掉 —— 那是
    测试脚手架的坑，不是产品 bug（真实对局里每帧都在跑，kind 早就落好了）。 */
function grant(g) { assert(g.grantSkill('sword_echo'), '把技能发到手上'); g.updateWeaponSkills(0.001); }
/** 走完整的一次普通攻击：起转 → 转完进收刃（这一步才会落剑） */
function finishAttack(g) { g.player.orbOn = true; g.player.orbT = 0; g.updateOrbit(0.016); }
function foeAt(g, x, y) {
  const f = deps.Entities.makeFoe(cfg, 'slime', x, y, 1, 1);
  f.hp = f.maxhp = 1e6; g.foes.push(f); return f;
}
/** 直接摆好三把剑的位置再起阵（跳过落剑，几何用例要可控的坐标） */
function armAt(g, pts) { g.skillEchoSwords = pts.map(p => ({ x: p[0], y: p[1] })); return g.echoArmStrike(); }
/** 把剑刺波推到底（0.02 一步，模拟真机每帧；波走完还会停留一下才清场） */
function runWave(g, steps) {
  for (let i = 0; i < (steps || 40); i++) {
    if (!g.skillEchoStrike) break;
    g.updateWeaponSkills(0.02);
  }
}

/* ==================== ⑨ 没有技能：一点都不攒 ==================== */
{
  const g = make();
  for (let i = 0; i < 5; i++) finishAttack(g);
  assert.equal((g.skillEchoSwords || []).length, 0, '没有剑阵回响的时候不落剑');
  assert(!g.skillEchoStrike, '也不会有三角');
}

/* ==================== ① 每完成一次普通攻击落一把（落在当时的脚下） ==================== */
{
  const g = make(); grant(g);
  assert.equal(g.skillEchoSwords.length, 0);
  g.player.x = 100; g.player.y = 200;
  finishAttack(g);
  assert.equal(g.skillEchoSwords.length, 1, '一次攻击完成 → 地上一把剑');
  assert.equal(g.skillEchoSwords[0].x, 100, '剑落在"攻击完成那一刻"的脚下 x');
  assert.equal(g.skillEchoSwords[0].y, 200, '同上 y');
  g.player.x = 160; g.player.y = 200;
  finishAttack(g);
  assert.equal(g.skillEchoSwords.length, 2, '第二把');
  assert.equal(g.skillEchoSwords[1].x, 160, '走位之后第二把落在新的位置上（这就是"走过的路"）');
  assert(!g.skillEchoStrike, '两把还不成阵');
}

/* ==================== ② 三把 → 进预警；预警期间不叠剑 ==================== */
{
  const g = make(); grant(g);
  armAt(g, [[0, 0], [200, 0], [100, 173]]);
  assert(g.skillEchoSwords.length === 0 && g.skillEchoStrike, '三把到齐 → 起阵（剑清空、三角出现）');
  assert.equal(g.skillEchoStrike.warn, E.warn, '预警时长 = config.swordEcho.warn');
  assert(!g.skillEchoStrike.slashed, '刚开始是预警，还没斩');
  const before = g.foes.length;
  g.player.x = 500; g.player.y = 500;
  finishAttack(g);                         // 预警期间又完成一次攻击
  assert.equal(g.skillEchoSwords.length, 0, '预警/斩击期间不再叠剑（这一段本来也不算布阵）');
  assert.equal(g.foes.length, before);
}

/* ============ ③ 剑刺波：贴边的先挨、中间的最后；阵外一点都不挨 ============ */
{
  const g = make(); grant(g);
  const edge = foeAt(g, 20, 18);             // 贴着左下那条边（离边近 → 先冒）
  const mid = foeAt(g, 120, 66);             // 质心附近（离边最远 → 最后冒）
  const outside = foeAt(g, 420, 420);        // 三角外面
  const edgeX = edge.x;
  const st = armAt(g, [[0, 0], [240, 0], [120, 208]]);
  g.updateWeaponSkills(E.warn / 2);          // 预警过半：还不该有伤害
  assert.equal(edge.hp, edge.maxhp, '预警期间不造成伤害（"短暂预警后"才炸）');
  g.updateWeaponSkills(E.warn / 2 + 0.01);   // 预警走完 → 进波（这一帧只切状态）
  assert(st.slashed && st.wave === 0, '预警走完开始走波，波从 0 起');
  assert(st.spikes.length > 0 && st.targets.length >= 2, '起阵时就把刺阵几何排好（核心层算，渲染层只读）');
  g.updateWeaponSkills(0.10);                // 波约 31%
  assert(edge.hp < edge.maxhp, '贴边的怪先挨（用户选的 A 编排：三边向内收拢）');
  assert.equal(mid.hp, mid.maxhp, '中间的怪这时候还没轮到（它是最后才冒的那根）');
  assert.equal(outside.hp, outside.maxhp, '阵外的怪一点都不挨（区域要"连成三角"，不是无脑全屏）');
  runWave(g);
  assert.equal(st.targets.filter(t => t.hit).length, 2, '波走完：被围住的两只都扎到了');
  assert.equal(st.hits.length, 2, '命中点也记了 2 个（交给渲染层画火花）');
  assert.equal(st.hits[0].x, edgeX, '先冒的那根先结账（命中点按顺序记）');
  assert(!g.skillVisuals.some(v => v.kind === 'echoLine'),
    '攻击不走 skillVisuals 的细线 —— 会和画面里的剑刺叠一起');
  /* ⑦ 一次性：不是持续伤害 */
  const hpE = edge.hp, hpM = mid.hp;
  for (let i = 0; i < 10; i++) g.updateWeaponSkills(0.1);
  assert.equal(edge.hp, hpE, '每只只吃一次，不是持续伤害（用户口径"不持续伤害"）');
  assert.equal(mid.hp, hpM, '同上');
  assert(!g.skillEchoStrike, '波 + 停留走完 → 整块清掉（不留在场上）');
}

/* ==================== ④ 单次命中上限 ==================== */
{
  const g = make(); grant(g);
  const foes = [];
  for (let i = 0; i < 20; i++) foes.push(foeAt(g, 100 + (i % 5) * 8, 80 + Math.floor(i / 5) * 8));
  const st = armAt(g, [[0, 0], [240, 0], [120, 208]]);
  g.updateWeaponSkills(E.warn + 0.01);
  runWave(g);
  const hit = foes.filter(f => f.hp < f.maxhp).length;
  assert.equal(hit, E.maxHits, '单次最多命中 maxHits 处（防一波怪群被秒清），实测 ' + hit);
  assert.equal(st.hits.length, E.maxHits, '交给渲染层的命中点也不会超过上限');
  assert.equal(st.targets.length, E.maxHits, '目标在起阵那一刻锁定，波走一半也不会又多冒出来');
}

/* ==================== ① 三角超过 maxR → 整体等比压回来 ==================== */
{
  const g = make(); grant(g);
  const st = armAt(g, [[0, 0], [600, 0], [300, 520]]);     // 很大
  const k = Math.max(...st.tri.map(p => Math.hypot(p.x - st.cx, p.y - st.cy)));
  assert(Math.abs(k - E.maxR) < 1e-9, '超过 maxR 的三角要被压到 maxR=' + E.maxR + '（实测顶点离质心 ' + k.toFixed(2) + '）');
  const small = armAt(g, [[0, 0], [60, 0], [30, 52]]);     // 小三角：不能被放大
  const k2 = Math.max(...small.tri.map(p => Math.hypot(p.x - small.cx, p.y - small.cy)));
  assert(k2 < E.maxR && Math.abs(k2 - 34.6) < 0.5, '小三角保持原样（**不做最小值放大**，这是"站着不动收益低"的实现）');
}

/* ==================== ② 三把靠太近 → 小范围，打不到远处 ==================== */
{
  const g = make(); grant(g);
  const far = foeAt(g, 140, 0);              // 离得比较远的怪
  armAt(g, [[100, 100], [106, 100], [103, 105]]);   // 三把剑几乎叠在一起
  g.updateWeaponSkills(E.warn + 0.01);
  runWave(g);
  assert.equal(far.hp, far.maxhp, '站着不动 → 三把剑挤在一起 → 小的打不到远处的怪（用户口径"收益低"）');
  const g2 = make(); grant(g2);
  const near = foeAt(g2, 103, 101);          // 就在小三角里
  armAt(g2, [[100, 100], [106, 100], [103, 105]]);
  g2.updateWeaponSkills(E.warn + 0.01);
  runWave(g2);
  assert(near.hp < near.maxhp, '但正踩在阵里的还是会被扎到（小范围 ≠ 完全无效）');

  /* ⚠️⚠️ 上面这一节以前是**假绿**：它用的是"偏 6px"的非退化小三角，正好绕开了退化边界。
     真正的"站着不动"是三把剑落在**同一个坐标**（面积正好 0）—— 那时候点判定的三条边符号
     全是 0，`!(neg && pos)` 对**平面上任何一点**都返回 true ⇒ 全图每只怪都被算进阵里。
     用户报的「我如果站着不动, 剑阵的刺会攻击所有人」就是这个（2026-10）。 */
  const g3 = make(); grant(g3);
  g3.player.x = 1000; g3.player.y = 1000;    // 玩家站远处，别干扰下面那堆怪
  const crowd = [];
  for (let i = 0; i < 8; i++) crowd.push(foeAt(g3, 200 + i * 120, 300 + (i % 3) * 150));
  armAt(g3, [[100, 100], [100, 100], [100, 100]]);   // 三点完全重合 = 站着不动
  const st3 = g3.skillEchoStrike;
  assert(st3, '退化三角照常起阵（"三把到齐就起阵"这个流程不变）');
  assert.equal(st3.spikes.length, 0, '退化三角一根刺都不排（实测 ' + st3.spikes.length + ' 根）');
  assert.equal(st3.targets.length, 0, '也不锁任何目标（全图 8 只怪一只都不该算进阵里）');
  g3.updateWeaponSkills(E.warn + 0.01);
  runWave(g3);
  assert(crowd.every(f => f.hp === f.maxhp), '波走完，全图 8 只怪一点血都没掉（"攻击所有人"已修）');

  /* 偏 1px：不是退化（面积 0.5）但极小 —— 行为要和退化三角**连续**（都打不到远处的怪） */
  const g4 = make(); grant(g4);
  g4.player.x = 1000; g4.player.y = 1000;
  const far4 = foeAt(g4, 800, 800);
  armAt(g4, [[100, 100], [101, 100], [100, 101]]);
  g4.updateWeaponSkills(E.warn + 0.01);
  runWave(g4);
  assert.equal(far4.hp, far4.maxhp, '偏 1px 的小三角同样打不到远处的怪（退化与非退化行为连续）');
}

/* ==================== ⑧ 换武器清场 ==================== */
{
  const g = make(); grant(g);
  armAt(g, [[0, 0], [200, 0], [100, 173]]);
  assert(g.skillEchoStrike, '先有个三角在预警');
  const w = deps.Progression.makeDefaultWeapon(cfg); w.kind = 'staff'; w.id = 'staff-x';
  g.player.bag.push(w); g.switchWeapon(g.player.bag.length - 1);
  g.updateWeaponSkills(0.016);               // 换武器后的第一帧：skillActiveKind 变了 → 清场
  assert.equal(g.skillEchoSwords.length, 0, '换走长剑 → 地上的剑清掉');
  assert(!g.skillEchoStrike, '预警中的三角也要清（不然切走武器它还在原地替你把怪斩了）');
}

/* ==================== 换关也要清场 ==================== */
{
  const g = make(); grant(g);
  armAt(g, [[0, 0], [200, 0], [100, 173]]);
  g.skillEchoSwords = [{ x: 1, y: 2 }];
  g.enterStage(1);
  assert.equal(g.skillEchoSwords.length, 0, '进新关不背上一关的阵');
  assert(!g.skillEchoStrike);
}

/* ==================== ⑩ 渲染：布阵 / 预警（V2：真剑形 + 落地扬尘 + 阵纹 + 短刺 + 碎刃） ==================== */
{
  const Renderer = require(root + '/render/renderer.js');
  const ops = { ellipse: 0, arc: 0, stroke: 0, fill: 0, clip: 0 };
  const base = {
    ellipse: () => { ops.ellipse++; }, arc: () => { ops.arc++; },
    stroke: () => { ops.stroke++; }, fill: () => { ops.fill++; }, clip: () => { ops.clip++; },
    fillText: () => {}, measureText: (s) => ({ width: String(s).length * 6 }),
    canvas: { width: 812, height: 375 }
  };
  const ctx = new Proxy(base, {
    get: (t, k) => (k in t) ? t[k] : (typeof k === 'string' ? function () {} : undefined),
    set: (t, k, v) => { t[k] = v; return true; }
  });
  const R = new Renderer(ctx, { cfg: cfg, createCanvas: () => null });
  R.resize(812, 375);
  const reset = () => { ops.ellipse = 0; ops.arc = 0; ops.stroke = 0; ops.fill = 0; ops.clip = 0; };

  const g = make(); grant(g);
  R.drawWeaponSkills(g);
  assert.equal(ops.ellipse + ops.arc + ops.stroke + ops.fill, 0,
    '没布阵的时候一个特效都不画（别给所有玩家都挂东西）');

  /* 刚落地的两把剑：每把 = 1 片地面微光 + 1 圈落地涟漪（ellipse 2）+ 6 粒扬尘（arc 6） */
  g.player.x = 100; g.player.y = 200;
  finishAttack(g);
  g.player.x = 200; g.player.y = 200;
  finishAttack(g);
  assert.equal(g.skillEchoSwords[0].t, 0, '落剑时核心层给 t=0，渲染层靠它算落地进度（渲染层不自己计时）');
  reset(); R.drawWeaponSkills(g);
  assert.equal(ops.ellipse, 4, '两把刚落地的剑：各 1 片地面微光 + 1 圈落地涟漪（实测 ' + ops.ellipse + '）');
  assert.equal(ops.arc, 12, '两把剑各 6 粒扬尘（实测 ' + ops.arc + '）');
  g.skillEchoSwords[0].t = 1; g.skillEchoSwords[1].t = 1;   // 假装落地那一下早就过去了
  reset(); R.drawWeaponSkills(g);
  assert.equal(ops.ellipse, 2, '过时之后只剩两片地面微光，涟漪收掉（实测 ' + ops.ellipse + '）');
  assert.equal(ops.arc, 0, '扬尘也不再冒（不是一直在喷）');

  /* 预警：三把剑亮起来 + 阵纹（裁在三角里）+ 边框 + 短刺 + 顶点碎刃 */
  /* ⚠️ 怪必须在**起阵之前**就在场上 —— 刺阵和目标都是起阵那一刻锁定的
     （第一版我把 foeAt 写在 armAt 后面，结果那只怪压根没进目标表，白挨不到）。 */
  const inFoe = foeAt(g, 20, 14);            // 贴着边 → 波走到 ~38% 时它已经被扎了
  armAt(g, [[0, 0], [200, 0], [100, 173]]);
  reset(); R.drawWeaponSkills(g);
  assert.equal(ops.ellipse, 3, '预警中：三把剑各有一小片地面微光（实测 ' + ops.ellipse + '）');
  assert.equal(ops.clip, 1, '阵纹（斜线）必须被裁在三角里（实测 clip ' + ops.clip + ' 次）');
  assert(ops.stroke >= 60, '三角边框 + 三把剑 + 边框短刺 + 顶点碎刃都要描出来（实测 ' + ops.stroke + ' 次 stroke）');
  assert.equal(ops.arc, 0, '预警阶段不画圆点粒子（碎刃是短线）');

  /* 剑刺波：三把残剑 + 三角残影 + 每根刺"被顶开的坑" + 被扎住的怪身上火花/脚下圈 */
  g.updateWeaponSkills(E.warn + 0.01);       // 进波（wave=0）
  g.updateWeaponSkills(0.12);                // 波约 38%：靠边的刺已经冒头并扎到了
  const st2 = g.skillEchoStrike;
  assert(inFoe.hp < inFoe.maxhp, '（前置）贴边那只已经被扎到');
  const sp = st2.spikes;
  assert(sp.length > 4, '刺阵要排出一片刺（实测 ' + sp.length + ' 根）');
  const rose = sp.filter(s => s.p > 0).length;                              // 已经冒头的
  const precue = sp.filter(s => s.p <= 0 && (s.lead || 0) > -0.18).length;  // 土刚鼓起、还没冒的
  const hits = st2.hits.length;
  reset(); R.drawWeaponSkills(g);
  assert.equal(ops.ellipse, 3 + rose * 2 + precue + hits,
    '三把残剑的地面微光(3) + 每根冒头的刺"坑+坑沿"(2) + 快冒的土包(1) + 被扎怪脚下的圈(1)'
    + '（实测 ' + ops.ellipse + '）');
  assert(ops.arc >= 9 * hits, '被扎住的怪身上要有放射火花（实测 arc ' + ops.arc + '）');
  assert(ops.stroke >= rose * 2, '每根冒头的刺都要描出来（实测 stroke ' + ops.stroke + '）');
  assert.equal(ops.clip, 0, '波阶段不再画阵纹（阵纹只属于预警那一段）');
  for (let i = 0; i < 40; i++) g.updateWeaponSkills(0.05);   // 波 + 停留走完
  reset(); R.drawWeaponSkills(g);
  assert.equal(ops.ellipse + ops.arc + ops.stroke + ops.fill, 0,
    '特效时间到了就什么都不画（不在屏幕上留残影）');
}

/* ============ ⑪ 刺阵几何：只在起阵时算一次；角色脚下不冒刺；最后一根也冒得出来 ============ */
{
  const g = make(); grant(g);
  g.player.x = 120; g.player.y = 70;         // 角色站在三角中间（质心附近）
  const st = armAt(g, [[0, 0], [240, 0], [120, 208]]);
  assert(st.spikes.length > 4, '三角内要排出一片刺（实测 ' + st.spikes.length + ' 根）');
  const tooNear = st.spikes.filter(s => Math.hypot(s.x - g.player.x, s.y - g.player.y) <= E.spikeGap);
  assert.equal(tooNear.length, 0, '角色脚下不冒刺（阵不扎自己人）；实测最近 ' +
    Math.min(...st.spikes.map(s => Math.hypot(s.x - g.player.x, s.y - g.player.y))).toFixed(1) + 'px');
  const maxDelay = Math.max(...st.spikes.map(s => s.delay));
  assert(maxDelay + E.spikeRise <= 1.0001,
    '最晚那根的 delay + rise 不能超过 1，否则它永远冒不出来（实测 ' + (maxDelay + E.spikeRise).toFixed(3) + '）');
  assert(st.spikes.every(s => s.delay >= 0 && s.p === 0), '刚起阵时全是没冒的（p=0）');
  /* 刺的位置是**一次算好**的：波走一半也不能变（不然刺会在怪脚下飘） */
  const snapshot = st.spikes.map(s => s.x + ',' + s.y).join('|');
  g.updateWeaponSkills(E.warn + 0.01); g.updateWeaponSkills(0.15);
  assert.equal(st.spikes.map(s => s.x + ',' + s.y).join('|'), snapshot, '波走到一半，刺的位置一个都没动');
}

/* ==================== 配置与卡定义 ==================== */
{
  const card = cfg.upgrades.filter(u => u.id === 'sword_echo')[0];
  assert(card && card.weapon === 'sword', '剑阵回响是长剑的技能卡');
  assert.equal(card.masteryMin, 2, '熟练度 Lv2 才进掉落池');
  assert.equal(E.maxSwords, 3, '三把成阵');
  assert(E.maxR > 0 && E.warn > 0 && E.dmgMul > 0 && E.maxHits > 0, '参数齐全（别留 0 或 undefined）');
  /* 尺寸全在 config，渲染层不留写死的数字 */
  ['swordH', 'swordW', 'hatchStep', 'hatchAlpha', 'edgeW', 'edgeAlpha', 'tickLen', 'tickW',
    'shardLen', 'landT', 'dustColor', 'spikeH', 'spikeW', 'spikeStep', 'spikeMargin',
    'spikeGap', 'spikeSnap', 'spikeTime', 'spikeRise', 'spikeHitP', 'spikeHit', 'spikeRingR',
    'holeDark', 'holeRim', 'clodColor'].forEach(k => {
      assert(E[k] !== undefined && E[k] !== null,
        'config.swordEcho 要有 ' + k + '（视觉参数一律进 config，不许写死在渲染层）');
    });
  assert(E.tick !== false && E.shardBurst !== false && E.dust !== false && E.spikeRing !== false,
    '预警那几样 + 被扎怪脚下那圈默认都是开的');
  /* 换成地刺式之后，第 2 版"锥形刀光 + 中心光斑"那套参数必须**删干净**：
     留着就是死参数，下一个人会以为还在用（而且一看就知道现在攻击不是那套了）。 */
  ['bladeW', 'bladeBack', 'bladeOver', 'bladeHalo', 'coreFlash', 'coreWhite'].forEach(k => {
    assert(E[k] === undefined, 'config.swordEcho 不该再有 ' + k + '（锥形刀光的参数，已随地刺式删掉）');
  });
}

console.log('PASS: 剑阵回响 —— 每完成一次普通攻击在脚下落一把剑（走位决定落点）'
  + ' / 三把连成三角 → 预警 ' + E.warn + 's → 剑刺波 ' + E.spikeTime + 's 走完'
  + ' / 攻击 = 地刺式（用户选的 A 编排：三边向内收拢）：贴边的先冒、中间最后，'
  + '被围住的怪从下往上被穿透（阵外的一点都不挨）'
  + ' / 三角超过 ' + E.maxR + 'px 等比压回来，小三角不做放大（站着不动收益低）'
  + ' / 单次最多命中 ' + E.maxHits + ' 处 / 每只只吃一次、走完即清、场上最多 3 把剑'
  + ' / 换武器与进新关都清场 / 没这个技能不攒剑'
  + ' / 预警渲染：真剑形(高' + E.swordH + 'px) + 落地扬尘 + 阵纹 + 短刺 + 顶点碎刃'
  + ' / 波渲染：被顶开的坑 + 剑刃 + 命中火花（尺寸全走 config，渲染层只读进度）');
