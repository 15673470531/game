'use strict';
var Entrances=typeof require==='function'?require('./entrances'):globalThis.__GAME__.Entrances;
var FLOW_KEY='kdtl-prologue-v1';
// Keep persisted IDs stable: old equipment step 2 advances directly to dash step 3.
var TUTORIAL_STEPS=[0,1,3,4,5];
var ARMOR={id:'prologue-armor',slot:'armor',slotName:'护甲',kind:null,name:'守夜者旧甲',rarity:1,rarityName:'普通',color:'#c9ccd2',affixes:[{k:'maxhp',v:10,label:'生命'}],score:10};
function copy(x){return JSON.parse(JSON.stringify(x));}
function Adventure(game,account,wx){
 this.g=game;this.account=account;this.wx=wx;this.baseCfg=game.cfg;this.baseStorage=game.storage;this.mode='loading';this.busy=false;this.notice='正在检查冒险进度';this.guard=.4;
 try{this.progress=wx.getStorageSync(FLOW_KEY)||{};}catch(_){this.progress={};}
 if(typeof this.progress!=='object')this.progress={};
 this.legacy=game.loadMeta();
 this.hasLegacy=!!(this.legacy&&(this.legacy.run||this.legacy.runs||this.legacy.gold||Object.keys(this.legacy.mastery||{}).length||this.legacy.bag&&this.legacy.bag.length>1));
 this.hook();
 var self=this;this.entrances=new Entrances(game,function(){return self.mode==='chapter';});
}
Adventure.prototype.persist=function(){try{this.wx.setStorageSync(FLOW_KEY,this.progress);}catch(_){this.notice='本机保存失败，请勿退出';}};
Adventure.prototype.payload=function(data){var g=this.g,d=data||g.Save.snapshot(g,false);return {
 v:1,gold:Math.max(0,Math.floor(d.gold||0)),mastery:Array.isArray(d.mastery)?{}:(d.mastery||{}),equip:d.equip||{weapon:null,armor:null,trinket:null},bag:d.bag||[],best:d.best||{wave:1,kills:0},runs:d.runs||0,
 chapterCompleted:this.chapterCompleted||0,storySeen:!!this.storySeen};};
Adventure.prototype.hook=function(){var self=this,g=this.g;this.original={};
 ['bgmTrack','saveNow','startRun','toTitle','updateSpawns','tickWave','updateHazards','checkSwarm','updateSwarm','gainMastery','onFoeDeath','collect','stageClear','track','setTraining'].forEach(function(k){self.original[k]=g[k];});
 g.bgmTrack=function(){if(self.victory||self.dialogue&&self.dialogue.ember)return null;return self.original.bgmTrack.call(g);};
 g.saveNow=function(){if(self.mode==='tutorial'){self.persist();return true;}var out=self.original.saveNow.apply(g,arguments);if(self.account.data.playerId&&self.mode==='chapter')self.account.queue(self.payload());return out;};
 g.startRun=function(resume){if(self.mode==='tutorial'){self.setupStep(self.step);return 'new';}if(!self.account.ready){self.mode='login';g.state='title';return 'failed';}return self.original.startRun.call(g,resume);};
 g.toTitle=function(opts){self.victory=null;g.victoryScene=null;self.dialogue=null;if(self.mode==='tutorial'){g.state='play';return true;}self.original.toTitle.call(g,opts);self.mode=self.account.ready?'chapters':'login';self.account.sync(true);return true;};
 ['updateSpawns','tickWave','updateHazards','checkSwarm','updateSwarm','gainMastery','setTraining'].forEach(function(k){g[k]=function(){if(self.mode==='tutorial'||k==='setTraining')return;return self.original[k].apply(g,arguments);};});
 g.track=function(){if(self.mode==='tutorial')return;return self.original.track.apply(g,arguments);};
 g.onFoeDeath=function(f){if(self.mode!=='tutorial')return self.original.onFoeDeath.call(g,f);g.player.kills++;self.killed++;};
 g.collect=function(u){var out=self.original.collect.call(g,u);if(self.mode==='tutorial'){if(u.kind==='skill')self.skillPicked=true;}return out;};
 g.stageClear=function(){
  if(self.mode==='chapter'&&g.trial&&g.trial.finished)return;
  var fallen=g.foes.find(function(f){return f.kind==='boss';});
  var first=!self.chapterCompleted,out=self.original.stageClear.call(g);
  if(self.mode==='chapter'){
   self.chapterCompleted=1;g.collectAll();g.clearT=0;g.nextStage();
   // Settle rewards and persist the finished run before the optional presentation.
   g.saveNow();self.account.queue(self.payload());self.account.sync(true);
   self.victory={age:0,first:first,fallen:fallen?copy(fallen):null,cam:{x:g.cam.x,y:g.cam.y}};g.victoryScene=self.victory;g.state='intro';
  }return out;
 };
};
Adventure.prototype.boot=function(){var self=this;
 if(this.account.data.token){this.account.restore().then(function(info){return self.loadAccount(info);}).catch(function(err){self.mode='login';self.notice=err.message;self.g.state='title';});}
 else if(this.hasLegacy||this.progress.completed){this.mode='login';this.notice=this.hasLegacy?'你的原有进度已保留，登录后同步':'序章完成，登录保存成果并开启第一章';this.g.state='title';}
 else this.startTutorial();
};
Adventure.prototype.authenticate=function(){var self=this;if(this.busy)return;this.busy=true;this.notice='正在微信登录';
 this.account.login().then(function(info){return self.loadAccount(info);}).catch(function(err){self.notice=err.message||'登录失败，请重试';self.mode='login';}).then(function(){self.busy=false;});
};
Adventure.prototype.loadAccount=function(info){var self=this;
 if(!info.tutorial_completed){
  if(!this.progress.completed&&!this.hasLegacy){this.startTutorial();return;}
  return this.account.initialize(this.hasLegacy?'legacy':'tutorial',this.payload(this.hasLegacy?this.legacy:null)).then(function(save){if(self.hasLegacy){self.bindAccount(info.player_id);if(!self.g.loadMeta())self.baseStorage.set(self.g.cfg.save.key,JSON.stringify(self.legacy));}self.applyAccount(save,info.player_id);});
 }
 if(!info.save)throw {message:'云存档尚未初始化，请稍后重试'};
 // An unsent local snapshot always needs reconciliation, never silently replaced.
 if(this.account.data.latest||this.account.data.pending){
  this.account.conflict=info.save;this.bindAccount(info.player_id);this.mode='conflict';this.g.state='title';return;
 }
 this.applyAccount(info.save,info.player_id);
};
Adventure.prototype.bindAccount=function(id){
 this.g.cfg=Object.assign({},this.baseCfg,{save:Object.assign({},this.baseCfg.save,{key:this.baseCfg.save.key+'-account-'+id})});
 this.g.storage=this.baseStorage;
};
Adventure.prototype.applyAccount=function(save,id){
 this.bindAccount(id);var old=this.g.loadMeta(),d=copy(save.payload);
 this.chapterCompleted=d.chapterCompleted||0;this.storySeen=!!d.storySeen;
 // Same device's unfinished run stays local if long-term progress matches the server.
 if(old&&old.run&&JSON.stringify(this.payload(old))===JSON.stringify(this.payload(d)))d=Object.assign({},old,d,{run:old.run});
 if(old&&old.settings)d.settings=old.settings;
 if(!this.baseStorage.set(this.g.cfg.save.key,JSON.stringify(d)))throw {message:'本机存储失败，请清理空间后重试，云端进度仍保留'};
 this.account.setCloud(save);this.account.lastSynced=JSON.stringify(save.payload);
 this.original.toTitle.call(this.g,{keep:false});this.mode='chapters';this.notice='云存档已同步';this.guard=.3;this.loadExpectation();
};
Adventure.prototype.startTutorial=function(){
 this.mode='tutorial';this.g.cfg=Object.assign({},this.baseCfg,{save:Object.assign({},this.baseCfg.save,{enabled:false})});this.g.storage=null;
 this.setupStep(Math.max(0,Math.min(5,this.progress.step||0)));
 if(!this.progress.introSeen&&!this.progress.step){var self=this;this.beginDialogue(['我最后记得的，是深夜回家路上的灯光。','再睁开眼，熟悉的街道消失了。眼前只剩荒草与碎石。','掌心多了一道陌生的印记，身旁躺着一把旧剑。','远处传来低吼。无论这里是什么地方，我得先活下来。'],function(){self.progress.introSeen=true;self.persist();self.g.state="play";},['night-road','wasteland','wasteland','wasteland']);}
};
Adventure.prototype.spawn=function(type,hp,dx,dy){var g=this.g,p=g.player,x=p.x+dx,y=p.y+dy;
 if(!g.world.isFree(x,y,30)){x=p.x+90;y=p.y;}
 var f=g.Entities.makeFoe(g.cfg,type,x,y,1,1,null);f.hp=f.maxhp=hp;f.dmg=5;f.spd=type==='charger'?45:30;f.xp=0;f.gold=0;
 g.foes.push(f);return f;
};
Adventure.prototype.setupStep=function(step){
 if(step===2)step=3;
 var g=this.g;this.success=null;this.step=step;this.progress.step=step;this.persist();g.reset();
 // Restore the original wasteland generation, keeping the formal altar world untouched.
 var terrain=Object.assign({},g.cfg,{trial:Object.assign({},g.cfg.trial,{enabled:false})});
 g.player.x=320;g.player.y=800;g.world=g.World.createWorld(terrain,{x:320,y:800},1);g.updateCamera();
 g.player.hp=g.player.stats.maxhp;g.state='play';this.killed=0;this.skillPicked=false;this.moved=0;this.dashed=false;this.dashAttempt=null;this.startX=g.player.x;this.startY=g.player.y;this.stepAge=0;this.skillEnemies=false;this.guard=.4;
 g.player.equip.armor=copy(ARMOR);g.Prog.recompute(g.player,g.cfg);g.player.hp=g.player.stats.maxhp;
 if(step===1)this.spawn('slime',100,130,0);
 if(step===3){var f=this.spawn('charger',99999,180,0);f.name='练习：躲开冲撞';}
 if(step===4){var elite=this.spawn('charger',450,180,0);elite.name='荒原猎卫';elite.r=28;this.spawn('slime',70,220,65);this.spawn('slime',70,220,-65);}
 if(step===5){g.pickups.push(g.Entities.makePickup('skill',g.player.x+75,g.player.y,'sword_wave'));}
};
Adventure.prototype.beginDialogue=function(lines,done,art){
 this.dialogue={lines:lines,index:0,done:done,art:art||[],age:0};this.g.state='intro';this.guard=.3;
 var self=this;(art||[]).forEach(function(name){self.loadStoryArt(name);});
};
Adventure.prototype.loadStoryArt=function(name){
 if(!name||!this.wx.createImage)return null;
 this.storyImages=this.storyImages||{};if(this.storyImages[name])return this.storyImages[name];
 var asset={ready:false};this.storyImages[name]=asset;
 try{var img=this.wx.createImage();asset.image=img;img.onload=function(){asset.ready=true;};img.onerror=function(){asset.ready=false;};img.src='assets/story/'+name+'.jpg';}catch(_){asset.ready=false;}
 return asset;
};
Adventure.prototype.nextTutorialStep=function(step){return TUTORIAL_STEPS[TUTORIAL_STEPS.indexOf(step)+1];};
Adventure.prototype.passStep=function(){
 if(this.success)return;
 this.success={step:this.step,left:1.4};this.g.state='intro';
 // Persist the completed step before the transition, so a relaunch cannot lose it.
 if(this.step<5)this.progress.step=this.nextTutorialStep(this.step);else this.progress.completed=true;
 this.persist();
};
Adventure.prototype.completeTutorial=function(){
 this.progress.completed=true;this.persist();var self=this;
 this.beginDialogue(['猎卫倒下后，你在守夜者的遗物里找到一张残图。','纸上只留着一句话：“别等天亮——它已经很久没来过了。”','残图指向荒原深处的一座祭坛。也许那里藏着你来到这个世界的答案。'],function(){self.mode='login';self.g.state='title';self.notice='序章完成 · 守夜者旧甲将在登录后保存';self.guard=.3;},['watchkeeper-map','watchkeeper-map','silent-altar']);
};
Adventure.prototype.enterChapter=function(resume){
 if(!this.account.ready){this.mode='login';this.g.state='title';return;}
 if(this.account.conflict){this.mode='conflict';this.g.state='title';return;}
 if(!resume&&!this.storySeen){this.mode='story';var self=this;this.beginDialogue(['残图把你带到荒原深处。','熄灭的祭坛上，留着与掌心相同的印记。','你刚踏上石阶，地下便传来密集的刮擦声。','想弄清自己为何来到这里，得先让晨火重新燃起。'],function(){self.storySeen=true;self.enterChapter(false);},['silent-altar','silent-altar','silent-altar','silent-altar']);return;}
 this.mode='chapter';this.g.cfg=Object.assign({},this.g.cfg,{save:Object.assign({},this.g.cfg.save,{enabled:true})});
 this.original.startRun.call(this.g,!!resume);this.account.queue(this.payload());this.guard=.3;
};
Adventure.prototype.update=function(dt,input){var g=this.g;this.guard=Math.max(0,this.guard-dt);
 if(this.victory){if(g.state==='paused'){g.update(dt,input);return;}this.updateVictory(dt);this.account.sync(false);return;}
 if(this.dialogue){
  this.dialogue.age+=dt;
  if(this.guard<=0&&input.tap){var d=this.dialogue;d.index++;d.age=0;this.guard=.25;if(d.index>=d.lines.length){this.dialogue=null;d.done();}}
  return;
 }
 if(this.success){this.success.left-=dt;if(this.success.left<=0){var step=this.success.step;this.success=null;if(step<5)this.setupStep(this.nextTutorialStep(step));else this.completeTutorial();}return;}
 if(this.mode==='tutorial'){
  if(g.state==='dead'){if(this.guard<=0&&input.tap)this.setupStep(this.step);return;}
  if(g.state==='paused'){g.update(dt,input);return;}
  g.pickups.forEach(function(u){u.t=0;});
  var x=g.player.x,y=g.player.y,wasDashing=g.player.dash>0;g.update(dt,input);this.stepAge+=dt;this.moved+=Math.hypot(g.player.x-x,g.player.y-y);
  if(this.step===3){
   if(g.player.dash>0&&!wasDashing)this.dashAttempt={distance:0};
   if(this.dashAttempt){
    if(wasDashing||g.player.dash>0)this.dashAttempt.distance+=Math.hypot(g.player.x-x,g.player.y-y);
    if(wasDashing&&g.player.dash<=0){this.dashed=this.dashAttempt.distance>=30;this.dashAttempt=null;}
   }
  }
  if(g.state==='dead'){this.guard=.5;return;}
  if(this.step===0&&this.moved>=100||this.step===1&&this.killed>=1||this.step===3&&this.dashed||this.step===4&&this.killed>=3)this.passStep();
  else if(this.step===5){if(this.skillPicked&&!this.skillEnemies){this.skillEnemies=true;this.spawn('slime',70,180,0);this.spawn('slime',70,210,55);}if(this.skillPicked&&this.killed>=2)this.passStep();}
  return;
 }
 if(this.mode==='chapter'){if(g.state==='clear')g.rewardReveal=Math.min(1.8,(g.rewardReveal||0)+dt);if(!this.entrances.beforeUpdate(dt)){g.update(dt,input);this.entrances.afterUpdate();}this.account.sync(false);return;}
 if(this.mode==='library'){if(input.tap){g.updateCodex(input.tap);if(!g.codexOpen){this.mode='chapters';g.homeLibrary=false;}}return;}
 if(this.mode==='settings'){if(input.tap){g.updateSettingsPanel(input.tap);if(!g.settingsOpen)this.mode='chapters';}return;}
 if(this.mode==='chapters'&&this.account.conflict)this.mode='conflict';
 if(this.guard>0||this.busy||!input.tap)return;
 var buttons=this.layout().buttons,self=this;
 buttons.some(function(b){if(!g.inRect(b,input.tap))return false;
  if(b.id==='login')self.authenticate();
  if(b.id==='start')self.enterChapter(false);
  if(b.id==='resume')self.enterChapter(true);
  if(b.id==='cloud'){
   try{self.wx.setStorageSync('kdtl-conflict-backup-'+self.account.data.playerId,self.account.data.latest||self.account.data.pending&&self.account.data.pending.payload);}catch(_){}
   self.applyAccount(self.account.conflict,self.account.data.playerId);
  }
  if(b.id==='local'){
   var local=self.account.data.latest||self.account.data.pending&&self.account.data.pending.payload;
   if(local){self.account.data.latest=local;self.busy=true;Promise.resolve(self.account.keepLocal()).then(function(){self.busy=false;if(!self.account.data.pending&&!self.account.conflict)self.applyAccount({revision:self.account.data.revision,payload:local},self.account.data.playerId);else self.notice=self.account.message;});}
  }
  if(b.id==='expect')self.expectChapter();
  if(b.id==='library'){g.openCodex();self.mode='library';g.homeLibrary=true;}
  if(b.id==='ending'){self.showEnding(function(){self.mode='chapters';g.state='title';});}
  if(b.id==='settings'){g.settingsOpen=true;self.mode='settings';}
  return true;
 });

};
Adventure.prototype.layout=function(){
 var vp=this.g.viewport,ins=vp.insets||{},left=(ins.left||0)+22,right=vp.w-(ins.right||0)-22,top=Math.max((ins.top||0)+18,this.g.menuReserveTop||0),bottom=vp.h-(ins.bottom||0)-18;
 var width=Math.min(420,right-left),x=(left+right-width)/2,buttons=[],y=top+95;
 function button(id,label,yy,h){buttons.push({id:id,label:label,x:x,y:yy,w:width,h:h||44});}
 if(this.mode==='chapters'){
  button('expect','第二章 · 迷雾旧镇（开发中） · '+(this.expectationBusy?'提交中…':this.expected?'已期待 ✓':'期待这一章'),top+145+(this.g.hasResume()?45:0),28);
  button('start',this.chapterCompleted?'第一章 · 已通关 · 再次挑战':'第一章 · 荒原残火',y);
  buttons.push({id:'library',label:'武器库 · 熟练度',x:x,y:bottom-68,w:width,h:36});
  if(this.chapterCompleted)buttons.push({id:'ending',label:'重温晨火',x:left,y:top,w:92,h:32});
  if(this.g.hasResume())button('resume','继续本机未完成的第一章',y+50,36);
  buttons.push({id:'settings',label:'设置',x:right-66,y:top,w:66,h:32});
 }else if(this.mode==='login')button('login',this.busy?'正在登录…':'微信登录 · 保存进度',bottom-50);
 else if(this.mode==='conflict'){button('cloud','保留云端进度',bottom-100);button('local','保留本机进度',bottom-50);}
 return {x:x,w:width,top:top,bottom:bottom,buttons:buttons};
};
Adventure.prototype.draw=function(renderer,t){var g=this.g,ctx=renderer.ctx,w=renderer.w,h=renderer.h;
 if(this.dialogue){ctx.save();this.drawDialogue(ctx,w,h);ctx.restore();return;}
 if(this.mode==='chapter'){renderer.draw(g,t);if(this.victory)this.drawVictoryCaption(ctx,w,h);return;}
 if(this.mode==='library'){renderer.drawCodex(g);return;}
 if(this.mode==='tutorial'){
  var stageHud=renderer.drawStageHud,frenzyHud=renderer.drawFrenzyControl,introHud=renderer.drawStageIntro;
  renderer.drawStageHud=renderer.drawFrenzyControl=renderer.drawStageIntro=function(){};
  try{renderer.draw(g,t);}finally{renderer.drawStageHud=stageHud;renderer.drawFrenzyControl=frenzyHud;renderer.drawStageIntro=introHud;}ctx.save();
  if(this.dialogue){this.drawDialogue(ctx,w,h);ctx.restore();return;}
  if(this.success){this.drawSuccess(ctx,w,h);ctx.restore();return;}
  var lines=[['序章 · 醒在荒原','拖动左侧摇杆移动，先离开醒来的位置'],['武器会自动攻击','靠近小怪，调整距离，让旋刃扫中它'],null,['学会冲刺','保持移动，点击右下冲刺，躲开猎卫的冲撞'],['通往废墟的路','击败荒原猎卫和两只小怪，留意冲撞预警'],['卷轴中的力量','走近卷轴学习剑气，再消灭两只小怪']];
  var line=lines[this.step],cw=Math.max(190,Math.min(w-(renderer.insets.left||0)-(renderer.insets.right||0)-360,470)),x=(w-cw)/2,y=8+(renderer.insets.top||0);
  ctx.fillStyle='rgba(8,19,24,.88)';ctx.fillRect(x,y,cw,74);ctx.textAlign='center';ctx.fillStyle='#f4d69b';ctx.font='bold 15px sans-serif';ctx.fillText(line[0]+'  '+(TUTORIAL_STEPS.indexOf(this.step)+1)+'/5',w/2,y+21);
  ctx.fillStyle='#e0e8e3';ctx.font='12px sans-serif';this.wrap(ctx,line[1],w/2,y+42,cw-20,16);
  if(g.state==='dead'){ctx.fillStyle='rgba(7,15,20,.96)';ctx.fillRect(0,0,w,h);ctx.fillStyle='#fff0d1';ctx.font='bold 22px sans-serif';ctx.fillText('再试一次',w/2,h/2-15);ctx.font='14px sans-serif';ctx.fillText('点击屏幕，从当前教学步骤重新开始',w/2,h/2+20);}
  ctx.restore();return;
 }
 ctx.save();var r=this.layout(),gradient=ctx.createLinearGradient(0,0,w,h);gradient.addColorStop(0,'#142e35');gradient.addColorStop(1,'#080f19');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
 this.drawHomeAtmosphere(ctx,w,h,t||0);
 // Subtle ember circles link the chapter screen to the dormant altar.
 ctx.strokeStyle='rgba(216,170,87,.12)';ctx.lineWidth=1;
 [50,90,130].forEach(function(radius){ctx.beginPath();ctx.arc(w*.83,h*.66,radius,0,Math.PI*2);ctx.stroke();});
 ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#f7e4be';ctx.font='bold 26px sans-serif';
 var title=this.mode==='login'?'序章 · 长夜的来客':this.mode==='story'?'第一章 · 荒原残火':this.mode==='conflict'?'选择要保留的进度':'砍到天亮';ctx.fillText(title,w/2,r.top+23);
 ctx.font='13px sans-serif';ctx.fillStyle='#adc2c0';
 if(this.mode==='chapters'||this.mode==='settings'){
  ctx.fillText(this.chapterCompleted?'晨火已经点亮，雾中的道路正在显现':'点燃晨火，找回黎明',w/2,r.top+56);
  var offset=this.g.hasResume()?45:0;
  ctx.fillStyle='#849494';ctx.fillText('第三章 · 沉钟矿井    开发中',w/2,r.top+190+offset);
  ctx.fillStyle='#e0c38e';ctx.font='12px sans-serif';ctx.fillText('长剑  '+g.masteryShortText(g.masteryInfo('sword')),w/2,r.bottom-80);
  ctx.fillStyle='#adc2c0';ctx.font='11px sans-serif';ctx.fillText((this.chapterCompleted?'第一章已通关 · ':'')+(this.expectationNotice||this.account.message||this.notice),w/2,r.bottom-12);
 }else if(this.mode==='login'){
  var text=this.hasLegacy?'你的原有冒险进度仍在。登录后将它保存到云端。':'“别等天亮——它已经很久没来过了。”\n守夜者留下的残图，指向荒原深处的祭坛。';
  this.wrap(ctx,text,w/2,r.top+85,r.w,22);ctx.fillStyle='#f0c98a';this.wrap(ctx,this.notice,w/2,r.bottom-83,r.w,18);
 }else if(this.mode==='story'){
  this.wrap(ctx,'残图把你带到荒原深处。\n熄灭的祭坛上，留着与掌心相同的印记。\n你刚踏上石阶，地下便传来密集的刮擦声。\n想弄清自己为何来到这里，得先让晨火重新燃起。',w/2,r.top+82,r.w,24);
 }else if(this.mode==='conflict'){
  var local=this.account.data.latest||this.account.data.pending&&this.account.data.pending.payload||{},cloud=this.account.conflict&&this.account.conflict.payload||{};
  this.wrap(ctx,'另一份进度已保存，系统没有自动覆盖。\n本机：金币 '+(local.gold||0)+' · 长剑熟练度 '+((local.mastery||{}).sword||0)+'\n云端：金币 '+(cloud.gold||0)+' · 长剑熟练度 '+((cloud.mastery||{}).sword||0),w/2,r.top+73,r.w,21);
 }else this.wrap(ctx,this.notice,w/2,h/2,r.w,22);
 r.buttons.forEach(function(b){ctx.fillStyle=(b.id==='settings'||b.id==='ending'||b.id==='expect')?'#22383e':'#c99f5a';ctx.fillRect(b.x,b.y,b.w,b.h);ctx.fillStyle=(b.id==='settings'||b.id==='ending'||b.id==='expect')?'#e2e8e3':'#17232b';ctx.font=b.id==='expect'?'12px sans-serif':'bold 15px sans-serif';ctx.fillText(b.label,b.x+b.w/2,b.y+b.h/2);});
 if(this.mode==='settings')renderer.drawPanel(g,g.settingsRects());ctx.restore();
};
Adventure.prototype.wrap=function(ctx,text,x,y,width,lineHeight){String(text).split('\n').forEach(function(paragraph){var line='';Array.from(paragraph).forEach(function(ch){if(ctx.measureText(line+ch).width>width&&line){ctx.fillText(line,x,y);y+=lineHeight;line=ch;}else line+=ch;});ctx.fillText(line,x,y);y+=lineHeight;});};

Adventure.prototype.centerLines=function(ctx,text,w,h){
 var width=Math.min(560,w-100),lines=[],line='';
 Array.from(text).forEach(function(ch){if(ctx.measureText(line+ch).width>width&&line){lines.push(line);line=ch;}else line+=ch;});if(line)lines.push(line);
 lines.forEach(function(t,i){ctx.fillText(t,w/2,h/2+(i-(lines.length-1)/2)*30);});
};
Adventure.prototype.drawDialogue=function(ctx,w,h){
 var d=this.dialogue,asset=this.loadStoryArt(d.art[d.index]);
 ctx.fillStyle='#0a151e';ctx.fillRect(0,0,w,h);
 if(asset&&asset.ready){
  var img=asset.image,scale=Math.max(w/img.width,h/img.height)*(1+.025*Math.min(d.age/8,1)),iw=img.width*scale,ih=img.height*scale;
  ctx.save();ctx.globalAlpha=Math.min(1,.4+d.age*1.5);ctx.drawImage(img,(w-iw)/2,(h-ih)/2,iw,ih);ctx.restore();
 }
 if(d.ember){var fire=ctx.createRadialGradient(w*.65,h*.6,0,w*.65,h*.6,w*.7);fire.addColorStop(0,'rgba(247,170,61,.22)');fire.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=fire;ctx.fillRect(0,0,w,h);}
 // Keep the painting visible at the edges and the centered narration readable.
 var shade=ctx.createLinearGradient(0,0,0,h);shade.addColorStop(0,'rgba(3,10,17,.24)');shade.addColorStop(.35,'rgba(3,10,17,.48)');shade.addColorStop(.5,'rgba(3,10,17,.72)');shade.addColorStop(.65,'rgba(3,10,17,.48)');shade.addColorStop(1,'rgba(3,10,17,.62)');ctx.fillStyle=shade;ctx.fillRect(0,0,w,h);
 ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#f7e4be';ctx.font='18px sans-serif';ctx.shadowColor='#02080d';ctx.shadowBlur=7;
 this.centerLines(ctx,d.lines[d.index],w,h);ctx.shadowBlur=0;
 ctx.font='12px sans-serif';ctx.fillStyle='#c0cec9';ctx.fillText('点击屏幕继续  '+(d.index+1)+' / '+d.lines.length,w/2,h-45);
};
Adventure.prototype.drawSuccess=function(ctx,w,h){
 var labels=['移动教学完成','攻击教学完成','','冲刺教学完成','精英挑战完成','技能教学完成'];
 ctx.fillStyle='rgba(5,20,18,.80)';ctx.fillRect(0,0,w,h);ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#9be3b2';ctx.font='bold 24px sans-serif';ctx.fillText('✓ '+labels[this.success.step],w/2,h/2-12);
 ctx.font='14px sans-serif';ctx.fillStyle='#e0e8df';ctx.fillText(this.success.step===5?'序章已通关':'即将进入下一项教学',w/2,h/2+27);
};

// The first clear gets a complete epilogue. Replays remain available from home.
Adventure.prototype.showEnding=function(done){
 this.beginDialogue(['巨蝎倒下了。祭坛深处，一点火光重新亮起。','掌心的印记随之发烫。火焰中，你看见那条熟悉的回家路——却只是一闪而过。','这些熄灭的祭坛，也许藏着回去的方法。至少现在，你不再毫无线索。','火光照过残图，一条道路浮现出来，通向雾中的旧镇。','下一站 · 迷雾旧镇\n新的章节正在开发中'],done,['silent-altar','night-road','silent-altar','watchkeeper-map','watchkeeper-map']);
 this.dialogue.ember=true;
};
Adventure.prototype.updateVictory=function(dt){
 var g=this.g,v=this.victory;
 v.age+=dt;g.parts.update(dt);var A=g.world.landmarks.altar,z=Math.min(1,v.age/2),ease=z*z*(3-2*z);
 var vp=g.viewport,zoom=g.cfg.camera?g.cfg.camera.zoom:1;
 var tx=Math.max(0,Math.min(g.world.w-vp.w/zoom,A.x-vp.w/(2*zoom))),ty=Math.max(0,Math.min(g.world.h-vp.h/zoom,A.y-vp.h/(2*zoom)));
 g.cam.x=v.cam.x+(tx-v.cam.x)*ease;g.cam.y=v.cam.y+(ty-v.cam.y)*ease;
 if(v.age<5.4)return;
 var self=this,first=v.first;this.victory=null;g.victoryScene=null;
 function summary(){g.state='clear';g.clearGuard=.6;g.rewardReveal=0;self.guard=.4;}
 if(first)this.showEnding(summary);else summary();
};
Adventure.prototype.drawVictoryCaption=function(c,w,h){
 var age=this.victory.age;c.save();c.fillStyle='rgba(3,10,17,.85)';c.fillRect(0,0,w,25);c.fillRect(0,h-76,w,76);
 c.globalAlpha=Math.min(1,age/.7);c.textAlign='center';c.textBaseline='middle';c.fillStyle='#ffe0a0';c.font='bold 23px sans-serif';c.fillText(age<2?'长夜，终于有了回应':'第一章完成 · 晨火已燃',w/2,h-49);
 c.fillStyle='#c9cbbb';c.font='13px sans-serif';c.fillText(age<2?'刮擦声消失了。灰烬里，升起一缕光。':'裂隙正在合拢。远处仍是黑夜，但这里已经不同。',w/2,h-22);c.restore();
};
Adventure.prototype.drawHomeAtmosphere=function(c,w,h,t){
 var lit=!!this.chapterCompleted,x=w*.82,y=h*.65;c.save();
 var glow=c.createRadialGradient(x,y,3,x,y,Math.min(w,h)*.8);glow.addColorStop(0,lit?'rgba(230,160,65,.26)':'rgba(60,104,110,.16)');glow.addColorStop(1,'rgba(0,0,0,0)');c.fillStyle=glow;c.fillRect(0,0,w,h);
 for(var i=3;i>=0;i--){c.fillStyle=lit?'rgba(119,104,75,.4)':'rgba(56,78,80,.45)';c.beginPath();c.ellipse(x,y+i*12,78+i*17,22+i*5,0,0,7);c.fill();}
 c.fillStyle='#26383c';c.fillRect(x-24,y-25,48,28);
 if(lit){for(var j=0;j<3;j++){c.fillStyle=['#b96b2d','#efb952','#fff1b8'][j];c.beginPath();c.ellipse(x+Math.sin(t*2+j)*3,y-36-j*6,13-j*3,24-j*4,0,0,7);c.fill();}
 for(var i=0;i<20;i++){var phase=(t*.13+i*.137)%1;c.fillStyle='rgba(255,213,124,'+((1-phase)*.5)+')';c.fillRect(x+Math.sin(i*7+phase)*45,y-25-phase*130,2,2);}}
 c.restore();
};


// Kept outside the cloud-save payload so restoring a save cannot erase a vote.
Adventure.prototype.loadExpectation=function(){
 var self=this,id=this.account.data.playerId,serial=(this.expectationSerial||0)+1;
 this.expectationSerial=serial;this.expected=false;this.expectationBusy=false;this.expectationNotice='';
 if(!this.account.request)return;
 this.account.request('chapters/2/expectation','GET').then(function(data){
  if(self.account.data.playerId===id&&self.expectationSerial===serial)self.expected=!!data.expected;
 },function(){ /* An unavailable optional endpoint must not block the chapter screen. */ });
};
Adventure.prototype.expectChapter=function(){
 var self=this;if(this.expected||this.expectationBusy)return;
 if(!this.account.ready){this.mode='login';this.g.state='title';this.notice='请先登录，再表达期待';return;}
 var id=this.account.data.playerId,serial=(this.expectationSerial||0)+1;
 this.expectationSerial=serial;this.expectationBusy=true;this.expectationNotice='正在送出你的期待…';
 this.account.request('chapters/2/expectation','PUT',{}).then(function(data){
  if(self.account.data.playerId!==id||self.expectationSerial!==serial)return;
  self.expectationBusy=false;self.expected=!!data.expected;
  self.expectationNotice=self.expected?'你的期待已记下，雾中的旧镇正在慢慢显现。':'未能记录，请点击重试';
 },function(err){
  if(self.account.data.playerId!==id||self.expectationSerial!==serial)return;
  self.expectationBusy=false;
  self.expectationNotice=err.status===401?'登录已过期，点击期待重新登录':err.status===404?'期待功能尚未开放，请稍后再试':'没能送出期待，请检查网络后重试';
 });
};

module.exports=Adventure;
