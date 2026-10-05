/**
 * 核心层：世界（地图尺寸、地形生成、碰撞解算）
 * 纯逻辑：不知道画布，也不知道输入。
 *
 * 地形为什么用"胶囊"（带厚度的线段）而不是一列圆石：
 *   一列圆石拼出来的墙面是**扇贝形**的，怪撞上去会卡在石头缝里磨不出来
 *   （实测：怪在墙缝里原地磨了 120 帧、位置一动不动），玩家往墙后一躲就成了安全口袋。
 *   线段表面是平的 —— 撞上去只有"垂直于墙"的分量被抵消，切向分量保留，自然就沿墙滑行了。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.__GAME__ = root.__GAME__ || {}).World = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof window !== 'undefined' ? window : globalThis), function () {
  'use strict';

  /** 点到线段最近点的参数 t ∈ [0,1] */
  function closestT(px, py, seg) {
    var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    var L2 = dx * dx + dy * dy;
    if (L2 < 0.0001) return 0;
    var t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / L2;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }

  /** 取第 n 关（1 起）的关卡定义；关卡表循环，循环一轮难度再叠 diffPerLoop */
  function stageOf(cfg, n) {
    var list = cfg.stages || [];
    if (!list.length) return null;
    var idx = ((Math.max(1, n) - 1) % list.length);
    var loop = Math.floor((Math.max(1, n) - 1) / list.length);
    var st = list[idx];
    if (!loop) return st;
    var copy = {};
    for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) copy[k] = st[k];
    copy.name = st.name + ' +' + loop;
    copy.diff = st.diff * (1 + cfg.stage.diffPerLoop * loop);
    return copy;
  }

  function createWorld(cfg, spawn, stageIdx) {
    var W = cfg.map.w, H = cfg.map.h, c = cfg.world;
    var st = stageOf(cfg, stageIdx || 1);
    var wallDefs = (st && st.walls) ? st.walls : (c.walls || []);
    var ground = (st && st.ground) ? st.ground : { base: '#3c5a34', patch: [40, 110, 40], path: 'rgba(120,98,66,.42)' };
    var walls = [], rocks = [], paths=[],trees=[],corridors=[];
    if(cfg.trial&&cfg.trial.enabled){
      wallDefs=[];
      // Connected outer loop, crossed branches and a clear central fighting space.
      var nodes=[[.20,.25],[.50,.18],[.80,.25],[.85,.62],[.65,.82],[.32,.82],[.15,.60]];
      for(var pi=0;pi<nodes.length;pi++){var a=nodes[pi],b=nodes[(pi+1)%nodes.length];paths.push({x1:a[0]*W,y1:a[1]*H,x2:b[0]*W,y2:b[1]*H});}
      [0,2,4,6].forEach(function(index){var a=nodes[index];paths.push({x1:spawn.x,y1:spawn.y,x2:a[0]*W,y2:a[1]*H});});
    }
    if(paths.length){
      // Short parallel rock banks: 104px clear width, open at both ends and around the outside.
      [7,10].forEach(function(index){
        var road=paths[index],dx=road.x2-road.x1,dy=road.y2-road.y1,len=Math.hypot(dx,dy),ux=dx/len,uy=dy/len;
        var cx=road.x1+dx*.48,cy=road.y1+dy*.48;
        corridors.push({x:cx,y:cy,ux:ux,uy:uy,half:80,width:104});
        [-1,1].forEach(function(side){var ox=-uy*70*side,oy=ux*70*side;walls.push({x1:cx-ux*80+ox,y1:cy-uy*80+oy,x2:cx+ux*80+ox,y2:cy+uy*80+oy,r:18,corridor:true});});
      });
    }
    function nearPath(x,y,r){
      for(var k=0;k<paths.length;k++){var line=paths[k],t=closestT(x,y,line);if(Math.hypot(x-line.x1-(line.x2-line.x1)*t,y-line.y1-(line.y2-line.y1)*t)<r+65)return true;}return false;
    }

    /* ===== 1) 墙：按 span 走一遍，跳过缺口，得到几段"实心"区间，每段做成一条胶囊 =====
       墙把场地切成几个区；缺口是唯一的通路，也是能卡住追兵的瓶颈。 */
    for (var wi = 0; wi < wallDefs.length; wi++) {
      var wd = wallDefs[wi];
      var isV = wd.dir === 'v';
      var fixed = (isV ? W : H) * wd.at;
      var len = isV ? H : W;
      var from = len * wd.span[0], to = len * wd.span[1];
      var solid = null;
      for (var s = from; s <= to; s += 8) {
        var inGap = false;
        for (var gi = 0; gi < wd.gaps.length; gi++) {
          if (Math.abs(s - len * wd.gaps[gi]) < c.gapHalf) { inGap = true; break; }
        }
        if (!inGap) {
          if (!solid) solid = { a: s };
          solid.b = s;
        } else if (solid) {
          pushWall(walls, isV, fixed, solid.a, solid.b, c, spawn, wi);
          solid = null;
        }
      }
      if (solid) pushWall(walls, isV, fixed, solid.a, solid.b, c, spawn, wi);
    }

    /* ===== 2) 散落石头：点缀（避开出生点和墙） ===== */
    var guard = 0;
    while (rocks.length < c.rockCount && guard++ < 900) {
      var r = c.rockR[0] + Math.random() * (c.rockR[1] - c.rockR[0]);
      var x = 120 + Math.random() * (W - 240);
      var y = 120 + Math.random() * (H - 240);
      if (spawn && Math.hypot(x - spawn.x, y - spawn.y) < c.spawnClear) continue;
      var bad = false;
      for (var i = 0; i < rocks.length; i++) {
        if (Math.hypot(rocks[i].x - x, rocks[i].y - y) < rocks[i].r + r + 70) { bad = true; break; }
      }
      if (bad || nearPath(x,y,r)) continue;
      if (nearWall(walls, x, y, r)) continue;      // 别贴在墙上长石头
      rocks.push({ x: x, y: y, r: r });
    }

    if(paths.length){
      // Sparse collidable trunks; foliage is decorative and never blocks movement.
      for(var ti=0;ti<150&&trees.length<25;ti++){
        var tx=110+Math.random()*(W-220),ty=110+Math.random()*(H-220),tr=12;
        if(Math.hypot(tx-spawn.x,ty-spawn.y)<240||nearPath(tx,ty,tr)||nearWall(walls,tx,ty,tr))continue;
        var clear=true;for(var rk=0;rk<rocks.length;rk++)if(Math.hypot(tx-rocks[rk].x,ty-rocks[rk].y)<rocks[rk].r+85){clear=false;break;}
        if(!clear)continue;
        var tree={x:tx,y:ty,r:tr,tree:true,crown:34+Math.random()*12};trees.push(tree);rocks.push(tree);
      }
    }
    /* 缺口（墙上的"门"）列表：怪撞墙时会改道去最近的那个。
       有了它，怪不需要寻路也能穿过地形：绕过不去就奔门，门是唯一的通路。 */
    var gaps = [];
    corridors.forEach(function(c){[-1,1].forEach(function(sign){gaps.push({x:c.x+c.ux*150*sign,y:c.y+c.uy*150*sign});});});
    for (var gj = 0; gj < wallDefs.length; gj++) {
      var gwd = wallDefs[gj], gV = gwd.dir === 'v';
      var gLen = gV ? H : W, gFixed = (gV ? W : H) * gwd.at;
      for (var gk = 0; gk < gwd.gaps.length; gk++) {
        var gp = gLen * gwd.gaps[gk];
        gaps.push({ x: gV ? gFixed : gp, y: gV ? gp : gFixed });
      }
    }

    return {
      w: W,
      h: H,
      stage: stageIdx || 1,
      stageName: (st && st.name) || '荒原',
      paths: paths, trees: trees, corridors:corridors,
      ground: ground,               // 这一关的地面配色（渲染层用）
      wallDefs: wallDefs,           // 这一关的墙定义（测试/HUD 用）
      walls: walls,                 // 墙（胶囊线段）
      gaps: gaps,                   // 缺口中心（怪改道用）
      rocks: rocks,                 // 散落石头（圆）
      spawn: { x: spawn.x, y: spawn.y },

      /** 这个位置放东西会不会卡在墙/石头里（入口选址要用） */
      isFree: function (x, y, r) {
        var probe = { x: x, y: y, r: r || 1 };
        for (var i = 0; i < walls.length; i++) {
          var w = walls[i];
          var t = closestT(x, y, w);
          var cx = w.x1 + (w.x2 - w.x1) * t, cy = w.y1 + (w.y2 - w.y1) * t;
          if (Math.hypot(x - cx, y - cy) < w.r + probe.r) return false;
        }
        for (var j = 0; j < rocks.length; j++) {
          if (Math.hypot(x - rocks[j].x, y - rocks[j].y) < rocks[j].r + probe.r) return false;
        }
        return true;
      },

      /** 离 (x,y) 最近的缺口 —— 怪撞墙时用它改道 */
      nearestGap: function (x, y) {
        var best = null, bd = Infinity;
        for (var i = 0; i < gaps.length; i++) {
          var d = Math.hypot(gaps[i].x - x, gaps[i].y - y);
          if (d < bd) { bd = d; best = gaps[i]; }
        }
        return best;
      },

      /** 把实体推出墙/石头，并夹在地图内。改了碰撞规则只需要改这里。 */
      collide: function (e) {
        /* ⚠️ 推出量多给 0.01px：正好推到 `min` 上是个浮点刀锋 ——
           isFree() 判的是 `<`，推完可能还差 1e-7 就被判"还在墙里"，
           于是"生成点不自由"这种假故障会随机冒出来（教学精英那次就是被它卡住的）。 */
        var SLACK = 0.01;
        for (var i = 0; i < walls.length; i++) {
          var w = walls[i];
          var t = closestT(e.x, e.y, w);
          var cx = w.x1 + (w.x2 - w.x1) * t, cy = w.y1 + (w.y2 - w.y1) * t;
          var dx = e.x - cx, dy = e.y - cy;
          var d = Math.hypot(dx, dy), min = w.r + e.r + SLACK;
          if (d < min) {
            if (d < 0.001) { dx = 0; dy = -1; d = 1; }    // 正好压在轴线上：往上推
            e.x = cx + dx / d * min;
            e.y = cy + dy / d * min;
          }
        }
        for (var j = 0; j < rocks.length; j++) {
          var o = rocks[j];
          var ox = e.x - o.x, oy = e.y - o.y;
          var od = Math.hypot(ox, oy), omin = o.r + e.r + SLACK;
          if (od < omin && od > 0) {
            e.x = o.x + ox / od * omin;
            e.y = o.y + oy / od * omin;
          }
        }
        e.x = Math.max(c.border, Math.min(W - c.border, e.x));
        e.y = Math.max(c.border, Math.min(H - c.border, e.y));
      }
    };
  }

  /** 把一段实心区间做成墙；太短的段不要，出生点附近让开（别把玩家砌死在墙里） */
  function pushWall(walls, isV, fixed, a, b, c, spawn, wi) {
    if (b - a < 40) return;
    var x1 = isV ? fixed : a, y1 = isV ? a : fixed;
    var x2 = isV ? fixed : b, y2 = isV ? b : fixed;
    var seg = { x1: x1, y1: y1, x2: x2, y2: y2, r: c.wallHalf, wallIndex: wi };
    if (spawn) {
      var t = closestT(spawn.x, spawn.y, seg);
      var cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
      if (Math.hypot(spawn.x - cx, spawn.y - cy) < c.spawnClear * 0.6 + c.wallHalf) return;
    }
    walls.push(seg);
  }

  /** 散石别长在墙里 */
  function nearWall(walls, x, y, r) {
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      var t = closestT(x, y, w);
      var cx = w.x1 + (w.x2 - w.x1) * t, cy = w.y1 + (w.y2 - w.y1) * t;
      if (Math.hypot(x - cx, y - cy) < w.r + r + 40) return true;
    }
    return false;
  }

  return { createWorld: createWorld, stageOf: stageOf };
});
