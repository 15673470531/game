'use strict';
const assert=require('assert'),Adventure=require('../core/adventure'),Game=require('../core/game'),cfg=require('../core/config');
const deps={World:require('../core/world'),Entities:require('../core/entities'),Progression:require('../core/progression'),Save:require('../core/save')};
(async()=>{
 const g=new Game(cfg,deps);g.setViewport(812,375);let calls=[],resolve,reject;
 const account={data:{playerId:1},ready:true,request:(path,method)=>{calls.push(method);return new Promise((ok,no)=>{resolve=ok;reject=no;});}};
 const a=new Adventure(g,account,{getStorageSync:()=>null});a.mode='chapters';
 a.loadExpectation();const lateRead=resolve;a.expectChapter();assert(a.expectationBusy);a.expectChapter();assert.equal(calls.length,2);assert(!a.expected);resolve({expected:true});await Promise.resolve();lateRead({expected:false});await Promise.resolve();assert(a.expected,'late GET must not undo successful PUT');assert(!a.expectationBusy);a.expectChapter();assert.equal(calls.length,2);
 a.loadExpectation();resolve({expected:false});await Promise.resolve();a.expectChapter();reject({status:500});await Promise.resolve();assert(!a.expected&&!a.expectationBusy);a.expectChapter();assert(a.expectationBusy);account.data.playerId=2;resolve({expected:true});await Promise.resolve();assert(!a.expected,'previous account response must be ignored');
 a.loadExpectation();resolve({expected:true});await Promise.resolve();assert(a.layout().buttons.find(b=>b.id==='expect').label.includes('已期待'));
 console.log('Expectation: server acknowledgement, dedup, retry, account isolation, late reads and button status passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
