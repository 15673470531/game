const assert=require('assert'), path=require('path');
const dir=path.resolve(__dirname,'..'), cfg=require(dir+'/core/config');
const deps={}; for(const [k,f] of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(dir+'/core/'+f);
const Game=require(dir+'/core/game');
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}
let g=make(), P=g.player;
const up=id=>deps.Progression.applyUpgrade(cfg,P,id);
up('life');assert.equal(P.stats.lifesteal,.5);up('thorns#rare');up('thorns');assert.equal(P.stats.thornsMul,.8);
for(const id of ['trail','dash','blades','aspd','giantblade','dmg'])up(id);
assert.deepEqual(P.evolutions,{flame:true,storm:true,quake:true});
P.runGold=65;P.gold=1000;g.state='dead';assert(g.doubleDeathGold());assert.equal(P.gold,1065);assert(!g.doubleDeathGold());
g=make(); P=g.player; let f=deps.Entities.makeFoe(cfg,'slime',P.x+30,P.y,1,1);f.gold=103;g.foes=[f];g.damageFoe(f,9999,0,'weapon');assert.equal(g.pickups.length,5);assert.equal(g.pickups.reduce((s,p)=>s+p.value,0),103);assert.equal(g.hitstop,0);
for(let i=0;i<24;i++){f=deps.Entities.makeFoe(cfg,'slime',P.x+30,P.y,1,1);g.foes.push(f);g.damageFoe(f,9999,0,'weapon');}assert.equal(P.frenzy,0);assert.equal(P.frenzyCharge,25);g.state='play';assert(g.activateFrenzy());assert.equal(P.frenzy,6);
P.runGold=40; const snapshot=deps.Save.snapshot(g,true), resumed=make();deps.Save.applyRun(resumed,JSON.parse(JSON.stringify(snapshot)));assert.equal(resumed.player.runGold,40);assert.equal(resumed.player.frenzy,6);
g=make();P=g.player;up('trail');up('dash');f=deps.Entities.makeFoe(cfg,'tank',P.x+45,P.y,1,1);g.foes=[f];g.updatePlayer(1/60,{moveX:1,dash:true});assert(f.hp<f.maxhp);assert(g.flameCd>0);
g=make();P=g.player;up('giantblade');up('dmg');P.equip.weapon={kind:'greatsword',affixes:[]};f=deps.Entities.makeFoe(cfg,'slime',P.x+30,P.y,1,1);g.foes=[f];g.damageFoe(f,9999,0,'weapon');assert(g.quakePulse);g.state='play';P.pendingLevels=0;g.update(.2,{});assert(!g.quakePulse);
const parts=new deps.Entities.Particles();for(let i=0;i<500;i++){parts.burst(0,0,'red',20);parts.text(0,0,'5');}assert(parts.list.length<=260);const ref=parts.list;parts.update(2);assert.equal(parts.list.length,0);assert.equal(parts.list,ref);
// Simulate several dense fights, exercise all weapon paths and repeated level-ups.
for(const kind of Object.keys(cfg.weapons)){
 g=make();P=g.player;P.equip.weapon={kind,affixes:[]};P.base.maxhp=1e7;deps.Progression.recompute(P,cfg);P.hp=P.stats.maxhp;
 for(let i=0;i<120;i++)g.foes.push(deps.Entities.makeFoe(cfg,i%2?'slime':'tank',P.x+Math.cos(i)*100,P.y+Math.sin(i)*100,1,1));
 for(let frame=0;frame<900;frame++){
  if(g.state==='levelup'){deps.Progression.applyUpgrade(cfg,P,g.cards[0].id);P.pendingLevels=0;g.state='play';}
  if(g.state==='clear'||g.state==='intro') {g.enterStage(g.stage+1);g.state='play';}
  g.update(1/60,{moveX:Math.cos(frame/80),moveY:Math.sin(frame/80),dash:frame%60===0});g.drainEvents();
  assert(Number.isFinite(P.hp)&&Number.isFinite(P.x));assert(g.parts.list.length<=260);
 }
 console.log('密集战斗通过',kind,'击杀',P.kills);
}
console.log('PASS: regression, evolutions, frenzy, save/resume, exact gold, particle bounds, dense fights');
