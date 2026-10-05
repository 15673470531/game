'use strict';
var KEY='kdtl_friend_progress_v2';
function valid(s){return !!(s&&s.v===2&&Number.isInteger(s.stage)&&s.stage>=1&&s.stage<=4&&Number.isInteger(s.milestone)&&s.milestone>=0&&s.milestone<=1&&Number.isInteger(s.progress)&&s.progress>=0&&s.progress<=1000&&Number.isInteger(s.ms)&&s.ms>0&&s.ms<=86400000&&typeof s.runId==='string'&&s.runId.length<100&&(s.stage!==1||s.milestone===0)&&(s.stage!==4||(s.milestone===0&&s.progress===0)));}
// Negative means a ranks ahead of b; stage first, elite/boss milestone, objective progress, active time.
function compare(a,b){return b.stage-a.stage||b.milestone-a.milestone||b.progress-a.progress||a.ms-b.ms;}
function time(ms){return Math.floor(ms/60000)+':'+('0'+Math.floor(ms%60000/1000)).slice(-2)+'.'+Math.floor(ms%1000/100);}
function label(s){if(s.stage===4)return '已通关';if(s.stage===3&&s.milestone)return '首领剩余 '+((1000-s.progress)/10).toFixed(1)+'%';return '第'+s.stage+'波 '+(s.progress/10).toFixed(1)+'%'+(s.stage===2?(s.milestone?' · 精英已击败':' · 精英未击败'):'');}
function packed(s){return ((s.stage*2+s.milestone)*1001+s.progress)*86400001+(86400000-s.ms);}
module.exports={KEY:KEY,valid:valid,compare:compare,time:time,label:label,packed:packed};
