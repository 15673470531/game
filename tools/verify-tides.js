'use strict';
const assert=require('assert'),path=require('path'),r=path.resolve(__dirname,'../core'),cfg=require(r+'/config'),Game=require(r+'/game'),deps={};for(const[k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(r+'/'+f);
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}
function kill(g,f){f.hp=0;g.onFoeDeath(f);g.state='play';g.player.pendingLevels=0;}
let g=make();g.spawnTrialFoe(false,{x:100,y:100});const old=g.foes[0];g.pickups.push({kind:'gold',x:200,y:200,value:2});g.projectiles.push({x:1});g.hazards.push({x:2});g.advanceTrialWave();assert(g.foes.includes(old));assert.equal(g.pickups.length,1);assert.equal(g.projectiles.length,1);assert.equal(g.hazards.length,1);kill(g,old);assert.equal(g.trial.killed,0);assert.equal(g.trial.killsByWave[1],1);
g.spawnTrialFoe(false,{x:100,y:100});kill(g,g.foes[0]);assert.equal(g.trial.killed,1);
for(let wave=1;wave<=2;wave++){
 g=make();g.wave=wave;g.trial.killed=cfg.tide.triggers[wave-1];g.updateTide(.1);assert.equal(g.trial.tide.phase,'warning');const n=g.foes.length;g.updateTide(1);assert.equal(g.foes.length,n);assert.equal(g.trial.tide.phase,'warning');
 const raw=JSON.parse(JSON.stringify(deps.Save.snapshot(g,true))),resumed=make();deps.Save.applyRun(resumed,raw);assert.deepEqual(resumed.trial,g.trial);
 g.updateTide(.6);assert.equal(g.enemyCap(),120);for(let i=0;i<100;i++)g.updateTide(.1);
 assert.equal(g.trial.tide.phase,'done');assert.equal(g.trial.tide.spawned,24);assert.equal(g.foes.filter(f=>f.tideFoe).length,24);assert.equal(g.foes.reduce((s,f)=>s+f.xp,0),12);
 const before=g.trial.killed;for(const f of g.foes.slice())kill(g,f);assert.equal(g.trial.killed,before);for(let i=0;i<100;i++)g.updateTide(.1);assert.equal(g.foes.length,0);
}
g=make();g.wave=3;g.trial.killed=120;g.updateTide(5);assert(!g.trial.tide);
g=make();g.trial.killed=35;g.updateTide(.1);g.updateTide(2);g.foes=Array.from({length:120},()=>deps.Entities.makeFoe(cfg,'slime',100,100,1,1));g.updateTide(1);assert.equal(g.foes.length,120);g.updateTide(20);assert.equal(g.trial.tide.phase,'done');
// All ordinary hunters, including leftovers, count toward the two-hunter cap.
g=make();g.wave=2;g.trial.spawned=9;for(let i=0;i<80;i++)g.spawnTrialFoe(false,{x:100,y:100});assert(g.foes.filter(f=>f.type==='charger').length<=2);
const hunters=g.foes.filter(f=>f.type==='charger');hunters.forEach(f=>{f.chargeCd=0;f.x=g.player.x+180;f.y=g.player.y;});g.updateCharger(.1,hunters[0],-180,0,180);g.updateCharger(.1,hunters[1],-180,0,180);assert(hunters[0].windup>0);assert.equal(hunters[1].windup,0);const angle=hunters[0].chargeDir;g.updateCharger(1,hunters[0],0,180,180);assert.equal(hunters[0].chargeDir,angle);g.updateCharger(.5,hunters[0],0,180,180);assert(hunters[0].recovery>=1);
console.log('PASS: surviving enemies/drops/hazards, wave attribution, two finite tides, warning/save, XP budget, caps, timeout and staggered pounces');
