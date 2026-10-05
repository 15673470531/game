'use strict';
var Rules=require('./rules');
// Friend identities and cloud records stay inside the open-data context.
function createBoard(wx){
 var canvas=wx.getSharedCanvas(),ctx=canvas.getContext('2d'),KEY=Rules.KEY;
 var W=600,H=180,rows=[],own=null,page=0,status='正在读取好友成绩…',busy=false,pending=null,visible=false,images={},fetchId=0,friendRows=[],friendsOK=false,localBest=null,cloudOwn=null,selfIds={},profile=null;
 var valid=Rules.valid,errors={};
 var apiLabels={getUserCloudStorage:'个人读取',setUserCloudStorage:'成绩上传',getFriendCloudStorage:'好友读取'};
 function errorText(name,err){var code=err.errCode!=null?err.errCode:err.errcode!=null?err.errcode:err.code;var message=String(err.errMsg||err.message||'未知错误').replace(/[\r\n]+/g,' ').replace(name+':fail','').trim();return apiLabels[name]+'失败'+(code!=null?' ['+code+']':'')+'：'+message;}
 function footer(){var names=Object.keys(errors);return names.length?names.map(function(n){return errors[n];}).join('；'):status;}
 function parse(list){try{var pair=(list||[]).find(function(k){return k.key===KEY;});var v=pair&&JSON.parse(pair.value);return valid(v)?v:null;}catch(e){return null;}}
 function time(ms){return Math.floor(ms/60000)+':'+('0'+Math.floor(ms%60000/1000)).slice(-2)+'.'+Math.floor(ms%1000/100);}
 function text(s,x,y,color,size){ctx.fillStyle=color||'#dce5df';ctx.font=(size||13)+'px PingFang SC, sans-serif';ctx.fillText(s,x,y);}
 function avatar(url,x,y){ctx.fillStyle='#3a514c';ctx.fillRect(x,y,26,26);if(!url)return;var entry=images[url];if(entry&&entry.ready){ctx.drawImage(entry.img,x,y,26,26);return;}if(entry)return;
   var img=wx.createImage();images[url]={img:img};img.onload=function(){images[url].ready=true;draw();};img.onerror=function(){images[url].failed=true;};img.src=url;
 }
 function rebuild(){
   own=cloudOwn;
   if(localBest&&(!own||Rules.compare(localBest,own)<0))own=localBest;
   var unsynced=!!(own&&(!cloudOwn||Rules.compare(own,cloudOwn)<0));
   rows=friendRows.filter(function(row){return !selfIds[row.score.runId]&&!(profile&&profile.openid&&row.openid===profile.openid);});
   if(own)rows.push({nickname:profile&&profile.nickname||'我',avatarUrl:profile&&profile.avatarUrl,score:own,self:true,unsynced:unsynced});
   rows.sort(function(a,b){return Rules.compare(a.score,b.score);});
   var rank=0,last=null,confirmed=0;rows.forEach(function(row){
     if(row.unsynced||!friendsOK){row.rank='—';return;}
     confirmed++;if(!last||Rules.compare(row.score,last)!==0){rank=confirmed;last=row.score;}row.rank=rank;
   });
 }
 function remember(score){if(valid(score)){selfIds[score.runId]=true;if(!localBest||Rules.compare(score,localBest)<0)localBest=score;}}
 function selfProfile(){
   if(profile||typeof wx.getUserInfo!=='function')return;
   try{wx.getUserInfo({openIdList:['self'],success:function(res){var p=res.data&&res.data[0];if(!p)return;profile={openid:p.openId||p.openid,nickname:p.nickName||p.nickname,avatarUrl:p.avatarUrl};rebuild();draw();},fail:function(){}});}catch(e){}
 }
 function draw(){if(!visible)return;ctx.clearRect(0,0,W,H);ctx.fillStyle='#12232b';ctx.fillRect(0,0,W,H);ctx.textBaseline='middle';ctx.textAlign='left';
   var count=Math.max(1,Math.floor((H-72)/36)),pages=Math.max(1,Math.ceil(rows.length/count));page=Math.max(0,Math.min(page,pages-1));
   text('名次',10,13,'#91a9a4',11);text('好友',80,13,'#91a9a4',11);text('最佳成绩 / 用时',W-230,13,'#91a9a4',11);
   if(!rows.length)text(status.indexOf('失败')>=0?'暂时无法读取好友榜':'暂无好友挑战记录，完成一次挑战即可上榜',12,48,'#b9cac4',12);
   rows.slice(page*count,(page+1)*count).forEach(function(row,i){var y=28+i*36,me=!!row.self;if(me){ctx.fillStyle='#34402a';ctx.fillRect(4,y,W-8,34);}text(''+row.rank,12,y+17,me?'#ffd166':null);avatar(row.avatarUrl,42,y+4);text((row.nickname||'微信玩家').slice(0,9)+(me?'（我）':''),80,y+17,me?'#ffd166':null);text(Rules.label(row.score),W-230,y+10,me?'#ffd166':null,11);text(time(row.score.ms)+(row.unsynced?' · 本机成绩，待同步':''),W-230,y+25,'#94aaa5',10);});
   var me=rows.find(function(row){return row.self;});
   text(own?'我的最佳 '+Rules.label(own)+' · '+time(own.ms)+' · '+(me&&me.unsynced?'待同步':me&&me.rank!=='—'?'第 '+me.rank+' 名':'名次待刷新'):'我的最佳：暂无挑战记录',12,H-31,'#ffd166',12);
   var detail=footer(),limit=W-24;if(ctx.measureText){while(detail.length>1&&ctx.measureText(detail).width>limit)detail=detail.slice(0,-2)+'…';}text(detail,12,H-12,'#93aaa4',11);ctx.textAlign='right';text((page+1)+' / '+pages,W-10,H-31,'#93aaa4',11);ctx.textAlign='left';
 }
 function call(name,args,done){var ended=false,timer=setTimeout(function(){end({errCode:'TIMEOUT',errMsg:'10秒内未收到微信响应'});},10000);
   function end(err,res){if(ended)return;ended=true;clearTimeout(timer);
     if(err){errors[name]=errorText(name,err);if(typeof console!=='undefined'&&console.warn)console.warn('[好友榜] '+name+' '+errors[name]);}
     else delete errors[name];
     done(err,res);
   }
   if(typeof wx[name]!=='function'){end({errCode:'UNAVAILABLE',errMsg:'当前环境不支持此接口'});return;}
   try{wx[name](Object.assign({},args,{success:function(res){end(null,res||{});},fail:function(err){end(err||{errMsg:'微信未返回错误详情'});}}));}catch(e){end(e);}
 }
 function fetch(){var id=++fetchId;call('getFriendCloudStorage',{keyList:[KEY]},function(err,res){if(id!==fetchId)return;if(err){friendsOK=false;friendRows=[];status=own?'好友成绩读取失败，个人记录已显示；点击刷新':'好友成绩读取失败；点击刷新重试';rebuild();draw();return;}
   friendsOK=true;friendRows=(res.data||[]).map(function(row){return {openid:row.openid,nickname:row.nickname,avatarUrl:row.avatarUrl,score:parse(row.KVDataList)};}).filter(function(row){return !!row.score;});
   rebuild();
   draw();
 });}
 function sync(score){remember(score);rebuild();draw();if(valid(score)&&(!pending||Rules.compare(score,pending)<0))pending=score;if(busy)return;busy=true;var candidate=pending;pending=null;
   status='正在同步个人最佳…';draw();
   call('getUserCloudStorage',{keyList:[KEY]},function(err,res){if(err){finish('成绩同步失败，已保留本机记录；点击刷新重试');return;}
     cloudOwn=parse(res.KVDataList);if(cloudOwn)selfIds[cloudOwn.runId]=true;rebuild();
     if(!candidate||(cloudOwn&&Rules.compare(cloudOwn,candidate)<=0)){finish('已同步 · 同时间并列');return;}
     var payload=Object.assign({},candidate,{wxgame:{score:Rules.packed(candidate),update_time:Math.floor(Date.now()/1000)}});
     call('setUserCloudStorage',{KVDataList:[{key:KEY,value:JSON.stringify(payload)}]},function(writeErr){if(writeErr){finish('成绩上传失败，已保留本机记录；点击刷新重试');return;}cloudOwn=payload;selfIds[payload.runId]=true;finish('最佳成绩已上传 · 同时间并列');});
   });
 }
 function finish(message){busy=false;status=message;rebuild();draw();if(visible)fetch();if(pending)sync(pending);}
 function message(m){if(!m||m.key!==KEY)return;
   if(m.type==='show'){visible=true;W=Math.max(260,Math.min(1600,m.width||600));H=Math.max(100,Math.min(1000,m.height||180));page=0;remember(m.score);rebuild();draw();selfProfile();sync(m.score);}
   if(m.type==='submit'&&valid(m.score))sync(m.score);
   if(m.type==='page'){page+=m.delta>0?1:-1;draw();}
   if(m.type==='hide')visible=false;
 }
 wx.onMessage(message);return {message:message,parse:parse,valid:valid};
}
if(typeof wx!=='undefined')createBoard(wx);
if(typeof module!=='undefined')module.exports=createBoard;
