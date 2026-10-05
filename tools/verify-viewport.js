'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..'),Touch=require(root+'/platform/wechat/input');
let touchStart;
const input=new Touch({onTouchStart:f=>touchStart=f,onTouchMove(){},onTouchEnd(){},onTouchCancel(){}},{width:375,height:812});
const originalScreen=input.screen;
let info={windowWidth:375,windowHeight:812,pixelRatio:3,safeArea:{left:0,top:44,width:375,height:734}},resize,show,rankRefresh=0;
const transforms=[];
const state={wx:{getWindowInfo:()=>info,onWindowResize:f=>resize=f,onHide(){},onShow:f=>show=f,
  getMenuButtonBoundingClientRect:()=>({width:87,height:32,top:8,bottom:40,left:718,right:805})},input,
 W:375,H:812,dpr:2,insets:{top:44,left:0,right:0,bottom:34},canvas:{width:750,height:1624},ctx:{setTransform(...v){transforms.push(v);}},
 renderer:{resize(w,h){this.w=w;this.h=h;},setInsets(v){this.insets=v;},setMenuReserve(r){this.menuReserve=r;}},
 game:{setViewport(w,h,v){this.viewport={w,h,insets:v};},setMenuReserve(r){this.menuReserve=r;},rankOpen:true,ranking:{show(){rankRefresh++;}},rankRects(){return{list:{}};}},last:500};
const src=fs.readFileSync(root+'/game.js','utf8');const section=src.slice(src.indexOf('function syncViewport(size)'),src.indexOf('/* 5) 主循环 */'));
vm.runInNewContext(section,state);
resize({size:{windowWidth:812,windowHeight:375}});assert.equal(state.renderer.w,812);assert.equal(state.game.viewport.insets.bottom,0);assert.equal(input.screen,originalScreen);
// 右上角微信原生胶囊（⋯／⊙）：量到 bottom=40 → 避让高度 48（下移到胶囊下面），核心层和渲染层都要拿到
assert.equal(state.game.menuReserve.top,48);assert.equal(state.renderer.menuReserve.top,48);
info={windowWidth:812,windowHeight:375,pixelRatio:3,safeArea:{left:44,top:0,width:724,height:354}};
show();assert.equal(state.last,0);assert.equal(state.canvas.width,1624);assert.equal(state.canvas.height,750);assert.equal(state.game.viewport.insets.right,44);assert.equal(input.safeBottom,21);assert.equal(input.btnDash.y,258);assert(rankRefresh>0);
touchStart({changedTouches:[{identifier:1,clientX:300,clientY:150}]});assert(input.stick.active,'touch closure must see resized half-screen');
show();assert(!input.stick.active);assert(!input.tap);
// Cached surface backing-size loss is repaired even if logical dimensions are unchanged.
state.canvas.width=300;state.canvas.height=150;show();assert.equal(state.canvas.width,1624);assert.equal(state.canvas.height,750);assert.deepEqual(transforms[transforms.length-1],[2,0,0,2,0,0]);
const refreshes=rankRefresh;show();assert.equal(rankRefresh,refreshes,'unchanged layout should not refetch the board');
// 老基础库/开发者工具拿不到胶囊 API → 避让 0，版式回到改动前（不能凭空多出一块空白）
delete state.wx.getMenuButtonBoundingClientRect;show();
assert.equal(state.game.menuReserve.top,0);assert.equal(state.renderer.menuReserve.top,0);
console.log('PASS: orientation race, warm resume, safe areas, renderer/game/touch agreement, stale touches, restored backing canvas and non-accumulating DPR');
