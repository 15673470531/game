'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),Audio=require('../platform/wechat/audio');
const calls=[],fake={play:(key,gain)=>calls.push({key,gain}),swingMode:'onHit',vibrate:false,wx:{}};
Audio.prototype.handle.call(fake,['entranceRumble','entranceWell','entranceDoor','entranceStone','entranceBreak'].map(type=>({type})));
assert.equal(calls.length,5);
for(const call of calls){assert(call.gain>0&&call.gain<1);const data=fs.readFileSync(path.join(__dirname,'../assets/audio',call.key+'.wav'));assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WAVE');assert(data.length>1000);}
console.log('Entrance sound mapping, volume and packaged WAV files passed.');
