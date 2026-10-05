'use strict';
var Rules=require('../../core/rank-rules');
var KEY=Rules.KEY,LOCAL=KEY+'_local';
function Ranking(wx){this.wx=wx;this.context=null;this.best=null;this.error='';try{this.best=wx.getStorageSync(LOCAL)||null;}catch(e){}if(!Rules.valid(this.best))this.best=null;}
Ranking.prototype.init=function(){if(this.context)return true;try{var context=this.wx.getOpenDataContext();if(!context||!context.canvas)throw Error('unsupported');this.context=context;return true;}catch(e){this.error='好友榜暂不可用，请用手机微信打开后重试';return false;}};
Ranking.prototype.post=function(msg){if(!this.init())return;msg.key=KEY;try{this.context.postMessage(msg);}catch(e){this.error='好友榜加载失败，请点击刷新';}};
Ranking.prototype.submit=function(result){
 var score=Object.assign({},result,{runId:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),at:Date.now(),weapon:result.weapon||'sword'});
 if(!Rules.valid(score))return {ms:score.ms,text:'本次成绩无效'};
 var previous=this.best,improved=!previous||Rules.compare(score,previous)<0;
 if(improved){this.best=score;try{this.wx.setStorageSync(LOCAL,this.best);}catch(e){}}
 this.post({type:'submit',score:this.best});
 var message=improved?'刷新本机最佳 · '+Rules.label(score):'未超过本机最佳 · '+Rules.label(score);
 if(improved&&previous&&score.stage===previous.stage&&score.milestone===previous.milestone&&score.progress===previous.progress)message='刷新本机最佳 · 快了 '+((previous.ms-score.ms)/1000).toFixed(1)+' 秒';
 return {ms:score.ms,score:score,text:message};
};
Ranking.prototype.show=function(rect){
 this.error='';if(!this.init())return;
 var width=Math.max(260,Math.min(1600,Math.round(rect.w)||600)),height=Math.max(100,Math.min(1000,Math.round(rect.h)||180));
 // WeChat sharedCanvas dimensions must be set in the main context, before drawing in the open-data context.
 try{var canvas=this.context.canvas;if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;}
 catch(e){this.error='好友榜画布初始化失败，请重新打开游戏';return;}
 this.post({type:'show',width:width,height:height,score:this.best});
};
Ranking.prototype.page=function(delta){this.post({type:'page',delta:delta});};
Ranking.prototype.draw=function(ctx,rect){if(this.context&&!this.error){ctx.drawImage(this.context.canvas,rect.x,rect.y,rect.w,rect.h);}else{ctx.fillStyle='#c8d3ce';ctx.font='13px sans-serif';ctx.fillText(this.error||'正在准备好友榜…',rect.x+12,rect.y+28);}};
module.exports=Ranking;
