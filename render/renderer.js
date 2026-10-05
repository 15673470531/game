/**
 * 共享渲染层：只依赖 canvas 2D 上下文，网页和小游戏都能用。
 *
 * 平台只要给它三样东西：
 *   ctx                     画布 2D 上下文
 *   opts.createCanvas(w,h)  建离屏画布的函数（网页 document.createElement，小游戏 wx.createCanvas）
 *   opts.cfg                数值配置
 *
 * 设计要点：**成长必须看得见**。装备不只改数字，还要改角色身上画出来的东西
 * （武器形状/颜色、护甲配色+肩甲、脚下收刃充能环 —— 饰品光环 2026-10 已按用户口径删掉），
 * 再加上升级时的冲击波/闪光/放大。
 * 血条、经验、装备栏、小地图、升级卡、结束画面也全在这里，所以小游戏端不用重写 UI。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.__GAME__ = root.__GAME__ || {}).Renderer = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof window !== 'undefined' ? window : globalThis), function () {
  'use strict';

  var FONT = '-apple-system,"PingFang SC","Helvetica Neue",sans-serif';
  var POP_TIME = 0.45;        // 升级时角色放大一下的时长
  var FLASH_TIME = 0.32;      // 全屏闪光时长
  /* 精英 / Boss 头顶名字的颜色（2026-10 用户指定：紫色）。
     不用饱和紫（#8a2be2 那种）—— 叠在草地/石林上会糊成暗块；这个是偏亮的香芋紫，
     配深色描边在地面两种底色上都读得清（描边由 drawFoeName 加）。 */
  var ELITE_NAME_COLOR = '#c9a2ff';

  /* ---------- 颜色工具 ---------- */
  function hex2rgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * t) + ',' +
                    Math.round(A[1] + (B[1] - A[1]) * t) + ',' +
                    Math.round(A[2] + (B[2] - A[2]) * t) + ')';
  }
  function rgba(hex, a) {
    var c = hex2rgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  function Renderer(ctx, opts) {
    this.ctx = ctx;
    this.createCanvas = opts.createCanvas;
    this.cfg = opts.cfg || null;
    this.hint = opts.hint || '';
    this.restartHint = opts.restartHint || '再来一次';
    this.w = 0; this.h = 0;
    this.ground = null;
    this.groundWorld = null;

    // 打击/成长反馈
    this.shakeMag = 0;
    this.lastT = 0;
    this.flash = 0;           // 全屏白闪剩余时间
    this.popT = 0;            // 角色放大动画剩余时间
    this.fx = [];             // 冲击波等特效
    this.equipFlash = 0;      // 换装高亮
    this.insets = { top: 0, left: 0, right: 0, bottom: 0 };   // 手机安全区（刘海/底部横条）
    this.hpLag = 1;           // 掉血滞留条
    /* 低血时的"角色级"信号样式：'body' = 红色描身体剪影的心跳脉冲（默认）；
       'ring' = 脚下一个红色警示圈（备选，出图对比用，见 tools/preview-hud.html）。 */
    this.lowHpStyle = opts.lowHpStyle || 'body';
    /* 地上武器技能卷轴的表现（2026-10 用户挑的编号 3+4+6）：
       'magic'（默认）= 卷轴 + 地上柔光 + 四周小星点闪烁 + 上升金色火星 + 每 2.5s 一次脉冲提亮
       'glow'  = 只有卷轴 + 地上柔光           'scroll' = 只有卷轴
       'pillar'= 更早那版（竖光柱 + 深色字牌），只在 tools/preview-skilldrop.html 里当对照。 */
    this.scrollStyle = opts.scrollStyle || 'magic';
    this.menuReserveTop = 0;  // 右上角原生胶囊按钮的避让高度（见 setMenuReserve）
    this.dt = 0;
  }

  /** 手机安全区。平台层把 wx.getWindowInfo().safeArea 换算成四边内缩传进来 */
  Renderer.prototype.setInsets = function (ins) {
    this.insets = {
      top: (ins && ins.top) || 0,
      left: (ins && ins.left) || 0,
      right: (ins && ins.right) || 0,
      bottom: (ins && ins.bottom) || 0
    };
  };

  /**
   * 右上角必须让开的区域（微信**原生胶囊按钮** ⋯／⊙）。
   * 平台层用 wx.getMenuButtonBoundingClientRect() 量出来；网页/开发者工具拿不到 → 0，版式不变。
   * ⚠️ 这和 insets 是两件事：insets 管刘海/底部横条（safeArea），胶囊是平台画在最上层的按钮 ——
   *    只管 insets 的话，真机横屏时暂停键和击杀/金币卡就压在胶囊底下（2026-10 真机发现）。
   */
  Renderer.prototype.setMenuReserve = function (r) {
    this.menuReserveTop = (r && r.top) || 0;
    return this.menuReserveTop;
  };

  Renderer.prototype.resize = function (w, h) { this.w = w; this.h = h; };

  /* ==================== 事件 → 视觉反馈 ==================== */
  Renderer.prototype.handleEvents = function (events) {
    if (!this.cfg) return;
    var shake = this.cfg.feel.shake;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var m = shake[ev.type];
      if (m) this.shakeMag = Math.min(28, Math.max(this.shakeMag, m));

      if (ev.type === 'levelup') {
        // 升级要"亮一下、震一下、角色鼓一下" —— 三件事同时做才够明显
        this.flash = FLASH_TIME;
        this.popT = POP_TIME;
        this.shakeMag = Math.max(this.shakeMag, 9);
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.75, color: '#ffd166', r0: 20, r1: 260, w: 7 });
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.95, color: '#fff4c2', r0: 8, r1: 400, w: 4 });
        this.fx.push({ kind: 'burst', x: ev.x, y: ev.y - 20, t: 0, life: 0.6, color: '#ffd166', n: 22, seed: 1 });
      }
      if (ev.type === 'equip') {
        this.equipFlash = 0.7;
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.5, color: '#8fd6a5', r0: 10, r1: 120, w: 4 });
      }
      if (ev.type === 'spin') {                 // 起转：冲击环 + 震屏（"刀甩起来了"）
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.32, color: '#ffe9a8', r0: 12, r1: 108, w: 5 });
        this.fx.push({ kind: 'burst', x: ev.x, y: ev.y - 10, t: 0, life: 0.4, color: '#fff4c2', n: 10, seed: 3 });
      }
      /* 收刃**不画任何东西**（真机要求："这个收刃后的光圈也不要"）——
         原来这里放一个收缩的小圈提示"进冷却了"，现在连它一起删掉：
         收刃的可见信号就是"刀刃消失了"，不再额外加光圈。 */

      if (ev.type === 'splash') {
        // 大剑震地：地面冲击环（原来只有粒子，看不出"溅射到旁边了"）
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.28,
                       color: '#a8bccd', r0: 18, r1: ev.radius || 118, w: 5 });
      }
      if (ev.type === 'pierce') {
        // 法杖穿透：命中点留一个小残影，能看出"打穿了继续飞"
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.22,
                       color: '#b98ae0', r0: 4, r1: 26, w: 2.5 });
      }
      if (ev.type === 'summon') {
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 0.6,
                       color: '#6aa9e0', r0: 20, r1: 200, w: 6 });
      }
      if (ev.type === 'bossDown') {
        this.fx.push({ kind: 'ring', x: ev.x, y: ev.y, t: 0, life: 1.0, color: '#ff9b6b', r0: 20, r1: 420, w: 9 });
        this.flash = Math.max(this.flash, 0.2);
      }
    }
    if (this.fx.length > 80) this.fx.splice(0, this.fx.length - 80);
  };

  /* ==================== 地形 ==================== */
  Renderer.prototype.buildGround = function (world) {
    var c = this.createCanvas(world.w, world.h);
    var g = c.getContext('2d');
    var sx = world.w / 2400, sy = world.h / 1600;
    var G = world.ground || { base: '#3c5a34', patch: [40, 110, 40], path: 'rgba(120,98,66,.42)' };
    var PC = G.patch || [40, 110, 40];

    g.fillStyle = G.base;
    g.fillRect(0, 0, world.w, world.h);

    for (var i = 0; i < 2600; i++) {
      var x = Math.random() * world.w, y = Math.random() * world.h, r = 20 + Math.random() * 95;
      var k = 0.6 + Math.random() * 0.9;      // 斑块颜色按关卡主题色抖一下
      g.fillStyle = 'rgba(' + ((PC[0] * k) | 0) + ',' + ((PC[1] * k) | 0) + ',' + ((PC[2] * k) | 0) + ',' +
                    (0.05 + Math.random() * 0.10).toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }

    var roads=world.paths||[];
    g.lineCap='round';g.lineJoin='round';
    for(var layer=0;layer<2;layer++){
      g.strokeStyle=layer?'rgba(160,137,88,.30)':'rgba(112,98,60,.5)';g.lineWidth=layer?48:66;
      for(var ri=0;ri<roads.length;ri++){var road=roads[ri];g.beginPath();g.moveTo(road.x1,road.y1);g.lineTo(road.x2,road.y2);g.stroke();}
    }
    for(var di=0;di<1400;di++){
      var dx=Math.random()*world.w,dy=Math.random()*world.h;
      if(di%3===0){g.strokeStyle='rgba(172,188,99,.23)';g.lineWidth=1;g.beginPath();g.moveTo(dx-3,dy);g.lineTo(dx-5,dy-6);g.moveTo(dx,dy);g.lineTo(dx+2,dy-8);g.stroke();}
      else{g.save();g.translate(dx,dy);g.rotate(Math.random()*6.28);g.fillStyle=di%2?'rgba(192,153,69,.42)':'rgba(124,146,59,.55)';g.beginPath();g.ellipse(0,0,3.5,1.5,0,0,7);g.fill();g.restore();}
    }
    for(var ti=0;ti<(world.trees||[]).length;ti++){
      var tree=world.trees[ti];g.fillStyle='rgba(13,29,15,.2)';g.beginPath();g.ellipse(tree.x+10,tree.y+8,tree.crown,tree.crown*.4,0,0,7);g.fill();
      for(var li=0;li<16;li++){var la=li*2.4,lr=18+(li%5)*8;g.fillStyle=li%2?'#77843c':'#9a8945';g.beginPath();g.ellipse(tree.x+Math.cos(la)*lr,tree.y+Math.sin(la)*lr*.6,3,1.4,la,0,7);g.fill();}
    }

    g.fillStyle = 'rgba(52,96,120,.75)';
    g.beginPath(); g.ellipse(1900 * sx, 1250 * sy, 240 * sx, 150 * sy, -0.3, 0, 7); g.fill();
    g.strokeStyle = 'rgba(150,200,220,.35)'; g.lineWidth = 5; g.stroke();

    g.strokeStyle = 'rgba(20,30,18,.85)'; g.lineWidth = 26;
    g.strokeRect(0, 0, world.w, world.h);

    this.ground = c;
    this.groundWorld = world;
  };

  /* ==================== 主绘制 ==================== */
  Renderer.prototype.draw = function (game, t) {
    var ctx = this.ctx, w = this.w, h = this.h, P = game.player;

    this.viewX = game.cam.x; this.viewY = game.cam.y;
    /* 本帧的界面状态：给"只在打的时候画"的元素用（目前是脚下的挥刀充能环 ——
       方案 2 之后它脚下一直有，不 gate 的话暂停/升级/死亡面板后面会挂一圈冻住的环）。 */
    this.frameState = game.state;
    this.zoom=(game.cfg.camera&&game.cfg.camera.zoom)||1;
    var dt = Math.min(Math.max(t - this.lastT, 0), 0.1);
    this.lastT = t;
    this.dt = dt;

    /* 首页：整屏就是首页，**不画世界**。
       （世界这时候是刚 reset 的空场，画出来像"已经在打了"，正好是这次要修的问题） */
    if (game.state === 'title') { this.drawTitle(game); return; }

    if (this.groundWorld !== game.world) this.buildGround(game.world);

    // 屏震衰减
    if (this.shakeMag > 0.05) this.shakeMag *= Math.exp(-(this.cfg ? this.cfg.feel.shakeDecay : 7) * dt);
    else this.shakeMag = 0;
    var ox = (Math.random() * 2 - 1) * this.shakeMag;
    var oy = (Math.random() * 2 - 1) * this.shakeMag;

    // 各类反馈计时
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    if (this.popT > 0) this.popT = Math.max(0, this.popT - dt);
    if (this.equipFlash > 0) this.equipFlash = Math.max(0, this.equipFlash - dt);
    for (var i = this.fx.length - 1; i >= 0; i--) {
      this.fx[i].t += dt;
      if (this.fx[i].t >= this.fx[i].life) this.fx.splice(i, 1);
    }

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(ox,oy);ctx.scale(this.zoom,this.zoom);
    ctx.translate(-game.cam.x, -game.cam.y);

    ctx.drawImage(this.ground, 0, 0);
    this.drawRocks(game.world.rocks);
    this.drawWalls(game.world.walls || []);    // 墙（地形）
    this.drawHazards(game.hazards || []);      // 地面威胁画在最底下（贴地）
    this.drawTelegraph(game.foes);
    this.drawPickups(game.pickups, t);
    this.drawFoes(game.foes, t);
    /* 技能卷轴的**光柱层**：必须画在怪之后 —— 卷轴本体在 drawPickups 里（怪下面），
       怪一多就把它盖住；这条光柱是"怪物再多也压不住"的那一层。见 drawScrollBeams。 */
    this.drawScrollBeams(game.pickups, t);
    this.drawProjectiles(game.projectiles);
    /* 旋刃分两层画：**朝上的那一半画在角色背后**（俯视角里屏幕上方 = 远处，刀刃本来就从人物后面过），
       否则刀刃会从人物身上划过去（真机反馈"和人物重叠"）。 */
    this.drawOrbit(game, P, t, 'behind');
    this.drawFx();
    this.drawWeaponSkills(game);

    // 升级时角色"鼓"一下：最直接的"我变强了"的信号
    var pop = this.popT > 0 ? 1 + 0.34 * (this.popT / POP_TIME) : 1;
    if (pop !== 1) {
      ctx.save();
      ctx.translate(P.x, P.y);
      ctx.scale(pop, pop);
      ctx.translate(-P.x, -P.y);
      this.drawPlayer(P, t);
      ctx.restore();
    } else {
      this.drawPlayer(P, t);
    }
    this.drawOrbit(game, P, t, 'front');

    this.drawTrees(game.world.trees||[],P,game.foes);
    this.drawPlayerHp(P, t, game.cam.y);       // 头顶血条（贴地图上边时会自动改挂脚下）
    this.drawParticles(game.parts.list);
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = 'rgba(255,246,214,' + (0.5 * this.flash / FLASH_TIME).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }

    this.drawTideWarning(game,t);
    this.drawSwarmBanner(game.swarmWarn, t, game.swarmCount);   // 边缘泛红 + 顶部小字（屏幕空间）
    if (!game.training && !game.cfg.trial.enabled) this.drawMinimap(game);   // 试炼场不需要小地图（底栏要占位置）
    this.drawHud(game, P);
    this.drawScrollGuides(game);        // 掉在屏幕外的技能卷轴：边缘箭头指路（"不消失"必须配指路）
    if (game.training) this.drawTrainingBar(game);
    this.drawStageHud(game);
    if (game.state === 'play') this.drawFrenzyControl(game, t);
    /* 武器库入口（左下角）：只在打的时候、且手里不止一把武器时出现 */
    /* ⚠️ 2026-10 用户口径（页面简洁）：左下角那个「武器库」按钮**整个删掉** ——
       入口改到「暂停 → 换武器」（暂停面板里一行，见 game.pauseRects）。
       ⚠️ 按钮、它的点击判定、以及"升级卡弹出时点在按钮上的手不算选卡"那条排除，
          必须**一起删干净**（留一半就是一个看不见的热区/永远不会触发的分支 —— 技能格那次踩过）。 */
    if (game.state === 'levelup') this.drawCards(game);
    if (game.state === 'dead') this.drawGameOver(game);
    if (game.state === 'intro') this.drawStageIntro(game);
    if (game.state === 'clear') this.drawClearPanel(game);        // 通关成功面板
    if (game.state === 'bag') this.drawBagPanel(game);             // 武器库（换武器）
    if (game.state === 'trialcards') this.drawTrialCardPanel(game); // 试炼场·试卡（点名试用某张卡）
    if (game.state === 'paused') this.drawPausePanel(game);        // 暂停面板（覆盖在上面）
  };

  /**
   * ⚠️ 2026-10 删除：左下角的「武器库」入口按钮（drawBagButton）。
   * 用户口径"页面简洁" → 入口改到「暂停 → 换武器」（见 game.pauseRects / updatePaused）。
   * 删掉的东西：本函数、draw() 里的调用、game.update() 里的点击判定、
   * 以及 updateLevelUp 里"点在按钮上的手不算选卡"那条排除（按钮没了，那条就是死分支）。
   */

  /** 面板顶部的两个页签：武器 / 属性（矩形来自 game.bagTabs —— 渲染和判定共用） */
  Renderer.prototype.drawBagTabs = function (game) {
    var ctx = this.ctx, tabs = game.bagTabs();
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i], on = (game.bagTab === t.id);
      ctx.fillStyle = on ? 'rgba(255,209,102,.16)' : 'rgba(10,14,18,.72)';
      ctx.fillRect(t.x, t.y, t.w, t.h);
      ctx.strokeStyle = on ? '#ffd166' : 'rgba(255,255,255,.22)';
      ctx.lineWidth = on ? 2 : 1.5;
      ctx.strokeRect(t.x + 1, t.y + 1, t.w - 2, t.h - 2);
      ctx.font = (on ? '700 13.5px ' : '600 13.5px ') + FONT;
      ctx.fillStyle = on ? '#ffd166' : 'rgba(255,255,255,.62)';
      ctx.fillText(t.label, t.x + t.w / 2, t.y + t.h / 2 + 0.5);
    }
    ctx.restore();
  };

  /**
   * 「属性」页：**本局拿过的卡**给了什么（只列拿过的，一项一行）。
   * 一行三层信息：`攻击力 36 → 64（+77%）` + 右边小字写是哪张卡给的（金色卡用金色）。
   * 数值口径 = 裸装基准 → 加了卡之后（**不含装备**，装备是另一页的事）。
   * 空状态（还没拿过卡）明确说一句，而不是画 12 行 0 —— 12 个 0 会被读成"零值/没生效"。
   */
  Renderer.prototype.drawStatPanel = function (game) {
    var ctx = this.ctx, vw = this.w, vh = this.h;
    var tabs = game.bagTabs();
    var y0 = (tabs.length ? tabs[0].y + tabs[0].h : 90) + 22;
    var rows = game.Prog && game.Prog.statRows ? game.Prog.statRows(this.cfg, game.player) : [];
    ctx.save();ctx.font='11px '+FONT;ctx.textAlign='center';ctx.fillStyle='#ffd166';ctx.fillText('当前攻击 '+game.player.stats.attackDamage.toFixed(1)+' · 常规移速 '+game.player.stats.spd.toFixed(1)+' / '+(this.cfg.player.base.spd*1.25).toFixed(1)+'上限',vw/2,y0-9);ctx.restore();

    ctx.save();
    ctx.textBaseline = 'middle';
    if (!rows.length) {
      ctx.textAlign = 'center';
      ctx.font = '600 15px ' + FONT;
      ctx.fillStyle = 'rgba(255,255,255,.78)';
      ctx.fillText('本局还没拿过卡', vw / 2, vh / 2 - 12);
      ctx.font = '12px ' + FONT;
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.fillText('升级时选的卡，效果会列在这里', vw / 2, vh / 2 + 12);
      ctx.restore();
      return;
    }

    /* ⚠️ 分列要**尽量平均**（用户口径：并列的列表数量不齐会觉得"怪"）：
       ① 列数按"每列最多 6 行"算  ② 用**轮转**分配（i % cols）而不是"切块"，
       这样 7 行是 4+3、13 行是 5+4+4 —— 列高差不超过 1 行。
       （切块写法会给出 6+1、5+5+3 这种尾巴，最后一列孤零零的。） */
    /* ⚠️ **最多两列**：试过 3 列（13 行 5+4+4），列一窄"攻击力 36 → 65（+81%）"就和右边
       的卡名（玻璃大炮 · 狂奔）压在一起了 —— 812 宽塞不下"数值 + 卡名"三列。
       两列时每行 = 值（左）+ 卡名（右对齐），13 行刚好 7+6，行高还有 29px。 */
    var cols = Math.max(1, Math.min(2, Math.ceil(rows.length / 6)));
    var perCol = Math.ceil(rows.length / cols);
    var colW = Math.min(368, (vw - 48) / cols);
    var x0 = (vw - colW * cols) / 2;
    var rowH = Math.min(30, (vh - y0 - 40) / perCol);

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], c = i % cols, k = Math.floor(i / cols);
      var x = x0 + c * colW, y = y0 + k * rowH + rowH / 2;

      ctx.textAlign = 'left';
      ctx.font = '600 13px ' + FONT;
      ctx.fillStyle = '#f2efe9';
      ctx.fillText(r.text, x + 14, y);

      /* 哪张卡给的：普通版和金色版都拿过就并排写出来（金色那张用金色字） */
      var names = '', anyGold = false, j;
      for (j = 0; j < r.cards.length; j++) {
        names += (j ? ' · ' : '') + r.cards[j].name;
        if (r.cards[j].gold) anyGold = true;
      }
      ctx.textAlign = 'right';
      ctx.font = '11px ' + FONT;
      ctx.fillStyle = anyGold ? '#ffd94a' : 'rgba(255,255,255,.42)';
      ctx.fillText(names, x + colW - 20, y);
    }
    ctx.restore();
  };

  /**
   * 武器库面板（暂停）：一排卡片，点一张就换上。
   * 每张卡：稀有度色带 + 武器图标 + "稀有度 · 名字" + 主要词条 + 独有机制；当前那把高亮。
   */
  Renderer.prototype.drawBagPanel = function (game) {
    var ctx = this.ctx, cfg = this.cfg, ins = this.insets;
    var P = game.player, bag = P.bag || [], rects = game.bagRects();

    ctx.save();
    ctx.fillStyle = 'rgba(6,9,12,.94)';
    ctx.fillRect(0, 0, this.w, this.h);
    /* 顶部两个页签取代了原来那行标题（垂直空间紧，标题的信息页签已经说了） */
    this.drawBagTabs(game);
    if (game.bagTab === 'skills') { this.drawSkillPanel(game); ctx.restore(); return; }
    if (game.bagTab === 'stats') {
      this.drawStatPanel(game);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = '11.5px ' + FONT;
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillText('本局拿过的卡 · 点空白处关掉', this.w / 2, this.h - 14 - ins.bottom);
      ctx.restore();
      return;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var canPick = bag.length >= 2;

    for (var i = 0; i < rects.length; i++) {
      var r = rects[i], it = bag[i];
      if (!it) continue;
      var wdef = cfg.weapons[it.kind] || cfg.weapons.sword;
      var cur = (it === P.equip.weapon);

      ctx.fillStyle = 'rgba(12,16,20,.92)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = it.color;
      ctx.fillRect(r.x, r.y, r.w, 4);                    // 顶部稀有度色带
      ctx.strokeStyle = cur ? '#ffd166' : 'rgba(255,255,255,.18)';
      ctx.lineWidth = cur ? 2.5 : 1.5;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);

      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y + r.h * 0.23);
      ctx.scale(r.w / 96, r.w / 96);
      this.drawWeaponIcon(ctx, it.kind, it.color);
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.font = '700 12.5px ' + FONT;
      ctx.fillStyle = it.color;
      ctx.fillText(it.rarityName + ' · ' + it.name, r.x + r.w / 2, r.y + r.h * 0.46);
      var a0 = (it.affixes && it.affixes[0]) || null;
      ctx.font = '11px ' + FONT;
      ctx.fillStyle = 'rgba(255,255,255,.66)';
      ctx.fillText(a0 ? (a0.label + ' ' + (a0.negate ? '-' : '+') + Math.abs(a0.v)) : '',
        r.x + r.w / 2, r.y + r.h * 0.46 + 16);
      ctx.fillStyle = 'rgba(255,255,255,.48)';
      ctx.fillText(wdef.trait ? ('独有：' + wdef.trait.label) : '独有机制：无',
        r.x + r.w / 2, r.y + r.h - 56);

      var skills = game.weaponSkillRows(it.kind);
      for (var si = 0; si < skills.length; si++) {
        ctx.font = '11px ' + FONT;
        ctx.fillStyle = skills[si].owned ? (cur ? '#ffd166' : '#9fd9c9') : '#80909d';
        ctx.fillText((skills[si].owned ? '● ' : '○ ') + skills[si].name, r.x + r.w / 2, r.y + r.h - 35 + si * 18);
      }
      if (cur) {
        ctx.textAlign = 'right';
        ctx.font = '700 10.5px ' + FONT;
        ctx.fillStyle = '#ffd166';
        ctx.fillText('当前', r.x + r.w - 8, r.y + 14);
        ctx.textAlign = 'center';
      }
    }

    ctx.font = '11.5px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    var footY = rects.length ? Math.min(this.h - 14 - ins.bottom, rects[0].y + rects[0].h + 20) : this.h - 20;
    ctx.fillText(canPick
      ? '● 已获得 ○ 未获得 · 技能页看详情 · 装备攻击加成上限+10'
      : '● 已获得　○ 未获得 · 技能页查看效果 · 点空白处返回', this.w / 2, footY);
    ctx.restore();
  };

  Renderer.prototype.drawSkillPanel = function (game) {
    var ctx = this.ctx, r = game.skillPanelRects(), kind = game.skillViewKind || game.weaponKind();
    for (var i = 0; i < r.tabs.length; i++) this.drawBtn(r.tabs[i], this.cfg.weapons[r.tabs[i].kind].name,
      r.tabs[i].kind === kind ? 'primary' : 'ghost', 12);
    /* ⚠️ 列数按**实际张数**算 —— 长剑熟练度 Lv2 之后是 3 张技能。
       原来是写死 `(r.body.w - gap) / 2` 两列，第 3 张会画到 body 右边**外面**：
       面板看着没坏，就是"这张技能根本不存在"（用户 2026-10 就是这么发现"看不到所有技能"的）。 */
    var rows = game.weaponSkillRows(kind), n = Math.max(1, rows.length), gap = 12;
    var w = (r.body.w - gap * (n - 1)) / n;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i], x = r.body.x + i * (w + gap), y = r.body.y;
      ctx.fillStyle = '#111e29'; ctx.fillRect(x, y, w, r.body.h);
      ctx.strokeStyle = row.owned ? '#d1b166' : '#42515c'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, r.body.h);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = '700 15px ' + FONT; ctx.fillStyle = row.owned ? '#ffd166' : '#bdc7ce';
      ctx.fillText(row.name, x + 12, y + 10);
      ctx.font = '11px ' + FONT; ctx.fillStyle = row.owned ? '#9fd9c9' : '#8999a6';
      ctx.fillText(row.status, x + 12, y + 32);
      /* 描述：列一窄（3 张时）就装不下，先按 13px 排、放不下降字号 —— 别让字出格 */
      var dfs = 13, dlh = 19, maxW = w - 24, dl;
      while (true) {
        ctx.font = dfs + 'px ' + FONT;
        dl = []; var ln = '';
        for (var j2 = 0; j2 < row.desc.length; j2++) {
          if (ln && ctx.measureText(ln + row.desc[j2]).width > maxW) { dl.push(ln); ln = ''; }
          ln += row.desc[j2];
        }
        if (ln) dl.push(ln);
        if (dfs <= 10.5 || y + 54 + dl.length * dlh <= y + r.body.h - 6) break;
        dfs -= 0.5;
      }
      ctx.font = dfs + 'px ' + FONT; ctx.fillStyle = '#dae4ed';
      var lineY = y + 54;
      for (var j = 0; j < dl.length; j++) { ctx.fillText(dl[j], x + 12, lineY); lineY += dlh; }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '11px ' + FONT; ctx.fillStyle = '#b8c6cf';
    var owned = rows.filter(function (c) { return c.owned; }).length;
    /* 提示按**实际张数**说（长剑 3 张，不能再判 `owned === 2`）；
       旧那句"第二张：第二波起…"是"技能走三选一"时代的节奏，2026-10 改成精英掉卷轴之后已经过时了。 */
    var hint = owned >= rows.length ? '技能本局保留 · 切回对应武器生效'
             : (owned > 0 ? '还有技能没拿到 · 精英怪会掉技能卷轴'
                          : '精英怪掉技能卷轴 · 捡起即学会');
    ctx.fillText(hint + ' · 点空白返回', this.w / 2, this.h - 15 - (this.insets.bottom || 0));
  };

  /** 冲击波 / 爆散 等世界坐标特效 */
  Renderer.prototype.drawFx = function () {
    var ctx = this.ctx;
    for (var i = 0; i < this.fx.length; i++) {
      var f = this.fx[i];
      var k = f.t / f.life;
      var a = 1 - k;
      if (f.kind === 'ring') {
        var r = f.r0 + (f.r1 - f.r0) * (k * (2 - k));      // 先快后慢
        ctx.strokeStyle = rgba(f.color, a * 0.9);
        ctx.lineWidth = f.w * (1 - k * 0.7);
        ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 7); ctx.stroke();
      } else if (f.kind === 'burst') {
        for (var n = 0; n < f.n; n++) {
          var ang = n / f.n * 6.283 + f.seed;
          var dist = 20 + 120 * k;
          ctx.fillStyle = rgba(f.color, a);
          ctx.beginPath();
          ctx.arc(f.x + Math.cos(ang) * dist, f.y + Math.sin(ang) * dist - 30 * k, 3.4 * a + 1, 0, 7);
          ctx.fill();
        }
      }
    }
  };

  /* ==================== 世界物件 ==================== */
  Renderer.prototype.drawRocks = function (rocks) {
    var ctx = this.ctx;
    for (var i = 0; i < rocks.length; i++) {
      var o = rocks[i];
      if(o.tree)continue;
      ctx.fillStyle = 'rgba(0,0,0,.26)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + o.r * 0.55, o.r * 1.02, o.r * 0.45, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#6d6f73';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#83868b';
      ctx.beginPath(); ctx.arc(o.x - o.r * 0.22, o.y - o.r * 0.26, o.r * 0.74, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.13)';
      ctx.beginPath(); ctx.arc(o.x - o.r * 0.32, o.y - o.r * 0.38, o.r * 0.36, 0, 7); ctx.fill();
    }
  };

  /** 地面威胁：预警圈 → 落地闪一下。
   *  视觉刻意和 Boss 的预警圈用同一套语言（画在地面上、圈会收拢），
   *  玩家学会"看到地上的圈就跑开"之后，Boss 的 slam 也顺手看得懂了。 */
  Renderer.prototype.drawHazards = function (list) {
    var ctx = this.ctx, tm = this.lastT;
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      ctx.save();
      /* Boss 造的地面区：预警 = 细亮线/细圈（收拢），生效 = 深色沟/火柱（脉动） */
      if(h.kind==='poison'){
        ctx.strokeStyle='#dda2e4';ctx.lineWidth=2;ctx.fillStyle=h.t>0?'rgba(166,81,178,.12)':'rgba(117,49,136,.55)';
        ctx.beginPath();ctx.arc(h.x,h.y,h.r,0,7);ctx.fill();ctx.stroke();
        if(h.t>0){ctx.beginPath();ctx.arc(h.x,h.y,h.r*Math.max(0,1-h.t/h.total),0,7);ctx.stroke();
          if(h.launched){var flight=Math.max(0,Math.min(1,(.55-h.t)/.55));var px=h.fromX+(h.x-h.fromX)*flight,py=h.fromY+(h.y-h.fromY)*flight-Math.sin(flight*Math.PI)*45;
            ctx.fillStyle='#d5a2d6';ctx.beginPath();ctx.arc(px,py,5,0,7);ctx.fill();}
        }else{ctx.fillStyle='#be7cc7';for(var bubble=0;bubble<3;bubble++){ctx.beginPath();ctx.arc(h.x+Math.cos(bubble*2.1)*13,h.y+Math.sin(bubble*2.1)*10,3,0,7);ctx.fill();}}
        ctx.restore();continue;
      }
      if (h.active) {
        if (h.t > 0) {
          var k = 1 - h.t / Math.max(0.01, h.total);
          ctx.lineCap = 'round';
          ctx.strokeStyle = h.kind === 'fire' ? 'rgba(255,150,80,.85)' : 'rgba(255,205,150,.85)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          if (h.kind === 'crack') { ctx.moveTo(h.x, h.y); ctx.lineTo(h.x2, h.y2); }
          else ctx.arc(h.x, h.y, h.r * (0.3 + 0.7 * k), 0, 7);
          ctx.stroke();
        } else if (h.kind === 'crack') {
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(34,29,26,.8)';                 // 深色沟
          ctx.lineWidth = h.w;
          ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(h.x2, h.y2); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,168,104,' + (0.30 + 0.14 * Math.sin(tm * 7)).toFixed(2) + ')';
          ctx.lineWidth = Math.max(3, h.w * 0.34);               // 沟里的余烬
          ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(h.x2, h.y2); ctx.stroke();
        } else {
          var fl = 0.55 + 0.45 * Math.sin(tm * 9 + h.x * 0.05);
          /* 玩家自己留的火痕（灼痕卡）用偏亮黄绿的色，和 Boss 那片橙红区分开 ——
             玩家要能一眼看出"这是我烧的、可以往里站" vs "那是敌人技能、要躲开"。 */
          ctx.fillStyle = h.friendly
            ? 'rgba(190,235,90,' + (0.20 + 0.14 * fl).toFixed(2) + ')'
            : 'rgba(255,110,50,' + (0.22 + 0.16 * fl).toFixed(2) + ')';
          ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.fill();
          ctx.fillStyle = h.friendly
            ? 'rgba(240,255,170,' + (0.28 + 0.22 * fl).toFixed(2) + ')'
            : 'rgba(255,190,90,' + (0.30 + 0.25 * fl).toFixed(2) + ')';
          ctx.beginPath(); ctx.arc(h.x, h.y, h.r * (0.45 + 0.12 * fl), 0, 7); ctx.fill();
        }
        ctx.restore();
        continue;
      }
      if (h.fired) {
        // 落地余波：实心橙块迅速淡出
        ctx.fillStyle = 'rgba(255,130,70,.40)';
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.fill();
      } else {
        var p = 1 - h.t / Math.max(0.01, h.total);
        ctx.fillStyle = 'rgba(255,120,60,' + (0.07 + 0.20 * p).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(255,175,110,.95)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r * p, 0, 7); ctx.stroke();   // 收拢的圈 = 剩余时间
      }
      ctx.restore();
    }
  };

  /** 墙：带粗度的线段（圆头收尾）。比一列圆石视觉更清楚，也让"沿墙滑行"成立。 */
  Renderer.prototype.drawWalls = function (walls) {
    var ctx = this.ctx;
    if (!walls || !walls.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      ctx.lineWidth = w.r * 2;
      ctx.strokeStyle = '#6a6d73';
      ctx.beginPath(); ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); ctx.stroke();
      ctx.lineWidth = w.r * 1.05;               // 顶面亮一点，看起来有厚度
      ctx.strokeStyle = '#7f8288';
      ctx.beginPath(); ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); ctx.stroke();
    }
    ctx.restore();
  };

  /* 原来这里有个 drawPortal（过关入口：Boss 死后全图随机开一道发光漩涡，跑过去读条过关）。
     2026-10 改成"打死 Boss 直接过关"后整段删除 —— 别留着，留着就会有小地图上的入口点、
     边缘箭头这些指着不存在的东西画的代码。 */

  /** 关卡 HUD：第 N 关 · 名称 / 本关进度（波次 / BOSS / 过关） */
  Renderer.prototype.drawStageHud = function (game) {
    if (!game || game.training) return;
    var ctx = this.ctx, ins = this.insets;
    var label = '第 ' + game.stage + ' 关 · ' + (game.world.stageName || '');
    var sub;
    if (game.clearT > 0) sub = '过关！';
    else if (game.bossAlive > 0) sub = 'BOSS';
    else sub = '波次 ' + Math.min(game.wave, game.cfg.stage.wavesPerStage) + '/' + game.cfg.stage.wavesPerStage;
    if (game.cfg.trial.enabled) { label = '荒原试炼'; sub = game.wave + '/3波 · ' + game.trialObjective(); }
    if(game.rankEligible)label="用时 "+(game.rankSeconds||0).toFixed(1)+"s";
    var cx = this.w / 2, y = 20 + ins.top;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 15px ' + FONT;
    var w1 = ctx.measureText(label).width;
    ctx.font = '600 13px ' + FONT;
    var w2 = ctx.measureText(sub).width;
    var boxW = w1 + w2 + 46;
    ctx.fillStyle = 'rgba(6,10,14,.62)';
    ctx.fillRect(cx - boxW / 2, y - 13, boxW, 26);
    ctx.textAlign = 'left';
    var tx = cx - boxW / 2 + 14;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px ' + FONT;
    ctx.fillText(label, tx, y);
    ctx.fillStyle = (game.clearT > 0 || game.bossAlive > 0) ? '#ffcf7a' : 'rgba(255,255,255,.66)';
    ctx.font = '600 13px ' + FONT;
    ctx.fillText('　' + sub, tx + w1, y);
    ctx.restore();
  };

  /** 入口指引：屏幕外画边缘箭头；站在上面时画读条 */
  /** 过关过场：第 N 关 · 名称 + 上一关成绩 */
  /* 通关成功面板（2026-10 真机需求）。设计口径：
     · 只列**这一关**的东西：成绩三行 + 这关拿到的装备（含过关时自动收的那批）
     · 点任意处继续（不用按钮，真机反馈按钮目标小容易点错）；刚弹出时护栏由核心层管
     · 深色卡片 + 绿色标题，和其它面板同一套语言；没有动画、没有渐变 */
  Renderer.prototype.drawClearPanel = function (game) {
    var ctx = this.ctx, w = this.w, h = this.h;
    var s = game.stageSummary || {}, ci = game.clearInfo || {};
    var got = (s.gained || []).slice(0, 3);
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,10,.72)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    var cw = Math.min(440, w - 48);
    /* +30 是给熟练度块留的高度（两行，见 drawMasteryBlock；和结算页共用同一个画法） */
    var ch = 176 + Math.max(1, got.length) * 36 + 30;
    var cx = w / 2, cy = h / 2, top = cy - ch / 2;
    ctx.fillStyle = 'rgba(10,14,18,.94)';
    ctx.fillRect(cx - cw / 2, top, cw, ch);
    ctx.strokeStyle = 'rgba(143,214,165,.45)'; ctx.lineWidth = 2;
    ctx.strokeRect(cx - cw / 2, top, cw, ch);

    var y = top + 30;
    ctx.fillStyle = '#8fd6a5'; ctx.font = '600 22px ' + FONT;
    ctx.fillText('第 ' + s.stage + ' 关　通关！', cx, y);
    y += 20;
    ctx.fillStyle = '#9aa0a6'; ctx.font = '13px ' + FONT;
    ctx.fillText(s.name || '', cx, y);
    y += 26;
    ctx.fillStyle = '#c7ced4'; ctx.font = '13px ' + FONT;
    ctx.fillText('击杀 ' + s.kills + '　用时 ' + (game.rankEligible?(game.rankSeconds||0):(s.time||0)).toFixed(1) + 's　受伤 ' + s.hits + ' 次', cx, y);
    y += 16;
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - cw / 2 + 24, y); ctx.lineTo(cx + cw / 2 - 24, y); ctx.stroke();
    y += 20;

    if (got.length) {
      for (var i = 0; i < got.length; i++) {
        var rec = got[i], it = rec.item;
        ctx.save();
        ctx.translate(cx - cw / 2 + 38, y - 2);
        if (it.slot === 'weapon') this.drawWeaponIcon(ctx, it.kind, it.color);
        else {
          ctx.fillStyle = it.color;
          ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.stroke();
        }
        ctx.restore();
        ctx.textAlign = 'left';
        ctx.fillStyle = it.color; ctx.font = '600 14px ' + FONT;
        ctx.fillText(it.rarityName + (it.kind ? it.name : it.slotName), cx - cw / 2 + 56, y - 8);
        var af = (it.affixes && it.affixes[0]) ? (it.affixes[0].label + ' ' + it.affixes[0].v) : '';
        if (it.slot === 'weapon') {
          /* 武器是进"武器库"的（见 game.switchWeapon）：这里顺便告诉玩家去哪儿切，
             不然新功能没人知道（左下角那个按钮一进去就看到了）。 */
          af += (af ? '　' : '') + (rec.equipped ? '已装上（武器库里可切回）' : '不如库里的那把（没换）');
        } else if (rec.equipped) {
          af += (af ? '　' : '') + (rec.replaced ? '替换了' + rec.replaced.slotName : '已装备');
        } else {
          af += (af ? '　' : '') + '不如身上的（没换）';
        }
        ctx.fillStyle = '#8b9298'; ctx.font = '12px ' + FONT;
        ctx.fillText(af, cx - cw / 2 + 56, y + 10);
        ctx.textAlign = 'center';
        y += 36;
      }
    } else {
      ctx.fillStyle = '#6f767c'; ctx.font = '13px ' + FONT;
      ctx.fillText('这关没掉装备', cx, y + 6);
      y += 36;
    }

    ctx.textAlign = 'center';
    /* 熟练度块插在"这关拿到什么"下面（和死亡结算页共用同一个画法，一处改两处生效）。
       ⚠️ drawMasteryBlock 会把 textAlign 改成 left/right，画完必须还原成 center ——
          后面那两行"下一关 / 点任意处继续"是靠居中的。 */
    this.drawMasteryBlock(ctx, game, game.masteryInfo(), cx, y + 16);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#b9b6b0'; ctx.font = '13px ' + FONT;
    ctx.fillText(game.rankEligible&&game.rankResult ? game.rankResult.text : ci.complete ? '荒原试炼完成 · 换把武器再挑战' : '下一关：第 ' + (ci.stage || '?') + ' 关 · ' + (ci.name || ''), cx, top + ch - 36);
    var pulse = game.clearGuard > 0 ? 0.35 : (0.55 + 0.45 * Math.abs(Math.sin((this.lastT || 0) * 3.2)));
    ctx.fillStyle = 'rgba(255,209,102,' + pulse.toFixed(2) + ')';
    ctx.font = '600 14px ' + FONT;
    ctx.fillText(ci.complete ? '点击返回首页' : '点任意处继续', cx, top + ch - 15);
    ctx.restore();
  };

  Renderer.prototype.drawStageIntro = function (game) {
    var ctx = this.ctx, W = this.w, H = this.h, s = game.stageSummary;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.58)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 34px sans-serif';
    ctx.fillText('第 ' + game.stage + ' 关 · ' + (game.world.stageName || ''), W / 2, H / 2 - 30);
    if (s) {
      ctx.font = '600 15px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.fillText(s.name + ' 通过　用时 ' + s.time.toFixed(1) + 's　击杀 ' + s.kills +
        '　受伤 ' + s.hits + ' 次', W / 2, H / 2 + 12);
    }
    ctx.font = '600 13px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillText('继续前进', W / 2, H / 2 + 48);
    ctx.restore();
  };

  /* ==================== 敌群（包围事件）的预警与提示 ====================
     全环包围如果不给预警，就是"莫名其妙被围死" —— 这不是难度，是不公平。
     所以：地上先把每个落点标出来（环的位置在触发那一刻就锁死了，玩家跑开圈就偏了），
     屏幕边缘泛红，正中给一行"敌群来袭"。 */
  /* 地面落点标记已删除（2026-10 真机反馈）：本来是想解决"怪在屏幕外生成、玩家看不到"，
     但实际把"从屏幕外涌进来"演成了"按标记刷怪"，而且实心标记还会被误认成已有的怪。
     现在敌群只给：正中"敌群来袭"+ 倒数条 + 四边泛红 + 音效，怪自己从屏幕外冲进来。
     落点数据 warn.pts 仍然要用 —— 它决定怪从哪里生成（环锁定在触发那一瞬，
     所以玩家往哪跑，怪就从身后/侧面涌上来追）。 */

  /**
   * 屏幕空间的敌群提示（2026-10 改小）：四边泛红 + 顶部一个小胶囊（标题 + 倒数条）。
   *
   * ⚠️ 原来是一条**横贯屏幕的 96px 暗带 + 38px 大字**，位置在 H*0.30 = 屏幕偏中间。
   *    敌群是**从四面八方围上来**的，这个提示恰好压在玩家最需要看的地方（真机反馈
   *    "敌群来袭的样式和字样可以小一点，不要挡住视线"）。
   * 现在：
   *   · 提示块缩到 200x46 左右，挪到**关卡栏下面**（y=92，Boss 战期间不会和血条撞 ——
   *     敌群只在没有 Boss 的时候触发，见 game.checkSwarm）
   *   · 字号 38 → 20，"从四面八方围上来了 找空隙冲出去"只在**本局第一次**敌群时显示
   *     （教学一次就够，之后不再多一行字挡视线）
   *   · 四边泛红保持不变：那部分本来就不挡视线，而且它才是真正"扫一眼就知道"的预警
   */
  Renderer.prototype.drawSwarmBanner = function (warn, t, count) {
    if (!warn) return;
    var ctx = this.ctx, W = this.w, H = this.h;
    if (!W || !H) return;
    var k = 1 - Math.max(0, Math.min(1, warn.t / warn.total));
    var pulse = 0.5 + 0.5 * Math.sin(t * 13);
    ctx.save();
    for (var i = 0; i < 4; i++) {                  // 边缘泛红（叠几层 alpha，避免渐变 API）
      var d = 9 + i * 10;
      var a = (0.17 - i * 0.034) * (0.55 + 0.45 * pulse) * (0.45 + 0.55 * k);
      if (a <= 0) continue;
      ctx.fillStyle = 'rgba(255,58,44,' + a.toFixed(3) + ')';
      ctx.fillRect(0, 0, W, d);
      ctx.fillRect(0, H - d, W, d);
      ctx.fillRect(0, 0, d, H);
      ctx.fillRect(W - d, 0, d, H);
    }

    var ins = this.insets || { top: 0 };
    var first = (count === undefined) || (count <= 1);     // 本局第一次 → 多给一行提示
    var cx = W / 2, y = 96 + (ins.top || 0);
    var pw = 128;                                          // 倒数条宽（条走完怪就落地）
    var boxW = 176, boxH = first ? 62 : 44;

    ctx.fillStyle = 'rgba(24,2,0,' + (0.50 + 0.16 * k).toFixed(2) + ')';
    ctx.fillRect(cx - boxW / 2, y - 18, boxW, boxH);
    ctx.fillStyle = 'rgba(255,58,44,' + (0.50 + 0.40 * pulse).toFixed(2) + ')';
    ctx.fillRect(cx - boxW / 2, y - 18, boxW, 2);
    ctx.fillRect(cx - boxW / 2, y - 18 + boxH - 2, boxW, 2);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '800 20px ' + FONT;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(46,0,0,.9)';
    ctx.strokeText('敌群来袭', cx, y);
    ctx.fillStyle = 'rgba(255,110,84,' + (0.85 + 0.15 * pulse).toFixed(2) + ')';
    ctx.fillText('敌群来袭', cx, y);
    if (first) {                                   // 这行提示只在本局第一次敌群时给
      ctx.font = '11.5px ' + FONT;
      ctx.lineWidth = 3;
      ctx.strokeText('找空隙冲出去', cx, y + 17);
      ctx.fillStyle = 'rgba(255,232,224,.92)';
      ctx.fillText('找空隙冲出去', cx, y + 17);
    }

    var px0 = cx - pw / 2, py = first ? y + 32 : y + 14;
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.fillRect(px0, py, pw, 4);
    ctx.fillStyle = 'rgba(255,72,52,.95)';
    ctx.fillRect(px0, py, pw * k, 4);
    ctx.restore();
  };

  /** 角色头顶：只挂「限次爆发」徽标（还剩几刀）。
      ⚠️ 血条/经验条 2026-10 按用户口径从这里**挪进了左上角那张信息卡**（见 drawHud）——
         用户原话"血量和经验值放左上角去"；头顶那组会跟着人跑、压在角色上。
         徽标留在头顶的理由不变：打斗时眼睛盯着角色，"还剩几刀"必须一直看得见。 */
  Renderer.prototype.drawPlayerHp = function (P, t, camY) {
    var B = P.burst;
    if (!B || B.left <= 0) return;              // 没有限次爆发就不画（头顶彻底清空）

    var ctx = this.ctx;
    var bw2 = 112, bh2 = 14;
    /* ⚠️ 不能按 P.r 定位：P.r 是**碰撞半径**（15），角色美术其实画到中心上方约 49px
       （头 + 帽 + 武器挥砍最多也到 -49）→ 按 P.r 放会正压在头上（真机反馈"挡住角色"）。 */
    var SPRITE_TOP = 56;
    var flip = (camY !== undefined) && (P.y - SPRITE_TOP - 10 < camY + 2);
    var bx2 = P.x - bw2 / 2;
    var by2 = flip ? (P.y + P.r + 14) : (P.y - SPRITE_TOP - 6 - bh2);   // 贴地图最上边时翻到脚下

    /* 限次爆发的状态条（2026-10 从屏幕底排挪过来的）：**"还剩几刀"必须一直看得见** ——
       飘字只在起转那一下闪一下，玩家过两秒就忘了自己还剩几刀。
       为什么贴头顶：打斗时眼睛在角色身上；底部那一排（原武器技能格）已经清空，不留常驻信息。 */
    var tint = B.tint || '#ffd166';
    var bPulse = 0.5 + 0.5 * Math.sin(t * 6);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.55)';                       // 薄底衬：压在任何地面上都看得清
    ctx.fillRect(bx2 - 1.5, by2 - 1.5, bw2 + 3, bh2 + 3);
    ctx.fillStyle = B.active ? rgba(tint, 0.24) : rgba(tint, 0.12);
    ctx.fillRect(bx2, by2, bw2, bh2);
    ctx.strokeStyle = rgba(tint, B.active ? (0.7 + 0.3 * bPulse) : 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(bx2 + 0.5, by2 + 0.5, bw2 - 1, bh2 - 1);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 10px ' + FONT;
    ctx.fillStyle = rgba(tint, B.active ? 1 : 0.92);    // 待起转也要看得清（用户口径"还剩几刀一直看得见"）
    ctx.fillText(B.name + (B.active ? ' · 剩 ' + B.left + ' 刀' : ' · 待起转 ' + B.left + ' 刀'),
      P.x, by2 + bh2 / 2 + 0.5);
    ctx.restore();
  };

  Renderer.prototype.drawTelegraph = function (foes) {
    var ctx = this.ctx;
    for (var i = 0; i < foes.length; i++) {
      var f = foes[i];
      if(f.windup>0&&this.inView(f,320)){
        var len=f.chargeRange||160,angle=f.chargeDir||0;
        ctx.save();ctx.translate(f.x,f.y);ctx.rotate(angle);
        ctx.fillStyle='rgba(226,103,65,.14)';ctx.fillRect(0,-f.r,len,f.r*2);
        ctx.strokeStyle='#f2ad75';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(len,0);ctx.lineTo(len-10,-6);ctx.moveTo(len,0);ctx.lineTo(len-10,6);ctx.stroke();ctx.restore();
      }
      /* 荒原巨蝎 · 尾针锁定（2026-10）：一条从蝎子射出去的细亮线 + 远端"收拢"的进度线。
         和冲撞型怪物的粗预警带刻意区分：它是**细线**（打的是一个点/一条窄道），
         颜色用毒绿，和尾针本体发亮同一套色 —— 看到哪根针亮、地上哪条线亮，就是同一件事。 */
      if (f.sting>0&&this.inView(f,460)){
        var sl=f.chargeRange||560,sa2=f.chargeDir||0;
        var sp2=Math.max(0,Math.min(1,1-f.sting/Math.max(0.01,f.stingTotal||1)));
        ctx.save();ctx.translate(f.x,f.y);ctx.rotate(sa2);
        ctx.fillStyle='rgba(200,224,106,.13)';ctx.fillRect(0,-12,sl,24);
        ctx.strokeStyle='rgba(200,224,106,.55)';ctx.lineWidth=1.5;
        ctx.beginPath();ctx.moveTo(0,-12);ctx.lineTo(sl,-12);ctx.moveTo(0,12);ctx.lineTo(sl,12);ctx.stroke();
        // 收拢：亮线从远端往蝎子这边推，推到头就是要放针
        ctx.strokeStyle='rgba(235,255,180,.95)';ctx.lineWidth=3;
        ctx.beginPath();ctx.moveTo(sl-sl*sp2,0);ctx.lineTo(sl,0);ctx.stroke();
        ctx.restore();
      }
      /* 荒原巨蝎 · 双钳夹击：身前扇形（内圈收拢 = 要夹了）。
         扇形贴地画，和震荡波的圈、地面的火/裂痕用同一套"看地面"的语言。 */
      if (f.claw>0&&this.inView(f,240)){
        var cr=(f.clawRange||140)+14,ca=f.clawDir||0,ha=f.clawArc||0.95;
        var cp=Math.max(0,Math.min(1,1-f.claw/Math.max(0.01,f.clawTotal||1)));
        ctx.save();ctx.translate(f.x,f.y);
        ctx.fillStyle='rgba(255,120,70,'+(0.10+0.16*cp).toFixed(3)+')';
        ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,cr,ca-ha,ca+ha);ctx.closePath();ctx.fill();
        ctx.strokeStyle='rgba(255,180,120,.95)';ctx.lineWidth=3;
        ctx.beginPath();ctx.arc(0,0,cr*cp,ca-ha,ca+ha);ctx.stroke();
        ctx.restore();
      }
      if (!f.cast) continue;
      var rad = f.castRadius || 120;
      var p = 1 - f.castT / Math.max(0.01, f.castTotal || 1);
      var isFrost = f.bossType === 'frost';
      ctx.save();
      ctx.fillStyle = isFrost ? 'rgba(90,170,230,' + (0.10 + 0.22 * p).toFixed(3) + ')'
                              : 'rgba(255,90,60,' + (0.10 + 0.22 * p).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(f.castX, f.castY, rad, 0, 7); ctx.fill();
      ctx.strokeStyle = isFrost ? 'rgba(120,200,255,.9)' : 'rgba(255,140,90,.9)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(f.castX, f.castY, rad * p, 0, 7); ctx.stroke();
      ctx.restore();
    }
  };

  Renderer.prototype.drawTrees = function(trees,P,foes){
    var ctx=this.ctx;
    for(var i=0;i<trees.length;i++){var tree=trees[i];if(!this.inView(tree,100))continue;
      var hidden=Math.hypot(P.x-tree.x,P.y-20-(tree.y-40))<tree.crown+26;
      for(var j=0;!hidden&&j<foes.length;j++)if(Math.hypot(foes[j].x-tree.x,foes[j].y-(tree.y-40))<tree.crown+foes[j].r)hidden=true;
      ctx.save();ctx.fillStyle='#67503a';ctx.fillRect(tree.x-7,tree.y-47,14,49);ctx.fillStyle='#8c714a';ctx.fillRect(tree.x-5,tree.y-42,3,39);
      ctx.globalAlpha=hidden?.22:.93;
      for(var k=0;k<3;k++){ctx.fillStyle=['#244b31','#35613a','#497442'][k];ctx.beginPath();ctx.ellipse(tree.x+(k-1)*12,tree.y-45-k*9,tree.crown*(1-k*.15),tree.crown*.7,0,0,7);ctx.fill();}
      ctx.restore();
    }
  };

  Renderer.prototype.inView = function (p, margin) {
    if (this.viewX === undefined) return true;
    return p.x >= this.viewX - margin && p.x <= this.viewX + this.w/(this.zoom||1) + margin &&
           p.y >= this.viewY - margin && p.y <= this.viewY + this.h/(this.zoom||1) + margin;
  };

  Renderer.prototype.drawPickups = function (list, t) {
    var ctx = this.ctx;
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!this.inView(u, 100)) continue;
      var bob = Math.sin(t * 4 + i) * 2;
      ctx.save();
      if (u.kind === 'gold') {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(u.x, u.y + bob, 6, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.beginPath(); ctx.arc(u.x - 2, u.y + bob - 2, 2.2, 0, 7); ctx.fill();
      } else if (u.kind === 'skill') {
        /* 武器技能卷轴（精英掉落）：**一眼认得出"这是技能"，不是金币也不是装备**。
           用户 2026-10 反馈"特效看上去不太好看" ⇒ 把原来那根竖光柱 + 深色字牌换掉：
             · 卷轴画具体：纸卷 + 上下两根轴头 + 三行"字迹"，立着、略微倾斜、轻轻上下浮
             · 落地给一个**普通暗影**（有影子才像放在地上，原来那圈金色光斑很出戏）
             · 想要"找得到"就加脚下一圈柔和的落光（不是能量柱 —— 用户明确讨厌抽象光带/能量环）
             · 挂字挪到卷轴**下方**、只描边不压底框（原来那块深色牌子像 UI 贴在草地上）
           style：'glow'（默认：卷轴 + 地上柔光）/ 'scroll'（只有卷轴）/ 'pillar'（改动前那版，留作对照）。 */
        var sk = (this.cfg && this.cfg.pickups && this.cfg.pickups.skill) || {};
        var card = null, ups = (this.cfg && this.cfg.upgrades) || [];
        for (var ci = 0; ci < ups.length; ci++) if (ups[ci].id === u.skill) card = ups[ci];
        var wname = (card && this.cfg.weapons[card.weapon]) ? this.cfg.weapons[card.weapon].name : '';
        var style = this.scrollStyle || 'glow';
        /* 名字要写**具体技能名**（2026-10 用户口径："掉落的技能都显示出具体的名字"），
           后面跟武器名做归属 —— 例如"穿云剑气 · 长剑"。
           查不到技能名（异常 id / 老存档）时退回通用文案，别显示空白。 */
        var sname = (card && card.name) || '';
        var txt = (sname || sk.label || '武器技能') + (wname ? ' · ' + wname : '');
        if (style === 'pillar') {
          var pil = sk.pillar || 40;
          ctx.globalAlpha = 0.32;
          ctx.fillStyle = '#ffd166';
          ctx.beginPath(); ctx.ellipse(u.x, u.y + 4, 20, 8, 0, 0, 7); ctx.fill();
          ctx.globalAlpha = 0.5;
          ctx.fillRect(u.x - 2, u.y - pil + bob, 4, pil);
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#f3e2b6';
          ctx.fillRect(u.x - 8, u.y - 6 + bob, 16, 13);
          ctx.strokeStyle = '#8a6d2f'; ctx.lineWidth = 1.2;
          ctx.strokeRect(u.x - 8, u.y - 6 + bob, 16, 13);
          ctx.fillStyle = '#c9a24a';
          ctx.fillRect(u.x - 10.5, u.y - 8.4 + bob, 21, 3.4);
          ctx.fillRect(u.x - 10.5, u.y + 5 + bob, 21, 3.4);
        } else {
          var magic = style === 'magic';
          /* 6) 周期性脉冲：每 2.5s「亮一下再落回」（快起慢落，纯 t 算 —— 断言可复现）。
             打仗时满地都是东西，光靠"慢慢呼吸"远处根本注意不到，脉冲是给余光用的。 */
          var pp = (t % 2.5) / 2.5;
          var pulse = Math.pow(Math.max(0, 1 - pp / 0.35), 2);
          ctx.globalAlpha = 0.26;
          ctx.fillStyle = '#0b0f12';
          ctx.beginPath(); ctx.ellipse(u.x, u.y + 8, 12, 4.4, 0, 0, 7); ctx.fill();
          ctx.globalAlpha = 1;
          if (style !== 'scroll') {                     // 脚下一圈柔和的落光（呼吸 + 脉冲叠加，两层出层次）
            var gp = 0.5 + 0.5 * Math.sin(t * 3);
            /* 颜色偏白（#ffe9a8 而不是饱和金）：叠在草地上才像"光"，饱和金叠绿会变成一块发白的绿斑 */
            ctx.fillStyle = '#ffe9a8';
            /* 透明度 +0.04（2026-10 口径："卷轴做得更显眼一点"）—— 原来那层柔光在草地上偏淡 */
            ctx.globalAlpha = 0.14 + 0.08 * gp + 0.20 * pulse;
            ctx.beginPath(); ctx.ellipse(u.x, u.y + 7, 18 + gp * 2.5 + pulse * 4, 7 + gp * 1 + pulse * 1.6, 0, 0, 7); ctx.fill();
            ctx.globalAlpha = 0.05 + 0.07 * pulse;
            ctx.beginPath(); ctx.ellipse(u.x, u.y + 7, 25 + pulse * 5, 9.4 + pulse * 2, 0, 0, 7); ctx.fill();
            ctx.globalAlpha = 1;
          }
          if (magic) {
            /* 4) 上升的金色小火星：4 颗，相位错开，从地面往上飘 21px 边飘边淡（有生命感，
               不吸附的掉落物最怕"看着像装饰品"）。画在卷轴**之前**，飞过卷轴背后才像立体的。 */
            for (var sp = 0; sp < 4; sp++) {
              var su = (t * 0.62 + sp * 0.27) % 1;
              var sx2 = u.x + Math.sin(su * 6.28 + sp * 1.7) * 5.5;
              var sy2 = u.y + 4 - su * 21;
              ctx.fillStyle = '#ffe9a8';
              ctx.globalAlpha = Math.min(su * 6, 1) * (1 - su) * 0.22;
              ctx.beginPath(); ctx.arc(sx2, sy2, 2.8 - su * 0.8, 0, 7); ctx.fill();
              ctx.globalAlpha = Math.min(su * 6, 1) * (1 - su) * 0.8;
              ctx.beginPath(); ctx.arc(sx2, sy2, 1.7 - su * 0.4, 0, 7); ctx.fill();
            }
            ctx.globalAlpha = 1;
          }
          ctx.save();
          ctx.translate(u.x, u.y + bob - 4);
          ctx.rotate(-0.1);
          ctx.fillStyle = '#f7ecd4';                    // 纸卷
          ctx.fillRect(-7.5, -6.5, 15, 13);
          ctx.strokeStyle = pulse > 0.02 ? '#ffdf8a' : '#9a7a34';   // 脉冲那一刻金边提亮
          ctx.lineWidth = 1.1 + pulse * 0.8;
          ctx.strokeRect(-7.5, -6.5, 15, 13);
          ctx.strokeStyle = 'rgba(122,95,44,.55)'; ctx.lineWidth = 1;   // 三行"字迹"：看得出是写过的卷
          for (var li = -1; li <= 1; li++) {
            ctx.beginPath();
            ctx.moveTo(-5, li * 3); ctx.lineTo(li === 0 ? 3.5 : 5, li * 3);
            ctx.stroke();
          }
          for (var ax = -1; ax <= 1; ax += 2) {         // 上下两根轴头
            ctx.fillStyle = '#c9a24a';
            pathRoundRect(ctx, -10, ax * 7.2 - 3.6, 20, 7.2, 3.6);
            ctx.fill();
            ctx.strokeStyle = '#7d5f22'; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,' + (0.45 + 0.5 * pulse) + ')';
            ctx.fillRect(-6.5, ax * 7.2 - 2.4, 13, 1.2);
          }
          ctx.restore();
          if (magic) {
            /* 3) 四周小星点闪烁：5 颗钉在卷轴周围（从正上方起均匀一圈），相位各自错开。
               sin^3 让它「闪一下」而不是匀速呼吸 —— 匀速呼吸像灯泡，闪一下才叫"闪耀"。
               ⚠️ 芯要小、芒要细长：一开始芯半径给到 3.7px，真实尺寸下糊成一团白点（不像星）。
               太暗的直接跳过：省算力，也免得糊在一起变成脏黄。 */
            ctx.fillStyle = '#fffdf2'; ctx.strokeStyle = '#fffdf2';
            for (var st = 0; st < 5; st++) {
              var tw = Math.max(0, Math.sin(t * 2.6 + st * 1.7));
              tw = tw * tw * tw;
              if (tw < 0.04) continue;
              var ang = -1.5708 + st * 1.2566;
              var stx = u.x + Math.cos(ang) * 13, sty = u.y - 5 + Math.sin(ang) * 9;
              var core = 1.0 + tw * 1.5;
              var arm = core * (1.9 + tw * 1.4);
              ctx.globalAlpha = 0.35 + 0.55 * tw;
              ctx.beginPath(); ctx.arc(stx, sty, core, 0, 7); ctx.fill();
              ctx.globalAlpha = 0.30 + 0.60 * tw;
              ctx.lineWidth = 0.9 + tw * 0.5;
              ctx.beginPath();                          // 十字芒：一眼认出是"闪"不是"点"
              ctx.moveTo(stx - arm, sty); ctx.lineTo(stx + arm, sty);
              ctx.moveTo(stx, sty - arm); ctx.lineTo(stx, sty + arm);
              ctx.stroke();
              if (tw > 0.85) {                          // 最亮那一下补一道 45° 斜芒 —— 那个"叮"
                var k2 = (tw - 0.85) / 0.15, d2 = arm * 0.62;
                ctx.globalAlpha = 0.5 * k2; ctx.lineWidth = 0.9;
                ctx.beginPath();
                ctx.moveTo(stx - d2, sty - d2); ctx.lineTo(stx + d2, sty + d2);
                ctx.moveTo(stx + d2, sty - d2); ctx.lineTo(stx - d2, sty + d2);
                ctx.stroke();
              }
            }
            ctx.globalAlpha = 1;
          }
        }
        /* 字号 +1.5px（2026-10 用户口径：落地卷轴"做得更显眼/更明确"）——
           名字变长（技能名 + 武器名）之后，原 11px 在真机上偏小。 */
        ctx.font = '700 12.5px ' + FONT;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(10,14,18,.9)'; ctx.lineWidth = 3.2;
        ctx.fillStyle = '#ffe9a8';
        ctx.strokeText(txt, u.x, u.y + 21);
        ctx.fillText(txt, u.x, u.y + 21);
        ctx.textBaseline = 'alphabetic';
      } else {
        var col = u.item.color;
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.ellipse(u.x, u.y + 4, 18, 8, 0, 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
        // 稀有度越高光柱越高，远远就能看出"这掉了个好东西"
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = col;
        ctx.fillRect(u.x - 1.6, u.y - 14 - u.item.rarity * 7 + bob, 3.2, 14 + u.item.rarity * 7);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(u.x, u.y + bob, 9, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.8)';
        ctx.beginPath(); ctx.arc(u.x - 2.5, u.y + bob - 2.5, 3, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
  };

  /**
   * 技能卷轴的**光柱层**（2026-10 用户口径："你在做一个光柱的效果吧，不然如果怪物太多会被覆盖住"）。
   *
   * ⚠️ **必须单独一层、画在 drawFoes 之后**：卷轴本体和地上那圈柔光都在 drawPickups 里
   *    （怪下面），怪一多就把卷轴整个盖住 —— 只有画在怪之后，才谈得上"怪物再多也压不住"。
   *
   * ⚠️ 形态是用户选的 (d)：**上升光尘柱（主）+ 一层很淡的光晕底衬**。
   *    为什么不画成实心能量柱：同一位用户更早明确否过那一版（原话记在 drawPickups 的注释里：
   *    "不是能量柱 —— 用户明确讨厌抽象光带/能量环"）。
   *    所以：光尘负责"看起来是有东西在往上飘"（不像抽象光带），淡柱负责"草地上找得到"。
   *
   * ⚠️ 不用 createLinearGradient（项目禁用：假 ctx 会崩 / 跨端不齐）—— 渐隐用 4 段矩形叠出来。
   * ⚠️ 不吸附/不消失/出屏箭头那几条规矩一条都没变，这里只是"让它看得见"。
   * 只给 u.kind === 'skill' 画；金币/装备不画（不然满地都是柱子）。
   */
  Renderer.prototype.drawScrollBeams = function (list, t) {
    var ctx = this.ctx, sk = (this.cfg && this.cfg.pickups && this.cfg.pickups.skill) || {};
    var B = sk.beam || {};
    var H = B.h || 120, W = B.w || 14, MOTES = B.motes || 9;
    var col = B.color || '#ffe9a8', core = B.core || '#fffdf2';

    /* 一根"柔光竖条"：多段矩形叠出来（项目禁用渐变对象），alpha 用 pow 衰减 + 宽度随高度收窄。
       ⚠️ 每一层都必须走这里 —— 任何一层"等亮到顶"都会露出**齐平截断**。
       ⚠️ 段数给到 18：段数少（试过 4、6）时每段的 alpha 台阶肉眼可见 —— 出图放大就是一条"积木柱"，
          顶上还会留一块更亮的"帽"。段多了台阶才化掉，成本只是几次 fillRect（一屏最多 1~2 根柱子）。 */
    var softBar = function (x, base, h, w, aMax, fall, color, kb) {
      var N = 18, sh = h / N;
      for (var s = 0; s < N; s++) {                          // s = 0 是**最底**那一段
        var k = s / (N - 1);                                 // 0 = 底部（最亮最粗）→ 1 = 顶部（淡到没有）
        ctx.globalAlpha = Math.min(1, aMax * Math.pow(1 - k, fall) * kb);
        ctx.fillStyle = color;
        var ww = w * (1 - 0.5 * k);
        /* ⚠️ 坐标必须是 base-(s+1)*sh：写成 base-h+s*sh 的话 s 是从**顶部**往下数的，
           k 的含义就反了 —— 表现是"柱子上扣了一顶更亮的帽子"（出图放大一眼就看出来，
           纯靠读代码没发现）。 */
        ctx.fillRect(x - ww / 2, base - (s + 1) * sh, ww, sh + 0.6);   // 轻微重叠，避免分数像素留缝
      }
    };

    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u || u.kind !== 'skill' || !this.inView(u, 100)) continue;
      var bob = Math.sin(t * 4 + i) * 2;              // 和卷轴本体同一个 bob（否则柱子会离地飘）
      var x = u.x, base = u.y + bob;
      /* 脉冲/呼吸和卷轴本体那套**同一节拍**（每 2.5s 亮一下）——两边不同步会看着像两个东西 */
      var pp = (t % 2.5) / 2.5, pulse = Math.pow(Math.max(0, 1 - pp / 0.35), 2);
      var breath = 0.5 + 0.5 * Math.sin(t * 3);
      var kb = 0.85 + 0.35 * breath + 0.5 * pulse;
      ctx.save();
      /* ⚠️ 用 'lighter' 叠加而不是普通覆盖：金色低透明度直接盖在草地上会**变成一根灰绿的条**
         （第一版就是这个毛病 —— 出图放大才发现"看不出是光"）。
         可关：config 里 beam.additive = false 就退回普通覆盖（万一某机型基础库表现不对，改一个布尔值）。 */
      if (B.additive !== false) ctx.globalCompositeOperation = 'lighter';
      softBar(x, base, H,        W,         0.40, 1.8,  col,  kb);   // 外层：金色光晕（衰减陡，保住"一束光"的形）
      softBar(x, base, H * 0.88, W * 0.60,  0.24, 1.6,  col,  kb);   // 中层：把两侧硬边垫柔
      /* 柱芯：细白亮线，**衰减要比外层缓**——怪堆里能看见全靠它（外层那种陡衰减在密密麻麻的
         怪身上会被吃掉，第一轮出图就是这样：空地上好看、怪堆里几乎看不见）。 */
      softBar(x, base, H * 0.92, 3.2,       0.55, 1.05, core, kb);
      /* 贴地亮核：把"柱子是从卷轴上起来的"这件事做实（不是凭空一根光） */
      ctx.globalAlpha = Math.min(1, 0.24 + 0.22 * breath + 0.34 * pulse);
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.ellipse(x, base + 2, 14, 5.4, 0, 0, 7); ctx.fill();
      /* 上升光尘：motes 颗小菱片，相位错开，边升边淡（纯 t 算，断言可复现） */
      for (var m = 0; m < MOTES; m++) {
        var mu = (t * 0.34 + m / MOTES) % 1;                     // 0 = 贴地，1 = 柱顶
        var a = Math.min(mu * 5, 1) * (1 - mu);                  // 起手淡入、到顶淡出
        if (a <= 0.02) continue;
        var my = base - 6 - mu * H, mx = x + Math.sin(mu * 5.2 + m * 1.7) * (8 - 4 * mu);
        var rr = 3.0 - 1.7 * mu;
        ctx.globalAlpha = Math.min(1, a * (0.75 + 0.35 * pulse));
        ctx.fillStyle = (m % 2) ? core : col;
        ctx.beginPath();
        ctx.moveTo(mx, my - rr); ctx.lineTo(mx + rr, my);
        ctx.lineTo(mx, my + rr); ctx.lineTo(mx - rr, my); ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  };

  /**
   * 出屏的技能卷轴：在屏幕边缘画一个指向它的金色箭头。
   * 用户口径是"掉落不消失、等玩家自己来捡" —— 那必须配指路，否则掉在视野外就等于永久失踪。
   * ⚠️ 这段是**新写的**：原来那套出屏箭头（传送门入口指引）在"打死 Boss 直接过关"那轮
   *    连同 drawPortal 一起删掉了，这里顺着同一条思路重来一份。
   * 屏幕坐标 = (世界 − cam) × zoom（和 draw() 里那个 transform 保持一致）。
   */
  Renderer.prototype.drawScrollGuides = function (game) {
    var list = (game && game.pickups) || [];
    var ctx = this.ctx, pad = 28, zoom = this.zoom || 1, cam = game.cam;
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.kind !== 'skill' || this.inView(u, 40)) continue;
      var sx = (u.x - cam.x) * zoom, sy = (u.y - cam.y) * zoom;
      var cx = Math.max(pad, Math.min(this.w - pad, sx));
      /* 上边多让 46px：顶部那条是关卡栏 + 精英血条/文案，箭头别挤进去（右下角是暂停键，也比 pad 更靠里一点） */
      var cy = Math.max(pad + 46, Math.min(this.h - pad - (this.insets.bottom || 0), sy));
      var a = Math.atan2(sy - cy, sx - cx);
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = 'rgba(255,209,102,.92)';
      ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, 7.5); ctx.lineTo(-7, -7.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(20,24,28,.85)'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.restore();
    }
  };

  Renderer.prototype.drawProjectiles = function (list) {
    var ctx = this.ctx;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!this.inView(p, 40)) continue;
      ctx.save();
      if (p.skillShape) {
        ctx.translate(p.x, p.y); ctx.rotate(p.skillShape === 'return' ? p.t * 16 : p.angle);
        ctx.strokeStyle = p.color; ctx.lineWidth = p.skillShape === 'wave' ? 6 : 4;
        ctx.beginPath();
        if (p.skillShape === 'wave') ctx.arc(-10, 0, 24, -1.1, 1.1);
        else { ctx.moveTo(-17, -9); ctx.lineTo(17, 0); ctx.lineTo(-17, 9); }
        ctx.stroke(); ctx.restore(); continue;
      }
      if (p.spike) {                                 // 荒原巨蝎的尾针毒刺：细长针形（不是圆点）
        ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(p.vy, p.vx));
        ctx.fillStyle = p.color; ctx.shadowColor = p.color;
        ctx.shadowBlur = list.length > 35 ? 0 : 10;
        ctx.beginPath();
        ctx.moveTo(-p.r * 2.6, 0); ctx.lineTo(p.r * 1.2, -p.r * 0.5);
        ctx.lineTo(p.r * 1.2, p.r * 0.5); ctx.closePath(); ctx.fill();
        ctx.restore(); continue;
      }
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = list.length > 35 ? 0 : 12;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      ctx.restore();
    }
  };

  /* ==================== 敌人 ==================== */
  /**
   * 精英 / Boss 的显示名：「类型 · 名字」（2026-10 用户口径：精英写「精英」、Boss 写「领主」，
   * 中间用" · "隔开）。**头顶名字和顶部血条共用这一处** —— 两处各写一份的话，
   * 以后改文案必然走偏（"精英 铁甲母蟹" vs "精英 · 铁甲母蟹"就是这么来的）。
   * 类型词在 config.ui.foeType，一处可改。没有类型（配置缺字段）时退回纯名字。
   */
  function foeLabel(ui, f) {
    var ft = (ui && ui.foeType) || {};
    var tp = f.kind === 'boss' ? (ft.boss || '') : (f.trialElite ? (ft.elite || '') : '');
    return (tp ? tp + ' · ' : '') + (f.name || '');
  }

  /**
   * 精英 / Boss 的"身份标识"（2026-10 用户口径："精英怪应该要和其他怪有一些标识"）：
   *   · 脚下一圈地面光环（贴地椭圆）—— 走位时余光就能看到"这只不能当普通怪处理"
   *   · 头顶一个**菱形**（原来是个 4px 的圆点，在怪堆里几乎看不见）
   * 颜色：
   *   · **有头顶名字**的精英 / Boss 用紫色（ELITE_NAME_COLOR，和名字同一支颜色）——
   *     2026-10 用户口径："精英和领主底下的那个圈也改成紫色"；
   *   · 随机词缀怪仍用 affix.color（它的外圈/菱形都是这个词缀色，图例见 docs/design-sheet.html）。
   * Boss 没有 affix、也没有菱形，只走这一圈地面光环（见 drawFoes 里那条单独的预渲染循环）。
   * ⚠️ 和玩家身上的低血红光/狂热金光不是一套颜色（那是玩家、这是怪），别用红/金画怪。
   * ap = 呼吸相位（0..1），由调用方从 t 算好传进来（和其它精英表现同一节奏）。
   */
  Renderer.prototype.drawEliteMark = function (f, t, ap) {
    var ctx0 = this.ctx;
    if (!f) return;
    var named = !!(f.trialElite || f.kind === 'boss');
    if (!f.affix && !named) return;                    // 既没词缀又不是 Boss/教学精英：不是精英
    var col = named ? ELITE_NAME_COLOR : (f.affix.color || '#ffd166');
    var pulse = ap === undefined ? (0.5 + 0.5 * Math.sin(t * 5)) : ap;
    /* Boss 个子大（r=40）、脚下的地面平面更低（影子画在 y+r*0.72，见 drawBoss），
       光环位置/扁度按它调一档 —— 沿用精英那套的话这个圈会压在身体上。 */
    var boss = f.kind === 'boss';
    var ry0 = f.r * (boss ? 0.55 : 0.60) + pulse * 1.5;
    ctx0.save();
    /* 脚下圈：先压一圈深色底，再画亮色 —— 草地上不压底会"糊进去" */
    ctx0.globalAlpha = 0.55;
    ctx0.strokeStyle = 'rgba(8,12,16,.8)';
    ctx0.lineWidth = 6.5;
    ctx0.beginPath();
    ctx0.ellipse(f.x, f.y + (boss ? f.r * 0.72 : 4), f.r * 1.35, ry0, 0, 0, 7);
    ctx0.stroke();
    ctx0.globalAlpha = 0.50 + 0.40 * pulse;
    ctx0.strokeStyle = col;
    ctx0.lineWidth = 3;
    ctx0.beginPath();
    ctx0.ellipse(f.x, f.y + (boss ? f.r * 0.72 : 4), f.r * 1.35, ry0, 0, 0, 7);
    ctx0.stroke();
    /* 头顶菱形。⚠️ 2026-10 用户口径："精英头上的棱形图标去掉吧" —— 指的是**已经有头顶名字**
       的那两类（教学精英 / Boss）：名字本身就带类型前缀「精英 · 铁甲母蟹」，再顶个菱形纯属重复。
       **随机词缀怪保留菱形**：它没有专属名字，菱形是它唯一的"头顶标识"
       （去掉就没法在头顶一眼分出它和普通杂兵了）—— 要去掉说一声，这里换成一个统一的开关。 */
    if (!(f.trialElite || f.kind === 'boss')) {
      var dy = f.y - f.r - 23, dr = 6.5 + pulse * 0.6;
      ctx0.globalAlpha = 1;
      ctx0.beginPath();
      ctx0.moveTo(f.x, dy - dr); ctx0.lineTo(f.x + dr, dy);
      ctx0.lineTo(f.x, dy + dr); ctx0.lineTo(f.x - dr, dy); ctx0.closePath();
      ctx0.fillStyle = col;
      ctx0.fill();
      ctx0.strokeStyle = 'rgba(8,12,16,.9)'; ctx0.lineWidth = 2; ctx0.stroke();
    }
    ctx0.restore();
  };

  /**
   * 精英 / Boss 的**头顶名字**（2026-10 用户口径：精英怪和 Boss 头顶显示对应的名字，
   * 颜色用紫色；名字前面带**类型前缀** —— 精英写「精英」、Boss 写「领主」，中间用" · "隔开）。
   * 只画"有专属名字"的这两类：
   *   · 杂兵不画 —— 怪堆里几十只都挂上名字，屏幕就只剩字了；
   *   · 随机词缀精英也不画 —— 它没有专属名字（只有类型名"裂壳爬虫"），
   *     挂上类型名反而误导"这只是特殊的"（它特殊的是词缀，不是身份）。
   * 位置：精英头顶线在 y-r-38；Boss 没菱形、个子大（r=40），贴在头顶上方即可。
   * ⚠️ 名字用深色描边（和卷轴/飘字同一套做法）：紫色叠在草地或石林上，没描边会糊掉。
   * @returns 画出去的文字（没画则空串，便于无头测试断言）
   */
  Renderer.prototype.drawFoeName = function (f) {
    var ctx = this.ctx, nm = f && f.name;
    if (!nm) return '';
    var big = f.kind === 'boss';
    var label = foeLabel(this.cfg && this.cfg.ui, f);   // 「精英 · 铁甲母蟹」/「领主 · 荒原巨蝎」
    ctx.font = (big ? '700 15px ' : '700 12.5px ') + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(10,14,18,.92)';
    ctx.lineWidth = big ? 4 : 3.4;
    ctx.fillStyle = ELITE_NAME_COLOR;
    var ny = f.y - f.r - (big ? 30 : 38);
    ctx.strokeText(label, f.x, ny);
    ctx.fillText(label, f.x, ny);
    ctx.textBaseline = 'alphabetic';
    return label;
  };

  Renderer.prototype.drawFoes = function (foes, t) {
    var ctx0 = this.ctx;

    /* 精英 / Boss 的身份表现（画在身体**之前**，所以是"围着它的圈"，不是贴纸）：
       身体外圈（呼吸，仅精英）+ 脚下贴地光环（精英和 Boss 都有，见 drawEliteMark）。
       玩家要能一眼认出"哪只是精英、哪只要爆"，才谈得上"先打谁"的决策。
       ④ 强化（2026-10）：原来只有一圈细线 —— 在怪堆里基本看不见，等于没做。
       现在 = 深色底圈（压在任何地面上都分得出来）+ 亮色呼吸圈。
       2026-10 再加：脚下一圈地面光环 + 头顶小点改成**菱形**（见 drawEliteMark）。
       ⚠️ 同日更新：**已经有头顶名字**的精英/Boss 不再画菱形（名字里带类型前缀「精英 · 铁甲母蟹」，
       菱形是重复的）；随机词缀怪没有名字，菱形保留 —— 见 drawEliteMark 里那行 if。
       颜色（2026-10 用户口径："一起改紫吧"）：**有名字**的精英/Boss（含领主的身体外圈）
       统一用紫色 ELITE_NAME_COLOR —— 名字、身体外圈、脚下光环三处一共就一支紫；
       随机词缀怪仍用 affix.color（它的圈/菱形和词缀表一一对应，图例见 docs/design-sheet.html）。 */
    for (var ai = 0; ai < foes.length; ai++) {
      var ef = foes[ai];
      if (!ef || !this.inView(ef, 160)) continue;
      var named = !!(ef.trialElite || ef.kind === 'boss');
      if (!ef.affix && !named) continue;               // 既没词缀又不是精英/Boss：跳过
      var ap = 0.5 + 0.5 * Math.sin(t * 5 + ai);
      /* 围着身体的那圈（呼吸圈）：**Boss 不画**。2026-10 用户口径："为啥看 boss 很怪，
         有两个圈——底下一个圆圈，周围一个圆圈？周围的圆圈去掉吧"。
         原因：Boss 个子大（r=40），身体圈（r+6）和脚下贴地圈（r×1.35）尺寸挨得太近，
         看着像画重了。Boss 只留脚下那圈紫色地面光环（见 drawEliteMark）。
         ⚠️ 教学精英照旧保留这一圈 —— 它混在怪堆里，需要"围着它的一圈"才分得出来；
            Boss 是单挑、体型也够大，不需要。 */
      if (ef.kind !== 'boss') {
        ctx0.save();
        ctx0.strokeStyle = 'rgba(8,12,16,.75)';
        ctx0.lineWidth = 7;
        ctx0.beginPath(); ctx0.arc(ef.x, ef.y, ef.r + 6 + ap * 2, 0, 7); ctx0.stroke();
        ctx0.globalAlpha = 0.55 + 0.40 * ap;
        ctx0.strokeStyle = named ? ELITE_NAME_COLOR : ef.affix.color;
        ctx0.lineWidth = 3.4;
        ctx0.beginPath(); ctx0.arc(ef.x, ef.y, ef.r + 6 + ap * 2, 0, 7); ctx0.stroke();
        ctx0.restore();
      }
      this.drawEliteMark(ef, t, ap);
    }
    /* ⚠️ Boss 也走上面那条循环（它没有 affix，靠 `named` 进来）——
       所以**不要**再单独写一条"只给 Boss 画圈"的循环，否则领主的圈会画两遍（叠加变亮）。 */
    for (var i = 0; i < foes.length; i++) {
      var f = foes[i];
      if (!this.inView(f, 160)) continue;
      var elite = !!(f.affix && f.kind !== 'boss');
      if (elite) {                       // 精英略大一圈：远看就能分出"这只不一样"
        ctx0.save();
        ctx0.translate(f.x, f.y); ctx0.scale(1.09, 1.09); ctx0.translate(-f.x, -f.y);
      }
      if(f.type==='spitter')this.drawSpitter(f,t);
      else if (f.kind !== 'boss' && (f.type === 'slime' || f.type === 'tank' || f.type === 'charger')) this.drawAberration(f,t);
      else if (f.shape === 'boss') this.drawBoss(f, t);
      else if (f.shape === 'horn') this.drawHorn(f, t);
      else this.drawCreature(f, t);          // jelly / cone / shell / sac / husk
      if (elite) ctx0.restore();
      /* 精英 / Boss 头顶名字（紫色）：只这两类有专属名字，见 drawFoeName。 */
      if (f.trialElite || f.kind === 'boss') this.drawFoeName(f);
      if (f.kind !== 'boss' && f.hp < f.maxhp) {
        var ctx = this.ctx;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fillRect(f.x - 16, f.y - f.r - 13, 32, 4);
        ctx.fillStyle = '#e06c6c';
        ctx.fillRect(f.x - 16, f.y - f.r - 13, 32 * (f.hp / f.maxhp), 4);
      }
    }
  };

  Renderer.prototype.drawSpitter=function(f,t){
    var ctx=this.ctx,r=f.r,pulse=f.spitWindup>0?1.12+.08*Math.sin(t*20):1;
    ctx.save();ctx.translate(f.x,f.y);ctx.rotate(Math.atan2(f.aimY||0,f.aimX||1));
    ctx.strokeStyle='#302335';ctx.lineWidth=3;
    for(var side=-1;side<=1;side+=2){ctx.beginPath();ctx.moveTo(-10,side*8);ctx.lineTo(-18,side*18);ctx.moveTo(5,side*8);ctx.lineTo(13,side*17);ctx.stroke();}
    ctx.fillStyle=f.hurt>0?'#c8aac9':'#604c69';ctx.beginPath();ctx.ellipse(-4,0,r*pulse,r*.9*pulse,0,0,7);ctx.fill();ctx.stroke();
    ctx.strokeStyle=f.spitWindup>0?'#f5bded':'#ab7db1';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(-7,0,r*.6*pulse,r*.67*pulse,0,0,7);ctx.stroke();
    ctx.fillStyle='#b17bba';for(var i=0;i<3;i++){ctx.beginPath();ctx.arc(-8+i*5,(i%2?1:-1)*6,3.5,0,7);ctx.fill();}
    ctx.fillStyle='#352d3a';ctx.beginPath();ctx.ellipse(r*.65,0,8,5,0,0,7);ctx.fill();ctx.fillStyle='#e5a2ca';ctx.fillRect(r*.65,-2,7,4);ctx.restore();
  };

  // Bounded vector silhouettes: three leg strokes per side, no gradients or per-foe canvas.
  Renderer.prototype.drawAberration = function(f,t){
    var ctx=this.ctx,r=f.r,crab=f.type==='tank'||f.trialElite,spider=f.type==='charger'&&!f.trialElite;
    var phase=f.ph||0,wind=f.windup>0,angle=(f.charging>0||wind)?f.chargeDir:Math.atan2(f.aimY||0,f.aimX||1);
    ctx.save();ctx.translate(f.x,f.y);
    ctx.fillStyle='rgba(6,9,13,.3)';ctx.beginPath();ctx.ellipse(0,4,r*1.2,r*.68,0,0,7);ctx.fill();
    ctx.rotate(angle);
    var compress=wind?.84:1;ctx.scale(f.charging>0?1.15:compress,wind?1.1:1);
    ctx.lineCap='round';ctx.lineJoin='round';
    // Angular alternating feet reach outside the shell, without changing collision radius.
    ctx.strokeStyle=wind?'#d9a178':'#323039';ctx.lineWidth=crab?3:2.4;
    for(var side=-1;side<=1;side+=2){ctx.beginPath();
      for(var leg=0;leg<3;leg++){var lx=(leg-1)*r*.55,sway=Math.sin(phase*2+leg*2+side)*r*.1;
        ctx.moveTo(lx,side*r*.35);ctx.lineTo(lx-r*.25+sway,side*r*(spider?1.12:.94));ctx.lineTo(lx+r*.2+sway,side*r*(spider?1.48:1.2));}
      ctx.stroke();
    }
    ctx.fillStyle=f.hurt>0?'#b9a9a2':crab?'#6b6b54':spider?'#554452':'#696272';ctx.strokeStyle='#28242e';ctx.lineWidth=2;
    ctx.beginPath();
    if(crab){ctx.moveTo(r*.76,0);ctx.lineTo(r*.42,-r*.81);ctx.lineTo(-r*.62,-r*.88);ctx.lineTo(-r*.96,-r*.22);ctx.lineTo(-r*.75,r*.76);ctx.lineTo(r*.4,r*.82);}
    else{ctx.moveTo(r*.84,0);ctx.lineTo(r*.26,-r*.59);ctx.lineTo(-r*.55,-r*(spider?.55:.72));ctx.lineTo(-r*.98,0);ctx.lineTo(-r*.55,r*(spider?.55:.72));ctx.lineTo(r*.26,r*.59);}
    ctx.closePath();ctx.fill();ctx.stroke();
    // Broken plate edges and a thin red fissure, rather than smiling facial features.
    ctx.strokeStyle=crab?'#a7a084':'#a399ab';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(-r*.75,-r*.15);ctx.lineTo(-r*.46,-r*.5);ctx.lineTo(r*.2,-r*.38);ctx.stroke();
    ctx.strokeStyle=wind?'#ffb17b':'#b55255';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(-r*.62,0);ctx.lineTo(-r*.22,-r*.17);ctx.lineTo(0,r*.12);ctx.lineTo(r*.38,0);ctx.stroke();
    if(crab){
      ctx.fillStyle=f.trialElite?'#aaa087':'#89866b';ctx.strokeStyle='#342e30';ctx.lineWidth=2;
      for(var claw=-1;claw<=1;claw+=2){var size=claw<0?1:.76;
        ctx.beginPath();ctx.moveTo(r*.4,claw*r*.5);ctx.lineTo(r*1.04,claw*r*1.13*size);ctx.lineTo(r*1.55,claw*r*.78*size);ctx.lineTo(r*1.11,claw*r*.66*size);ctx.lineTo(r*1.47,claw*r*.38*size);ctx.lineTo(r*.83,claw*r*.36);ctx.closePath();ctx.fill();ctx.stroke();}
      ctx.fillStyle='#96977a';for(var spot=0;spot<3;spot++){ctx.beginPath();ctx.arc(-r*.42+spot*r*.28,r*(spot%2?.25:-.29),r*.1,0,7);ctx.fill();}
    }else{
      ctx.strokeStyle='#cfbca0';ctx.lineWidth=1.7;ctx.beginPath();ctx.moveTo(r*.55,-r*.18);ctx.lineTo(r*1.02,-r*.29);ctx.lineTo(r*.9,-r*.03);ctx.moveTo(r*.55,r*.18);ctx.lineTo(r*1.02,r*.29);ctx.lineTo(r*.9,r*.03);ctx.stroke();
    }
    ctx.fillStyle=wind?'#ffe3a4':'#e77768';
    for(var eye=-1;eye<=1;eye+=2){ctx.beginPath();ctx.arc(r*.6,eye*r*.22,crab?2:1.6,0,7);ctx.fill();}
    ctx.restore();
  };

  /* ==================== 怪物形象：剪影 + 光影 + 动作 ====================
     2026-10 改版。改之前 5 种怪里 3 种共用同一个"球"（史莱姆/石甲/投手只换颜色和大小），
     疾刺是个原地旋转的三角，球上就 2 个点眼睛 —— 远看像"图标"，不像生物。
     现在每种怪一套独有剪影（靠形状区分，不再靠颜色），再加：
       · 三层光影（主体色 + 底部暗部 + 顶部亮部）+ 深色描边 → 有体积感，压在杂乱地面上也看得清
       · 动作：朝运动方向挤压拉伸、蓄力下蹲、冲刺拉长、受击缩一下并抖
       · 投手快开火时背囊鼓起来（不看弹幕就知道要挨打了）
     ⚠️ 不要用 createLinearGradient / createRadialGradient：小游戏冒烟测试的假 ctx 返回
        undefined，接着 .addColorStop 就当场崩。要渐变感就叠几层 alpha 色块。
     ⚠️ 不要用 setLineDash（跨端支持不齐，真机上可能整条线都不画）。
     ⚠️ 只改画法：碰撞/伤害/血量还是 f.r 那一套，对玩法零影响。
     ================================================================ */

  /** 同色系暗/亮档（代替渐变） */
  function shade(hex, k) {
    var c = hex2rgb(hex);
    return 'rgb(' + Math.min(255, Math.round(c[0] * k)) + ',' +
                    Math.min(255, Math.round(c[1] * k)) + ',' +
                    Math.min(255, Math.round(c[2] * k)) + ')';
  }

  /* ---------- 剪影（坐标已平移到怪中心，+x = 前方） ---------- */
  function pathJelly(ctx, f) {          // 史莱姆：坐在地上的果冻块（底宽、顶尖）
    var r = f.r;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.98);
    ctx.bezierCurveTo(r * 0.98, -r * 0.94, r * 1.14, r * 0.28, r * 0.80, r * 0.76);
    ctx.bezierCurveTo(r * 0.36, r * 1.08, -r * 0.36, r * 1.08, -r * 0.80, r * 0.76);
    ctx.bezierCurveTo(-r * 1.14, r * 0.28, -r * 0.98, -r * 0.94, 0, -r * 0.98);
    ctx.closePath();
  }
  function pathCone(ctx, f) {           // 疾刺：尖锥 + 3 根尾刺
    var r = f.r;
    ctx.beginPath();
    ctx.moveTo(r * 1.55, 0);
    ctx.bezierCurveTo(r * 0.60, -r * 0.95, -r * 0.55, -r * 0.85, -r * 0.75, -r * 0.18);
    ctx.lineTo(-r * 1.75, -r * 0.62);   // 尾刺（上）
    ctx.lineTo(-r * 0.95, 0.02);
    ctx.lineTo(-r * 1.75, r * 0.62);    // 尾刺（下）
    ctx.lineTo(-r * 0.75, r * 0.18);
    ctx.bezierCurveTo(-r * 0.55, r * 0.85, r * 0.60, r * 0.95, r * 1.55, 0);
    ctx.closePath();
  }
  function pathShell(ctx, f) {          // 石甲：六边形甲壳
    var r = f.r, n = 6;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var a = i * Math.PI * 2 / n - Math.PI / 2;
      var x = Math.cos(a) * r * 1.06, y = Math.sin(a) * r * 0.98;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  function pathSac(ctx, f) {            // 投手：圆身体（背上的囊另外画，在身体后面）
    var r = f.r;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.closePath();
  }
  function pathHusk(ctx, f) {           // 甲壳兽：甲虫身体（两片硬甲另外叠上去，见 drawHuskShell）
    var r = f.r;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.98, r * 1.10, 0, 0, 7); ctx.closePath();
  }
  var PATHS = { jelly: pathJelly, cone: pathCone, shell: pathShell, sac: pathSac, husk: pathHusk };

  /**
   * 甲壳兽的两片硬甲（免疫怪能不能玩，全看这一层画得清不清楚）：
   *   合壳   = 两片甲盖上，中间一条缝；**开壳前 tell 秒**甲片开始抖、缝里透光变亮 → 这就是预告
   *   开壳   = 两片向两侧掀起，露出亮核（光核 + 光刺，渲染在身体那层）
   *   被弹开 = 朝玩家那侧画一道弧光（"当"的视觉版，配合 block 音效）
   */
  function drawHuskShell(ctx, f) {
    var r = f.r, sh = f.shell || { closed: 3.6, open: 2.2, tell: 0.7 };
    var open = !!f.shellOpen;
    var k = open ? Math.min(1, f.shellT / 0.16) : 0;           // 掀开进度 0=合 1=全开
    var telling = !open && (sh.closed - f.shellT) <= sh.tell;  // 快开了
    var shk = telling ? (Math.random() * 2 - 1) * 1.9 : 0;     // 预告：抖

    for (var s = -1; s <= 1; s += 2) {                          // s = -1 左半 / +1 右半
      ctx.save();
      ctx.translate(s * r * 0.10 + shk, shk * 0.6);
      ctx.rotate(s * (0.10 + 0.72 * k));
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.02);
      ctx.bezierCurveTo(s * r * 0.92, -r * 0.92, s * r * 1.06, r * 0.20, s * r * 0.62, r * 0.96);
      ctx.bezierCurveTo(s * r * 0.20, r * 1.12, 0, r * 1.05, 0, r * 0.62);
      ctx.closePath();
      ctx.fillStyle = shade(f.color, 0.78);
      ctx.fill();
      ctx.strokeStyle = 'rgba(12,18,14,.55)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      // 甲片上的横纹（不用渐变，靠纹路说明"这是块硬甲"）
      ctx.globalAlpha = 0.32;
      ctx.strokeStyle = shade(f.color, 0.48);
      ctx.lineWidth = 1.6;
      for (var li = 0; li < 3; li++) {
        var ly = -r * 0.42 + li * r * 0.48;
        ctx.beginPath();
        ctx.moveTo(s * r * 0.26, ly);
        ctx.lineTo(s * r * 0.70, ly + r * 0.12);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (!open) {                    // 合壳：缝里透光。快开了会一闪一闪（不看血条就知道要开）
        ctx.globalAlpha = telling ? (0.55 + 0.35 * Math.sin(f.ph * 14)) : 0.16;
        ctx.strokeStyle = '#ffb066';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(s * r * 0.16, -r * 0.84);
        ctx.lineTo(s * r * 0.16, r * 0.70);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    if (f.blockT > 0) {               // 砍在闭壳上：朝玩家那侧一道弧光
      var bk = Math.min(1, f.blockT / 0.20);
      var ba = Math.atan2(f.aimY || 0, f.aimX || 1);
      ctx.save();
      ctx.globalAlpha = 0.9 * bk;
      ctx.strokeStyle = '#fff2c9';
      ctx.lineWidth = 1 + 3.4 * bk;
      ctx.beginPath();
      ctx.arc(0, 0, r * (1.14 + 0.34 * (1 - bk)), ba - 0.95, ba + 0.95);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 这一帧的动作状态：朝向、挤压、抖动、速度比 */
  function motionOf(f) {
    var m = { ang: 0, sx: 1, sy: 1, jx: 0, jy: 0, speedR: 0, ready: 0 };
    var sp = Math.hypot(f.vx || 0, f.vy || 0);
    m.speedR = Math.min(1, sp / 260);
    m.ang = (sp > 4) ? Math.atan2(f.vy || 0, f.vx || 0) : (f.chargeDir || 0);

    // 沿运动方向拉长、垂直方向压扁 —— 就是"有惯性"的感觉
    var along = 1 + 0.14 * m.speedR, across = 1 - 0.10 * m.speedR;
    m.sx = along; m.sy = across;

    // 蓄力（铁角）/ 冲刺：下蹲 → 拉长
    if (f.windup > 0) { m.sx = 1.18; m.sy = 0.80; }
    if (f.charging > 0) { m.sx = 1.32; m.sy = 0.76; }

    // 呼吸（一直有，让它"活着"）
    m.sy *= 1 + Math.sin(f.ph) * 0.05;

    // 受击：缩一下 + 抖（现在不只是闪白）
    if (f.hurt > 0) {
      var k = Math.min(1, f.hurt / 0.16);
      m.sx *= 1 - 0.10 * k; m.sy *= 1 - 0.10 * k;
      m.jx = (Math.random() * 2 - 1) * 3.2 * k;
      m.jy = (Math.random() * 2 - 1) * 3.2 * k;
    }

    // 投手：快开火了 → 背囊鼓起来（这就是"要挨打了"的预告）
    if (f.shape === 'sac' && f.ranged) {
      m.ready = Math.max(0, Math.min(1, 1 - Math.max(0, f.shootT) / 0.45));
    }
    return m;
  }

  /** 三层光影 + 描边。pathFn 画剪影，paint 负责上色 */
  function paintCreature(ctx, f, pathFn) {
    if (f.hurt > 0) {                       // 受击：整只闪白（最直接的"打中了"反馈）
      pathFn(ctx, f);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      return;
    }
    pathFn(ctx, f);
    ctx.fillStyle = f.color;
    ctx.fill();

    ctx.save();
    pathFn(ctx, f);
    ctx.clip();
    ctx.globalAlpha = 0.34;                 // 底部暗部
    ctx.fillStyle = shade(f.color, 0.42);
    ctx.beginPath();
    ctx.ellipse(0, f.r * 0.86, f.r * 1.7, f.r * 0.95, 0, 0, 7);
    ctx.fill();
    ctx.globalAlpha = 0.30;                 // 左上亮部
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-f.r * 0.36, -f.r * 0.50, f.r * 0.74, f.r * 0.5, -0.5, 0, 7);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();

    pathFn(ctx, f);                         // 深色描边：压在草地/石地上都分得出来
    ctx.strokeStyle = 'rgba(12,18,14,.55)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  /** 各怪独有的细节：眼睛 / 核 / 裂缝 / 囊 / 瞳孔 */
  function features(ctx, f, m) {
    var r = f.r;

    if (f.shape === 'jelly') {
      ctx.globalAlpha = 0.22;               // 体内更亮的核（果冻感）
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(0, r * 0.12, r * 0.52, r * 0.42, 0, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1d2a1a';            // 眼
      ctx.beginPath(); ctx.arc(-r * 0.34, -r * 0.14, r * 0.15, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.34, -r * 0.14, r * 0.15, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.85)';   // 眼神光
      ctx.beginPath(); ctx.arc(-r * 0.30, -r * 0.20, r * 0.055, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.38, -r * 0.20, r * 0.055, 0, 7); ctx.fill();
      ctx.strokeStyle = '#1d2a1a'; ctx.lineWidth = 1.6;   // 嘴：受击时张大
      ctx.beginPath();
      if (f.hurt > 0) ctx.arc(0, r * 0.42, r * 0.20, 0, 7);
      else ctx.arc(0, r * 0.30, r * 0.26, 0.35, Math.PI - 0.35);
      ctx.stroke();

    } else if (f.shape === 'cone') {
      ctx.fillStyle = '#2b2410';            // 细长的斜眼（凶）
      ctx.beginPath(); ctx.ellipse(r * 0.42, -r * 0.26, r * 0.20, r * 0.09, -0.5, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.42, r * 0.26, r * 0.20, r * 0.09, 0.5, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(r * 0.95, 0); ctx.lineTo(r * 1.42, 0); ctx.stroke();
      ctx.globalAlpha = 1;

    } else if (f.shape === 'shell') {
      var hurtR = Math.max(0, Math.min(1, f.hp / f.maxhp));
      ctx.globalAlpha = 0.55;               // 内层甲片
      ctx.strokeStyle = shade(f.color, 0.6);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i < 6; i++) {
        var a = i * Math.PI * 2 / 6 - Math.PI / 2;
        var x = Math.cos(a) * r * 0.62, y = Math.sin(a) * r * 0.58;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha = 1;
      // 血越少裂纹越多 —— 比血条更直观的"快死了"
      var cracks = Math.round((1 - hurtR) * 4);
      if (cracks > 0) {
        ctx.strokeStyle = 'rgba(24,26,30,.85)';
        ctx.lineWidth = 2;
        for (var c = 0; c < cracks; c++) {
          var ca2 = c * 2.1 + 0.7;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ca2) * r * 0.15, Math.sin(ca2) * r * 0.15);
          ctx.lineTo(Math.cos(ca2 + 0.25) * r * 0.62, Math.sin(ca2 + 0.25) * r * 0.62);
          ctx.lineTo(Math.cos(ca2 - 0.2) * r * 1.02, Math.sin(ca2 - 0.2) * r * 1.02);
          ctx.stroke();
        }
      }
      ctx.fillStyle = '#3a3f46';            // 壳缝里的两只小眼
      ctx.beginPath(); ctx.arc(-r * 0.22, -r * 0.28, r * 0.11, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.22, -r * 0.28, r * 0.11, 0, 7); ctx.fill();

    } else if (f.shape === 'sac') {
      var ex = (f.aimX || 1) * r * 0.14, ey = (f.aimY || 0) * r * 0.14;   // 眼睛盯着玩家
      ctx.fillStyle = '#f4f1ea';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.52, 0, 7); ctx.fill();
      ctx.fillStyle = '#2a1b33';
      ctx.beginPath(); ctx.arc(ex, ey, r * 0.24, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(ex - r * 0.09, ey - r * 0.09, r * 0.075, 0, 7); ctx.fill();
    } else if (f.shape === 'husk') {
      /* ⚠️ 只在**开壳**时画眼睛：闭壳就是一块密封的甲（没有脸）。
         这样"能不能打"不用看血条也不用记节奏 —— 有脸就能打，没脸就是砍不动。 */
      if (!f.shellOpen) return;
      var hx = (f.aimX || 1) * r * 0.28, hy = (f.aimY || 0) * r * 0.28;
      ctx.fillStyle = '#1b2028';
      ctx.beginPath(); ctx.arc(hx - r * 0.20, hy - r * 0.10, r * 0.13, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(hx + r * 0.20, hy - r * 0.10, r * 0.13, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      ctx.beginPath(); ctx.arc(hx - r * 0.24, hy - r * 0.15, r * 0.05, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(hx + r * 0.16, hy - r * 0.15, r * 0.05, 0, 7); ctx.fill();
    }
  }

  /** 普通怪（史莱姆/疾刺/石甲/投手）的完整画法 */
  Renderer.prototype.drawCreature = function (f, t) {
    var ctx = this.ctx, pathFn = PATHS[f.shape] || pathJelly;
    var m = motionOf(f);
    var cx = f.x + m.jx, cy = f.y + m.jy;

    // 接触阴影（贴地感）。跑得快就小一点淡一点 = 腾空
    ctx.save();
    ctx.globalAlpha = 0.30 - 0.09 * m.speedR;
    ctx.fillStyle = '#08100a';
    ctx.beginPath();
    ctx.ellipse(cx, f.y + f.r * 0.88, f.r * 1.10, f.r * 0.42, 0, 0, 7);
    ctx.fill();
    ctx.restore();

    // 疾刺高速时的残影
    if (f.shape === 'cone' && m.speedR > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.18 * m.speedR;
      ctx.fillStyle = f.color;
      for (var g = 1; g <= 2; g++) {
        ctx.beginPath();
        ctx.ellipse(cx - (f.vx || 0) * 0.022 * g, cy - (f.vy || 0) * 0.022 * g,
          f.r * 0.85, f.r * 0.42, m.ang, 0, 7);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(cx, cy);
    if (f.shape === 'cone') {                 // 有前后之分：整体朝运动方向转
      ctx.rotate(m.ang);
      ctx.scale(m.sx, m.sy);
    } else {                                  // 无前后之分：只沿运动方向拉伸，形状保持直立
      ctx.rotate(m.ang); ctx.scale(m.sx, m.sy); ctx.rotate(-m.ang);
    }

    if (f.shape === 'sac') {                  // 背囊画在身体后面，快开火时会鼓起来
      var bul = 1 + m.ready * 0.42;
      ctx.fillStyle = shade(f.color, 0.72);
      ctx.beginPath();
      ctx.ellipse(-f.r * 1.02, 0, f.r * 0.52 * bul, f.r * 0.74 * bul, 0, 0, 7);
      ctx.fill();
      if (m.ready > 0.35) {                   // 快到点了：囊上亮一圈 = 预警
        ctx.globalAlpha = (m.ready - 0.35) / 0.65 * 0.85;
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.ellipse(-f.r * 1.02, 0, f.r * 0.52 * bul, f.r * 0.74 * bul, 0, 0, 7);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (f.shape === 'husk') {                 // 甲壳兽：六条腿画在身体后面（贴地的甲虫）
      ctx.strokeStyle = shade(f.color, 0.52);
      ctx.lineWidth = 2.6;
      for (var lg = -1; lg <= 1; lg++) {
        var ly = lg * f.r * 0.60;
        var wig = Math.sin(f.ph * 2.2 + lg * 1.7) * 2.4;
        ctx.beginPath();
        ctx.moveTo(-f.r * 0.42, ly); ctx.lineTo(-f.r * 1.22, ly + wig);
        ctx.moveTo(f.r * 0.42, ly); ctx.lineTo(f.r * 1.22, ly + wig);
        ctx.stroke();
      }
    }

    paintCreature(ctx, f, pathFn);

    if (f.shape === 'husk' && f.shellOpen) {  // 开壳：露出的亮核（能打的窗口，一眼就看得见）
      var pk = Math.min(1, f.shellT / 0.18);
      var pulse = 0.5 + 0.5 * Math.sin(f.ph * 6);
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = '#ffd9a8';
      ctx.beginPath(); ctx.arc(0, 0, f.r * (0.66 + 0.10 * pulse) * pk, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = '#ffb066';
      ctx.beginPath(); ctx.arc(0, 0, f.r * (0.34 + 0.07 * pulse) * pk, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.62;                  // 光刺（不用渐变）
      ctx.strokeStyle = '#ffcf99';
      ctx.lineWidth = 2;
      for (var ri = 0; ri < 6; ri++) {
        var ra = ri * Math.PI / 3 + f.ph * 0.7;
        var r0 = f.r * 0.40, r1 = f.r * (0.86 + 0.12 * pulse);
        ctx.beginPath();
        ctx.moveTo(Math.cos(ra) * r0, Math.sin(ra) * r0);
        ctx.lineTo(Math.cos(ra) * r1, Math.sin(ra) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }

    features(ctx, f, m);
    if (f.shape === 'husk') drawHuskShell(ctx, f);
    ctx.restore();
  };

  Renderer.prototype.drawBlob = function (f) {      // 兼容旧调用：等价于史莱姆
    if (!f.shape || f.shape === 'blob') f.shape = 'jelly';
    this.drawCreature(f, 0);
  };

  Renderer.prototype.drawSpike = function (f, t) {  // spike 已并入 cone（疾刺）
    if (!f.shape || f.shape === 'spike') f.shape = 'cone';
    this.drawCreature(f, t);
  };


  /* 旧的 drawSpike（原地旋转的三角）已删除：它转起来像风车不像生物，
     现在由 drawCreature + pathCone（尖锥 + 尾刺，朝运动方向）替代。 */

  /**
   * 铁角：平时是普通小怪；蓄力时原地抖 + 在地上画出冲撞路线。
   * 预警线是它能不能玩的关键 —— 没有它，冲撞就只是"莫名其妙掉血"。
   */
  Renderer.prototype.drawHorn = function (f, t) {
    var ctx = this.ctx;
    var shake = f.windup > 0 ? (Math.random() * 2 - 1) * 2.4 : 0;
    var x = f.x + shake, y = f.y;
    var charging = f.charging > 0;

    if (f.windup > 0) {
      var k = 1 - f.windup / Math.max(0.01, f.windupTotal || 0.65);
      var len = (f.chargeRange || 300) * (0.4 + 0.6 * k);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(f.chargeDir || 0);
      ctx.fillStyle = 'rgba(255,110,70,' + (0.10 + 0.20 * k).toFixed(3) + ')';
      ctx.fillRect(0, -f.r - 6, len, (f.r + 6) * 2);
      ctx.strokeStyle = 'rgba(255,140,90,.85)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
      ctx.restore();
    }

    var m = motionOf(f);
    ctx.save();                            // 接触阴影（跑起来小一点淡一点）
    ctx.globalAlpha = 0.30 - 0.09 * m.speedR;
    ctx.fillStyle = '#08100a';
    ctx.beginPath(); ctx.ellipse(x, y + f.r * 0.88, f.r * 1.05, f.r * 0.40, 0, 0, 7); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    // 平时也朝玩家（以前只有冲撞时才转，站着不动像一张贴纸）
    ctx.rotate((charging || f.windup > 0) ? (f.chargeDir || 0) : Math.atan2(f.aimY || 0, f.aimX || 0));
    ctx.scale(m.sx, m.sy);
    if (charging) {                       // 冲刺拖影
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = f.color;
      for (var s = 1; s <= 3; s++) {
        ctx.beginPath();
        ctx.ellipse(-s * 13, 0, f.r * 0.86, f.r * 0.6, 0, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    paintCreature(ctx, f, function (c, e) {     // 躯干：三层光影 + 描边
      c.beginPath(); c.ellipse(0, 0, e.r, e.r, 0, 0, 7); c.closePath();
    });

    // 两只角：底粗尖细、朝前弯（原来是两根直针，看着像插上去的）
    for (var hi = 0; hi < 2; hi++) {
      var s = hi ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(f.r * 0.18, s * f.r * 0.40);                                  // 角的根部内侧
      ctx.quadraticCurveTo(f.r * 0.66, s * f.r * 1.08, f.r * 1.46, s * f.r * 0.80);   // 外缘（向前弯）
      ctx.quadraticCurveTo(f.r * 0.84, s * f.r * 0.66, f.r * 0.52, s * f.r * 0.14);   // 内缘
      ctx.closePath();
      ctx.fillStyle = f.hurt > 0 ? '#ffffff' : '#f0e6d8';
      ctx.fill();
      ctx.strokeStyle = 'rgba(12,18,14,.55)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.save();                          // 角尖一段暗面：有厚度、不像纸片
      ctx.clip();
      ctx.globalAlpha = 0.26; ctx.fillStyle = '#7a6650';
      ctx.beginPath();
      ctx.ellipse(f.r * 1.5, s * f.r * 0.86, f.r * 0.55, f.r * 0.55, 0, 0, 7); ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = '#2a1113';             // 眼（按体型缩放，别在大怪身上成两个像素点）
    ctx.beginPath(); ctx.arc(f.r * 0.34, -f.r * 0.20, f.r * 0.14, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(f.r * 0.34, f.r * 0.20, f.r * 0.14, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.beginPath(); ctx.arc(f.r * 0.40, -f.r * 0.26, f.r * 0.05, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(f.r * 0.40, f.r * 0.14, f.r * 0.05, 0, 7); ctx.fill();
    ctx.restore();
  };

  /* 三个新 Boss 的形象（2026-10：每关配专属 Boss）。
     设计要求：**剪影就能分辨**，不能只是"球 + 一圈尖刺换个颜色"（现有两只就是这个毛病）。
       · golem 碎石巨像：方块拼的巨像，有臂有头，抬手 = 要砸地
       · magma 熔心巨兽：甲虫式外壳 + 裂缝透岩浆（呼吸脉动），冲刺前会先亮起来
       · eye   虚空之眼：竖瞳眼球 + 一圈反向转的黑色碎片 + 下面几条触须，瞬移时收拢
     ⚠️ 只用多边形/椭圆/描边（不用 createLinearGradient / setLineDash）。 */
  function poly(ctx, cx, cy, r, n, rot) {
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var a = rot + i * Math.PI * 2 / n;
      if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
  }

  /** 碎石巨像：慢、厚、抬头就是要砸地 */
  Renderer.prototype.drawGolem = function (b, t) {
    var ctx = this.ctx, r = b.r;
    var cast = (b.cast ? 1 : 0);                       // 抬手预警
    var bob = Math.sin(t * 1.8) * (r * 0.03);
    var body = b.hurt > 0 ? '#ffffff' : b.color;
    var dark = b.hurt > 0 ? '#dddddd' : '#4a5058';

    // 腿（两个梯形）
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(b.x - r * 0.62, b.y + r * 0.42); ctx.lineTo(b.x - r * 0.22, b.y + r * 0.42);
    ctx.lineTo(b.x - r * 0.28, b.y + r * 0.98); ctx.lineTo(b.x - r * 0.74, b.y + r * 0.98);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(b.x + r * 0.22, b.y + r * 0.42); ctx.lineTo(b.x + r * 0.62, b.y + r * 0.42);
    ctx.lineTo(b.x + r * 0.74, b.y + r * 0.98); ctx.lineTo(b.x + r * 0.28, b.y + r * 0.98);
    ctx.closePath(); ctx.fill();

    // 手臂（抬起 = 要砸地）
    var armA = cast ? 1.55 : 0.12;        // 抬手要**明显**：不动时几乎垂直垂下，要砸时甩到近水平
    ctx.save();
    ctx.translate(b.x, b.y + bob);
    for (var s = -1; s <= 1; s += 2) {
      ctx.save();
      ctx.translate(s * r * 0.78, r * 0.05);
      ctx.rotate(s * armA);
      ctx.fillStyle = dark;
      ctx.fillRect(-r * 0.16, -r * 0.16, r * 0.32, r * 0.95);
      ctx.fillStyle = body;
      ctx.fillRect(-r * 0.19, r * 0.62, r * 0.38, r * 0.42);   // 拳头
      ctx.beginPath(); poly(ctx, 0, r * 0.83, r * 0.24, 5, 0.3); ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // 身体（六边形 + 明暗面）
    ctx.fillStyle = body;
    ctx.beginPath(); poly(ctx, b.x, b.y + bob, r * 0.86, 6, 0.52); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath(); poly(ctx, b.x - r * 0.14, b.y + bob - r * 0.12, r * 0.5, 6, 0.52); ctx.fill();
    // 裂缝
    ctx.strokeStyle = 'rgba(20,24,28,.65)'; ctx.lineWidth = Math.max(1.6, r * 0.05);
    ctx.beginPath();
    ctx.moveTo(b.x - r * 0.3, b.y + bob - r * 0.3); ctx.lineTo(b.x - r * 0.05, b.y + bob + r * 0.1);
    ctx.lineTo(b.x - r * 0.26, b.y + bob + r * 0.36);
    ctx.stroke();

    // 头（小六边形 + 两眼）
    var hy = b.y + bob - r * 0.72;
    ctx.fillStyle = dark;
    ctx.beginPath(); poly(ctx, b.x, hy, r * 0.36, 6, 0.52); ctx.fill();
    var eye = cast ? '#ff8a5c' : '#e0574f';
    ctx.fillStyle = eye;
    ctx.beginPath(); ctx.arc(b.x - r * 0.15, hy + r * 0.02, r * 0.09, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(b.x + r * 0.15, hy + r * 0.02, r * 0.09, 0, 7); ctx.fill();
    if (cast) {                                       // 抬手时眼睛发亮 + 脚下碎石预告
      ctx.fillStyle = 'rgba(255,170,110,.9)';
      ctx.beginPath(); ctx.arc(b.x - r * 0.15, hy + r * 0.02, r * 0.045, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(b.x + r * 0.15, hy + r * 0.02, r * 0.045, 0, 7); ctx.fill();
    }
  };

  /** 熔心巨兽：甲虫壳 + 裂缝透岩浆，冲刺前整体变亮 */
  Renderer.prototype.drawMagma = function (b, t) {
    var ctx = this.ctx, r = b.r;
    var heat = (b.charge || 0);                        // 0~1：蓄力（越亮）
    var pulse = 0.55 + 0.45 * Math.sin(t * (2.6 + heat * 3));
    var lit = 0.35 + 0.65 * pulse + heat * 0.5;
    var body = b.hurt > 0 ? '#ffffff' : b.color;

    // 六条腿（画在壳后面）
    /* 六条腿要**露在壳外**（原来伸到 r*0.95，被壳整个盖住 = 看不出来是甲虫） */
    ctx.strokeStyle = b.hurt > 0 ? '#dddddd' : '#2b2724';
    ctx.lineWidth = Math.max(3, r * 0.17);
    ctx.lineCap = 'round';
    for (var i = 0; i < 6; i++) {
      var s = i % 2 ? 1 : -1, k = Math.floor(i / 2);
      var la = -0.62 + k * 0.62 + Math.sin(t * 6 + i) * 0.06;
      var kx = b.x + s * (r * 1.02 + Math.cos(la) * r * 0.22);
      var ky = b.y + r * (0.22 + la * 0.62);
      ctx.beginPath();
      ctx.moveTo(b.x + s * r * 0.5, b.y + r * (0.05 + k * 0.16));
      ctx.lineTo(kx, ky);                                   // 大腿
      ctx.lineTo(kx + s * r * 0.16, ky + r * 0.3);          // 小腿（往外折一下，像虫脚）
      ctx.stroke();
    }

    // 壳（宽椭圆）+ 裂缝
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(b.x, b.y, r * 1.05, r * 0.86, 0, 0, 7); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.ellipse(b.x, b.y, r * 1.05, r * 0.86, 0, 0, 7); ctx.clip();
    ctx.strokeStyle = 'rgba(255,110,40,' + lit.toFixed(2) + ')';
    ctx.lineWidth = Math.max(2, r * 0.11);
    for (var c = -1; c <= 1; c++) {
      ctx.beginPath();
      ctx.moveTo(b.x + c * r * 0.52, b.y - r * 0.95);
      ctx.lineTo(b.x + c * r * 0.30 + Math.sin(t * 3 + c) * r * 0.06, b.y);
      ctx.lineTo(b.x + c * r * 0.56, b.y + r * 0.95);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath(); ctx.ellipse(b.x - r * 0.3, b.y - r * 0.32, r * 0.42, r * 0.3, -0.5, 0, 7); ctx.fill();

    // 头（前侧，两根角 + 发亮的嘴）
    var hx = b.x + r * 0.88, hy = b.y + r * 0.06;
    ctx.fillStyle = b.hurt > 0 ? '#dddddd' : '#3a352f';
    ctx.beginPath(); ctx.arc(hx, hy, r * 0.38, 0, 7); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx - r * 0.1, hy - r * 0.28); ctx.lineTo(hx - r * 0.02, hy - r * 0.78);
    ctx.lineTo(hx + r * 0.14, hy - r * 0.24); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx + r * 0.24, hy - r * 0.2); ctx.lineTo(hx + r * 0.5, hy - r * 0.62);
    ctx.lineTo(hx + r * 0.44, hy - r * 0.08); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,' + Math.round(120 + 100 * lit) + ',60,' + (0.65 + 0.35 * lit).toFixed(2) + ')';
    ctx.beginPath(); ctx.ellipse(hx + r * 0.06, hy + r * 0.12, r * 0.2, r * 0.09, 0, 0, 7); ctx.fill();
    ctx.fillStyle = lit > 0.85 ? '#fff3c4' : '#ffd166';
    ctx.beginPath(); ctx.arc(hx + r * 0.02, hy - r * 0.12, r * 0.07, 0, 7); ctx.fill();
  };

  /** 虚空之眼：竖瞳眼球 + 反向碎片环 + 触须；瞬移时碎片收拢 */
  Renderer.prototype.drawVoidEye = function (b, t) {
    var ctx = this.ctx, r = b.r;
    var vanish = (b.teleport || 0);                    // 0~1：正在瞬移（收拢）
    var open = 1 - vanish;
    var body = b.hurt > 0 ? '#ffffff' : b.color;

    // 触须（下面几条，摆动）
    ctx.strokeStyle = b.hurt > 0 ? '#dddddd' : '#241b33';
    ctx.lineWidth = Math.max(2, r * 0.13);
    ctx.lineCap = 'round';
    for (var i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(b.x + i * r * 0.34, b.y + r * 0.6 * open);
      ctx.lineTo(b.x + i * r * 0.5 + Math.sin(t * 2.4 + i) * r * 0.14, b.y + r * (1.05 + 0.1 * i));
      ctx.stroke();
    }

    // 碎片环（反向自转）
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(-t * 0.55);
    for (var k = 0; k < 11; k++) {
      var a = k * Math.PI * 2 / 11;
      var d = r * (1.30 - vanish * 0.45 + 0.06 * Math.sin(t * 3 + k));
      ctx.fillStyle = k % 2 ? 'rgba(36,27,51,.92)' : 'rgba(70,52,104,.9)';
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * d, Math.sin(a) * d);
      ctx.lineTo(Math.cos(a + 0.16) * (d + r * 0.34), Math.sin(a + 0.16) * (d + r * 0.34));
      ctx.lineTo(Math.cos(a + 0.30) * d, Math.sin(a + 0.30) * d);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // 眼球（竖瞳）
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(b.x, b.y, r * 0.98 * open, r * 0.84 * open, 0, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.ellipse(b.x - r * 0.26, b.y - r * 0.26, r * 0.34 * open, r * 0.24 * open, -0.5, 0, 7); ctx.fill();
    var pupilH = r * 0.62 * open * (0.45 + 0.55 * Math.abs(Math.sin(t * 1.4)));
    ctx.fillStyle = b.cast ? '#ffffff' : '#0d0716';
    ctx.beginPath(); ctx.ellipse(b.x, b.y, r * 0.14, pupilH, 0, 0, 7); ctx.fill();
    if (b.cast) {                                      // 施法：瞳孔发亮 + 一圈外扩散
      ctx.strokeStyle = 'rgba(190,140,255,.6)';
      ctx.lineWidth = Math.max(2, r * 0.08);
      ctx.beginPath(); ctx.arc(b.x, b.y, r * (1.15 + 0.25 * Math.abs(Math.sin(t * 4))), 0, 7); ctx.stroke();
    }
  };

  /* ==================== 两只老 Boss 的具体形态（2026-10） ====================
     真机："原来的两个 boss 可以换一种具体的形态吗" —— 原来它们就是"圆球 + 一圈尖刺"，
     抽象、也没和机制对上。现在按各自的机制配形状（朝向 = b.face，朝玩家）：
       · warden（原潮汐守卫 → 改名"荒原巨蝎"）：躯体 + 双钳 + **高举的尾针**
         —— 尾针发亮 = 要放环形弹幕（机制和形状对上了）
       · frost（霜缚行者）：**冰晶鹿** —— 鹿角发亮 = 要旋转扫射；跺脚召唤疾刺
     ⚠️ 都用局部坐标画（+x 朝前），整体 rotate(b.face)。 */
  function limb(ctx, x0, y0, x1, y1, x2, y2, w, col) {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  /** 荒原巨蝎 */
  Renderer.prototype.drawScorpion = function (b, t) {
    var ctx = this.ctx, r = b.r;
    /* 裂壳（半血）之后整体转红、甲片裂缝透光 —— "它变了"必须一眼看得出来。 */
    var body = (b.hurt > 0 || b.crack > 0) ? '#ffffff' : (b.phase2 ? '#d8492f' : b.color);
    var dark = b.hurt > 0 ? '#e6e6e6' : (b.phase2 ? '#5a211c' : '#6d3630');
    var sting = b.sting > 0 ? 1 : 0;               // 尾针锁定期：尾针发亮 = 直线毒刺要来了
    var cast = (b.cast || sting) ? 1 : 0;
    var open = b.claw > 0 ? 1 : 0;                 // 双钳张开 = 身后那片扇形要夹下来了
    var step = Math.sin(t * 4) * 0.16;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.face || 0);

    // 八条腿（四对，交替摆）
    for (var i = 0; i < 4; i++) {
      var lx = (i - 1.5) * r * 0.42;
      var sw = Math.sin(t * 4 + i * 1.5) * r * 0.12;
      limb(ctx, lx, r * 0.3, lx + r * 0.16 + sw, r * 0.78, lx + r * 0.3 + sw, r * 1.02, Math.max(2.6, r * 0.11), dark);
      limb(ctx, lx, -r * 0.3, lx + r * 0.16 - sw, -r * 0.78, lx + r * 0.3 - sw, -r * 1.02, Math.max(2.6, r * 0.11), dark);
    }
    // 尾巴：从尾部拱起到背上，尾针在最上面（发亮 = 要放弹幕）
    var seg = 6, tx = -r * 0.9, ty = 0, ang = -0.5 - cast * 0.25;
    var pts = [];
    for (var s = 0; s < seg; s++) {
      ang -= 0.36;                                 // 每节往上弯一点
      tx += Math.cos(ang) * r * 0.42 * (1 - s * 0.06);
      ty += Math.sin(ang) * r * 0.42 * (1 - s * 0.06);
      pts.push({ x: tx, y: ty, w: Math.max(2.4, r * 0.30 * (1 - s * 0.11)) });
    }
    for (var k = 0; k < pts.length; k++) {
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.arc(pts[k].x, pts[k].y, pts[k].w, 0, 7); ctx.fill();
    }
    var tip = pts[pts.length - 1];
    ctx.fillStyle = sting ? '#c8e06a' : (b.cast ? '#ffd166' : '#8d4038');
    ctx.beginPath();
    ctx.moveTo(tip.x - r * 0.1, tip.y - r * 0.1);
    ctx.lineTo(tip.x + Math.cos(ang) * r * 0.62, tip.y + Math.sin(ang) * r * 0.62);
    ctx.lineTo(tip.x + r * 0.16, tip.y + r * 0.12);
    ctx.closePath(); ctx.fill();
    if (cast) {                                    // 尾针亮起来 = 直线毒刺（绿）/ 震荡波（金）要来了
      ctx.strokeStyle = sting ? 'rgba(200,224,106,.6)' : 'rgba(255,209,102,.55)';
      ctx.lineWidth = Math.max(2, r * 0.07);
      ctx.beginPath(); ctx.arc(tip.x, tip.y, r * (0.4 + 0.12 * Math.abs(Math.sin(t * 6))), 0, 7); ctx.stroke();
    }

    // 躯体（三段甲片）
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.02, r * 0.7, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(20,16,16,.35)'; ctx.lineWidth = Math.max(1.4, r * 0.045);
    for (var q = -1; q <= 1; q++) {
      ctx.beginPath();
      ctx.ellipse(q * r * 0.3, 0, r * 0.1, r * 0.66, 0, -1.2, 1.2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.beginPath(); ctx.ellipse(-r * 0.16, -r * 0.22, r * 0.5, r * 0.26, 0, 0, 7); ctx.fill();

    // 双钳（前侧）+ 头。open = 张开（预警期把钳张到最大，一眼看出"要夹了"）
    var spread = 1 + open * 0.55;
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      limb(ctx, r * 0.72, sgn * r * 0.3, r * 1.15, sgn * r * 0.62 * spread, r * 1.42, sgn * r * 0.42 * spread,
        Math.max(3, r * 0.16), open ? '#ffb27a' : dark);
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(r * 1.5, sgn * r * 0.4 * spread, r * 0.26, r * 0.18, sgn * 0.5, 0, 7); ctx.fill();
      ctx.strokeStyle = open ? '#ffb27a' : dark; ctx.lineWidth = Math.max(2, r * 0.09);
      ctx.beginPath(); ctx.arc(r * 1.62, sgn * r * 0.34 * spread, r * 0.2, sgn > 0 ? 0.5 : -1.5, sgn > 0 ? 2.6 : 4.6); ctx.stroke();
    }
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(r * 0.95, 0, r * 0.34, r * 0.3, 0, 0, 7); ctx.fill();
    ctx.fillStyle = b.hurt > 0 ? '#dddddd' : '#ffd166';
    ctx.beginPath(); ctx.arc(r * 1.05, -r * 0.14, r * 0.075, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 1.05, r * 0.14, r * 0.075, 0, 7); ctx.fill();
    /* 裂壳：甲片上的裂缝透出红光（半血之后一直在）—— 血条之外的第二条"我在二阶段"的线索 */
    if (b.phase2) {
      ctx.strokeStyle = 'rgba(255,150,90,.9)';
      ctx.lineWidth = Math.max(1.5, r * 0.05);
      for (var ck = -1; ck <= 1; ck++) {
        ctx.beginPath();
        ctx.moveTo(ck * r * 0.30, -r * 0.62);
        ctx.lineTo(ck * r * 0.16 + r * 0.12, -r * 0.12);
        ctx.lineTo(ck * r * 0.36, r * 0.54);
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  /** 霜缚行者（冰晶鹿） */
  Renderer.prototype.drawFrostStag = function (b, t) {
    var ctx = this.ctx, r = b.r;
    var body = b.hurt > 0 ? '#ffffff' : b.color;
    var dark = b.hurt > 0 ? '#e6e6e6' : '#2f5f86';
    var lit = (b.cast || b.sweeping > 0) ? 1 : 0;      // 鹿角发亮 = 要扫射
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.face || 0);

    // 四条细腿
    for (var i = 0; i < 2; i++) {
      var lx = (i ? 0.52 : -0.52) * r;
      var sw = Math.sin(t * 5 + i * 2) * r * 0.08;
      limb(ctx, lx, r * 0.3, lx + sw, r * 0.72, lx + sw * 1.4, r * 1.05, Math.max(2.2, r * 0.09), dark);
      limb(ctx, lx, -r * 0.3, lx - sw, -r * 0.72, lx - sw * 1.4, -r * 1.05, Math.max(2.2, r * 0.09), dark);
    }
    // 躯体 + 尾
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(-r * 0.05, 0, r * 0.92, r * 0.56, 0, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.ellipse(-r * 0.24, -r * 0.18, r * 0.44, r * 0.22, 0, 0, 7); ctx.fill();
    limb(ctx, -r * 0.9, 0, -r * 1.2, -r * 0.14, -r * 1.38, -r * 0.34, Math.max(2.2, r * 0.09), dark);
    // 脖子 + 头
    limb(ctx, r * 0.6, -r * 0.16, r * 0.95, -r * 0.42, r * 1.18, -r * 0.6, Math.max(4, r * 0.24), body);
    var hx = r * 1.3, hy = -r * 0.66;
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(hx, hy, r * 0.34, r * 0.22, -0.35, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.2)';
    ctx.beginPath(); ctx.ellipse(hx + r * 0.06, hy + r * 0.06, r * 0.2, r * 0.12, -0.35, 0, 7); ctx.fill();
    ctx.fillStyle = lit ? '#eafaff' : '#17384f';
    ctx.beginPath(); ctx.arc(hx + r * 0.06, hy - r * 0.1, r * 0.07, 0, 7); ctx.fill();

    // 鹿角（两簇冰晶：主干 + 分叉 + 晶尖）
    var antCol = lit ? 'rgba(230,250,255,.95)' : 'rgba(150,200,235,.9)';
    for (var sgn2 = -1; sgn2 <= 1; sgn2 += 2) {
      var bx = hx - r * 0.04, by = hy - r * 0.2;
      ctx.strokeStyle = antCol; ctx.lineWidth = Math.max(2.4, r * 0.1); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - r * 0.12, by - r * 0.52);
      ctx.lineTo(bx - r * 0.34, by - r * 0.86);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - r * 0.1, by - r * 0.44);
      ctx.lineTo(bx + r * 0.18, by - r * 0.72);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - r * 0.06, by - r * 0.3);
      ctx.lineTo(bx - r * 0.32, by - r * 0.48);
      ctx.stroke();
      // 晶尖（菱形）
      ctx.fillStyle = antCol;
      [[-0.34, -0.94], [0.18, -0.8], [-0.34, -0.54]].forEach(function (o) {
        ctx.beginPath();
        ctx.moveTo(bx + o[0] * r, by + o[1] * r - r * 0.1);
        ctx.lineTo(bx + o[0] * r + r * 0.09, by + o[1] * r);
        ctx.lineTo(bx + o[0] * r, by + o[1] * r + r * 0.1);
        ctx.lineTo(bx + o[0] * r - r * 0.09, by + o[1] * r);
        ctx.closePath(); ctx.fill();
      });
    }
    if (b.sweeping > 0) {                              // 扫射中：角上转一圈光
      ctx.strokeStyle = 'rgba(190,235,255,.5)';
      ctx.lineWidth = Math.max(2, r * 0.07);
      ctx.beginPath(); ctx.arc(hx - r * 0.1, hy - r * 0.4, r * (1.0 + 0.14 * Math.abs(Math.sin(t * 5))), 0, 7); ctx.stroke();
    }
    ctx.restore();
  };

  Renderer.prototype.drawBoss = function (b, t) {
    var ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,.34)';
    ctx.beginPath(); ctx.ellipse(b.x, b.y + b.r * 0.72, b.r * 1.05, b.r * 0.38, 0, 0, 7); ctx.fill();

    /* 五只各走各自的画法（剪影要能分辨，不能只是"球 + 尖刺换颜色"）：
       warden 荒原巨蝎 / frost 冰晶鹿 / golem 碎石巨像 / magma 熔心巨兽 / eye 虚空之眼。
       旧的"圆球 + 一圈尖刺"已删（抽象、且和机制没关系）。 */
    if (b.bossType === 'frost') return this.drawFrostStag(b, t);
    if (b.bossType === 'golem') return this.drawGolem(b, t);
    if (b.bossType === 'magma') return this.drawMagma(b, t);
    if (b.bossType === 'eye')   return this.drawVoidEye(b, t);
    return this.drawScorpion(b, t);            // warden（原潮汐守卫）
  };

  /* ==================== 玩家 ==================== */

  /* ==================== 旋刃（环绕攻击） ====================
     真机定下来的画法（三轮反馈的结果，别再改回去）：
       · **画的是武器本身**（用同一套 drawWeaponShape），不是光带/白弧 —— 之前那版像"能量环"，被否掉
       · **飘在旁边**：刀柄离身体 GRIP_R(30px)，整把武器都在身体轮廓之外，任何角度都不压人物
       · **朝上那半圈画在角色背后**（见 draw() 里的分两层调用）—— 俯视角里那一侧本来就在远处
       · **不要光带、不要残影**（真机："旋转的样子有点丑"）；转速纯观感，慢一点才看得清是把刀
       · **多大就打多远**：武器本体的真实范围 [x0,x1] 整段映射到 [GRIP_R, 伤害半径]
         → 刀尖精确落在伤害半径上，画面和判定对得上（判定见 game.js updateOrbit）
       · 收刃期：**什么都不画**（刀和那圈冷却读数都被否掉了）
     ⚠️ 每把武器的画法都**不是**从 0 开始：长枪的杆从 x=-14 起（握把后面还有一截）。
        按"从握把开始缩放"的话枪杆会捅进身体里 —— 这就是长枪看着和人物重叠的原因。
     ⚠️ 不用 createLinearGradient / setLineDash（假 ctx 会崩 / 跨端不齐）。 */
  /* 刀柄离身体多远 —— ⚠️ 这个数必须和核心层的判定用同一个（config.player.base.orbitGripR），
     否则又变成"画出来的刀"和"打得到的范围"两套数字（真机就是这么抓出来的）。 */
  function gripRadiusOf(S) { return (S && S.orbitGripR) || 30; }

  /** 武器本体在局部坐标里的范围（+x = 刃的方向），和 drawWeaponShape 的画法一一对应 */
  function weaponExtent(wdef) {
    var L = wdef.len;
    if (wdef.thrust) return [-14, L + 2];           // 长枪：杆 -14 → 枪尖 L+2
    if (wdef.pair)   return [5, 10 + L];            // 双刀：护手 5 → 刀尖 10+L
    if (wdef.staff)  return [-4, L * 0.78 + 18.2];  // 法杖：环绕时画光球，这里只用于算范围
    return [6, 12 + L];                             // 长剑 / 大剑：护手 6 → 刀尖 12+L
  }

  /**
   * @param game  只用来读 `orbitParams()`（半径/刃数的**唯一来源**，见下面那段说明）
   * @param layer 'behind' = 只画朝上的那一半（画在角色之前）/ 'front' = 朝下的那一半（画在角色之后）
   */
  Renderer.prototype.drawOrbit = function (game, P, t, layer) {
    var ctx = this.ctx, cfg = this.cfg;
    if (!cfg || !P.stats || !P.orbOn) return;        // 收刃期不画任何东西
    var wdef = cfg.weapons[(P.equip.weapon && P.equip.weapon.kind) || 'sword'] || cfg.weapons.sword;
    var S = P.stats;
    /* ===== 半径和刃数**一律读 orbitParams()**，不再在这里自己重算（2026-10 根治）=====
       这个函数历史上因为"自己重算"栽过三次，每次的修法都是"在这儿再抄一行"，于是第四次照样漏：
         ① 开天（半径 ×5）漏 radiusMul → 判定打到 350px 外、画出来的刀还是 70 长
         ② 千刃（变身 6 把）漏 bladesSet → 判定转着 4 把、画面只画 1 把
         ③ 万刃归一（每转 +1 把）漏了那一项 → 又是"只有效果、视觉还是一把剑"
       现在只认一个来源：orbitParams() 已经把"武器自带 + 旋刃卡 + 万刃归一 + 限次爆发"全算完。
       用户口径（也是这个坑的由来）："武器多大就打到哪里，画面和伤害必须是同一个数"。
       ⚠️ 以后**别往这里加"漏了就补一行"的重算** —— 要改刃数/半径，改 orbitParams 那一处。 */
    var op = game.orbitParams();
    var radius = op.radius;
    var blades = op.blades;
    var col = (P.equip.weapon && P.equip.weapon.color) || wdef.color;
    /* 血刃：刀身整把染红（"具象"口径 —— 不是光带/能量环，就是这把刀变了颜色） */
    if (P.burst && P.burst.active && P.burst.tint) col = P.burst.tint;
    var cy = P.y - 14;                               // 绕"腰线"转（和武器在手里的高度一致）
    var ex = weaponExtent(wdef);
    var GRIP_R = gripRadiusOf(S);
    var k = (radius - GRIP_R) / Math.max(1, ex[1] - ex[0]);   // 自动倍率：本体整段映射上去
    var step = Math.PI * 2 / blades;
    var ang = P.orbAng || 0;
    var behind = (layer === 'behind');

    for (var i = 0; i < blades; i++) {
      var a = ang + i * step;
      if ((Math.sin(a) < -0.02) !== behind) continue;         // 朝上 = 背面
      if(P.frenzy>0){
        ctx.save();ctx.strokeStyle='#ffc86c';ctx.lineCap='round';
        for(var ft=0;ft<3;ft++){ctx.globalAlpha=(.24-ft*.06)*Math.min(1,P.frenzy);ctx.lineWidth=5-ft;
          ctx.beginPath();ctx.arc(P.x,cy,radius-ft*3,a-.36-ft*.1,a-.03);ctx.stroke();}
        ctx.restore();
      }
      if (wdef.staff) {                                       // 法杖：三颗光球（不画刃）
        var kx = P.x + Math.cos(a) * radius, ky = cy + Math.sin(a) * radius;
        ctx.save();
        ctx.globalAlpha = 0.30;
        ctx.fillStyle = '#b98ae0';
        ctx.beginPath(); ctx.arc(kx, ky, 15, 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#e0c8ff';
        ctx.beginPath(); ctx.arc(kx, ky, 7, 0, 7); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(kx - 2, ky - 2, 2.6, 0, 7); ctx.fill();
        ctx.restore();
        continue;
      }
      ctx.save();
      ctx.translate(P.x, cy);
      ctx.rotate(a);
      ctx.translate(GRIP_R - k * ex[0], 0);                   // 本体起点落在 GRIP_R 上
      ctx.scale(k, k);
      /* 限次爆发（开天）生效中：**同一把刀先描一圈金边**（画一遍放大 1.1 的亮金版，本色压在它上面）。
         刻意不加光带/能量环 —— 真机明确否过"抽象光带"（口径：刀就是那把刀在转）。
         刀身整体变长本身来自 k（半径 ×5 → k ×5），所以"变长"是画出来的、不需要额外表现。 */
      if (P.burst && P.burst.active) {
        ctx.save();
        ctx.scale(1.10, 1.10);
        this.drawWeaponShape(wdef, P.burst.tint || '#ffd166', false);
        ctx.restore();
      }
      ctx.save();                                             // 深色底影：浅色刀压草地会发灰
      ctx.translate(1.6, 2.2);
      ctx.globalAlpha = 0.28;
      this.drawWeaponShape(wdef, 'rgba(8,14,10,.9)', false);
      ctx.restore();
      this.drawWeaponShape(wdef, col, true);
      ctx.restore();
    }
  };

  /** 手里那把武器 —— 形状由种类决定，颜色由稀有度决定，一眼能看出换了什么 */
  Renderer.prototype.drawWeaponShape = function (wdef, bladeColor, glow) {
    var ctx = this.ctx;
    ctx.save();
    if (glow) { ctx.shadowColor = bladeColor; ctx.shadowBlur = 10; }

    var L = wdef.len, W = wdef.width;

    if (wdef.staff) {
      ctx.fillStyle = '#6b4a2c';
      ctx.fillRect(-4, -1.8, L * 0.78 + 10, 3.6);
      ctx.fillStyle = bladeColor;
      ctx.beginPath(); ctx.arc(L * 0.78 + 12, 0, 6.2, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.beginPath(); ctx.arc(L * 0.78 + 10, -2, 2.2, 0, 7); ctx.fill();
    } else if (wdef.thrust) {
      // 长枪：长杆 + 枪头
      ctx.fillStyle = '#6b4a2c';
      ctx.fillRect(-14, -1.6, L, 3.2);
      ctx.fillStyle = bladeColor;
      ctx.beginPath();
      ctx.moveTo(L - 14, -5);
      ctx.lineTo(L + 2, 0);
      ctx.lineTo(L - 14, 5);
      ctx.closePath(); ctx.fill();
    } else if (wdef.pair) {
      // 双刀：两把错开的小刀
      for (var s = -1; s <= 1; s += 2) {
        ctx.fillStyle = '#8a8f96';
        ctx.fillRect(10, s * 5 - W / 2, L, W);
        ctx.fillStyle = bladeColor;
        ctx.fillRect(10, s * 5 - W / 2, L, W * 0.55);
        ctx.fillStyle = '#6b4a2c';
        ctx.fillRect(5, s * 5 - 3.4, 6, 6.8);
      }
    } else {
      // 长剑 / 大剑
      ctx.fillStyle = '#8a8f96';
      ctx.fillRect(12, -W / 2, L, W);
      ctx.fillStyle = bladeColor;
      ctx.fillRect(12, -W / 2, L, W * 0.6);
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fillRect(14, -W / 2 + 1, L - 4, 1.4);
      ctx.fillStyle = '#6b4a2c';
      ctx.fillRect(6, -W * 0.62, 6, W * 1.24);      // 护手
    }
    ctx.restore();
  };

  Renderer.prototype.drawPlayer = function (P, t) {
    var ctx = this.ctx;
    var cfg = this.cfg;
    if (P.frenzy > 0) {
      var elapsed=((P.evolutions&&P.evolutions.storm)?cfg.frenzy.upgradedDuration:cfg.frenzy.duration)-P.frenzy;
      if(elapsed<.24){
        ctx.save();ctx.globalAlpha=(1-elapsed/.24)*.85;ctx.strokeStyle='#fff1bc';ctx.lineWidth=3;
        ctx.beginPath();ctx.moveTo(P.x-24,P.y-39);ctx.lineTo(P.x+24,P.y+9);ctx.moveTo(P.x+24,P.y-39);ctx.lineTo(P.x-24,P.y+9);ctx.stroke();ctx.restore();
      }
    }
    /* 中毒（被 Boss 尾针扎到）：脚下一圈毒绿的脉动 ——
       减速是看不见的数值，没有这个圈玩家只会觉得"我这局怎么老走不掉"。 */
    if (P.slowT > 0) {
      var pp = 0.5 + 0.5 * Math.sin(t * 8);
      ctx.save();
      ctx.globalAlpha = 0.28 + 0.34 * pp;
      ctx.strokeStyle = '#c8e06a';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.ellipse(P.x, P.y + 2, 22 + pp * 4, 9 + pp * 2, 0, 0, 7); ctx.stroke();
      ctx.restore();
    }
    var blink = P.inv > 0 && Math.floor(t * 22) % 2 === 0;

    var weaponItem = P.equip.weapon;
    var wdef = (cfg && cfg.weapons[(weaponItem && weaponItem.kind) || 'sword']) || null;
    var armorItem = P.equip.armor;

    /* ==================== 挥刀充能环（收刃期，脚下）====================
       2026-10 用户口径，六版：
         ① 「把饰品光环改造成收刃期」+「饰品的光环就不用了」+「涨满的时候闪」
         ② 「从 6 点开始吧」+「不要做的那么明显的转圈，做成之前那种饰品一样，有一个小点点在脚下转」
         ③ 「参考之前的饰品光环，那个做得很好，看起来也不明显，一条浅色透明的实圈，
             还有那个点点也是一个小小的」→ 照旧复刻
         ④ 「不够明显，小点经过的圈可以直接变成小点的颜色吗?」→ 圈自己当进度条
         ⑤ 「小点扫过的实圈换一个不是很明显的颜色吧，现在这个纯白太白了，透明一点吧」→ alpha 降到 0.55
         ⑥ 「**转的时候这个圈不显示吧，只有收刃期间才进行转圈**」← 撤销了中间那版"整圈 = 转动 + 收刃"：
            环**只在收刃期出现**，在收刃那段时间里从 0 填到满，填满 = 起转挥刀 → 环消失。

       所以现在画的是（收刃期，裸装 0.90s / 一圈）：
         ① 淡底整圈（ringAlpha 0.22）
         ② 已扫过的一段（sweepAlpha 0.55，同一条圈、同一个线宽，只换透明度）
         ③ 小点停在进度最前端（走在圈外侧）
         ④ 填满那一下点闪一下 → 环整个消失（起转开始）
       ⚠️ 转动期（2.2s）**完全不画**：那段时间刀刃本身在转，脚下再套一圈是噪音（用户口径"转的时候不显示"）。

       ⚠️ 圈和点**都不许加深色底衬** —— 我有一版加了深色底 + 实心大点，被用户当场否掉
          （"你这个好丑"）。旧饰品光环之所以"不明显也不脏"，就是因为它是一根干净的半透明描边。
       ⚠️ 已扫过的那段必须**同一条圈、同一个 lineWidth**（只换透明度），
          不能画成更粗的"进度环" —— 那又变回用户否过的"明显的转圈"了。
       ⚠️ 点的路径比圈**大 dotOut(4px)**（旧代码同一比例），点走在圈外侧，颜色段和点不糊在一起。
       ⚠️ 必须画在**影子之前**（= 角色下层），否则会压在小腿上。
       ⚠️ 只在 state==='play' 时画（frameState 为空 = 被测试/工具直接调 drawPlayer，也照画）：
          不 gate 的话暂停/升级/死亡面板后面会挂一圈冻住的环。
       ⚠️ 这块位置原来画的是"饰品脚下的光环"（含 3 颗绕转小点），**已按用户要求删掉**。
       ⚠️ 进度/闪光**只读核心层状态**（orbOn / orbTotal / orbT / orbChargeFlash），
          渲染层不自己攒计时器（和角色动作相位同一条规矩）。 */
    var ring = cfg && cfg.feel && cfg.feel.attackRing;
    var ringState = (!this.frameState || this.frameState === 'play');
    if (ring && P.orbTotal > 0 && (!P.orbOn || P.orbChargeFlash > 0) && ringState) {
      var rrx = ring.rx, rry = rrx * (ring.ry || 0.4);
      var dOut = ring.dotOut === undefined ? 4 : ring.dotOut;
      var dotR = ring.dotR || 2.6;
      var col = ring.color || '#e8edf2';
      var raBase = ring.ringAlpha === undefined ? 0.22 : ring.ringAlpha;    // 未扫过（轨道底）
      var raSweep = ring.sweepAlpha === undefined ? 0.55 : ring.sweepAlpha; // 已扫过（点色）
      var A0 = Math.PI * 0.5;                                  // 6 点 = 正下方
      /* 收刃期进度：0 → 1，1 就是起转那一下 */
      var prog = P.orbOn ? 1 : Math.max(0, Math.min(1, 1 - P.orbT / P.orbTotal));
      ctx.save();
      ctx.lineWidth = 2.6;
      /* ① 轨道底：整圈、浅色半透明描边（照旧饰品光环：不填实、不加底衬） */
      ctx.globalAlpha = raBase;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.ellipse(P.x, P.y + 2, rrx, rry, 0, 0, 7); ctx.stroke();
      /* ② 小点已经扫过的那一段：同一条圈、同一个线宽，换成小点的颜色（用户口径） */
      var TAU = 6.2832;
      if (prog > 0.004) {                                      // 太短就不画（免得起点冒一个小疙瘩）
        ctx.globalAlpha = raSweep;
        ctx.beginPath(); ctx.ellipse(P.x, P.y + 2, rrx, rry, 0, A0, A0 + TAU * prog); ctx.stroke();
      }
      var ppx = P.x + Math.cos(A0) * (rrx + dOut);
      var ppy = P.y + 2 + Math.sin(A0) * (rry + dOut * (ring.ry || 0.4));
      if (P.orbChargeFlash > 0) {
        /* ③ 填满那一下：小点在 6 点闪一下（亮核 + 一层薄光晕）。
           这是环在画面上最后 0.12s —— 闪完就整个消失（起转开始）。 */
        var k = P.orbChargeFlash / Math.max(0.001, ring.flash || 0.12);
        ctx.globalAlpha = 0.45 * k;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(ppx, ppy, dotR * (3.0 + 2.2 * (1 - k)), 0, 7); ctx.fill();
        ctx.globalAlpha = 0.85 * k;
        ctx.beginPath(); ctx.arc(ppx, ppy, dotR * (1 + 1.3 * (1 - k)), 0, 7); ctx.fill();
      } else {
        /* ④ 一个小小点，走在圈的**外侧**，停在进度最前端（= 颜色段的头） */
        var ang = A0 + TAU * prog;
        var dx = P.x + Math.cos(ang) * (rrx + dOut);
        var dy = P.y + 2 + Math.sin(ang) * (rry + dOut * (ring.ry || 0.4));
        ctx.fillStyle = col;
        if (ring.dotGlow) {                                    // 可选：给"进度头"加一圈很淡的光晕
          ctx.globalAlpha = 0.30 * (ring.dotAlpha === undefined ? 1 : ring.dotAlpha);
          ctx.beginPath(); ctx.arc(dx, dy, dotR * (1 + ring.dotGlow), 0, 7); ctx.fill();
        }
        ctx.globalAlpha = ring.dotAlpha === undefined ? 0.9 : ring.dotAlpha;
        ctx.beginPath(); ctx.arc(dx, dy, dotR, 0, 7); ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    if (blink) ctx.globalAlpha = 0.45;

    /* ==================== 角色本体（2026-10 换成剑客造型 · 半侧 55°）====================
       造型：头带(两条飘带) + 交领短打 + 宽腰带 + 绑腿布靴 + **腰间佩剑**。
       朝向：只画"面朝右"这一套，再按移动方向**水平镜像**（cos(P.face) 的符号）。
             ⚠️ 往上下走时**保持这个侧身不变**（用户 2026-10 选的处理 1：不另画背面）。
       侧身的关键细节（少一个就露馅，都是手调的，见 tools/preview-side.html 的 ANG 表）：
         远侧眼藏掉 / 有鼻尖 / 后脑头发后鼓 + 一缕发尾 / 身体变窄 + 肩线往朝向偏 /
         两腿一前一后(远侧腿压暗) / 近侧手臂画在身体前面 / 佩剑挂后腰(剑柄从背后翘出来) / 飘带往后飘。
       ⚠️ 手里不画武器（真机口径"手里不要任何东西"）：佩剑是**别在腰上**的，手里空的。
       ⚠️ 动作相位全部挂真实状态：P.moving(在走) / P.bob(步相位) / P.orbOn(刃在转=在砍) /
          P.dash(冲刺) / P.face(朝向) —— 渲染层不自己攒计时器。 */
    var OUT = '#1b1f26';
    var SKIN = '#f2cda6', HAIR = '#141519';
    var ROBE = '#37587f', ROBE_D = '#2b4666', SASH = '#c9a24a', SASH_D = '#8f6f26';
    var walk = !!P.moving && P.dash <= 0;
    var swing = !!P.orbOn;
    var dashK = P.dash > 0 ? Math.min(1, P.dash / 0.16) : 0;
    var step = Math.sin(P.bob);
    var y0 = P.y - 42 + step * 2.2;
    /* ⚠️ **就正面**（用户 2026-10 口径："跑起来有点怪…别弄侧身了，就正面"）：
       不做左右镜像 —— 朝左右跑时精灵瞬间翻转，动起来很跳。
       整套只画一种朝向；哪天要恢复"面朝左翻一下"，把下面这行换成
       `Math.cos(P.face||0) < 0 ? -1 : 1` 即可（渲染/测试都认这个变量）。 */
    var flip = 1;
    var lx = dashK * Math.cos(P.face || 0) * 3.4;          // 冲刺前倾（世界空间，不走镜像）
    var ly = dashK * Math.sin(P.face || 0) * 1.8;
    /* 55° 侧身的一套几何（想换角度：只改这几行，渲染和剪影共用） */
    /* ---- 造型和"朝向偏多少"就这一处（现在 = **正面 0°**，用户 2026-10 定：头带造型的原样）----
       想换侧身角度：照着 tools/preview-side.html 里的 ANG 表改下面这几个数就行 ——
         eyeF=null 藏掉远侧眼 / nose>0 才画鼻尖 / backHair>0 才画后脑那团头发和发尾 /
         hw 身体半宽 / shX 肩线往朝向偏 / legF,legB 两腿一前一后 / swAX,swAY,swR 佩剑挂哪、转多少 */
    var F = { hx: 0, hr: 1.00, eyeN: 3.3, eyeF: -3.3, nose: 0, backHair: 0,
              hw: 12, shX: 0, legF: 1.5, legB: -8, swAX: 13, swAY: 21, swR: 0 };
    var legA = walk ? step : 0;
    /* 两只手臂的摆幅：走路时**反相**摆（远侧那只原来被写成固定 0 = 冻住，跑起来像断了一条胳膊） */
    var armFar = walk ? step : 0;
    var armNear = walk ? -step : (swing ? 1.0 : 0);
    var G = { x: P.x, y0: y0, hx: F.hx, hr: F.hr, hw: F.hw, shX: F.shX, legF: F.legF, legB: F.legB, legA: legA };
    var hx = P.x + F.hx, hw = F.hw, sh = P.x + F.shX;
    /* 护甲：**换配色**（用户口径"成长要看得见"）——短打和袖子都跟着染 */
    var coat = ROBE, coatDark = ROBE_D;
    if (armorItem) {
      coat = mix(ROBE, armorItem.color, 0.30 + armorItem.rarity * 0.10);
      coatDark = mix(coat, '#000000', 0.18);
    }

    /* ---- 影子（冲刺时被拉长一点）---- */
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath(); ctx.ellipse(P.x + G.shX * 0.4, P.y + 3, 17 + dashK * 5, 6 - dashK * 1.6, 0, 0, 7); ctx.fill();

    ctx.save();
    /* 镜像 + 世界位移：点(X) 映射到 P.x+lx+flip*(X-P.x)，所以里面一律按"面朝右"用绝对坐标画 */
    ctx.translate(P.x + lx, P.y + ly);
    ctx.scale(flip, 1);
    ctx.translate(-P.x, -P.y);

    /* ---- 冲刺残影：身后拖两层同款剪影（只画剪影不画细节）---- */
    if (dashK > 0.05) {
      for (var gi = 2; gi >= 1; gi--) {
        ctx.save();
        ctx.globalAlpha = 0.16 * dashK / gi;
        ctx.fillStyle = '#dff0ff';
        pathPlayerSilhouette(ctx, P, { x: P.x - gi * 6, y0: y0, hx: G.hx - gi * 1.2, hr: G.hr,
          hw: G.hw, shX: G.shX - gi * 1.0, legF: G.legF, legB: G.legB, legA: G.legA });
        ctx.fill();
        ctx.restore();
      }
    }

    /* ---- 狂热光晕：**贴着身体**的一圈光（描的就是身体剪影本身）---- */
    if (P.frenzy > 0) {
      var fk = Math.min(1, P.frenzy);
      var fpulse = 0.5 + 0.5 * Math.sin(t * 7);
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffe1a0';
      ctx.globalAlpha = fk * (0.22 + 0.16 * fpulse);
      ctx.lineWidth = 8;
      pathPlayerSilhouette(ctx, P, G); ctx.stroke();
      ctx.globalAlpha = fk * (0.55 + 0.25 * fpulse);
      ctx.lineWidth = 2.4;
      pathPlayerSilhouette(ctx, P, G); ctx.stroke();
      ctx.restore();
    }

    /* ---- 低血心跳：红色描身体剪影的脉冲（2026-10 用户口径：血条/经验条挪到左上角卡之后，
            低血必须"在角色身上"也看得出来 —— 眼睛盯着怪的时候，角落那条红是看不见的）。
       三层反馈里这是"角色级"那一层：屏幕四边泛红是余光信号、心跳音/震动是听触觉信号。
       ⚠️ 画在狂热金圈**之后**（叠在它上面）：两个信号同时出现时以**低血为准** ——
          "快死了"比"在变强"更紧急，红压金。（金圈只在狂热那几秒里有，红是持续危险态。）
       ⚠️ 内圈必须是**高不透明度**：低透明度的红叠在草地上会变成脏兮兮的褐色，
          看着像"角色糊了"而不是"角色在冒红光"（出图才看出来，见 tools/preview-lowhp.html）。
       ⚠️ 用 P.stats.maxhp 算比例，别用别的血量口径（升血卡之后 maxhp 会涨）。 */
    var lowCfg = (this.cfg && this.cfg.feel && this.cfg.feel.lowHp) || {};
    var lowRatio = lowCfg.ratio === undefined ? 0.30 : lowCfg.ratio;
    var hpFrac = (P.stats && P.stats.maxhp > 0) ? P.hp / P.stats.maxhp : 1;
    if (hpFrac <= lowRatio) {
      var lse = 1 - hpFrac / lowRatio;                       // 越接近 0 越强（0..1）
      var beat = 0.5 + 0.5 * Math.sin(t * 7.5);              // 心跳节奏（约 1.2 次/秒）
      var beat2 = Math.max(0, Math.sin(t * 7.5));            // 第二击（lub-dub 的那个 "dub"）
      var k = (0.55 + 0.45 * beat) * (0.55 + 0.45 * lse);
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (this.lowHpStyle === 'ring') {
        /* 备选样式：脚下一个红色警示圈（贴地，完全不碰身体）——出图对比用的，
           默认不用（见 tools/preview-lowhp.html 第③格）。 */
        ctx.strokeStyle = '#ff4b3a';
        ctx.globalAlpha = 0.75 * beat + 0.2;                 // 也要够实：淡红圈在草地上同样发褐
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.ellipse(P.x, P.y + 2, 26 + 5 * beat, 11 + 2.4 * beat, 0, 0, 7);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#ff4b3a';
        ctx.globalAlpha = (0.10 + 0.16 * k) + 0.06 * beat2;  // 外圈柔光：铺开在草地上（给"余光"看）
        ctx.lineWidth = 18;
        pathPlayerSilhouette(ctx, P, G); ctx.stroke();
        ctx.globalAlpha = 0.62 + 0.38 * k;                   // 内圈亮边：贴着身体，给"盯着看"看
        ctx.lineWidth = 5;
        pathPlayerSilhouette(ctx, P, G); ctx.stroke();
      }
      ctx.restore();
    }

    /* ---- 腿脚：远侧那条先画、压暗（侧身是一前一后，不是并排）---- */
    function drawLeg(dx, lift, col, boot) {
      pathRoundRect(ctx, P.x + dx, P.y - 17, 6.8, 17 - lift, 2.6);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.strokeStyle = '#6c6152'; ctx.lineWidth = 1.3;              // 绑腿：两道斜缠
      for (var w2 = 0; w2 < 2; w2++) {
        var wy = P.y - 15 + w2 * 5 - lift;
        ctx.beginPath(); ctx.moveTo(P.x + dx - 0.5, wy); ctx.lineTo(P.x + dx + 7.3, wy + 2.6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(P.x + dx - 0.5, wy + 2.6); ctx.lineTo(P.x + dx + 7.3, wy); ctx.stroke();
      }
      pathRoundRect(ctx, P.x + dx - 1.5, P.y - 4 - lift, 9.8, 5.6, 2);
      ctx.fillStyle = boot; ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.6; ctx.stroke();
    }
    drawLeg(G.legB - legA * 1.6, Math.max(0, -legA) * 2.6, '#2f2a20', '#1b1e22');

    /* ---- 腰间佩剑：剑柄挂在右腰、鞘斜到左下方（末端露在下摆外）----
       ⚠️ **不是背在背后**：角色头顶那条空间被血/经验条占了（头顶上方只剩约 7px），剑柄竖起来会顶到血条。
       ⚠️ 画在身体之前 → 中间那段被身体挡住，只露剑柄和鞘尾。 */
    ctx.save();
    ctx.translate(P.x + F.swAX, y0 + F.swAY);
    ctx.rotate(F.swR);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-15, 19);               // 鞘（短一点：别伸到腿那儿去）
    ctx.strokeStyle = OUT; ctx.lineWidth = 6.2; ctx.stroke();
    ctx.strokeStyle = '#2f3a46'; ctx.lineWidth = 3.8; ctx.stroke();
    ctx.save(); ctx.translate(-15, 19); ctx.rotate(0.9);                  // 鞘尾（金属包头）
    pathRoundRect(ctx, -3.2, -2.8, 6.4, 5.6, 2);
    ctx.fillStyle = SASH; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.translate(0.5, -1.5); ctx.rotate(-0.9);               // 护手
    pathRoundRect(ctx, -5.8, -1.4, 11.6, 2.8, 1.2);
    ctx.fillStyle = SASH; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.moveTo(1.5, -3.5); ctx.lineTo(5.5, -10);         // 握柄
    ctx.strokeStyle = OUT; ctx.lineWidth = 5.8; ctx.stroke();
    ctx.strokeStyle = '#5a4634'; ctx.lineWidth = 3.4; ctx.stroke();
    ctx.beginPath(); ctx.arc(6.2, -11, 2.3, 0, 7);                        // 柄头
    ctx.fillStyle = SASH; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();

    /* ---- 前腿（亮） ---- */
    drawLeg(G.legF + legA * 1.6, Math.max(0, legA) * 2.6, '#3b2f22', '#22252a');

    /* ---- 手臂：远侧那只画在身体**后面**（压暗），近侧那只画在身体**前面** ---- */
    function drawArm(dir, phase, near) {
      var sx = P.x - G.shX + dir * 8.6, sy = y0 + 14;
      var ax = P.x + dir * (12.8 + swing * 1.6 + (near ? G.shX * 0.5 : -G.shX * 0.5));
      var ay = y0 + 29 - swing * 6.5 - phase * 3.6;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ax, ay);
      ctx.strokeStyle = OUT; ctx.lineWidth = 8.4; ctx.stroke();
      ctx.strokeStyle = near ? coatDark : mix(coat, '#000000', 0.30); ctx.lineWidth = 6.0; ctx.stroke();
      ctx.beginPath(); ctx.arc(ax, ay + 1.6, 2.8, 0, 7);
      ctx.fillStyle = near ? SKIN : '#d9b48f'; ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; ctx.stroke();
    }
    drawArm(-1, armFar, false);                             // 远侧那只（在身体后面）

    /* ---- 身体：交领短打（越侧越窄、肩线往朝向偏）---- */
    ctx.beginPath();
    ctx.moveTo(sh - hw, y0 + 27);
    ctx.lineTo(sh - hw + 1, y0 + 13);
    ctx.quadraticCurveTo(sh, y0 + 8, sh + hw, y0 + 13);
    ctx.lineTo(sh + hw + 0.5, y0 + 27);
    ctx.closePath();
    ctx.fillStyle = coat; ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.16)';                     // 右侧薄暗部（先铺暗部再勾线，勾线才干净）
    ctx.fillRect(sh, y0 + 12, hw, 14);
    ctx.strokeStyle = OUT; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
    /* ---- 护甲：肩甲（小、贴住肩线；越稀有越大）---- */
    if (armorItem) {
      var pad = 2.1 + armorItem.rarity * 0.55;
      for (var ps = -1; ps <= 1; ps += 2) {
        ctx.beginPath();
        ctx.ellipse(sh + ps * (hw * 0.86 + pad * 0.4), y0 + 13.5, pad + 1.5, pad, 0, 0, 7);
        ctx.fillStyle = mix(coat, '#ffffff', 0.30); ctx.fill();
        ctx.strokeStyle = rgba(armorItem.color, 0.9); ctx.lineWidth = 1.4; ctx.stroke();
      }
    }
    ctx.strokeStyle = '#e8e2d4'; ctx.lineWidth = 2.6; ctx.lineCap = 'butt';   // 交领右衽
    ctx.beginPath(); ctx.moveTo(sh - hw + 1.5, y0 + 10.5); ctx.lineTo(sh + 0.5, y0 + 20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sh + hw - 1.5, y0 + 10.5); ctx.lineTo(sh - 0.6, y0 + 21); ctx.stroke();
    pathRoundRect(ctx, sh - hw + 0.5, y0 + 22, hw * 2 - 1, 6.5, 2.5);          // 宽腰带
    ctx.fillStyle = SASH; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.6; ctx.stroke();
    pathRoundRect(ctx, sh + G.shX * 0.9 - 2.5, y0 + 22.6, 5, 5.4, 1.6);        // 腰扣
    ctx.fillStyle = SASH_D; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();

    drawArm(1, armNear, true);                              // 近侧那只（压在前面）

    /* ---- 头 + 脸：三层，别把后脑和帽子画成一块（那样会把脸糊住）----
       ① 后脑头发（画在脸之前，只在背后一侧露出）② 脸 + 眼 + 鼻尖 ③ 头顶那顶 + 头带 + 飘带 */
    var hy = y0 + 3, bh = F.backHair;
    if (bh > 0) {                                           // ① 后脑那团头发（侧身才画；正面 = 不画）
      ctx.beginPath();
      ctx.ellipse(hx - 3.0 - bh * 0.5, hy + 0.6, 9.4 * F.hr, 9.6, 0, 0, 7);
      ctx.fillStyle = HAIR; ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 2; ctx.stroke();
      if (bh >= 3) {                                        // 半侧以上再拖一缕发尾
        ctx.beginPath();
        ctx.moveTo(hx - 6 - bh * 0.45, hy - 2);
        ctx.quadraticCurveTo(hx - 10 - bh * 0.8, hy + 4, hx - 9.2 - bh * 0.7, hy + 9.5);
        ctx.lineTo(hx - 5.6 - bh * 0.45, hy + 9);
        ctx.quadraticCurveTo(hx - 7 - bh * 0.5, hy + 5, hx - 3.5 - bh * 0.35, hy + 1);
        ctx.closePath();
        ctx.fillStyle = HAIR; ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.7; ctx.stroke();
      }
    }
    ctx.beginPath(); ctx.ellipse(hx, hy, 9.4 * F.hr, 9.4, 0, 0, 7);   // ② 脸
    ctx.fillStyle = SKIN; ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 2; ctx.stroke();
    ctx.lineCap = 'round';
    /* 眼睛：①平时两个圆点 ②砍的**那一下**（起转头 0.22 秒）眯成**一对镜像的斜线**。
       ⚠️ 两个坑都踩过：
         · 两只画成同一个方向 = 像被划了两刀（要左右镜像成"\ /"，才像皱起来用力）
         · 用整段 orbOn 当"在砍" = 长武器会连着好几秒一直眯着（像眼睛坏了）→ 用 orbT 判"刚起转"
       （远侧那只：侧身到一定程度才藏，正面造型下眼F 会画出来） */
    var eyeYs = y0 + 5.4;
    var spinLen = (wdef && wdef.orbit && wdef.orbit.spin) || 0.9;
    var squint = swing && P.orbT > spinLen - 0.22;
    function drawEye(ex, inner) {
      if (squint) {
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (inner < 0) { ctx.moveTo(ex - 1.5, eyeYs - 1.3); ctx.lineTo(ex + 1.2, eyeYs + 1.2); }
        else { ctx.moveTo(ex + 1.5, eyeYs - 1.3); ctx.lineTo(ex - 1.2, eyeYs + 1.2); }
        ctx.stroke();
      } else {
        ctx.fillStyle = OUT;
        ctx.beginPath(); ctx.arc(ex, eyeYs, 1.35, 0, 7); ctx.fill();
      }
    }
    if (F.eyeF !== null) drawEye(hx + F.eyeF, 1);
    drawEye(hx + F.eyeN, -1);
    if (F.nose > 0) {                                       // 鼻尖（贴在朝向那一侧的轮廓外）
      ctx.beginPath();
      ctx.moveTo(hx + 8.6 * F.hr, y0 + 2.8);
      ctx.lineTo(hx + 8.6 * F.hr + F.nose, y0 + 5.4);
      ctx.lineTo(hx + 8.4 * F.hr, y0 + 6.6);
      ctx.closePath();
      ctx.fillStyle = SKIN; ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; ctx.stroke();
    }

    ctx.beginPath();                                        // ③ 头顶那顶
    ctx.arc(hx - bh * 0.35, y0 + 1.4, 9.8, Math.PI * 1.02, Math.PI * 2.0);
    ctx.fillStyle = HAIR; ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 2; ctx.stroke();
    /* 头带：**沿着头的一圈弧**画（不是一块矩形）——
       矩形两端会戳出头轮廓外面、看着像贴了块胶布；弧的两端正好落在头的轮廓上，收口自然。
       画法同其他部件：先描一圈深色（lineWidth+2.6）再压上金色。 */
    ctx.beginPath();
    ctx.arc(hx, hy - 0.6, 8.2, Math.PI * 1.14, Math.PI * 1.86);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = OUT; ctx.lineWidth = 4.6; ctx.stroke();
    ctx.strokeStyle = SASH; ctx.lineWidth = 2.4; ctx.stroke();
    /* 头带侧边的小结 + **两条飘带都在同一侧**往一边飘（用户口径 2026-10：
       "头带应该是在一个边上，有一种飘的感觉" —— 就是我早先那张小样里的样子）。
       ⚠️ 别改成左右对称：两边各一条看着是"停着"的，飘感全没了。
       飘的幅度：挥砍甩得最开 > 跑动跟着抖 > 站着也有微风（sin(t)）。 */
    ctx.beginPath();
    ctx.arc(hx - 8.2, hy - 0.4, 2.1, 0, 7);
    ctx.fillStyle = SASH; ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.3; ctx.stroke();
    var k = (swing ? 1.0 : 0.35) + (walk ? step * 0.3 : 0) + 0.12 * Math.sin(t * 3);
    ctx.strokeStyle = SASH_D; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(hx - 8.6, hy - 0.4);
    ctx.quadraticCurveTo(hx - 16 - k * 3, hy + 4 - k * 5, hx - 21 - k * 4, hy + 1 - k * 9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx - 8.4, hy + 1.2);
    ctx.quadraticCurveTo(hx - 15 - k * 3, hy + 8, hx - 20 - k * 5, hy + 8 - k * 7); ctx.stroke();

    ctx.restore();                                          // 结束镜像

    // 尖甲卡的光晕（圆，不受镜像影响，放外面）
    if (P.stats && P.stats.thorns > 0) {
      ctx.strokeStyle = 'rgba(255,209,102,.34)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(P.x, P.y - 20, 24, 0, 7); ctx.stroke();
    }
    ctx.restore();

    // 双刀连击层数：必须画出来。机制不可见 = 玩家不知道自己在变快 = 这个机制等于不存在
    if (P.comboStacks > 0 && P.equip.weapon && P.equip.weapon.kind === 'dagger') {
      var n = P.comboStacks;
      ctx.save();
      for (var ci = 0; ci < n; ci++) {
        var ca = -Math.PI / 2 + ci * 0.4 - (n - 1) * 0.2;
        ctx.strokeStyle = 'rgba(230,214,138,' + (0.45 + ci * 0.1).toFixed(2) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(P.x, P.y - 22, 27 + ci * 3, ca - 0.15, ca + 0.15);
        ctx.stroke();
      }
      ctx.font = '700 13px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillText('x' + n, P.x, P.y - 53);
      ctx.fillStyle = '#e6d68a';
      ctx.fillText('x' + n, P.x, P.y - 54);
      ctx.restore();
    }
  };

  Renderer.prototype.drawParticles = function (list) {
    var ctx = this.ctx;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!this.inView(p, 80)) continue;
      var a = 1 - p.t / p.life;
      if (p.str) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = p.c;
        ctx.font = '600 13px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillText(p.str, p.x, p.y);
        ctx.restore();
        continue;
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * a, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  /* ==================== HUD ==================== */
  Renderer.prototype.drawMinimap = function (game) {
    var ctx = this.ctx, world = game.world;
    var mw = Math.max(104, Math.min(150, this.w * 0.14));
    var mh = mw * world.h / world.w;
    // 右下角是攻击/冲刺按钮的位置，小地图会被按钮压住 → 挪到右上角面板下面
    var mx = this.w - mw - 16, my = 96 + (this.insets ? this.insets.top : 0);

    ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1; ctx.strokeRect(mx, my, mw, mh);

    var sx = mw / world.w, sy = mh / world.h, i, f;

    // 墙 + 缺口：认地形/找缺口全靠小地图，只画几个点等于没画
    if (world.walls) {
      ctx.strokeStyle = 'rgba(255,255,255,.34)';
      ctx.lineCap = 'round';
      for (i = 0; i < world.walls.length; i++) {
        var w = world.walls[i];
        ctx.lineWidth = Math.max(1.2, w.r * sx * 1.6);
        ctx.beginPath();
        ctx.moveTo(mx + w.x1 * sx, my + w.y1 * sy);
        ctx.lineTo(mx + w.x2 * sx, my + w.y2 * sy);
        ctx.stroke();
      }
    }
    if (world.gaps) {
      ctx.fillStyle = 'rgba(143,214,165,.85)';
      for (i = 0; i < world.gaps.length; i++) {
        ctx.fillRect(mx + world.gaps[i].x * sx - 1.2, my + world.gaps[i].y * sy - 1.2, 2.4, 2.4);
      }
    }
    for (i = 0; i < game.foes.length; i++) {
      f = game.foes[i];
      ctx.fillStyle = f.kind === 'boss' ? '#ff6b5c' : '#69b45c';
      var s = f.kind === 'boss' ? 5 : 3;
      ctx.fillRect(mx + f.x * sx - s / 2, my + f.y * sy - s / 2, s, s);
    }
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(mx + game.player.x * sx - 2, my + game.player.y * sy - 2, 4, 4);
  };

  function bar(ctx, x, y, w, h, ratio, color, back) {
    ctx.fillStyle = back || 'rgba(0,0,0,.60)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(0, w * Math.min(1, ratio)), h);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  /** 装备栏：三个格子 + 部位图标 + 稀有度颜色。换装时整格闪一下 */
  /** 武器按种类画不同形状：换武器 = 换打法，得让玩家一眼看出手里拿的是什么 */
  Renderer.prototype.drawWeaponIcon = function (ctx, kind, col) {
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    if (kind === 'dagger') {                     // 匕首：短刃 + 小护手
      ctx.beginPath(); ctx.moveTo(0, 11); ctx.lineTo(0, -5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(4, -5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, -11); ctx.lineTo(2.4, -7.5); ctx.lineTo(0, -5); ctx.closePath(); ctx.fill();
    } else if (kind === 'greatsword') {          // 大剑：宽刃 + 大护手（最"重"的剪影）
      ctx.beginPath();
      ctx.moveTo(-3.2, 9); ctx.lineTo(3.2, 9); ctx.lineTo(3.2, -7); ctx.lineTo(0, -12); ctx.lineTo(-3.2, -7);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-8, 8.4); ctx.lineTo(8, 8.4); ctx.lineWidth = 3; ctx.stroke();
    } else if (kind === 'spear') {               // 长枪：杆 + 叶形枪头
      ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(0, -5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(3.4, -4); ctx.lineTo(0, -2); ctx.lineTo(-3.4, -4);
      ctx.closePath(); ctx.fill();
    } else if (kind === 'staff') {               // 法杖：杆 + 顶端的环（会发光的那个）
      ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(0, -3); ctx.stroke();
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(0, -7, 4.6, 0, 7); ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.arc(0, -7, 2, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    } else {                                     // 长剑（默认）：直刃 + 十字护手
      ctx.beginPath(); ctx.moveTo(0, 11); ctx.lineTo(0, -10); ctx.lineWidth = 2.6; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-4.6, 8.6); ctx.lineTo(4.6, 8.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(2, -7); ctx.lineTo(0, -4.6); ctx.lineTo(-2, -7);
      ctx.closePath(); ctx.fill();
    }
  };

  /** 装备栏：3 个部位。稀有度 = 边框色 + 底色；每格下面标一条主要属性。
      空槽只画淡图标，不写"未装备"这类占位文字（写着反而更乱）。 */
  Renderer.prototype.drawEquipPanel = function (game, P, x0, y0, slot, gap) {
    var ctx = this.ctx, cfg = this.cfg;
    if (!cfg) return;
    var box = slot || 40, g = gap || 8;
    var slots = cfg.items.slots;
    var SHORT = { attackDamage: '攻', maxhp: '血', spd: '速', attackCooldown: '攻速' };

    for (var i = 0; i < slots.length; i++) {
      var x = x0 + i * (box + g);
      var it = P.equip[slots[i].id];
      var flash = (this.equipFlash > 0 && it) ? this.equipFlash / 0.7 : 0;

      ctx.fillStyle = it ? rgba(it.color, 0.15) : 'rgba(255,255,255,.05)';
      ctx.fillRect(x, y0, box, box);
      ctx.strokeStyle = it ? it.color : 'rgba(255,255,255,.16)';
      ctx.lineWidth = it ? 2 : 1;
      ctx.strokeRect(x + 0.5, y0 + 0.5, box - 1, box - 1);
      if (flash > 0) {                                   // 换上/捡到装备时亮一下
        ctx.fillStyle = rgba(it.color, 0.35 * flash);
        ctx.fillRect(x, y0, box, box);
      }

      ctx.save();
      ctx.translate(x + box / 2, y0 + box / 2);
      ctx.scale(box / 44, box / 44);                     // 图标按格子大小缩放
      var col = it ? it.color : 'rgba(255,255,255,.26)';
      if (slots[i].id === 'weapon') {
        this.drawWeaponIcon(ctx, it && it.kind, col);
      } else if (slots[i].id === 'armor') {
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-9, -8); ctx.lineTo(-4, -11); ctx.lineTo(4, -11); ctx.lineTo(9, -8);
        ctx.lineTo(7, 10); ctx.lineTo(-7, 10); ctx.closePath();
        ctx.globalAlpha = 0.4; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        ctx.globalAlpha = 0.55;                          // 胸口一道亮线，别是一块死方块
        ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(0, 7); ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -11); ctx.lineTo(9, -2); ctx.lineTo(0, 11); ctx.lineTo(-9, -2); ctx.closePath();
        ctx.globalAlpha = 0.45; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
      }
      ctx.restore();

      if (it && it.affixes && it.affixes.length) {        // 主要属性：让"这件装备给了什么"看得见
        var a = it.affixes[0];
        var v = Math.abs(a.v) < 1 ? (Math.round(a.v * 100) / 100) : Math.round(a.v);
        var s = (SHORT[a.k] || a.label || '') + (v > 0 ? '+' : '') + v;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '700 10px ' + FONT;
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        ctx.fillText(s, x + box / 2 + 0.5, y0 + box + 10.5);
        ctx.fillStyle = rgba(it.color, 0.98);
        ctx.fillText(s, x + box / 2, y0 + box + 10);
      }
    }
    ctx.textBaseline = 'alphabetic';
  };

  /**
   * 血条 / 经验条重做。原来只有 12px、8px 的细条、没数值、没边框 —— 手机上根本看不清。
   * 现在五件事一起做：加粗、外描边、数值读数、掉血滞留、低血脉冲。少一样都会"不够明显"。
   */
  Renderer.prototype.drawTideWarning=function(game,t){
    var e=game.trial&&game.trial.tide;if(!e||e.phase!=='warning')return;
    var ctx=this.ctx,ins=this.insets||{},x=this.w/2,y=(ins.top||0)+112;
    ctx.save();ctx.fillStyle='rgba(30,17,20,.9)';ctx.fillRect(x-128,y-17,256,34);
    ctx.fillStyle='#ffc08a';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='700 15px '+FONT;
    ctx.fillText(['← 左侧','右侧 →','↑ 上方','↓ 下方'][e.side]+'敌群袭来',x,y);
    ctx.fillStyle='rgba(235,108,66,'+(.3+.2*Math.sin(t*10))+')';
    if(e.side<2)ctx.fillRect(e.side===0?0:this.w-7,0,7,this.h);else ctx.fillRect(0,e.side===2?0:this.h-7,this.w,7);
    ctx.restore();
  };

  Renderer.prototype.drawFrenzyControl = function(game, t) {
    var ctx=this.ctx,r=game.frenzyRect(),P=game.player,F=game.cfg.frenzy;
    var active=P.frenzy>0,ready=(P.frenzyCharge||0)>=F.threshold;
    ctx.save();
    var cx=r.x+r.w/2,cy=r.y+26,sz=24,progress=active?P.frenzy/(game.frenzyTotal||6):(P.frenzyCharge||0)/F.threshold;
    progress=Math.max(0,Math.min(1,progress));
    var pulse=ready?.75+.25*Math.sin(t*5):1;
    ctx.beginPath();ctx.moveTo(cx,cy-sz);ctx.lineTo(cx+sz,cy);ctx.lineTo(cx,cy+sz);ctx.lineTo(cx-sz,cy);ctx.closePath();
    ctx.lineJoin='round';ctx.lineWidth=5;ctx.fillStyle=active?'#563516':ready?'#48351c':'rgba(17,30,30,.88)';ctx.fill();
    ctx.strokeStyle='#526260';ctx.stroke();
    ctx.globalAlpha=pulse;ctx.strokeStyle=active?'#fff0b3':'#edb85c';ctx.lineWidth=3;
    var perimeter=4*Math.sqrt(2)*sz;
    ctx.setLineDash([Math.max(.01,perimeter*progress),perimeter+1]);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.strokeStyle=active||ready?'#ffe3a2':'#a1b4ad';ctx.lineWidth=3;ctx.lineCap='round';
    for(var slash=0;slash<3;slash++){var sx=cx-10+slash*7;ctx.beginPath();ctx.moveTo(sx-3,cy+6);ctx.lineTo(sx+4,cy-7);ctx.stroke();}
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='700 11px '+FONT;ctx.fillStyle=active||ready?'#ffe3a2':'#d4dfd7';
    var label=active?'狂热 '+P.frenzy.toFixed(1)+'s':ready?'释放狂热':(P.frenzyCharge||0)+' / '+F.threshold;
    ctx.strokeStyle='#172320';ctx.lineWidth=3;ctx.strokeText(label,cx,r.y+58);ctx.fillText(label,cx,r.y+58);
    if(game.frenzyNoticeT>0){ctx.textAlign='center';ctx.font='700 16px '+FONT;ctx.fillStyle='#ffd166';ctx.strokeStyle='#18221d';ctx.lineWidth=4;ctx.strokeText(game.frenzyNotice,this.w/2,this.h-77-(this.insets.bottom||0));ctx.fillText(game.frenzyNotice,this.w/2,this.h-77-(this.insets.bottom||0));}
    ctx.restore();
  };

  Renderer.prototype.drawHud = function (game, P) {
    var ctx = this.ctx, S = P.stats;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 12px ' + FONT;
    /* ⚠️ 2026-10 删掉了屏幕底部那一排武器技能格（`○ 穿云剑气 / ○ 回旋飞刃`）——
       用户口径："屏幕底下的武器技能就不用显示了，在武器库里面有"。
       连带改了两处：`game.update()` 里"点技能格开武器库"的点击热区一起删了（否则留个隐形热区），
       而爆发徽标从这里挪到了**角色头顶**（血/经验条上面，见 drawPlayerHp）——
       底排已经清空，不再放任何常驻或临时信息。 */
    ctx.restore();
    var ins = this.insets, dt = this.dt;
    var x0 = 16 + ins.left;
    var y0 = 16 + ins.top;
    var hpR = Math.max(0, Math.min(1, P.hp / S.maxhp));
    /* 低血判定的两个阈值只从 cfg 读一处（渲染层和核心层不许各写一个数）：
       ratio = 进"低血档"（血条描红 + 屏幕泛红 + 角色心跳脉冲）
       heavy = 重档（屏幕泛红加深加快）
       release/repeat 只核心层用（发 lowHp 事件的滞回和间隔），这里不读。 */
    var lhCfg = (this.cfg && this.cfg.feel && this.cfg.feel.lowHp) || {};
    var lhLow = lhCfg.ratio === undefined ? 0.30 : lhCfg.ratio;
    var lhHeavy = lhCfg.heavy === undefined ? 0.15 : lhCfg.heavy;

    // 掉血滞留：血掉下去后留一条红影慢慢追上来 —— 比数字跳动更容易被眼睛捕捉到
    if (this.hpLag > hpR) this.hpLag = Math.max(hpR, this.hpLag - dt * 0.55);
    else this.hpLag = hpR;

    ctx.textBaseline = 'middle';

    /* ================= 左上：等级 + 血/经验 + 装备 合成一张卡 =================
       原来三行各自一块黑底，画面左上角像贴了三张便签；现在共用一张卡，
       信息还是那几样，但视觉重量只有一份。
       血条/经验条 2026-10 从角色头顶**挪进这张卡**（用户口径"血量和经验值放左上角去"）——
       理由反过来：条跟着人跑会压在角色身上；放卡里一样"一直在视线里"，还不用跟着人走。 */
    var slot = 40, gap = 8, pad = 10;
    /* ⚠️ 卡片宽度 = 装备格那排的宽度，**不再**用 bw（= min(268, w*0.34)）。
       原因：血条按 bw 铺满时右端会顶到顶部关卡栏 —— 横屏刘海机更明显
       （卡片整体被 ins.left 推右，见 tools/preview-hud.html 第④格），
       而关卡栏宽度是随文案变的，没法安全地"留出固定余量"。
       收成内容宽之后：卡里 Lv/血条/经验条/装备格 四样等宽（宽度不齐看着会歪），
       宽度也和右上那张"击杀/金币"卡（138）接近，顶部一条更平衡。 */
    var rowW = slot * 3 + gap * 2;
    var barY = y0 + 17 + 8;
    var hpBarH = 7, xpBarH = 4, barGap = 3;
    var barsH = hpBarH + barGap + xpBarH;
    var equipY = barY + barsH + 10;
    var cardH = pad + 17 + 8 + barsH + 10 + slot + 14 + pad;
    ctx.fillStyle = 'rgba(6,10,14,.78)';
    ctx.fillRect(x0 - pad, y0 - pad, rowW + pad * 2, cardH);
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 - pad + 0.5, y0 - pad + 0.5, rowW + pad * 2 - 1, cardH - 1);

    ctx.font = '800 14px ' + FONT;
    /* ⚠️ 这一整行（Lv / 击杀图标 / 击杀数 / 金币点 / 金币数）统一用 **textBaseline='middle'** 画在
       同一个 midY 上 —— 上一版数字按 alphabetic 基线画、图标却按"基线 −4.5"估视觉中线，
       两套规则各自估，实测金币点比数字高了 **5px**（用户："金币我看还是没有在一行"，量像素证实）。
       同一套基线规则之后，结构上不可能再错位。midY = y0 + 3.5 是原来 alphabetic 基线(y0+8)下的视觉中线。 */
    var midY = y0 + 3.5;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.strokeText('Lv ' + P.level, x0 + 1, midY);
    ctx.fillStyle = '#fff';
    ctx.fillText('Lv ' + P.level, x0 + 1, midY);
    var lvW = ctx.measureText('Lv ' + P.level).width;
    if (P.pendingLevels > 0) {                 // 有卡可升：等级旁边点一个小金点
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(x0 + 6 + lvW + 5, midY, 3.5, 0, 7); ctx.fill();
    }

    /* ---- 击杀 / 金币：跟在「Lv N」后面同一行（用户："放在左上角的 lv2 后面"、"击杀用图标吧"）----
       击杀的图标 = **一只小怪头**（圆身 + 两只角 + 两只眼）：选项里它 1:1 下最能认
       （双刀交叉像 ✗、骷髅像灰疙瘩、横剑像箭头、弯刀像钩子），语义也对得上"打了几只怪"。
       6 个候选的对照图：tools/preview-icons.html → docs/kill-icon-options.png。
       金币保留黄圆点（10px 下也认得出）。 */
    var killX = x0 + 8 + lvW + (P.pendingLevels > 0 ? 14 : 2);
    var ix = killX + 7;
    ctx.fillStyle = '#d8dee6';
    ctx.beginPath(); ctx.ellipse(ix, midY + 0.4, 6.0, 5.2, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(ix - 4.4, midY - 3.6); ctx.lineTo(ix - 2.6, midY - 7.0); ctx.lineTo(ix - 1.6, midY - 4.4); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(ix + 4.4, midY - 3.6); ctx.lineTo(ix + 2.6, midY - 7.0); ctx.lineTo(ix + 1.6, midY - 4.4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#11161b';
    ctx.beginPath(); ctx.arc(ix - 2.2, midY - 0.4, 1.3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(ix + 2.2, midY - 0.4, 1.3, 0, 7); ctx.fill();
    ctx.font = '700 13px ' + FONT;
    ctx.fillStyle = '#e8edf2';
    ctx.fillText(String(P.kills), killX + 18, midY);

    var goldTxt = String(P.gold);
    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'right';
    ctx.fillText(goldTxt, x0 + rowW, midY);
    var goldW = ctx.measureText(goldTxt).width;                 // 圆点跟着数字宽度走（4 位数也不会挤上）
    ctx.beginPath(); ctx.arc(x0 + rowW - goldW - 9, midY, 4.4, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(x0 + rowW - goldW - 10.5, midY - 1.6, 1.4, 0, 7); ctx.fill();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    /* ---- 血条 / 经验条（血在上、经验在下，和原来头顶那组同一个顺序）----
       掉血滞留：血掉下去后留一条浅红影慢慢追上来，比数字跳动更容易被眼睛捕捉。 */
    var xpR = P.xpNext > 0 ? Math.max(0, Math.min(1, P.xp / P.xpNext)) : 0;
    ctx.fillStyle = 'rgba(74,16,16,.95)';       // 血
    ctx.fillRect(x0, barY, rowW, hpBarH);
    if (this.hpLag > hpR) {                     // 刚掉掉的那一段：浅红影
      ctx.fillStyle = 'rgba(236,138,120,.55)';
      ctx.fillRect(x0, barY, rowW * this.hpLag, hpBarH);
    }
    ctx.fillStyle = hpR > 0.55 ? '#5fd06a' : (hpR > 0.28 ? '#e8c56a' : '#e8564f');
    ctx.fillRect(x0, barY, rowW * hpR, hpBarH);

    ctx.fillStyle = 'rgba(10,18,30,.95)';       // 经验（有卡可升时变金色）
    ctx.fillRect(x0, barY + hpBarH + barGap, rowW, xpBarH);
    ctx.fillStyle = P.pendingLevels > 0 ? '#ffd166' : '#4e8fd0';
    ctx.fillRect(x0, barY + hpBarH + barGap, rowW * xpR, xpBarH);

    if (hpR <= lhLow) {                         // 残血：整组外面再描一圈闪红
      var bpulse = 0.5 + 0.5 * Math.sin((this.lastT || 0) * 9);
      ctx.strokeStyle = 'rgba(255,80,70,' + (0.4 + 0.5 * bpulse).toFixed(2) + ')';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 - 2.5, barY - 2.5, rowW + 5, barsH + 5);
    }

    this.drawEquipPanel(game, P, x0, equipY, slot, gap);

    /* ---- 精英掉落的技能捡起来时：全屏一行（用户口径"要有仪式感"）----
       两句：主行"获得 · 穿云剑气"，副标"长剑的技能 · 跟随武器生效"。
       副标是**当下唯一**能把"技能跟着武器走"讲清楚的地方（玩家不会自己去技能页发现），不能省。 */
    if (game.skillNotice) {
      var sn = game.skillNotice;
      var sy2 = this.h * 0.34;
      ctx.save();
      ctx.globalAlpha = Math.min(1, sn.t / 0.35);        // 最后 0.35 秒淡出
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(8,12,16,.72)';
      ctx.fillRect(this.w / 2 - 132, sy2 - 30, 264, 60);
      ctx.strokeStyle = 'rgba(255,209,102,.45)'; ctx.lineWidth = 1;
      ctx.strokeRect(this.w / 2 - 132 + 0.5, sy2 - 30 + 0.5, 263, 59);
      ctx.font = '800 19px ' + FONT; ctx.fillStyle = '#ffd166';
      ctx.fillText('获得 · ' + sn.name, this.w / 2, sy2 - 9);
      ctx.font = '12.5px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,.78)';
      ctx.fillText(sn.weapon + '的技能 · 跟随武器生效', this.w / 2, sy2 + 14);
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
    }

    /* ---- 低血：屏幕四边泛红，**两档** ----
       2026-10：血条挪到左上角卡之后，"低血"必须靠余光的屏幕信号兜住。
       原来只有一档、最外圈 alpha 才 0.14（还只在 ≤25% 才出现），打斗里基本感觉不到。
       现在：≤lowHp.ratio 轻档（3 圈）／≤lowHp.heavy 重档（4 圈、更深、闪得更快、内扩更宽）。
       ⚠️ 试炼场不放：那里是试招的沙盒，满屏红边只会干扰看机制。 */
    if (hpR <= lhLow && !game.training) {
      var heavy = hpR <= lhHeavy;
      var layers = heavy ? 4 : 3;
      var base = heavy ? 0.30 : 0.15;           // 最内圈的不透明度（往外递减）
      var step = heavy ? 0.055 : 0.036;
      var vpulse = 0.5 + 0.5 * Math.sin((this.lastT || 0) * (heavy ? 8.5 : 6));
      for (var vi = 0; vi < layers; vi++) {
        var vd = (heavy ? 15 : 11) + vi * (heavy ? 16 : 13);
        var va = Math.max(0, base - vi * step) * (0.55 + 0.45 * vpulse);
        ctx.fillStyle = 'rgba(198,28,22,' + va.toFixed(3) + ')';
        ctx.fillRect(0, 0, this.w, vd);
        ctx.fillRect(0, this.h - vd, this.w, vd);
        ctx.fillRect(0, 0, vd, this.h);
        ctx.fillRect(this.w - vd, 0, vd, this.h);
      }
    }
    ctx.textBaseline = 'alphabetic';

    /* ---- 右上角：只剩暂停键 ----
       ⚠️ 2026-10 那张"击杀/金币"卡已挪进左上角那张卡（用户口径"击杀和金币也放左边去"+页面简洁）。
       这里**不要**再加回任何常驻信息：顶部右侧现在只有一枚暂停键
       （它要给微信原生胶囊避让，见 setMenuReserve —— 之前信息卡跟着它一起下移，现在没有卡了）。 */
    var pauseR = game.pauseBtnRect ? game.pauseBtnRect() : null;
    if (pauseR) this.drawPauseButton(game, pauseR);

    /* ---- Boss / 精英 血条（顶部）----
       精英（`trialElite`）和 Boss 走同一条血条，名字用 **foeLabel**（和头顶名字同一处文案）：
       「精英 · 铁甲母蟹」/「领主 · 荒原巨蝎」（2026-10 用户口径：两处统一成"类型 · 名字"）。
       教学关的精英后面再跟一个括号（合成**一行**「精英 · 铁甲母蟹（击败精英 · 可能掉落武器技能）」，
       原来的"厚甲，行动迟缓"那行和单独的提示行都去掉 —— 顶部只留一条，别堆三行字）。
       ⚠️ 2026-10 用户口径：**名字这行也用紫色**（和头顶名字/身体外圈/脚下光环同一支 ELITE_NAME_COLOR）——
       原来这里是金色 #ffd166。括号那半句**保持浅灰白**，靠颜色分开主次（不要整行一个色）。
       血条本体（红条）表示血量、不是身份，**不跟着变**。 */
    for (var i = 0; i < game.foes.length; i++) {
      var f = game.foes[i];
      if (f.kind !== 'boss' && !f.trialElite) continue;
      var w2 = Math.max(200, Math.min(460, this.w * 0.42));
      var x2 = (this.w - w2) / 2;
      var lbl = foeLabel(this.cfg.ui, f) + (f.phase2 ? ' · 裂壳' : '');
      var hint = f.eliteTips ? '（击败精英 · 可能掉落武器技能）' : '';
      ctx.textAlign = 'left';
      ctx.font = '700 14px ' + FONT;
      var nw = ctx.measureText(lbl).width;
      ctx.font = '11.5px ' + FONT;
      var hw = hint ? ctx.measureText(hint).width : 0;
      var sx2 = this.w / 2 - (nw + hw) / 2;
      ctx.font = '700 14px ' + FONT;
      ctx.fillStyle = ELITE_NAME_COLOR;
      ctx.fillText(lbl, sx2, 44 + ins.top);
      if (hint) {
        ctx.font = '11.5px ' + FONT;
        ctx.fillStyle = 'rgba(255,255,255,.78)';
        ctx.fillText(hint, sx2 + nw, 45 + ins.top);
      }
      bar(ctx, x2, 52 + ins.top, w2, 14, f.hp / f.maxhp, '#c0554f');
      break;
    }

    if (this.hint && game.state === 'play' && !game.training) {
      ctx.textAlign = 'center';
      ctx.font = '12.5px ' + FONT;
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillText(this.hint, this.w / 2, this.h - 16 - ins.bottom);
    }
  };

  /**
   * 武器试炼场底栏：两行共六个按钮 + 当前武器与独有机制说明 + Boss/铁角召唤状态。
   * 目的是"点一次换一把"，所以按钮要比说明更显眼。
   */
  Renderer.prototype.drawTrainingBar = function (game) {
    var ctx = this.ctx, ins = this.insets;
    var rects = game.trainingRects();
    var W = game.weapon();

    var title = '武器试炼场 · 点下面的按钮换武器';
    var mech = W.trait ? ('独有机制：' + W.trait.label) : '无独有机制（均衡基准）';
    var wline = W.name + '（' + W.desc + '）　' + mech;
    var bossName = game.trainingBossName ? game.trainingBossName() : '';
    var nCharger = game.trainingChargerCount ? game.trainingChargerCount() : 0;
    var sline = 'Boss 试炼：' + bossName + '　　铁角：' +
                (nCharger > 0 ? (nCharger + ' 只（看它蓄力时的冲撞路线）') : '未召唤');

    // 顶部 HUD（血条 + 等级/经验条，底部约 69px）和 Boss 血条都占着屏幕上方，
    // 标题块必须整体让开，否则字和条子叠在一起谁都看不清。
    var top = 78 + ins.top;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // 底衬：三行字压在地面和特效上会糊，加一层薄底就干净了
    ctx.font = '700 16px ' + FONT;
    var bw = ctx.measureText(title).width;
    ctx.font = '13.5px ' + FONT;
    bw = Math.max(bw, ctx.measureText(wline).width);
    ctx.font = '12.5px ' + FONT;
    bw = Math.max(bw, ctx.measureText(sline).width);
    bw += 30;
    ctx.fillStyle = 'rgba(6,9,13,.58)';
    ctx.fillRect(this.w / 2 - bw / 2, top - 17, bw, 68);

    ctx.font = '700 16px ' + FONT;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillText(title, this.w / 2, top + 1);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(title, this.w / 2, top);

    ctx.font = '13.5px ' + FONT;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillText(wline, this.w / 2, top + 23);
    ctx.fillStyle = '#f2efe9';
    ctx.fillText(wline, this.w / 2, top + 22);

    var line = sline;
    ctx.font = '12.5px ' + FONT;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillText(line, this.w / 2, top + 45);
    ctx.fillStyle = (game.trainingBossIdx || nCharger > 0) ? '#ff9b6b' : 'rgba(255,255,255,.6)';
    ctx.fillText(line, this.w / 2, top + 44);

    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var accent = (r.id === 'next' || r.id === 'prev') ? '#ffd166'
                 : (r.id === 'exit' ? '#e8564f' : (r.id === 'charger' ? '#e08a5a' : '#6aa9e0'));
      ctx.fillStyle = 'rgba(0,0,0,.80)';
      ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      ctx.fillStyle = rgba(accent, 0.24);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.8;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.font = '600 14px ' + FONT;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.label, r.x + r.w / 2, r.y + r.h / 2);
      ctx.textBaseline = 'alphabetic';
    }

    // 当前是第几把（方便知道还剩几把没试）
    var list = game.weaponKindList ? game.weaponKindList() : [];
    var idx = list.indexOf(game.weaponKind ? game.weaponKind() : 'sword');
    ctx.font = '12px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillText((idx + 1) + ' / ' + list.length, this.w / 2, rects[0].y - 12);
  };

  /* ==================== 升级卡 ==================== */
  Renderer.prototype.drawCards = function (game) {
    var ctx = this.ctx;
    ctx.fillStyle = 'rgba(5,7,10,.74)';
    ctx.fillRect(0, 0, this.w, this.h);

    var rects = game.cardRects();
    if (!rects.length) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 18px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText('升级！选一个（还剩 ' + game.player.pendingLevels + ' 次）', this.w / 2, rects[0].y - 26);

    var pal = ['#8fd6a5', '#6cc48f', '#6aa9e0', '#c07ae0'];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i], card = game.cards[i];
      /* 金色卡（rare）：统一用亮金 + 更亮的光晕 + 一层内框 —— 一眼就能和普通卡分开，
         也不用依赖卡片排序（原来 3 张卡的配色是按位置给的，金色卡必须打破那套）。 */
      var col = card.weapon ? '#68dcff' : (card.gold ? '#ffd94a' : pal[i % pal.length]);

      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = card.gold ? 30 : 18;
      ctx.fillStyle = card.gold ? 'rgba(38,32,14,.98)' : 'rgba(24,28,36,.98)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();

      ctx.fillStyle = rgba(col, 0.9);
      ctx.fillRect(r.x, r.y, r.w, 5);                     // 顶部色条
      ctx.strokeStyle = col;
      ctx.lineWidth = card.gold ? 3 : 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      if (card.gold) {                                    // 金色卡再压一圈内框，像"镶边"
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 5.5, r.y + 5.5, r.w - 11, r.h - 11);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffd94a';
        ctx.font = '700 11px ' + FONT;
        ctx.textAlign = 'left';
        ctx.fillText('稀有', r.x + 9, r.y + 21);
        ctx.textAlign = 'center';
      }

      if (card.weapon) {
        ctx.fillStyle = '#68dcff'; ctx.font = '700 11px ' + FONT;
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
        ctx.fillText(this.cfg.weapons[card.weapon].name + '专属 · 本局保留', r.x + r.w / 2, r.y + 20);
      }

      // 圆形图标里放卡名的第一个字，比纯文字好认
      var cx = r.x + r.w / 2, cy = r.y + r.h * (card.weapon ? 0.36 : 0.34);
      ctx.fillStyle = rgba(col, 0.18);
      ctx.beginPath(); ctx.arc(cx, cy, card.weapon ? 19 : 24, 0, 7); ctx.fill();
      ctx.strokeStyle = rgba(col, 0.75); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, card.weapon ? 19 : 24, 0, 7); ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = '600 22px ' + FONT;
      ctx.textBaseline = 'middle';
      ctx.fillText(card.name.charAt(0), cx, cy + 1);
      ctx.textBaseline = 'alphabetic';

      ctx.fillStyle = '#f2efe9';
      ctx.font = '600 16px ' + FONT;
      ctx.fillText(card.name, cx, r.y + r.h * 0.66);

      ctx.fillStyle = '#b9b5ae';
      ctx.font = '12.5px ' + FONT;
      wrapText(ctx, card.desc, cx, r.y + r.h * 0.78, r.w - 22, 15);
    }
    this.drawReroll(game);
    ctx.textBaseline = 'alphabetic';
  };

  /**
   * 重刷按钮（升级面板底部居中，和左下角武器库同一行）。
   * 主字：「重刷 · 免费」/「重刷 30 金币」；副字：本局还剩几次 / 本局已刷满 / 金币不够（有 X）
   *       / 不限次数时改报「下次 60 金币」，让玩家看得见"越刷越贵"（见 config.growth.reroll）。
   * 不可用时**置灰但不隐藏** —— 藏起来玩家会以为没这个功能（用户口径："就算一个武器也要显示"）。
   */
  Renderer.prototype.drawReroll = function (game) {
    var ctx = this.ctx, r = game.rerollBtnRect();
    var cost = game.rerollCost(), left = game.rerollLeft(), ok = game.canReroll();
    var free = cost === 0;
    var col = ok ? (free ? '#8fd6a5' : '#ffd166') : 'rgba(150,150,150,.55)';

    ctx.save();
    ctx.fillStyle = ok ? 'rgba(10,14,18,.94)' : 'rgba(12,14,16,.78)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 15px ' + FONT;
    ctx.fillStyle = ok ? '#fff' : 'rgba(232,232,232,.55)';
    ctx.fillText(free ? '重刷 · 免费' : '重刷 ' + cost + ' 金币', r.x + r.w / 2, r.y + 15);

    ctx.font = '11px ' + FONT;
    ctx.fillStyle = ok ? col : 'rgba(205,205,205,.5)';
    /* 副字四种：刷满 / 钱不够 / 不限次数时报**下一次的价** / 还剩几次。
       ⚠️ `left === Infinity` 必须单独判：不判的话会画出「本局还剩 Infinity 次」。 */
    var sub;
    if (left <= 0) sub = '本局已刷满';
    else if (game.player.gold < cost) sub = '金币不够（有 ' + game.player.gold + '）';
    else if (left === Infinity) sub = free ? '本局第一次免费' : '下次 ' + game.rerollNextCost() + ' 金币';
    else sub = '本局还剩 ' + left + ' 次';
    ctx.fillText(sub, r.x + r.w / 2, r.y + 30);
    ctx.restore();
  };

  function wrapText(ctx, text, cx, cy, maxW, lineH) {
    var chars = String(text).split('');
    var line = '', lines = [];
    for (var i = 0; i < chars.length; i++) {
      if (ctx.measureText(line + chars[i]).width > maxW && line) { lines.push(line); line = chars[i]; }
      else line += chars[i];
    }
    if (line) lines.push(line);
    for (var k = 0; k < lines.length; k++) ctx.fillText(lines[k], cx, cy + k * lineH);
  }

  /* ==================== 结束 ====================
     按钮化的结算页（2026-10）：以前是"点任意处重开"，现在这一页有
     再来一次 / 回首页 / 晒战绩 / 看视频复活 这么多东西，一个手势抢不过来。 */
  /**
   * 熟练度块（2026-10，结算页 + 通关面板共用同一个画法 —— 一处改两处生效）。
   * 一次说清三件事（用户口径）：**当前进度 / 这把拿到多少 / 下一级解锁什么**。
   * 排成两行、固定宽度 360（左缘 cx-180 / 右缘 cx+180）：
   *   ① 左「长剑熟练度 150 / 300」  右「本局 +150」
   *   ② 进度条（左半，宽 130）+ 右半「下一级 Lv2：解锁专属技能「剑阵回响」」
   *      （文案由 game.masteryRewardText 给，渲染层不拼；满级那行改说"满级奖励：…"）
   * ⚠️ 分母是 **mi.to = 当前等级的满级值**，不是满级大数。用户口径：用满级数当分母，
   *    刚起步就看着没戏；用本级上限，打完一把就是半条，看得见"再来一把"。
   * ⚠️ 满级时改用 `mi.rewardNow`（本级那个奖励，也就是满级奖励）；`masteryRewardText`
   *    返回 null（奖励内容还没定，比如双刀）时**不画右半** —— 露出"待开发"很难看。
   * ⚠️ 高度固定 26px（两行 + 一点余量），调用方按这个数字留位置：结算页那点空间是**量出来的**
   *    （DEAD_TEXT_H 一点都不能涨，涨了 812x375 会把下面的按钮顶出屏幕）。
   */
  Renderer.prototype.drawMasteryBlock = function (ctx, game, mi, cx, y) {
    if (!mi) return y + 26;
    var half = 180, left = cx - half, right = cx + half;
    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + FONT;
    /* ① 名字 + 当前 / 本级上限 */
    ctx.textAlign = 'left';
    ctx.fillStyle = '#c7ced4';
    ctx.fillText(mi.name + '熟练度　' + mi.pts + ' / ' + mi.to, left, y);
    /* ② 本局拿到多少（0 就不写，别摆一个"+0"吓人） */
    ctx.textAlign = 'right';
    if (mi.gainedRun > 0) {
      ctx.fillStyle = '#ffd166';
      ctx.fillText('本局 +' + mi.gainedRun, right, y);
    }
    /* ③ 进度条：本级区间内 */
    var barY = y + 13, barW = 130, barH = 4;
    var span = mi.to - mi.from;
    var frac = span > 0 ? Math.max(0, Math.min(1, (mi.pts - mi.from) / span)) : 1;
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(left, barY, barW, barH);
    ctx.fillStyle = '#8fd6a5';
    ctx.fillRect(left, barY, Math.round(barW * frac), barH);
    /* ④ 下一级解锁什么（满级时改说"满级奖励"）。
       ⚠️ 文案**一律走 game.masteryRewardText** —— 渲染层不许自己拼这句。
          2026-10：这一支原来是渲染层自己拼的 `→ Lv2 · 剑阵回响`（只有个名字，看不出类别），
          而满级那支早就调了那个函数、说得很清楚 ⇒ 一处两套写法，用户就是从这里觉得"没写清楚"。 */
    var txt = game.masteryRewardText(mi.maxed ? mi.rewardNow : mi.reward, mi.maxed);
    if (txt) {
      ctx.textAlign = 'left';
      ctx.font = '10px ' + FONT;
      /* 兜底：奖励名字以后变长，也不能顶出面板右缘。
         可用宽度 ≈ 258px（块自身占 180，但这一行右半边是空的、可以借到面板右缘）——
         不是 218px：满级那句实测 221px，按 218 会被误降一档字号。 */
      var maxW = 258, fs = 10;
      while (fs > 8 && ctx.measureText(txt).width > maxW) { fs--; ctx.font = fs + 'px ' + FONT; }
      ctx.fillStyle = mi.maxed ? '#ffd166' : '#8fd6a5';
      ctx.fillText(txt, left + barW + 12, barY + barH / 2);
    }
    return y + 26;
  };

  Renderer.prototype.drawGameOver = function (game) {
    var ctx = this.ctx, P = game.player, R = game.deadRects();
    var w = this.w, cx = w / 2, cy = R.textTop;

    ctx.save();
    ctx.fillStyle = 'rgba(5,7,10,.85)';
    ctx.fillRect(0, 0, w, this.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#fff';
    ctx.font = '600 26px ' + FONT;
    ctx.fillText('你倒下了', cx, cy + 16);

    /* 「输在哪」：只死在一只 Boss 手上时才有（用户口径「这条是真信息」）。
       挂在标题下面当一行小字，**不占下面那四块排好的间距** ——
       有它就整体下压 12~15px、没有就照旧（两种情况的间距各自都是排匀的：
       有 = 3/9/8.5/10/8，无 = 12/11.5/14/13）；DEAD_TEXT_H 仍是 132，按钮一行不动。 */
    var lost = game.deathLostTo || null;
    if (lost) {
      ctx.font = '12px ' + FONT;
      ctx.fillStyle = '#ffd166';
      ctx.fillText(lost, cx, cy + 38);
    }

    ctx.font = '14px ' + FONT;
    ctx.fillStyle = '#b9b6b0';
    ctx.fillText('等级 ' + P.level + ' · 击杀 ' + P.kills + ' · 波次 ' + game.wave + ' · 本局金币 ' + (P.runGold || 0),
      cx, cy + (lost ? 60 : 48));

    // 带着什么装备走的 —— 让"这一局攒了什么"看得见
    var parts = [];
    var slots = this.cfg ? this.cfg.items.slots : [];
    for (var i = 0; i < slots.length; i++) {
      var it = P.equip[slots[i].id];
      if (it) parts.push(it.rarityName + (it.kind ? it.name : it.slotName));
    }
    ctx.font = '13px ' + FONT;
    ctx.fillStyle = '#8fd6a5';
    ctx.fillText(parts.length ? parts.join('　') : '没捡到装备', cx, cy + (lost ? 82 : 73));

    /* ---- 死亡结算那行提示：**整行去掉**（2026-10 用户口径「把下局目标去掉, 让他们排版更好一点」）
       它原来有三种内容：
         ① 无 Boss 时「下局目标：突破第 N 关」—— 试玩版只有一关，这句永远是同一句，
            而且指的是"你刚卡住的那关"，等于废话（用户点名的就是它）
         ② 有 Boss 时「XX还剩 X% 生命」（"输在哪"，是有用信息，但也跟着一起去了）
         ③ 兜底「换种搭配，再挑战一次」；榜单开着时还会顶成榜上成绩（榜单现在关着、本版不出现）
       去掉之后上面几行才有空间排匀（行距 12/11.5/14/13），熟练度块也不用再贴着分隔线。
       ⚠️ 要恢复"输在哪"就**别加常驻行**（那正是被去掉的东西）—— 建议挂在标题下面当一行小字。 */
    this.drawMasteryBlock(ctx, game, game.masteryInfo(), cx, cy + (lost ? 104 : 99));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 92, cy + 130); ctx.lineTo(cx + 92, cy + 130); ctx.stroke();

    var kind;
    for (var j = 0; j < R.rows.length; j++) {
      var b = R.rows[j];
      kind = b.kind === 'primary' ? 'primary' : (b.kind === 'ad' ? 'ad' : 'ghost');
      this.drawBtn(b, b.label, kind, 15);
    }
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  };

  /* ==================== 首页 / 面板 / 按钮（两端共用） ==================== */

  /**
   * 角色剪影：头 + 肩 + 短打下摆 + 双腿（一条 path，多个子路径）。
   * 狂热光晕和冲刺残影都描它 —— 2026-10 之前狂热那圈是**手拼的折线**，
   * 有几笔直接拉出体外，看着像给角色套了个支架。改身体形状时只要改这里，
   * 光晕/残影自动跟着变（不会各画各的、越改越错位）。
   * g = {x, y0, hx, hr, hw, shX, legF, legB, legA}（就是 drawPlayer 里算的那套几何）
   * ⚠️ 脚永远在 P.y：冲刺前倾时只有上半身挪，脚不跟着飘。
   */
  function pathPlayerSilhouette(ctx, P, g) {
    var x = g.x, y0 = g.y0, legA = g.legA || 0;
    var hx = x + (g.hx || 0), hw = g.hw || 9, sh = x + (g.shX || 0);
    ctx.beginPath();
    ctx.ellipse(hx, y0 + 3, 9.4 * (g.hr || 1), 9.4, 0, 0, Math.PI * 2);   // 头
    ctx.moveTo(sh - hw, y0 + 27);                                        // 短打（下摆比长袍短）
    ctx.lineTo(sh - hw + 1, y0 + 13);
    ctx.quadraticCurveTo(sh, y0 + 8, sh + hw, y0 + 13);
    ctx.lineTo(sh + hw + 0.5, y0 + 27);
    ctx.closePath();
    var l1 = x + (g.legF || 1.5) + legA * 1.6, l2 = x + (g.legB || -8) - legA * 1.6;
    ctx.moveTo(l1 - 1.5, P.y - 17); ctx.lineTo(l1 + 8, P.y - 17);
    ctx.lineTo(l1 + 8, P.y + 1.5); ctx.lineTo(l1 - 1.5, P.y + 1.5); ctx.closePath();
    ctx.moveTo(l2 - 1.5, P.y - 17); ctx.lineTo(l2 + 8, P.y - 17);
    ctx.lineTo(l2 + 8, P.y + 1.5); ctx.lineTo(l2 - 1.5, P.y + 1.5); ctx.closePath();
  }

  function pathRoundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  /**
   * 统一按钮（首页 / 暂停面板 / 结算页共用），三种语气：
   *   primary 实心琥珀 = 这是建议你点的那个（开始 / 继续 / 再来一次）
   *   ad      蓝色描边 = 要看广告（刻意和"继续玩"区分开，别让人误点）
   *   ghost   白色描边 = 次级（重新开始 / 回首页 / 晒战绩）
   */
  Renderer.prototype.drawBtn = function (r, label, kind, fontSize) {
    var ctx = this.ctx;
    ctx.save();
    pathRoundRect(ctx, r.x, r.y, r.w, r.h, 10);
    if (kind === 'primary') {
      ctx.fillStyle = '#ffd166'; ctx.fill();
      ctx.fillStyle = '#241a05';
    } else if (kind === 'ad') {
      ctx.fillStyle = 'rgba(126,224,255,.14)'; ctx.fill();
      ctx.strokeStyle = 'rgba(126,224,255,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#bfeaff';
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.26)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#e6eaee';
    }
    ctx.font = '600 ' + (fontSize || 16) + 'px ' + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
    ctx.restore();
  };

  /** 开关行：左边文字、右边一个胶囊（开着=绿、关了=灰），状态直接写在胶囊上 */
  Renderer.prototype.drawToggleRow = function (r, on) {
    var ctx = this.ctx;
    ctx.save();
    pathRoundRect(ctx, r.x, r.y, r.w, r.h, 10);
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();

    ctx.font = '15px ' + FONT;
    ctx.fillStyle = '#dfe4e8';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(r.label, r.x + 16, r.y + r.h / 2);

    var pw = 58, ph = 28;
    var px = r.x + r.w - 16 - pw, py = r.y + (r.h - ph) / 2;
    pathRoundRect(ctx, px, py, pw, ph, ph / 2);
    ctx.fillStyle = on ? 'rgba(143,214,165,.92)' : 'rgba(255,255,255,.16)';
    ctx.fill();
    ctx.fillStyle = on ? '#0d1f14' : '#9aa2a9';
    ctx.font = '600 13px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText(on ? '开' : '关', px + pw / 2, py + ph / 2);
    ctx.restore();
  };

  /** 面板（暂停 / 设置共用）：深色卡 + 标题 + 一列按钮或开关 */
  Renderer.prototype.drawPanel = function (game, R) {
    var ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,10,.72)';
    ctx.fillRect(0, 0, this.w, this.h);

    pathRoundRect(ctx, R.panel.x, R.panel.y, R.panel.w, R.panel.h, 14);
    ctx.fillStyle = 'rgba(10,14,18,.96)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.stroke();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8ecef'; ctx.font = '600 18px ' + FONT;
    ctx.fillText(R.title, R.panel.x + R.panel.w / 2, R.panel.y + 20);

    for (var i = 0; i < R.rows.length; i++) {
      var b = R.rows[i];
      if (b.kind === 'toggle') this.drawToggleRow(b, !!(game.settings && game.settings[b.id]));
      else if (b.kind === 'locked' || b.kind === 'current') this.drawLockRow(b);
      else this.drawBtn(b, b.label, b.kind === 'primary' ? 'primary' : 'ghost', 15);
    }
    ctx.restore();
  };

  /**
   * 面板里"不可选"的一行：**故意不做成按钮的样子** —— 按钮的样子本身就在说"可以点"，
   * 而用户口径是「其他变成不可选」（开局武器面板，2026-10）。
   * `current` = 当前这把（主题色高亮）；`locked` = 锁着（灰 + 小锁）。
   *
   * 2026-10（用户选的方案 1：熟练度并进这个面板，零新增入口）之后，一行里排**两行字**：
   *   第 1 行 = 名字（+ 小锁 / 当前那把的"开局武器"小标签） ......... 右上 `.mstr` 练度读数
   *   第 2 行 = 一句说明（`.next` 优先 —— "下一级解锁什么"；没有就 `.note` —— "怎么解锁"）
   * ⚠️ 行高 h **没动**（还是 36）。算过：6 行整体涨到 40 时面板 y 会退到 panelRects 在矮屏的
   *    `top+12` 底线、把底部安全区压掉 ⇒ 是"同一个行高里排两行"，不是加高。字号也没动
   *    （名字 15px、说明 10px，和改动前一模一样）。
   * ⚠️ 练度数字**不在这里算、这里也不拼 `Lv` 字样** —— `.mstr` / `.next` 全部由核心层给
   *    （`masteryShortText` / `masteryRewardText`，跟结算页那块同一个来源）。
   *    验收里有静态断言守着这条：渲染层"同一个数写两处"已经栽过四次。
   */
  Renderer.prototype.drawLockRow = function (r) {
    var ctx = this.ctx, cur = (r.kind === 'current');
    var y1 = r.y + 12, y2 = r.y + 26;          // 两行中线：15px + 10px 在 36 里排匀（上 5 / 下 5）
    ctx.save();
    pathRoundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fillStyle = cur ? 'rgba(255,209,102,.13)' : 'rgba(255,255,255,.035)';
    ctx.fill();
    ctx.strokeStyle = cur ? 'rgba(255,209,102,.5)' : 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1.5; ctx.stroke();

    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = '600 15px ' + FONT;
    ctx.fillStyle = cur ? '#ffd166' : 'rgba(255,255,255,.40)';
    ctx.fillText(r.label, r.x + 14, y1);
    var lw = ctx.measureText(r.label).width;

    if (!cur) {                                   // 小锁：名字右边一把灰锁，一眼"这把还锁着"
      var lx = r.x + 14 + lw + 9, ly = y1 - 4;
      ctx.strokeStyle = 'rgba(255,255,255,.34)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(lx + 5, ly, 3.4, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.20)'; ctx.fillRect(lx, ly, 10, 8);
      ctx.strokeStyle = 'rgba(255,255,255,.36)'; ctx.strokeRect(lx + 0.5, ly + 0.5, 9, 7);
    } else if (r.note && r.next) {
      /* 第 2 行被"下一级解锁什么"占了 ⇒ 把"开局武器"挪到名字后面当小标签（不丢信息） */
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = 'rgba(255,209,102,.62)';
      ctx.fillText(r.note, r.x + 14 + lw + 8, y1 + 1);
    }

    if (r.mstr) {                                 // 右上：练度读数（`Lv2 · 150/300` / `Lv4 · 满级`）
      ctx.textAlign = 'right';
      ctx.font = '11px ' + FONT;
      ctx.fillStyle = cur ? 'rgba(255,209,102,.92)' : 'rgba(255,255,255,.40)';
      ctx.fillText(r.mstr, r.x + r.w - 14, y1);
    }

    var line2 = r.next || r.note;                 // 第 2 行：一句说明，占整行宽（名字挪上去了，不用再挤右半边）
    if (line2) {
      ctx.textAlign = 'left';
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = cur ? 'rgba(255,209,102,.80)' : 'rgba(255,255,255,.34)';
      /* 兜底：说明以后变长也不能顶出面板（可用宽 = 行宽 - 两边各 14） */
      var maxW = r.w - 28, fs = 10;
      while (fs > 8 && ctx.measureText(line2).width > maxW) { fs--; ctx.font = fs + 'px ' + FONT; }
      ctx.fillText(line2, r.x + 14, y2);
    }
    ctx.restore();
  };

  Renderer.prototype.drawPausePanel = function (game) {
    this.drawPanel(game, game.pauseRects());
  };

  /**
   * 试炼场·试卡面板（点名试用某张升级卡）。
   * 矩形全部来自 `game.trialCardPanelRects()` —— 渲染和判定共用同一份，改布局只改一处。
   *
   * 反馈只有三样，但都必须在**面板上**：点完的即时反馈是"格子立刻变金边 + 已试 N"
   * 和右上角一行「刚用上：XXX」。**不能用世界坐标的飘字** —— 面板盖住全屏，飘字在面板底下根本看不见。
   */
  Renderer.prototype.drawTrialCardPanel = function (game) {
    var ctx = this.ctx, cfg = this.cfg, P = game.player, R = game.trialCardPanelRects();
    var goldOn = !!game.trialCardGold, kind = game.weaponKind(), i;

    ctx.save();
    ctx.fillStyle = 'rgba(5,7,10,.84)';
    ctx.fillRect(0, 0, this.w, this.h);
    pathRoundRect(ctx, R.panel.x, R.panel.y, R.panel.w, R.panel.h, 14);
    ctx.fillStyle = 'rgba(10,14,18,.97)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.stroke();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8ecef'; ctx.font = '600 15px ' + FONT;
    ctx.fillText('试卡 · 点一下就用上（可重复点，数值会叠加）',
      R.panel.x + R.panel.w / 2, R.panel.y + 16);
    if (game.trialCardLast) {                       // 刚用上什么：面板上唯一"发生了什么"的回执
      ctx.textAlign = 'right'; ctx.font = '600 12px ' + FONT;
      ctx.fillStyle = 'rgba(255,209,102,.9)';
      ctx.fillText('刚用上：' + game.trialCardLast, R.panel.x + R.panel.w - 14, R.panel.y + 16);
      ctx.textAlign = 'center';
    }

    /* 分类页签：带上这一页有几张卡 —— 不然"某张卡没出现"会被当成 bug（停用的卡是真没列） */
    for (i = 0; i < R.tabs.length; i++) {
      var tb = R.tabs[i], on = game.trialCardCat === tb.id;
      pathRoundRect(ctx, tb.x, tb.y, tb.w, tb.h, 8);
      ctx.fillStyle = on ? 'rgba(255,209,102,.16)' : 'rgba(255,255,255,.05)'; ctx.fill();
      ctx.strokeStyle = on ? 'rgba(255,209,102,.85)' : 'rgba(255,255,255,.14)';
      ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = on ? '#ffd166' : '#98a4ab';
      ctx.font = '600 13px ' + FONT;
      ctx.fillText(tb.label + ' ' + game.trialCardList(tb.id).length, tb.x + tb.w / 2, tb.y + tb.h / 2 + 0.5);
    }

    var list = game.trialCardList(game.trialCardCat);
    for (i = 0; i < R.tiles.length; i++) {
      if (i >= list.length) break;                  // 这一页的卡列完了：剩下的格子留空，不画虚线框
      var u = list[i], t = R.tiles[i];
      var tried = (P.taken[u.id] || 0) + (P.taken[u.id + '#rare'] || 0);
      var gold = goldOn && !!u.rare;               // 金色开关开着 → 标签和效果都按金色版显示
      var other = !!u.weapon && u.weapon !== kind; // 别的武器的技能卡：现在装着也用不上，画淡

      pathRoundRect(ctx, t.x, t.y, t.w, t.h, 8);
      ctx.fillStyle = (tried || gold) ? 'rgba(255,209,102,.10)' : 'rgba(255,255,255,.045)';
      ctx.fill();
      ctx.strokeStyle = (tried || gold) ? 'rgba(255,209,102,.7)' : 'rgba(255,255,255,.12)';
      ctx.lineWidth = (tried || gold) ? 1.6 : 1; ctx.stroke();

      ctx.globalAlpha = other ? 0.42 : 1;
      ctx.textAlign = 'left';
      ctx.fillStyle = u.cost ? '#ffb37a' : ((tried || gold) ? '#ffe9a8' : '#dfe6ea');
      ctx.font = '600 13px ' + FONT;
      ctx.fillText(gold ? u.rare.name : u.name, t.x + 10, t.y + 15);

      ctx.font = '10px ' + FONT;
      var tag = other ? ('需' + ((cfg.weapons[u.weapon] && cfg.weapons[u.weapon].name) || u.weapon))
                      : (tried ? ('已试 ' + tried) : (gold ? '金色版' : ''));
      if (tag) {
        ctx.textAlign = 'right';
        ctx.fillStyle = other ? '#9beaff' : '#ffd166';
        ctx.fillText(tag, t.x + t.w - 10, t.y + 14);
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = '#93a0a8';
      ctx.font = '10px ' + FONT;
      wrapText(ctx, gold ? u.rare.desc : u.desc, t.x + 10, t.y + 32, t.w - 20, 12);
      ctx.globalAlpha = 1;
    }

    /* 底排三键：金色开关单独一个（真实池子里金色只有 12% 概率，不给入口就永远试不到） */
    for (i = 0; i < R.foot.length; i++) {
      var f = R.foot[i];
      if (f.id === 'clear') this.drawBtn(f, f.label, 'ghost', 13);
      else if (f.id === 'gold') this.drawBtn(f, f.label, goldOn ? 'primary' : 'ghost', 13);
      else this.drawBtn(f, f.label, 'primary', 13);
    }
    ctx.restore();
  };

  /** 右上角的暂停键（两条白杠 + 一层薄底，草地/冻原上都看得见） */
  Renderer.prototype.drawPauseButton = function (game, r) {
    if (!game.pauseAvailable()) return;      // 只有打的时候才画（暂停中/结算/首页都不画）
    var ctx = this.ctx, t = this.lastT || 0;
    /* 刚开局 3 秒内轻微呼吸一下 —— 新玩家要"发现"这里有暂停键 */
    var breathe = game.elapsed < 3 ? (0.72 + 0.28 * Math.abs(Math.sin(t * 2.4))) : 1;
    ctx.save();
    ctx.globalAlpha = breathe;
    pathRoundRect(ctx, r.x, r.y, r.w, r.h, 10);
    ctx.fillStyle = 'rgba(6,10,14,.55)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.x + r.w / 2 - 7, r.y + 12, 4.5, 16);
    ctx.fillRect(r.x + r.w / 2 + 2.5, r.y + 12, 4.5, 16);
    ctx.restore();
  };

  /**
   * 首页：标题 + 战绩 + 按钮，一屏之内只有这些（不摆装饰）。
   * 按钮由核心层给（game.titleRects）：有"没打完的一局"时是两个按钮
   * （继续上次 / 重新开始），没有时只有一个「开始游戏」。
   */
  Renderer.prototype.drawTitle = function (game) {
    var ctx = this.ctx, w = this.w, h = this.h, ins = this.insets, ui = game.cfg.ui;
    var R = game.titleRects(), i;

    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#101820');
    g.addColorStop(1, '#0a0f14');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var ty = R.titleY;
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 40px ' + FONT;
    ctx.fillText(ui.title, w / 2, ty);
    ctx.fillStyle = '#8b9298';
    ctx.font = '14px ' + FONT;
    ctx.fillText(ui.tagline, w / 2, ty + 34);

    /* 最高记录：**没玩过就不画这一行**（用户口径：数据缺失宁可留空，也别显示 0
       —— "最高 第 1 关 · 击杀 0" 会被读成"打到过第 1 关但一个都没杀"）。 */
    var played = (game.bestKills || 0) > 0 || (game.bestWave || 1) > 1 || (game.runs || 0) > 0;
    if (played) {
      ctx.fillStyle = '#6f767c';
      ctx.font = '13px ' + FONT;
      ctx.fillText('最高 第 ' + (game.bestWave || 1) + ' 关 · 击杀 ' + (game.bestKills || 0) +
                   ((game.player.gold || 0) > 0 ? ' · 金币 ' + game.player.gold : ''), w / 2, ty + 56);
    }

    for (i = 0; i < R.main.length; i++) {
      this.drawBtn(R.main[i], R.main[i].label, R.main[i].id === 'restart' ? 'ghost' : 'primary', 17);
    }

    /* 有得续的时候说清"续的是什么"：第几关、几级、死了多少 —— 不然「继续上次」是盲选 */
    if (game.hasResume()) {
      var rr = game.pendingResume, last = R.main[R.main.length - 1];
      var lv = (game.resumeData && game.resumeData.level) || 1;
      ctx.fillStyle = '#7d848b';
      ctx.font = '12.5px ' + FONT;
      ctx.fillText('上次：第 ' + rr.stage + ' 关 · Lv ' + lv + ' · 击杀 ' + (rr.kills || 0),
        w / 2, last.y + last.h + 20);
    }

    /* 试炼场入口（调试专用）：和「设置」同款的文字按钮，摆在它左边一个身位。
       用文字而不是画个图标 —— 旁边那个"齿轮"其实是文字按钮「设置」，同款更统一。
       它只在 debug.enabled 时存在（titleRects().trial 为 null 就不画），
       位置固定 ⇒ 不会像原来的"长按空白"那样误触。 */
    if (R.trial) this.drawBtn(R.trial, R.trial.label, 'ghost', 13);
    if (R.rank) this.drawBtn(R.rank, R.rank.label, 'ghost', 13);   // 开关关掉时 R.rank 是 null（见 cfg.ui.rankOnTitle）
    this.drawBtn(R.settings, ui.settings, 'ghost', 13);
    for (i = 0; i < R.info.length; i++) this.drawBtn(R.info[i], R.info[i].label, 'ghost', 14);

    if (game.cfg.debug.enabled && R.hint) {
      /* ⚠️ 这行提示原来画在 `h - 18`，**正好压在底部那排「游戏介绍/玩法说明/开局」上**
         （出图才发现：三个 ghost 按钮是半透明的，文字从按钮里透出来，像版式坏了）。
         现在位置来自 `titleRects().hint`（按钮排上面 11px），并给 baseline —— 别再按"屏幕底部往上减"算。 */
      ctx.fillStyle = '#3f474e';
      ctx.font = '11px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('debug：右上角「试炼」进试炼场 · 上线前 debug.enabled 改回 false', R.hint.x, R.hint.y);
    }
    ctx.textBaseline = 'alphabetic';

    if (game.settingsOpen) this.drawPanel(game, game.settingsRects());
    if (game.loadoutOpen) this.drawPanel(game, game.loadoutRects());
    if (game.infoOpen) this.drawInfoPanel(game);
    if (game.codexOpen) this.drawCodex(game);
    if(game.rankOpen)this.drawRankPanel(game);
  };

  Renderer.prototype.drawRankPanel=function(game){
    var ctx=this.ctx,R=game.rankRects();ctx.save();ctx.fillStyle='#0b151d';ctx.fillRect(0,0,this.w,this.h);
    ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillStyle='#ffd166';ctx.font='700 20px '+FONT;ctx.fillText('好友挑战成绩榜',R.x,R.y+17);
    ctx.fillStyle='#bdcbc8';ctx.font='12px '+FONT;ctx.fillText('首页开局也计榜 · 通关/失败自动记录 · 续玩累计用时 · 暂停/选卡不计时',R.x,R.y+48);
    ctx.fillStyle='#849b99';ctx.fillText('荒原挑战 v2 · 通关优先，再比进度和用时 · 死亡/通关自动提交',R.x,R.y+65);
    if(game.ranking)game.ranking.draw(ctx,R.list);else{ctx.fillStyle='#bec9c6';ctx.fillText('请在微信中查看好友榜',R.list.x+16,R.list.y+35);}
    [R.back,R.challenge,R.refresh,R.prev,R.next].forEach(function(b){this.drawBtn(b,b.label,b===R.challenge?'primary':'ghost',12);},this);ctx.restore();
  };

  Renderer.prototype.drawInfoPanel = function (game) {
    var ctx = this.ctx, r = game.infoRects(), pages = game.cfg.infoPages[game.infoOpen];
    var page = pages[Math.min(pages.length - 1, game.infoPage)];
    ctx.save();
    ctx.fillStyle = '#090f16'; ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#121f2b'; pathRoundRect(ctx, r.panel.x, r.panel.y, r.panel.w, r.panel.h, 12); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd166'; ctx.font = '700 19px ' + FONT;
    ctx.fillText(game.cfg.ui.title + ' · ' + (game.infoOpen === 'intro' ? '游戏介绍' : '玩法说明'), r.panel.x + 20, r.panel.y + 25);
    for (var i = 0; i < r.tabs.length; i++) this.drawBtn(r.tabs[i], r.tabs[i].label, i === game.infoPage ? 'primary' : 'ghost', 13);
    // 按实际字体宽度排版；小屏时缩小到13px，段落保持可读且不覆盖返回按钮。
    var size = 15, lines, lineH;
    do {
      lines = []; lineH = size + 7; ctx.font = size + 'px ' + FONT;
      for (var j = 0; j < page.paragraphs.length; j++) {
        var text = page.paragraphs[j], line = '';
        for (var k = 0; k < text.length; k++) {
          if (line && ctx.measureText(line + text[k]).width > r.body.w) { lines.push(line); line = ''; }
          line += text[k];
        }
        if (line) lines.push(line);
        if (j < page.paragraphs.length - 1) lines.push('');
      }
      var textHeight = lines.reduce(function (sum, row) { return sum + (row ? lineH : lineH * 0.45); }, 0);
      if (textHeight <= r.body.h || size <= 13) break;
      size--;
    } while (true);
    ctx.fillStyle = '#dae4ed'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    var textY = r.body.y;
    for (i = 0; i < lines.length; i++) {
      if (lines[i]) ctx.fillText(lines[i], r.body.x, textY);
      textY += lines[i] ? lineH : lineH * 0.45;
    }
    this.drawBtn(r.back, r.back.label, 'ghost', 13);
    ctx.restore();
  };

  /**
   * 武器图鉴页（2026-10 · 首页 · 用户选的 Aa / Ba）。一把武器一个页签，页内两块：
   *   ① 技能：这把武器**全部**技能 —— 名字 / 状态 / **描述全文**（Ba：没拿到也显示完整描述）
   *   ② 熟练度：Lv1~LvN 每级给什么（内容还没配的等级**留白**，不写"待开发"）
   * 两版版式（game.codexStyle）：'A' 上下两块（技能横排卡片 + 熟练度横排格子）、
   *                             'B' 左右两块（技能竖列表 + 熟练度竖列表）—— 出图给用户挑。
   * 矩形全部来自 `game.codexRects()`（渲染和判定共用一份，改布局只改一处）。
   * ⚠️ 这里**不拼 "Lv"、不算等级、不拼奖励文案**：技能行来自 weaponSkillRows、
   *    熟练度行来自 codexMasteryRows（再往上是 config.mastery.levels）。
   *    "同一个数写两处"已经栽过四次，渲染层只负责画。
   */
  Renderer.prototype.drawCodex = function (game) {
    var ctx = this.ctx;
    var style = game.codexStyle || 'A';
    var r = game.codexRects(style);
    var kind = game.codexKind || game.startWeaponInfo().kind;
    var wdef = this.cfg.weapons[kind] || {};
    var skills = game.weaponSkillRows(kind);
    var mrows = game.codexMasteryRows(kind);
    var mi = game.masteryInfo(kind);
    var owned = 0, i, j;
    for (i = 0; i < skills.length; i++) if (skills[i].owned) owned++;

    /* 按可用宽度把一段话拆成行（中文逐字拆；图鉴里描述要显示全文） */
    function wrap(text, maxW) {
      var out = [], line = '';
      for (var k = 0; k < text.length; k++) {
        if (line && ctx.measureText(line + text[k]).width > maxW) { out.push(line); line = ''; }
        line += text[k];
      }
      if (line) out.push(line);
      return out;
    }
    /* 一块的标题行：左边一句、右边一句读数 */
    function head(box, left, right, color) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = '600 13px ' + FONT; ctx.fillStyle = color || 'rgba(255,255,255,.72)';
      ctx.fillText(left, box.x, box.y + 11);
      if (right) {
        ctx.textAlign = 'right'; ctx.font = '11px ' + FONT;
        ctx.fillStyle = 'rgba(255,255,255,.46)';
        ctx.fillText(right, box.x + box.w, box.y + 11);
      }
    }

    ctx.save();
    /* 整页底 + 内容框（和「游戏介绍」那页同一套观感） */
    ctx.fillStyle = '#080d13'; ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#121f2b';
    pathRoundRect(ctx, r.panel.x, r.panel.y, r.panel.w, r.panel.h, 12); ctx.fill();
    for (i = 0; i < r.tabs.length; i++) {
      this.drawBtn(r.tabs[i], this.cfg.weapons[r.tabs[i].kind].name,
        r.tabs[i].kind === kind ? 'primary' : 'ghost', 12.5);
    }
    /* 这把是什么：名字 + 手感 + 独有机制（画在页签和 body 之间那条空档里，位置由矩形算出）
       ⚠️ 别写死 y：那行原来按"页签底 + 16"写死，body 一往上贴就和「技能」标题叠字了。 */
    var nameY = Math.round((r.tabs[0].y + r.tabs[0].h + r.body.y) / 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '700 14px ' + FONT; ctx.fillStyle = '#ffd166';
    var nm = wdef.name || kind;
    ctx.fillText(nm, r.panel.x + 14, nameY);
    var nw = ctx.measureText(nm).width;
    ctx.font = '11px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.fillText((wdef.desc || '') + (wdef.trait && wdef.trait.label ? ' · 独有：' + wdef.trait.label : ''),
      r.panel.x + 14 + nw + 10, nameY + 1);

    var SB = r.skills, MB = r.mastery;

    /* ============ ① 技能 ============ */
    head(SB, '技能', '已获得 ' + owned + ' / ' + skills.length, '#e8ecef');
    if (style === 'B') {
      /* 竖列表：一张技能一行（名字 + 状态 + 描述全文） */
      var ry = SB.y + 26, rgap = 8;
      var rh = skills.length ? (SB.h - 26 - rgap * (skills.length - 1)) / skills.length : SB.h;
      for (i = 0; i < skills.length; i++) {
        var s = skills[i], y = ry + i * (rh + rgap);
        pathRoundRect(ctx, SB.x, y, SB.w, rh, 9);
        ctx.fillStyle = s.owned ? 'rgba(255,209,102,.09)' : 'rgba(255,255,255,.035)'; ctx.fill();
        ctx.strokeStyle = s.owned ? 'rgba(255,209,102,.5)' : 'rgba(255,255,255,.13)';
        ctx.lineWidth = 1.4; ctx.stroke();
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left'; ctx.font = '700 14px ' + FONT;
        ctx.fillStyle = s.owned ? '#ffd166' : '#e2e8ec';
        ctx.fillText(s.name, SB.x + 12, y + 17);
        ctx.textAlign = 'right'; ctx.font = '10.5px ' + FONT;
        ctx.fillStyle = s.owned ? '#9fd9c9' : '#8d9aa6';
        ctx.fillText(s.status, SB.x + SB.w - 12, y + 18);
        ctx.textAlign = 'left'; ctx.font = '12px ' + FONT;
        ctx.fillStyle = 'rgba(228,234,238,.84)';
        var ls = wrap(s.desc, SB.w - 24), ly = y + 39;
        for (j = 0; j < ls.length; j++) { ctx.fillText(ls[j], SB.x + 12, ly); ly += 16; }
      }
    } else {
      /* 横排卡片：**张数按实际算**（长剑 3 张 —— 原来写死 2 列，第 3 张会画到面板外） */
      var n = Math.max(1, skills.length), cgap = 10;
      var cw = (SB.w - cgap * (n - 1)) / n, cy = SB.y + 26, ch = SB.h - 26;
      for (i = 0; i < skills.length; i++) {
        var s2 = skills[i], x = SB.x + i * (cw + cgap);
        pathRoundRect(ctx, x, cy, cw, ch, 9);
        ctx.fillStyle = s2.owned ? 'rgba(255,209,102,.09)' : 'rgba(255,255,255,.035)'; ctx.fill();
        ctx.strokeStyle = s2.owned ? 'rgba(255,209,102,.5)' : 'rgba(255,255,255,.13)';
        ctx.lineWidth = 1.4; ctx.stroke();
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.font = '700 14.5px ' + FONT;
        ctx.fillStyle = s2.owned ? '#ffd166' : '#e2e8ec';
        ctx.fillText(s2.name, x + 11, cy + 9);
        ctx.font = '10.5px ' + FONT;
        ctx.fillStyle = s2.owned ? '#9fd9c9' : '#8d9aa6';
        ctx.fillText(s2.status, x + 11, cy + 30);
        /* 描述全文：先按 12.5px 排，放不下就降字号（描述以后变长也不会被截掉） */
        var fs = 12.5, lineH = 17, avail = ch - 54, lines;
        while (true) {
          ctx.font = fs + 'px ' + FONT;
          lines = wrap(s2.desc, cw - 22);
          if (fs <= 10 || lines.length * lineH <= avail) break;
          fs -= 0.5;
        }
        ctx.fillStyle = 'rgba(228,234,238,.84)';
        var ly2 = cy + 52;
        for (j = 0; j < lines.length; j++) { ctx.fillText(lines[j], x + 11, ly2); ly2 += lineH; }
      }
    }

    /* ============ ② 熟练度 ============ */
    head(MB, '熟练度', game.masteryShortText(mi), '#e8ecef');
    if (style === 'B') {
      /* 竖列表：一级一行（等级 + 门槛 + 这一级给什么） */
      var my = MB.y + 26, mgap = 8;
      var mh = (MB.h - 26 - mgap * (mrows.length - 1)) / mrows.length;
      for (i = 0; i < mrows.length; i++) {
        this.drawCodexLevelRow(ctx, MB.x, my + i * (mh + mgap), MB.w, mh, mrows[i], wrap);
      }
    } else {
      /* 横排格子：一级一格 */
      var mn = mrows.length, ggap = 8;
      var gw = (MB.w - ggap * (mn - 1)) / mn, gy = MB.y + 26, gh = MB.h - 26;
      for (i = 0; i < mrows.length; i++) {
        this.drawCodexLevelTile(ctx, MB.x + i * (gw + ggap), gy, gw, gh, mrows[i], wrap);
      }
    }

    this.drawBtn(r.back, r.back.label, 'ghost', 12);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '10.5px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText('技能来自精英怪掉落 · 熟练度靠打完 Boss 通关累积', r.panel.x + r.panel.w / 2, r.panel.y + r.panel.h - 22);
    ctx.restore();
  };

  /** 图鉴 · 熟练度：横排格子（等级 / 门槛 / 这一级给什么）。text 为空 = 内容还没配 → 留白 */
  Renderer.prototype.drawCodexLevelTile = function (ctx, x, y, w, h, row, wrap) {
    pathRoundRect(ctx, x, y, w, h, 9);
    ctx.fillStyle = row.current ? 'rgba(255,209,102,.12)'
                  : (row.reached ? 'rgba(143,214,165,.07)' : 'rgba(255,255,255,.03)');
    ctx.fill();
    ctx.strokeStyle = row.current ? 'rgba(255,209,102,.6)'
                    : (row.reached ? 'rgba(143,214,165,.42)' : 'rgba(255,255,255,.12)');
    ctx.lineWidth = 1.4; ctx.stroke();

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = '700 13.5px ' + FONT;
    ctx.fillStyle = row.current ? '#ffd166' : (row.reached ? '#9fd9c9' : 'rgba(255,255,255,.5)');
    ctx.fillText(row.label, x + 10, y + 9);
    ctx.textAlign = 'right'; ctx.font = '10.5px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText(row.needText, x + w - 10, y + 11);

    ctx.textAlign = 'left'; ctx.font = '11px ' + FONT;
    ctx.fillStyle = row.reached ? 'rgba(228,234,238,.86)' : 'rgba(255,255,255,.55)';
    var lines = row.text ? wrap(row.text, w - 20) : [], ly = y + 32;
    for (var k = 0; k < lines.length; k++) { ctx.fillText(lines[k], x + 10, ly); ly += 15; }
  };

  /** 图鉴 · 熟练度：竖列表一行（同上，只是横过来排） */
  Renderer.prototype.drawCodexLevelRow = function (ctx, x, y, w, h, row, wrap) {
    pathRoundRect(ctx, x, y, w, h, 9);
    ctx.fillStyle = row.current ? 'rgba(255,209,102,.12)'
                  : (row.reached ? 'rgba(143,214,165,.07)' : 'rgba(255,255,255,.03)');
    ctx.fill();
    ctx.strokeStyle = row.current ? 'rgba(255,209,102,.6)'
                    : (row.reached ? 'rgba(143,214,165,.42)' : 'rgba(255,255,255,.12)');
    ctx.lineWidth = 1.4; ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.font = '700 13.5px ' + FONT;
    ctx.fillStyle = row.current ? '#ffd166' : (row.reached ? '#9fd9c9' : 'rgba(255,255,255,.5)');
    ctx.fillText(row.label, x + 10, y + 16);
    var lw = ctx.measureText(row.label).width;
    ctx.font = '10.5px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText(row.needText, x + 10 + lw + 8, y + 17);

    ctx.textAlign = 'left'; ctx.font = '11.5px ' + FONT;
    ctx.fillStyle = row.reached ? 'rgba(228,234,238,.86)' : 'rgba(255,255,255,.55)';
    var lines = row.text ? wrap(row.text, w - 20) : [], ly = y + 34;
    for (var k = 0; k < lines.length; k++) { ctx.fillText(lines[k], x + 10, ly); ly += 15; }
  };

  Renderer.prototype.drawWeaponSkills = function (game) {
    var ctx = this.ctx, fields = game.skillFields || [], visuals = game.skillVisuals || [];
    ctx.save();
    for (var i = 0; i < fields.length; i++) {
      var z = fields[i]; if (!this.inView(z, z.r)) continue;
      ctx.globalAlpha = Math.min(0.75, z.life); ctx.strokeStyle = '#ffe3a1'; ctx.fillStyle = 'rgba(255,210,100,.10)';
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      for (var k = 0; k < 6; k++) {
        var a = k * Math.PI / 3, x = z.x + Math.cos(a) * 42, y = z.y + Math.sin(a) * 42;
        ctx.beginPath(); ctx.moveTo(x, y + 17); ctx.lineTo(x, y - 17);
        ctx.moveTo(x - 6, y - 9); ctx.lineTo(x, y - 19); ctx.lineTo(x + 6, y - 9); ctx.stroke();
      }
    }
    for (i = 0; i < visuals.length; i++) {
      var v = visuals[i], alpha = 1 - v.t / v.life;
      ctx.globalAlpha = alpha; ctx.strokeStyle = v.color; ctx.fillStyle = v.color;
      if (v.kind === 'line' || v.kind === 'lightning') {
        ctx.lineWidth = v.kind === 'line' ? v.width * 0.65 : 3;
        ctx.beginPath(); ctx.moveTo(v.x, v.y);
        if (v.kind === 'lightning') {
          var dx = v.x2 - v.x, dy = v.y2 - v.y, len = Math.hypot(dx, dy) || 1;
          for (k = 1; k < 6; k++) {
            var off = k % 2 ? 9 : -9;
            ctx.lineTo(v.x + dx * k / 6 - dy / len * off, v.y + dy * k / 6 + dx / len * off);
          }
        }
        ctx.lineTo(v.x2, v.y2); ctx.stroke();
        if (v.kind === 'line') {
          ctx.lineWidth = 3; ctx.strokeStyle = '#fff9dc'; ctx.beginPath();
          ctx.moveTo(v.x, v.y); ctx.lineTo(v.x2, v.y2); ctx.stroke();
        }
      } else if (v.kind === 'cone') {
        ctx.globalAlpha = alpha * 0.25; ctx.beginPath(); ctx.moveTo(v.x, v.y);
        ctx.arc(v.x, v.y, v.radius, v.angle - 1.05, v.angle + 1.05); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = alpha; ctx.lineWidth = 9; ctx.beginPath();
        ctx.arc(v.x, v.y, v.radius * (0.65 + 0.35 * v.t / v.life), v.angle - 1.05, v.angle + 1.05); ctx.stroke();
      } else if (v.kind === 'ring') {
        ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(v.x, v.y, v.radius * (0.4 + 0.6 * v.t / v.life), 0, Math.PI * 2); ctx.stroke();
      }
    }
    /* ---- 剑阵回响（长剑技能，熟练度 Lv2 解锁）：地上的虚剑 + 预警三角 + 齐斩 ----
       视觉口径（2026-10 第 2 版，用户在"V1 克制版 / V2 更响版"两张对照图里选了 **V2**）：
         · 技能是**事件**，可以比脚下的常驻指示器（充能环）响 —— 但响 ≠ 抽象：
           下面全是**具象**的东西（真剑形、地面阵纹、锥形刀光、火花、扬尘），
           没有光带、没有实心大块、没有纯白硬核铺满屏。
         · 第 1 版是"一根细线段 + 一个细三角框 + 三道直线"，读起来像地上有个记号、
           不像"我插了一把剑、布了一个阵" —— 用户真机反馈"看上去不是很有视觉感、不是很帅"。
           这次改的就是这个。
       ⚠️ 尺寸全走 config.swordEcho（**世界像素**，跟角色/怪同一套缩放，别在这里写死数字）；
          **渲染层不自己算任何状态**：落地进度读 sword.t、斩击命中点读 strike.hits，
          都是核心层给好的 —— 老坑"渲染层自己重算 → 效果有、画面没有"见 drawOrbit 那段注释。
       场上最多 3 把剑 + 1 个三角（用户口径"不无限留剑"），零性能负担。 */
    var eSwords = game.skillEchoSwords || [], eStrike = game.skillEchoStrike;
    if (eSwords.length || eStrike) {
      var EC = (this.cfg && this.cfg.swordEcho) || {};
      var eColor = EC.color || '#cfe9ff';
      var eSH = EC.swordH || 43, eSW = EC.swordW || 2.8;

      /* 一把插在地上的虚剑：剑身（尖头）+ 中脊高光 + 护手 + 剑柄 + 地面微光 + 竖直虚影。
         这一块是本次改动的核心 —— 要**一眼认出是剑**，而不是"一根竖线"。
         glow=true 用在"阵成了"的时候（预警中）：剑亮起来，告诉玩家它要动了。
         注：原型给 glow 用的是 shadowBlur，这里改成显式描一层更粗的淡光晕（同样观感，
         但不用阴影、不吃性能、不挑平台）。 */
      var drawSpiritSword = function (sx, sy, alpha, glow) {
        var tipY = sy - eSH, guardY = sy - eSH * 0.29;
        ctx.globalAlpha = alpha * 0.20;                        // 地面微光（扁椭圆，俯视角）
        ctx.fillStyle = eColor;
        ctx.beginPath(); ctx.ellipse(sx, sy + eSH * 0.023, eSH * 0.39, eSH * 0.15, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = alpha * 0.10;                        // 竖直虚影：它是"虚"剑
        ctx.fillRect(sx - eSW * 1.3, tipY, eSW * 2.6, eSH);
        if (glow) {
          ctx.globalAlpha = alpha * 0.28; ctx.strokeStyle = eColor; ctx.lineWidth = eSW * 3.6;
          ctx.beginPath(); ctx.moveTo(sx, tipY + eSH * 0.2); ctx.lineTo(sx, guardY); ctx.stroke();
        }
        ctx.beginPath();                                       // 剑身
        ctx.moveTo(sx, tipY);
        ctx.lineTo(sx + eSW, tipY + eSH * 0.19);
        ctx.lineTo(sx + eSW, guardY);
        ctx.lineTo(sx - eSW, guardY);
        ctx.lineTo(sx - eSW, tipY + eSH * 0.19);
        ctx.closePath();
        ctx.globalAlpha = alpha * 0.95; ctx.fillStyle = 'rgba(207,233,255,.55)'; ctx.fill();
        ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = Math.max(1, eSH * 0.048); ctx.stroke();
        ctx.globalAlpha = alpha * 0.85;                        // 中脊高光
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, eSH * 0.029);
        ctx.beginPath(); ctx.moveTo(sx, tipY + eSH * 0.02); ctx.lineTo(sx, guardY); ctx.stroke();
        ctx.globalAlpha = alpha * 0.95;                        // 护手
        ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = Math.max(1.2, eSH * 0.074);
        ctx.beginPath(); ctx.moveTo(sx - eSH * 0.21, guardY); ctx.lineTo(sx + eSH * 0.21, guardY); ctx.stroke();
        ctx.lineWidth = Math.max(1.2, eSH * 0.09);             // 剑柄
        ctx.beginPath(); ctx.moveTo(sx, guardY); ctx.lineTo(sx, sy - eSH * 0.023); ctx.stroke();
      };

      /* 一根从地里炸出来的剑刺：先画"被顶开的坑"，再画一截**刃**（尖头 + 一个"肩" + 中脊高光，
         没有护手没有柄 —— 和立在地上那三把区分开：立着的是"阵"，冒出来的是"贯穿"）。
         ⚠️ 进度 p / lead 都是**核心层**给的（位置在 echoBuildSpikes 排好、updateSwordEcho 每帧推进），
            渲染层只读 —— 不许自己按帧算（老坑见 drawOrbit 那段注释）。 */
      var drawSpike = function (sp) {
        var sx = sp.x, sy = sp.y;
        var hSP = EC.spikeH || 34, wSP = EC.spikeW || 3.2;
        if (sp.p <= 0) {
          if ((sp.lead || 0) > -0.18) {                 // 波快到了：土先鼓一下（有预兆，不然太突然）
            ctx.globalAlpha = 0.30 * (1 + (sp.lead || 0) / 0.18);
            ctx.fillStyle = EC.holeDark || '#7d6738';
            ctx.beginPath(); ctx.ellipse(sx, sy + 1, 9, 3.2, 0, 0, Math.PI * 2); ctx.fill();
          }
          return;
        }
        var e2 = Math.pow(sp.p, 0.85), h = hSP * e2, rx = 5.5 + 8 * (1 - e2);
        ctx.globalAlpha = 0.38 + 0.20 * (1 - e2);       // 被顶开的坑
        ctx.fillStyle = EC.holeDark || '#7d6738';
        ctx.beginPath(); ctx.ellipse(sx, sy + 1, rx, rx * 0.36, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.55 + 0.28 * (1 - e2);       // 坑沿翻起来的亮土
        ctx.strokeStyle = EC.holeRim || '#e6d7a4'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(sx, sy + 1, rx, rx * 0.36, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.50 + 0.30 * (1 - e2);       // 翻出来的土块
        ctx.fillStyle = EC.clodColor || '#c2a86e';
        for (var d = 0; d < 3; d++) {
          var da = Math.PI * (0.25 + d * 0.32), dd = rx * 0.85;
          ctx.beginPath(); ctx.arc(sx + Math.cos(da) * dd, sy + 1 - Math.sin(da) * dd * 0.36,
            1.5 + 0.8 * (1 - e2), 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 0.70;                        // 刃
        ctx.beginPath();
        ctx.moveTo(sx, sy - h);
        ctx.lineTo(sx + wSP, sy - h * 0.30);
        ctx.lineTo(sx + wSP, sy);
        ctx.lineTo(sx - wSP, sy);
        ctx.lineTo(sx - wSP, sy - h * 0.30);
        ctx.closePath();
        ctx.fillStyle = 'rgba(214,238,255,.72)'; ctx.fill();
        ctx.globalAlpha = 0.95; ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.globalAlpha = 0.90; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(sx, sy - h + 1.5); ctx.lineTo(sx, sy - 2); ctx.stroke();
        if (sp.p < 0.7) {                              // 刚破土：几粒土往外飞
          ctx.globalAlpha = 0.45 * (1 - sp.p / 0.7);
          ctx.fillStyle = EC.dustColor || '#e8f3d8';
          for (var q = 0; q < 4; q++) {
            var qa = Math.PI * (0.15 + q * 0.22), qd = 8 + 16 * (sp.p / 0.7);
            ctx.beginPath(); ctx.arc(sx + Math.cos(qa) * qd, sy + 1 - Math.sin(qa) * qd * 0.5,
              1.6, 0, Math.PI * 2); ctx.fill();
          }
        }
      };

      var si, sw;
      for (si = 0; si < eSwords.length; si++) {
        sw = eSwords[si];
        drawSpiritSword(sw.x, sw.y, 1, false);
        /* 落地那一下：一圈很快散开的涟漪 + 几粒扬尘 —— "插下去了"要有手感。
           进度只读 sw.t（核心层计时），渲染层不自己累计时间。 */
        if (EC.dust !== false && (sw.t || 0) < (EC.landT || 0.3)) {
          var lf = Math.max(0, 1 - (sw.t || 0) / (EC.landT || 0.3));
          ctx.globalAlpha = lf * 0.42; ctx.strokeStyle = eColor;
          ctx.lineWidth = 1.2 + 1.6 * lf;
          ctx.beginPath();
          ctx.ellipse(sw.x, sw.y + eSH * 0.023, eSH * 0.30 * (0.45 + 1.1 * (1 - lf)),
            eSH * 0.115 * (0.45 + 1.1 * (1 - lf)), 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = lf * 0.30; ctx.fillStyle = EC.dustColor || '#e8f3d8';
          for (var di = 0; di < 6; di++) {
            var da = di / 6 * Math.PI * 2, dr = eSH * 0.335 * (0.35 + (1 - lf) * 0.65);
            ctx.beginPath();
            ctx.arc(sw.x + Math.cos(da) * dr, sw.y + 1 + Math.sin(da) * dr * 0.38,
              Math.max(0.9, eSH * 0.054 * (0.4 + lf * 0.6)), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      var eTri = eStrike ? eStrike.tri : null;
      if (eTri && !eStrike.slashed) {
        /* 预警：阵纹（斜线）+ 边框 + 边框短刺 + 顶点碎刃，一起随剩余时间收紧变亮 ——
           这就是"要来了"的读秒（用户要的"短暂预警"）。 */
        var wf = 1 - Math.max(0, eStrike.warn) / (EC.warn || 0.35);
        ctx.save();                                            // 阵纹只画在三角内部
        ctx.beginPath();
        ctx.moveTo(eTri[0].x, eTri[0].y); ctx.lineTo(eTri[1].x, eTri[1].y); ctx.lineTo(eTri[2].x, eTri[2].y);
        ctx.closePath(); ctx.clip();
        var eMinX = Math.min(eTri[0].x, eTri[1].x, eTri[2].x), eMaxX = Math.max(eTri[0].x, eTri[1].x, eTri[2].x);
        var eMinY = Math.min(eTri[0].y, eTri[1].y, eTri[2].y), eMaxY = Math.max(eTri[0].y, eTri[1].y, eTri[2].y);
        ctx.globalAlpha = (EC.hatchAlpha || 0.13) + 0.08 * wf;
        ctx.strokeStyle = eColor; ctx.lineWidth = 1.2;
        var hstep = EC.hatchStep || 11;                        // 45° 斜线：扫出"这块地是我的阵"
        for (var hd = eMinX - (eMaxY - eMinY); hd < eMaxX; hd += hstep) {
          ctx.beginPath(); ctx.moveTo(hd + (eMaxY - eMinY), eMinY); ctx.lineTo(hd, eMaxY); ctx.stroke();
        }
        ctx.restore();
        ctx.globalAlpha = (EC.edgeAlpha || 0.8) * (0.55 + 0.45 * wf);
        ctx.strokeStyle = eColor; ctx.lineWidth = (EC.edgeW || 3.1) * (0.85 + 0.15 * wf);
        ctx.beginPath();
        ctx.moveTo(eTri[0].x, eTri[0].y); ctx.lineTo(eTri[1].x, eTri[1].y); ctx.lineTo(eTri[2].x, eTri[2].y);
        ctx.closePath(); ctx.stroke();
        if (EC.tick !== false) {                               // 边框短刺：一律朝三角内部
          var tn = EC.tickN || 7, tLen = EC.tickLen || 9;
          ctx.globalAlpha = 0.55; ctx.lineWidth = EC.tickW || 1.8;
          for (var ei = 0; ei < 3; ei++) {
            var ea = eTri[ei], eb = eTri[(ei + 1) % 3];
            for (var tk = 1; tk <= tn; tk++) {
              var tp = tk / (tn + 1);
              var tbx = ea.x + (eb.x - ea.x) * tp, tby = ea.y + (eb.y - ea.y) * tp;
              var tmx = eStrike.cx - tbx, tmy = eStrike.cy - tby, tl = Math.hypot(tmx, tmy) || 1;
              ctx.beginPath(); ctx.moveTo(tbx, tby);
              ctx.lineTo(tbx + tmx / tl * tLen, tby + tmy / tl * tLen); ctx.stroke();
            }
          }
        }
        for (si = 0; si < 3; si++) {
          drawSpiritSword(eTri[si].x, eTri[si].y, 1, true);
          if (EC.shardBurst !== false) {                       // 顶点碎刃："阵成了"
            var sn = EC.shardN || 8, sL = EC.shardLen || 29, sCY = eSH * 0.465;
            ctx.globalAlpha = 0.45 + 0.45 * wf;
            for (var sb = 0; sb < sn; sb++) {
              var sa = sb / sn * Math.PI * 2 + 0.3, s0 = eSH * 0.155, s1 = sL * (0.6 + (sb % 3) * 0.2);
              ctx.strokeStyle = sb % 2 ? '#ffffff' : eColor; ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(eTri[si].x + Math.cos(sa) * s0, eTri[si].y - sCY + Math.sin(sa) * s0);
              ctx.lineTo(eTri[si].x + Math.cos(sa) * s1, eTri[si].y - sCY + Math.sin(sa) * s1);
              ctx.stroke();
            }
          }
        }
      }
      if (eTri && eStrike.slashed) {
        /* 地刺式（2026-10 第 3 版攻击表现，用户在 A/B/D 编排里选了 **A 三边向内收拢**）：
           三角还在（三把剑 + 边框的残影），刺从三条边同时朝中心一根根炸起来，
           把被围住的怪从下往上穿透。 */
        var eSP = eStrike.spikes || [];
        for (si = 0; si < 3; si++) drawSpiritSword(eTri[si].x, eTri[si].y, 0.45, false);
        ctx.globalAlpha = 0.28; ctx.strokeStyle = eColor; ctx.lineWidth = (EC.edgeW || 3.1) * 0.8;
        ctx.beginPath();
        ctx.moveTo(eTri[0].x, eTri[0].y); ctx.lineTo(eTri[1].x, eTri[1].y); ctx.lineTo(eTri[2].x, eTri[2].y);
        ctx.closePath(); ctx.stroke();
        /* 靠下的先画（上层的盖住下层的）—— 读起来才像一片地，不像一排贴纸 */
        var eOrder = eSP.slice().sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
        for (si = 0; si < eOrder.length; si++) drawSpike(eOrder[si]);
        /* 被扎住的怪：脚下一圈 + 放射火花。
           命中点走 eStrike.hits（核心层扎完交给渲染层）—— "火花只落在被围住的怪身上"
           因此是构造上成立的，不靠两处判定碰巧一致。 */
        var eHits = eStrike.hits || [], eN = EC.spikeHit || 9, eRing = EC.spikeRingR || 19;
        for (var hi = 0; hi < eHits.length; hi++) {
          var hx = eHits[hi].x, hy = eHits[hi].y;
          if (EC.spikeRing !== false) {                        // 脚下留一圈
            ctx.globalAlpha = 0.30; ctx.strokeStyle = eColor; ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.ellipse(hx, hy + 6.5, eRing, eRing * 0.38, 0, 0, Math.PI * 2); ctx.stroke();
          }
          for (var hj = 0; hj < eN; hj++) {
            var ha = hj / eN * Math.PI * 2 + 0.4, hd0 = eSH * 0.13;
            var hd1 = eSH * 0.395 + (hj % 3) * eSH * 0.068;
            ctx.globalAlpha = 0.85;
            ctx.strokeStyle = hj % 2 ? '#ffffff' : eColor; ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(hx + Math.cos(ha) * hd0, hy + Math.sin(ha) * hd0);
            ctx.lineTo(hx + Math.cos(ha) * hd1, hy + Math.sin(ha) * hd1);
            ctx.stroke();
          }
        }
      }
    }
    var sh = game.skillShadow;
    if (sh) {
      ctx.globalAlpha = Math.min(0.65, sh.life); ctx.fillStyle = '#8fffea';
      ctx.beginPath(); ctx.arc(sh.x, sh.y - 20, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(sh.x - 8, sh.y - 10, 16, 23);
      ctx.strokeStyle = '#baffff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(sh.x - 12, sh.y + 7); ctx.lineTo(sh.x - 31, sh.y - 22);
      ctx.moveTo(sh.x + 12, sh.y + 7); ctx.lineTo(sh.x + 31, sh.y - 22); ctx.stroke();
    }
    ctx.restore();
  };

  return Renderer;
});
