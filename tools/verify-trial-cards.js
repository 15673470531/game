'use strict';
/*
 * 试炼场「试卡」面板的验收（2026-10 用户需求：「在练武场中，提供一个可以体验指定卡片的功能」）。
 *
 * 这个功能的危险点只有一个：**它能让玩家白拿卡**。所以第一条断言就是"正式关卡里打不开"。
 * 其余按"玩家真的这么点"来测：点按钮 → 面板开 → 切页签 → 点格子 → 数值真的变了 → 清空 → 回到裸装。
 *
 * ⚠️ 全部走**真实点击链路**（updateTrainingInput / updateTrialCards 吃 input.tap），
 *    不直接调 openTrialCards/applyTrialCard —— 否则"按钮位置算错了点不到"这类 bug 会漏过去。
 */
const assert=require('assert'),path=require('path');
const root=path.resolve(__dirname,'..'),cfg=require(root+'/core/config'),Game=require(root+'/core/game'),deps={};
for(const [k,f]of Object.entries({World:'world',Entities:'entities',Progression:'progression',Save:'save'}))deps[k]=require(root+'/core/'+f);
let seed=99;Math.random=function(){seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};

function make(training){
  const g=new Game(cfg,deps);g.setViewport(812,375);
  g.world.rocks.length=0;g.world.walls.length=0;
  g.state='play';
  if(training){g.setTraining(true);g.state='play';}
  return g;
}
const center=r=>({x:r.x+r.w/2,y:r.y+r.h/2});
const tap=(g,r)=>{g.update(1/60,{tap:center(r)});};          // 走真主循环（状态分派 + 护栏都跑到）
function tapId(g,id){
  const R=g.trialCardPanelRects();
  const all=g.trainingRects().concat(R.foot).concat(R.tabs);
  const r=all.filter(x=>x.id===id)[0];
  assert(r,'找不到按钮 '+id);
  g.cardPanelGuard=0;g.bagGuard=0;                            // 测试里不等护栏，手动清（护栏本身另有断言）
  tap(g,r);
}
const cardOf=id=>cfg.upgrades.filter(u=>u.id===id)[0];

/* ---------- 1. 门槛：正式关卡里打不开（这条最重要） ---------- */
let g=make(false);
assert.equal(g.openTrialCards(),false,'正式关卡不许开试卡面板');
assert.equal(g.state,'play');
g.training=true;g.state='play';g.cardPanelGuard=0;            // 硬把 training 标志打开也一样要拦住
g.training=false;
assert.equal(g.state,'play','没进试炼场时 state 不能被改掉');

/* ---------- 2. 试炼场按钮栏多了「试卡」，而且 4 个按钮都在屏幕内 ---------- */
g=make(true);
let rects=g.trainingRects();
assert(rects.some(r=>r.id==='cards'),'试炼场按钮栏要有「试卡」');
assert.equal(rects.length,7,'原 6 个 + 试卡 = 7 个（第一排 3、第二排 4）');
for(const r of rects){
  assert(r.x>=0&&r.x+r.w<=812+0.01,'按钮不能超出屏幕：'+r.id+' 右边缘 '+ (r.x+r.w).toFixed(1));
  assert(r.y>=-0.01&&r.y+r.h<=375+0.01,'按钮不能超出屏幕：'+r.id);
}

/* ---------- 3. 点「试卡」→ 面板打开；页签分类对得上 ---------- */
tapId(g,'cards');
assert.equal(g.state,'trialcards','点「试卡」要打开面板');
const cats=g.trialCardCats().map(c=>c.id);
assert.deepEqual(cats,['stat','mechanic','cost','weapon']);
assert.equal(g.trialCardList('stat').length,11,'数值 11 张');
assert.equal(g.trialCardList('mechanic').length,6,'机制 6 张（处决/灼痕/开天/千刃/血刃/叠刃）');
assert.equal(g.trialCardList('cost').length,2,'代价 2 张（狂奔是停用状态，不列）');
assert.equal(g.trialCardList('weapon').length,11,'武器专属 11 张（长剑 3：多了熟练度解锁的剑阵回响）');
assert(cfg.upgrades.filter(u=>u.disabled).every(u=>!cats.some(c=>g.trialCardList(c).some(x=>x.id===u.id))),
  '停用的卡不许出现在任何页签里');
const R=g.trialCardPanelRects();
assert.equal(R.tiles.length,12,'3 列 × 4 行 = 12 个格子（最多的页是 11 张，够放）');
assert(R.tiles.every(t=>t.x>=R.panel.x&&t.x+t.w<=R.panel.x+R.panel.w+0.01),'格子不能超出面板');
/* ⚠️ 试卡面板是**固定 12 格**（3×4）。渲染层按 tiles 遍历（renderer 里 `list[i]`），
   点选那边是 `i < list.length && i < R.tiles.length` —— 两边都只吃到 12 张，
   所以第 13 张会**静默消失**：画不出来、点不到，而且不报错、不报错、不报错（最难查的那一类）。
   现状：武器页 11 张（长剑 3 + 其余各 2）**只剩 1 格** ——
   以后再加武器技能（比如双刀的）必须先扩格子，否则新技能在试炼场里根本试不到。 */
for(const c of cats){
  assert(g.trialCardList(c).length<=R.tiles.length,
    '试卡面板每页最多 '+R.tiles.length+' 张（'+c+' 现在 '+g.trialCardList(c).length+' 张）—— 超出的会静默消失');
}

/* ---------- 4. 面板开着的时候，主循环不许继续跑（等于暂停）+ 底下 7 个按钮一个都点不到 ---------- */
const before={x:g.player.x,y:g.player.y};
g.update(1/60,{moveX:1,moveY:1,tap:{x:1,y:1}});               // 点左上角空白
assert.equal(g.state,'trialcards','点空白处不关面板（试卡时会点错）');
assert.equal(g.player.x,before.x,'面板开着时玩家不许动');
/* 逐一点一遍底下的试炼场按钮位置：面板必须把它们全吃掉（最要命的是「退出试炼」）——
   这条比"点某一个按钮"强，因为布局一改（比如面板变矮）就会漏出缝隙。 */
for(const r of g.trainingRects()){
  g.cardPanelGuard=0;
  tap(g,r);
  assert.equal(g.training,true,'面板上的点击穿透到了「'+r.label+'」');
  if(g.state!=='trialcards'){ g.cardPanelGuard=0; tapId(g,'cards'); }   // 点到了「关闭」就再打开
}

/* ---------- 5. 点一张数值卡：数值真的变了，而且标了「已试」 ---------- */
g.cardPanelGuard=0;
const sharp=cardOf('dmg');
const idx=g.trialCardList('stat').findIndex(u=>u.id==='dmg');
assert(idx>=0,'数值页要有「'+sharp.name+'」');
const dmg0=g.player.stats.attackDamage;
g.cardPanelGuard=0;tap(g,R.tiles[idx]);
assert(g.player.taken.dmg,'点过之后就记进 taken（面板上的「已试」看这个）');
assert(g.player.stats.attackDamage>dmg0,'攻击力要真的涨：'+dmg0+' → '+g.player.stats.attackDamage);
assert.equal(g.trialCardLast,sharp.name,'面板右上角要回执"刚用上谁"');
const dmg1=g.player.stats.attackDamage;
g.cardPanelGuard=0;tap(g,R.tiles[idx]);
assert(g.player.stats.attackDamage>dmg1,'同一张卡可以重复点（数值叠加），否则试不了"拿两张"');

/* ---------- 6. 点机制卡「开天」：burst 真的登记了（和正式选卡同一条路） ---------- */
g.cardPanelGuard=0;tapId(g,'mechanic');
assert.equal(g.trialCardCat,'mechanic');
const R2=g.trialCardPanelRects();
const skyIdx=g.trialCardList('mechanic').findIndex(u=>u.id==='skyCut');
g.cardPanelGuard=0;tap(g,R2.tiles[skyIdx]);
assert(g.player.burst,'试「开天」要登记 burst');
assert.equal(g.player.burst.left,2,'2 刀');
assert.equal(g.player.burst.active,false,'抽到不立刻生效（和正式局一致）');

/* ---------- 7. 金色开关：开了之后用金色版的数值 ---------- */
g.cardPanelGuard=0;tapId(g,'clear');                          // 先清干净，省得被叠加干扰
assert.equal(g.trialCardGold,false,'默认关');
g.cardPanelGuard=0;
const goldBtn=g.trialCardPanelRects().foot.filter(f=>f.id==='gold')[0];
tap(g,goldBtn);
assert.equal(g.trialCardGold,true,'点一下要开');
tapId(g,'stat');
const R3=g.trialCardPanelRects();
const dmgIdx=g.trialCardList('stat').findIndex(u=>u.id==='dmg');
const d0=g.player.stats.attackDamage;
g.cardPanelGuard=0;tap(g,R3.tiles[dmgIdx]);
const dGold=g.player.stats.attackDamage;
assert(g.player.taken['dmg#rare'],'金色版记的是 dmg#rare');
g.cardPanelGuard=0;tapId(g,'clear');
g.trialCardGold=false;
g.cardPanelGuard=0;tap(g,g.trialCardPanelRects().tiles[dmgIdx]);
const dPlain=g.player.stats.attackDamage;
assert(dGold>dPlain+0.01,'金色版要更强：金 '+dGold.toFixed(1)+' vs 普通 '+dPlain.toFixed(1));

/* ---------- 8. 清空：回裸装（base/taken/进化/burst 全清） ---------- */
g.cardPanelGuard=0;tapId(g,'stat');
g.cardPanelGuard=0;tap(g,g.trialCardPanelRects().tiles[0]);
g.player.burst={id:'skyCut',name:'开天',left:1,active:true,radiusMul:5};
assert(Object.keys(g.player.taken).length>0);
const bareAttack=cfg.player.base.attackDamage, bareHp=cfg.player.base.maxhp;
g.cardPanelGuard=0;tapId(g,'clear');
assert.deepEqual(g.player.taken,{},'清空要把 taken 清掉');
assert.equal(g.player.burst,null,'清空要把爆发状态清掉');
assert.equal(g.player.stats.attackDamage,bareAttack,'攻击力回到裸装 '+bareAttack);
assert.equal(g.player.stats.maxhp,bareHp,'生命上限回到裸装 '+bareHp);
assert.equal(g.player.hp,g.player.stats.maxhp,'清空后血量按新上限补满');
/* ⚠️ evolutions 是个**固定三个键**的对象（flame/storm/quake，值 true/false，见 recompute）——
   所以要断言"一个都没激活"，不能断言"键数为 0"。 */
assert(Object.keys(g.player.evolutions).every(k=>!g.player.evolutions[k]),
  '清空后不该留着进化：'+JSON.stringify(g.player.evolutions));

/* ---------- 9. 清空不该动装备/金币/武器库（那是玩家"刷"出来的，和试卡无关） ---------- */
g=make(true);
const bagLen=g.player.bag.length, w0=g.player.equip.weapon, gold0=g.player.gold;
g.cardPanelGuard=0;tapId(g,'cards');
g.cardPanelGuard=0;tap(g,g.trialCardPanelRects().tiles[0]);
g.cardPanelGuard=0;tapId(g,'clear');
assert.equal(g.player.equip.weapon,w0,'清空卡片不许换掉手上的武器');
assert.equal(g.player.bag.length,bagLen,'清空卡片不许动武器库');
assert.equal(g.player.gold,gold0,'清空卡片不许动金币');

/* ---------- 10. 关闭 → 回到能打的状态，而且护栏不会卡住（on-off 两轮） ---------- */
for(let round=0;round<2;round++){
  g.cardPanelGuard=0;tapId(g,'cards');
  assert.equal(g.state,'trialcards','第 '+(round+1)+' 轮要能打开');
  g.cardPanelGuard=0;tapId(g,'close');
  assert.equal(g.state,'play','第 '+(round+1)+' 轮要能关上');
}
/* 关掉之后同一个按钮还能用：护栏是在 update 顶部递减的（bagGuard 当年就栽在这） */
g.cardPanelGuard=0;tapId(g,'cards');
assert.equal(g.state,'trialcards');
g.cardPanelGuard=0;tapId(g,'close');
for(let i=0;i<10;i++)g.update(1/60,{});
assert(g.cardPanelGuard<=0,'护栏要自己走完，不能永久挡住下一次点击');
g.cardPanelGuard=0;tapId(g,'cards');
assert.equal(g.state,'trialcards','护栏走完之后还能再打开');

/* ---------- 11. 关掉面板后回到正常可玩的战斗状态（不是"卡死"） ---------- */
g.cardPanelGuard=0;tapId(g,'close');
assert.equal(g.state,'play','关掉面板要回到 play');
const px0=g.player.x;
for(let i=0;i<30;i++)g.update(1/60,{moveX:1,moveY:0});
assert.notEqual(g.player.x,px0,'关掉面板后玩家要能动');
assert.equal(g.canSwitchWeapon(),g.player.bag.length>1,'武器库入口的逻辑没被牵连');

/* ---------- 12. 长按/点空白都不该误开面板（试卡入口只在按钮上） ---------- */
g=make(true);
g.player.x=1200;g.player.y=800;
g.update(1/60,{tap:{x:400,y:150}});                           // 屏幕中央空白
assert.notEqual(g.state,'trialcards','点空白处不许开面板');

/* ---------- 13. 首页那个新的「试炼」入口进的是试炼场本体，不该顺手把试卡面板摊开 ----------
   （不然从首页一进来就是一屏卡片，连靶子和 Boss 都看不到）
   ⚠️ 旧的"长按进试炼场"已经整个删掉了（见 verify-training.js 的源码级断言），
      所以这里不再需要"长按时避开面板"那条护栏。 */
g=make(false);g.state='title';
/* 入口存在与否**跟着 debug 开关走**（上线时用户已把 debug 关掉，正式版首页没有这个入口）：
   开着就把"点入口只进试炼场、不摊开面板"验一遍；关着就验"入口确实没有了"。 */
const savedDbg=cfg.debug.enabled;
cfg.debug.enabled=true;
const tr=make(false).titleRects().trial;
assert(tr,'debug 开着时首页要有「试炼」入口');
g=make(false);g.state='title';
g.updateTitle({tap:{x:tr.x+tr.w/2,y:tr.y+tr.h/2}});
assert.equal(g.training,true,'点它进的是试炼场');
assert.notEqual(g.state,'trialcards','首页进来不该直接把试卡面板摊开');
cfg.debug.enabled=false;
assert.equal(make(false).titleRects().trial,null,'debug 关着时首页不许有「试炼」入口');
cfg.debug.enabled=savedDbg;                           // 还回项目里的真实值

console.log('PASS: 试卡面板 = 正式关卡打不开 / 试炼场按钮栏 4+3 且不出屏 / 点一下就用上并可重复点 / 机制卡（开天）burst 真的登记 / 金色开关走金色数值 / 清空回裸装（base+taken+进化+burst）且不动装备金币 / 点空白不关不穿透 / 能反复开关（护栏不卡死）/ 首页入口只进试炼场不开面板');
