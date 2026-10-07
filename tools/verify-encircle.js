'use strict';
const assert=require('assert'),path=require('path'),root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
let seed=42;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}
for(let iteration=0;iteration<20;iteration++){
 const g=make(),P=g.player;
 /* 第 1 波教学 gate（2026-10）：不先"学会技能"就不会刷怪群 —— 本用例量的是包围/密度，先放行。 */
 g.trial.skillTaken=true;assert(Math.abs((P.x-g.cam.x)*cfg.camera.zoom-406)<1e-6);assert(Math.abs((P.y-g.cam.y)*cfg.camera.zoom-187.5)<1e-6);
 assert(g.world.landmarks.bamboo.length>=15);assert.equal(g.world.landmarks.houses.length,5);assert.equal(g.world.paths.length,11);assert.equal(g.world.walls.filter(w=>w.corridor).length,4);
 for(const road of g.world.paths)for(let i=0;i<=30;i++){const t=i/30;assert(g.world.isFree(road.x1+(road.x2-road.x1)*t,road.y1+(road.y2-road.y1)*t,P.r+12),'road obstructed');}
 g.updateSpawns(.7);assert(g.foes.length>=8,'initial squads too small');
 for(let i=0;i<100;i++)g.updateSpawns(.1);
 assert.equal(g.foes.length,cfg.trial.caps[0]);
 const sides=new Set();for(const f of g.foes){assert(g.world.isFree(f.x,f.y,f.r));assert(f.x<=g.cam.x-20||f.x>=g.cam.x+812/.9+20||f.y<=g.cam.y-20||f.y>=g.cam.y+375/.9+20);sides.add(Math.abs(f.x-P.x)>400?(f.x<P.x?'L':'R'):(f.y<P.y?'T':'B'));}assert(sides.size>=3);
 const before=g.foes.reduce((s,f)=>s+Math.hypot(f.x-P.x,f.y-P.y),0);P.inv=100;
 for(let frame=0;frame<360;frame++)g.updateFoes(1/60);
 const after=g.foes.reduce((s,f)=>s+Math.hypot(f.x-P.x,f.y-P.y),0);assert(after<before*.65,'squads failed to approach');
}
let g=make(),P=g.player;g.hurtPlayer(5,P.x+20,P.y);const hp=P.hp;assert(P.inv>=.7);for(let i=0;i<30;i++)g.hurtPlayer(5,P.x+20,P.y);assert.equal(P.hp,hp);
// Two overlapping enemies spread apart; weapon knockback can still open a gap.
g=make();P=g.player;g.foes=[deps.Entities.makeFoe(cfg,'slime',P.x+100,P.y,1,1),deps.Entities.makeFoe(cfg,'slime',P.x+100,P.y,1,1)];g.foes.forEach(f=>f.spd=0);for(let i=0;i<60;i++)g.updateFoes(1/60);assert(Math.hypot(g.foes[0].x-g.foes[1].x,g.foes[0].y-g.foes[1].y)>15);const f=g.foes[0];g.damageFoe(f,1,120,'weapon');assert(Math.hypot(f.kb.x,f.kb.y)>50);
console.log('PASS: 20 maps, open connected paths, centered zoom, offscreen multi-side squads, pursuit, separation, knockback and contact protection');
