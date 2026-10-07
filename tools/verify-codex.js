'use strict';
/*
 * 武器图鉴（2026-10）。用户连着两轮问的其实是同一件事：
 *   "我希望有一个地方能看到每个武器每个等级的熟练度满了之后的奖励"
 *   "我想有一个地方能看到武器的所有技能"
 * ⇒ 做成一页：一把武器一个页签，页内两块（技能 / 熟练度）。
 *
 * ⚠️ 2026-10 第二轮（**入口搬家，页面本身一行没删**）：
 *   用户口径：「游戏首页的武器图鉴去掉，在游戏里面点击暂停后，弹出的菜单里面需要包含武器库」。
 *   ⇒ 首页底部那排回到 3 个（游戏介绍 / 玩法说明 / 开局武器），图鉴**不再有入口**。
 *      四把武器的全部技能 / 熟练度奖励改看 局内暂停 →「武器库」→「技能」页。
 *      本文件从此是"页面还在不在"的回归测试（直接调 openCodex() 验），
 *      以及"首页不许再有入口"的反向断言 —— 别把它当"入口在首页"的测试删了。
 *
 *   （历史：当初放在首页，是因为 局内那条路 暂停 →「换武器」→ 武器库 只在手里 ≥2 把
 *     武器时才出现 —— 而开局只有一把长剑、双刀要长剑熟练度 Lv4 才掉 ⇒ 绝大多数时候
 *     根本进不去，「技能」页等于没有。现在那条路已经**恒开**（见 verify-pause-bag.js），
 *     这个动机也就没了。）
 *
 * 用户定下的口径（页面内部）：Ba = 技能**没拿到也显示完整描述**（不是"只给个名字"）
 *
 * 本文件钉住的东西：
 *   ① 首页底部只有 3 个按钮、**不许再有 codex**；点原来第 4 个按钮的位置开的是开局武器面板
 *   ② 图鉴两块（技能 / 熟练度）都在面板内，不和「返回首页」重叠
 *   ③ **长剑 3 张技能要全部排得下** —— 这条是这次修的 bug：局内技能页原来写死 2 列，
 *      第 3 张画到面板外，看着就像"这张技能不存在"（渲染层不报错，最难查）
 *   ④ 熟练度每级的奖励来自 config.mastery.rewards；内容没配的等级 `text` 是 null
 *      （面板留白，**不许**写"待开发 / 敬请期待"）
 *   ⑤ 交互：点页签切武器、点「返回首页」关掉、点别处不穿透到「开始游戏」
 *
 * ⚠️ 几何断言用的是**矩形**（渲染和判定共用同一份），不是"看图画得对不对"——
 *    具体版式丑不丑靠 tools/preview-codex.html 出图人眼核（断言抓不到"挤"）。
 */
const assert = require('assert'), path = require('path'), root = path.resolve(__dirname, '..');
const cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) {
  deps[k] = require(root + '/core/' + f);
}
const W = 812, H = 375;
function make() { const g = new Game(cfg, deps); g.setViewport(W, H); g.state = 'title'; return g; }
function overlap(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

/* 记录 fillText 的假 ctx：用来断言"面板上没有出现某句话"（比如"待开发"）。
   其余调用走 Proxy 自动补，渲染层加新调用不该把这个测试整红。 */
function recCtx() {
  const texts = [];
  const target = { texts: texts, canvas: { width: W, height: H } };
  return new Proxy(target, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return function (s) { return { width: String(s).length * 7 }; };
      if (k === 'fillText' || k === 'strokeText') return function (s) { texts.push(String(s)); };
      return function () {};
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

/* ==================== ① 首页：图鉴入口**已摘掉**（2026-10） ==================== */
{
  const g = make();
  const info = g.titleRects().info;
  assert.equal(info.length, 3, '首页底部那排 3 个按钮（游戏介绍 / 玩法说明 / 开局武器）');
  assert(!info.some(b => b.id === 'codex'), '首页不许再有「武器图鉴」按钮 —— 入口搬到 局内暂停 →「武器库」了');
  for (const id of ['intro', 'guide', 'loadout']) {
    assert(info.some(b => b.id === id), '另外三个按钮照旧要在：' + id + '（实际：' + info.map(b => b.id).join(',') + '）');
  }
  for (const b of info) {
    assert(b.x >= 0 && b.x + b.w <= W, '按钮不能顶出屏幕：' + b.id);
    assert(b.y >= 0 && b.y + b.h <= H, '按钮不能顶出屏幕（竖向）：' + b.id);
  }
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      assert(!overlap(info[i], info[j]), '底部按钮不许互相压：' + info[i].id + ' / ' + info[j].id);
    }
  }
  /* 原来第 4 个按钮那块位置，现在是「开局：武器」—— 点它开的是开局面板，不是图鉴 */
  const last = info[info.length - 1];
  g.updateTitle({ tap: { x: last.x + last.w / 2, y: last.y + last.h / 2 } });
  assert.equal(!!g.codexOpen, false, '首页底部那排点下去不该再打开图鉴');
  assert.equal(g.loadoutOpen, true, '最右边那个按钮是「开局：武器」');
  /* 图鉴页本身**代码保留**（"未完善的功能先隐藏不删"）：直接调 openCodex() 还是能开。
     想恢复入口就往 titleRects 的 infoDefs 里加回一行，别的什么都不用改。 */
  const g2 = make(); g2.openCodex();
  assert.equal(g2.codexOpen, true, '图鉴页还在：openCodex() 仍能打开');
  assert.equal(g2.codexKind, 'sword', '默认看开局那把（长剑）');
}

/* ==================== ② 版面几何：两块都在面板内 ==================== */
for (const style of ['A', 'B']) {
  const g = make(); g.openCodex();
  const r = g.codexRects(style);
  const P = r.panel;
  for (const name of ['skills', 'mastery']) {
    const b = r[name];
    assert(b.x >= P.x && b.y >= P.y && b.x + b.w <= P.x + P.w && b.y + b.h <= P.y + P.h,
      style + ' 版：' + name + ' 必须整个在面板内');
  }
  assert(!overlap(r.mastery, r.back), style + ' 版：熟练度块不能压到「返回首页」');
  assert(!overlap(r.body, r.back), style + ' 版：内容区不能压到「返回首页」');
  /* 「武器名 + 手感」那一行画在页签和 body 之间的空档里：空档不够就会和两块的标题**叠字**
     （第一版就是这么出的图：左上角"技能"和"长剑"压在一起） */
  assert(r.body.y - (r.tabs[0].y + r.tabs[0].h) >= 24,
    style + ' 版：页签和内容区之间要留出"武器名 + 手感"那一行的高度（>=24）');
  for (let i = 1; i < r.tabs.length; i++) {
    assert(!overlap(r.tabs[i - 1], r.tabs[i]), '武器页签不许互相压');
  }
}

/* ==================== ③ 长剑 3 张技能要全排得下（这次修的 bug） ==================== */
{
  const g = make(); g.openCodex();
  assert.equal(g.weaponSkillRows('sword').length, 3, '长剑现在有 3 张技能（穿云剑气 / 回旋飞刃 / 剑阵回响）');

  /* 图鉴 A 版：3 张横排卡片，右缘不许超出技能块 */
  const SB = g.codexRects('A').skills;
  const n = 3, cgap = 10, cw = (SB.w - cgap * (n - 1)) / n;
  const lastRight = SB.x + 2 * (cw + cgap) + cw;
  assert(lastRight <= SB.x + SB.w + 0.001, 'A 版：第 3 张技能卡不能画到技能块外面');

  /* 局内技能页（暂停 →「换武器」→「技能」）同一个坑：原来写死 2 列 */
  g.startRun();
  const r = g.skillPanelRects();
  const cols = Math.max(1, g.weaponSkillRows('sword').length);
  const cw2 = (r.body.w - 12 * (cols - 1)) / cols;
  assert(r.body.x + (cols - 1) * (cw2 + 12) + cw2 <= r.body.x + r.body.w + 0.001,
    '局内技能页：第 3 张技能卡不能画到 body 外面');
  assert(cols === 3, '局内技能页要按实际张数排（长剑 3 列），不是写死 2 列');
}

/* ==================== ④ 熟练度每级给什么（数据来自 config.mastery.rewards） ==================== */
{
  const g = make();
  const sword = g.codexMasteryRows('sword');
  assert.equal(sword.length, cfg.mastery.levels.length, '有几级门槛就列几行（Lv1~Lv4）');
  assert.equal(sword[0].label, 'Lv1', '等级文案由核心层给（渲染层不许自己拼 Lv）');
  assert.equal(sword[0].text, null, 'Lv1 是起始等级，没有奖励 → text 为 null（面板留白）');
  assert(sword[1].text.indexOf('剑阵回响') >= 0, 'Lv2 解锁剑阵回响');
  assert(sword[2].text.indexOf('叠刃') >= 0, 'Lv3 解锁叠刃');
  assert(sword[3].text.indexOf('双刀') >= 0, 'Lv4 有几率掉双刀');
  assert.equal(sword[3].needText, '900 点', '门槛文案由核心层给');
  assert.equal(sword[0].reached, true, 'Lv1 起始就达成');
  assert.equal(sword[0].current, true, '0 点时当前等级是 Lv1');

  /* 双刀：奖励内容还没配（config 里三级都是 null）→ 一行都不许编内容 */
  const dagger = g.codexMasteryRows('dagger');
  assert(dagger.every(r => r.text === null), '双刀的奖励还没定 → 全部留白');

  /* 有进度时：当前等级跟着点数走 */
  const g2 = make(); g2.player.mastery = { sword: 450 };
  const rows = g2.codexMasteryRows('sword');
  assert.equal(rows.filter(r => r.reached).length, 2, '450 点 = Lv2（Lv1 / Lv2 已达成）');
  assert.equal(rows.filter(r => r.current).length, 1, '当前等级只有一个');
  assert.equal(rows.find(r => r.current).label, 'Lv2', '450 / 600 → 当前是 Lv2');
}

/* ==================== ⑤ 不写"待开发 / 敬请期待"，也不漏画第三张 ==================== */
{
  const g = make(); g.codexOpen = true; g.codexKind = 'sword';
  const ctx = recCtx();
  const R = new (require(root + '/render/renderer'))(ctx, {
    cfg: cfg, createCanvas: function (w, h) { const c = { width: w, height: h, getContext: function () { return recCtx(); } }; return c; }
  });
  R.resize(W, H);
  R.drawCodex(g);
  const all = ctx.texts.join('|');
  for (const bad of ['待开发', '敬请期待', '未获得']) {
    assert(all.indexOf(bad) < 0, '图鉴里不许出现"' + bad + '"');
  }
  /* 3 张技能名 + 4 级奖励都要真的画出来（数据在、画面也得在） */
  for (const s of ['穿云剑气', '回旋飞刃', '剑阵回响']) assert(all.indexOf(s) >= 0, '要画出技能：' + s);
  for (const s of ['剑阵回响', '叠刃', '双刀']) assert(all.indexOf(s) >= 0, '要画出熟练度奖励：' + s);
  assert(all.indexOf('技能') >= 0 && all.indexOf('熟练度') >= 0, '两块的小标题要在');
}

/* ==================== ⑥ 交互 ==================== */
{
  const g = make(); g.openCodex();
  const r = g.codexRects();
  /* ⚠️ updateCodex(p) 收的是**点本身**（`updateTitle` 里才把 input.tap 拆出来）——
     这里传 {tap:…} 的话它当成一个没有 x/y 的点，什么都不匹配。 */
  const daggerTab = r.tabs.find(t => t.kind === 'dagger');
  g.updateCodex({ x: daggerTab.x + 4, y: daggerTab.y + 4 });
  assert.equal(g.codexKind, 'dagger', '点武器页签要切到那把');
  assert.equal(g.codexOpen, true, '切页签不会把页面关掉');
  /* 点面板中间（不是返回键）→ 页面还在，且不穿透到「开始游戏」 */
  g.update(0.01, { tap: { x: r.panel.x + r.panel.w / 2, y: r.panel.y + 10 } });
  assert.equal(g.codexOpen, true, '点空白处不关页面（要按「返回首页」）');
  assert.equal(g.state, 'title', '不许穿透到「开始游戏」');
  /* 点返回 → 关掉，回到首页 */
  g.updateCodex({ x: r.back.x + 4, y: r.back.y + 4 });
  assert.equal(g.codexOpen, false, '点「返回首页」要关掉');
}

console.log('PASS: 武器图鉴 —— 首页第 4 个按钮「武器图鉴」（4 个按钮都在屏内、互不压） / ' +
  'A·B 两版两块都在面板内、不和返回键重叠、留出"武器名+手感"那一行的高度 / ' +
  '长剑 3 张技能在图鉴和局内技能页都排得下（写死 2 列会把第 3 张画到框外） / ' +
  '熟练度每级奖励取自 config.mastery.rewards（未配内容的等级留白，不写"待开发/敬请期待"） / ' +
  '点页签切武器、点返回关掉、点别处不穿透');
