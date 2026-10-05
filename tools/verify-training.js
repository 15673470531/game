'use strict';
/*
 * 「试炼场（演练场）」入口 + 试 Boss 的验收。
 *
 * 入口历史（2026-10 改过一次，别再翻回去）：
 *   旧：**长按屏幕空白 1.5 秒**（平台层 holdSeconds → takeTraining() → 根 game.js 里 setTraining）。
 *       问题：落点不固定 —— 战斗中手一放上去就误触，而进试炼场会把场上的怪/弹幕/掉落全清掉
 *       （等于当前这一波白打）。用户原话："试炼场从指定位置进去吧，现在这样有时候会点错"。
 *   新（用户选的方案 3AB）：
 *       ① 入口 = 首页右上角「试炼」按钮（`titleRects().trial`，**只有 debug.enabled 时才存在**）
 *       ② 长按手势**整个删掉**（平台层不再有任何"进试炼场"的手势信号）
 *       ③ 允许**从首页直接进**，不用先开局；退出回首页，且不写存档
 *   另外试炼场原来一律无敌 —— "试武器"够用，但**"试 Boss"无敌就等于没试**，
 *   所以有 debug.damage：招照样掉血（钳夹/震荡波/尾针的伤害、推飞、中毒全在），
 *   只是血掉到 1 就停、不进入死亡、也不落盘。
 */
const assert=require('assert'),path=require('path'),fs=require('fs'),root=path.resolve(__dirname,'..');
const cfg=require(root+'/core/config'),Game=require(root+'/core/game'),TouchInput=require(root+'/platform/wechat/input.js'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}

/* ---------- 1. 入口开关：**试炼入口只在 debug 开着时存在**（2026-10 上线时用户已改成 false） ----------
   ⚠️ 这里以前钉的是 `assert.equal(cfg.debug.enabled,true)`（"入口这次是特意打开的"）——
      上线把 debug 关掉之后它就成了假红。正确的口径是**跟着开关走**：
      开着 → 首页有入口且能进；关着 → 首页没有入口、也进不去（正式版就该是这样）。
      试炼场本体仍然照测（下面直接用 setTraining 进去，不依赖入口存不存在）。 */
assert.equal(typeof cfg.debug.enabled,'boolean','debug.enabled 只能是 true/false');
assert.equal(cfg.debug.damage,true,'试炼场里 Boss 要能打到人，否则"试 Boss"试不出惩罚');

/* ---------- 2. 长按手势必须**彻底**删掉 ----------
   ⚠️ 只删一半（比如留着 takeTraining 但没人调用）最容易留下"偶发误触"的余地，
   所以这里连字段名一起扫源码钉住。 */
const inpSrc=fs.readFileSync(root+'/platform/wechat/input.js','utf8');
assert(inpSrc.indexOf('holdMs')<0,'平台层不许再有 holdMs（长按时长）');
assert(inpSrc.indexOf('takeTraining')<0,'平台层不许再有 takeTraining（长按进试炼场的信号）');
assert(inpSrc.indexOf('_trainingTapped')<0 && inpSrc.indexOf('_press')<0,'长按用的中间状态也要一起清掉');
assert(!('holdSeconds' in cfg.debug),'config.debug 里不许再留 holdSeconds');
const entrySrc=fs.readFileSync(root+'/game.js','utf8');
assert(entrySrc.indexOf('takeTraining')<0,'平台入口（根 game.js）不许再消费这个信号');
assert(entrySrc.indexOf('holdSeconds')<0,'平台入口不许再把 holdSeconds 传给 TouchInput（删了就别留半截）');
/* 短按点选**必须留着**（选卡、试炼场按钮、首页按钮全靠它）——删长按别把它一起删掉 */
function mkInput(){
  const h={start:[],move:[],end:[]};
  const api={
    onTouchStart:function(f){h.start.push(f);},onTouchMove:function(f){h.move.push(f);},
    onTouchEnd:function(f){h.end.push(f);},onTouchCancel:function(f){h.end.push(f);}
  };
  const inp=new TouchInput(api,{width:812,height:375,safeArea:{top:0,left:0,width:812,height:375}},{});
  function fire(list,x,y){h[list].forEach(function(f){f({changedTouches:[{identifier:1,clientX:x,clientY:y}]});});}
  return {inp:inp,start:function(x,y){fire('start',x,y);},move:function(x,y){fire('move',x,y);},end:function(x,y){fire('end',x,y);}};
}
const realNow=Date.now;let now=1000;Date.now=function(){return now;};
let t=mkInput();
t.start(400,190);now=1200;t.end(400,190);
assert(t.inp.read({}).tap,'短按仍然算"点选"（删长按不许伤到它）');
t=mkInput();t.start(400,190);now=9000;t.end(400,190);           // 按住 8 秒（旧版会触发长按入口）
assert(!t.inp.read({}).tap,'按太久不算点选（老行为不变）');
Date.now=realNow;

/* ---------- 3. 新入口：首页右上角「试炼」按钮 ---------- */
let g=make();
assert.equal(g.state,'play','构造函数出来就是可玩状态');
assert.equal(g.setTraining(true),true);
assert(g.training);
assert(g.foes.length>0&&g.foes.every(function(f){return f.dummy;}),'进试炼场：一圈练习靶，没有别的怪');
g.setTraining(false);
assert.equal(g.state,'play','从战斗中进出：退出回play（继续这一局）');

/* 首页上的入口：**跟着 debug 开关走** —— 开着要有（位置固定、不压「设置」），关着就必须没有 */
g=make();g.state='title';
let R=g.titleRects();
const savedDbg=cfg.debug.enabled;   // 记住项目里的真实开关（上线是 false），测完必须还回去
cfg.debug.enabled=true;  g=make(); g.state='title'; R=g.titleRects();
assert(R.trial,'debug 开着时首页要有一个固定位置的「试炼」入口');
assert.equal(R.trial.label,'试炼');
assert(R.trial.x+R.trial.w<=R.settings.x,'入口摆在「设置」左边，不许压住它');
assert(R.trial.x>=0&&R.trial.y>=0&&R.trial.x+R.trial.w<=812&&R.trial.y+R.trial.h<=375,'入口要在屏幕内');
/* 调试提示那行不许压在底部按钮排上（2026-10 出图才发现它一直压着「游戏介绍」那一排） */
assert(R.hint,'debug 开着时要有那行提示（位置也在 titleRects 里，渲染和断言共用）');
assert(R.hint.y + R.hint.h/2 <= R.info[0].y,'提示要画在底部按钮排**上面**，不许重叠');
for(const btn of R.info) assert(!(R.hint.y+R.hint.h/2>btn.y && R.hint.y-R.hint.h/2<btn.y+btn.h),'提示不许压到：'+btn.label);
/* 点它 → 从首页直接进试炼场（方案 B：不用先开局） */
assert.equal(g.updateTitle({tap:{x:R.trial.x+R.trial.w/2,y:R.trial.y+R.trial.h/2}}),true);
assert.equal(g.training,true,'点首页的「试炼」要进试炼场');
assert.equal(g.state,'play');
assert(g.foes.every(function(f){return f.dummy;}));
/* 退出 → 回首页（不是被扔进一局没开过的关卡） */
g.setTraining(false);
assert.equal(g.training,false);
assert.equal(g.state,'title','从首页进来的，退出就回首页');
/* 点首页别处（空白）不许进试炼场 */
g=make();g.state='title';
g.updateTitle({tap:{x:60,y:200}});
assert.equal(g.training,false,'首页点空白不该进试炼场');
assert.equal(g.state,'title');
/* 正式版（debug 关掉 = 上线状态）：入口必须**整个消失**，首页和现在一模一样 */
cfg.debug.enabled=false;
assert.equal(make().titleRects().trial,null,'debug 关掉后首页不该有「试炼」按钮');
assert.equal(make().titleRects().hint,null,'debug 关掉后首页那行 debug 提示也要一起没了');
let gOff=make();gOff.state='title';
gOff.updateTitle({tap:{x:700,y:36}});                 // 就是按钮原本在的位置
assert.equal(gOff.training,false,'debug 关掉后那个位置点了也不该进试炼场');
cfg.debug.enabled=savedDbg;                           // 还回项目里的真实值（别硬写成 true）

/* ---------- 3b. 试炼场是沙盒：试卡的结果不许带出门 ----------
   试炼场里有「试卡」面板，它改的是 P.base/taken/evolutions/burst。
   进出不存/不还原的话，"进试炼场白点 26 张卡再退出" = 这一局白拿全部卡。 */
g=make();g.state='title';
g.setTraining(true);
const beforeTaken=Object.keys(g.player.taken).length, beforeAtk=g.player.stats.attackDamage;
g.applyTrialCard('dmg',false);
g.applyTrialCard('skyCut',false);
assert(g.player.taken.dmg&&g.player.burst,'沙盒里点了卡（这些只在试炼场里有效）');
g.setTraining(false);
assert.equal(Object.keys(g.player.taken).length,beforeTaken,'退出试炼场要把试卡的 taken 还回去');
assert.equal(g.player.burst,null,'退出试炼场要把试卡的爆发状态也还回去');
assert.equal(g.player.stats.attackDamage,beforeAtk,'退出试炼场要把试卡的数值还回去');

/* ---------- 4. 切 Boss：第一下就该是荒原巨蝎，血量 = 正式关卡 ---------- */
g=make();g.setTraining(true);
assert.equal(g.trainingBossIdx,0);
assert.equal(g.cycleTrainingBoss(),'warden','第一下切换 Boss 就是第 1 关的荒原巨蝎');
let boss=g.foes.filter(function(f){return f.kind==='boss';})[0];
assert(boss,'Boss 要真的进场');
assert.equal(boss.maxhp,cfg.trial.bossHp,'试炼场血量要和正式关卡一致（否则看不到半血裂壳）');
assert.equal(boss.hp,boss.maxhp);
assert.equal(boss.dmg,0,'接触伤害关掉（招的伤害照常）');
assert.equal(g.trainingBossName(),cfg.bossTypes.warden.name);
// 召唤 Boss 时靶子要收起来（靶子摆在正前方，会压住扇形/细线预警）
assert.equal(g.foes.filter(function(f){return f.dummy;}).length,0,'召唤 Boss 时要清掉练习靶（视线优先）');
// 「重置靶子」只清靶子、留着 Boss —— 想同时看靶子点它
g.resetDummies();
assert.equal(g.foes.filter(function(f){return f.dummy;}).length,cfg.debug.dummies.length,'重置靶子要把靶子摆回来');
assert(g.foes.some(function(f){return f.kind==='boss';}),'重置靶子不能把 Boss 清掉（它得继续放招）');
// 循环一圈回到"取消召唤"：Boss 清掉、靶子摆回来
for(let i=0;i<cfg.bossOrder.length;i++)g.cycleTrainingBoss();
assert.equal(g.trainingBossIdx,0);
assert.equal(g.foes.filter(function(f){return f.kind==='boss';}).length,0,'循环一圈要能取消召唤');
assert.equal(g.foes.filter(function(f){return f.dummy;}).length,cfg.debug.dummies.length,'取消召唤后回到武器试车台（靶子回来）');

/* ---------- 5. 试 Boss：招真的会放（不是"只有靶子"） ---------- */
g=make();g.setTraining(true);g.cycleTrainingBoss();
const P=g.player,b=g.foes.filter(function(f){return f.kind==='boss';})[0];
P.x=b.x-400;P.y=b.y;b.spd=0;                    // 站到"远处"这一段
let sawSpike=false,sawCast=false;
for(let i=0;i<60*10;i++){
  P.inv=0;g.updateFoes(1/60);g.updateProjectiles(1/60);
  if(g.projectiles.some(function(p){return p.spike;}))sawSpike=true;
  if(b.cast)sawCast=true;
  P.x=b.x-400;P.y=b.y;                          // 钉住距离，只看"这一段"出哪招
}
assert(sawSpike,'远处要能放出尾针（线预警 + 针形弹）');
assert(!sawCast,'远处不该出震荡波（严格分段）');

/* ---------- 6. 试炼场里能挨打，但打不死 ---------- */
assert.equal(cfg.debug.damage,true);
g=make();g.setTraining(true);
const P2=g.player;
const hp0=P2.hp;P2.inv=0;
g.hurtPlayer(40,P2.x+20,P2.y);
assert.equal(P2.hp,hp0-40,'开着 damage，试炼场里招是要掉血的');
for(let i=0;i<80;i++){P2.inv=0;g.hurtPlayer(40,P2.x+20,P2.y);}
assert.equal(P2.hp,1,'血量停在 1，试招不该真的死');
assert.equal(g.state,'play','不许进入死亡界面');
assert.equal(P2.dead,false);
assert.equal(g.runs,0,'试炼场打死不算一局（runs 不动）');
g.setTraining(false);
assert.equal(P2.hp,P2.stats.maxhp,'退出试炼场恢复满血');
assert.equal(g.training,false);

/* ---------- 6b. 掉血不许被下一帧顶回去 ----------
   "试炼场无敌"的实现方式是 updateSpawnsTraining 里每帧 `P.hp = maxhp`。
   不关掉那一句的话，挨打只会闪一帧就回满 —— 看起来像血条坏了，也试不出惩罚。
   ⚠️ 这条必须**跑主循环**才测得出来：直接调 hurtPlayer 是过的。 */
g=make();g.setTraining(true);g.cycleTrainingBoss();
const P4=g.player;P4.inv=0;
const hp4=P4.hp;
g.hurtPlayer(40,P4.x+20,P4.y);
assert.equal(P4.hp,hp4-40);
g.updateSpawnsTraining(1/60);
assert.equal(P4.hp,hp4-40,'开着 damage 时，试炼场不能每帧把血顶回满');
// 同一份逻辑：关掉 damage 就照旧每帧回满（老行为）
cfg.debug.damage=false;
g.updateSpawnsTraining(1/60);
assert.equal(P4.hp,P4.stats.maxhp,'关掉 damage 时照旧每帧回满（无敌）');
cfg.debug.damage=true;

/* ---------- 7. 回归护栏：关掉 damage 就是老行为（无敌） ---------- */
cfg.debug.damage=false;
g=make();g.setTraining(true);
const P3=g.player,hp3=P3.hp;P3.inv=0;
g.hurtPlayer(99,P3.x+20,P3.y);
assert.equal(P3.hp,hp3,'debug.damage=false 时试炼场必须还是无敌');
cfg.debug.damage=true;

console.log('PASS: 试炼场入口 = 首页右上角固定按钮（debug 关掉就整个消失 / 位置不压「设置」/ 从首页直接进 / 退出回首页）'
  + ' + 长按手势彻底删掉（源码级钉住，但短按点选没被伤到）'
  + ' + 试炼场是沙盒（试卡结果不许带出门）'
  + ' + 切 Boss 到荒原巨蝎（真血量）+ 招真的会放 + 可挨打但不死 + 关掉开关回到无敌');
