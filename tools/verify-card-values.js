'use strict';
/*
 * 卡片数值的两条铁律（2026-10 用户口径："卡的数值保持在一个地方吧，用这份低数值为主"）。
 *
 * 背景：`core/config.js` 末尾原来有一整块 `tune('dmg','攻击力 +8%',...)` 试炼版覆盖，
 * 同一张卡的数值写两处 —— 直接看文件读到的是 +33%（没生效的那份），实际生效的是 +8%，
 * 白查一轮。那次已经合并进定义处了，这个文件负责**不许它再长回来**，并顺手守住第二条：
 * **数值写的那一处自己不许骗人**（desc 里的数字必须和 apply 真正做的事对得上）。
 *
 * ⚠️ 本文件的期望值**全部从 desc 文字里解析出来**，不抄第二份数字 ——
 *    这样"改数值只改 config 一处"依然成立，测试只负责验证 desc 和 apply 是同一件事。
 */
const assert = require('assert'), path = require('path'), fs = require('fs');
const root = path.resolve(__dirname, '..');
const cfg = require(root + '/core/config');

/** 把一张卡（普通版或金色版）apply 到裸装上，返回每个受影响字段的增量 */
function effectOf(id, gold) {
  const u = cfg.upgrades.filter(function (x) { return x.id === id; })[0];
  assert(u, '找不到卡 ' + id);
  const def = gold ? u.rare : u;
  assert(def, id + ' 没有金色版');
  const b = {};
  for (const k in cfg.player.base) b[k] = cfg.player.base[k];
  const before = {};
  for (const k in b) before[k] = b[k];
  def.apply(b);
  const d = {};
  /* ⚠️ 有些字段裸装上根本没有（thornsMul/execute 这些"开关型"），要用 0 兜底 ——
     不然 delta = 0.4 - undefined = NaN，整个校验会静默变成"通过"。 */
  for (const k in b) {
    const bv = before[k] === undefined ? 0 : before[k];
    const av = b[k] === undefined ? 0 : b[k];
    if (av !== bv) d[k] = { delta: av - bv, base: bv, after: av };
  }
  return d;
}

/** 从 desc 里按关键词取出**紧跟其后的**第一个数字（% 与各种负号都认）。
    ⚠️ 不能按段取"第一个数字"：金色旋刃的 desc 用「、」分隔（'旋刃 +1 把、攻击力 +4%…'），
    整段只有一个逗号分隔符，按段取会把 +1 当成攻击力的数字。 */
function numNear(desc, keyword) {
  const s = String(desc).replace(/[−–—]/g, '-');
  const at = s.indexOf(keyword);
  assert(at >= 0, 'desc 里没有「' + keyword + '」：' + desc);
  const m = s.slice(at + keyword.length).match(/-?\d+(\.\d+)?/);
  assert(m, 'desc 里「' + keyword + '」后面没有数字：' + desc);
  return parseFloat(m[0]);
}

/* 每条：[卡 id, desc 里的关键词, 受影响的 stat 字段, 语义]
     pct    = desc 的百分比就是这个字段的变化率
     pctInv = desc 的百分比是"速度/频率"，字段是它的倒数（冷却、间隔）
     add    = desc 的数字就是这个字段的绝对增量
     frac   = desc 的百分比÷100 就是这个字段的绝对增量（0.04 表示 +4%） */
const CASES = [
  ['dmg', '攻击力', 'attackDamage', 'pct'],
  ['aspd', '转速', 'attackCooldown', 'pctInv'],
  ['range', '轨道半径', 'attackRange', 'pct'],
  ['blades', '旋刃', 'orbitBlades', 'add'],
  ['blades', '攻击力', 'attackDamage', 'pct'],          // 金色版：旋刃 +1、攻击力 +4%
  ['spin', '转动时长', 'orbitSpin', 'add'],
  ['retract', '收刃移速', 'orbitRetractSpd', 'frac'],
  ['hp', '生命上限', 'maxhp', 'add'],
  ['spd', '移速', 'spd', 'pct'],
  ['dash', '冲刺冷却', 'dashCooldown', 'pct'],
  ['life', '击杀回复', 'lifesteal', 'add'],
  ['thorns', '受伤时反伤', 'thornsMul', 'frac'],
  ['glass', '攻击力', 'attackDamage', 'pct'],
  ['glass', '生命上限', 'maxhp', 'pct'],
  ['giantblade', '轨道半径', 'attackRange', 'pct'],
  ['giantblade', '收刃', 'orbitRest', 'pct'],   // 2026-10：巨刃的代价从"转速 −8%"改成"收刃 +25%"（转速一变，一圈一刀就不成立）
  ['exec', '低于', 'execute', 'frac']
];
const EPS = 1e-6;
function check(gold) {
  let n = 0;
  for (const [id, kw, field, mode] of CASES) {
    const u = cfg.upgrades.filter(function (x) { return x.id === id; })[0];
    const desc = gold ? u.rare.desc : u.desc;
    const eff = effectOf(id, gold)[field];
    if (!eff) {
      /* 这一档没动这个字段：说明 desc 提了但 apply 没做（或反过来）—— 只有 blades 普通版不碰攻击力 */
      if (!(id === 'blades' && !gold)) assert(false, id + (gold ? '(金色)' : '') + ' 的 desc 提到「' + kw + '」但 apply 没动 ' + field);
      continue;
    }
    const p = numNear(desc, kw);
    let want;
    if (mode === 'add') want = eff.base + p;
    else if (mode === 'frac') want = eff.base + p / 100;
    else if (mode === 'pct') want = eff.base * (1 + p / 100);
    else if (mode === 'pctInv') want = eff.base / (1 + p / 100);
    assert(Math.abs(eff.after - want) < Math.max(EPS, Math.abs(want) * 1e-9),
      id + (gold ? '(金色)' : '') + ' 「' + kw + '」desc 写 ' + p + '（' + mode + '）→ 期望 ' + want.toFixed(4) +
      '，实际 ' + eff.after.toFixed(4) + '（desc/apply 不一致）');
    n++;
  }
  return n;
}
const nPlain = check(false), nGold = check(true);

/* ---------- 1. 低值档（用户点名的那个）：锋利 攻击力 +8%，金色 +12% ---------- */
const dmg = cfg.upgrades.filter(function (x) { return x.id === 'dmg'; })[0];
assert.equal(dmg.desc, '攻击力 +8%', '锋利必须是低值档 +8%（用户 2026-10 明确）');
assert.equal(dmg.rare.desc, '攻击力 +12%');
assert.equal(dmg.apply.toString().indexOf('1.08') > 0, true, '锋利 apply 必须是 ×1.08');

/* ---------- 2. 数值只写一处：config 里不许再有"事后覆盖"那张块 ---------- */
const src = fs.readFileSync(root + '/core/config.js', 'utf8');
assert(src.indexOf('function tune(') < 0, 'config 里不许再出现 tune(...) 这种试炼版覆盖块');
assert(src.indexOf('c.desc = desc; c.apply = apply') < 0, '卡片数值不许在定义之外再被改写');
/* 每张卡（含金色版）在文件里只出现一次 id 定义 */
const defCount = {};
cfg.upgrades.forEach(function (u) { defCount[u.id] = (defCount[u.id] || 0) + 1; });
assert(Object.keys(defCount).every(function (k) { return defCount[k] === 1; }), '卡片 id 不许重复');

/* ---------- 3. 武器专属卡 desc 的 % == 代码倍率 × 全局 0.65 ----------
   代码里 skill 伤害统一要过一次 ×0.65（damageFoe / 形状类 game.js:3437），
   所以 desc 写的是"到玩家身上"的真实值。改代码倍率就必须手改 desc —— 这里把两边钉在一起。 */
const gsrc = fs.readFileSync(root + '/core/game.js', 'utf8');
const TRIAL_SKILL_MUL = 0.65;
assert(/if \(this\.cfg\.trial\.enabled && src === 'skill'\) dmg \*= 0\.65;/.test(gsrc),
  '全局 skill 伤害 ×0.65 这条规则变了 —— desc 里的百分比要重新手算');
const WEAPON_CASES = [
  ['dagger_dash', 'skillDaggerDash', 2.0, 'S.attackDamage * 2,'],
  ['greatsword_charge', 'greatsword', 3.5, 'attackDamage * 3.5'],
  ['greatsword_quake', 'greatsword', 1.8, 'attackDamage * 1.8'],
  ['spear_pierce', 'spear', 2.2, 'attackDamage * 2.2']
];
for (const [id, , mult, snippet] of WEAPON_CASES) {
  const u = cfg.upgrades.filter(function (x) { return x.id === id; })[0];
  assert(gsrc.indexOf(snippet) > 0, '源码里找不到倍率表达式 `' + snippet + '`（' + id + '）——改了代码就要同步改这里和 desc');
  const p = numNear(u.desc, '造成');
  const want = Math.round(mult * TRIAL_SKILL_MUL * 100);
  assert.equal(p, want, id + ' 的 desc 写 ' + p + '%，代码 ' + mult + ' × ' + TRIAL_SKILL_MUL + ' = ' + want + '%');
}

/* ---------- 4. 试卡面板/属性页显示的就是同一份 desc（不是另抄一份） ---------- */
const gameSrc = fs.readFileSync(root + '/core/game.js', 'utf8');
assert(/wrapText\(ctx, gold \? u\.rare\.desc : u\.desc/.test(fs.readFileSync(root + '/render/renderer.js', 'utf8')),
  '试卡面板要直接画 config 的 desc（另抄一份文案 = 又变成两处）');

console.log('PASS: 卡片数值只有 config 一处（无 tune 覆盖块 / id 不重复）· desc 里的数字与 apply 实际效果逐条吻合（普通 ' + nPlain +
  ' 条 + 金色 ' + nGold + ' 条）· 锋利 = +8%/+12% · 武器专属卡 desc % 与代码倍率×0.65 一致（4 张）');
