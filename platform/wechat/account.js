'use strict';
var KEY='kdtl-account-v1';
function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:(r&3)|8).toString(16);});}
function Account(wx){
 this.wx=wx;this.ready=false;this.busy=false;this.message='';this.conflict=null;this.nextSync=0;
 try{this.data=wx.getStorageSync(KEY)||{};}catch(_){this.data={};}
 if(typeof this.data!=='object')this.data={};
}
Account.prototype.persist=function(){try{this.wx.setStorageSync(KEY,this.data);}catch(_){this.message='本机存储失败，请保持网络连接';}};
Account.prototype.request=function(path,method,body){var self=this;return new Promise(function(resolve,reject){
 try{self.wx.request({url:'https://eat.guozeshui.top/api/game-account/'+path,method:method,timeout:15000,
 header:{'Content-Type':'application/json','Accept':'application/json',Authorization:self.data.token?'Bearer '+self.data.token:''},data:body,
 success:function(r){if(r.statusCode>=200&&r.statusCode<300&&r.data&&r.data.data)resolve(r.data.data);else{if(r.statusCode===401)self.ready=false;var label=path==='login'?'登录接口':path==='onboarding'?'存档初始化':'云存档';var message=r.data&&r.data.message||'服务暂时不可用';if(r.statusCode===404)message='接口尚未部署，请更新服务器';if(r.statusCode>=500&&!(r.data&&r.data.message))message='服务器处理失败，请检查服务日志';reject({status:r.statusCode,message:label+'（'+r.statusCode+'）：'+message,data:r.data&&r.data.data});}},
 fail:function(err){var msg=err&&err.errMsg||'';reject({message:/domain|url not in/i.test(msg)?'请求域名未允许，请配置 eat.guozeshui.top 为 request 合法域名':/timeout/i.test(msg)?'连接服务器超时，请重试':'无法连接登录服务器，请检查网络及 request 合法域名'});}});}catch(_){reject({message:'网络接口暂时不可用'});}
});};
Account.prototype.accept=function(info){
 if(this.data.playerId&&this.data.playerId!==info.player_id){try{this.wx.setStorageSync('kdtl-account-backup-'+this.data.playerId,this.data.latest||this.data.pending&&this.data.pending.payload||null);}catch(_){}this.data.pending=null;this.data.latest=null;this.data.revision=0;}
 if(info.token)this.data.token=info.token;
 this.data.playerId=info.player_id;this.ready=true;this.persist();return info;
};
Account.prototype.restore=function(){var self=this;if(!this.data.token)return Promise.reject({message:'请微信登录'});return this.request('me','GET').then(function(info){return self.accept(info);});};
Account.prototype.loginBody=function(code){var body={code:code};try{var info=this.wx.getAccountInfoSync&&this.wx.getAccountInfoSync();if(info&&info.miniProgram&&info.miniProgram.appId)body.client_appid=info.miniProgram.appId;}catch(_){}return body;};
Account.prototype.login=function(){var self=this;return new Promise(function(resolve,reject){
 if(!self.wx.login)return reject({message:'请在微信中登录'});
 self.wx.login({success:function(r){if(!r.code)return reject({message:'未获得微信登录凭证'});self.request('login','POST',self.loginBody(r.code)).then(function(info){resolve(self.accept(info));},reject);},fail:function(err){reject({message:'微信登录未完成：'+(err&&err.errMsg||'请重试')});}});
});};
Account.prototype.initialize=function(source,payload){return this.request('onboarding','POST',{source:source,payload:payload});};
Account.prototype.setCloud=function(save){this.data.revision=save.revision;this.data.latest=null;this.data.pending=null;this.conflict=null;this.persist();};
Account.prototype.queue=function(payload){
 if(!this.data.playerId)return;
 var text=JSON.stringify(payload);
 if(this.data.latest&&JSON.stringify(this.data.latest)===text)return;
 if(!this.data.pending&&!this.data.latest&&this.lastSynced===text)return;
 this.data.latest=JSON.parse(text);this.persist();
};
Account.prototype.sync=function(force){
 var self=this;
 if(!this.ready||this.busy||this.conflict||!this.data.latest&&!this.data.pending||(!force&&Date.now()<this.nextSync))return Promise.resolve();
 if(!this.data.pending)this.data.pending={revision:this.data.revision,request_id:uuid(),payload:this.data.latest};
 this.persist();this.busy=true;this.message='正在保存进度';
 return this.request('save','PUT',this.data.pending).then(function(res){
  var sent=JSON.stringify(self.data.pending.payload);self.data.revision=res.revision;self.lastSynced=sent;
  if(JSON.stringify(self.data.latest)===sent)self.data.latest=null;
  self.data.pending=null;self.message='云存档已同步';
 },function(err){
  self.message=err.message;
  if(err.status===409&&err.data)self.conflict=err.data;
 }).then(function(){self.busy=false;self.nextSync=Date.now()+15000;self.persist();});
};
Account.prototype.keepLocal=function(){if(!this.conflict)return;this.data.revision=this.conflict.revision;this.data.pending=null;this.conflict=null;this.persist();return this.sync(true);};
module.exports=Account;
