'use strict';
const assert=require('assert'),cfg=require('../core/config'),World=require('../core/world');
let seed=7301;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
for(let run=0;run<30;run++){
 const w=World.createWorld(cfg,{x:1200,y:800},1),L=w.landmarks;
 assert(w.isFree(L.altar.x,L.altar.y,100),'altar must support an open tutorial');
 // Flood fill the player walkable grid: every landmark must be approachable from spawn.
 const step=20,cols=w.w/step,rows=w.h/step,seen=new Set(),queue=[[60,40]];
 seen.add(40*cols+60);
 for(let head=0;head<queue.length;head++){
  const [x,y]=queue[head];for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
   const nx=x+dx,ny=y+dy,key=ny*cols+nx;
   if(nx<2||ny<2||nx>=cols-2||ny>=rows-2||seen.has(key)||!w.isFree(nx*step,ny*step,22))continue;
   seen.add(key);queue.push([nx,ny]);
  }
 }
 for(const site of [L.well,L.ancientTree].concat(L.houses)){
  assert(queue.some(([x,y])=>Math.hypot(x*step-site.x,y*step-site.y)<95),'landmark inaccessible');
 }
 // Solid visual landmarks cannot overlap existing corridor banks.
 for(const site of [L.well,L.ancientTree])for(const wall of w.walls){
  const dx=wall.x2-wall.x1,dy=wall.y2-wall.y1,t=Math.max(0,Math.min(1,((site.x-wall.x1)*dx+(site.y-wall.y1)*dy)/(dx*dx+dy*dy)));
  assert(Math.hypot(site.x-wall.x1-dx*t,site.y-wall.y1-dy*t)>wall.r+35,'landmark intersects wall');
 }
}
console.log('PASS: 30 realm layouts, open spawn, all landmarks reachable, well/tree clear of walls');
