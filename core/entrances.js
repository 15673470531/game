'use strict';
// Chapter-only staging. The regular wave/reward counters remain owned by Game.
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function smooth(x){x=clamp(x,0,1);return x*x*(3-2*x);}
function Entrances(game,enabled){this.g=game;this.isEnabled=enabled;this.world=null;this.sites=[];this.hook();game.entrances=this;}
Entrances.prototype.enabled=function(){return this.isEnabled()&&!this.g.training&&!!this.g.world.landmarks;};
Entrances.prototype.data=function(){var t=this.g.trial;return t.entrances||(t.entrances={seen:{},queue:[],active:null,serial:0,scoutStarted:false});};
Entrances.prototype.findFree=function(x,y,r,avoidPlayer){
 var g=this.g;
 for(var ring=0;ring<7;ring++)for(var i=0;i<(ring?16:1);i++){
  var a=i*Math.PI/8,px=x+Math.cos(a)*ring*24,py=y+Math.sin(a)*ring*24;
  if(px>r+20&&py>r+20&&px<g.world.w-r-20&&py<g.world.h-r-20&&g.world.isFree(px,py,r)&&(!avoidPlayer||Math.hypot(px-g.player.x,py-g.player.y)>r+g.player.r+35))return {x:px,y:py};
 }
 return null;
};
Entrances.prototype.ensureSites=function(){
 var g=this.g;if(this.world===g.world)return;this.world=g.world;this.sites=[];
 var L=g.world.landmarks;if(!L)return;var self=this;
 this.sites.push({id:'well',kind:'well',x:L.well.x,y:L.well.y,mouthX:L.well.x,mouthY:L.well.y+60});
 L.houses.forEach(function(h,i){self.sites.push({id:'house-'+i,kind:'house',x:h.x,y:h.y,mouthX:h.x,mouthY:h.y+h.h*.55+30});});
 var chamber=this.findFree(L.altar.x+240,L.altar.y-210,100),rift=this.findFree(L.altar.x+70,L.altar.y+225,120);
 if(chamber){
  var cy=chamber.y-72;this.sites.push({id:'chamber',kind:'chamber',x:chamber.x,y:cy,mouthX:chamber.x,mouthY:chamber.y});
  // Three solid sides, a clear doorway and walkable stairs. No invisible front wall.
  [-1,1].forEach(function(side){g.world.walls.push({x1:chamber.x+side*55,y1:cy-60,x2:chamber.x+side*55,y2:cy+20,r:10,ruin:true,entrance:true});});
  g.world.walls.push({x1:chamber.x-55,y1:cy-60,x2:chamber.x+55,y2:cy-60,r:10,ruin:true,entrance:true});
 }
 if(rift)this.sites.push({id:'rift',kind:'rift',x:rift.x,y:rift.y,mouthX:rift.x,mouthY:rift.y});
};
Entrances.prototype.choose=function(kind){
 this.ensureSites();var g=this.g,list=this.sites.filter(function(s){return kind==='small'?(s.kind==='well'||s.kind==='house'):s.kind===kind;});
 if(!list.length)return null;
 var serial=this.data().serial;
 // Rotate through the nearest three exits; the other end of the map never spawns into empty space.
 list.sort(function(a,b){return Math.hypot(a.x-g.player.x,a.y-g.player.y)-Math.hypot(b.x-g.player.x,b.y-g.player.y);});
 return list[serial%Math.min(kind==='small'?3:1,list.length)];
};
Entrances.prototype.point=function(site,r){
 if(!site)return null;var n=this.data().serial,angle=(n%7-3)*.28;
 var p=this.findFree(site.mouthX+Math.sin(angle)*38,site.mouthY+Math.abs(Math.sin(angle))*24,r,true);
 return p;
};
Entrances.prototype.mark=function(f,site,scout){
 var d=this.data(),kind=f.kind==='boss'?'boss':f.trialElite?'elite':'small',key=kind==='small'?'small-'+site.kind:kind+'-'+this.g.wave;
 var full=!d.seen[key];d.seen[key]=true;d.opened=d.opened||{};d.opened[site.id]=true;d.serial++;
 f.arrival={id:d.serial,site:site,elapsed:0,total:kind==='boss'?1.65:kind==='elite'?1.25:.85,grace:.55,wait:full?0:(d.serial%6)*.07};
 if(scout)f.entranceScout=true;
 if(full){
  d.queue.push({id:f.arrival.id,site:site,kind:kind,time:0,duration:kind==='boss'?3.6:2.8,title:kind==='boss'?'荒原巨蝎':kind==='elite'?f.name:site.kind==='well'?'井底的刮擦声':'门后的动静',subtitle:kind==='boss'?'祭坛亮起的瞬间，地下有什么醒了。':kind==='elite'?'封闭的石室，正在被从里面推开。':site.kind==='well'?'枯井里，先伸出了一只爪子。':'木门震动，黑暗里的眼睛睁开了。'});
 }
};
Entrances.prototype.hook=function(){
 var self=this,g=this.g,spawn=g.spawnTrialFoe,update=g.updateTrialSpawns,advance=g.advanceTrialWave,realm=g.realmEntrance,reset=g.reset,objective=g.trialObjective;
 g.trialObjective=function(){if(self.enabled()){var d=self.data();if(g.wave===1&&!g.trial.eliteSpawned&&d.scoutStarted)return '击败从枯井爬出的怪物';}return objective.apply(g,arguments);};
 g.reset=function(){g.entranceScene=null;return reset.apply(g,arguments);};
 g.realmEntrance=function(boss){if(!self.enabled())return realm.apply(g,arguments);return self.point(self.choose(boss?'rift':'chamber'),boss?70:36);};
 g.spawnTrialFoe=function(elite,point){
  if(!self.enabled())return spawn.apply(g,arguments);
  var site=self.forcedSite||self.choose(elite?'chamber':'small'),p=self.point(site,elite?36:28);if(!p)return false;
  var ok=spawn.call(g,elite,p);if(ok)self.mark(g.foes[g.foes.length-1],site,!!self.scout);return ok;
 };
 g.advanceTrialWave=function(){var d=self.enabled()?self.data():null;var out=advance.apply(g,arguments);if(d){g.trial.entrances=d;g.saveNow();}return out;};
 g.updateTrialSpawns=function(dt){
  if(!self.enabled())return update.call(g,dt);
  self.ensureSites();var d=self.data();
  if(g.wave===1&&!g.trial.eliteSpawned&&!d.scoutStarted){
   if(g.trial.delay>0){g.trial.delay=Math.max(0,g.trial.delay-dt);return;}
   self.forcedSite=self.choose('well');self.scout=true;
   var ok=g.spawnTrialFoe(false);self.forcedSite=null;self.scout=false;if(ok)d.scoutStarted=true;return;
  }
  if(g.wave===1&&!g.trial.eliteSpawned&&g.foes.some(function(f){return f.entranceScout&&f.hp>0;}))return;
  var out=update.call(g,dt);
  // Tide enemies and the boss are created directly by the existing wave code.
  g.foes.forEach(function(f){if(f.arrival||f.hp<=0)return;var site=self.choose(f.kind==='boss'?'rift':f.trialElite?'chamber':'small'),p=self.point(site,f.kind==='boss'?70:f.r+5);if(p){f.x=p.x;f.y=p.y;self.mark(f,site,false);}});
  return out;
 };
};
Entrances.prototype.beforeUpdate=function(dt){
 var g=this.g;if(!this.enabled()){g.entranceScene=null;return false;}this.ensureSites();var d=this.data();
 if(!d.hydrated&&g.foes.length){d.scoutStarted=true;g.foes.forEach(function(f){if(f.arrival)return;var site={id:'legacy',kind:'legacy',x:f.x,y:f.y,mouthX:f.x,mouthY:f.y};f.arrival={id:++d.serial,site:site,elapsed:1,total:1,grace:0,wait:0};});if(g.trial.eliteSpawned)d.seen['elite-'+g.wave]=true;if(g.stageBossPending)d.seen['boss-3']=true;}
 d.hydrated=true;
 if(g.state==='paused'||g.state==='bag'||g.state==='levelup')return false;
 if(d.active){
  g.state='intro';g.entranceScene=d.active;var a=d.active;a.time+=dt;
  var f=g.foes.find(function(f){return f.arrival&&f.arrival.id===a.id;});
  if(f){f.arrival.elapsed=clamp(a.time-.65,0,f.arrival.total);f.arrival.grace=.65;}
  if(a.time>.7&&!a.impact){a.impact=true;g.emit(a.kind==='boss'?'entranceBreak':a.site.kind==='well'?'entranceWell':a.site.kind==='house'?'entranceDoor':'entranceStone',{});}
  var z=(g.cfg.camera&&g.cfg.camera.zoom)||1,w=g.viewport.w/z,h=g.viewport.h/z;
  var tx=clamp(a.site.x-w/2,0,Math.max(0,g.world.w-w)),ty=clamp(a.site.y-h/2,0,Math.max(0,g.world.h-h));
  var weight=smooth(a.time/.65)*(1-smooth((a.time-(a.duration-.55))/.55));
  g.cam.x=a.from.x+(tx-a.from.x)*weight;g.cam.y=a.from.y+(ty-a.from.y)*weight;
  if(a.time>=a.duration){d.active=null;g.entranceScene=null;g.state='play';g.player.inv=Math.max(g.player.inv,.65);g.updateCamera();g.saveNow();}
  return true;
 }
 if(g.state==='play')g.foes.forEach(function(f){var a=f.arrival;if(!a)return;if(a.wait>0){a.wait=Math.max(0,a.wait-dt);return;}if(a.elapsed<a.total)a.elapsed=Math.min(a.total,a.elapsed+dt);else a.grace=Math.max(0,a.grace-dt);});
 return false;
};
Entrances.prototype.afterUpdate=function(){
 if(!this.enabled()||this.g.state!=='play')return;var d=this.data(),g=this.g;
 if(!d.active&&d.queue.length){var a=d.queue.shift();a.from={x:g.cam.x,y:g.cam.y};d.active=a;g.entranceScene=a;g.state='intro';g.emit('entranceRumble',{});g.saveNow();}
};
if(typeof module!=='undefined'&&module.exports)module.exports=Entrances;
var root=typeof GameGlobal!=='undefined'?GameGlobal:globalThis;(root.__GAME__=root.__GAME__||{}).Entrances=Entrances;
