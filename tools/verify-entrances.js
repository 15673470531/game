'use strict';
const assert=require('assert'),cfg=require('../core/config'),Game=require('../core/game'),Entrances=require('../core/entrances');
const deps={World:require('../core/world'),Entities:require('../core/entities'),Progression:require('../core/progression'),Save:require('../core/save')};
function make(){const values={};const g=new Game(cfg,{...deps,storage:{get:k=>values[k],set:(k,v)=>{values[k]=v;return true;}}});g.setViewport(812,375);const e=new Entrances(g,()=>true);g.startRun(false);return {g,e,values};}
function tick(s,dt=.05,input={}){if(!s.e.beforeUpdate(dt)){s.g.update(dt,input);s.e.afterUpdate();}}
function until(s,test,max=600){for(let i=0;i<max&&!test();i++)tick(s);assert(test(),'timed out waiting for scene');}
function kill(s,f){f.hp=0;s.g.onFoeDeath(f);}
let s=make();until(s,()=>!!s.g.entranceScene);let scout=s.g.foes.find(f=>f.entranceScout);assert(scout);assert.equal(scout.arrival.site.kind,'well');assert(!s.g.trial.eliteSpawned);
let hp=scout.hp,playerHp=s.g.player.hp,elapsed=s.g.elapsed;s.g.damageFoe(scout,9999,0,'weapon');s.g.hurtPlayer(9999,scout.x,scout.y,scout);assert.equal(scout.hp,hp);assert.equal(s.g.player.hp,playerHp);tick(s,.2);assert.equal(s.g.elapsed,elapsed);
const at=s.g.entranceScene.time;s.g.pause();tick(s,.3);assert.equal(s.g.entranceScene.time,at);assert.equal(s.g.state,'paused');s.g.resume();
// Save midway through the shot; both the shot and not-yet-active enemy survive reload.
const snap=JSON.parse(JSON.stringify(deps.Save.snapshot(s.g,true)));assert(snap.run.trial.entrances.active);
const restored=make();deps.Save.applyRun(restored.g,snap);restored.g.state='play';const originalCount=restored.g.foes.length;tick(restored);assert(restored.g.entranceScene);assert.equal(restored.g.foes.length,originalCount);until(restored,()=>!restored.g.entranceScene);assert.equal(restored.g.state,'play');
until(s,()=>!s.g.entranceScene);until(s,()=>scout.arrival.grace<=0);kill(s,scout);until(s,()=>!!s.g.entranceScene&&s.g.entranceScene.kind==='elite');assert(s.g.foes.some(f=>f.trialElite&&f.arrival.site.kind==='chamber'));
// New ordinary arrivals are inert and cannot inflict contact damage or be farmed before emerging.
const n=s.g.foes.find(f=>f.arrival&&f.arrival.elapsed<f.arrival.total);assert(n);assert(s.g.world.isFree(n.x,n.y,n.r));
// Full chapter simulation checks that old quotas, loot gates and boss completion still terminate.
s=make();let bossSeen=false,houseSeen=false,eliteSeen=false,scenes=new Set();
for(let i=0;i<16000&&s.g.state!=='clear';i++){
 s.g.player.inv=10;s.g.player.hp=s.g.player.stats.maxhp;
 if(s.g.state==='levelup'){s.g.cards=[];s.g.player.pendingLevels=0;s.g.state='play';}
 tick(s,.1);
 if(s.g.entranceScene){scenes.add(s.g.entranceScene.kind+'-'+s.g.entranceScene.site.kind);continue;}
 for(const f of s.g.foes.slice()){
  if(f.hp<=0||f.arrival&&(f.arrival.elapsed<f.arrival.total||f.arrival.grace>0))continue;
  assert(f.arrival,'all chapter spawns have a physical entrance');
  if(f.kind==='boss'){bossSeen=true;assert.equal(f.arrival.site.kind,'rift');}
  if(f.trialElite)eliteSeen=true;if(f.arrival.site.kind==='house')houseSeen=true;
  kill(s,f);
 }
 for(const p of s.g.pickups.slice())if(p.kind==='skill'){s.g.collect(p);s.g.pickups.splice(s.g.pickups.indexOf(p),1);}
}
assert.equal(s.g.state,'clear');assert(bossSeen&&eliteSeen&&houseSeen);assert(scenes.has('small-well'));assert(scenes.has('small-house'));assert(scenes.has('boss-rift'));assert.equal(s.g.bossCount,1);
assert(s.g.trial.killsByWave[1]>=cfg.trial.totals[0]*.9);assert(s.g.trial.killsByWave[2]>=cfg.trial.totals[1]*.8);
// Pre-feature local saves retain existing enemy positions rather than teleporting them.
const old=make();const f=deps.Entities.makeFoe(cfg,'slime',old.g.player.x+180,old.g.player.y,1,1,null);old.g.foes=[f];delete old.g.trial.entrances;old.e.beforeUpdate(.01);assert.equal(f.x,old.g.player.x+180);assert.equal(f.arrival.site.kind,'legacy');
for(let i=0;i<24;i++){const sample=make();sample.e.ensureSites();for(const kind of ['well','chamber','rift']){const site=sample.e.choose(kind);assert(site,kind+' must have an exit');const p=sample.e.point(site,kind==='rift'?70:36);assert(p,'exit must remain clear');assert(sample.g.world.isFree(p.x,p.y,kind==='rift'?70:36));}}
console.log('Entrances: physical exits, safe cinematic, pause/resume, mid-shot save, old-save compatibility and complete three-wave battle passed.');
