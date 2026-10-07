/**
 * 微信小游戏适配层：触摸 → InputState
 *
 * **左半屏虚拟摇杆 · 右下冲刺键**（2026-10 起攻击键删掉了）
 * 还有两个手机端特有的点按：死亡后点屏幕重开、升级时点卡片
 *
 * ⚠️ 攻击改成"旋刃环绕、到点自动转"之后，**攻击键没有存在意义**（不用按也会打），
 *    删掉之后右下角空出来 → 冲刺键挪到那里（拇指最顺手的位置），半径也放大到 48。
 *    想加回来（比如以后做"点按开转"）就在 btnDash 旁边加一个 btnAtk 即可，
 *    核心层读的 input 字段里 attackDown 还留着（只是现在没人读）。
 */
'use strict';

var STICK_RADIUS = 62;      // 摇杆最大半径（逻辑像素）
var STICK_DEAD = 0.14;      // 死区：手指微抖不该让角色乱动。手机上嫌"走不动"就把这个调小
var TAP_MS = 400;           // 点选判定：按下到抬起的最长时间
var TAP_MOVE = 24;          // 点选判定：手指最多偏移多少（超过就是在推摇杆/滑屏）
var AUTO_ATTACK = true;     // true = 靠近敌人自动挥剑。手机上没有键盘，false 会很难受

function TouchInput(wxApi, screen, opts) {
  this.wx = wxApi;
  this.screen = screen;
  /* ⚠️ 2026-10：原来这里有个"长按 1.5 秒进试炼场"的手势入口（holdSeconds），**已删**。
     原因是落点不固定（屏幕任意空白处都算）：战斗中手一放上去就误触，而进试炼场会把场上的
     怪/弹幕/掉落全清掉 —— 等于当前这一波白打。用户口径："试炼场从指定位置进去吧"。
     现在入口是首页右上角的「试炼」按钮（`game.titleRects().trial`，只有 debug 开着才存在），
     平台层不再需要任何手势。 */
  this.safeBottom = (screen.safeArea ? screen.height - (screen.safeArea.top + screen.safeArea.height) : 0);

  this.stick = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
  this.dash = false;
  this.dashId = null;
  this.tap = null;
  /* 点选候选（选卡 / 试炼场按钮）：**按下时记、抬起时才确认**。
     ⚠️ 原来 onTouchStart 里是"任何一根手指落下就 self.tap = {...}" —— 于是玩家推摇杆走位时，
     手指一落下就等于点了一次屏幕：升级卡正好弹出来的那一瞬间就会被**误选**
     （真机反馈"在移动的时候，技能卡选择很容易被误选"）。 */
  /* ⚠️ 这个字段的赋值必须在这里（构造函数里逐条写）：真机调试时
     __GAME__.input 能查到它，而平台层不再用它做"点屏幕重开"了（见下面的说明）。 */
  this._restartTapped = false;
  this._tapCand = null;

  var bottom = this.safeBottom + 26;
  this.btnDash = { x: screen.width - 84, y: screen.height - bottom - 70, r: 48 };   // 原来攻击键的位置
  /* ⚠️ 原来这里还有个静音圆点（x=46,y=46,r=24），它的位置正好压在左上角"等级+装备"那张卡上
     （版式重叠：断言看不出来，只有截图能发现）。音效开关现在在暂停面板里（设置项），
     这个圆点连同 muteTapped 一起删掉。 */

  this._bind();
}

TouchInput.prototype.resize = function (screen) {
  // Keep the object captured by touch callbacks; replacing it leaves stale hit regions.
  this.screen.width=screen.width;this.screen.height=screen.height;this.screen.safeArea=screen.safeArea;
  this.safeBottom=screen.safeArea?Math.max(0,screen.height-screen.safeArea.top-screen.safeArea.height):0;
  this.btnDash.x=screen.width-84;this.btnDash.y=screen.height-this.safeBottom-96;
  this.stick.active=false;this.stick.id=null;this.dash=false;this.dashId=null;this.tap=null;this._tapCand=null;this._restartTapped=false;
};

TouchInput.prototype._bind = function () {
  var self = this, S = this.screen;

  function inBtn(p, b) { return Math.hypot(p.clientX - b.x, p.clientY - b.y) <= b.r * 1.25; }

  this.wx.onTouchStart(function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      self._restartTapped = true;                    // 只做记录（真机调试可查），不再驱动"点屏幕重开"

      /* ⚠️ 落在按钮上的手指**不算点选**：右下冲刺键的触摸范围（r×1.25 ≈ 60px）和最右边那张
         升级卡的右下角是重叠的 —— 不然点冲刺会把右边那张卡选走。试炼场的按钮是居中的两排，
         够不到右下角（实测 x ≤ 629 vs 冲刺键 x ≥ 668），所以排除按钮不会误伤它们。
         剩下的手指才记成"点选候选"：能不能算点选还要等抬手时看时长和位移（见 end()）。 */
      if (self.playing !== false && inBtn(t, self.btnDash)) { self.dash = true; self.dashId = t.identifier; continue; }
      self._tapCand = { id: t.identifier, x: t.clientX, y: t.clientY, t: Date.now() };

      if (t.clientX < S.width * 0.5 && !self.stick.active) {
        self.stick.active = true;
        self.stick.id = t.identifier;
        self.stick.ox = t.clientX;
        self.stick.oy = t.clientY;
        self.stick.x = t.clientX;
        self.stick.y = t.clientY;
        self.stick.moved = false;                    // 这根手指有没有推出死区（推过 = 不是点选）
      }
    }
  });

  this.wx.onTouchMove(function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (self.stick.active && t.identifier === self.stick.id) {
        self.stick.x = t.clientX;
        self.stick.y = t.clientY;
        if (Math.hypot(t.clientX - self.stick.ox, t.clientY - self.stick.oy) > STICK_RADIUS * STICK_DEAD) {
          self.stick.moved = true;
        }
      }
    }
  });

  function end(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      /* 点选确认：短按 + 几乎没移动 + **不是在推摇杆** 才算一次点选。
         这样"推着摇杆时手指落下/抬起""按住不放""滑出去了"都不会被当成点选，
         升级卡再也不会被误选；而真正的轻点（选卡、试炼场按钮）照旧生效。 */
      var wasStick = (self.stick.active && t.identifier === self.stick.id);
      if (self._tapCand && t.identifier === self._tapCand.id) {
        var heldTap = Date.now() - self._tapCand.t;
        var movedTap = Math.hypot(t.clientX - self._tapCand.x, t.clientY - self._tapCand.y);
        if (heldTap < TAP_MS && movedTap < TAP_MOVE && !(wasStick && self.stick.moved)) {
          self.tap = { x: self._tapCand.x, y: self._tapCand.y };
        }
        self._tapCand = null;
      }
      if (wasStick) {
        self.stick.active = false; self.stick.id = null;
      }
      if (t.identifier === self.dashId) { self.dash = false; self.dashId = null; }
    }
  }
  this.wx.onTouchEnd(end);
  this.wx.onTouchCancel(end);
};

TouchInput.prototype.read = function (game) {
  this.playing = !game || game.state === 'play';
  var mx = 0, my = 0;
  if (this.stick.active) {
    var dx = (this.stick.x - this.stick.ox) / STICK_RADIUS;
    var dy = (this.stick.y - this.stick.oy) / STICK_RADIUS;
    var l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    if (l > STICK_DEAD) { mx = dx; my = dy; }
  }
  var st = {
    moveX: mx,
    moveY: my,
    attackDown: AUTO_ATTACK,      // 核心层已不读它（攻击是自动的旋刃），留着是为了平台契约稳定
    attackEdge: false,
    dash: this.dash,
    aimAngle: null,        // 手机端不做指向，用移动方向
    tap: this.tap
  };
  this.tap = null;
  return st;
};

/* ⚠️ 平台层**不再**提供 takeRestart / takeMute：
   死亡结算现在是明确的按钮（再来一次 / 回首页 / 晒战绩 / 看视频复活），音效开关在暂停面板里。
   平台层如果还拿"任何一次触摸"去重开，点那些按钮时会顺带把这一局重开掉（实测踩过）。
   核心层通过 input.read(game).tap 统一收点按，见 game.updateDeadPanel / updatePaused。 */
TouchInput.prototype.takeRestart = function () { return false; };
TouchInput.prototype.takeMute = function () { return false; };

/** 摇杆和按钮画在最上层（手机端专属 UI，不进共享渲染器） */
TouchInput.prototype.draw = function (ctx, game) {
  var s = this.stick;
  ctx.save();
  // 只有游戏进行中才显示操作 UI，选卡/结束时藏起来，免得挡住
  var showPlay = game && game.state === 'play';

  if (showPlay && s.active) {
    ctx.globalAlpha = 0.26;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(s.ox, s.oy, STICK_RADIUS, 0, 7); ctx.fill();
    var dx = s.x - s.ox, dy = s.y - s.oy, l = Math.hypot(dx, dy);
    if (l > STICK_RADIUS) { dx = dx / l * STICK_RADIUS; dy = dy / l * STICK_RADIUS; }
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.arc(s.ox + dx, s.oy + dy, 27, 0, 7); ctx.fill();
  }

  if (showPlay) {
    /* 按钮可见性：以前冲刺键是"浅绿 30% 透明"压在深绿草地上，等于隐形
       （玩家反馈"冲刺键没了"，其实一直在画）。现在统一改成"实心 + 深色描边"，
       并且按状态区分：可用时亮、冷却中压暗 + 画一圈冷却环。 */
    var dashReady = !game || !game.player || game.player.dashcd <= 0;

    ctx.globalAlpha = 0.92;
    ctx.fillStyle = dashReady ? '#7ee0ff' : '#4b7c8e';
    ctx.beginPath(); ctx.arc(this.btnDash.x, this.btnDash.y, this.btnDash.r, 0, 7); ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(18,26,30,.55)';
    ctx.beginPath(); ctx.arc(this.btnDash.x, this.btnDash.y, this.btnDash.r, 0, 7); ctx.stroke();

    // 冲刺冷却环：冷却中从缺口慢慢补满，玩家一眼知道还能不能冲
    if (!dashReady && game.player.stats.dashCooldown > 0) {
      var dp = 1 - game.player.dashcd / game.player.stats.dashCooldown;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(this.btnDash.x, this.btnDash.y, this.btnDash.r - 5, -1.5708, -1.5708 + 6.283 * Math.max(0, Math.min(1, dp)));
      ctx.stroke();
    }

    ctx.globalAlpha = 0.95;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#16202a';
    ctx.font = '600 16px sans-serif';
    ctx.fillText('冲刺', this.btnDash.x, this.btnDash.y);
  }

  ctx.restore();
};

module.exports = TouchInput;
