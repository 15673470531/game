'use strict';
const assert=require('assert'),cfg=require('../core/config'),Game=require('../core/game'),Adventure=require('../core/adventure'),Account=require('../platform/wechat/account');
const deps={World:require('../core/world'),Entities:require('../core/entities'),Progression:require('../core/progression'),Save:require('../core/save')};
function make(values={}){
 const wx={getStorageSync:k=>values[k],setStorageSync:(k,v)=>values[k]=JSON.parse(JSON.stringify(v))};
 const storage={get:k=>values[k]||null,set:(k,v)=>{values[k]=v;return true;}};
 const account=new Account(wx),g=new Game(cfg,{...deps,storage});g.setViewport(812,375);g.toTitle({keep:false});
 const flow=new Adventure(g,account,wx);return {wx,values,account,g,flow};
}
function dialogue(s){let count=0;while(s.flow.dialogue){assert(count++<10);s.flow.guard=0;s.flow.update(.04,{tap:{x:20,y:20}});}}
function success(s){assert(s.flow.success);const step=s.flow.step,elapsed=s.g.elapsed;s.flow.update(.4,{});assert.equal(s.flow.step,step);assert.equal(s.g.elapsed,elapsed);s.flow.update(1.1,{});}
function killAll(s){for(const f of s.g.foes.slice())s.g.damageFoe(f,999999,0,'weapon');s.flow.update(.04,{});}
(async()=>{
 const s=make();s.flow.boot();assert.equal(s.flow.mode,'tutorial');assert(!s.g.world.landmarks,'original wasteland');assert(s.flow.dialogue);assert(s.g.player.equip.armor,'armor equipped from start');assert.equal(s.flow.dialogue.art[0],'night-road');const x=s.g.player.x;s.flow.update(.04,{moveX:1});assert.equal(s.g.player.x,x);dialogue(s);assert(s.values['kdtl-prologue-v1'].introSeen);
 for(let i=0;i<30;i++)s.flow.update(.04,{moveX:1,moveY:0});success(s);assert.equal(s.flow.step,1);
 killAll(s);success(s);assert.equal(s.flow.step,3);assert(!s.g.pickups.some(p=>p.kind==='item'));
 assert(s.g.player.equip.armor);s.flow.update(.04,{moveX:1,moveY:0,dash:true});assert(!s.flow.success,'dash must finish first');for(let i=0;i<10&&!s.flow.success;i++)s.flow.update(.04,{moveX:1,moveY:0});success(s);assert.equal(s.flow.step,4);
 killAll(s);success(s);assert.equal(s.flow.step,5);s.g.collect(s.g.pickups[0]);s.flow.update(.04,{});assert.equal(s.g.foes.length,2);
 killAll(s);success(s);dialogue(s);assert.equal(s.flow.mode,'login');assert(s.values['kdtl-prologue-v1'].completed);
 assert.deepEqual(s.g.player.mastery,{});assert(!s.values[cfg.save.key]);
 s.g.startRun(false);assert.equal(s.flow.mode,'login');assert.equal(s.g.state,'title');
 const fresh=make(s.values);fresh.flow.boot();assert.equal(fresh.flow.mode,'login');
 const oldEquipment=make({'kdtl-prologue-v1':{step:2,introSeen:true}});oldEquipment.flow.boot();assert.equal(oldEquipment.flow.step,3);assert(oldEquipment.g.player.equip.armor);
 const mid=make({'kdtl-prologue-v1':{step:4}});mid.flow.boot();assert.equal(mid.flow.step,4);
 mid.g.player.inv=0;mid.g.hurtPlayer(999999,0,0,null);mid.flow.update(.04,{});mid.flow.guard=0;mid.flow.update(.04,{tap:{x:400,y:200}});assert.equal(mid.g.state,'play');assert.equal(mid.flow.step,4);
 const c=make();c.account.ready=true;c.account.data.playerId=12;
 const payload=c.flow.payload();c.flow.applyAccount({revision:1,payload},12);
 assert.equal(c.flow.mode,'chapters');c.flow.enterChapter(false);assert.equal(c.flow.mode,'story');
 assert.equal(c.flow.dialogue.index,0);c.flow.guard=0;c.flow.update(.04,{tap:{x:10,y:10}});assert.equal(c.flow.dialogue.index,1);assert.equal(c.flow.mode,'story');dialogue(c);
 assert.equal(c.flow.mode,'chapter');assert.equal(c.g.state,'play');assert(c.g.world.landmarks.altar);assert(c.flow.storySeen);
 c.g.player.level=4;c.g.player.xp=7;c.g.saveNow();const running=c.g.loadMeta();const cloud=c.flow.payload(running);c.flow.applyAccount({revision:2,payload:cloud},12);assert(c.g.hasResume());assert.equal(c.g.loadMeta().level,4);c.flow.enterChapter(true);assert.equal(c.g.player.level,4);assert.equal(c.g.player.xp,7);
 c.g.stageClear();assert.equal(c.flow.chapterCompleted,1);assert(c.account.data.latest);
 c.g.toTitle();c.flow.guard=0;const settings=c.flow.layout().buttons.find(b=>b.id==='settings');c.flow.update(.04,{tap:{x:settings.x+2,y:settings.y+2}});assert.equal(c.flow.mode,'settings');
 const legacy=make({[cfg.save.key]:JSON.stringify({v:1,gold:30,mastery:{sword:150}})});legacy.flow.boot();assert.equal(legacy.flow.mode,'login');assert.equal(JSON.parse(legacy.values[cfg.save.key]).gold,30);
 const art=make();let imageCount=0;art.wx.createImage=()=>{imageCount++;return {width:1280,height:720};};art.flow.boot();assert.equal(imageCount,2);const picture=art.flow.loadStoryArt('night-road');assert.equal(imageCount,2);picture.image.onload();assert(picture.ready);picture.image.onerror();assert(!picture.ready,'failed art leaves dialogue usable');
 const TouchInput=require('../platform/wechat/input');const handlers={};const touchWx={onTouchStart:f=>handlers.start=f,onTouchMove:f=>handlers.move=f,onTouchEnd:f=>handlers.end=f,onTouchCancel:f=>handlers.cancel=f};const touch=new TouchInput(touchWx,{width:812,height:375});touch.read({state:'intro'});const point={identifier:1,clientX:touch.btnDash.x,clientY:touch.btnDash.y};handlers.start({changedTouches:[point]});handlers.end({changedTouches:[point]});assert(touch.read({state:'intro'}).tap,'dialogue accepts taps even over hidden dash control');touch.read({state:'play'});handlers.start({changedTouches:[point]});assert(touch.read({state:'play'}).dash);handlers.end({changedTouches:[point]});
 console.log('Adventure: tutorial, retry, resume, login gate, chapters/story and legacy protection passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
