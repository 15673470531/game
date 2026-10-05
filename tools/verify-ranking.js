'use strict';
const assert=require('assert'),path=require('path'),root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),Ranking=require(root+'/platform/wechat/ranking'),createBoard=require(root+'/open-data'),deps={};for(const[k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
/* ⚠️ 榜单这一套机制的验收要在**入口开着**的前提下跑：上线时 cfg.ui.rankOnTitle 是 false
   （用户 2026-10："首页的排榜榜单暂时隐藏"），此时 finishRanked 整块不参与、也不会提交成绩。
   这个开关本身的行为在文件末尾单独验（关=点不到、开=全回来）。 */
cfg.ui.rankOnTitle=true;
let store={},writes=0;const storage={get:k=>store[k],set:(k,v)=>{store[k]=v;writes++;},remove:k=>delete store[k]};
let g=new Game(cfg,{...deps,storage});g.setViewport(812,320,{top:20,bottom:20,left:44,right:44});g.toTitle({keep:false});
let submitted=[];g.ranking={post:()=>{},submit:score=>{submitted.push(score);return{score,text:'recorded'};}};
g.startRun(false);assert(g.rankEligible);g.player.gold=888;g.tickRankClock(12.5);g.state='paused';g.tickRankClock(15);g.state='levelup';g.tickRankClock(15);assert.equal(g.rankSeconds,12.5);
g.toTitle();assert(!g.rankEligible);assert.equal(submitted.length,0);assert(g.hasResume());g.startRun(true);assert(g.rankEligible);assert.equal(g.rankSeconds,12.5);assert.equal(g.player.gold,888);g.tickRankClock(2.5);
g.player.hp=1;g.player.inv=0;g.hurtPlayer(100,g.player.x+60,g.player.y);assert.equal(submitted.length,1);assert.equal(submitted[0].ms,15000);g.finishRanked(false);assert.equal(submitted.length,1);
g.tickRankClock(20);assert.equal(g.rankSeconds,15);
// Reviving permits a new settlement, retaining time and the per-run revival count.
const oldLimit=g.cfg.ads.revivePerRun;g.cfg.ads.revivePerRun=2;assert(g.revivePlayer());g.tickRankClock(3);g.saveNow();g.toTitle();g.startRun(true);assert.equal(g.revives,1);assert.equal(g.rankSeconds,18);g.stageClear();g.stageClear();assert.equal(submitted.length,2);assert.equal(submitted[1].stage,4);assert.equal(submitted[1].ms,18000);g.cfg.ads.revivePerRun=oldLimit;
g.toTitle();g.startRanked();assert(g.rankEligible&&!g.ranked);assert.equal(g.rankSeconds,0);assert.equal(g.rankResult,null);g.training=true;g.tickRankClock(10);g.finishRanked(false);assert.equal(submitted.length,2);g.training=false;
g.startRun(false);assert.equal(g.rankSeconds,0);g.toTitle();assert.equal(submitted.length,2);
// Legacy saves without rankSeconds fall back to their elapsed time.
g.startRun(false);g.elapsed=42;g.saveNow();let legacy=JSON.parse(store[cfg.save.key]);delete legacy.run.rankSeconds;store[cfg.save.key]=JSON.stringify(legacy);g.toTitle({keep:false});g.startRun(true);assert.equal(g.rankSeconds,42);
// Local best is separate and only improves; opening sends dimensions without exposing friend records.
function done(ms){return {v:2,stage:4,milestone:0,progress:0,ms:ms};}
let sent=[],local={};const rank=new Ranking({getStorageSync:k=>local[k],setStorageSync:(k,v)=>local[k]=v,getOpenDataContext:()=>({canvas:{},postMessage:m=>sent.push(m)})});rank.submit(done(5000));rank.submit(done(6000));assert.equal(rank.best.ms,5000);rank.submit(done(4000));assert.equal(rank.best.ms,4000);rank.show({w:600,h:180});assert.equal(sent[sent.length-1].type,'show');
const texts=[],ctx={clearRect(){},fillRect(){},fillText:t=>texts.push(t),drawImage(){}};let cloud=null,failRead=false,failWrite=false,writeCount=0,receiver;
const wx={getSharedCanvas:()=>({getContext:()=>ctx}),onMessage:f=>receiver=f,createImage:()=>({}),getUserCloudStorage:o=>failRead?o.fail():o.success({KVDataList:cloud?[{key:'kdtl_friend_progress_v2',value:JSON.stringify(cloud)}]:[]}),setUserCloudStorage:o=>{writeCount++;if(failWrite)return o.fail();cloud=JSON.parse(o.KVDataList[0].value);o.success({});},getFriendCloudStorage:o=>o.success({data:cloud?[{nickname:'me',KVDataList:[{key:'kdtl_friend_progress_v2',value:JSON.stringify(cloud)}]},{nickname:'tie',KVDataList:[{key:'kdtl_friend_progress_v2',value:JSON.stringify({...cloud,runId:'another'})}]}]:[]})};
createBoard(wx);const key='kdtl_friend_progress_v2',score=ms=>({...done(ms),runId:'run'+ms});receiver({key,type:'show',width:600,height:180});assert(texts.includes('暂无好友挑战记录，完成一次挑战即可上榜'));receiver({key,type:'submit',score:score(5000)});assert.equal(cloud.ms,5000);receiver({key,type:'submit',score:score(6000)});assert.equal(writeCount,1);receiver({key,type:'submit',score:score(4000)});assert.equal(cloud.ms,4000);assert(texts.includes('我的最佳 已通关 · 0:04.0 · 第 1 名'));
failRead=true;receiver({key,type:'submit',score:score(3000)});assert.equal(cloud.ms,4000);assert.equal(writeCount,2);failRead=false;failWrite=true;receiver({key,type:'submit',score:score(3000)});assert.equal(cloud.ms,4000);failWrite=false;receiver({key,type:'show',score:score(3000)});assert.equal(cloud.ms,3000);receiver({key,type:'submit',score:score(-1)});assert.equal(cloud.ms,3000);
for(const h of [320,375,430]){g.setViewport(812,h,{top:20,bottom:20,left:44,right:44});const R=g.rankRects();assert(R.list.h>=100);assert(R.list.y+R.list.h<R.challenge.y);assert(R.back.x+R.back.w<812-20);}
console.log('PASS: home/board start, timed resume, revival settlement, training exclusion, submit once, local/cloud best, ties, network retry, empty states and safe layouts');

const Rules=require(root+'/core/rank-rules'),fs=require('fs');assert.equal(fs.readFileSync(root+'/core/rank-rules.js','utf8'),fs.readFileSync(root+'/open-data/rules.js','utf8'));
const scores=[{stage:4,milestone:0,progress:0,ms:500000},{stage:3,milestone:1,progress:920,ms:5000},{stage:3,milestone:1,progress:650,ms:1000},{stage:3,milestone:0,progress:1000,ms:1000},{stage:2,milestone:1,progress:600,ms:1000},{stage:2,milestone:0,progress:1000,ms:1000},{stage:1,milestone:0,progress:1000,ms:1000}].map((s,i)=>({...s,v:2,runId:'test'+i}));
for(let i=1;i<scores.length;i++){assert(Rules.compare(scores[i-1],scores[i])<0);assert(Rules.packed(scores[i-1])>Rules.packed(scores[i]));}
assert.equal(Rules.compare(scores[0],{...scores[0],runId:'different'}),0);assert(!Rules.valid({...scores[0],v:1}));
function failAt(wave,elite,boss){g=new Game(cfg,deps);g.startRanked();g.wave=wave;g.rankSeconds=100;g.trial.killed=42;g.trial.eliteDead=elite;if(boss){g.foes=[{kind:'boss',name:'boss',hp:80,maxhp:1000}];}g.player.inv=0;g.player.hp=1;let results=[];g.ranking={submit:s=>{results.push(s);return{score:s,text:'result'};}};g.hurtPlayer(100,g.player.x+50,g.player.y);assert.equal(g.state,'dead');assert.equal(results.length,1);g.finishRanked(false);assert.equal(results.length,1);return results[0];}
assert.equal(failAt(1,false,false).stage,1);assert.equal(failAt(2,true,false).milestone,1);assert.equal(failAt(3,false,true).progress,920);
rank.submit({...scores[0],ms:900000});assert.equal(rank.best.stage,4);rank.submit(scores[1]);assert.equal(rank.best.stage,4);
g=new Game(cfg,deps);g.startRanked();let calls=0;g.ranking={submit:()=>{calls++;},post:()=>{}};g.toTitle();assert.equal(calls,0);
g.state='play';g.player.hp=1;g.player.inv=0;g.hurtPlayer(100,g.player.x+10,g.player.y);assert.equal(calls,0);
console.log('PASS: failed-run auto-submit, inactive/exit exclusions, stage/elite/boss ordering, packed score parity, ties and v1 isolation');

// Model WeChat's restriction: only the main context can resize sharedCanvas.
const dimensions={width:300,height:150},mainCanvas={},subCanvas={getContext:()=>ctx};
for(const name of ['width','height']){
 Object.defineProperty(mainCanvas,name,{get:()=>dimensions[name],set:v=>{dimensions[name]=v;}});
 Object.defineProperty(subCanvas,name,{get:()=>dimensions[name],set:()=>{throw Error('sharedCanvas dimensions are read-only in open-data context');}});
}
let dispatch,ownCloud=null,networkDown=false,friends=[],uploads=0;
const field=s=>({key:Rules.KEY,value:JSON.stringify(s)});
createBoard({getSharedCanvas:()=>subCanvas,onMessage:f=>dispatch=f,createImage:()=>({}),
 getUserInfo:o=>o.success({data:[{openId:'self-id',nickName:'测试玩家'}]}),
 getUserCloudStorage:o=>networkDown?o.fail():o.success({KVDataList:ownCloud?[field(ownCloud)]:[]}),
 setUserCloudStorage:o=>{uploads++;ownCloud=JSON.parse(o.KVDataList[0].value);o.success({});},
 getFriendCloudStorage:o=>networkDown?o.fail():o.success({data:friends})});
const failedScore={v:2,stage:2,milestone:0,progress:420,ms:45000,runId:'failed-run'};
const persisted={[Rules.KEY+'_local']:failedScore};
const adapter=new Ranking({getStorageSync:k=>persisted[k],getOpenDataContext:()=>({canvas:mainCanvas,postMessage:m=>{
 if(m.type==='show'){assert.equal(dimensions.width,m.width);assert.equal(dimensions.height,m.height);}
 dispatch(m);
}})});
networkDown=true;texts.length=0;adapter.show({w:640,h:220});
assert.equal(adapter.error,'');assert(texts.some(t=>t.includes('本机成绩，待同步')));assert(texts.some(t=>t.includes('我的最佳 第2波')));assert.equal(uploads,0);
networkDown=false;texts.length=0;adapter.show({w:640,h:220});
assert.equal(uploads,1);assert.equal(ownCloud.stage,2);assert(texts.some(t=>t.includes('我的最佳 第2波')&&t.includes('第 1 名')));
// A stale friend-cache record for self must not duplicate the fresh own record.
friends=[{openid:'self-id',nickname:'过期本人',KVDataList:[field({...failedScore,runId:'old-run',progress:100})]}];
texts.length=0;adapter.show({w:700,h:250});assert(!texts.some(t=>t.includes('过期本人')));assert.equal(uploads,1);assert.equal(dimensions.width,700);
// Optional profile APIs must not prevent score loading even when unsupported at runtime.
let unsupportedDispatch;
createBoard({getSharedCanvas:()=>subCanvas,onMessage:f=>unsupportedDispatch=f,getUserInfo:()=>{throw Error('unsupported');},getUserCloudStorage:o=>o.success({KVDataList:[field(failedScore)]}),getFriendCloudStorage:o=>o.success({data:[]})});
texts.length=0;unsupportedDispatch({key:Rules.KEY,type:'show',width:700,height:250});assert(texts.some(t=>t.includes('我的最佳 第2波')&&t.includes('第 1 名')));
console.log('PASS: main-context canvas resize, read-only subdomain canvas, failed-run restore/sync, self omitted by friends API, network fallback, stale-self dedup and optional profile failure');
// Keep platform errors (rather than replacing every failure with 'network').
let errorDispatch,readFails=true;
createBoard({getSharedCanvas:()=>subCanvas,onMessage:f=>errorDispatch=f,
 getUserCloudStorage:o=>readFails?o.fail({errCode:123,errMsg:'getUserCloudStorage:fail permission denied'}):o.success({KVDataList:[]}),
 getFriendCloudStorage:o=>readFails?o.fail({errCode:456,errMsg:'getFriendCloudStorage:fail test failure'}):o.success({data:[]})});
texts.length=0;errorDispatch({key:Rules.KEY,type:'show',width:700,height:250});
assert(texts.some(t=>t.includes('个人读取失败 [123]：permission denied')&&t.includes('好友读取失败 [456]：test failure')));
readFails=false;texts.length=0;errorDispatch({key:Rules.KEY,type:'show',width:700,height:250});
assert.equal(texts[texts.length-2],'已同步 · 同时间并列');
console.log('PASS: precise API error codes/messages survive subsequent failures and clear after successful refresh');

/* ---------- 首页「好友排行榜」入口开关（2026-10 用户："首页的排榜榜单暂时隐藏"） ----------
   口径：**先隐藏不删** —— 面板 / 平台层 ranking.js / open-data 云存储一行没动，
   关的是首页那枚入口（titleRects().rank 返回 null，渲染和判定共用这一份布局，
   拿不到矩形就等于入口彻底消失）。所以这里既验"关掉点不到"，也验"打开还全在"。
   ⚠️ 别把断言写成"永远是 false"：开关是给人翻的，翻回 true 时这几条要照样过。 */
{
  const makeTitle=()=>{const x=new Game(cfg,deps);x.setViewport(812,375,{top:0,bottom:0,left:44,right:44});x.toTitle({keep:false});return x;};
  const saved=cfg.ui.rankOnTitle;                       // 记住项目里的默认值，测完还原
  const drawTitleTexts=function(g){
    const texts=[];
    const base={canvas:{width:812,height:375},fillText:s=>texts.push(String(s)),measureText:()=>({width:10}),
      /* 首页背景会用渐变：假 ctx 必须把 createXxxGradient 补上，否则 addColorStop 那一步直接炸 */
      createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})};
    const ctx=new Proxy(base,{get:(t,k)=>{if(k in t)return t[k];t[k]=()=>{};return t[k];},set:(t,k,v)=>{t[k]=v;return true;}});
    const R=new (require(root+'/render/renderer.js'))(ctx,{cfg:cfg,createCanvas:()=>null});
    R.resize(812,375);R.lastT=1;R.draw(g,1);
    return texts;
  };

  cfg.ui.rankOnTitle=false;
  let g=makeTitle();
  assert.equal(g.titleRects().rank,null,'关掉时首页不该有排行榜入口（返回 null）');
  assert(!drawTitleTexts(g).some(t=>t.indexOf('好友排行榜')>=0),'关掉时首页不许画出「好友排行榜」');
  g=makeTitle();
  g.update(1/60,{tap:{x:114,y:34}});                    // 原来那枚按钮的中心（左边 16+44、顶部 16，108x36）
  assert(!g.rankOpen,'关掉时点原位置不许打开榜单面板');

  cfg.ui.rankOnTitle=true;
  g=makeTitle();
  const r=g.titleRects().rank;
  assert(r&&r.w>0,'打开时首页要有排行榜入口（开关是藏不是删）');
  assert(drawTitleTexts(g).some(t=>t.indexOf('好友排行榜')>=0),'打开时要把按钮画回来');
  g.update(1/60,{tap:{x:r.x+r.w/2,y:r.y+r.h/2}});
  assert(g.rankOpen,'打开时点入口要能进榜单面板');

  /* 关掉时连同"结算上那行榜单文字"一起不许出现。
     2026-10 上线前补的：入口藏了，但死亡/通关结算上还会冒一句 "本局已结束 · 好友榜不可用" ——
     榜单明明藏了、结算又露一句，前后矛盾，所以 finishRanked 也要跟着开关走。 */
  cfg.ui.rankOnTitle=false;
  const g2=new Game(cfg,{...deps,storage});g2.setViewport(812,375);g2.startRun(false);
  const subs=[];g2.ranking={post:()=>{},submit:s=>{subs.push(s);return{score:s,text:'recorded'};}};
  g2.finishRanked(false);
  assert.equal(subs.length,0,'关掉时不许提交成绩');
  assert.equal(g2.rankResult,null,'关掉时不许产生榜单结算文字（死亡/通关面板会显示它）');
  cfg.ui.rankOnTitle=true;
  const g3=new Game(cfg,{...deps,storage});g3.setViewport(812,375);g3.startRun(false);
  const subs2=[];g3.ranking={post:()=>{},submit:s=>{subs2.push(s);return{score:s,text:'recorded'};}};
  g3.finishRanked(false);
  assert.equal(subs2.length,1,'打开时结算要照旧提交成绩（机制没被开关弄坏）');
  cfg.ui.rankOnTitle=saved;                             // 还原
  console.log('PASS: 首页排行榜入口开关（关掉=返回null+不画+点不到；打开=入口/按钮/面板全回来）');
}
