'use strict';
/*
 * 限次爆发卡「开天」的验收（2026-10 用户口径："武器长度增加 5 倍，但只能砍 2 次"）。
 *
 * 用户逐条定的规则，每一条都在下面被钉住：
 *   ① "一次" = **一个转动窗口**（起转 → 收刃），不按圈数、更不按命中数
 *   ② 抽到后**下次起转才生效**（抽卡时可能正在收刃，立刻生效爽点会被冷却吃掉）
 *   ③ 长度 ×5 = 判定半径 ×5，且**长枪/大剑的刀尖会飞出屏幕**（用户选"不管"）
 *   ④ 抽到就登记，用满 2 个窗口后彻底失效
 *   ⑤ 记录剩余刀数要能看见（HUD 徽标 + 属性页一行）、要跨读档保留
 *
 * ⚠️ 这个文件里最容易写假的两处，都特意绕开了：
 *   · 抽卡走**真实的选卡路径**（openLevelUp → updateLevelUp 点卡片），不是直接调 grantBurst
 *   · "打不打得到"用**真的刀刃扫掠**跑出来（updateOrbit 循环），不是比一个半径数字
 */
const assert=require('assert'),path=require('path');
const root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
let seed=777;Math.random=function(){seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};

function make(kind){
  const g=new Game(cfg,deps);g.setViewport(812,375);
  g.player.x=1200;g.player.y=800;g.player.face=0;
  g.world.rocks.length=0;g.world.walls.length=0;
  if(kind){g.player.equip.weapon={kind,affixes:[],id:kind};g.player.bag=[g.player.equip.weapon];g.Prog.recompute(g.player,cfg);}
  g.spawnFoe=function(){};g.updateSpawns=function(){};
  return g;
}
const R=function(g){return g.orbitParams().radius;};
/** 手动走一次"起转"（走进 updateOrbit 的起转分支） */
function spin(g){g.player.orbOn=false;g.player.orbT=0;g.updateOrbit(1/60);}
/** 手动走一次"收刃"（这个转动窗口结束） */
function sheathe(g){g.player.orbOn=true;g.player.orbT=0;g.updateOrbit(1/60);}
function cardOf(id){return cfg.upgrades.filter(function(u){return u.id===id;})[0];}

/* ---------- 1. 卡定义 + 金色版参数 ---------- */
const sky=cardOf('skyCut');
assert(sky,'config 里要有「开天」这张卡');
assert.deepEqual(sky.burst,{radiusMul:5,swings:2},'普通版：×5、2 刀');
assert.deepEqual(sky.rare.burst,{radiusMul:8,swings:3},'金色版：×8、3 刀');
assert.equal(sky.weapon,undefined,'它不是武器专属卡（武器技能卡的数量被测试钉在 10 张）');
assert.equal(!!sky.cost,false,'它不是代价卡（每排最多 1 张代价卡，别去占那个位子）');
/* 金色版抽卡对象必须带上 burst —— 漏带是最难查的一类 bug。
   走真实抽卡路径把它逼出来：把池子里其它非武器卡都标记成"拿过"、并关掉武器技能，
   于是这一排只剩「开天」，再用 rareChance:1 强制升级成金色版。
   ⚠️ 2026-10 起"成长卡"（长刃/巨刃/旋刃）标了 stackable，**永远不会被 taken 排除**，
      光标记"拿过"已经清不空池子了 —— 这里临时把它们 disabled 掉（抽卡层认这个标记），跑完还原。 */
const takenAll={}, restored=[];
cfg.upgrades.forEach(function(u){
  if(u.weapon||u.id==='skyCut')return;
  takenAll[u.id]=1;
  if(u.stackable){restored.push(u);u.disabled=true;}
});
const goldRow=deps.Progression.drawUpgrades(cfg,takenAll,1,{allowSkill:false,rareChance:1});
assert.equal(goldRow.length,1,'池子里只剩开天一张');
restored.forEach(function(u){delete u.disabled;});   // 还原（后面的断言还要用这些卡）
assert.equal(goldRow[0].id,'skyCut#rare');
assert.equal(goldRow[0].gold,true,'金色标记叫 gold（不能叫 rare，config 里每张卡都有 rare）');
assert.deepEqual(goldRow[0].burst,{radiusMul:8,swings:3},'金色版抽卡对象要把 burst 带过来（×8、3 刀）');

/* ---------- 2. 抽到卡：只登记，**不立刻生效** ---------- */
let g=make('sword');
const baseR=R(g);
assert.equal(baseR,70,'长剑的基准半径 70（orbitRadius）');
// 走真实选卡路径：把这一排卡钉成只有「开天」
const origDraw=deps.Progression.drawUpgrades;
deps.Progression.drawUpgrades=function(){return [sky];};
g.player.pendingLevels=1;g.openLevelUp();g.cardGuard=0;
assert.equal(g.state,'levelup');
const rect=g.cardRects()[0];
g.updateLevelUp({tap:{x:rect.x+rect.w/2,y:rect.y+rect.h/2}});
deps.Progression.drawUpgrades=origDraw;
assert.equal(g.state,'play','点完卡要回到 play');
assert.equal(g.player.pendingLevels,0);
assert(g.player.taken.skyCut,'卡片要记进 taken（一次性，抽过就不再出现）');
assert(g.player.burst,'选卡路径要登记爆发状态');
assert.equal(g.player.burst.left,2,'还剩 2 刀');
assert.equal(g.player.burst.active,false,'抽到的那一刻不生效');
assert.equal(R(g),baseR,'抽到卡**不能**立刻把刀变长（下次起转才生效）');

/* ---------- 3. 第一刀：起转时消耗一个窗口并生效 ---------- */
spin(g);
assert.equal(g.player.burst.left,1,'第一刀用掉一个窗口');
assert.equal(g.player.burst.active,true);
assert(Math.abs(R(g)-baseR*5)<1e-6,'生效中半径 = 基准 ×5（长剑 70 → 350）');
// 这一刀打完 → 收刃，加成跟着窗口结束
sheathe(g);
assert.equal(g.player.burst.active,false);
assert(Math.abs(R(g)-baseR)<1e-6,'收刃期加成要结束（刀已经收回去了，半径不该还挂着）');

/* ---------- 4. 第二刀：再用掉一个窗口；第三刀不再生效 ---------- */
spin(g);
assert.equal(g.player.burst.left,0,'第二刀用掉最后一个窗口');
assert.equal(g.player.burst.active,true);
assert(Math.abs(R(g)-baseR*5)<1e-6);
sheathe(g);
assert.equal(g.player.burst.active,false);
spin(g);
assert.equal(g.player.burst.left,0,'已经没有窗口了');
assert.equal(g.player.burst.active,false,'第三刀不许再生效');
assert(Math.abs(R(g)-baseR)<1e-6,'第三刀半径回到基准');

/* ---------- 5. 真的能打到 5 倍外的怪吗（跑真刀刃扫掠，不是比半径数字） ---------- */
function hitsAt(dist,withBurst){
  const t=make('sword'),P=t.player;
  const f=deps.Entities.makeFoe(cfg,'tank',P.x+dist,P.y,1,1);
  f.hp=f.maxhp=1e5;f.spd=0;t.foes.push(f);
  if(withBurst){P.burst={id:'skyCut',name:'开天',left:2,active:false,radiusMul:5};}
  P.orbOn=true;P.orbT=99;P.orbAng=0;P.orbPrev=0;      // 直接开转，跑满两圈
  for(let i=0;i<130;i++){P.burst&&(P.burst.active=true);t.updateOrbit(1/60);}
  return f.hp<f.maxhp;
}
assert.equal(hitsAt(200,false),false,'平时（半径 70）打不到 200px 外的怪');
assert.equal(hitsAt(200,true),true,'爆发（半径 350）能打到 200px 外的怪 —— 这是"刀真的变长了"');

/* ---------- 6. 存档：剩余刀数保留，但 active 清零 ---------- */
g=make('sword');
g.player.burst={id:'skyCut',name:'开天',left:1,active:true,radiusMul:5};
const snap=JSON.parse(JSON.stringify(deps.Save.snapshot(g,true)));
const resumed=make('sword');deps.Save.applyRun(resumed,snap);
assert(resumed.player.burst,'读档要把爆发状态接回来（不然切后台回来就白拿一张卡）');
assert.equal(resumed.player.burst.left,1,'剩余刀数要保留');
assert.equal(resumed.player.burst.active,false,'读档后必须重新起转才算第一刀（口径同"敌方攻击重新预警"）');
assert.equal(resumed.player.burst.radiusMul,5);
spin(resumed);
assert.equal(resumed.player.burst.left,0);
assert(Math.abs(R(resumed)-70*5)<1e-6,'读档后起转仍然生效');

/* ---------- 7. 读档不许凭空多出加成；死亡重开要清干净 ---------- */
g=make('sword');
assert.equal(g.player.burst,null,'干净开局没有爆发状态');
g.player.burst={id:'skyCut',name:'开天',left:2,active:true,radiusMul:5};
g.reset();                                            // 死亡重开
assert.equal(g.player.burst,null,'死亡重开要把爆发清掉（reset 里换的是新 player，字段要跟着新）');
assert(Math.abs(R(g)-70)<1e-6);

/* ---------- 8. 剩余刀数看得见 ---------- */
g=make('sword');g.player.taken.skyCut=1;
g.player.burst={id:'skyCut',name:'开天',left:2,active:false,radiusMul:5};
let rows=deps.Progression.statRows(cfg,g.player);
const row=rows.filter(function(r){return r.label.indexOf('开天')===0;})[0];
assert(row,'属性页要有一行"开天 · 剩余刀数"');
assert.equal(row.nowV,2,'属性页显示的是当前剩余刀数');
g.player.burst.left=0;
rows=deps.Progression.statRows(cfg,g.player);
assert.equal(rows.filter(function(r){return r.label.indexOf('开天')===0;})[0].nowV,0,'用完显示 0');

/* ---------- 9. 和别的卡的叠加、切武器都不崩 ---------- */
g=make('spear');
const spearBase=R(g);
g.player.taken.skyCut=1;
g.player.burst={id:'skyCut',name:'开天',left:2,active:true,radiusMul:5};
const spearR=R(g);
assert(Math.abs(spearR-spearBase*5)<1e-6,'长枪 ×5 = ' + spearR.toFixed(0) + 'px');
assert(spearR>451,'确实超过了屏幕可见半宽 451px —— 用户选的处理 1"不管，出屏就出屏"（判定照常）');
g.player.bag.push({...deps.Progression.makeDefaultWeapon(cfg),id:'staff-x',kind:'staff'});
assert(g.switchWeapon(g.player.bag.length-1));
assert(g.player.burst,'切武器不该把爆发状态丢掉');
assert.equal(g.player.burst.active,true,'切武器时窗口还在，加成也还在');
g.setTraining(true);
g.update(1/60,{moveX:0,moveY:0});
assert(Number.isFinite(R(g)),'进试炼场之后半径不能变成 NaN');
g.setTraining(false);

/* ---------- 10. 渲染层和判定层必须同一套半径（这条是被出图抓出来的 bug） ----------
   ⚠️ 渲染层（drawOrbit）是**自己重算半径**的，不读核心层的 orbitParams()。
   第一版只在 orbitParams 里乘了 ×5 → 判定已经打到 350px 外、画出来的刀还是 70 长
   （正好踩中用户口径"武器多大就打到哪里，画面和伤害得对得上"），靠预览出图才发现。
   这里用假 ctx 把 drawOrbit 的 scale（= 武器拉伸倍率 k，正比于半径）录下来比对。 */
const Renderer=require(root+'/render/renderer.js');
function fakeCtx(){
  const scales=[];
  const rec={rotates:0,texts:[]};
  const noop=function(){};
  const c={canvas:{width:812,height:375}};
  ['save','restore','translate','beginPath','moveTo','lineTo','closePath','fill','stroke',
   'arc','arcTo','ellipse','fillRect','strokeRect','clearRect','clip','quadraticCurveTo','bezierCurveTo'].forEach(function(k){c[k]=noop;});
  c.scale=function(x,y){scales.push(x);};
  c.rotate=function(){rec.rotates++;};          // 每画一把刀一次 rotate → 数它就知道画了几把
  c.fillText=function(s,x,y){rec.texts.push({s:String(s),x:x,y:y});};
  c.strokeText=function(s,x,y){rec.texts.push({s:String(s),x:x,y:y});};
  c.measureText=function(){return {width:10};};
  c.createLinearGradient=function(){throw new Error('渲染层不许用 createLinearGradient（假 ctx 会崩）');};
  c.createRadialGradient=function(){throw new Error('渲染层不许用 createRadialGradient');};
  c.setLineDash=function(){throw new Error('渲染层不许用 setLineDash');};
  return {ctx:c,scales:scales,rec:rec};        // ⚠️ 返回 rec 这个对象本身（不是 rec.rotates 的快照，否则永远是 0）
}
function drawnK(orbitRadius,burstActive){
  const t=make('sword'),P=t.player;
  if(orbitRadius)P.stats.orbitRadius=orbitRadius;      // 只改半径这一个量，量它画出来多长
  P.orbOn=true;P.orbAng=0.6;P.orbT=1;
  if(burstActive)P.burst={id:'skyCut',name:'开天',left:2,active:true,radiusMul:5};
  const f=fakeCtx();
  const r=new Renderer(f.ctx,{cfg:cfg,createCanvas:function(){return null;}});
  r.resize(812,375);r.zoom=1;r.viewX=0;r.viewY=0;r.dt=1/60;r.lastT=1;
  /* ⚠️ drawOrbit 的第一个参数是 game（2026-10 起它要读 game.orbitParams() 拿半径/刃数 ——
     以前渲染层自己重算，漏了叠刃那一项，表现成"只有效果、视觉还是一把剑"）。 */
  r.drawOrbit(t,P,1,'front');
  assert(f.scales.length>0,'drawOrbit 应该至少画一把刀');
  return Math.max.apply(null,f.scales);                // k：武器本体整段映射到半径上的倍率
}
/* ⚠️ 不能直接比 k —— k = (半径 − 握把半径) / 本体长度，带减法和常数偏移，
   所以"半径 ×5"对应的 k 不是 ×5（实测是 ×8）。要比的是**刀尖离玩家多远**。
   自己标定：量两个已知半径下的 k，解出握把半径 G 和本体长度 span，
   于是"画出来的刀尖距离"= G + k·span，和判定半径是同一个数。 */
const kA=drawnK(70,false), kB=drawnK(140,false);
const span=70/(kB-kA), grip=70-kA*span;
const tip=function(k){return grip+k*span;};
assert(Math.abs(tip(kA)-70)<0.05,'自检：基准半径 70 画出来就该是 70（实测 ' + tip(kA).toFixed(2) + '）');
assert(Math.abs(tip(drawnK(70,true))-350)<0.5,
  '画出来的刀尖必须落在 350px（= 判定半径 ×5），实测 ' + tip(drawnK(70,true)).toFixed(1) + 'px —— ' +
  '渲染层自己重算半径，漏了这一步就是"判定打到 350、画面还是 70"');

/* ==================== 千刃（刃数爆发） ====================
   ⚠️ 这张卡唯一会做废的地方：试炼版的归一化 `dmg *= baseBlades*(1+extra*0.15)/blades`。
      把爆发加上的刃数也丢进除数 ⇒ "4 把刀、每把只打 36%" ⇒ 总 DPS 只 +45%，白叫千刃。
      所以下面**量的是"同一只怪在一个窗口里挨了多少总伤害"**，不是比一个参数。 */
const BStorm={id:'bladeStorm',name:'千刃',left:2,active:true,radiusMul:1,bladesSet:6};

/** 数一帧里画了几把刀（front + behind 两层各画一半，加起来就是总刃数） */
function drawnBlades(burst){
  const t=make('sword'),P=t.player;
  P.orbOn=true;P.orbAng=0.6;P.orbT=1;
  if(burst)P.burst=burst;
  let n=0;
  for(const layer of ['front','behind']){
    const f=fakeCtx();
    const r=new Renderer(f.ctx,{cfg:cfg,createCanvas:function(){return null;}});
    r.resize(812,375);r.zoom=1;r.viewX=0;r.viewY=0;r.dt=1/60;r.lastT=1;
    /* ⚠️ 第一个参数是 game（见 drawnK 那段的说明） */
    r.drawOrbit(t,P,1,layer);
    n+=f.rec.rotates;
  }
  return n;
}

/** 跑一个真的转动窗口（updateOrbit + 怪的命中冷却都要走），返回 N 只**打不死**的贴脸靶子吃到的总伤害。
    ⚠️ 必须多摆几只、且靶子打不死：单个靶子时命中次数是离散的（1 刃 3 下 vs 6 刃 15 下）
      会量出 ×5 这种假数；靶子会死的话后面的刀没地方打，读数会被压平（血刃那次就量反了）。 */
function windowDamage(burst,nFoes){
  const t=make('sword'),P=t.player;
  P.x=1200;P.y=800;
  const N=nFoes||8, RING=55, foes=[];
  for(let i=0;i<N;i++){
    const a=i/N*Math.PI*2;                                  // 均匀摊在 55px 的环上（同一位置的相位会一致 → 读数偏）
    const f=deps.Entities.makeFoe(cfg,'tank',P.x+Math.cos(a)*RING,P.y+Math.sin(a)*RING,1,1);
    f.hp=f.maxhp=1e9; f.orbCd=0; f.xp=0; f.gold=0; f._a=a;
    t.foes.push(f); foes.push(f);
  }
  if(burst)P.burst=JSON.parse(JSON.stringify(burst));
  let total=0;
  t.damageFoe=function(foe,d){ total+=d; return 1; };      // 只统计、不真打
  P.orbOn=false;P.orbT=0;                                  // 从"起转"开始
  for(let i=0;i<150;i++){
    for(const f of foes){ f.x=P.x+Math.cos(f._a)*RING; f.y=P.y+Math.sin(f._a)*RING; f.orbCd=Math.max(0,f.orbCd-1/60); }
    t.updateOrbit(1/60);
  }
  return total;
}

assert.equal(drawnBlades(null),1,'长剑平时画 1 把刀');
assert.equal(drawnBlades(BStorm),6,'千刃生效时画 6 把刀（渲染层自己重算刃数：漏同步就是"判定 6 把、画面 1 把"）');
let gs=make('sword');
const perBlade0=gs.orbitParams().dmg;              // 没爆发时的单刃伤害（= 攻击力 × orbitDmg，别拿攻击力比）
assert.equal(gs.orbitParams().blades,1);
gs.player.burst=JSON.parse(JSON.stringify(BStorm));
const opS=gs.orbitParams();
assert.equal(opS.blades,6,'判定侧刃数直接变 6 把');
assert(Math.abs(opS.dmg-perBlade0)<1e-9,
  '每一刀的伤害**不许被归一化打下来**（应该是 '+perBlade0.toFixed(1)+'，实际 '+opS.dmg.toFixed(1)+'）');
const dmgPlain=windowDamage(null), dmgStorm=windowDamage(BStorm);
const stormRatio=dmgStorm/dmgPlain;
assert(stormRatio>5.5&&stormRatio<6.5,
  '千刃一个窗口的总伤害必须 ≈ ×6（8 只靶子实测 ×'+stormRatio.toFixed(2)+'）——掉到 1.4 附近就是被归一化吃了');

/* 旋刃**不封顶**（2026-10 用户："旋刃也不要封顶吧"）：堆到 7 把就是 7 把。
   顺便守住那条老口径：千刃是"直接变 6 把"，取 max —— 已经堆到 7 把的人拿千刃**不会变少**。 */
gs=make('sword');
gs.player.base.orbitBlades=4;deps.Progression.recompute(gs.player,cfg);
assert.equal(gs.orbitParams().blades,4,'旋刃 4 把');
gs.player.base.orbitBlades=7;deps.Progression.recompute(gs.player,cfg);
assert.equal(gs.orbitParams().blades,7,'旋刃不封顶：堆到 7 把就是 7 把（卡里和 orbitParams 里的 min(4) 都删了）');
gs.player.burst=JSON.parse(JSON.stringify(BStorm));
assert.equal(gs.orbitParams().blades,7,'千刃取 max(当前,6)：已经 7 把的人拿了不会变少');
gs=make('sword');
gs.player.base.orbitBlades=4;deps.Progression.recompute(gs.player,cfg);
gs.player.burst=JSON.parse(JSON.stringify(BStorm));
assert.equal(gs.orbitParams().blades,6,'刃数不到 6 的人拿千刃 = 6 把');

/* ==================== 血刃（伤害 + 吸血爆发） ==================== */
const BBlood={id:'bloodBlade',name:'血刃',left:2,active:true,radiusMul:1,
              dmgMul:3,healPerHit:0.5,healCap:20,tint:'#ff6b5a'};
gs=make('sword');
const sPlain=gs.orbitParams().dmg;                    // 没爆发时的单刃伤害（攻击力 × orbitDmg）
gs.player.burst=JSON.parse(JSON.stringify(BBlood));
const sBlood=gs.orbitParams().dmg;
assert(Math.abs(sBlood-sPlain*3)<1e-9,'血刃生效时每刀 = 基准 ×3（'+sPlain.toFixed(1)+' → '+sBlood.toFixed(1)+'）');
gs.player.burst.active=false;
assert(Math.abs(gs.orbitParams().dmg-sPlain)<1e-9,'收刃期没有伤害加成');

/* 回血封顶：不封顶的话一圈 60 只怪能吸 70+ 血 ⇒ 两圈满血无敌 */
gs.player.burst.active=true;gs.player.burst.healed=0;gs.player.hp=30;
let healed=0;
for(let i=0;i<60;i++) healed+=gs.burstHeal();
assert(Math.abs(healed-BBlood.healCap)<1e-9,'一个窗口最多回 '+BBlood.healCap+' 血（实测 '+healed+'）');
assert.equal(gs.player.hp,50,'血量 30 + 20 = 50（没有溢出成满血）');
assert.equal(gs.burstHeal(),0,'吸满之后再命中一滴都不回');
assert(gs.parts.list.some(p=>p.str&&p.str.indexOf('吸血到上限')>=0),'吸到上限要飘字说明（否则以为回血坏了）');

/* 每个窗口重新计数：起转时 healed 不归零的话第二个窗口一滴都吸不到 */
gs.player.burst.left=2;gs.player.burst.active=false;
gs.player.orbOn=false;gs.player.orbT=0;gs.updateOrbit(1/60);        // 起转
assert.equal(gs.player.burst.healed,0,'起转要把"这个窗口吸了多少"归零');
assert.equal(gs.player.burst.left,1,'并且消耗一刀');

/* 真打起来确实会回血（跑一个窗口的主循环，玩家先掉血） */
{
  const t=make('sword'),P=t.player;
  P.x=1200;P.y=800;
  for(let i=0;i<8;i++){
    const f=deps.Entities.makeFoe(cfg,'slime',P.x+60+Math.cos(i)*18,P.y+Math.sin(i)*18,1,1);
    f.hp=f.maxhp=1e9; f.orbCd=0; t.foes.push(f);
  }
  P.hp=40;
  P.burst={id:'bloodBlade',name:'血刃',left:2,active:false,radiusMul:1,dmgMul:3,healPerHit:0.5,healCap:20,tinted:null,tint:'#ff6b5a',healed:0,capNoticed:false};
  P.orbOn=false;P.orbT=0;
  let maxHp=P.hp;
  for(let i=0;i<150;i++){
    for(const f of t.foes){ f.x=P.x+60; f.y=P.y; f.orbCd=Math.max(0,f.orbCd-1/60); }
    t.updateOrbit(1/60);
    maxHp=Math.max(maxHp,P.hp);
  }
  assert(maxHp>40&&maxHp<=60,'真打起来会回血，且不超过上限（40 → '+maxHp.toFixed(1)+'，上限 60）');
}

/* ==================== 同族只有一个槽：第二张会顶掉第一张 ==================== */
gs=make('sword');
gs.grantBurst(cardOf('skyCut'));
assert.equal(gs.player.burst.id,'skyCut');
gs.parts.list.length=0;
gs.grantBurst(cardOf('bloodBlade'));
assert.equal(gs.player.burst.id,'bloodBlade','后来的顶掉先前的（单槽是有意的）');
assert.equal(gs.player.burst.left,2,'新卡按自己的刀数算');
gs.parts.list.length=0;
gs.grantBurst(cardOf('skyCut'));
assert(gs.parts.list.some(p=>p.str&&p.str.indexOf('顶掉了')>=0),
  '顶掉要飘字说明（默默顶掉会被当成 bug："我两张卡呢？"）');
/* 已经用完（left=0）的那张被替换：不用提示 */
gs.player.burst.left=0;gs.parts.list.length=0;
gs.grantBurst(cardOf('bloodBlade'));
assert(!gs.parts.list.some(p=>p.str&&p.str.indexOf('顶掉了')>=0),'用光的卡被换掉不用提示');

/* ==================== 三张爆发卡都在试卡面板里能试 ==================== */
gs=make(true);gs.setTraining(true);gs.state='play';
assert.equal(gs.trialCardList('mechanic').length,6,'机制页 6 张（处决/灼痕/开天/千刃/血刃/叠刃）');
for(const id of ['skyCut','bladeStorm','bloodBlade']){
  gs.player.taken={};gs.player.burst=null;gs.player.pendingLevels=0;
  assert(gs.applyTrialCard(id,false),'试卡面板要能试 '+id);
  assert(gs.player.burst&&gs.player.burst.id===id,'试 '+id+' 之后 burst 要登记成它');
  assert.equal(gs.player.burst.left,cardOf(id).burst.swings,'剩余刀数按卡片自己的参数');
  gs.applyTrialCard(id,true);
  assert.equal(gs.player.burst.id,id+'#rare','金色版走金版的参数（'+gs.player.burst.left+' 刀）');
}
gs.player.taken={};gs.player.burst=null;
gs.cardPanelGuard=0;gs.burstHeal&&null;
gs.clearTrialCards();

/* ==================== 存档：新维度也要跟着走 ==================== */
gs=make('sword');
gs.player.burst={id:'bloodBlade',name:'血刃',left:1,active:true,radiusMul:1,dmgMul:3,
                 healPerHit:0.5,healCap:20,tint:'#ff6b5a',healed:12,capNoticed:true};
const snap2=JSON.parse(JSON.stringify(deps.Save.snapshot(gs,true)));
const res2=make('sword');deps.Save.applyRun(res2,snap2);
assert.equal(res2.player.burst.dmgMul,3,'伤害倍率要存');
assert.equal(res2.player.burst.healPerHit,0.5,'每次回血要存');
assert.equal(res2.player.burst.healCap,20,'回血上限要存');
assert.equal(res2.player.burst.tint,'#ff6b5a','配色要存（不然读档后徽标又变回金色）');
assert.equal(res2.player.burst.active,false,'读档后 active 清零（重新起转才算第一刀）');
assert.equal(res2.player.burst.healed,0,'读档后"这个窗口吸了多少"也要清零');
assert.equal(res2.player.burst.left,1,'剩余刀数保留');
/* 老存档（只有 id/name/left/radiusMul）不许崩：新维度是 undefined，消费点全按 0 处理 */
const res3=make('sword');
deps.Save.applyRun(res3,{v:deps.Save.VERSION,level:1,xp:0,gold:0,kills:0,taken:{},base:{},equip:{},bag:[],
  run:{stage:1,wave:1,trialVersion:cfg.trial.version,trial:null,burst:{id:'skyCut',name:'开天',left:1,radiusMul:5}}});
assert.equal(res3.player.burst.bladesAdd,undefined,'老存档没有 bladesAdd');
assert.equal(res3.orbitParams().blades,1,'没有 bladesAdd 时刃数正常（不会 NaN）');
assert(Number.isFinite(res3.orbitParams().dmg),'老存档读回来伤害不能变 NaN');

/* ==================== 爆发徽标：贴角色头顶，不在屏幕底部 ====================
   用户 2026-10 两条口径合起来的结果：
     "屏幕底下的武器技能就不用显示了，在武器库里面有" + 底排留空
   ⇒ 徽标从底排挪到**血/经验那一组的上面**（贴头顶 = 打斗时眼睛在的地方）。 */
{
  const t=make('sword'),P=t.player;
  P.x=1200;P.y=800;
  /* ⚠️ HUD 会读装备对象的 color/rarity —— 假武器对象（只写 kind）会让渲染层拿 undefined 去 hex 解析。
     所以这里换成工厂函数造的真武器（预览页那次也栽在同一个坑上）。 */
  const w=deps.Progression.makeDefaultWeapon(cfg);w.kind='sword';
  P.equip.weapon=w;P.bag=[w];deps.Progression.recompute(P,cfg);
  P.burst={id:'skyCut',name:'开天',left:2,active:true,radiusMul:5};
  const f=fakeCtx();
  const r=new Renderer(f.ctx,{cfg:cfg,createCanvas:function(){return null;}});
  r.resize(812,375);r.lastT=1;
  r.drawPlayerHp(P,1,0);
  const badge=f.rec.texts.filter(function(x){return x.s.indexOf('开天')>=0;})[0];
  assert(badge,'爆发时头顶要画出"开天 · 剩 N 刀"（不然玩家不知道还剩几刀）');
  assert(badge.s.indexOf('剩 2 刀')>0,'待起转/生效中的文案要带上剩余刀数');
  assert(badge.y < 800-56,'徽标要画在角色美术顶部（y-56）**之上**，不许挡脸');
  assert(badge.y > 0,'而且要在屏幕内（别飞出上边）');
  /* ⚠️ 这里记录的是**世界坐标**（画在相机变换里）—— 不能拿"屏幕底部"去比。
     要断"底排留空"得在 HUD 那边比（HUD 是屏幕坐标，见下面）。 */
  assert(Math.abs(badge.x-P.x)<20,'徽标要居中挂在角色身上（x 跟角色走）');
  /* HUD（屏幕坐标）里：不许再画爆发徽标，而且**底排（原来技能格那一条）不许有任何文字** */
  const f2=fakeCtx();
  const r2=new Renderer(f2.ctx,{cfg:cfg,createCanvas:function(){return null;}});
  r2.resize(812,375);r2.lastT=1;
  r2.drawHud(t,P);
  assert(!f2.rec.texts.some(function(x){return x.s.indexOf('开天')>=0||x.s.indexOf('待起转')>=0;}),
    'HUD 里不该再画爆发徽标（已经挪到头顶，两处都画就重复了）');
  assert(!f2.rec.texts.some(function(x){return x.y>375-70;}),
    '屏幕底排那一条（原先武器技能格的位置）用户要求留空，HUD 不许再往上画东西');
}

console.log('PASS: 开天（限次爆发）= 抽到只登记/下次起转生效/一个转动窗口算一刀/2 刀用完即止/半径×5 真的打得到 5 倍外/画出来的刀尖也在 350px（渲染与判定同一套数字）/存档保留剩余刀数且 active 清零/死亡重开清干净/属性页可见/切武器与试炼场不崩'
  + ' · 千刃 = 窗口内**直接变 6 把**（1 把或 4 把的人都是 6 把）、每刀伤害不被归一化打下来、一个窗口总伤害真的 ×6、画面同步画 6 把'
  + ' · 血刃 = 每刀 ×3、命中回血每窗口封顶 20（吸满停手+飘字）、起转时重新计数、真打会回血、刀身/徽标走同色'
  + ' · 同族单槽：后抽的顶掉先抽的并有飘字（用光的不提示）· 三张卡试卡面板都能试（含金色版）· 存档带全参数、老存档不崩');
