'use strict';
const assert=require('assert'),path=require('path');
const root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f] of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
let seed=452;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
function make(kind='sword'){
 const g=new Game(cfg,deps);g.setViewport(812,375);g.player.x=1200;g.player.y=800;g.player.face=0;g.world.rocks.length=0;g.world.walls.length=0;
 g.player.equip.weapon={kind,affixes:[],id:kind};g.player.bag=[g.player.equip.weapon];g.skillActiveKind=kind;return g;
}
function grant(g,id){assert(deps.Progression.applyUpgrade(cfg,g.player,id));}
function foe(g,x=80,y=0){let f=deps.Entities.makeFoe(cfg,'tank',g.player.x+x,g.player.y+y,1,1);f.hp=f.maxhp=1e5;g.foes.push(f);return f;}
const cards=cfg.upgrades.filter(c=>c.weapon);assert.equal(cards.length,11,'11 张武器技能卡（长剑 3、其余各 2 —— 2026-10 熟练度 Lv2 解锁的「剑阵回响」）');
for(const kind of Object.keys(cfg.weapons)){
  /* ⚠️ 长剑是 3 张：多出来的「剑阵回响」是**熟练度解锁**的（masteryMin:2），
     所以下面的抽卡断言里长剑池默认只放 2 张（masteryPts 不传 = 0 = Lv1）。 */
  const g=make(kind), own=cards.filter(c=>c.weapon===kind);assert.equal(own.length,kind==='sword'?3:2);
 for(let i=0;i<200;i++){
  const row=deps.Progression.drawUpgrades(cfg,{},3,{weapon:kind});assert.equal(row.length,3);assert.equal(new Set(row.map(c=>c.id)).size,3);
  assert.equal(row.filter(c=>c.weapon).length,1);assert(row.every(c=>!c.weapon||c.weapon===kind));assert(row.filter(c=>c.cost).length<=1);
 }
 grant(g,own[0].id);assert(!deps.Progression.applyUpgrade(cfg,g.player,own[0].id));
 let row=deps.Progression.drawUpgrades(cfg,g.player.taken,3,{weapon:kind});assert(row.some(c=>c.id===own[1].id));
 grant(g,own[1].id);row=deps.Progression.drawUpgrades(cfg,g.player.taken,3,{weapon:kind});assert(row.every(c=>!c.weapon));
 const restored=make(kind);deps.Save.applyRun(restored,JSON.parse(JSON.stringify(deps.Save.snapshot(g,true))));assert(restored.hasWeaponSkill(own[0].id));assert(restored.hasWeaponSkill(own[1].id));
 const reset=make(kind);deps.Save.applyMeta(reset,deps.Save.snapshot(g,false),'loot');assert(!reset.player.taken[own[0].id]);
 /* 发到手的那两张都要在属性页有一行（`own[2]` 是熟练度 Lv2 才解锁的剑阵回响，
    这条用例没发它 —— 它得先有熟练度，见 verify-mastery）。 */
 for(const c of own.slice(0,2))assert(deps.Progression.statRows(cfg,g.player).some(r=>r.label.includes(c.name)));
}
let g=make();grant(g,'sword_wave');let f=foe(g);g.updateWeaponSkills(.01);assert.equal(g.projectiles[0].skillShape,'wave');for(let i=0;i<12;i++)g.updateProjectiles(1/60);assert(f.hp<f.maxhp);
g=make();grant(g,'sword_return');f=foe(g);g.player.orbOn=true;g.player.orbT=0;g.updateOrbit(.01);assert.equal(g.projectiles[0].skillShape,'return');for(let i=0;i<40;i++)g.updateProjectiles(1/60);assert(f.hp<=f.maxhp-g.player.stats.attackDamage*2.8*.65+.001,'outbound and return each hit');
g=make('dagger');grant(g,'dagger_shadow');f=foe(g,45);for(let i=0;i<5;i++)g.damageFoe(f,1,0,'weapon');assert(g.skillShadow);let hp=f.hp;g.updateWeaponSkills(.01);assert(f.hp<hp);
g=make('dagger');grant(g,'dagger_dash');g.player.orbT=10;f=foe(g,40);g.updatePlayer(.08,{moveX:1,dash:true});hp=f.hp;assert(hp<f.maxhp);g.updatePlayer(.08,{moveX:1});assert.equal(f.hp,hp,'dash cannot hit same enemy twice');
g=make('greatsword');grant(g,'greatsword_charge');f=foe(g,140);g.updateOrbit(.01);assert(Math.abs((f.maxhp-f.hp)-g.player.stats.attackDamage*3.5*.65)<1e-6);assert(g.skillVisuals.some(v=>v.kind==='cone'));
g=make('greatsword');grant(g,'greatsword_quake');f=foe(g);for(let i=0;i<4;i++)g.damageFoe(f,1,0,'weapon');assert(g.skillQuakePending);hp=f.hp;g.updateWeaponSkills(.01);assert(f.hp<hp);assert(!g.skillQuakePending);
g=make('spear');grant(g,'spear_pierce');f=foe(g,270);g.updateWeaponSkills(.01);assert(f.hp<f.maxhp);assert(g.skillVisuals.some(v=>v.kind==='line'));
g=make('spear');grant(g,'spear_field');f=foe(g,-48);g.updateWeaponSkills(.01);assert.equal(g.skillFields.length,1);assert(f.hp<f.maxhp);
g=make('staff');grant(g,'staff_chain');grant(g,'staff_split');const first=foe(g,70,-14),second=foe(g,150,-14),third=foe(g,225,-14);g.castSpell(g.weapon(),g.player.stats);
for(let i=0;i<8;i++)g.updateProjectiles(1/60);
assert(second.hp<second.maxhp&&third.hp<third.maxhp,'chain hits two neighbours');assert.equal(g.skillVisuals.filter(v=>v.kind==='lightning').length,2);assert.equal(g.projectiles.length,3,'two split children only');
assert(g.projectiles.filter(p=>!p.chainSkill&&!p.splitSkill).length===2);for(let i=0;i<30;i++)g.updateProjectiles(1/60);assert(g.projectiles.length<=3,'children never recurse');
// Current-weapon isolation; returning does not erase owned cards.
g=make();grant(g,'sword_wave');g.updateWeaponSkills(.01);g.player.equip.weapon.kind='staff';assert(!g.hasWeaponSkill('sword_wave'));g.updateWeaponSkills(.01);g.updateProjectiles(.01);assert.equal(g.projectiles.length,0);g.player.equip.weapon.kind='sword';assert(g.hasWeaponSkill('sword_wave'));
/* 技能不再从升级卡给（2026-10）—— 走**精英掉落的真实路径**：
   精英死 → 地上掉卷轴 → 走过去捡（collect）→ 学会，而且**不消耗升级机会**。 */
g=make('staff');g.wave=1;
const eliteFoe=deps.Entities.makeFoe(cfg,'tank',g.player.x+40,g.player.y,1,1);
eliteFoe.trialElite=true;eliteFoe.name='铁甲母蟹';eliteFoe.eliteDesc='精英';g.foes.push(eliteFoe);
const pend0=g.player.pendingLevels;
eliteFoe.hp=0;g.onFoeDeath(eliteFoe);
const scroll=g.pickups.find(u=>u.kind==='skill');
/* ⚠️ 掉哪个技能是**随机**的（dropSkillScroll 2026-10 改随机取，为了支持"熟练度解锁的
   新技能有几率掉落"）→ 断言"是手上这把武器的技能"，别写死某一个。 */
const staffSkills=cards.filter(c=>c.weapon==='staff').map(c=>c.id);
assert(scroll,'精英死了要掉技能卷轴');assert(staffSkills.indexOf(scroll.skill)>=0,'掉的是手上这把武器的技能（Lv1 池：'+staffSkills.join('/')+'）');
g.collect(scroll);assert(g.hasWeaponSkill(scroll.skill),'捡起来要学会它');
assert.equal(g.player.pendingLevels,pend0,'掉落的技能**不占升级机会**（这正是这次改动的意义）');
assert(g.skillNotice&&g.skillNotice.name,'拾取时要给"获得 · XX"的提示');
assert.equal(g.state,'play');
// Stress every pair for 30 seconds against a full crowd; verify runtime budgets.
for(const kind of Object.keys(cfg.weapons)){
 g=make(kind);for(const card of cards.filter(c=>c.weapon===kind))grant(g,card.id);
 g.player.base.maxhp=1e8;deps.Progression.recompute(g.player,cfg);g.player.hp=g.player.stats.maxhp;
 for(let i=0;i<44;i++)foe(g,Math.cos(i)*100,Math.sin(i)*100);
 for(let i=0;i<1800;i++){
  g.update(1/60,{moveX:Math.cos(i/80),moveY:Math.sin(i/80),dash:i%60===0});g.drainEvents();
  assert(g.playerShotCount()<=cfg.skillLimits.projectiles);assert(g.skillVisuals.length<=48);assert(g.skillFields.length<=3);assert(g.parts.list.length<=260);assert(Number.isFinite(g.player.hp));
  if(g.state==='levelup'){g.player.pendingLevels=0;g.state='play';}
 }
 console.log('pair stress passed:',kind);
}
console.log('PASS: 10 skill effects, draft/duplicates, save/reset, switch isolation, upgrade UI, bounded pair interactions');

// Switching through the real inventory API preserves ownership; the draft never offers weapon skills any more.
g=make();grant(g,'sword_wave');g.player.bag.push({...deps.Progression.makeDefaultWeapon(cfg),id:'staff-test',kind:'staff'});
assert(g.switchWeapon(1));g.openLevelUp();assert(g.cards.every(c=>!c.weapon),'切武器后升级池里也不许出现武器技能卡');g.cards=[];g.state='play';assert(!g.hasWeaponSkill('sword_wave'));
assert(g.switchWeapon(0));assert(g.hasWeaponSkill('sword_wave'));
assert.equal(g.dropSkillScroll(0,0),'sword_return','切回长剑后，精英掉的是长剑的第二个技能');
console.log('PASS: actual inventory switch and skill ownership travels with the weapon');

/* ---------- 同类连续限流（2026-10 用户选的方案 2） ----------
   规则：上一排出现过机制卡 ⇒ 这一排机制卡权重压到 cfg.growth.repeatMechWeight（0.35）。
   ⚠️ 量的是**出现率**（跑真抽卡 2 万排），不是"参数等于 0.35" —— 参数以后可以改，
      用户要的手感是"连着出明显变少"，这条盯着手感。 */
{
  const isM = deps.Progression.isMechanic;
  /* ⚠️ 必须按**真实调用**抽样：游戏里现在是 `allowSkill:false`（技能改成精英掉落，不再进卡池）。
     旧写法（带武器卡）测的是"每排固定 1 张技能 + 2 张通用"的池子，而游戏里已经没有那个位子了 ——
     照旧写法测会得到 49%、并且**完全看不出限流是否生效**；真实路径下不补限流是 66% 且纹丝不动。 */
  const sample = (lastMech, N) => {
    let hit = 0;
    const rows = N || 20000;
    for (let i = 0; i < rows; i++) {
      const row = deps.Progression.drawUpgrades(cfg, {}, 3, { weapon: 'sword', allowSkill: false, lastMechanic: lastMech });
      assert.equal(row.length, 3);
      assert.equal(new Set(row.map(c => c.id)).size, 3);
      assert(row.every(c => !c.weapon), '技能卡不许再进升级池');
      assert(row.filter(c => c.cost).length <= 1);
      if (row.some(isM)) hit++;
    }
    return hit / rows;
  };
  const plain = sample(false), damped = sample(true);
  assert(plain > 0.60 && plain < 0.72,
    '平时机制卡出现率 ≈66%（实测 ' + (plain * 100).toFixed(1) + '%）—— 比旧卡池的 49% 高，' +
    '因为"每排那个技能位"也回到池子里了（技能改掉档的直接结果，用户已确认方向）');
  assert(damped < plain * 0.7, '上一排有机制卡时这一排要明显变少（' + (plain * 100).toFixed(1) + '% → ' + (damped * 100).toFixed(1) + '%）');
  assert(damped > 0.10, '但也不许压到 0（还要偶尔连出，否则"随机"变成"剧本"）');
  assert.equal(cfg.growth.repeatMechWeight, 0.35, '权重就写在 config 一处（改它一个数就能调松紧）');
  /* 权重调到 0 = 硬禁：抽卡器不许除零算成 NaN（NaN 会抽出一排 undefined —— 表现是"整排空白"） */
  {
    const w = cfg.growth.repeatMechWeight;
    cfg.growth.repeatMechWeight = 0;
    let bad = 0;
    for (let i = 0; i < 500; i++) {
      const row = deps.Progression.drawUpgrades(cfg, {}, 3, { weapon: 'sword', lastMechanic: true });
      if (row.some(c => !c || !c.id)) bad++;
    }
    assert.equal(bad, 0, '限流权重调到 0 时不许抽出空卡（pickWeightedN 的除零保护）');
    cfg.growth.repeatMechWeight = w;
  }
  /* 判断"是不是机制卡"只有一处定义：Progression.isMechanic（别在 game/渲染里各写一份） */
  assert.equal(deps.Progression.isMechanic({ cat: 'mechanic' }), true);
  assert.equal(deps.Progression.isMechanic({ id: 'burstButNoCat', burst: { radiusMul: 2 } }), false,
    '只看 cat，不许用"有 burst"当机制卡的间接特征（处决/灼痕不是 burst 卡）');
  /* 金色版也得带 cat，否则"金色机制卡"抽出来后，下一排的连续限流会漏判 */
  /* ⚠️ 不能直接断言"抽到的就是 exec#rare"：`stackable`（可叠的成长卡：旋刃/长刃/巨刃）
     是**不受 taken 限制**的（Progression.drawUpgrades 里 `!taken[u.id] || u.stackable`），
     永远留在池子里 —— 原来那条断言等于赌 shuffle 的手气（实测命中率约 1/4），
     上游随机数消耗一变就红，而报错信息"池子里只剩处决"完全指错方向。
     要钉的是"金色卡也带 cat"这条不变量，所以先把 stackable 临时摘掉，让池子真的只剩 exec。 */
  const onlyExec = {}, stacked = cfg.upgrades.filter(u => u.stackable);
  cfg.upgrades.forEach(u => { if (!u.weapon && u.id !== 'exec') onlyExec[u.id] = 1; });
  stacked.forEach(u => { u.stackable = false; });
  const goldRow = deps.Progression.drawUpgrades(cfg, onlyExec, 1, { allowSkill: false, rareChance: 1 });
  stacked.forEach(u => { u.stackable = true; });
  assert.equal(goldRow[0].id, 'exec#rare', '池子里只剩「处决」，且被换成金色版');
  assert.equal(deps.Progression.isMechanic(goldRow[0]), true, '金色机制卡也要认得出是机制卡（rareCard 要带 cat）');
  console.log('   连续限流：平时 ' + (plain * 100).toFixed(1) + '% → 上一排有机制卡时 ' + (damped * 100).toFixed(1) + '%');
}
