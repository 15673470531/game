'use strict';
const assert=require('assert'),Analytics=require('../platform/wechat/analytics');
const config={reportingEnabled:true,build:'http-test',endpoint:'https://eat.guozeshui.top/api/game-analytics/events'};
function setup(values={},env='release'){
 const requests=[];
 const wx={getStorageSync:k=>JSON.parse(JSON.stringify(values[k]===undefined?null:values[k])),setStorageSync:(k,v)=>values[k]=JSON.parse(JSON.stringify(v)),getSystemInfoSync:()=>({platform:'ios'}),getAccountInfoSync:()=>({miniProgram:{envVersion:env}}),request:o=>requests.push(o)};
 const a=new Analytics(wx,config),g={stage:1,wave:1,elapsed:4,revives:0,weaponKind:()=> 'sword'};
 return {a,g,requests,values};
}
function ack(r,events=r.data.events){r.success({statusCode:200,data:{code:0,data:{acknowledged:events.map(e=>({run_id:e.run_id,seq:e.seq}))}}});}
{
 const s=setup();s.a.begin(s.g,false);const r=s.requests[0];
 assert.equal(r.data.events.length,1);assert.equal(r.data.events[0].test_device,0);
 assert(/^[0-9a-f-]{36}$/.test(r.data.player_id));assert(/Z$/.test(r.data.events[0].occurred_at));
 s.a.track(s.g,'wave_complete');s.a.flush();assert.equal(s.requests.length,1,'one request in flight');
 ack(r);assert.equal(s.a.queue.length,1);assert.equal(s.a.status().acknowledged,1);
 s.a.retryAt=0;s.a.flush();ack(s.requests[1]);assert.equal(s.a.queue.length,0);
}
{
 const s=setup();s.a.begin(s.g,false);const original=s.requests[0].data.events[0];
 s.requests[0].fail({errMsg:'offline'});assert.equal(s.a.queue.length,1);assert(s.a.retryAt>Date.now());
 s.a.flush();assert.equal(s.requests.length,1,'backoff');
 const t=setup(s.values);assert.equal(t.a.playerId,s.a.playerId);t.a.flush();
 assert.deepEqual(t.requests[0].data.events[0],original);ack(t.requests[0]);assert.equal(t.a.queue.length,0);
 // Old gameplay snapshot cannot reuse an acknowledged seq after process restart.
 const u=setup(t.values);u.g.analyticsRun={id:original.run_id,seq:0,seen:{}};u.a.begin(u.g,true);
 assert(u.g.analyticsRun.seq>original.seq);
}
{
 const s=setup({},'develop');s.a.begin(s.g,false);assert.equal(s.requests[0].data.events[0].test_device,1);
 ack(s.requests[0]);s.a.setTestDevice(true);s.a.begin(s.g,false);assert.equal(s.a.queue.length,0);
}
{
 const s=setup();s.a.begin(s.g,false);s.requests[0].success({statusCode:200,data:{code:0,data:{acknowledged:[{run_id:'unrelated',seq:1}]}}});
 assert.equal(s.a.queue.length,1);assert.equal(s.a.acknowledged,0);
 s.a.retryAt=0;s.a.track(s.g,'app_show');s.a.flush();
 s.requests[1].success({statusCode:422,data:{errors:{'events.0.occurred_at':['bad']}}});
 assert.equal(s.a.queue.length,1);assert.equal(s.a.dropped,1);
 s.a.retryAt=0;s.a.flush();ack(s.requests[2]);assert.equal(s.a.queue.length,0);
}
{
 const s=setup();s.a.begin(s.g,false);s.requests[0].fail({errMsg:'offline'});
 for(let i=0;i<250;i++)s.a.track(s.g,'app_show');assert.equal(s.a.queue.length,200);assert(s.a.dropped>0);
 s.a.queue[0].occurred_at='2000-01-01T00:00:00Z';s.a.prune();assert.equal(s.a.queue.length,199);
}
console.log('HTTP analytics passed: ACK, retry, persistence, sequence, test traffic, quarantine, bounds.');
