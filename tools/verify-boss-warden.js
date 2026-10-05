'use strict';
/*
 * 荒原巨蝎（第 1 关 Boss）机制重做的验收。
 *
 * 背景：真机反馈「第一关的 boss 只会跟着人走，没一点机制」。量出来的原因是
 *   30 秒里只有 8 个动作（85% 的时间在走路）、两招都与距离无关、贴脸零代价。
 * 这次改成**按距离分段**三招 + 半血裂壳：
 *   近身 双钳夹击（疼 + 把你推开）/ 中距 震荡波（圈落你脚下）/ 远程 尾针锁定（直线，只能横向躲）
 *   半血裂壳：移速 +30%、尾针三连、钳夹冷却减半
 * 这个文件把上面每一条都钉成断言 —— 尤其是**方向锁定**和**裂壳只触发一次**这两条，
 * 它们是"看着像有机制、实际没有/反而更糟"的典型翻车点。
 */
const assert=require('assert'),path=require('path'),root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
// 固定随机（Boss 的 spd 是区间随机）—— 不然断言的数值每次都不一样
let seed=20261003;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}
const B=cfg.bossTypes.warden;

/** 干净场景：只有一只荒原巨蝎，玩家满血不无敌。ang=0 时 Boss 在玩家的右边 dist 处
 *  ⚠️ 玩家用**关卡自己的出生点**（一定是空地），Boss 放好之后先 collide 一次 ——
 *     地图是随机生成的，写死坐标很容易把 Boss 放进石头里，它会被推开、距离就变了。
 *     pin 之后每帧把双方钉回原位，"距离段"这几条断言才是确定性的。 */
function scene(dist,ang){
  const g=make(),P=g.player;
  g.foes=[];g.projectiles=[];g.hazards=[];
  P.hp=P.stats.maxhp=10000;P.inv=0;
  const a=ang===undefined?0:ang;
  const b=g.Entities.makeBoss(cfg,P.x+Math.cos(a)*dist,P.y+Math.sin(a)*dist,1,'warden',1);
  g.world.collide(b);
  g.foes.push(b);
  g.spawnFoe=function(){};                     // 挡掉杂兵，断言里只有 Boss 这一只
  return {g:g,P:P,b:b,pinP:{x:P.x,y:P.y},pinB:{x:b.x,y:b.y}};
}
/** 钉住双方（测"这个距离段该出哪招"时用），不钉就是自由距离 */
function pin(s){s.pin=true;return s;}
/** 把玩家钉成"不会死"再跑一帧（foes + 弹幕都要走，不然弹幕永远不消失、会越积越多） */
function tick(s,dt){
  const d=dt===undefined?1/60:dt;
  s.P.inv=0;s.g.updateFoes(d);s.g.updateProjectiles(d);
  if(s.pin){s.P.x=s.pinP.x;s.P.y=s.pinP.y;s.b.x=s.pinB.x;s.b.y=s.pinB.y;}
}
/** 一直跑到 cond 成立或超时（超时就断言失败，避免静默通过） */
function until(s,cond,maxFrames,msg){
  for(let i=0;i<(maxFrames||900);i++){tick(s);if(cond(s))return true;}
  assert(false,'等不到：'+msg);
}

/* ---------- 1. 新状态齐全、旧弹幕已删 ---------- */
let s=scene(400);
assert.equal(typeof s.b.clawT,'number');assert.equal(typeof s.b.stingT,'number');
assert.equal(s.b.claw,0);assert.equal(s.b.sting,0);assert.equal(s.b.crack,0);
assert.equal(s.b.phase2,false);
assert(!B.volley,'环形弹幕应该已经从配置里删掉（它没有蝎子身份、和尾针重复）');
assert(!('volleyT' in s.b),'boss 上不该再留着 volleyT');

/* ---------- 2. 距离分段：每个距离段只起"这一段"的招（区间互不重叠） ---------- */
// 远（400）：只有尾针；震荡波（区间 140~330）和钳夹（<140）都不该出现
s=pin(scene(400));s.b.spd=0;
let farSting=0,farClaw=0,farCast=0;
for(let i=0;i<60*16;i++){
  tick(s);
  if(s.b.sting>0)farSting++;
  if(s.b.claw>0)farClaw++;
  if(s.b.cast)farCast++;
}
assert(farSting>0,'远距离必须起尾针');
assert.equal(farClaw,0,'远距离不该起近身钳夹');
assert.equal(farCast,0,'400px 在 slam 区间（140~330）之外，不该起震荡波');

// 中（250）：只起震荡波
s=pin(scene(250));s.b.spd=0;
let midCast=0,midClaw=0,midSting=0;
for(let i=0;i<60*16;i++){
  tick(s);
  if(s.b.cast)midCast++;
  if(s.b.claw>0)midClaw++;
  if(s.b.sting>0)midSting++;
}
assert(midCast>0,'中距离必须起震荡波');
assert.equal(midClaw,0,'250px 在 claw.range 之外，不该起钳夹');
assert.equal(midSting,0,'250px 还在 slam 区间内，不该起尾针（严格分段 = 一个距离只有一件事）');

// 近（100）：只起钳夹
s=pin(scene(100));s.b.spd=0;
let nearClaw=0,nearSting=0,nearCast=0;
for(let i=0;i<60*16;i++){
  tick(s);
  if(s.b.claw>0)nearClaw++;
  if(s.b.sting>0)nearSting++;
  if(s.b.cast)nearCast++;
}
assert(nearClaw>0,'近身必须起钳夹');
assert.equal(nearSting,0,'贴脸时不该放尾针（直线在 100px 内没有躲避空间 = 不公平）');
assert.equal(nearCast,0,'贴脸时只剩钳夹这一件事（严格分段，不再和震荡波交替砸）');

/* ---------- 3. 尾针：方向锁死在预警开始那一刻（躲法是"侧移"，不是"后退"） ---------- */
s=pin(scene(400));s.b.spd=0;
until(s,function(x){return x.b.sting>0;},900,'起尾针');
const locked=s.b.chargeDir;
assert(Math.abs(locked-Math.atan2(s.P.y-s.b.y,s.P.x-s.b.x))<1e-6,'锁定方向 = 起手那一刻"Boss→玩家"的方向');
const aim0=Math.atan2(s.P.y-s.b.y,s.P.x-s.b.x);
s.P.y+=220;                                  // 玩家在预警期间往侧面走开（并且不再钉住）
const aimNow=Math.atan2(s.P.y-s.b.y,s.P.x-s.b.x);
assert(Math.abs(aimNow-locked)>0.3,'（前提检查）玩家确实挪出了原来的直线');
s.g.projectiles=[];
until(s,function(x){return x.g.projectiles.length>0;},180,'把针射出来');
const needle=s.g.projectiles.find(function(p){return p.spike;});
assert(needle,'射出来的必须是针形弹（spike），不是圆点弹');
assert(Math.abs(Math.atan2(needle.vy,needle.vx)-locked)<1e-9,'针的方向必须锁死在预警开始那一刻（否则又是"跟着人走"）');
assert(Math.abs(Math.atan2(needle.vy,needle.vx)-aimNow)>0.3,'针不能追着玩家拐 —— 那样就不是"侧移能躲"了');

/* ---------- 4. 尾针命中：掉血 + 中毒减速（只削走路，冲刺照旧） ---------- */
s=scene(400);s.b.spd=0;
const g4=make(),P4=g4.player;g4.foes=[];g4.state='play';g4.trial=null;
g4.spawnFoe=function(){};
P4.hp=P4.stats.maxhp=1000;P4.inv=0;
const shot=g4.Entities.makeProjectile(P4.x-70,P4.y,0,B.sting.speed,B.sting.damage,B.sting.width,'#c8e06a','foe');
shot.spike=true;shot.slow=B.sting.slowMul;shot.slowTime=B.sting.slowTime;shot.life=1;
g4.projectiles=[shot];
const hpBefore=P4.hp;
g4.updateProjectiles(0.12);
assert(P4.hp<hpBefore,'毒刺应该打到玩家');
assert.equal(P4.slowT>0,true,'命中要挂中毒');
assert.equal(P4.slowMul,B.sting.slowMul);
// 走路的实际速度必须按 slowMul 掉下来 —— 直接读 updatePlayer 写出的 P.vx（不依赖地图碰撞）
P4.slowT=B.sting.slowTime;P4.slowMul=B.sting.slowMul;
g4.updatePlayer(1/60,{moveX:1,moveY:0});
const slowedV=Math.abs(P4.vx);
P4.slowT=0;P4.slowMul=1;
g4.updatePlayer(1/60,{moveX:1,moveY:0});
const normalV=Math.abs(P4.vx);
assert(Math.abs(slowedV/normalV-B.sting.slowMul)<0.02,'中毒时走路速度应该正好是 slowMul 倍');
// 冲刺不受中毒影响（否则被扎一次就真的走不掉了）
P4.slowT=B.sting.slowTime;P4.slowMul=B.sting.slowMul;P4.dashcd=0;
g4.updatePlayer(1/60,{moveX:1,moveY:0,dash:true});
const dashV=Math.abs(P4.vx);
assert(dashV>normalV,'中毒不应该拖慢冲刺（冲刺是脱身手段）');
assert(P4.slowT>0&&P4.slowMul>0,'中毒状态本身还在');

/* ---------- 5. 双钳夹击：扇形内 = 掉血 + 被推开；扇形外 = 不挨打 ---------- */
// 场景里 Boss 在玩家右边，所以玩家在 Boss 的 angle=π 方向
s=scene(100);s.b.spd=0;
const P5=s.P,b5=s.b;
b5.claw=B.claw.telegraph;b5.clawTotal=B.claw.telegraph;
b5.clawDir=Math.PI;b5.clawRange=B.claw.range;b5.clawArc=B.claw.arc;
const hp5=P5.hp,d5=Math.hypot(P5.x-b5.x,P5.y-b5.y);
until(s,function(x){return x.b.claw<=0;},120,'钳夹落地');
assert(P5.hp<hp5,'扇形内应该挨打');
const d5b=Math.hypot(P5.x-b5.x,P5.y-b5.y);
assert(d5b>d5+30,'被夹住还要被**推开**（代价是离开原来的输出位置，不只是掉血）');

// 扇形朝反方向（Boss 朝右夹，玩家在左边）→ 角度不匹配，不该挨打
s=scene(100);s.b.spd=0;
const P5b=s.P,b5b=s.b;
b5b.claw=B.claw.telegraph;b5b.clawTotal=B.claw.telegraph;
b5b.clawDir=0;b5b.clawRange=B.claw.range;b5b.clawArc=B.claw.arc;
const hp5b=P5b.hp;
until(s,function(x){return x.b.claw<=0;},120,'钳夹落地（反向）');
assert.equal(P5b.hp,hp5b,'扇形外不该挨打 —— 不然"侧身躲开"就是假的');

/* ---------- 6. 半血裂壳：更快、招更密、尾针三连，且**只裂一次** ---------- */
s=scene(400);s.b.spd=0;
const b6=s.b,spd0=b6.spd;
b6.hp=b6.maxhp*B.phase2.atHp;
tick(s);
assert.equal(b6.phase2,true,'半血必须裂壳');
assert(Math.abs(b6.spd-spd0*B.phase2.spdMul)<1e-9,'裂壳后移速要 ×'+B.phase2.spdMul);
// 尾针三连
until(s,function(x){return x.b.sting>0;},900,'裂壳后起尾针');
s.g.projectiles=[];
until(s,function(x){return x.g.projectiles.length>0;},180,'裂壳后把针射出来');
assert.equal(s.g.projectiles.length,B.sting.burst,'裂壳后尾针应该是 '+B.sting.burst+' 连发');
assert(s.g.projectiles.every(function(p){return p.spike;}),'三连也必须是针形弹');
// 不会每帧重复裂壳（重复乘 spdMul = Boss 越打越快）
const spd1=b6.spd;
for(let i=0;i<180;i++)tick(s);
assert(Math.abs(b6.spd-spd1)<1e-9,'裂壳只能触发一次（否则每帧乘一次 1.3，Boss 会越跑越快）');

// 裂壳后钳夹冷却减半
s=scene(100);s.b.spd=0;
const b6b=s.b;b6b.hp=b6b.maxhp*B.phase2.atHp;tick(s);
assert.equal(b6b.phase2,true);
until(s,function(x){return x.b.claw>0;},900,'裂壳后起钳夹');
assert(Math.abs(b6b.clawT-B.claw.cooldown*B.phase2.clawCdMul)<0.05,'裂壳后钳夹冷却要 ×'+B.phase2.clawCdMul);

/* ---------- 7. 存档：预警清零、裂壳状态保留、spd 不被二次放大 ---------- */
s=scene(300);
const b7=s.b;b7.hp=b7.maxhp*B.phase2.atHp;tick(s);
assert.equal(b7.phase2,true);
const spdSaved=b7.spd;
s.P.slowT=1.6;s.P.slowMul=B.sting.slowMul;
const snap=JSON.parse(JSON.stringify(deps.Save.snapshot(s.g,true)));
const resumed=make();deps.Save.applyRun(resumed,snap);
const b7b=resumed.foes.filter(function(f){return f.kind==='boss';})[0];
assert(b7b,'读档后 Boss 要还在');
assert.equal(b7b.phase2,true,'裂壳状态必须保留');
assert.equal(b7b.claw,0);assert.equal(b7b.sting,0,'读档后预警一律清零（口径同 windup/cast：重新预警）');
assert(Math.abs(b7b.spd-spdSaved)<1e-9,'读档不能把 spdMul 再乘一次');
assert.equal(resumed.player.slowT,0,'中毒不该跨存档（回来就是"走不动"的状态很劝退）');
resumed.player.inv=1e9;
b7b.hp=b7b.maxhp*B.phase2.atHp;
for(let i=0;i<120;i++)resumed.updateFoes(1/60);
assert(Math.abs(b7b.spd-spdSaved)<1e-9,'读档后半血也不能重新裂壳一次');

/* ---------- 8. 血量降了一档（用户口径："血量可以降低一点"） ---------- */
assert.equal(cfg.trial.bossHp,3200);
s=scene(300);
assert.equal(s.b.maxhp,3200,'第 1 关 Boss 的实际血量 = trial.bossHp');
assert.equal(s.b.hp,s.b.maxhp);

/* ---------- 9. 回归：Boss 的远程弹只剩毒刺，不再有"一簇圆弹" ---------- */
s=scene(420);s.b.spd=0;
for(let i=0;i<60*20;i++)tick(s);
assert(s.g.projectiles.length>0,'20 秒远距离总该放出针了');
assert(s.g.projectiles.every(function(p){return p.spike;}),'Boss 的远程弹必须全是毒刺（环形弹幕已删）');
assert(s.g.projectiles.length<=B.sting.burst,'一次最多 '+B.sting.burst+' 发（裂壳前应该是 1 发）');

console.log('PASS: 荒原巨蝎 距离分段(钳/波/针) + 尾针方向锁定与中毒减速 + 扇形命中推开 + 半血裂壳一次性 + 存档迁移 + 血量 3200 + 环形弹幕已删');
