'use strict';
/*
 * 武器技能的**来源**（2026-10 改）：不再从升级卡里给，改成**精英怪掉落**（用户口径：
 *   "武器的技能我感觉别用卡片形式吧，要么用别的形式给角色，然后跟着武器走" +
 *   "第一波要么给一个精英怪吧…因为考虑到掉落武器技能可能要给到精英怪身上好一点"）。
 *
 * 这一版钉住的规则（每一条都是用户逐条定的）：
 *   ① 升级池里**永远**不出现武器技能卡（allowSkill:false）—— 卡定义还留在 cfg.upgrades 里，
 *      技能页/属性页/试炼场试卡面板照旧用它们，只是升级抽不到
 *   ② 一局两只精英：第 1 波「铁甲母蟹」**开场就在场**（教学波，400 血，不预警），
 *      第 2 波「裂钳守卫」还是 76 杀入场
 *   ③ 两只精英都**不死不推进波次**（慢速精英会被绕过去 = 这堂课没上）
 *   ④ 精英死 → 地上掉一个卷轴，给**当前手上这把武器**的技能之一（跟着武器走）。
 *      ⚠️ 2026-10 起是**随机取一个**（不是按 config 顺序取第一个）—— 为了支持
 *         "熟练度解锁的新技能**有几率**掉落"：池子 3 个而一局只掉 2 次，
 *         按顺序取的话排最后那个（正好是新解锁的）永远轮不到。
 *   ⑤ 卷轴**不吃 26 秒寿命**（"不消失，等玩家自己来捡"），但磁吸照旧、过关 collectAll 照常收走
 *   ⑥ 手上这把武器的技能拿满了 → 改掉金币（不掉一个"捡了没反应"的东西）
 *   ⑦ 掉落**不占用升级机会**（这正是这次改动的意义：技能不再和属性卡抢那 3 个格子）
 *   ⑧ 第 1 波教学 gate（2026-10）：开场**只出精英 + 随行 startMates 只慢速杂兵**，
 *      **捡到卷轴学会技能之前不刷怪群**（用户原话："先单独出精英怪，等角色打死精英怪获得技能后，
 *      再正常出怪"）；精英没死 / 没学会技能时波次也不推进。
 *   ⑨ 精英 / Boss 头顶显示**「类型 · 名字」**（紫色；精英写「精英」、Boss 写「领主」，
 *      文案在 config.ui.foeType），顶部血条那行**共用同一处 foeLabel**（不许分两处写文案）；
 *      有名字的这两类不画头顶菱形；脚下圈改成**紫色**、顶部血条那行名字也改紫；
 *      **Boss 只留脚下圈**（围着身体那圈只给精英，2026-10 口径"boss 两个圈很怪"）；
 *      词缀怪保留词缀色菱形 + 词缀色圈；卷轴与飘字写**具体技能名**（+武器名）。
 *
 * ⚠️ 假 ctx 用 Proxy 自动补方法（渲染层加新调用不该把这个测试整红）。
 */
const assert=require('assert'),path=require('path'),fs=require('fs'),root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f] of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
function make(){const g=new Game(cfg,deps);g.setViewport(812,375);return g;}
function recordingCtx(){
  const texts=[],fills=[],strokes=[],paints=[],alphas=[],arcs=[];
  const rec={ellipses:0,ellAlphaSum:0};
  const base={
    canvas:{width:812,height:375},
    fillText:function(s,x,y){texts.push({s:String(s),x:x,y:y,c:base.fillStyle});},
    strokeText:function(s,x,y){texts.push({s:String(s),x:x,y:y,c:base.fillStyle});},
    fillRect:function(x,y,w,h){fills.push({x:x,y:y,w:w,h:h,c:base.fillStyle});},
    stroke:function(){strokes.push(base.strokeStyle);},
    fill:function(){paints.push(base.fillStyle);alphas.push(base.globalAlpha);},
    /* 圆弧也记一笔（半径 + 当时的描边色）：用来断言"围着身体那圈"在不在
       （Boss 不许有这圈，见 verify-skill-drop 里那条）。 */
    arc:function(x,y,r){arcs.push({x:x,y:y,r:r,c:base.strokeStyle});},
    ellipse:function(){rec.ellipses++;rec.ellAlphaSum+=(base.globalAlpha||0);},
    measureText:function(s){return {width:String(s).length*6};}
  };
  const ctx=new Proxy(base,{get:function(t,k){if(k in t)return t[k];t[k]=function(){};return t[k];},
                            set:function(t,k,v){t[k]=v;return true;}});
  return {ctx:ctx,texts:texts,fills:fills,strokes:strokes,paints:paints,alphas:alphas,arcs:arcs,rec:rec};
}

/* ==================== ① 升级池里不再有武器技能卡 ==================== */
{
  const g=make();
  for(let i=0;i<120;i++){
    g.player.pendingLevels=1;
    g.openLevelUp();
    assert.equal(g.cards.length,cfg.growth.chooseFrom);
    assert(g.cards.every(c=>!c.weapon),
      '升级池里不许再出现武器技能卡（实测抽到：'+g.cards.filter(c=>c.weapon).map(c=>c.name).join('/')+'）');
    g.cards=[];g.player.pendingLevels=0;g.state='play';
  }
  /* 直接点名 allowSkill:false 也不许漏出一张武器卡 */
  for(let i=0;i<300;i++){
    const row=deps.Progression.drawUpgrades(cfg,{},3,{weapon:'sword',allowSkill:false});
    assert(row.every(c=>!c.weapon),'allowSkill:false 时不许出现武器卡');
    assert.equal(row.length,3);assert.equal(new Set(row.map(c=>c.id)).size,3);
  }
  /* 卡定义本身还在（技能页/属性页/试卡面板要用），只是不再参与升级 */
  assert.equal(cfg.upgrades.filter(c=>c.weapon).length,11,'11 张武器技能卡的定义必须保留（长剑 3：多了熟练度解锁的剑阵回响）');
}

/* ==================== ② 第 1 波的教学精英（开场单挑） ==================== */
assert(cfg.trial.elite&&cfg.trial.elite.length===2,'一局两只精英');
assert.equal(cfg.trial.elite[0].name,'铁甲母蟹');
assert.equal(cfg.trial.elite[1].name,'裂钳守卫');
assert.equal(cfg.trial.elite[0].at,'start','第 1 波精英开场就在场（教学波不搞预警）');
assert.equal(cfg.trial.elite[1].at,76,'第 2 波保持 76 杀入场');
assert.equal(cfg.trial.elite[0].hp,400,'教学精英 400 血（用户定的数）');
assert(cfg.trial.elite[0].hp<cfg.trial.elite[1].hp,'教学精英要比第 2 波那只明显弱（教学关不该卡住新手）');
{
  /* 开场：**只有精英 + 随行 startMates 只慢速杂兵**，怪群一只都不刷
     （2026-10 用户口径："先单独出精英怪，等角色打死精英怪获得技能后，再正常出怪"）。 */
  const g=make();g.wave=1;g.trial.delay=0;
  for(let i=0;i<40;i++)g.updateTrialSpawns(.5);
  const e=g.foes.find(f=>f.trialElite);
  assert(e,'第 1 波开场就要有精英在场');
  assert.equal(e.name,'铁甲母蟹');assert.equal(e.hp,400);
  assert(e.eliteTips,'教学关的精英要带那半句"（击败精英 · 可能掉落武器技能）"');
  assert(!e.eliteDesc,'顶部只留一行 —— 那行"厚甲，行动迟缓"已经去掉');
  assert.equal(g.trial.warningKind,'','教学精英不走"精英即将入场"预警');
  const mates=g.foes.filter(f=>!f.trialElite);
  assert(mates.length>=2&&mates.length<=cfg.trial.startMates,
    '开场只跟 2~'+cfg.trial.startMates+' 只随行杂兵（落点被石头挡住时允许少一只，实测 '+mates.length+'）');
  assert(mates.every(f=>f.startMate&&f.spd<cfg.enemyTypes.slime.spd[0]),'随行的是慢速"陪练"，不是压力');
  assert.equal(g.trial.spawned,mates.length,'gate 没解锁 → 怪群一只都不许提前刷（场上只有精英 + 随行）');
  assert.equal(g.trial.skillTaken,false,'新开的局 skillTaken 必须是 false');
}
{
  /* gate：精英死了但**卷轴还躺在地上** → 仍然不刷怪；捡起来学会技能之后才放怪群。
     这是"先上完课再考试"的关键：不 gate 的话新手第一波就要同时处理精英 + 怪群。 */
  const g=make();g.wave=1;g.trial.delay=0;
  g.updateTrialSpawns(.5);
  const mates=g.foes.filter(f=>!f.trialElite).length;   // 随行杂兵数（落点被石头挡住时可能 2~3）
  g.foes.filter(f=>f.trialElite).forEach(f=>{f.hp=0;g.onFoeDeath(f);});
  assert(g.pickups.some(u=>u.kind==='skill'),'精英死 → 地上掉技能卷轴');
  assert.equal(g.trialObjective(),'捡起技能卷轴 · 学会武器技能','精英死了没捡 → 目标行要指路（不然以为卡住了）');
  for(let i=0;i<40;i++)g.updateTrialSpawns(.5);
  assert.equal(g.trial.spawned,mates,'卷轴没捡 → 不许开始刷怪群（场上只该有精英 + 随行的 '+mates+' 只）');
  assert.equal(g.trial.skillTaken,false);
  g.collect(g.pickups.find(u=>u.kind==='skill'));
  assert.equal(g.trial.skillTaken,true,'捡起卷轴 = 学会技能 = 解锁');
  for(let i=0;i<10;i++)g.updateTrialSpawns(.5);
  assert(g.trial.spawned>mates,'解锁之后怪群才开始进');
  assert(g.trialObjective().indexOf('捡起技能卷轴')<0,'解锁后目标行不再提示捡卷轴');
}
{
  /* 精英不死 → 波次不推进（教学完成率不可控就是因为没 gate） */
  const g=make();g.wave=1;g.trial.delay=0;
  g.updateTrialSpawns(.5);
  const finish=()=>{g.trial.tide={phase:'done'};g.trial.spawned=cfg.trial.totals[0];g.trial.killed=Math.ceil(cfg.trial.totals[0]*.9);};
  finish();g.trial.eliteDead=false;
  g.updateTrialSpawns(.5);assert.equal(g.wave,1,'精英没死不许推进波次');
  g.foes.filter(f=>f.trialElite).forEach(f=>{f.hp=0;g.onFoeDeath(f);});
  finish();g.trial.skillTaken=false;
  g.updateTrialSpawns(.5);assert.equal(g.wave,1,'精英死了但还没学会技能 → 也不推进波次');
  g.trial.skillTaken=true;
  finish();g.updateTrialSpawns(.5);
  assert.equal(g.wave,2,'精英死了 + 学会技能才推进到第 2 波');
}
{
  /* 手上这把武器的技能全拿满时，精英改掉金币 —— 这时**没有卷轴可捡**，
     gate 必须同时解锁（否则老存档带着技能继续打，第一波永远不刷怪）。 */
  const g=make();g.wave=1;g.trial.delay=0;
  g.grantSkill('sword_wave');g.grantSkill('sword_return');
  g.updateTrialSpawns(.5);
  g.foes.filter(f=>f.trialElite).forEach(f=>{f.hp=0;g.onFoeDeath(f);});
  assert.equal(g.pickups[g.pickups.length-1].kind,'gold','拿满 → 改掉金币');
  assert.equal(g.trial.skillTaken,true,'没卷轴可捡时 gate 要自动放行');
}
{
  /* 第 2 波的精英仍然是 76 杀入场（走原来的预警） */
  const g=make();g.wave=2;g.trial.delay=0;g.trial.tide={phase:'done'};
  g.trial.killed=cfg.trial.elite[1].at-1;g.updateTrialSpawns(.5);
  assert(!g.foes.some(f=>f.trialElite),'还没到 76 杀不许入场');
  g.trial.killed=cfg.trial.elite[1].at;g.updateTrialSpawns(.5);
  assert.equal(g.trial.warningKind,'elite','该走预警了');
  g.updateTrialSpawns(2);
  assert(g.foes.some(f=>f.trialElite&&f.name==='裂钳守卫'),'预警结束入场的是裂钳守卫');
  const e2=g.foes.find(f=>f.trialElite);
  assert.equal(e2.hp,cfg.trial.elite[1].hp);
  assert(!e2.eliteTips,'第 2 波不再给教学那行（只教一次，靠波次区分）');
}

/* ==================== ③ 掉落、拾取、跟着武器走 ==================== */
{
  const g=make();g.wave=1;
  /* ⚠️ 掉哪个技能是**随机**的（2026-10 改随机取一个，为了支持"熟练度解锁的新技能有几率掉落"），
     所以按**实际掉出来的那个**断言，不写死 id。
     熟练度 Lv1 时长剑池 = 原来那两个技能（剑阵回响要 Lv2 才进池）。 */
  const firstId=g.dropSkillScroll(100,100);
  const firstCard=cfg.upgrades.filter(u=>u.id===firstId)[0];
  assert(firstCard&&firstCard.weapon==='sword','掉的是手上这把武器的技能（实测 '+firstId+'）');
  const s=g.pickups[g.pickups.length-1];
  assert.equal(s.kind,'skill');assert.equal(s.skill,firstId);
  const pend=g.player.pendingLevels;
  g.collect(s);
  assert(g.player.taken[firstId],'捡起来 = 学会（和选卡走同一条 apply 路径）');
  assert.equal(g.player.pendingLevels,pend,'掉落不占用升级机会 —— 这正是这次改动的意义');
  assert(g.skillNotice&&g.skillNotice.name===firstCard.name&&g.skillNotice.weapon==='长剑',
    '拾取要给"获得 · XX / 长剑的技能 · 跟随武器生效"（讲清跟着武器走）');
  const secondId=g.dropSkillScroll(0,0);
  assert(secondId&&secondId!==firstId,'第二个精英掉另一个（一局两只正好给全）');
  g.grantSkill(secondId);                            // 掉在地上要捡起来才算学会（掉落本身不改 taken）
  assert(g.player.taken[secondId]);
  assert.equal(g.dropSkillScroll(0,0),null,'拿满了 → 不再掉卷轴');
  assert.equal(g.pickups[g.pickups.length-1].kind,'gold','拿满了改掉金币（不掉"捡了没反应"的东西）');
}
{
  const g=make();
  g.pickups.push(deps.Entities.makePickup('skill',g.player.x+900,g.player.y,'sword_wave'));
  g.pickups.push(deps.Entities.makePickup('gold',g.player.x+900,g.player.y,3));
  for(let i=0;i<60*30;i++)g.updatePickups(1/60);
  assert(g.pickups.some(u=>u.kind==='skill'),'技能卷轴不许超时消失（用户口径"不消失"）');
  assert(!g.pickups.some(u=>u.kind==='gold'),'其他掉落照旧 26 秒消失（别把满地的金币留着）');
}
{
  /* 卷轴**不吸附**：附近也不许自己飞过来，必须玩家走过去踩到
     （用户 2026-10 口径"武器掉落去掉自动吸附吧，只能自己去捡"）。 */
  const g=make();
  g.pickups.push(deps.Entities.makePickup('skill',g.player.x+60,g.player.y,'sword_wave'));
  const u=g.pickups[0];u.vx=0;u.vy=0;                 // 关掉落地散射，读数才确定（不然它自己也会飘）
  const d0=Math.hypot(u.x-g.player.x,u.y-g.player.y);
  for(let i=0;i<30;i++)g.updatePickups(1/60);         // 半秒：吸附的话早飞过来了
  const d1=Math.hypot(u.x-g.player.x,u.y-g.player.y);
  assert(Math.abs(d1-d0)<1e-6,'卷轴不许吸附（实测 '+d0.toFixed(1)+' → '+d1.toFixed(1)+'）');
  assert(!g.player.taken.sword_wave,'不许自动到手');
  g.player.x=u.x;g.player.y=u.y;                      // 走过去踩到
  g.updatePickups(1/60);
  assert(g.player.taken.sword_wave,'走到身上（P.r+14 内）要能捡起来');
}
{
  /* 但别把吸附整个关掉：金币照旧要吸（不然满地的金币得一个个踩） */
  const g=make();
  g.pickups.push(deps.Entities.makePickup('gold',g.player.x+60,g.player.y,3));
  const u=g.pickups[0];const d0=Math.hypot(u.x-g.player.x,u.y-g.player.y);
  g.updatePickups(1/60);g.updatePickups(1/60);
  assert(Math.hypot(u.x-g.player.x,u.y-g.player.y)<d0,'金币还是要吸附的');
}
{
  /* 精英标识（用户 2026-10："精英怪应该要和其他怪有一些标识"）：脚下地面光环，用精英色。
     ⚠️ 顺手钉住"头顶菱形去哪了"：**已经有头顶名字**的精英/Boss 不画菱形（名字里带了类型前缀
     「精英 · 铁甲母蟹」，菱形是重复的）；**随机词缀怪保留**（它没有名字，菱形是唯一的头顶标识）。
     ⚠️ 颜色（2026-10 用户口径："精英和领主底下的那个圈也改成紫色"）：
     有名字的用紫色（和头顶名字同色），随机词缀怪仍用词缀色。 */
  const rec=recordingCtx();
  const R=new (require(root+'/render/renderer.js'))(rec.ctx,{cfg:cfg,createCanvas:()=>null});
  R.resize(812,375);
  R.drawEliteMark({x:400,y:300,r:30,affix:{color:'#c9a24a'}},1,0.5);
  assert(rec.rec.ellipses>=2,'脚下圈画两次（深色底 + 精英色），实测 '+rec.rec.ellipses);
  assert(rec.strokes.indexOf('#c9a24a')>=0,'没有头顶名字的词缀精英：脚下圈照旧用词缀色');
  assert(rec.paints.indexOf('#c9a24a')>=0,'没有头顶名字的词缀精英：菱形照旧用精英色填充');
  const rec1b=recordingCtx();
  const R1b=new (require(root+'/render/renderer.js'))(rec1b.ctx,{cfg:cfg,createCanvas:()=>null});
  R1b.resize(812,375);
  R1b.drawEliteMark({x:400,y:300,r:30,trialElite:true,name:'铁甲母蟹',affix:{color:'#c9a24a'}},1,0.5);
  assert.equal(rec1b.paints.length,0,'有头顶名字的教学精英：菱形去掉（用户 2026-10 口径）');
  assert(rec1b.rec.ellipses>=2,'但脚下圈要留着');
  assert(rec1b.strokes.indexOf('#c9a2ff')>=0,'教学精英的脚下圈要用紫色（和名字同色）');
  assert(rec1b.strokes.indexOf('#c9a24a')<0,'脚下圈不再是词缀金色');
  const rec1c=recordingCtx();
  const R1c=new (require(root+'/render/renderer.js'))(rec1c.ctx,{cfg:cfg,createCanvas:()=>null});
  R1c.resize(812,375);
  R1c.drawEliteMark({x:400,y:300,r:40,kind:'boss',name:'荒原巨蝎'},1,0.5);   // Boss 没有 affix
  assert(rec1c.rec.ellipses>=2,'领主也要有脚下圈（原来只有影子，没有身份圈）');
  assert(rec1c.strokes.indexOf('#c9a2ff')>=0,'领主的脚下圈也是紫色');
  assert.equal(rec1c.paints.length,0,'领主不画菱形');
  const rec2=recordingCtx();
  const R2=new (require(root+'/render/renderer.js'))(rec2.ctx,{cfg:cfg,createCanvas:()=>null});
  R2.drawEliteMark({x:400,y:300,r:30},1,0.5);
  assert.equal(rec2.rec.ellipses,0,'没有 affix 的普通怪不许有精英标识（别给所有怪都画圈）');
  assert.equal(rec2.paints.length,0,'普通怪头顶不许有菱形');
}
{
  /* 头顶名字（2026-10 用户口径：精英怪和 Boss 头顶显示对应的名字，颜色用紫色；
     名字前面带**类型前缀** —— 精英写「精英」、Boss 写「领主」，中间用" · "隔开）。
     只有"有专属名字"的精英 / Boss 才画 —— 杂兵不画（怪堆里几十只都挂名字 = 屏幕全是字）。 */
  assert(cfg.ui&&cfg.ui.foeType,'类型前缀的文案要写在 config.ui.foeType 一处（别散在渲染里）');
  const mk=()=>{const r=recordingCtx();return {r:r,R:new (require(root+'/render/renderer.js'))(r.ctx,{cfg:cfg,createCanvas:()=>null})};};
  let t1=mk();t1.R.resize(812,375);
  assert.equal(t1.R.drawFoeName({x:400,y:300,r:30,trialElite:true,name:'铁甲母蟹'}),'精英 · 铁甲母蟹');
  const nm=t1.r.texts.find(t=>t.s==='精英 · 铁甲母蟹');
  assert(nm,'精英头顶要写「类型 · 名字」');
  assert.equal(nm.c,'#c9a2ff','名字必须是紫色（用户指定）');
  assert(nm.y<300-30,'名字要在头顶之上，别压在身上');
  let t2=mk();t2.R.resize(812,375);
  assert.equal(t2.R.drawFoeName({x:400,y:300,r:40,kind:'boss',name:'荒原巨蝎'}),'领主 · 荒原巨蝎',
    'Boss 的类型前缀是「领主」');
  assert(t2.r.texts.some(t=>t.s==='领主 · 荒原巨蝎'&&t.c==='#c9a2ff'),'Boss 头顶也要紫色名字');
  /* 走 drawFoes 这条真路径：精英要挂名字，杂兵不许挂。
     ⚠️ 判"菱形没画"只能看**词缀色有没有被 fill** —— 所以这里把怪身色和词缀色设成两个不同的值
     （真路径上还会 fill 别的东西，paints 不可能是空的）。
     同时钉住"全身一起改紫"（2026-10 用户口径）：身体外圈 + 脚下圈都必须是紫色，不许再出现词缀金。 */
  let t3=mk();t3.R.resize(812,375);
  t3.R.drawFoes([{x:400,y:300,r:30,type:'tank',trialElite:true,name:'铁甲母蟹',affix:{color:'#c9a24a'},hp:10,maxhp:10,color:'#123456',ph:0,kb:{x:0,y:0}}],0);
  assert(t3.r.texts.some(t=>t.s==='精英 · 铁甲母蟹'),'精英要挂名字（drawFoes 真路径）');
  assert(t3.r.paints.indexOf('#c9a24a')<0,'有名字的精英在真路径上也不该再画菱形（词缀色没被 fill）');
  assert(t3.r.strokes.indexOf('#c9a2ff')>=0,'精英的身体外圈 + 脚下圈都要紫色（实测 strokes：'+t3.r.strokes.join('/')+'）');
  assert(t3.r.strokes.indexOf('#c9a24a')<0,'精英身上不许再出现词缀金色');
  /* 围着身体那圈的半径 = r+6+ap*2（t=0 时 ap=0.5 → +1）：教学精英要保留这一圈
     （它混在怪堆里，靠这一圈分得出来；Boss 则不许有，见下面 t6）。 */
  assert(t3.r.arcs.some(a=>a.r===30+6+1),'教学精英要保留围着身体那圈');
  let t4=mk();t4.R.resize(812,375);
  t4.R.drawFoes([{x:400,y:300,r:14,type:'slime',name:'裂壳爬虫',hp:10,maxhp:10,color:'#77707f',ph:0,kb:{x:0,y:0}}],0);
  assert(!t4.r.texts.some(t=>t.s==='裂壳爬虫'),'杂兵不许挂名字');
  /* 随机词缀精英：没有名字 → 圈和菱形都还是词缀色（别把它也刷成紫色） */
  let t5=mk();t5.R.resize(812,375);
  t5.R.drawFoes([{x:400,y:300,r:30,type:'tank',affix:{color:'#c9a24a'},hp:10,maxhp:10,color:'#123456',ph:0,kb:{x:0,y:0}}],0);
  assert(t5.r.strokes.indexOf('#c9a24a')>=0,'随机词缀精英的外圈仍是词缀色（它没有名字）');
  assert(t5.r.strokes.indexOf('#c9a2ff')<0,'随机词缀精英不许用紫色（紫色是"有名字"的专用色）');
  /* 领主：**只留脚下那圈**（2026-10 用户口径："为啥看 boss 很怪，有两个圈……周围的圆圈去掉吧"），
     身体外圈不许再画 —— 直接数半径 r+6 上有没有圆弧。 */
  let t6=mk();t6.R.resize(812,375);
  t6.R.drawFoes([{x:400,y:300,r:40,kind:'boss',type:'boss',shape:'boss',bossType:'warden',name:'荒原巨蝎',
    hp:10,maxhp:10,color:'#123456',ph:0,kb:{x:0,y:0}}],0);
  assert(t6.r.strokes.indexOf('#c9a2ff')>=0,'领主还留着紫色脚下圈');
  assert(t6.r.arcs.every(a=>a.r<40),'领主不许再有围着身体的那圈（r+6 圆弧）—— 两个圈看着像画重了');
  assert(t6.r.rec.ellipses>=2,'领主的脚下圈要画（深色底 + 紫）');
  assert(t6.r.texts.some(t=>t.s==='领主 · 荒原巨蝎'),'领主头顶要挂「领主 · 荒原巨蝎」');
}
{
  /* 光柱层（2026-10 用户口径："你在做一个光柱的效果吧，不然如果怪物太多会被覆盖住"）：
     ① 只给技能卷轴画；② 柱子在卷轴上方；③ **必须画在怪之后**（这才是"怪物再多也压不住"的前提）。 */
  const B=(cfg.pickups.skill&&cfg.pickups.skill.beam)||{};
  assert(B.h>=100,'柱高要明显高过角色（配置在 cfg.pickups.skill.beam.h，实测 '+B.h+'）');
  const mkR=()=>{const r=recordingCtx();return {r:r,R:new (require(root+'/render/renderer.js'))(r.ctx,{cfg:cfg,createCanvas:()=>null})};};
  let b1=mkR();b1.R.resize(812,375);
  b1.R.drawScrollBeams([{kind:'skill',skill:'sword_wave',x:400,y:300,t:0,vx:0,vy:0,life:0}],1);
  assert(b1.r.fills.length>=4,'柱体要由多段矩形叠出来（项目禁用渐变对象），实测 '+b1.r.fills.length+' 段');
  const topY=Math.min.apply(null,b1.r.fills.map(f=>f.y));
  assert(topY<=300-100,'柱子要画在卷轴上方（最高那段 y='+topY.toFixed(0)+'，卷轴在 y=300）');
  assert(b1.r.paints.indexOf(B.color||'#ffe9a8')>=0&&b1.r.paints.indexOf(B.core||'#fffdf2')>=0,
    '柱子和光尘要用配置里那两色（cfg.pickups.skill.beam.color / .core）');
  assert(b1.r.paints.length>=6,'还要有上升光尘（菱形 fill，实测 '+b1.r.paints.length+' 个 fill）');
  /* 金币 / 装备不画柱子（不然满地都是柱子） */
  let b2=mkR();b2.R.resize(812,375);
  b2.R.drawScrollBeams([{kind:'gold',x:400,y:300,t:0},{kind:'item',x:400,y:300,t:0,item:{}}],1);
  assert.equal(b2.r.fills.length,0,'只有技能卷轴有光柱：金币/装备不许画');
  /* ③ 层序：drawScrollBeams 必须在 drawFoes **之后**（画在怪之前 = 等于白做） */
  {
    const g=make();g.wave=1;
    /* buildGround 会往一块离屏 canvas 上画 —— 假 ctx 得给它一个能 getContext 的假 canvas */
    const fakeCanvas=function(){const gc=new Proxy({},{get:(t,k)=>(k in t?t[k]:function(){}),set:(t,k,v)=>{t[k]=v;return true;}});
      return {width:0,height:0,getContext:function(){return gc;}};};
    const rec=recordingCtx();
    const R=new (require(root+'/render/renderer.js'))(rec.ctx,{cfg:cfg,createCanvas:fakeCanvas});
    R.resize(812,375);R.lastT=1;
    const seq=[];
    const oF=R.drawFoes,oB=R.drawScrollBeams;
    R.drawFoes=function(){seq.push('foes');return oF.apply(this,arguments);};
    R.drawScrollBeams=function(){seq.push('beam');return oB.apply(this,arguments);};
    R.draw(g,1);
    assert(seq.indexOf('foes')>=0&&seq.indexOf('beam')>seq.indexOf('foes'),
      '光柱要画在怪之后（实测顺序：'+seq.join(' → ')+'）');
  }
}
{
  /* 卷轴 + 飘字写**具体技能名**（2026-10 用户口径："掉落的技能都显示出具体的名字"），
     并带上武器名做归属；不再写笼统的"武器技能"。 */
  const g=make();g.wave=1;
  /* ⚠️ 掉哪个技能是**随机**的（dropSkillScroll 2026-10 改随机取），所以按"实际掉出来的"
     那个来断言；写死 'sword_wave' 会在随机挑到 sword_return 时假失败。 */
  const dropId=g.dropSkillScroll(g.player.x,g.player.y);
  const dropCard=cfg.upgrades.filter(u=>u.id===dropId)[0];
  assert(dropCard,'要掉出一张卷轴');
  assert(g.parts.list.some(p=>p.str&&p.str.indexOf(dropCard.name)>=0),
    '掉落瞬间的飘字要写技能名（实测：'+g.parts.list.map(p=>p.str).join('/')+'）');
  const rec=recordingCtx();
  const R=new (require(root+'/render/renderer.js'))(rec.ctx,{cfg:cfg,createCanvas:()=>null});
  R.resize(812,375);R.drawPickups(g.pickups,0);
  const lab=rec.texts.map(t=>t.s).join('|');
  assert(lab.indexOf(dropCard.name)>=0,'卷轴上要写具体技能名（实测："'+lab+'"）');
  assert(lab.indexOf('长剑')>=0,'卷轴上要带武器名做归属');
  assert(lab.indexOf('武器技能')<0,'不该再写笼统的"武器技能"');
}
{
  const g=make();g.wave=1;
  /* 掉哪个技能现在是**随机**的（见 dropSkillScroll），所以按"实际掉出来的那个"来断言，
     别写死某个 id —— 写死的话这条用例会在"随机挑到另一个"时假失败。 */
  const id=g.dropSkillScroll(g.player.x+300,g.player.y);
  assert(id,'要掉出一张卷轴');
  assert(!g.player.taken[id]);
  g.collectAll();
  assert(g.player.taken[id],'过关 collectAll 照常收走 = 算拿到（用户口径"通关没捡走的卷轴算拿到"）');
}
{
  const g=make();g.wave=1;
  g.grantSkill('sword_wave');
  assert(g.hasWeaponSkill('sword_wave'));
  const w=deps.Progression.makeDefaultWeapon(cfg);w.kind='staff';w.id='staff-x';
  g.player.bag.push(w);g.switchWeapon(g.player.bag.length-1);
  assert(!g.hasWeaponSkill('sword_wave'),'切到法杖后长剑技能休眠');
  /* 掉落是随机的（2026-10），但**必须落在"当前手上这把"的池子里** —— 换成法杖之后
     就只能掉法杖的技能，不许掉回长剑的。 */
  const staffPool=cfg.upgrades.filter(u=>u.weapon==='staff'&&!u.disabled).map(u=>u.id);
  assert(staffPool.indexOf(g.dropSkillScroll(0,0))>=0,'新武器掉的是它自己的技能（池：'+staffPool.join('/')+'）');
  assert(g.weaponSkillRows('sword').some(c=>c.status==='已获得 · 装备后生效'));
}
{
  /* 存档往返：技能留在 taken 里，读回来还在（技能是"本局成果"，跟武器库/装备一套规则） */
  const g=make();g.grantSkill('sword_wave');
  const saved=JSON.parse(JSON.stringify(deps.Save.snapshot(g,true)));
  const resumed=make();deps.Save.applyRun(resumed,saved);
  assert(resumed.hasWeaponSkill('sword_wave'),'读档要把技能接回来');
  /* 老存档带着 skillPacing 字段（已删）也不许崩 */
  const old=JSON.parse(JSON.stringify(saved));old.run.skillPacing={completed:3,offered:{sword:0},acquired:{sword:1}};
  const mig=make();deps.Save.applyRun(mig,old);
  assert(mig.hasWeaponSkill('sword_wave'),'老存档里的 skillPacing 字段要被忽略而不是报错');
  /* ⚠️ 教学 gate 字段的存档兼容（2026-10）：老存档没有 skillTaken，必须补**放行**值 true。
     补 false 的话老玩家一读档，第 1 波永远不刷怪（新加 gate 字段必须给"放行"默认值）。 */
  const legacy=JSON.parse(JSON.stringify(saved));
  delete legacy.run.trial.skillTaken;
  const mig2=make();deps.Save.applyRun(mig2,legacy);
  assert.equal(mig2.trial.skillTaken,true,'老存档没有 skillTaken → 必须补 true（别把老存档卡死）');
  assert(mig2.trial.skillTaken===true&&mig2.wave>=1,'读档后能继续打');
}

/* ==================== ④ 武器库「技能」页照旧（入口 2026-10 从首页图鉴搬回暂停面板） ==================== */
{
  const g=make();g.state='play';g.bagGuard=0;
  /* 入口：暂停 → 第一行「武器库」（左下角那个 HUD 按钮早就删了，
     2026-10 起首页那个「武器图鉴」按钮也摘掉了 —— 这里是唯一入口，且**恒显**）。 */
  const first=g.player.bag[0];
  const second=deps.Progression.makeDefaultWeapon(cfg);second.id='w2';second.kind='spear';
  g.player.bag=[first,second];
  g.pause();assert.equal(g.state,'paused');
  const bagRow=g.pauseRects().rows.find(r=>r.id==='bag');
  assert(bagRow,'暂停面板里要有「武器库」一行');
  assert.equal(bagRow.label,'武器库','那一行文案 = 武器库（不再是「换武器」——一把武器时它也是个"查看"入口）');
  g.pauseGuard=0;
  g.updatePaused({tap:{x:bagRow.x+5,y:bagRow.y+5}});
  assert.equal(g.state,'bag','点暂停面板的「武器库」要能开武器库');
  assert.notEqual(g.bagTab,'skills','不再有"点技能格直接进技能页"这条捷径了');
  g.bagGuard=0;
  const skillsTab=g.bagTabs().find(t=>t.id==='skills');
  g.updateBag({tap:{x:skillsTab.x+4,y:skillsTab.y+4}});
  assert.equal(g.bagTab,'skills');
  g.bagGuard=0;
  const tab=g.skillPanelRects().tabs.find(t=>t.kind==='staff');
  g.updateBag({tap:{x:tab.x+4,y:tab.y+4}});
  assert.equal(g.skillViewKind,'staff');assert.equal(g.weaponKind(),'sword');
  /* ⚠️ 2026-10 用户口径：「关掉武器库回到暂停面板」—— 不是直接接着打，由玩家自己点「继续」 */
  g.closeBag();assert.equal(g.state,'paused','关掉武器库要回暂停面板');
  /* 两个"已经不存在的热区"都不能再开面板：底部原来的技能格位置、左下角原来的武器库按钮位置 */
  g.pauseGuard=0;g.bagGuard=0;g.state='play';
  g.update(.01,{tap:{x:812/2-122+5,y:375-38+5}});
  assert.notEqual(g.state,'bag','屏幕底部原来技能格的位置不能再开面板（隐形热区）');
  g.pauseGuard=0;g.bagGuard=0;g.state='play';
  g.update(.01,{tap:{x:16+20,y:375-54-34+20}});
  assert.notEqual(g.state,'bag','左下角原来武器库按钮的位置不能再开面板（隐形热区）');
  /* ⚠️ 手里只有一把武器时，「武器库」那一行**照样要在**（2026-10 改：
     以前是 `bag.length >= 2` 才出现 ⇒ 开局只有长剑时这条路等于不存在）。 */
  const one=make();one.state='play';one.pause();
  const oneBag=one.pauseRects().rows.find(r=>r.id==='bag');
  assert(oneBag,'只有一把武器时暂停面板里也要有「武器库」（进去看技能/属性，只是没得换）');
  assert.equal(one.pauseRects().rows[0].id,'bag','「武器库」是第一行');
  /* 一把武器时点它照样能开（面板里就是唯一那张卡，点空白关掉） */
  one.pauseGuard=0;
  one.updatePaused({tap:{x:oneBag.x+5,y:oneBag.y+5}});
  assert.equal(one.state,'bag','一把武器时「武器库」也要能打开');
  one.bagGuard=0;one.closeBag();
  assert.equal(one.state,'paused','关掉还是回暂停面板');
  /* 废弃的 bagBtnRect 只许返回 null（留着是给老工具的兜底，别再当热区用） */
  assert.equal(one.bagBtnRect(),null,'bagBtnRect 已废弃，必须返回 null');
}
/* HUD 里也不许画武器技能名（技能在武器库「技能」页里看）；精英那两行文案是例外 */
{
  const g=make();g.wave=1;g.trial.delay=0;g.updateTrialSpawns(.5);
  const rec=recordingCtx();
  const R=new (require(root+'/render/renderer.js'))(rec.ctx,{cfg:cfg,createCanvas:function(){return null;}});
  R.resize(812,375);R.lastT=1;R.dt=1/60;
  R.drawHud(g,g.player);
  const names=cfg.upgrades.filter(c=>c.weapon).map(c=>c.name);
  assert(!rec.texts.some(t=>names.some(n=>t.s.indexOf(n)>=0)),
    'HUD 里不该出现武器技能名（实测画了：'+rec.texts.map(t=>t.s).filter(s=>names.some(n=>s.indexOf(n)>=0)).join('/')+'）');
  assert(rec.texts.some(t=>t.s.indexOf('Lv')>=0||t.s.indexOf('击杀')>=0),'HUD 其他部分照旧要画（别把整块删了）');
  /* 精英：名字写成「类型 · 名字」（2026-10 用户口径：精英写"精英"、Boss 写"领主"，一个点隔开；
     和头顶名字共用 foeLabel）—— 都在顶部血条那块，一行 */
  assert(rec.texts.some(t=>t.s.indexOf('精英 · 铁甲母蟹')>=0),
    '精英名字要写成"精英 · 铁甲母蟹"（实测：'+rec.texts.map(t=>t.s).join('|')+'）');
  /* 顶部这行名字也要**紫色**（2026-10 用户口径：和头顶名字/身体外圈/脚下光环同一支紫；
     原来是金色 #ffd166）。同时钉住"括号那半句保持浅灰白"——别整行刷成一个色。 */
  {
    const lt=rec.texts.find(t=>t.s.indexOf('精英 · 铁甲母蟹')>=0);
    assert(lt&&lt.c==='#c9a2ff','顶部血条那行名字必须是紫色（实测 '+(lt&&lt.c)+'）');
    const ht=rec.texts.find(t=>t.s.indexOf('击败精英')>=0);
    assert(ht&&ht.c==='rgba(255,255,255,.78)','教学括号那半句保持浅灰白（主次靠颜色分开）');
  }
  assert(rec.texts.some(t=>t.s.indexOf('击败精英')>=0&&t.s.indexOf('武器技能')>=0),
    '教学关要在同一行跟"（击败精英 · 可能掉落武器技能）"');
  /* Boss 那行同理：类型是"领主"，不许只写名字，颜色也要紫 */
  {
    const gb=make();
    gb.foes.push(deps.Entities.makeBoss(cfg,gb.player.x+200,gb.player.y,1,'warden',1));
    const recb=recordingCtx();
    const Rb=new (require(root+'/render/renderer.js'))(recb.ctx,{cfg:cfg,createCanvas:function(){return null;}});
    Rb.resize(812,375);Rb.lastT=1;Rb.dt=1/60;
    Rb.drawHud(gb,gb.player);
    assert(recb.texts.some(t=>t.s.indexOf('领主 · 荒原巨蝎')>=0),
      'Boss 名字要写成"领主 · 荒原巨蝎"（实测：'+recb.texts.map(t=>t.s).join('|')+'）');
    const lb=recb.texts.find(t=>t.s.indexOf('领主 · 荒原巨蝎')>=0);
    assert(lb&&lb.c==='#c9a2ff','Boss 那行名字也要紫色（实测 '+(lb&&lb.c)+'）');
  }
  /* 敌潮预警条 = 正中一个 256×34 的框（y = ins.top+112，即 95..129）。
     ⚠️ 原来的判据是"整条 y 带（60~130）里一个字都不许有"——2026-10 左上卡加了「击杀/金币」一行
     （y≈125，x 在 7~152）正好落进那条带里，但它水平方向离预警框（278~534）很远。
     所以改成**矩形不许重叠**这个精确判据（钝的判据会逼着版式让路，那是反的）。 */
  const wL = 812 / 2 - 128 - 12, wR = 812 / 2 + 128 + 12;
  const clash = rec.texts.filter(t => t.y > 95 - 12 && t.y < 129 + 12 && t.x > wL && t.x < wR);
  assert.equal(clash.length, 0,
    '顶部那几行字撞到敌潮预警条了：' + clash.map(t => t.s + '@' + Math.round(t.x) + ',' + Math.round(t.y)).join(' / '));
  const nameT=rec.texts.find(t=>t.s.indexOf('铁甲母蟹')>=0);
  assert(nameT.y<100,'精英的名字/血条在顶部，不许跑到角色头顶那块去');
}

/* ==================== ⑤ 角色朝向 / 步态相位 / 存档迁移（沿用原来的断言） ==================== */
{
  const scales=[];
  const mk=()=>{const b={canvas:{width:812,height:375},scale:(x,y)=>scales.push([x,y]),measureText:()=>({width:10})};
    return new Proxy(b,{get:(o,k)=>{if(k in o)return o[k];o[k]=()=>{};return o[k];},set:(o,k,v)=>{o[k]=v;return true;}});};
  const RR=new (require(root+'/render/renderer.js'))(mk(),{cfg:cfg,createCanvas:()=>null});
  RR.resize(812,375); RR.lastT=1;
  const gp=make(); gp.state='play';
  const PP=gp.player; PP.x=120; PP.y=200; PP.bob=0; PP.dash=0; PP.orbOn=false; PP.moving=false;
  [0, Math.PI/2, Math.PI, Math.PI*1.5].forEach(function(a){
    scales.length=0; PP.face=a; RR.drawPlayer(PP,1);
    assert(scales.every(s=>s[0]!==-1),'就正面：朝任何一个方向跑都不许镜像（face='+a.toFixed(2)+'）');
  });
}
{
  const gm=make();gm.state='play';gm.update(.02,{});
  assert.equal(gm.player.moving,false,'站着不动时 moving=false');
  gm.update(.02,{moveX:1});
  assert.equal(gm.player.moving,true,'有移动输入时 moving=true（渲染层靠它判断"在走"）');
}

/* ==================== ⑥ 卷轴在地上的发光表现（2026-10 用户挑的 3+4+6） ==================== */
{
  /* 同一颗卷轴，按不同 style / 不同 t 画一遍，数画了多少图元、地面光的 alpha 有多大 */
  const drawScroll=function(style,tt){
    const rec=recordingCtx();
    const R=new (require(root+'/render/renderer.js'))(rec.ctx,{cfg:cfg,createCanvas:function(){return null;},scrollStyle:style});
    R.resize(812,375);
    const pk=deps.Entities.makePickup('skill',400,300,'sword_wave');
    pk.vx=0;pk.vy=0;                                   // 出图/断言都静止：卷轴本来就不动
    R.drawPickups([pk],tt);
    return rec;
  };
  const magic=drawScroll('magic',1), glow=drawScroll('glow',1), plain=drawScroll('scroll',1);
  /* 3) 星点：只有 magic 有细十字星芒（描边色 #fffdf2）；别的版本有星就算串味 */
  assert(magic.strokes.indexOf('#fffdf2')>=0,'magic 版要画十字星芒（3 = 星点闪烁）');
  assert(glow.strokes.indexOf('#fffdf2')<0,'非 magic 版不许画星芒');
  /* 4) 火星 + 星点：magic 的图元数要明显多于只有柔光那版 */
  assert(magic.paints.length-glow.paints.length>=8,
    'magic 要比纯柔光多画火星/星点（实测只多 '+(magic.paints.length-glow.paints.length)+' 层）');
  assert(glow.paints.length>plain.paints.length,'柔光版要比"只有卷轴"多画那圈光');
  /* 卷轴本体不许被光盖住 —— 纸卷(fillRect) + 轴头(fill) 照旧要画 */
  assert(magic.fills.some(f=>f.c==='#f7ecd4'),'纸卷要照旧画出来（别让光把它糊掉）');
  assert(magic.paints.indexOf('#c9a24a')>=0,'上下两根轴头要照旧画');
  /* 6) 周期脉冲：t=5.0 正好是峰值（(t%2.5)/2.5 = 0），t=1.25 是低谷 → 地面光要明显更亮 */
  const peak=drawScroll('magic',5), idle=drawScroll('magic',1.25);
  const d=peak.rec.ellAlphaSum-idle.rec.ellAlphaSum;
  assert(d>0.15,'脉冲那一刻地面光要比平常亮一截（实测只差 '+d.toFixed(3)+'）');
}

console.log('PASS: 技能来源 = 精英掉落（升级池永不出武器卡 / 第 1 波教学精英跟着小怪直接入场且不死不推进 / '
  + '第 2 波 76 杀照旧 / 掉落给手上武器的技能之一（随机，且不占升级机会）/ 卷轴不超时但磁吸与过关收走照旧 / '
  + '卷轴在地上会闪（星点 + 火星 + 每 2.5s 脉冲，默认 magic 版） / '
  + '拿满改掉金币 / 切武器休眠 / 技能页与顶部血条文案照旧 / 朝向·步态·存档迁移不回归');
