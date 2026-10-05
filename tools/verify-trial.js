'use strict';
const assert=require('assert'),path=require('path'),r=path.resolve(__dirname,'../core'),cfg=require(r+'/config'),Game=require(r+'/game'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(r+'/'+f);
let seed=930;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
function make(){
  let g=new Game(cfg,deps);g.setViewport(812,375);
  /* 这个用例里要用到**全部四把武器**（关卡波次、法杖收尾都要用）；
     正式局开局只有默认那把（2026-10 用户口径：开局不能选武器），
     所以这里显式补齐 —— 等价于"已经打到过四把"的状态。 */
  Object.keys(cfg.weapons).forEach(kind=>{if(!g.player.bag.some(it=>it.kind===kind)){const it=deps.Progression.makeDefaultWeapon(cfg);it.id='t-'+kind;it.kind=kind;it.name=cfg.weapons[kind].name;g.player.bag.push(it);}});
  return g;
}
function kill(g,f){f.hp=0;g.onFoeDeath(f);if(g.state==='levelup'){g.player.pendingLevels=0;g.cards=[];g.state='play';}}
/* 开局只有默认那把（单独验一次，别和上面"补齐四把"的便利混在一起） */
{const g0=new Game(cfg,deps);g0.setViewport(812,375);
 assert.equal(g0.player.bag.length,1,'开局库里只有 1 把');
 assert.equal(g0.player.bag[0].kind,cfg.items.startWeapon,'开局那把 = cfg.items.startWeapon');}
let g=make();
// Three finite waves, elite gates, boss gates, no automatic frenzy.
let stages=new Set(),eliteSeen=false;
for(let i=0;i<800&&g.wave<3;i++){
 g.updateTrialSpawns(.5);stages.add(g.wave);
 for(const f of g.foes.slice()){if(f.trialElite)eliteSeen=true;kill(g,f);}
 /* 第 1 波的教学 gate（2026-10）：精英死了还得**走过去把卷轴捡起来**才会继续刷怪群。
    这里模拟"玩家走过去踩到" —— 也是这条用例真正想覆盖的完整链路。 */
 for(const u of g.pickups.slice())if(u.kind==='skill'){g.collect(u);g.pickups.splice(g.pickups.indexOf(u),1);}
 assert(g.foes.length<=cfg.waves.cap);assert(!g.player.frenzy);
}
assert(eliteSeen);assert.equal(g.wave,3);assert.equal(g.player.frenzyCharge,25);
for(let i=0;i<150&&!g.bossAlive;i++){g.updateTrialSpawns(.5);for(const f of g.foes.slice())if(f.kind!=='boss')kill(g,f);}
assert.equal(g.bossAlive,1);assert.equal(g.foes.filter(f=>f.kind==='boss').length,1);
let boss=g.foes.find(f=>f.kind==='boss');assert.equal(boss.hp,cfg.trial.bossHp);assert(g.activateFrenzy());assert(!g.activateFrenzy());
const counter=g.trial.spawned;for(let i=0;i<10;i++)g.updateTrialSpawns(.5);assert.equal(g.trial.spawned,counter);
const snap=JSON.parse(JSON.stringify(deps.Save.snapshot(g,true))),restored=make();deps.Save.applyRun(restored,snap);assert.deepEqual(restored.trial,g.trial);assert.equal(restored.bossAlive,1);assert.equal(restored.foes.find(f=>f.kind==='boss').hp,boss.hp);
kill(g,boss);g.updateClear(1);assert.equal(g.state,'clear');assert(g.clearInfo.complete);g.updateClearPanel(1,{tap:{x:400,y:200}});assert.equal(g.state,'title');assert.equal(g.stage,1);
// Elite cannot be skipped or executed.
g=make();g.wave=2;g.trial.tide={phase:"done"};g.trial.spawned=cfg.trial.totals[1];g.trial.killed=cfg.trial.totals[1];g.updateTrialSpawns(2);assert(g.foes.some(f=>f.trialElite));g.updateTrialSpawns(2);assert.equal(g.wave,2);const e=g.foes.find(f=>f.trialElite);e.hp=100;g.player.stats.execute=.9;g.damageFoe(e,1,0,'weapon');assert(e.hp>0);
// 技能来源改成精英掉落（2026-10）：升级池里**永远**没有武器卡；掉落给"手上武器的下一个技能"。
g=make();g.player.pendingLevels=1;g.openLevelUp();assert(g.cards.every(c=>!c.weapon),'升级池里不许出现武器技能卡');g.cards=[];g.state='play';g.player.pendingLevels=0;
/* ⚠️ 2026-10 起掉落改成**随机取一个**（不再是"按 config 顺序取第一个"）——
   因为要支持用户口径"熟练度解锁的新技能**有几率**掉落"：按顺序取的话，
   池子从 2 个变 3 个而一局只掉 2 次，排在最后那个（正好是新解锁的）永远轮不到。
   熟练度 Lv1 时长剑池只有 2 个，所以一局两只精英正好给全，只是顺序不保证。 */
const sk1=g.dropSkillScroll(0,0);assert(['sword_wave','sword_return'].includes(sk1),'Lv1 掉的是长剑那两个之一（剑阵回响要 Lv2 才进池）');assert(g.grantSkill(sk1),'卷轴要真学会（grantSkill 返回非空）');
const sk2=g.dropSkillScroll(0,0);assert.equal(sk2,sk1==='sword_wave'?'sword_return':'sword_wave','第二个精英给另一个（两只正好给全）');assert(g.grantSkill(sk2));
assert.equal(g.dropSkillScroll(0,0),null,'两个都拿到了 → 不硬塞一个"捡了没反应"的卷轴');
// Stat reductions, equipment budget and disabled draft cards.
let base=g.player.base.attackDamage;deps.Progression.applyUpgrade(cfg,g.player,'dmg');assert(Math.abs(g.player.base.attackDamage/base-1.08)<1e-8);g.player.base.spd=1000;deps.Progression.recompute(g.player,cfg);assert.equal(g.player.stats.spd,212.5);
for(let i=0;i<100;i++)assert(!deps.Progression.drawUpgrades(cfg,{},3,{weapon:'sword'}).some(c=>c.id.startsWith('sprint')));
let old=JSON.parse(JSON.stringify(snap));delete old.balanceVersion;delete old.run.trialVersion;old.run.stage=5;old.run.wave=7;old.base.attackDamage=999;const mig=make();deps.Save.applyRun(mig,old);assert.equal(mig.stage,1);assert.equal(mig.wave,1);assert(mig.player.stats.attackDamage<100);
// Completion clears resumable run while retaining actual earned loot.
let raw=null;const disk={get:()=>raw,set:(key,v)=>{raw=v;},remove:()=>{raw=null;}};g=new Game(cfg,{...deps,storage:disk});g.trial.finished=true;g.state='clear';g.saveNow();assert(!JSON.parse(raw).run);
console.log('PASS: finite three waves, elite/boss gates, manual frenzy, save migration/resume, growth caps and completion');
// A real WeChat touch reaches frenzy rather than being swallowed by the dash button.
const TouchInput=require('../platform/wechat/input');
for(const h of [320,375]){
 const handlers={},wx={onTouchStart:f=>handlers.start=f,onTouchMove:f=>handlers.move=f,onTouchEnd:f=>handlers.end=f,onTouchCancel:f=>handlers.cancel=f};
 g=make();g.setViewport(812,h,{top:20,bottom:20,left:44,right:44});g.player.frenzyCharge=25;
 const input=new TouchInput(wx,{width:812,height:h,safeArea:{top:20,height:h-40}}),rect=g.frenzyRect(),touch={identifier:1,clientX:rect.x+42,clientY:rect.y+24};
 assert(rect.y>=98);assert(Math.hypot(touch.clientX-input.btnDash.x,touch.clientY-input.btnDash.y)>input.btnDash.r*1.25);
 handlers.start({changedTouches:[touch]});handlers.end({changedTouches:[touch]});g.update(.016,input.read(g));assert.equal(g.player.frenzy,6);
 const t=g.trial.spawned;g.state='paused';g.update(1,{});assert.equal(g.player.frenzy,6);assert.equal(g.trial.spawned,t);
}
// Final spell kill can clear the projectile list during iteration without crashing.
g=make();g.wave=3;g.trial.spawned=cfg.trial.totals[2];g.trial.killed=Math.ceil(cfg.trial.totals[2]*.8);g.updateSpawns(2);boss=g.foes.find(f=>f.kind==='boss');boss.x=g.player.x+60;boss.y=g.player.y-14;boss.hp=1;
g.player.equip.weapon=g.player.bag.find(it=>it.kind==='staff');g.castSpell(g.weapon(),g.player.stats);g.castSpell(g.weapon(),g.player.stats);g.updateProjectiles(.1);assert(g.trial.finished);
console.log('PASS: WeChat touch routing, pause freezes frenzy, final spell kill');
assert.notEqual(g.state,'levelup','final boss XP must not force a post-victory card selection');
