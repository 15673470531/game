'use strict';
/**
 * 开局武器（2026-10 用户口径）：**开局只能用默认那把（长剑），其他不可选**。
 *
 * 背景：以前有两处"便利"把 5 把武器全塞进包里 ——
 *   ① `Game.initTrial()` 里那段（它是 reset() 调的，正式局也跑）
 *   ② `Save.applyMeta()` 里"保证每把都在"那段
 * 后果：开局就能在武器库换出大剑/长枪/法杖，每关 Boss 掉武器的设计形同虚设。
 * 现在的规矩：
 *   · 开局（新一局）手上和库里都只有默认那把；捡到的武器留在库里，**开局手上仍是长剑**
 *   · 首页那个"开局：XX·点换"改成**只交代不改**的面板：默认那把亮着，其余四把锁着
 *   · 试炼场照旧全发（要试招），但**退出时必须收回**（trial-* 一件都不许留下）
 *   · 开局是哪把只写在 `cfg.items.startWeapon` 一处
 */
const assert = require('assert'), path = require('path'), fs = require('fs');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config');
const Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);

function make() { const g = new Game(cfg, deps); g.setViewport(812, 375); return g; }
function mkWeapon(kind, id) {
  const it = deps.Progression.makeDefaultWeapon(cfg);
  it.id = id || ('t-' + kind); it.kind = kind; it.name = cfg.weapons[kind].name;
  return it;
}

/* ---------- ① 干净开局：库里只有一把，手上就是它 ---------- */
let g = make();
assert.equal(g.player.bag.length, 1, '开局库里只该有 1 把（实测 ' + g.player.bag.length + '）');
assert.equal(g.player.bag[0].kind, cfg.items.startWeapon, '开局那把 = cfg.items.startWeapon');
assert.equal(g.player.equip.weapon, g.player.bag[0], '手上那把就是库里那把（渲染的"当前"高亮靠 === 比较）');
assert.equal(g.player.equip.weapon.kind, 'sword', '开局是长剑');

/* ---------- ② 上一局捡到的武器：留在库里，但开局手上还是长剑 ---------- */
{
  const loot = make();
  const gs = mkWeapon('greatsword', 'loot-greatsword');
  loot.player.bag.push(gs);
  loot.player.equip.weapon = gs;                        // 上一局是拿着大剑死的
  const meta = JSON.parse(JSON.stringify(deps.Save.snapshot(loot, false)));
  const g2 = make();
  g2.loadMeta = function () { return meta; };           // 伪造"存档里有这份 meta"
  g2.reset();
  assert.equal(g2.player.bag.length, 2, '捡到的武器要留在库里（跨局保留）');
  assert(g2.player.bag.some(it => it.kind === 'greatsword'), '大剑还在库里');
  assert(g2.player.bag.some(it => it.kind === 'sword'), '默认长剑也必须在库里（不会被顶掉）');
  assert.equal(g2.player.equip.weapon.kind, 'sword', '开新局手上必须是长剑（捡的那把是局内切着用的）');
  assert(g2.switchWeapon(g2.player.bag.findIndex(it => it.kind === 'greatsword')), '局内仍然能切到捡到的武器');
  assert.equal(g2.player.equip.weapon.kind, 'greatsword', '切过去要真的生效');
}

/* ---------- ③ 「继续上次」是另一回事：那一局手上是哪把就还是哪把 ---------- */
{
  const run = make(), gs = mkWeapon('spear', 'run-spear');
  run.player.bag.push(gs); run.player.equip.weapon = gs;
  const saved = JSON.parse(JSON.stringify(deps.Save.snapshot(run, true)));
  const g3 = make();
  assert.equal(g3.Save.applyRun(g3, saved), true, '这份存档可续');
  assert.equal(g3.player.equip.weapon.kind, 'spear', '续局要接着用存档里那把（不是强行回长剑）');
}

/* ---------- ④ 旧存档里的 trial-* 试用武器：读档时清掉 ---------- */
{
  const old = make();
  /* 三把一起塞：两把 trial-*（试用）+ 一把"真的掉落的"（id 不是 trial- 前缀）——
     前面的要清掉，后面的必须留下（别把玩家真捡的打没了）。 */
  old.player.bag.push(mkWeapon('dagger', 'trial-dagger'), mkWeapon('staff', 'trial-staff'), mkWeapon('spear', 'loot-spear'));
  const meta = JSON.parse(JSON.stringify(deps.Save.snapshot(old, false)));
  const g4 = make();
  g4.loadMeta = function () { return meta; };
  g4.reset();
  assert(!g4.player.bag.some(it => String(it.id).indexOf('trial-') === 0), 'trial-* 试用武器不许留在正式局的库里');
  assert(g4.player.bag.some(it => it.kind === 'spear'), '真掉落的那把（loot-spear）必须留下');
  assert.equal(g4.player.bag.length, 2, '长剑 + 那把真的，试用武器清掉（实测 ' + g4.player.bag.length + '）');
}

/* ---------- ⑤ 首页「开局武器」面板：其他四把是**不可选**的 ---------- */
{
  const gt = make();
  gt.state = 'title';                     // 首页（新建的 game 不带 state，显式摆成首页）
  const btn = gt.titleRects().info.filter(r => r.id === 'loadout')[0];
  assert(btn, '首页要有「开局：XX」这个按钮');
  assert.equal(btn.label, '开局：' + cfg.weapons[cfg.items.startWeapon].name, '按钮文案就是开局那把（不再写"·点换"）');
  gt.updateTitle({ tap: { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 } });
  assert(gt.loadoutOpen, '点它要打开「开局武器」面板');

  const rows = gt.loadoutRects().rows;
  assert.equal(rows.filter(r => r.kind === 'locked').length, 4, '其他四把全部锁着');
  assert.equal(rows.filter(r => r.kind === 'current').length, 1, '默认那把是"当前"（高亮）');
  assert(rows.filter(r => r.kind === 'locked').every(r => r.note && r.note.length), '锁着的行必须写清怎么解锁（只锁不解释 = 莫名其妙）');
  assert(rows.some(r => r.note.indexOf('Boss') >= 0), '要写明是打 Boss 掉的');
  assert(rows.some(r => r.id === 'back'), '要有返回');

  const w0 = gt.player.equip.weapon, n0 = gt.player.bag.length;
  const dag = rows.filter(r => r.id === 'dagger')[0];
  /* ⚠️ 走**真实入口** updateTitle({tap})：它能一起验"面板是模态的"（点面板不许穿透到开始游戏）。
     updateLoadoutPanel(p) 收的是**点**，别直接塞 {tap} 进去（那样 p.x 是 undefined，
     所有命中判定都是 false → 表现成"点哪儿都关面板"，很容易误判成逻辑坏了）。 */
  gt.updateTitle({ tap: { x: dag.x + 6, y: dag.y + 6 } });
  assert(gt.loadoutOpen, '点锁着的那把：面板不关（留在原地让人看清为什么不能选）');
  assert.equal(gt.player.equip.weapon, w0, '点锁着的武器**不许换武器**');
  assert.equal(gt.player.bag.length, n0, '也不许凭空多一把（这是"不可选"的核心）');
  gt.updateTitle({ tap: { x: dag.x + 6, y: dag.y + 6 } });
  assert.equal(gt.player.equip.weapon.kind, 'sword', '连点也不许把开局武器换掉');

  gt.updateTitle({ tap: { x: 12, y: 12 } });
  assert(!gt.loadoutOpen, '点面板外要关掉');
  /* 模态：面板盖着时，点"开始游戏"那个位置不许开局（那一下只该被面板吃掉） */
  const startBtn = gt.titleRects().main[0];
  gt.updateTitle({ tap: { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 } });
  assert(gt.loadoutOpen && gt.state === 'title', '打开面板不许顺手开局');
  gt.updateTitle({ tap: { x: startBtn.x + startBtn.w / 2, y: startBtn.y + startBtn.h / 2 } });
  assert(gt.loadoutOpen && gt.state === 'title', '面板开着时点"开始游戏"也不许开局');
  /* 取一个**真的在面板外、也不在任何标题按钮上**的点：关面板 + 不穿透 */
  const outside = { x: gt.loadoutRects().panel.x - 10, y: gt.viewport.h - 6 };
  const R2 = gt.titleRects();
  assert(!gt.inRect(gt.loadoutRects().panel, outside), '这个点要在面板外');
  assert(![R2.settings].concat(R2.info, R2.main).some(r => gt.inRect(r, outside)), '这个点也不该压在标题按钮上（否则测不出穿透）');
  gt.updateTitle({ tap: outside });
  assert(!gt.loadoutOpen && gt.state === 'title', '关面板那一下不许穿透到底下按钮（别把游戏开了）');
  /* 页面里"点一下换一把"的循环已经删掉（否则点两次会跳到第 2 把武器） */
  gt.updateTitle({ tap: { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 } });
  gt.updateTitle({ tap: { x: 12, y: 12 } });
  assert.equal(gt.startWeaponInfo().kind, cfg.items.startWeapon, '不管点几下，开局那把永远是配置里那把');
}

/* ---------- ⑥ 试炼场：进 → 四把全发；退出 → 一件不留 ---------- */
{
  const g5 = make();
  g5.state = 'play';
  const before = g5.player.bag.length;
  g5.setTraining(true);
  assert.equal(g5.player.bag.length, 5, '进试炼场把四把都发出来（要能随手切武器试招）');
  const st = g5.player.bag.filter(it => it.kind === 'staff')[0];
  assert(st, '试炼场里要有法杖');
  g5.switchWeapon(g5.player.bag.indexOf(st));
  assert.equal(g5.player.equip.weapon.kind, 'staff', '试炼场里能切到法杖');
  g5.setTraining(false);
  assert.equal(g5.player.bag.length, before, '退出试炼场要把试用武器全收回去（实测 ' + g5.player.bag.length + ' vs ' + before + '）');
  assert(!g5.player.bag.some(it => String(it.id).indexOf('trial-') === 0), 'trial-* 一件都不许留下');
  assert.equal(g5.player.equip.weapon.kind, 'sword', '退出后手上还回原来那把（临时件不带走）');
}

/* ---------- ⑦ 开局是哪把只写在一处：换掉配置也能跑 ---------- */
{
  const old = cfg.items.startWeapon;
  cfg.items.startWeapon = 'dagger';
  const g6 = new Game(cfg, deps); g6.setViewport(812, 375);
  assert.equal(g6.startWeaponInfo().kind, 'dagger', '开局武器要跟着 config 走（别把 sword 写死在各处）');
  assert.equal(g6.player.equip.weapon.kind, 'dagger', '开局手上换成了配置那把');
  assert.equal(g6.player.bag.length, 1, '开局库里也只有它一把');
  assert.equal(g6.titleRects().info.filter(r => r.id === 'loadout')[0].label, '开局：' + cfg.weapons.dagger.name, '按钮文案跟着配置走');
  const rr = g6.loadoutRects().rows;
  assert.equal(rr.filter(r => r.kind === 'current')[0].id, 'dagger', '面板里高亮的也是配置那把');
  assert.equal(rr.filter(r => r.kind === 'locked').length, 4, '其他四把照锁');
  cfg.items.startWeapon = old;
}

/* ---------- ⑧ 源码级：删干净（别留半截） ---------- */
{
  const src = fs.readFileSync(root + '/core/game.js', 'utf8');
  assert(src.indexOf('this.selectedWeapon') < 0, '首页"点一下换一把"的 selectedWeapon 不许残留');
  assert(src.indexOf('·点换') < 0, '"·点换"这个文案不许残留（改文案要连行为一起改）');
  const saveSrc = fs.readFileSync(root + '/core/save.js', 'utf8');
  assert(saveSrc.indexOf('var kinds=Object.keys(game.cfg.weapons)') < 0,
    'applyMeta 里"保证每把都在"那段要删掉（它就是泄漏源：读档后 5 把全在包里）');
}

/* ---------- ⑨ 熟练度并进面板（2026-10 用户选的方案 1：零新增入口） ---------- */
{
  /* 用户原话：「需要支持查看自己当前熟练度信息, 但是现在没有入口, 你给方案」→ 选方案 1
     （并进已有的「开局武器」面板）。这里守四件事：
       ① 读数只有配了熟练度奖励表的武器才有（大剑/长枪/法杖 没表 ⇒ 不写，免得承诺"练了有奖励"）
       ② "下一级解锁什么"只给**当前手上这把**，别的行那句要用来说"怎么解锁"
       ③ 数字全由核心层给（渲染层不许自己算等级/拼 Lv 字样 —— 同一个数写两处栽过四次）
       ④ 行高还是 36、面板还是 324 高：是"同一行高里排两行"，不是把面板撑大 */
  const gt = make();
  gt.state = 'title';

  /* ① 刚上手：长剑 Lv1，读数 0 / 本级上限 300 */
  let rows = gt.loadoutRects().rows;
  let sword = rows.filter(r => r.id === 'sword')[0];
  assert.equal(sword.mstr, 'Lv1 · 0/300', '长剑行要有练度读数（0 / 本级上限 300）');
  assert.equal(sword.next, '下一级 Lv2：解锁专属技能「剑阵回响」',
    'Lv1 的"下一级"是 Lv2 那档（就是剑阵回响）—— 刚上手就该看见第一个目标');
  assert.equal(sword.note, '开局武器', 'note 照旧带着（渲染层有 next 时把它挪成名字后面的小标签，不丢信息）');
  ['greatsword', 'spear', 'staff'].forEach(function (k) {
    assert.equal(rows.filter(r => r.id === k)[0].mstr, null,
      k + ' 没配熟练度奖励表 ⇒ 不许写练度读数（写了等于承诺练了有奖励）');
  });
  assert.equal(rows.filter(r => r.id === 'dagger')[0].mstr, 'Lv1 · 0/300', '双刀有表 ⇒ 有读数');

  /* ② 打了一把（150 点）：还在 Lv1（本级 0~300）⇒ 正好半格；当前那把的说明换成"下一级解锁什么" */
  gt.player.mastery.sword = 150;
  rows = gt.loadoutRects().rows;
  sword = rows.filter(r => r.id === 'sword')[0];
  assert.equal(sword.mstr, 'Lv1 · 150/300',
    '150 点还在 Lv1（Lv1 区间是 0~300）—— 分母是本级上限，所以打完一把必然是半格');
  assert.equal(sword.next, '下一级 Lv2：解锁专属技能「剑阵回响」', '当前那把要写清"下一级解锁什么"');
  assert.equal(rows.filter(r => r.id === 'dagger')[0].next, null, '"下一级"只给当前手上那把（别的行那句是"怎么解锁"）');
  /* 跨过 Lv1 门槛（300 点）：读数换成 Lv2 区间，分母跟着变本级上限 600 */
  gt.player.mastery.sword = 300;
  assert.equal(gt.loadoutRects().rows.filter(r => r.id === 'sword')[0].mstr, 'Lv2 · 300/600',
    '到 300 点进 Lv2，分母换成 600（本级上限，不是满级 900）');

  /* ③ 满级（900 点）：读数改说"满级"，说明改说"满级奖励" */
  gt.player.mastery.sword = 900;
  sword = gt.loadoutRects().rows.filter(r => r.id === 'sword')[0];
  assert.equal(sword.mstr, 'Lv4 · 满级', '满级不写数字（分母 == 分子，写 900/900 是废话）');
  assert.equal(sword.next, '满级奖励：打完 Boss 有几率掉「双刀」', '满级那档改说"满级奖励"');

  /* ④ 奖励内容还没定（双刀全 null）时不许露出"待开发"：退回 note */
  const old = cfg.items.startWeapon;
  cfg.items.startWeapon = 'dagger';
  const gd = new Game(cfg, deps); gd.setViewport(812, 375); gd.state = 'title';
  const drow = gd.loadoutRects().rows.filter(r => r.kind === 'current')[0];
  assert.equal(drow.id, 'dagger', '换成双刀开局：高亮的还是配置那把');
  assert.equal(drow.next, null, '双刀各级奖励都是 null ⇒ 不写"下一级"（露出"待开发"很难看）');
  assert.equal(drow.note, '开局武器', '不写"下一级"时退回 note');
  assert(drow.mstr, '双刀开局照样有读数');
  cfg.items.startWeapon = old;

  /* ⑤ 宽度预算：两行都得装得进 36 高的那一行里（超了渲染层会降字号，看着就是"塞不下"） */
  function estWidth(t, fs) {
    let w = 0;
    for (let i = 0; i < t.length; i++) w += t.charCodeAt(i) < 128 ? fs * 0.56 : fs;
    return w;
  }
  const g2 = make(); g2.state = 'title'; g2.player.mastery.sword = 150;
  const R2 = g2.loadoutRects().rows;
  R2.forEach(function (r) {
    const line2 = r.next || r.note;
    if (line2) assert(estWidth(line2, 10) <= r.w - 28,
      '「' + line2 + '」约 ' + Math.round(estWidth(line2, 10)) + 'px，超了行内可用宽 ' + (r.w - 28) + 'px');
    if (r.mstr) {
      const clash = 14 + estWidth(r.label, 15) + 8 + estWidth(r.kind === 'current' && r.next ? r.note : '', 10)
        + 8 + estWidth(r.mstr, 11);
      assert(clash <= r.w, '第 1 行右边读数和左边名字/标签会撞（' + Math.round(clash) + ' > ' + r.w + '）');
    }
  });

  /* ⑥ 行高/面板高度没动：6 行涨到 40 在 812x375 上会把面板顶到屏幕边 */
  const R3 = g2.loadoutRects();
  assert(R3.rows.every(r => r.h === 36), '行高还是 36（"同一行高里排两行"，不是加高）');
  assert.equal(R3.panel.h, 324, '面板高度还是 324（改前实测值：6*36 + 5*10 + 标题 36 + 内边距 22）');
  assert(R3.panel.y + R3.panel.h <= 375 - 16, '面板底边要留出 16px（实测 y=' + R3.panel.y + ' h=' + R3.panel.h + '）');

  /* ⑦ 源码级：练度数字不许在渲染层算（"同一个数写两处"栽过四次） */
  const rsrc = fs.readFileSync(root + '/render/renderer.js', 'utf8');
  const fn = rsrc.slice(rsrc.indexOf('Renderer.prototype.drawLockRow'), rsrc.indexOf('Renderer.prototype.drawPausePanel'));
  assert(fn.indexOf("'Lv'") < 0 && fn.indexOf('masteryInfo') < 0 && fn.indexOf('masteryOf') < 0,
    'drawLockRow 不许自己算等级 / 拼 Lv 字样 —— 读数一律走核心层 masteryShortText');
  assert(fn.indexOf('r.mstr') >= 0, 'drawLockRow 要画 row.mstr（核心层给的那串读数）');
}

console.log('PASS: 开局长剑（库里只 1 把）/ 捡到的武器留库但开局回长剑 / 续局保持原武器 / 旧存档 trial-* 清掉 / 首页面板锁死其余四把且点了没反应 / 试炼场全发且退出收回 / 开局武器只由 config 一处决定 / 源码无残留 / 面板带熟练度读数（只有配了奖励表的武器才写、只有当前那把写"下一级解锁什么"、数字只在核心层算、行高与面板高度没变）');
