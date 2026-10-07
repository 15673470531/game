'use strict';
const assert=require('assert'),Account=require('../platform/wechat/account');
(async()=>{
 const values={},calls=[];let fail=true,conflict=false;
 const wx={getStorageSync:k=>values[k],setStorageSync:(k,v)=>values[k]=JSON.parse(JSON.stringify(v)),request:o=>{calls.push(JSON.parse(JSON.stringify(o.data)));if(fail)o.fail();else if(conflict)o.success({statusCode:409,data:{message:'conflict',data:{revision:8,payload:{gold:80}}}});else o.success({statusCode:200,data:{data:{revision:o.data.revision+1}}});}};
 let a=new Account(wx);a.data={playerId:1,token:'test',revision:1};a.ready=true;
 const payload={gold:3,equip:{weapon:null}};a.queue(payload);payload.gold=100;assert.equal(a.data.latest.gold,3,'queued snapshot must not mutate');
 await a.sync(true);const requestId=a.data.pending.request_id;assert(requestId);assert.equal(a.data.revision,1);
 a=new Account(wx);a.ready=true;fail=false;await a.sync(true);assert.equal(calls[1].request_id,requestId,'retry retains idempotency key');assert.equal(a.data.revision,2);assert.equal(a.data.pending,null);
 a.ready=false;a.queue({gold:4});assert.equal(a.data.latest.gold,4,'expired session still keeps changes');a.ready=true;conflict=true;await a.sync(true);assert.equal(a.conflict.revision,8);assert.equal(a.data.pending.payload.gold,4);
 conflict=false;await a.keepLocal();assert.equal(a.data.revision,9);assert.equal(a.data.pending,null);
 a.queue({gold:5});a.accept({player_id:2,token:'other'});assert.equal(values['kdtl-account-backup-1'].gold,5);assert.equal(a.data.latest,null);
 const loginWx={getStorageSync:()=>null,setStorageSync:()=>{},getAccountInfoSync:()=>({miniProgram:{appId:'client-app'}}),login:o=>o.success({code:'fresh-code'}),request:o=>{assert.equal(o.data.client_appid,'client-app');assert.equal(o.data.code,'fresh-code');o.success({statusCode:422,data:{message:'微信登录校验未通过（错误码 40029）'}});}};await assert.rejects(new Account(loginWx).login(),e=>e.message.includes('登录接口（422）')&&e.message.includes('40029'));
 console.log('Account: immutable queue, restart/retry, expired session, conflicts and account-switch backup passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
