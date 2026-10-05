'use strict';
/*
 * 兜底冒烟：**每个界面的每个按钮都点一遍，不许抛异常**。
 *
 * 为什么需要这个（2026-10 真机报障"卡片点击刷新没有用，卡住了"）：
 *   那次重构删掉了一个函数，而某个界面的**一条点击路径**还在调它 ——
 *   点下去就抛 TypeError、整帧 update 中断、界面卡死。
 *   18 个断言当时全绿：因为它们各自只走自己那条路（而且 grep 显示**没有任何测试点过刷新键**）。
 *   单个功能的测试永远补不全这种洞，所以这里用"穷举点击"的方式兜一层：
 *   凡是游戏自己吐出来的按钮矩形（titleRects / cardRects / rankRects / ...），
 *   挨个点一次，任何一处抛异常都算 FAIL，并报出**哪个状态、哪个按钮**。
 *
 * ⚠️ 判据只是"不许抛异常"：这是底线测试，不替代各功能自己的断言（数值/文案/版式各测各的）。
 * ⚠️ 每个按钮都**重开一局**再点：避免"点 A 进了另一个界面导致 B 点不到"这种串场。
 */
const assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config'), Game = require(root + '/core/game'), deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) deps[k] = require(root + '/core/' + f);
let seed = 424242;
Math.random = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/** 干净的局：不刷怪、不落盘、金钱够用 */
function make() {
  const g = new Game(cfg, deps);
  g.setViewport(812, 375);
  g.world.rocks.length = 0; g.world.walls.length = 0;
  g.spawnFoe = function () {}; g.updateSpawns = function () {};
  g.saveNow = function () {};                 // 冒烟不入存档（免得污染真机/别的测试的读档）
  g.player.gold = 500;
  return g;
}

/** 把游戏摆到指定状态（字段名照 game.js 里的实际用法写，别猜方法名） */
const setups = {
  title: function (g) { g.state = 'title'; },
  play: function (g) { g.startRun(); g.state = 'play'; },
  levelup: function (g) { g.startRun(); g.state = 'play'; g.player.pendingLevels = 1; g.openLevelUp(); },
  bag: function (g) { g.startRun(); g.state = 'play'; g.player.bag = [g.player.equip.weapon]; g.openBag(); },
  settings: function (g) { g.state = 'title'; g.settingsOpen = true; },
  info: function (g) { g.state = 'title'; g.infoOpen = 'intro'; g.infoPage = 0; },
  rank: function (g) { g.state = 'title'; g.rankOpen = true; },
  dead: function (g) { g.startRun(); g.state = 'play'; g.player.hp = 0; g.player.dead = true; g.gameOver && g.gameOver(); g.state = 'dead'; },
  clear: function (g) { g.startRun(); g.nextStage(); },
  loadout: function (g) { g.state = 'title'; g.loadoutOpen = true; },
  codex: function (g) { g.state = 'title'; g.openCodex(); },
  training: function (g) { g.setTraining(true); },
  trialcards: function (g) { g.openTrialCards(); }
};

/** 收集这个状态下所有"能点的东西"（矩形数组/对象/嵌套对象都拍平） */
function collectRects(g, deep) {
  const out = [];
  const names = ['titleRects', 'cardRects', 'bagRects', 'settingsRects', 'infoRects', 'rankRects',
    'deadRects', 'pauseRects', 'loadoutRects', 'skillPanelRects', 'trialCardPanelRects', 'trainingRects',
    'codexRects'];
  for (const n of names) {
    if (typeof g[n] !== 'function') continue;
    let v;
    try { v = g[n](); } catch (e) { throw new Error('取 ' + n + '() 时抛异常：' + e.message); }
    const walk = function (o, tag) {
      if (!o) return;
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, tag + '[' + i + ']')); return; }
      if (typeof o !== 'object') return;
      if (typeof o.x === 'number' && typeof o.y === 'number' && typeof o.w === 'number') {
        out.push({ tag: n + tag, x: o.x + o.w / 2, y: o.y + o.h / 2, label: o.label || o.id || '' });
        return;
      }
      for (const k in o) walk(o[k], tag + '.' + k);
    };
    walk(v, '');
  }
  /* 不在 Rects 里、但确定存在的几个按钮 */
  /* ⚠️ bagBtnRect 已废弃（2026-10 左下角武器库按钮删除）—— 别再往这里加回来，
     「换武器」入口在暂停面板里（verify-skill-drop 有断言）。 */
  const singles = { 'rerollBtnRect': '刷新', 'pauseBtnRect': '暂停', 'frenzyRect': '狂热' };
  for (const n in singles) {
    if (typeof g[n] !== 'function') continue;
    try { const r = g[n](); if (r && typeof r.x === 'number') out.push({ tag: n, x: r.x + r.w / 2, y: r.y + r.h / 2, label: singles[n] }); }
    catch (e) { throw new Error('取 ' + n + '() 时抛异常：' + e.message); }
  }
  void deep;
  return out;
}

let tapped = 0;
for (const state in setups) {
  /* 先看这个状态有没有按钮可点（没有就跳过，不算失败） */
  const probe = make();
  setups[state](probe);
  const rects = collectRects(probe, true);
  assert(rects.length > 0, state + ' 状态下没有任何按钮矩形可点（Rects 是不是写崩了）');
  for (const r of rects) {
    const g = make();
    setups[state](g);
    g.cardGuard = 0; g.bagGuard = 0;
    /* 点它：**任何异常都算失败**，并把状态和按钮名报出来（这就是当初那个洞的形状） */
    try {
      g.update(1 / 60, { tap: { x: r.x, y: r.y } });
      for (let i = 0; i < 3; i++) g.update(1 / 60, {});      // 再跑几帧：有些崩溃在"点完之后的下一帧"
    } catch (e) {
      assert.fail('点【' + state + '】的【' + r.tag + ' ' + r.label + '】(x=' + Math.round(r.x) + ',y=' + Math.round(r.y)
        + ') 抛异常 → 界面会卡死：' + e.message);
    }
    tapped++;
  }
}

/* 再随手跑一段真实循环：随机移动 + 随机点，任何一帧抛异常都算失败 */
{
  const g = make();
  g.startRun();
  let s2 = 99;
  const rnd = function () { s2 = (s2 * 1103515245 + 12345) % 2147483648; return s2 / 2147483648; };
  try {
    for (let i = 0; i < 1800; i++) {                       // 30 秒（60fps）
      const inp = { moveX: rnd() < 0.6 ? (rnd() < 0.5 ? -1 : 1) : 0, moveY: rnd() < 0.4 ? (rnd() < 0.5 ? -1 : 1) : 0 };
      if (rnd() < 0.02) inp.tap = { x: rnd() * 812, y: rnd() * 375 };
      if (i % 240 === 0) g.player.pendingLevels = 1;       // 逼它弹升级面板
      g.update(1 / 60, inp);
    }
  } catch (e) {
    assert.fail('随机操作跑到第 ' + '若干' + ' 帧时抛异常（状态 ' + g.state + '）：' + e.message);
  }
}

console.log('PASS: 冒烟兜底 —— ' + Object.keys(setups).length + ' 个界面共 ' + tapped + ' 个按钮全部点过，无异常；'
  + '另加 1800 帧随机操作（含升级面板弹出）无异常');
