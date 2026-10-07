'use strict';
/*
 * 暂停面板 →「武器库」（2026-10）。
 *
 * 用户口径（原话）：「game1小游戏首页的武器图鉴去掉，在游戏里面点击暂停后，弹出的菜单里面
 * 需要包含一下武器库吧」。配套定下的两条：
 *   · 关掉武器库回**暂停面板**（不是直接接着打）
 *   · 音乐/音效/震动 三行并成一行三个小开关（给「武器库」腾高度 —— 否则出屏）
 *
 * 这个文件钉住的是**入口本身**；武器库面板内部的技能页 / 熟练度页见 ⑦（2026-10 拆成两页），
 * 图鉴页没删（只是没入口）看 verify-codex.js。
 *
 * 本文件钉住的东西：
 *   ① 第一行就是「武器库」，且**恒显** —— 一把武器时也在（以前是 ≥2 把才出现）
 *   ② 点「武器库」→ state='bag'；关掉 → **回到 paused**；一把武器时同样能开
 *   ③ 面板几何：横屏 812x375（真机比例）/ 刘海机 / iPhone SE 320x568，整块 + 每行 + 每个子开关都不出屏
 *   ④ 开关行：三个子开关（音乐/音效/震动）各自的矩形都在那一行里、互不重叠，
 *      命中只切**自己那一个**设置；点两个开关之间的空隙什么也不该发生（那一行本身不是按钮）
 *   ⑤ 渲染层真的画了（真渲染器 + 假 ctx）：三个开关的"开/关"字样要出现
 *
 * ⚠️ 几何断言用的是矩形（渲染和判定共用同一份）。版式丑不丑靠
 *    `bash tools/shot-boss.sh pause` 出图人眼核 —— 断言抓不到"挤/丑"。
 */
const assert = require('assert'), path = require('path'), root = path.resolve(__dirname, '..');
const cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) {
  deps[k] = require(root + '/core/' + f);
}
const W = 812, H = 375;
const NOINS = { top: 0, left: 0, right: 0, bottom: 0 };
const NOTCH = { top: 0, left: 44, right: 44, bottom: 21 };   // 横屏刘海机

function make(w, h, ins) {
  const g = new Game(cfg, deps);
  g.setViewport(w || W, h || H, ins || NOINS);
  g.state = 'play';
  return g;
}
function overlap(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
function switchRow(g) { return g.pauseRects().rows.find(r => r.kind === 'switches'); }

/* 记录 fillText 的假 ctx：既收文本（断言"画了哪些字"），也收**坐标 + 当时的字体**
   （断言"文字没有越过卡片/面板的框"—— 武器库卡片第 3 行技能名越过下边框那个老 bug 就是这么抓的）。
   其余调用走 Proxy 自动补，渲染层加新调用不该把这个测试整红。 */
function recCtx() {
  const texts = [], calls = [];
  const target = { texts: texts, calls: calls, canvas: { width: W, height: H },
                   font: '10px x', textAlign: 'left', textBaseline: 'alphabetic' };
  return new Proxy(target, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return function (s) { return { width: String(s).length * 7 }; };
      if (k === 'fillText' || k === 'strokeText') return function (s, x, y) {
        texts.push(String(s));
        calls.push({ text: String(s), x: x, y: y, font: t.font, align: t.textAlign, baseline: t.textBaseline });
      };
      return function () {};
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function fontSize(call) {
  const m = /([\d.]+)px/.exec(String(call.font || ''));
  return m ? parseFloat(m[1]) : 11;
}
/* 一行字在屏幕上的上下缘（按当时的 textBaseline 反推） */
function vExtent(call) {
  const s = fontSize(call);
  if (call.baseline === 'middle') return [call.y - s / 2, call.y + s / 2];
  if (call.baseline === 'top') return [call.y, call.y + s];
  return [call.y - s * 0.8, call.y + s * 0.2];        // alphabetic（默认）
}
function textsAt(ctx, str) { return ctx.calls.filter(c => c.text === str); }
function uniq(arr) { return arr.filter(function (v, i) { return arr.indexOf(v) === i; }); }

/* ==================== ① 第一行是「武器库」，恒显 ==================== */
{
  for (const [label, bagLen] of [['开局只有一把武器', 1], ['手里两把武器', 2]]) {
    const g = make(); g.pause();
    if (bagLen >= 2) {
      const second = deps.Progression.makeDefaultWeapon(cfg);
      second.id = 'pb-w2'; second.kind = 'spear';
      g.player.bag = [g.player.bag[0], second];
    }
    const rows = g.pauseRects().rows;
    assert.equal(rows[0].id, 'bag', label + '：暂停面板第一行必须是「武器库」（实际第一行是 ' + rows[0].id + '）');
    assert.equal(rows[0].label, '武器库', label + '：那一行文案 = 武器库');
    assert.equal(rows.map(r => r.id).join(','), 'bag,resume,restart,home,switches',
      label + '：面板行序 = 武器库/继续/重新开始/回首页/开关行（实际 ' + rows.map(r => r.id).join(',') + '）');
  }
}

/* ==================== ② 点它 → bag；关掉 → 回暂停面板 ==================== */
{
  for (const bagLen of [1, 2]) {
    const g = make(); g.pause();
    if (bagLen >= 2) {
      const second = deps.Progression.makeDefaultWeapon(cfg);
      second.id = 'pb-w2b'; second.kind = 'spear';
      g.player.bag = [g.player.bag[0], second];
    }
    const bagRow = g.pauseRects().rows[0];
    g.pauseGuard = 0;
    g.updatePaused({ tap: { x: bagRow.x + 5, y: bagRow.y + 5 } });
    assert.equal(g.state, 'bag', bagLen + ' 把武器时点「武器库」都要能进武器库');
    assert.equal(g.bagReturnState, 'paused', '要记住"从暂停面板开出来的"');
    g.bagGuard = 0;
    g.closeBag();
    assert.equal(g.state, 'paused', '关掉武器库要**回暂停面板**（用户口径），不是直接接着打');
    assert(g.pauseGuard > 0, '关掉那一下要立 pauseGuard，否则同一根手指会点到面板上');
  }
}

/* ==================== ③ 面板几何：三种视口都不出屏 ==================== */
{
  const views = [[812, 375, NOTCH, '横屏刘海机 812x375'], [812, 375, NOINS, '横屏无安全区 812x375'],
                 [320, 568, NOINS, 'iPhone SE 320x568'], [375, 812, NOINS, '竖屏 375x812（容错）']];
  for (const [w, h, ins, name] of views) {
    for (const bagLen of [1, 2]) {
      const g = make(w, h, ins);
      if (bagLen >= 2) {
        const second = deps.Progression.makeDefaultWeapon(cfg);
        second.id = 'pb-w2c'; second.kind = 'spear';
        g.player.bag = [g.player.bag[0], second];
      }
      g.pause();
      const R = g.pauseRects(), tag = name + ' / ' + bagLen + ' 把武器 / ';
      assert(R.panel.y >= 0, tag + '面板顶部出屏（y=' + R.panel.y + '）');
      assert(R.panel.y + R.panel.h <= h, tag + '面板底部出屏（底=' + (R.panel.y + R.panel.h) + ' > ' + h + '）');
      for (const row of R.rows) {
        assert(row.y >= R.panel.y && row.y + row.h <= R.panel.y + R.panel.h,
          tag + '行「' + row.id + '」超出面板（行 ' + row.y + '~' + (row.y + row.h) +
          ' / 面板 ' + R.panel.y + '~' + (R.panel.y + R.panel.h) + '）');
        assert(row.x >= R.panel.x && row.x + row.w <= R.panel.x + R.panel.w, tag + '行「' + row.id + '」横向超出面板');
      }
    }
  }
}

/* ==================== ④ 开关行：三个子开关各自的矩形与命中 ==================== */
{
  const g = make(); g.pause();
  const row = switchRow(g);
  assert(row, '暂停面板要有那一行开关');
  assert(row.toggles && row.toggles.length === 3, '开关行里要有 3 个子开关（实际 ' + ((row.toggles || []).length) + ' 个）');
  assert.equal(row.toggles.map(t => t.id).join(','), 'music,sound,vibrate', '顺序 = 音乐/音效/震动');
  assert.equal(row.toggles.map(t => t.label).join(','), '音乐,音效,震动', '文案要和 id 对得上');

  for (const t of row.toggles) {
    assert(t.x >= row.x && t.x + t.w <= row.x + row.w, '子开关「' + t.id + '」横向出那一行');
    assert(t.y >= row.y && t.y + t.h <= row.y + row.h, '子开关「' + t.id + '」纵向出那一行');
  }
  for (let i = 0; i < row.toggles.length; i++) {
    for (let j = i + 1; j < row.toggles.length; j++) {
      assert(!overlap(row.toggles[i], row.toggles[j]), '两个子开关不许互相压：' + row.toggles[i].id + ' / ' + row.toggles[j].id);
    }
  }

  /* 命中只切自己那一个 —— 三个开关各点一次，别的两个不许跟着动 */
  for (const id of ['music', 'sound', 'vibrate']) {
    const gg = make(); gg.pause();
    const rr = switchRow(gg), t = rr.toggles.find(x => x.id === id);
    const before = { music: gg.settings.music, sound: gg.settings.sound, vibrate: gg.settings.vibrate };
    gg.pauseGuard = 0;
    gg.updatePaused({ tap: { x: t.x + t.w / 2, y: t.y + t.h / 2 } });
    assert.equal(gg.settings[id], !before[id], '点「' + t.label + '」要切它自己');
    for (const other of ['music', 'sound', 'vibrate']) {
      if (other === id) continue;
      assert.equal(gg.settings[other], before[other], '点「' + t.label + '」不该把 ' + other + ' 也切了');
    }
    assert.equal(gg.state, 'paused', '点开关不许把暂停面板关掉/继续');
  }

  /* 两个开关之间的空隙：那一行本身不是按钮，点了什么也不该发生 */
  const gg = make(); gg.pause();
  const rr = switchRow(gg);
  const gapX = (rr.toggles[0].x + rr.toggles[0].w + rr.toggles[1].x) / 2;
  const snap = JSON.stringify(gg.settings);
  gg.pauseGuard = 0;
  gg.updatePaused({ tap: { x: gapX, y: rr.y + rr.h / 2 } });
  assert.equal(JSON.stringify(gg.settings), snap, '点开关之间的空隙不该切任何设置');
  assert.equal(gg.state, 'paused', '点空隙也不该关面板');
}

/* ==================== ⑤ 渲染层真的画了（真渲染器 + 假 ctx） ==================== */
{
  const g = make(); g.pause();
  const ctx = recCtx();
  const R = new (require(root + '/render/renderer'))(ctx, {
    cfg: cfg, createCanvas: function (w, h) { const c = { width: w, height: h, getContext: function () { return recCtx(); } }; return c; }
  });
  R.resize(W, H);
  R.drawPausePanel(g);
  const all = ctx.texts.join('|');
  for (const s of ['已暂停', '武器库', '继续', '重新开始', '回首页', '音乐', '音效', '震动']) {
    assert(all.indexOf(s) >= 0, '暂停面板要画出「' + s + '」（渲染层漏了 kind==="switches" 就会这样）');
  }
  assert(all.indexOf('开') >= 0 || all.indexOf('关') >= 0, '三个开关要画出「开 / 关」字样');
}

/* ==================== ⑥ 武器库「武器」页：卡片里的技能名不许越过卡片下边框 ==================== */
{
  /* ⚠️ 这条钉住 2026-10 出图核出来的**老 bug**：技能名原来是 `r.y + r.h - 35 + i*18`，
     按 2 张算的；长剑熟练度 Lv2 之后是 3 张 ⇒ 第 3 行落在 `r.h + 1`，
     卡片下边框正好从"剑阵回响"中间穿过去（公式本身就溢出，跟卡片多高无关）。
     现在从底部往上锚。**2 张 / 3 张 / 1 张都要**在框内 —— 只测 3 张的话，
     以后有人把公式改成"贴顶往下排"就又漏了。 */
  function bagCardCheck(kinds, label) {
    const g = make();
    g.state = 'bag'; g.bagTab = 'weapon'; g.bagGuard = 0;
    const first = g.player.bag[0];
    const extra = [];
    for (let k = 1; k < kinds.length; k++) {
      const w = deps.Progression.makeDefaultWeapon(cfg);
      w.id = 'pb-c' + k; w.kind = kinds[k]; w.name = (cfg.weapons[kinds[k]] || {}).name || kinds[k];
      extra.push(w);
    }
    g.player.bag = [first].concat(extra);
    g.skillViewKind = 'sword';

    const ctx = recCtx();
    const R = new (require(root + '/render/renderer'))(ctx, {
      cfg: cfg, createCanvas: function (w, h) { const c = { width: w, height: h, getContext: function () { return recCtx(); } }; return c; }
    });
    R.resize(W, H);
    R.drawBagPanel(g);

    const rects = g.bagRects();
    for (let i = 0; i < g.player.bag.length; i++) {
      const card = rects[i], skills = g.weaponSkillRows(g.player.bag[i].kind);
      assert(skills.length >= 1, '每把武器都要有技能行');
      for (const s of skills) {
        /* 卡片上技能名的画法是"● / ○ + 名字"、居中、middle 基线 */
        const hits = ctx.calls.filter(function (c) {
          return c.text.indexOf(s.name) >= 0 && c.align === 'center' && c.baseline === 'middle';
        });
        assert(hits.length >= 1, label + '：卡片上要画出技能名「' + s.name + '」');
        for (const h of hits) {
          const ex = vExtent(h);
          assert(ex[1] <= card.y + card.h, label + '：技能名「' + s.name + '」越过卡片下边框（文字底 ' +
            ex[1].toFixed(1) + ' > 卡片底 ' + (card.y + card.h).toFixed(1) + '）');
          assert(ex[0] >= card.y, label + '：技能名「' + s.name + '」越过卡片上边框');
        }
      }
      /* 独有机制那行也要在框内，且不许压到第一张技能名上 */
      const tr = ctx.calls.filter(c => c.text.indexOf('独有') >= 0 && c.align === 'center');
      assert(tr.length >= 1, label + '：卡片上要画「独有机制：无 / 独有：…」那行');
      const tEx = vExtent(tr[0]);
      assert(tEx[0] >= card.y && tEx[1] <= card.y + card.h, label + '：「独有机制」那行出框');
      const s1 = ctx.calls.find(c => c.text.indexOf(skills[0].name) >= 0 && c.align === 'center');
      assert(s1 && vExtent(s1)[0] - tEx[1] >= 8, label + '：「独有机制」和第一张技能名挤在一起了（间距 <8px）');
    }
  }
  bagCardCheck(['sword'], '1 把武器（长剑 3 张技能）');
  bagCardCheck(['sword', 'spear'], '2 把武器');

  /* 换一把只有 2 张技能的武器，验证"张数变了也不出框" */
  (function () {
    const g = make();
    g.state = 'bag'; g.bagTab = 'weapon'; g.bagGuard = 0;
    const kinds = Object.keys(cfg.weapons).filter(k => g.weaponSkillRows(k).length === 2);
    assert(kinds.length >= 1, '要有一颗"只有 2 张技能"的武器来验另一头（实际都有：' +
      Object.keys(cfg.weapons).join(',') + '）');
    const w = deps.Progression.makeDefaultWeapon(cfg);
    w.id = 'pb-c2'; w.kind = kinds[0]; w.name = (cfg.weapons[kinds[0]] || {}).name || kinds[0];
    g.player.bag = [w]; g.skillViewKind = kinds[0];
    const ctx = recCtx();
    const R = new (require(root + '/render/renderer'))(ctx, {
      cfg: cfg, createCanvas: function (w2, h2) { const c = { width: w2, height: h2, getContext: function () { return recCtx(); } }; return c; }
    });
    R.resize(W, H); R.drawBagPanel(g);
    const card = g.bagRects()[0];
    for (const s of g.weaponSkillRows(kinds[0])) {
      const h = ctx.calls.find(c => c.text.indexOf(s.name) >= 0 && c.align === 'center' && c.baseline === 'middle');
      assert(h, '2 张技能的武器也要画出「' + s.name + '」');
      assert(vExtent(h)[1] <= card.y + card.h, '2 张时「' + s.name + '」也不许越过卡片下边框');
      assert(vExtent(h)[1] <= card.y + card.h, '2 张时「' + s.name + '」不许越过卡片下边框');
    }
  })();
}

/* ==================== ⑦ 武器库「技能」页 / 「熟练度」页（2026-10 拆成两页） ==================== */
{
  /* 用户口径（原话）：「技能模块看着有点错乱，技能模块中把熟练度这块去掉，
     我想新增加一个熟练度奖励模块」⇒ 熟练度从技能页搬到当年那个「武器库」里独立成第 4 个页签。
     这个块钉住三件事：
       · 技能页里**不许再有熟练度**（Lv 行 / 奖励文案都不许出现）—— 搬干净，不是"藏起来"
       · 熟练度页 = 进度行 + 每级一行，各自在 body 里、互不压、不互相跑位
       · 每级的字必须落在**它自己那一行**里（行是等分出来的，差一点就叠到下一行上） */
  const g = make();
  g.startRun();
  const r = g.skillPanelRects();
  assert(!r.mastery, '技能页不该再有 mastery 那块矩形（熟练度已独立成页）');
  assert(r.skills.y >= r.body.y - 0.001 && r.skills.y + r.skills.h <= r.body.y + r.body.h + 0.001,
    '技能块要落在 body 里（body 是判定用的整页热区）');
  assert(r.skills.x >= r.body.x && r.skills.x + r.skills.w <= r.body.x + r.body.w, '技能块横向出 body');
  assert(r.skills.h - 26 >= 74, '技能表要有高度（表头 26 + 每行至少 24），实际 ' + (r.skills.h - 26));

  /* 真渲染一遍：技能页只画技能（一行一张），熟练度那套一个字都不该出现 */
  g.state = 'bag'; g.bagTab = 'skills'; g.bagGuard = 0;
  g.skillViewKind = 'sword';
  const ctx = recCtx();
  const R = new (require(root + '/render/renderer'))(ctx, {
    cfg: cfg, createCanvas: function (w, h) { const c = { width: w, height: h, getContext: function () { return recCtx(); } }; return c; }
  });
  R.resize(W, H);
  R.drawSkillPanel(g);

  const all = ctx.texts.join('|');
  assert(all.indexOf('技能') >= 0, '技能页要有「技能」这块的标题');
  assert(all.indexOf('已获得') >= 0, '技能表要画出「已获得 N / M」读数');
  for (const s of g.weaponSkillRows('sword')) assert(all.indexOf(s.name) >= 0, '技能页要画出「' + s.name + '」');
  /* ⚠️ 只认**熟练度奖励的文案**，别一刀切搜"熟练度"两个字：
     未解锁技能的 status 本来就写着「未解锁 · 需长剑熟练度 Lv2」（那是解锁条件，得留）。 */
  assert(all.indexOf('Lv1') < 0, '技能页不该再有等级行「Lv1」—— 那是熟练度页的东西');
  assert(all.indexOf('解锁专属') < 0 && all.indexOf('打完 Boss 有几率掉落') < 0,
    '技能页不该再出现熟练度奖励文案（解锁专属技能/机制卡、打完 Boss 掉落）');

  /* 每张技能的名字要落在技能块里（以前只有 74px、字被裁，这条钉住"别又画丢一张"） */
  for (const s of g.weaponSkillRows('sword')) {
    const hits = textsAt(ctx, s.name);
    assert(hits.length >= 1, '技能页要画出「' + s.name + '」');
    for (const h of hits) {
      const ex = vExtent(h);
      assert(ex[0] >= r.skills.y && ex[1] <= r.skills.y + r.skills.h,
        s.name + ' 画出了技能块（文字 ' + ex[0].toFixed(1) + '~' + ex[1].toFixed(1) + '）');
    }
  }
  /* 全局兜底：技能页里没有一行字被画到屏幕外（"挤到看不出来"这一类只有它抓得住） */
  for (const c of ctx.calls) {
    const ex = vExtent(c);
    assert(ex[0] >= -1 && ex[1] <= H + 1, '技能页有文字画出屏幕：' + c.text + ' y=' + c.y.toFixed(1));
  }

  /* ---------- 熟练度页（熟练度奖励）：进度行 + 每级一行 ---------- */
  const m = g.masteryPanelRects();
  assert(!overlap(m.progress, m.list), '进度行和每级列表不许互相压（2026-10 出图抓到过：进度条那句压在第一行框线上）');
  for (const [name, box] of [['进度行', m.progress], ['每级列表', m.list]]) {
    assert(box.y >= m.body.y - 0.001 && box.y + box.h <= m.body.y + m.body.h + 0.001,
      name + '要落在 body 里');
    assert(box.x >= m.body.x && box.x + box.w <= m.body.x + m.body.w, name + '横向出 body');
  }
  assert(m.rows === g.codexMasteryRows('sword').length,
    '行数要按 config.mastery.levels 的实际长度算（写死 4 行，门槛表一改就漏画一级）');
  assert(m.rowH >= 24, '每级行高至少 24（等级 13.5px + 门槛小字两层），实际 ' + m.rowH.toFixed(1));

  const mc = recCtx();
  const MR = new (require(root + '/render/renderer'))(mc, {
    cfg: cfg, createCanvas: function (w, h) { const c = { width: w, height: h, getContext: function () { return recCtx(); } }; return c; }
  });
  MR.resize(W, H);
  MR.drawMasteryPanel(g);

  const mt = mc.texts.join('|');
  for (const s of ['Lv1', 'Lv2', 'Lv3', 'Lv4']) assert(mt.indexOf(s) >= 0, '熟练度页要画出等级「' + s + '」');
  assert(mt.indexOf('熟练度') >= 0, '熟练度页要画出顶部进度那行（含「熟练度」字样）');
  assert(mt.indexOf('剑阵回响') >= 0 || mt.indexOf('叠刃') >= 0, '熟练度页要画出"这一级给什么"');
  /* 每一级的标签必须落在**它自己那一行**里（行高是等分算的，差一点就叠到下一行上） */
  for (let i = 0; i < g.codexMasteryRows('sword').length; i++) {
    const row = g.codexMasteryRows('sword')[i];
    const hits = textsAt(mc, row.label);
    assert(hits.length >= 1, '熟练度页要画出「' + row.label + '」');
    const top = m.list.y + i * (m.rowH + m.rowsGap);
    for (const h of hits) {
      const ex = vExtent(h);
      assert(ex[0] >= top - 1 && ex[1] <= top + m.rowH + 1,
        row.label + ' 画出了它那一行（行 ' + top.toFixed(1) + '~' + (top + m.rowH).toFixed(1) +
        '，文字 ' + ex[0].toFixed(1) + '~' + ex[1].toFixed(1) + '）');
    }
  }
  for (const c of mc.calls) {
    const ex = vExtent(c);
    assert(ex[0] >= -1 && ex[1] <= H + 1, '熟练度页有文字画出屏幕：' + c.text + ' y=' + c.y.toFixed(1));
  }

  /* 换一把只有 2 张技能的武器：两页的外框和行位置都纹丝不动（用户口径：布局确定性） */
  const g2 = make(); g2.startRun();
  g2.skillViewKind = 'dagger';
  const r2 = g2.skillPanelRects(), m2 = g2.masteryPanelRects();
  assert(Math.abs(r2.skills.y - r.skills.y) < 0.001, '换武器时技能块的位置不许动');
  assert(Math.abs(m2.list.y - m.list.y) < 0.001 && Math.abs(m2.rowH - m.rowH) < 0.001,
    '换武器时熟练度页每级行的位置 / 行高不许动');

  /* ---------- 判定：新页签真的能切进去（别只在渲染层"看着在"） ---------- */
  const gt = make(); gt.startRun();
  gt.state = 'bag'; gt.bagTab = 'weapon'; gt.bagGuard = 0; gt.bagReturnState = 'paused';
  const mtab = gt.bagTabs().find(t => t.id === 'mastery');
  assert(mtab, '武器库顶部要有第 4 个页签「熟练度」');
  gt.updateBag({ tap: { x: mtab.x + mtab.w / 2, y: mtab.y + mtab.h / 2 } });
  assert.equal(gt.bagTab, 'mastery', '点「熟练度」页签要切到那一页');
  gt.bagGuard = 0; gt.skillViewKind = 'sword';
  const other = gt.weaponPageFrame().tabs.find(t => t.kind !== 'sword');
  gt.updateBag({ tap: { x: other.x + other.w / 2, y: other.y + other.h / 2 } });
  assert.equal(gt.skillViewKind, other.kind, '熟练度页里点武器页签 = 看那把武器的熟练度');
  gt.bagGuard = 0;
  const mb = gt.masteryPanelRects().body;
  gt.updateBag({ tap: { x: mb.x + 4, y: mb.y + 4 } });
  assert.equal(gt.state, 'bag', '熟练度页里点页内空白不许关掉面板');
  gt.bagGuard = 0;
  gt.updateBag({ tap: { x: 2, y: 2 } });
  assert.equal(gt.state, 'paused', '点页外要关掉武器库、回暂停面板');
}

/* ==================== ⑧ 拆行：中文避头尾（熟练度格子里的孤儿引号） ==================== */
{
  const Renderer = require(root + '/render/renderer');
  const R = new Renderer(recCtx(), { cfg: cfg, createCanvas: function (w, h) { return null; } });
  /* 一个精确控宽的量器：汉字 10px、其余 5px（比 length*7 更接近真实排版） */
  const mctx = {
    measureText: function (s) {
      let w = 0;
      for (const ch of String(s)) w += /[\u4e00-\u9fa5，。、；：？！（）【】《》「」『』…·]/.test(ch) ? 10 : 5;
      return { width: w };
    }
  };
  const NO_HEAD = '，。、；：？！）】》」』…·';

  const cases = [
    ['打完 Boss 有几率掉落 「双刀」', 149],
    ['解锁专属技能「剑阵回响」（精英掉落）', 149],
    ['每1.2秒发出剑气，最多穿透5个敌人', 204],
    ['收刃时飞出回旋刃，往返各可命中一次', 204]
  ];
  for (const [text, maxW] of cases) {
    const lines = R.wrapText(mctx, text, maxW);
    assert(lines.join('') === text, '拆行不许丢字 / 改字：' + text + ' → ' + JSON.stringify(lines));
    for (let i = 1; i < lines.length; i++) {
      assert(NO_HEAD.indexOf(lines[i][0]) < 0,
        '行首不许是「，。」）…」这类避头点：' + JSON.stringify(lines));
    }
    /* 成对的「」（）不许被拆到两行（拆了就会出现 `…「双刀` / `」` 这种孤儿） */
    for (const [o, c] of [['「', '」'], ['（', '）']]) {
      const oi = text.indexOf(o), ci = text.indexOf(c);
      if (oi >= 0 && ci > oi) {
        const lineOfO = lines.findIndex(l => l.indexOf(o) >= 0);
        const lineOfC = lines.findIndex(l => l.indexOf(c) >= 0);
        assert.equal(lineOfO, lineOfC, '「' + o + '…' + c + '」这对括号被拆到两行了：' + JSON.stringify(lines));
      }
    }
  }
  /* 没配对的括号（配置里手滑漏一个）不许把拆行弄崩，也不许丢字 */
  const broken = R.wrapText(mctx, '掉落物是「双刀', 60);
  assert(broken.join('') === '掉落物是「双刀', '没配对的括号也要原样拆完，不许丢字');
  /* 零宽 / 空串：拿到空数组，不抛 */
  assert.deepEqual(R.wrapText(mctx, '', 100), []);
}

console.log('PASS: 暂停面板 →「武器库」 —— 第一行恒显（一把武器时也能进）/ 关掉回暂停面板 / '
  + '横屏·刘海机·SE 三种视口整块与每行都不出屏 / 音乐·音效·震动 并成一行三个小开关、各自命中只切自己 / '
  + '「武器」页卡片技能名 2 张 3 张都不越框 / 「技能」页只画技能、熟练度一个字不留 / ' +
  + '中文拆行避头尾（不把「」（）拆到两行、行首不留标点）');
