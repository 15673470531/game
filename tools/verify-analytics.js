'use strict';
const assert = require('assert');
const cfg = require('../core/config'), Game = require('../core/game');
const Analytics = require('../platform/wechat/analytics');
const Storage = require('../platform/wechat/storage');
const deps = {World:require('../core/world'), Entities:require('../core/entities'),
  Progression:require('../core/progression'), Save:require('../core/save')};
function setup(options={}) {
  const values=options.values||{}, sent=[];
  const wx={getStorageSync:k=>values[k],setStorageSync:(k,v)=>{values[k]=v;},
    getAccountInfoSync:()=>({miniProgram:{envVersion:options.env||'release'}}),
    getSystemInfoSync:()=>({platform:'ios'}),
    request:o=>{if(options.fail)throw Error('offline'); o.data.events.forEach(data=>sent.push({name:data.event_name,data}));o.success({statusCode:200,data:{code:0,data:{acknowledged:o.data.events.map(e=>({run_id:e.run_id,seq:e.seq}))}}});}};
  if(options.unsupported)delete wx.request;
  const a=new Analytics(wx,{reportingEnabled:options.enabled!==false,build:'test',endpoint:cfg.analytics.endpoint});
  const track=a.track; a.track=function(){a.retryAt=0;track.apply(a,arguments);a.flush();};
  const g=new Game(cfg,Object.assign({},deps,{storage:new Storage(wx),analytics:a}));
  g.setViewport(812,375);g.toTitle({keep:false});
  return {g,a,sent,values,wx};
}
const count=(s,e)=>s.sent.filter(r=>r.name==='kdtl_'+e).length;
// Only an explicit start is an entry; real death panel decisions create a separate run.
{
 const s=setup(),g=s.g;assert.equal(s.sent.length,0);g.startRun(false);
 const id=g.analyticsRun.id;assert.equal(count(s,'run_start'),1);
 g.elapsed=43;g.advanceTrialWave();assert.equal(count(s,'wave_complete'),1);
 assert.equal(s.sent.find(e=>e.name==='kdtl_wave_complete').data.wave,1);
 g.player.inv=0;g.hurtPlayer(99999,g.player.x+10,g.player.y,{type:'charger'});
 assert.equal(count(s,'run_death'),1);assert.equal(s.sent[s.sent.length-1].data.detail,'charger');
 g.track('run_death');assert.equal(count(s,'run_death'),1);
 const b=g.deadRects().rows.find(r=>r.id==='again');g.updateDeadPanel({tap:{x:b.x+2,y:b.y+2}});
 assert.equal(count(s,'settle_action'),1);assert.equal(count(s,'run_start'),2);
 assert.notEqual(g.analyticsRun.id,id);assert.equal(s.sent[s.sent.length-1].data.previous_run_id,id);
}
// Persist run identity, sequence and wave dedup across a cold restart; legacy saves aren't new users/runs.
{
 const s=setup();s.g.startRun(false);s.g.advanceTrialWave();s.g.toTitle();
 const t=setup({values:s.values});t.g.startRun(true);
 assert.equal(count(t,'run_start'),0);assert.equal(count(t,'run_resume'),1);
 assert.equal(t.g.analyticsRun.id,s.sent[0].data.run_id);
 t.g.wave=1;t.g.track('wave_complete');assert.equal(count(t,'wave_complete'),0);
 const snap=deps.Save.snapshot(t.g,true);delete snap.run.analyticsRun;
 t.g.resumeData=snap;t.g.startRun(true);assert.equal(t.sent[t.sent.length-1].data.detail,'legacy_or_migrated');
}
// Completing three waves reports each once; successful exit isn't an abandonment/death.
{
 const s=setup(),g=s.g;g.startRun(false);g.advanceTrialWave();g.advanceTrialWave();g.stageClear();
 g.track('run_complete');assert.equal(count(s,'run_complete'),1);assert.equal(count(s,'wave_complete'),3);
 g.updateClear(10);g.updateClearPanel(10,{tap:{x:400,y:200}});
 assert.equal(count(s,'settle_action'),1);assert.equal(s.sent[s.sent.length-1].data.detail,'home');
 assert.equal(count(s,'run_death'),0);assert.equal(count(s,'run_leave'),0);
}
// Background events do not claim a death or restart, time comes from active game simulation.
{
 const s=setup();s.g.startRun(false);s.g.elapsed=12;
 s.g.track('app_hide',{detail:s.g.state});s.g.pause();s.g.saveNow();s.g.track('app_show',{detail:s.g.state});
 assert.equal(count(s,'run_death'),0);assert.equal(count(s,'run_start'),1);
 assert.equal(s.sent[s.sent.length-1].data.seconds,12);
}
// Test marking is per-device, survives process restarts and cannot leak the remainder of a test run.
{
 const s=setup();s.a.setTestDevice(true);s.g.startRun(false);assert.equal(s.sent.length,0);
 const t=setup({values:s.values});assert(t.a.status().testDevice);
 s.a.setTestDevice(false);s.g.advanceTrialWave();assert.equal(s.sent.length,0);
 s.g.startRun(false);assert.equal(count(s,'run_start'),1);
 s.g.setTraining(true);s.g.track('run_complete');assert.equal(count(s,'run_complete'),0);
}
// Transport/config/storage failures never break play; request failures never produce a delivery receipt.
for(const options of [{fail:true},{unsupported:true},{enabled:false}]) {
 const s=setup(options);s.g.startRun(false);s.g.advanceTrialWave();
 assert.equal(s.g.wave,2);assert.equal(s.sent.length,0);assert.equal(s.a.status().acknowledged,0);
 assert(s.a.recent.length>=2);
}
{
 const s=setup();s.wx.setStorageSync=()=>{throw Error('full');};
 assert.equal(s.a.setTestDevice(true).testFlagPersisted,false);
 s.g.startRun(false);assert.equal(s.sent.length,0);
 for(let i=0;i<150;i++)s.g.track('app_show');assert.equal(s.a.recent.length,100);
}
// Hidden settings gesture opens a cancellable device-local switch, no layout/button changes.
{
 const s=setup();let dialog;
 s.wx.showModal=o=>{dialog=o;};
 const panel=s.g.settingsRects().panel,p={x:panel.x+panel.w/2,y:panel.y+20};
 for(let i=0;i<4;i++)s.g.updateSettingsPanel(p);assert(!dialog);
 s.g.updateSettingsPanel(p);assert(dialog);dialog.success({confirm:false});dialog.complete();
 assert.equal(s.a.testDevice,false);
 for(let i=0;i<5;i++)s.g.updateSettingsPanel(p);
 dialog.success({confirm:true});dialog.complete();assert.equal(s.a.testDevice,true);
}
console.log('Analytics: lifecycle, persistence, dedup, exclusion, failure handling passed.');
