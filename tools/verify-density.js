'use strict';
const assert=require('assert'),path=require('path'),root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}
/* 第 1 波的教学 gate（2026-10）：开场只出精英 + 随行慢速小怪，**学到技能之前不刷怪群**。
   这个文件里量的全是"怪群密度/上限/经验预算"，所以要先把 gate 放行
   （等价于"教学那一课已经上完了"）。gate 本身的行为在 verify-skill-drop.js 里钉。 */
function unlocked(){const g=make();g.trial.skillTaken=true;return g;}
function seeded(){let seed=123;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
function spawns(charge,active){seeded();const g=unlocked();g.player.frenzyCharge=charge;g.player.frenzy=active;for(let i=0;i<100;i++)g.updateSpawns(.1);return g;}
const normal=spawns(0,0),ready=spawns(25,0),active=spawns(0,6);
assert.deepEqual(normal.foes,ready.foes);assert.deepEqual(normal.foes,active.foes);assert.equal(active.enemyCap(),cfg.waves.cap);assert.equal(active.harvestWarn,0);
// Finite supply even when each batch is immediately cleared, with no harvest or swarm events.
let g=unlocked();for(let i=0;i<300;i++){g.foes=[];g.updateSpawns(.1);g.checkSwarm();}assert.equal(g.trial.spawned,cfg.trial.totals[0]);assert.equal(g.wave,1);assert.equal(g.swarmWarn,null);
g=unlocked();g.foes=Array.from({length:cfg.waves.cap},()=>deps.Entities.makeFoe(cfg,'slime',100,100,1,1));g.updateSpawns(5);assert.equal(g.foes.length,cfg.waves.cap);assert.equal(g.trial.spawned,0);
// Boss timing depends on the wave, not frenzy or kills from unrelated enemies.
g=make();g.wave=3;g.trial.spawned=cfg.trial.totals[2];g.trial.killed=Math.ceil(cfg.trial.totals[2]*.8);g.player.frenzy=6;g.updateSpawns(2);assert.equal(g.bossAlive,1);const n=g.foes.length;g.updateSpawns(60);assert.equal(g.foes.length,n);
for(const [x,y]of [[60,60],[2340,60],[60,1540],[2340,1540],[1200,800]]){
 g=make();g.player.x=x;g.player.y=y;g.updateCamera();let found=0;
 for(let i=0;i<40;i++){const p=g.trialSpawnPoint();if(!p)continue;found++;assert(p.x>=60&&p.y>=60&&p.x<=2340&&p.y<=1540);assert(Math.hypot(p.x-x,p.y-y)>=180);assert(p.x<=g.cam.x-20||p.x>=g.cam.x+812/cfg.camera.zoom+20||p.y<=g.cam.y-20||p.y>=g.cam.y+375/cfg.camera.zoom+20);}
 assert(found>=30,'edge spawning starved');
}
// An active elite and outstanding finite spawn budget survive a restart.
g=make();g.wave=2;g.trial.tide={phase:"done"};g.trial.killed=cfg.trial.eliteAt;g.trial.spawned=50;g.updateSpawns(2);const elite=g.foes.find(f=>f.trialElite);assert(elite);elite.hp-=125;
const saved=JSON.parse(JSON.stringify(deps.Save.snapshot(g,true))),resumed=make();deps.Save.applyRun(resumed,saved);assert.deepEqual(resumed.trial,g.trial);assert.equal(resumed.foes.find(f=>f.trialElite).hp,elite.hp);resumed.updateSpawns(10);assert.equal(resumed.foes.filter(f=>f.trialElite).length,1);
console.log('PASS: frenzy-independent finite supply, shared caps, boss timing, safe edge spawns and elite resume');

// Increased living density and exact finite XP budget, independent of death order.
for(let wave=1;wave<=3;wave++){
 g=unlocked();g.wave=wave;g.trialSpawnPoint=()=>({x:100,y:100});
 /* ⚠️ 不能只跑固定帧数：落点被固定成 (100,100) 之后，每一批能站进来几只取决于**那一局地图
    生成出来的石头位置**（实测第 3 关那个世界，一批只能进 ~8 只）。固定 100 帧时根本填不满
    cap —— 这是测试自身的脆性，不是刷怪逻辑坏了。要测的性质是"同屏密度能达到 cap"，
    所以跑到填满为止，跑不满才算失败。 */
 for(let i=0;i<4000&&g.foes.length<Math.min(cfg.trial.caps[wave-1],g.enemyCap());i++)g.updateSpawns(.1);
 assert.equal(g.foes.length,cfg.trial.caps[wave-1]);
 g=unlocked();g.wave=wave;g.trialSpawnPoint=()=>({x:100,y:100});let xp=0,thin=0;
 for(let i=0;i<cfg.trial.totals[wave-1];i++){assert(g.spawnTrialFoe(false));const f=g.foes.pop();xp+=f.xp;assert(Number.isInteger(f.xp)&&f.xp>=0);assert(f.gold>=0);if(f.type==='slime'&&f.maxhp<180)thin++;}
 assert.equal(xp,cfg.trial.xpBudgets[wave-1]-(wave<=2?cfg.tide.xp:0));
}
console.log('PASS: living density targets and exact per-wave XP budgets');
