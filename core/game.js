/**
 * 核心层：游戏主逻辑（两端共用，永远不知道自己是网页还是小游戏）
 *
 * 对外接口：
 *   game.update(dt, input)        推进一帧（input 见 platform/CONTRACT.md）
 *   game.setViewport(w, h)        告诉它画面多大（CSS 像素）
 *   game.reset()                  重开
 *   game.drainEvents()            取走这一帧的事件（音效/屏震由平台层消费）
 *
 * 状态机 game.state：'play' | 'levelup'（升级卡暂停中）| 'dead'
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.__GAME__ = root.__GAME__ || {}).Game = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof window !== 'undefined' ? window : globalThis), function () {
  'use strict';

  /**
   * deps 由平台适配层注入：{ World, Entities, Progression, Save, storage?, ads?, share? }
   * 核心层不自己去全局找依赖 —— 这样 core/ 里就不会出现任何平台 API。
   * ads / share 是可选的：不注入就等于"这个平台没有广告/分享"，
   * 相关按钮**整个不出现**（而不是画一个点了没反应的按钮）。
   */
  function Game(cfg, deps) {
    if (!deps || !deps.World || !deps.Entities || !deps.Progression || !deps.Save) {
      throw new Error('Game 需要 deps: { World, Entities, Progression, Save }，由平台适配层注入');
    }
    this.cfg = cfg;
    this.World = deps.World;
    this.Entities = deps.Entities;
    this.Prog = deps.Progression;
    this.Save = deps.Save;
    // storage 可选：不注入就整个存档功能静默关闭（冒烟测试里有时不需要）
    this.storage = deps.storage || null;
    // 广告 / 分享：可选适配器（见 platform/CONTRACT.md）
    this.ads = deps.ads || null;
    this.share = deps.share || null;
    this.analytics = deps.analytics || null;
    this.viewport = { w: 0, h: 0 };
    this.cam = { x: 0, y: 0 };
    this.reset();
  }

  Game.prototype.reset = function () {
    this.analyticsRun = null;
    var cfg = this.cfg;
    var spawn = cfg.trial.enabled ? {x:cfg.map.w*.5,y:cfg.map.h*.5} : { x: Math.round(cfg.map.w * 0.133), y: Math.round(cfg.map.h * 0.8125) };

    this.world = this.World.createWorld(cfg, spawn, 1);
    this.player = this.Entities.makePlayer(cfg, spawn.x, spawn.y);
    this.Prog.recompute(this.player, cfg);
    this.player.xpNext = this.Prog.xpForNext(1, cfg);

    // 读档：把上一局攒下的等级/装备/金币接回来（保留多少由 config.save.keepOnDeath 决定）
    this.bestWave = 1;
    this.bestKills = 0;
    this.runs = 0;
    this.autosaveT = 0;
    /* 出卡的"同类连续限流"状态（上一排有没有出现机制卡）：每局从头算，别把上一局的带到这一局 */
    this.lastRowMechanic = false;
    /* 熟练度"这一局已经领过的"标记（防重领）：每局清空；「继续上次」会被 applyRun 盖回来。
       结构：{ elite: { 波次: true }, clear: true } */
    this.masteryClaimed = {};
    /* ⚠️ 设置要在 applyMeta 之前先给默认值：applyMeta 会把存档里的音效/震动/音乐开关盖回来，
       没有默认值的话"干净开局/没存档"时 this.settings 就是空的（渲染/音效层读它会崩）。 */
    this.settings = {
      sound: this.cfg.settings.sound,
      vibrate: this.cfg.settings.vibrate,
      music: this.cfg.settings.music
    };
    var meta = this.loadMeta();
    if (meta) {
      this.Save.applyMeta(this, meta, cfg.save.keepOnDeath);
      this.runs = (meta.runs || 0);
      this.bestWave = (meta.best && meta.best.wave) || 1;
      this.bestKills = (meta.best && meta.best.kills) || 0;
    }

    /* 武器库至少要有一件：开局就是默认那把（用户口径"就算一个武器也要显示"）。
       有存档的话上面 applyMeta 已经把 bag 接回来了（含老存档只有 equip.weapon 的情况），
       这里只兜"干净开局 / 存档里没有武器"那一种。 */
    if (!this.player.bag || !this.player.bag.length) {
      this.player.bag = [this.player.equip.weapon || this.makeStartWeapon()];
    }
    if (!this.player.equip.weapon) this.player.equip.weapon = this.player.bag[0];

    /* **开新局就是默认那把武器**（2026-10 用户口径：「开局只能有默认的长剑使用，
       其他变成不可选」）：
         · 库里永远留着它（上一局捡到的武器不会把它顶掉）
         · 装备的也换成它 —— 上一局死的时候手上拿着大剑，重开也是从长剑开始；
           捡到的那把留在武器库里，局内随时能切（"拿着它打下去"是局内的事，不是开局的事）
       ⚠️ 「继续上次」不走这里的效果：reset() 之后 applyRun 会用存档里那把盖回来 ✓ */
    var startKind = this.startWeaponInfo().kind;
    if (cfg.weapons[startKind]) {
      if (!this.player.bag.some(function (it) { return it && it.kind === startKind; })) {
        this.player.bag.unshift(this.makeStartWeapon());
      }
      if (!this.player.equip.weapon || this.player.equip.weapon.kind !== startKind) {
        var found = null;
        for (var bi2 = 0; bi2 < this.player.bag.length; bi2++) {
          if (this.player.bag[bi2] && this.player.bag[bi2].kind === startKind) { found = this.player.bag[bi2]; break; }
        }
        this.player.equip.weapon = found || this.player.bag[0];
      }
      this.Prog.recompute(this.player, cfg);
    }

    this.player.hp = this.player.stats.maxhp;

    this.parts = new this.Entities.Particles();
    this.foes = [];
    this.projectiles = [];
    this.pickups = [];
    this.hazards = [];        // 地面威胁（预警圈 → 落地伤害，不给经验）
    this.hazardT = cfg.hazards.startAt;
    this.events = [];

    this.wave = 1;
    this.stage = 1;             // 第几关（区域）
    this.stageKills = 0;        // 本关击杀（决定关内波次）
    this.stageT = 0;            // 本关用时（过场结算用）
    this.stageHits = 0;         // 本关受伤次数（过场结算用）
    this.clearT = 0;            // 击杀 Boss 后的过关延迟（到点自动收掉落 → 过场 → 下一关）
    this.introT = 0;            // 过场剩余时间
    this.bossCount = 0;         // 本局已经出过几只 Boss（第 2 只起双 Boss 同场）
    this.stageSummary = null;   // 上一关的成绩（过场显示）
    this.swarmAt = cfg.swarm.everyKills;    // 下一次敌群的击杀阈值
    this.swarmWarn = null;
    this.harvestWarn = 0; this.harvestAnnounced = false;
    this.harvestSpawnT = 0; this.harvestPrep = 0; this.harvestActive = 0;                  // 预警中：{t, total, pts}
    this.swarmCount = 0;                    // 本局来过几次（调试/跑分用）
    this.spawnT = 0.6;
    this.seenTypes = {};        // 已经登场过的敌人种类（保证新品种第一次必定刷出来）
    this.stageTypeCount = {};   // 本关各类怪已出多少只（maxPerStage 限量用，见 pickType）
    this.stageGained = [];      // 本关拿到的装备（通关面板列出来）
    this.weaponGifted = {};     // 本局已经给过的武器（跨关累计：保证一轮给全那四把）
    this.bagGuard = 0;          // 武器库面板的点选护栏（见 openBag/closeBag）
    this.elapsed = 0;
    this.rankEligible=false;this.rankSeconds=0;this.rankResult=null;
    this.hitstop = 0;
    this.quakePulse = null; this.flameCd = 0;
    this.lowHpAlarm = false; this.lowHpTimer = 0;    // 低血警报（见 updateLowHp）
    this.skillNotice = null;                         // 技能获得提示（换局要清）
    this.skillCooldowns = {}; this.skillHitCounts = {};
    this.skillVisuals = []; this.skillFields = []; this.skillShadow = null; this.skillDash = null;
    this.skillEchoSwords = []; this.skillEchoStrike = null;   // 剑阵回响：换场景必须清场
    this.skillActiveKind = null; this.skillQuakePending = false;
    this.state = 'play';
    /* ---------- 启动流程 / 暂停 / 设置 / 广告（2026-10 补） ----------
       ⚠️ reset() 保持"一局全新的 run、且立刻可玩"（state='play'）。
       首页（state='title'）是**平台启动时显式切过去**的（见 toTitle）：
       测试和 tools 都是 new Game() 之后直接开打，把它塞进 reset() 会让所有既有断言失效。 */
    this.pendingResume = null;    // 存档里"没打完的那一局"（首页据此显示「继续上次」）
    this.resumeData = null;       // 那份存档的完整内容（点「继续上次」时用）
    this.settingsOpen = false;    // 首页上的设置面板开着吗
    this.loadoutOpen = false;     // 首页上的「开局武器」面板开着吗（2026-10：开局那把锁死，这里只是交代）
    this.infoOpen = null; this.infoPage = 0;
    /* 武器图鉴（2026-10）：首页的只读武器详情页（技能 + 熟练度两块）。
       为什么必须是**首页**页：局内那条路（暂停 →「换武器」→ 武器库 →「技能」页）只在
       手里 ≥2 把武器时才出现（见 pauseRects 那行 `bag.length >= 2`），而开局只有一把长剑、
       双刀要长剑熟练度 Lv4 才掉 ⇒ 绝大多数时候根本进不去，「技能」页等于没有。
       见 codexRects / renderer.drawCodex。 */
    this.codexOpen = false;
    this.codexKind = null;        // 图鉴当前看哪把武器（打开时默认开局那把）
    this.codexStyle = 'A';        // 版式：'A' 上下两块 / 'B' 左右两块（出图对照用，定版后删掉另一支）
    this.pausedFrom = null;       // 从哪个状态暂停的（点「继续」时回到那里）
    this.pauseGuard = 0;          // 暂停面板护栏：防"点暂停键那一下顺手点到继续"
    this.revives = 0;             // 本局看广告复活了几次
    this.doubled = false;         // 本局"金币翻倍"用掉了吗
    this.adPending = null;        // 正在播的那条激励视频（'revive' | 'double'）
    this.training = false;      // 试炼场模式（无敌 + 练习靶 + 切武器按钮）
    this.trainingStash = null;  // 进试炼场时暂存的"真实武器"（退出时还回去，见 setTraining）
    this.skillViewKind = null;
    this.skillNotice = null;     // "获得 · XX"（精英掉落的技能捡起来时那一行，见 grantSkill）
    /* 武器库面板的页签：'weapon'（手里这几把）| 'skills'（这把武器的全部技能）
       | 'mastery'（**熟练度奖励：Lv1~LvN 每级给什么**，2026-10 从技能页下半块搬出来独立成页）
       | 'stats'（本局拿过的卡） */
    /* 试炼场·试卡面板（点名试用某张升级卡，见 openTrialCards）：
       页签分类 / 是否试金色版 / 点选护栏（和 bagGuard 同一个道理） */
    this.trialCardCat = 'stat';
    this.trialCardGold = false;
    this.trialCardLast = '';    // 面板右上角那行「刚用上：XXX」（点完的即时回执）
    this.cardPanelGuard = 0;
    this.dummies = [];
    this.trainingBossIdx = 0;   // 0 = 没召唤 Boss
    this.cards = [];            // 升级卡（3 选 1）
    /* ⚠️ Boss/关卡状态必须在这里清干净（真机 bug：死了重开"一个怪都没了"）：
       这三个字段原来只在 enterStage() 里重置，reset() 漏了 —— 而 reset() 里写的是
       `bossSpawnedForWave`（早就改名的旧字段，等于什么都没清）。后果：
         · stageBossPending 留成 true → updateSpawns 直接 return → **一只怪都不刷**
         · bossAlive 留着 → 同上（而且 Boss 其实已经不在场上了）
         · bossSpawnedForStage 留着 → 关底 Boss 永远不再出 → 这局永远过不了
       凡是"只在 enterStage 里清"的状态，都要问一句"死亡重开时清了吗"。 */
    this.bossSpawnedForStage = 0;      // 注意字段名是 ForStage（旧的 ForWave 已废弃）
    this.bossAlive = 0;
    this.stageBossPending = false;
    this.initTrial();
    this.updateCamera();
  };

  /**
   * @param insets 可选：手机安全区（刘海/底部横条）。核心层也要知道，
   *   因为**武器库按钮的矩形是核心层算的**（渲染层和点击判定共用同一份，老规矩），
   *   按钮贴着左下角，不避开安全区就会被刘海/横条压住。
   */
  Game.prototype.setViewport = function (w, h, insets) {
    this.viewport.w = w; this.viewport.h = h;
    if (insets) this.viewport.insets = insets;
    this.updateCamera();
  };

  /** 点在矩形里吗（UI 命中判定统一走它） */
  Game.prototype.inRect = function (r, p) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  };

  Game.prototype.emit = function (type, data) {
    var e = data || {};
    e.type = type;
    this.events.push(e);
    return e;
  };

  /** 平台层每帧取走事件（音效、屏震、震动反馈都靠这个） */
  Game.prototype.drainEvents = function () {
    var e = this.events;
    this.events = [];
    return e;
  };

  /* ==================== 存档 ====================
     核心层只负责"游戏状态 ⇄ 纯对象"，真正的存储介质由平台层注入（localStorage / wx.setStorageSync）。
     所以这里永远不出现平台 API，两端行为也一致。 */

  Game.prototype.loadMeta = function () {
    if (!this.storage || !this.cfg.save.enabled) return null;
    var raw = null;
    try { raw = this.storage.get(this.cfg.save.key); } catch (e) { return null; }
    if (!raw) return null;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    // 版本对不上直接丢：改了字段名还用旧档解析，会崩得莫名其妙
    if (!this.Save.isCompatible(data)) return null;
    return data;
  };

  /** 哪些状态算"这一局还在进行中"（只有这些状态才把「当前这一局」写进存档） */
  var RUN_STATES = { play: 1, levelup: 1, bag: 1, clear: 1, intro: 1, paused: 1 };

  /** 死亡结算页文字块的高度（"你倒下了" + 战绩 + 装备 + 分隔线）。渲染层按它排版 */
  var DEAD_TEXT_H = 132;

  Game.prototype.saveNow = function () {
    if(this.ranked)return true; // Ranked runs never replace normal progression/resume data.
    if (!this.storage || !this.cfg.save.enabled) return false;
    /* 试炼场**一律不存档**（用户 2026-10 口径）：试炼场是沙盒，
       里面换过武器/刷过掉落都不该写进真实存档（以前就是这里把假的试炼场武器存进去的）。 */
    if (this.training) return false;
    try {
      /* ⚠️ 首页（state='title'）上只改"设置"那一小块：
         首页的 player 是按 keepOnDeath 重建过的（'loot' ⇒ 等级回到 1），把整份写回去
         会把**没打完的那一局**连同等级一起冲掉（实测抓到：在首页关个音效就把进度清了）。 */
      if (this.state === 'title') {
        var cur = this.loadMeta();
        if (cur) {
          cur.settings = { sound: this.settings.sound, vibrate: this.settings.vibrate, music: this.settings.music };
          this.storage.set(this.cfg.save.key, JSON.stringify(cur));
          return true;
        }
        /* 没有旧档（第一次玩）→ 直接往下走，存一份新的 */
      }
      /* ⚠️ 只有"这一局还在进行中"才带上 run 块：
         · state='dead'  → 不写 ⇒ 首页只有「开始游戏」；死了就是死了，不给"继续上次"
         · state='title' → 不写 ⇒ 回首页那一下不会用一局空档覆盖掉真正的存档 */
      var inRun = !!RUN_STATES[this.state] && !(this.trial && this.trial.finished && this.state === 'clear');
      this.storage.set(this.cfg.save.key, JSON.stringify(this.Save.snapshot(this, inRun)));
      return true;
    } catch (e) {
      return false;    // 存储满了/被禁用，不该影响游戏继续跑
    }
  };

  Game.prototype.clearSave = function () {
    if (!this.storage) return false;
    try { this.storage.remove(this.cfg.save.key); return true; } catch (e) { return false; }
  };

  /* ==================== 主循环 ==================== */

  Game.prototype.update = function (dt, input) {
    var cfg = this.cfg;

    /* 武器库的点选护栏要**在状态分支之前**递减：
       ⚠️ 只放在 state==='bag' 里递减的话，关闭那一下把它置成 0.12 之后，
       状态已经回到 'play'，就再也没人递减它了 → 护栏永远不放行、武器库再也打不开
       （这个 bug 是 smoke 里"关掉之后再点一次按钮"那条用例抓到的）。 */
    if (this.bagGuard > 0) this.bagGuard = Math.max(0, this.bagGuard - dt);
    if (this.cardPanelGuard > 0) this.cardPanelGuard = Math.max(0, this.cardPanelGuard - dt);
    if (this.pauseGuard > 0) this.pauseGuard = Math.max(0, this.pauseGuard - dt);

    // 界面状态要先处理：它们本来就是暂停的，而且玩家的点按是"一帧一次"的事件，
    // 不能在顿帧里被吞掉 —— 否则"刚砍死怪就升级"时点卡片会没反应（实测抓到的 bug）
    if (this.state === 'title') {                 // 首页（平台启动时切进来，见 toTitle）
      this.updateTitle(input);
      this.parts.update(dt);
      return;
    }
    if (this.state === 'paused') {                // 暂停面板（继续 / 重新开始 / 回首页 / 开关）
      this.updatePaused(input);
      this.parts.update(dt);
      return;
    }
    if (this.state === 'clear') {                 // 通关成功面板（见 nextStage）
      this.updateClearPanel(dt, input);           // 护栏递减在它里面，别重复减
      this.parts.update(dt);
      return;
    }
    if (this.state === 'levelup') {
      /* 卡片刚弹出来的 0.12 秒内**不接受点选**（第二道护栏）：
         输入的"点选判定"已经挡住推摇杆（见 platform/wechat/input.js），
         但"正好在卡片弹出那一帧抬手/连点"仍可能误选 —— 这 0.2 秒把它也挡掉，
         代价只是"想选卡的人晚 0.12 秒"（感觉不出来）。 */
      if (this.cardGuard > 0) this.cardGuard = Math.max(0, this.cardGuard - dt);
      this.updateLevelUp(input);
      return;
    }
    if (this.state === 'bag') {                   // 武器库（换武器时暂停，见 switchWeapon）
      this.updateBag(input);                      // 护栏在上面统一递减
      this.parts.update(dt);
      return;
    }
    if (this.state === 'trialcards') {            // 试炼场·试卡（点名试用某张升级卡）
      this.updateTrialCards(input);               // 护栏在上面统一递减
      this.parts.update(dt);
      return;
    }
    if (this.state === 'dead') { this.updateDeadPanel(input); this.parts.update(dt); return; }
    // 过关过场：停一下显示"第 N 关 · 关卡名"和上一关成绩，期间不刷怪、玩家无敌
    if (this.state === 'intro') {
      this.introT -= dt;
      this.parts.update(dt);
      if (this.introT <= 0) this.state = 'play';
      return;
    }

    // 试炼场的按钮也要在顿帧之前处理 —— 玩家的点按是一帧一次的事件，不能被吞
    if (this.training) this.updateTrainingInput(input);

    /* ⚠️ 2026-10 删掉了左下角的「武器库」入口按钮（用户口径"页面简洁"）：入口改到
       「暂停 → 换武器」（见 pauseRects / updatePaused）。
       这里原来那条 `inRect(bagBtnRect(), tap) → openBag()` 必须一起删 ——
       留下就是一块**看不见的点击热区**（点左下角空白莫名开出面板），技能格那次就是这么翻的车。 */

    /* 狂热（爆发）按钮：和武器库入口一样，必须在顿帧之前 —— 点按是一帧一次的事件，被顿帧吞掉就是"点了没反应"。 */
    if (this.state === 'play' && input.tap && this.inRect(this.frenzyRect(), input.tap)) { this.activateFrenzy(); return; }

    /* 暂停键（右上角）：同样在顿帧之前 —— 顿帧里点它没反应，体感就像卡死了。
       ⚠️ 试炼场里不给暂停键（底部那排按钮已经占满，而且试炼场本来就无敌）。 */
    if (this.pauseAvailable() &&
        this.inRect(this.pauseBtnRect(), input.tap || { x: -1, y: -1 })) {
      if (this.pauseGuard <= 0) { this.pause(); return; }
    }

    // 顿帧：命中瞬间把所有东西冻住几十毫秒，是打击感最便宜也最有效的一招
    if (this.hitstop > 0) {
      // ⚠️ 夹到 0：0.05 - 3×(1/60) 在浮点下是 2.8e-17（>0 成立）→ 会多冻一帧，还会变成负数
      this.hitstop = Math.max(0, this.hitstop - dt);
      return;
    }

    this.elapsed += dt;
    if (!this.training) this.stageT += dt;      // 本关计时（过关结算用）

    // 自动存档：微信小游戏随时可能被切后台甚至杀掉，不存就白玩一局
    this.autosaveT += dt;
    if (this.cfg.save.autosaveSeconds > 0 && this.autosaveT >= this.cfg.save.autosaveSeconds) {
      this.autosaveT = 0;
      this.saveNow();
    }

    var wasFrenzy = this.player.frenzy > 0;
    this.player.frenzy = Math.max(0, (this.player.frenzy || 0) - dt);
    this.frenzyNoticeT = Math.max(0, (this.frenzyNoticeT || 0) - dt);
    if (wasFrenzy && !this.player.frenzy) {
      this.frenzyNotice = '狂热结束 · 击败' + (this.player.kills - this.frenzyStartKills) + '只';
      this.frenzyNoticeT = 1.8; this.emit('frenzyEnd', {});
    }
    this.flameCd = Math.max(0, (this.flameCd || 0) - dt);
    this.updateLowHp(dt);
    /* "获得 · XX"（精英掉落的技能）：只在这里倒计时，渲染层只读。 */
    if (this.skillNotice) { this.skillNotice.t -= dt; if (this.skillNotice.t <= 0) this.skillNotice = null; }
    if (this.quakePulse) {
      this.quakePulse.t -= dt;
      if (this.quakePulse.t <= 0) {
        var pulse = this.quakePulse; this.quakePulse = null;
        this.areaPulse(pulse.x, pulse.y, 140, pulse.damage, 'echo');
      }
    }
    this.updatePlayer(dt, input);
    if (this.training) {
      this.updateSpawnsTraining(dt);
    } else {
      this.updateSpawns(dt);
    }
    this.updateFoes(dt);
    if (!this.training) this.tickWave();
    this.updateProjectiles(dt);
    if (!this.training) this.updateHazards(dt);
    if (!this.training) this.updateClear(dt);
    if (!this.training) { this.checkSwarm(); this.updateSwarm(dt); }
    this.updatePickups(dt);
    this.parts.update(dt);
    this.updateCamera();
  };

  /* ==================== 玩家 ==================== */

  Game.prototype.updatePlayer = function (dt, input) {
    var cfg = this.cfg, P = this.player, S = P.stats;
    this.updateWeaponSkills(dt);
    var mx = input.moveX || 0, my = input.moveY || 0;
    var vx = 0, vy = 0;

    if (mx || my) {
      var l = Math.hypot(mx, my);
      vx = mx / l; vy = my / l;
      P.face = Math.atan2(vy, vx);
      P.bob += dt * 11;
      /* 「这一帧在移动」——给角色美术用的（走路迈腿/摆臂的相位）。
         渲染层只拿得到 P、读不到输入，动作必须挂在**真实状态**上，不能自己攒计时器。
         不是存档字段（每帧都会被重写），但也别在别处读它当逻辑用。 */
      P.moving = true;
    } else {
      P.moving = false;
      P.bob += dt * 2;
    }

    if (P.comboStacks > 0) {
      P.comboTimer -= dt;
      if (P.comboTimer <= 0) P.comboStacks = 0;      // 停手就清空，逼你一直贴着打
    }

    P.dashcd = Math.max(0, P.dashcd - dt);
    if (input.dash && P.dashcd <= 0 && (vx || vy)) {
      P.dash = S.dashTime;
      P.dashcd = S.dashCooldown;
      this.parts.burst(P.x, P.y, 'rgba(255,255,255,.35)', 6);
      this.emit('dash', { x: P.x, y: P.y });
      if (this.hasWeaponSkill('dagger_dash')) this.skillDash = { x: P.x, y: P.y, hits: [] };
      if (P.evolutions && P.evolutions.flame && !this.flameCd) {
        this.flameCd = 0.8;
        this.areaPulse(P.x, P.y, 125, S.attackDamage * 1.6, 'flame');
      }
    }

    /* 「灼痕」卡（升级卡，2026-10）：冲刺路径上留火痕 —— **把位移变成输出**。
       每 gap 秒落一团（冲刺 0.16 秒 → 约 4 团），等级看 dashTrail（1 普通 / 2 金色）。
       火痕只烧怪不烧自己（friendly: true，见 updateHazards）。
       ⚠️ 起手那团必须落在**起步位置**：所以 trailT 在没冲刺时归 0，第一帧就能落。 */
    if (P.dash > 0 && S.dashTrail > 0) {
      P.trailT = (P.trailT || 0) - dt;
      if (P.trailT <= 0) {
        var TL = (cfg.hazards && cfg.hazards.trail) || null;
        if (TL) {
          var lv = Math.min(TL.levels.length, Math.max(1, Math.round(S.dashTrail))) - 1;
          var L = TL.levels[lv];
          P.trailT = TL.gap;
          this.hazards.push({
            kind: 'fire', x: P.x, y: P.y, r: L.r, w: 0,
            t: 0, total: 0.001, fired: true, active: true,
            hold: L.hold, tick: 0, damage: L.damage, friendly: true
          });
        }
      }
    } else if (P.dash <= 0) {
      P.trailT = 0;
    }
    /* 默认收刃与攻击期移速一致；身法卡的收刃加速仍生效，冲刺不叠加。 */
    var retractMul = (!P.orbOn && P.dash <= 0) ? (S.orbitRetractSpd || 1) : 1;
    var spd = P.dash > 0 ? S.spd * S.dashSpeed : Math.min(S.spd * retractMul, cfg.player.base.spd * 1.25);
    /* 中毒（Boss 尾针命中）：只削**走路**速度，冲刺照旧 ——
       这样"被扎到"有明确代价（走不掉、要花一个冲刺脱身），但不会变成"被扎一次就等死"。 */
    if (P.slowT > 0) {
      P.slowT = Math.max(0, P.slowT - dt);
      if (P.slowT <= 0) P.slowMul = 1;
      else if (P.dash <= 0) spd *= (P.slowMul || 1);
    }
    if (P.dash > 0) P.dash -= dt;

    P.x += vx * spd * dt;
    P.y += vy * spd * dt;
    P.vx = vx * spd;          // 存一份玩家速度：地面威胁要按它预判落点
    P.vy = vy * spd;
    this.world.collide(P);
    if (this.skillDash) {
      if (this.hasWeaponSkill('dagger_dash')) {
        this.skillLine(this.skillDash.x, this.skillDash.y, P.x, P.y, 22,
          S.attackDamage * 2, '#8fffea', this.skillDash.hits);
        this.skillDash.x = P.x; this.skillDash.y = P.y;
      }
      if (P.dash <= 0 || !this.hasWeaponSkill('dagger_dash')) this.skillDash = null;
    }

    P.cd = Math.max(0, P.cd - dt);
    P.inv = Math.max(0, P.inv - dt);
    if (P.thornsCd > 0) P.thornsCd = Math.max(0, P.thornsCd - dt);   // 尖甲反伤的冷却
    /* 收刃充能环涨满那一下的闪光计时（渲染层只读，见 config.feel.attackRing） */
    if (P.orbChargeFlash > 0) P.orbChargeFlash = Math.max(0, P.orbChargeFlash - dt);
    /* 攻击 = 旋刃环绕（到点自动转、转完收刃）。整段判定在 updateOrbit 里。
       老代码（按住攻击键 → 朝面朝方向挥一刀 → resolveSwing 扇形判定）已删除：
       换环绕之后 aimAngle/攻击键/扇形都不再参与玩法。 */
    this.updateOrbit(dt);
  };

  /* ==================== 旋刃（环绕攻击，2026-10 换掉"朝目标挥砍"） ====================
     为什么是"有窗口的环绕"而不是"一直环绕"（定方案时的结论，别改回去）：
       · 一直环绕 = 360° + 边跑边打 + 不用任何操作 → 每只怪的 DPS 只能压得很低（否则崩），
         手感温吞，而且等于把之前为治"跑圈无敌"加的地形/疾刺/地面威胁又送回去；
       · 有窗口的环绕 = **转动期间每只怪的 DPS 可以保持甚至高于原来的挥砍**（爆发感），
         平均 DPS 差不多，但"什么时候贴上去"变成了唯一的战术决策。
     现在是**自动循环**：转 orbitSpin 秒 → 收 orbitRest 秒 → 循环。收刃期间移速 ×orbitRetractSpd。
     两条实现上必须有的东西：
       1. **按"这一帧扫过的弧"判定，不是按当前帧角度**：转速快时刀刃会在两帧之间跳过一只怪
          （穿怪）→ 每只怪记自己的冷却 = "两次扫过之间的间隔"（一圈时间 ÷ 刃数），
          刚度由 `orbitOmega`（转速 = 攻速）+ `blades`（刃数）决定 —— 画面更快 = 数值更高。
       2. **径向范围必须和画出来的武器一致**（gripR → radius）：刀柄离身体 30px，
          所以贴到脚底下的怪也得靠"身体和刀刃那段相交"才算 —— 画面和伤害是同一套数。
     */
  Game.prototype.orbitParams = function () {
    var cfg = this.cfg, P = this.player, S = P.stats, W = this.weapon(), o = W.orbit || {};
    /* 攻速/范围类加成（升级卡 + 饰品词条）改的是 attackCooldown / attackRange。
       换攻击方式后按比例折进环绕参数 —— 这样"迅捷/长刃"卡和"+攻速"词条不会变成废纸。 */
    /* 攻速/范围类加成（升级卡 + 饰品词条）改的是 attackCooldown / attackRange ——
       换攻击方式后按比例折进环绕参数：**"攻速"= 转速**（刀扫得快 = 打得勤），
       范围 = 刀刃长度/半径。这样老卡和词条不会变成废纸。 */
    var cdRatio = S.attackCooldown / (cfg.player.base.attackCooldown || 1);
    var rgRatio = S.attackRange / (cfg.player.base.attackRange || 1);
    /* ---- 叠刃（熟练度 Lv3 的机制卡）：本局累积的额外刃数 ----
       走**普通刃数**这条线 —— 下面试炼版那段归一化会自动把它算进 extra（每把刃
       总伤害 +15%，和旋刃卡一个待遇）。⚠️ **不能走 burst 桶**：burst 是"窗口内临时拉满"
       （千刃/开天），混进去会画 12 把刀但伤害跟不上（千刃那次踩过的同一个坑）。
       上限是**总刃数**（含旋刃卡给的），不是"叠刃自己加了几把"：12 这个数是
       用户看着"会不会糊屏"定的（见 config.bladeUnity 那段）。
       代价加在**收刃时长**（不碰转速）：转速一变"一次攻击转一圈"就不成立了。 */
    var U = cfg.bladeUnity || {};
    var unity = Math.max(0, Math.floor(P.bladeUnityStacks || 0));
    var bladesNow = (o.blades || 1) + Math.max(0, Math.round(S.orbitBlades) - 1) + unity;
    if (unity > 0 && U.bladesMax) bladesNow = Math.min(U.bladesMax, bladesNow);
    var unityRestMul = (unity > 0 && U.restPer)
      ? Math.min(U.restMax || Infinity, 1 + U.restPer * unity) : 1;
    var p = {
      /* 刃数：武器自带 + 旋刃卡的叠加，**不封顶**（2026-10 用户："旋刃也不要封顶吧"）。
         DPS 由下面试炼版那段归一化压着（每多一把刃总伤害只 +15%，线性），
         所以堆到 8~12 把是"画面越来越密"而不是"数值爆炸"。
         ⚠️ 真正要盯的是**命中事件密度**：每把刃各扫一次 ⇒ 每只怪挨打次数 ≈ 刃数倍，
            粒子/伤害数字会跟着涨（真机如果觉得糊，应该在渲染层按刃数降特效密度，别回头又加回上限）。 */
      blades: Math.max(1, bladesNow),
      gripR: S.orbitGripR || 30,                 // 刀柄离身体（渲染层读同一个值）
      // 半径（= 刀尖位置 = 攻击距离）：裸装 × range 卡/词条 × 武器自己的 range
      radius: S.orbitRadius * rgRatio * (o.radius !== undefined ? o.radius : W.range),
      omega: S.orbitOmega * (o.omega || 1) / cdRatio,
      // o.dmg：武器自己覆盖每刀倍率（法杖的光球很轻，伤害主要在弹上）
      dmg: S.attackDamage * (S.orbitDmg || 1) * (o.dmg !== undefined ? o.dmg : W.damage),
      arcSwing: o.arcSwing || 0,                 // >0 = 整片扇形挥砍：一次打中扇内所有怪（目前没武器用）
      kb: cfg.combat.knockback * (o.kb !== undefined ? o.kb : W.knockback),
      spin: S.orbitSpin * (o.spin || 1),
      /* 尺寸的代价（2026-10 用户选"要代价"而不是硬上限）：**尺寸每涨 20% → 收刃 +5%**。
         ⚠️ 代价故意加在**收刃时长**而不是转速上：转速一变，"一次攻击转一圈"立刻就不成立了
            （堆到 4.4 倍尺寸时转速要 −22% → 每次只转 0.78 圈，刀转不到一整圈就收，一眼看得出不对）。
            加在收刃上，体感同样是"越粗越慢"（循环变长、空档变久），但圈数永远是 1。
         ⚠️ 用 rgRatio（玩家自己的尺寸成长倍率）推导，不是每张卡各自扣 —— 卡上扣的话，
            装备/饰品词条带来的尺寸就不付代价，规则会漏。指数 0.274 = "1.2 倍尺寸 → 1.05 倍收刃"。 */
      rest: S.orbitRest * (o.rest || 1) * Math.pow(Math.max(1, rgRatio), 0.274) * unityRestMul,
      castCd: o.castCd || 0
    };
    /* 限次爆发（开天）：半径 ×5 只在**当前这个转动窗口**生效（active 由 updateOrbit 在起转/收刃时开合）。
       乘在半径上就等于"武器变长"——渲染层是把武器本体整段拉伸到 [刀柄, 半径]，
       所以画出来的刀和判定用的是同一个数（用户口径"武器多大就打到哪里"），这里不用另外做。 */
    if (P.burst && P.burst.active && P.burst.radiusMul) p.radius *= P.burst.radiusMul;
    /* 限次爆发（千刃）：额外刃数只在当前窗口生效。
       ⚠️ 下面的试炼版归一化**必须按"没爆发的刃数"算** —— 这是"同一个数写两处"的变体：
          判定用的刃数是 `p.blades`（含爆发），归一化用的刃数是 `bladesBeforeBurst`。
          写错这里，千刃就从"×4 DPS"退化成"+45% DPS"，而画面照样画 4 把刀（看不出坏，只觉得哑炮）。 */
    var bladesBeforeBurst = p.blades;
    if (P.burst && P.burst.active && (P.burst.bladesSet || P.burst.bladesAdd)) {
      if (P.burst.bladesSet) {
        /* "直接变成 N 把"（千刃）：取 max，保证不会比玩家原本更少（现在基础上限 4 < 6，等于恒为 6） */
        p.blades = Math.max(p.blades, P.burst.bladesSet);
      } else {
        p.blades = Math.min(P.burst.bladesMax || 4, p.blades + P.burst.bladesAdd);
      }
    }
    // 双刀连击：越打转得越快（转速上去 → 命中频率和 DPS 一起涨）
    var tr = W.trait;
    if (tr && tr.id === 'combo' && P.comboStacks > 0) p.omega *= 1 + tr.spdPerStack * P.comboStacks;
    if (P.frenzy > 0) { p.omega *= 1.3; p.rest *= 0.35; p.castCd *= 0.7; }
    if (cfg.trial.enabled) {
      var baseBlades = o.blades || 1, extra = bladesBeforeBurst - baseBlades;
      p.dmg *= baseBlades * (1 + extra * 0.15) / bladesBeforeBurst;
    }
    /* 限次爆发（血刃）：伤害 ×N。放在归一化**之后** —— desc 写"伤害 ×3"就必须是最终伤害的 ×3，
       放前面会被归一化再除一遍（玩家也算不出来）。 */
    if (P.burst && P.burst.active && P.burst.dmgMul) p.dmg *= P.burst.dmgMul;
    return p;
  };

  Game.prototype.updateOrbit = function (dt) {
    var P = this.player, op = this.orbitParams();

    P.orbT -= dt;
    if (P.orbOn) {
      if (P.orbT <= 0) {                       // 转完了 → 收刃
        P.orbOn = false;
        P.orbT = op.rest;
        P.orbTotal = op.rest;                  // 充能环的分母（见 entities.js 的 orbTotal 说明）
        /* 上一轮"涨满"的闪光到这里收干净：闪光只属于起转后那一小段，
           不收的话（万一某把武器 spin 比 flash 还短）收刃一开始就会画出一圈亮环。 */
        P.orbChargeFlash = 0;
        P.orbAng = P.orbAng0;
        P.orbPrev = P.orbAng0;
        P.orbCastT = 0;
        if (P.burst) P.burst.active = false;   // 爆发也跟着这个窗口结束（还剩几次看 left）
        this.emit('sheathe', { x: P.x, y: P.y });
        /* 剑阵回响：一次普通攻击（这个转动窗口）**刚刚走完** → 在当下的脚下留一把虚幻小剑。
           放这里而不是放起转，是因为"攻击完成"的落点更自然：收刃一开始玩家就要走位了，
           剑正好钉在他刚打完的位置 —— 这就是用户要的"走过的路变成杀招"。 */
        if (this.hasWeaponSkill('sword_echo')) this.echoDropSword(P.x, P.y);
        if (this.hasWeaponSkill('sword_return')) {
          var returning = this.skillShot(P.x, P.y, this.skillAim(), 340, P.stats.attackDamage * 1.4, 'return', '#9beaff');
          if (returning) { returning.life = 2; returning.pierce = 20; }
        }
        return;
      }
    } else if (P.orbT <= 0) {                  // 冷却结束 → 起转
      P.orbOn = true;
      P.orbT = op.spin;
      P.orbTotal = op.spin;                    // 充能环的分母（见 entities.js 的 orbTotal 说明）
      /* 收刃充能环填满 = 就是这一下。给一个"到点了"的闪光（用户口径：涨满要闪），
         渲染层只读它，不自己攒计时器。 */
      P.orbChargeFlash = (this.cfg.feel && this.cfg.feel.attackRing && this.cfg.feel.attackRing.flash) || 0.12;
      P.orbAng0 = P.face;                      // 从面朝方向甩出去，手感上"刀刃是甩起来的"
      P.orbAng = P.face;
      P.orbPrev = P.face;
      P.orbPass = 0;                           // 长枪的"越转越狠"按这一轮转动重新计
      P.orbCastT = 0.15;                       // 法杖：起转后 0.15 秒放第一发
      P.orbSwingT = 0;                         // 起转即挥第一刀
      /* ⚠️ 扇形武器的挥砍计时必须在这里清掉：不清的话上一个转动窗口用剩的
         那点时间会带进来，下一次起转的第一刀被推迟（真机表现为"转起来了却不出手"）。 */

      this.parts.burst(P.x, P.y, '#ffe9a8', 8);
      this.punchHitstop(this.cfg.feel.hitstop.spin);      // 起转给一次顿帧（只有这一下，不连续）
      this.emit('spin', { x: P.x, y: P.y, blades: op.blades });
      /* 叠刃：每起转 +1 把（本局累积）。放在起转分支 = "这一次转起来就多一把"，
         和开天/千刃"下次起转才生效"是同一套口径。上限与代价见 gainBladeUnity。 */
      if (P.stats.bladeUnity) this.gainBladeUnity();
      if (this.hasWeaponSkill('greatsword_charge')) this.skillHeavySlash();
      /* 限次爆发（开天）：**这一次起转才消耗一刀**。
         放在起转分支里（不是抽到卡的那一刻）= 用户口径"下次起转才生效"：
         抽卡时可能正在收刃，等下一次转起来才变巨刀，爽点不会被冷却吃掉。
         飘字是"还剩几刀"唯一的即时反馈（HUD 上还有个常驻徽标）。 */
      if (P.burst && P.burst.left > 0) {
        P.burst.left--;
        P.burst.active = true;
        /* 回血/封顶提示都是**每个转动窗口独立计**（血刃）：不归零的话第二个窗口一滴都吸不到 */
        P.burst.healed = 0;
        P.burst.capNoticed = false;
        this.parts.burst(P.x, P.y, '#ffd166', 24);
        this.parts.text(P.x, P.y - 78, P.burst.name + ' · 剩 ' + P.burst.left + ' 刀', '#ffd166');
        this.emit('levelup', { x: P.x, y: P.y });
      }
      return;
    }
    if (!P.orbOn) return;

    P.orbPrev = P.orbAng;
    P.orbAng += op.omega * dt;

    /* 命中 = **刀刃真实扫过的那一段**（真机要求："只有旋绕的武器经过的敌人才会受到伤害"、
       "武器多大就能打到哪里，画面和伤害得对得上"）。
       所以判定由两件事组成，和画面是同一套数字：
         ① 径向：怪的身体和 [刀柄 gripR → 刀尖 radius] 这段有交集
            （刀柄离身体 30px，所以刀够不到的地方就是不扣血）
         ② 角度：这一帧刀刃扫过的那段弧（上一帧角度 → 这一帧角度）盖住了它
            —— 必须按"扫过的弧"判，只比当前帧角度的话转速快时会**穿怪**
         ③ 每只怪的冷却 = 两次扫过之间的间隔（一圈时间 ÷ 刃数）→ 一次扫过只吃一刀。
            ⚠️ 别再改回"以玩家为圆心的伤害圆"：那是上一版，画面（一把刀浮在旁边）
               和判定（整片圆都掉血）对不上，真机一眼就看出来了。 */
    var W = this.weapon(), tr = W.trait;
    var revTime = (Math.PI * 2) / Math.max(0.01, op.omega);   // 转一圈要多久

    /* ---- 扇形一次挥砍（arcSwing）----
       ⚠️ **目前没有武器用它**：唯一配过 arcSwing 的是战斧，2026-10 那把被整体删掉了
          （原因见 config.items.stageWeapons 那段）。这段留着是因为判定测过、能用，
          以后要再做"一刀扫一片"的武器，配个 arcSwing 就能接上；
          没有武器配它时这条分支永远不进（op.arcSwing === 0）。
       ⚠️ 真要再用：挥砍间隔（转一圈 2π/ω）必须**明显短于**转动窗口 spin，
          否则一个窗口只挥得出一刀，看起来像"甩一下就不动了"（镰刀那版就是这么翻车的）。
       smoke.js 里用一把临时注入的测试武器盯住这套判定，别让它烂掉。 */
    if (op.arcSwing > 0) {
      var st = (P.orbSwingT === undefined ? 0 : P.orbSwingT) - dt;
      if (st > 0) { P.orbSwingT = st; return; }
      P.orbSwingT = revTime;
      var gripS = Math.max(6, op.gripR - 2), any = false;
      for (var si = 0; si < this.foes.length; si++) {
        var sf = this.foes[si];
        if (!sf) continue;
        var sdx = sf.x - P.x, sdy = sf.y - P.y, sd = Math.hypot(sdx, sdy);
        if (sd < 6 || sd + sf.r < gripS || sd - sf.r > op.radius) continue;
        var diff = Math.abs(((Math.atan2(sdy, sdx) - P.orbAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (diff > op.arcSwing) continue;                    // 不在刃口这一片里
        any = true;
        this.damageFoe(sf, op.dmg, op.kb, 'weapon', Math.atan2(sdy, sdx) + Math.PI / 2);
        /* 大剑那种"震地"对扇形武器没意义（它本来就打一片）→ 只保留武器的特质伤害加成 */
        if (tr && tr.id === 'pierceSweep') this.onWeaponHit(W, P, op.dmg);
      }
      if (any) this.onWeaponHit(W, P, op.dmg);               // 声音/火花一次就够（别一刀响十下）
      return;
    }
    var perFoe = Math.max(0.06, revTime / op.blades);         // 每只怪两次扫过的间隔
    var gripR = Math.max(6, op.gripR - 2);                    // 刀柄一侧放宽 2px（别卡边）
    for (var i = 0; i < this.foes.length; i++) {
      var f = this.foes[i];
      if (!f) continue;                        // 循环途中数组可能缩短（见 updateFoes 说明）
      if (f.orbCd > 0) continue;               // 这只怪刚挨过一刀（两次扫过之间）
      var dx = f.x - P.x, dy = f.y - P.y, d = Math.hypot(dx, dy);
      if (d < 6) continue;
      if (d + f.r < gripR || d - f.r > op.radius) continue;    // ① 身体和刀刃的径向范围不相交
      var bearing = Math.atan2(dy, dx);
      var tol = Math.asin(Math.min(0.9, (f.r + 4) / Math.max(1, d)));   // 怪有体积 → 角度给容差
      var hit = false;                                          // ② 这一帧扫过它了吗
      for (var b = 0; b < op.blades; b++) {
        var off = b * Math.PI * 2 / op.blades;
        if (sweptOver(P.orbPrev + off, P.orbAng + off, bearing, tol)) { hit = true; break; }
      }
      if (!hit) continue;

      f.orbCd = perFoe;
      P.orbPass++;
      var mul = 1;
      // 长枪横扫：这一轮转动里每多打一次就更狠（封顶 +60%），起转时清零 → "越转越狠"
      if (tr && tr.id === 'pierceSweep') mul = Math.min(1.6, 1 + 0.04 * P.orbPass);
      /* 击退方向 = **切向**（沿旋转方向甩出去），不是径向。
         ⚠️ 第一版用径向（朝外推）：怪被一次次推出伤害圆、又走回来 → 反复进出，
         轻怪几乎清不掉（跑分：过关 2→0；连"怪绕墙过来"那条测试都红了 —— 怪到 100px 就被顶住）。
         切向既符合"被旋转的刃抽飞"的直觉，又能把怪留在环里持续挨打。 */
      this.damageFoe(f, op.dmg * mul, op.kb, 'weapon', Math.atan2(dy, dx) + Math.PI / 2);
      /* 限次爆发（血刃）：命中回血。溅血粒子只在"还吸得动"的时候出 —— 吸到上限就停，
         玩家一眼看出"吸血到头了"（而不是以为回血坏了）。 */
      if (this.burstHeal() > 0) this.parts.burst(f.x, f.y - 6, (P.burst && P.burst.tint) || '#ff6b5a', 2);
      this.onWeaponHit(W, P, op.dmg);
    }

    // 法杖：转动期间自动放弹（不转圈就不是法杖了 —— 保住"远程"这个身份）
    if (op.castCd > 0 && W.projectile) {
      P.orbCastT -= dt;
      if (P.orbCastT <= 0) {
        P.orbCastT = op.castCd;
        this.castSpell(W, P.stats);
        this.emit('cast', { x: P.x, y: P.y });
      }
    }
  };

  /** 当前武器定义。没装武器就是长剑 —— 所以开局和拿到武器前的打法是一致的 */
  /** 当前武器种类 id（没装武器就是 sword）。注意 weapon() 返回的是"定义对象"，里面没有 kind */
  Game.prototype.weaponKind = function () {
    var it = this.player.equip.weapon;
    return (it && it.kind) ? it.kind : 'sword';
  };

  Game.prototype.weapon = function () {
    return this.cfg.weapons[this.weaponKind()] || this.cfg.weapons.sword;
  };

  /**
   * 命中之后触发武器的独有机制（每命中一只调一次）。
   * 只换数值玩家感觉不到换了武器，必须换机制 —— 这才是"换武器"的吸引力所在。
   * 注：原名叫 onSwingConnect（挥砍命中），换了环绕之后改叫 onWeaponHit。
   *     "贯穿"那条不再在这里（它现在是按圈计数的 pierceSweep，见 updateOrbit）。
   */
  Game.prototype.onWeaponHit = function (W, P, dmg) {
    var tr = W.trait;
    if (!tr) return;

    if (tr.id === 'combo') {
      P.comboStacks = Math.min(tr.maxStacks, P.comboStacks + 1);
      P.comboTimer = tr.decay;

    } else if (tr.id === 'splash') {
      // 震地：对周围敌人溅射
      for (var i = this.foes.length - 1; i >= 0; i--) {
        var f = this.foes[i];
        if (!f) continue;                             // 见 updateFoes 里的说明：循环途中数组可能缩短
        if (Math.hypot(f.x - P.x, f.y - P.y) <= tr.radius) {
          this.damageFoe(f, dmg * tr.mul, 0);
        }
      }
      this.parts.burst(P.x, P.y, W.color, 10);
      this.emit('splash', { x: P.x, y: P.y, radius: tr.radius });
    }
  };

  /* ==================== 武器试炼场 ====================
     目的：最快体验每一把武器，不用打怪不用攒装备。
     无敌 + 一圈钉死的练习靶 + 屏幕上的切武器按钮（点一次换一把，手机上也能用）。 */

  Game.prototype.setTraining = function (on) {
    var P = this.player, cfg = this.cfg;
    var was = !!this.training, next = !!on;
    /* 进试炼场：把**真实武器**存一份；期间切的武器只是临时件，退出时原样还回去。
       （2026-10 修：以前是直接在 equip 上换，试炼场里还会自动存档 →
         玩家手上多出一把假的"稀有"武器，而且真掉落永远顶不掉它。）
       ⚠️ 2026-10 又补一条：**升级卡的状态也要存一份** —— 试炼场里有「试卡」面板，
          它改的是 P.base/taken/evolutions/burst。不存的话"进试炼场白点 26 张卡再退出"
          就等于这一局白拿全部卡（试卡面板本来只是沙盒）。 */
    if (next && !was) {
      if (this.analyticsRun) this.analyticsRun.test = true;
      this.trainingStash = {
        weapon: P.equip.weapon || null,
        base: JSON.parse(JSON.stringify(P.base)),
        taken: JSON.parse(JSON.stringify(P.taken)),
        evolutions: JSON.parse(JSON.stringify(P.evolutions || {})),
        burst: P.burst ? JSON.parse(JSON.stringify(P.burst)) : null
      };
      /* 从首页进来的（调试入口）退出时要回首页，不要把人扔进一局没开过的关卡 */
      this.trainingFromTitle = (this.state === 'title');
      /* 试炼场把**四把武器全发**给玩家（试招要能随手切武器）。
         ⚠️ 发出去的用 id 记着，**退出时按 id 收回来** —— 不收就等于"进一次试炼场白得四把武器"，
            而用户 2026-10 的口径是「开局只能有默认的长剑，其他不可选」。 */
      this.trainingWeaponsAdded = [];
      var selfT = this;
      Object.keys(cfg.weapons).forEach(function (kind) {
        if (P.bag.some(function (it) { return it.kind === kind; })) return;
        var it = selfT.Prog.makeDefaultWeapon(cfg);
        it.id = 'trial-' + kind; it.kind = kind; it.name = cfg.weapons[kind].name;
        P.bag.push(it); selfT.trainingWeaponsAdded.push(it.id);
      });
    }
    this.training = next;
    this.foes.length = 0;
    this.projectiles.length = 0;
    this.pickups.length = 0;
    this.parts.list = [];
    this.state = 'play';
    this.cards = [];
    P.pendingLevels = 0;
    P.comboStacks = 0;
    P.orbOn = false; P.orbT = 0.8; P.orbTotal = 0.8; P.orbAng = 0; P.orbPrev = 0; P.orbAng0 = 0;
    P.orbRev = 0; P.orbPass = 0; P.orbCastT = 0;   // 旋刃状态也归零（换场景/重开）
    this.hitstop = 0;
    this.quakePulse = null; this.flameCd = 0;
    this.lowHpAlarm = false; this.lowHpTimer = 0;    // 换场景：低血警报也说一声"重新开始"
    this.skillCooldowns = {}; this.skillHitCounts = {};
    this.skillVisuals = []; this.skillFields = []; this.skillShadow = null; this.skillDash = null;
    this.skillEchoSwords = []; this.skillEchoStrike = null;   // 剑阵回响：换场景必须清场
    this.skillActiveKind = null; this.skillQuakePending = false;
    this.trainingBossIdx = 0;      // 换场景后 Boss 也被清掉了，索引要跟着归零，否则标签会撒谎

    if (this.training) {
      if (!P.equip.weapon) this.setWeapon('sword');
      this.spawnDummies();
    } else {
      /* 收回试炼场发的试用武器（按 id 删；玩家在试炼场里切过的那把也一样收回，
         手上那把由下面的 trainingStash 还原）。 */
      if (this.trainingWeaponsAdded && this.trainingWeaponsAdded.length) {
        var dropIds = this.trainingWeaponsAdded;
        P.bag = (P.bag || []).filter(function (it) { return it && dropIds.indexOf(it.id) < 0; });
      }
      this.trainingWeaponsAdded = null;
      /* 退出试炼：把手上的武器**还回**进试炼场之前那把（临时件不带走），
         升级卡状态（base/taken/进化/爆发）也一起还回去 —— 试卡面板是沙盒，不能带出门。 */
      if (this.trainingStash) {
        P.equip.weapon = this.trainingStash.weapon
          || (P.bag && P.bag[0]) || this.Prog.makeDefaultWeapon(cfg);
        P.base = this.trainingStash.base;
        P.taken = this.trainingStash.taken;
        P.evolutions = this.trainingStash.evolutions;
        P.burst = this.trainingStash.burst;
        this.trainingStash = null;
        this.Prog.recompute(P, cfg);
      }
      this.dummies = [];
      this.spawnT = 0.6;
      /* 从首页进来的：退出回首页（不回战场）。
         ⚠️ 用 keep:false（不存档）—— 首页进来的这一局根本没开始，"退出"不该在存档里
            写出一份"继续上次"（否则首页会凭空多出一个进度条）。 */
      if (this.trainingFromTitle) {
        this.trainingFromTitle = false;
        this.training = false;
        this.emit('training', { on: false });
        P.hp = P.stats.maxhp;
        return this.toTitle({ keep: false });
      }
    }
    P.hp = P.stats.maxhp;
    P.inv = 0;
    this.emit('training', { on: this.training });
    return this.training;
  };

  /** 一圈练习靶：正前方排一列（测穿透/范围），两侧各一只（测溅射/扇形） */
  Game.prototype.spawnDummies = function () {
    var cfg = this.cfg, P = this.player, list = cfg.debug.dummies;
    // 只清旧的练习靶 —— 试炼 Boss 要留着（它得正常放技能给我看）
    for (var j = this.foes.length - 1; j >= 0; j--) {
      if (this.foes[j].dummy) this.foes.splice(j, 1);
    }
    this.dummies = [];
    for (var i = 0; i < list.length; i++) {
      var f = this.Entities.makeFoe(cfg, 'tank', P.x + list[i].dx, P.y + list[i].dy, 1);
      f.hp = f.maxhp = 1e9;      // 打不死，方便反复试
      f.dmg = 0;                 // 不咬人
      f.spd = 0;                 // 不乱跑
      f.dummy = true;
      f.name = '练习靶';
      f.home = { x: P.x + list[i].dx, y: P.y + list[i].dy };
      this.foes.push(f);
      this.dummies.push(f);
    }
  };

  Game.prototype.resetDummies = function () { this.spawnDummies(); };

  /**
   * 试炼场里轮流召唤 Boss：不召唤 → warden → frost → 不召唤…
   * 加第二个 Boss 之后，"怎么快速看到它"就成了新问题 —— 这个按钮就是答案。
   */
  Game.prototype.cycleTrainingBoss = function () {
    var cfg = this.cfg, P = this.player, order = cfg.bossOrder;

    for (var i = this.foes.length - 1; i >= 0; i--) {
      if (this.foes[i].kind === 'boss') this.foes.splice(i, 1);
    }
    this.trainingBossIdx = ((this.trainingBossIdx || 0) + 1) % (order.length + 1);
    if (this.trainingBossIdx === 0) {
      this.emit('bossDown', { x: P.x, y: P.y });
      /* 取消召唤 = 回到"武器试车台"：靶子摆回来（也可能上一只 Boss 把它收了）。 */
      if (!this.dummies || !this.dummies.length) this.spawnDummies();
      return null;
    }

    var kind = order[this.trainingBossIdx - 1];
    /* 召唤 Boss 时先把练习靶收起来：靶子摆在正前方 92/176/260px，
       正好压在 Boss 的扇形/细线预警上 —— "试 Boss"时视线优先。
       想要靶子回来看伤害，点「重置靶子」（它只清靶子、留着 Boss，见 spawnDummies）。 */
    for (var di = this.foes.length - 1; di >= 0; di--) {
      if (this.foes[di].dummy) this.foes.splice(di, 1);
    }
    this.dummies = [];
    var b = this.Entities.makeBoss(cfg, P.x + 300, P.y - 150, this.stage || 1, kind);
    /* 血量 = **和正式关卡一样**（2026-10 改，原来是 ×3「血厚一点，方便看完全部技能」）。
       有了半血裂壳之后 ×3 就变成反效果：得先啃掉 4800 血才看得到二阶段，
       那不是"试招"该有的等待。用真血量顺带能对一下"这只 Boss 打起来要多久"。 */
    b.dmg = 0;                        // 接触伤害关掉；**招的伤害照常**（钳夹/震荡波/尾针，见 debug.damage）
    this.world.collide(b);
    this.foes.push(b);
    this.emit('boss', { x: b.x, y: b.y, bossType: kind });
    return kind;
  };

  Game.prototype.trainingBossName = function () {
    if (!this.trainingBossIdx) return '未召唤（点一下召唤）';
    var order = this.cfg.bossOrder;
    return this.cfg.bossTypes[order[this.trainingBossIdx - 1]].name;
  };

  /**
   * 试炼场里的铁角（冲撞型敌人）。
   * 铁角在第 5 波之后才会随机刷出来，想在试炼场里反复看"蓄力预警线 → 冲撞"
   * 就只能自己召唤。默认放两只（一左一右），点第二次赶走 —— 和「切换 Boss」一样是开关。
   */
  Game.prototype.trainingChargerCount = function () {
    var n = 0;
    for (var i = 0; i < this.foes.length; i++) if (this.foes[i].trainCharger) n++;
    return n;
  };

  Game.prototype.clearTrainingChargers = function () {
    var n = 0;
    for (var i = this.foes.length - 1; i >= 0; i--) {
      if (this.foes[i].trainCharger) { this.foes.splice(i, 1); n++; }
    }
    return n;
  };

  Game.prototype.spawnTrainingChargers = function () {
    var cfg = this.cfg, P = this.player, list = cfg.debug.chargers;
    this.clearTrainingChargers();
    for (var i = 0; i < list.length; i++) {
      var f = this.Entities.makeFoe(cfg, 'charger', P.x + list[i].dx, P.y + list[i].dy, 1);
      f.hp = f.maxhp = f.maxhp * 3;   // 血厚一点，方便反复看完"蓄力 → 冲撞 → 冷却"整个循环
      f.trainCharger = true;
      f.name = '铁角（练习）';
      this.world.collide(f);
      this.foes.push(f);
    }
    return this.trainingChargerCount();
  };

  Game.prototype.toggleTrainingChargers = function () {
    if (this.trainingChargerCount() > 0) return (this.clearTrainingChargers(), 0);
    return this.spawnTrainingChargers();
  };

  /** 试炼场每帧：钉住靶子（位置+血量复位），这样范围和穿透的对比才有意义 */
  Game.prototype.updateSpawnsTraining = function () {
    var P = this.player;
    /* ⚠️ "试炼场无敌"其实就是**每帧把这行血顶满** —— 所以打开 debug.damage（试 Boss）时
       必须把这一句关掉：否则挨打只闪一帧就回满，看起来像血条坏了、也试不出惩罚。
       改成只保证不死（低于 1 就抬回 1），掉血照常看得见。
       （这条是被测试抓出来的：直接调 hurtPlayer 是过的，跑起主循环才发现血会弹回来。） */
    if (!(this.cfg.debug && this.cfg.debug.damage)) P.hp = P.stats.maxhp;
    else if (P.hp < 1) P.hp = 1;
    for (var i = 0; i < this.dummies.length; i++) {
      var d = this.dummies[i];
      d.hp = d.maxhp;
      d.x = d.home.x;
      d.y = d.home.y;
      d.kb.x = 0; d.kb.y = 0;
    }
  };

  /** 试炼场按钮的屏幕矩形。渲染层画它、核心层判定它，共用同一份布局 */
  Game.prototype.trainingRects = function () {
    var vw = this.viewport.w, vh = this.viewport.h;
    var gap = 10, bh = 38, rowGap = 8;
    var y0 = vh - bh * 2 - rowGap - 16;
    var chargerLabel = this.trainingChargerCount() > 0 ? '赶走铁角' : '召唤铁角';
    /* 第二排 4 个（2026-10 加「试卡」）：每排的长度按这一排的个数算 ——
       以前是按 3 个算死的，加第 4 个会把整排顶出屏幕右边缘。 */
    var rows = [
      [{ id: 'prev', label: '◀ 上一把' }, { id: 'reset', label: '重置靶子' }, { id: 'next', label: '下一把 ▶' }],
      [{ id: 'boss', label: '切换 Boss' }, { id: 'charger', label: chargerLabel },
       { id: 'cards', label: '试卡' }, { id: 'exit', label: '退出试炼' }]
    ];
    var out = [];
    for (var r = 0; r < rows.length; r++) {
      var n = rows[r].length;
      var unit = Math.max(76, Math.min(142, (vw - gap * (n + 1)) / n));
      var total = unit * n + gap * (n - 1);
      var x0 = (vw - total) / 2;
      var y = y0 + r * (bh + rowGap);
      for (var i = 0; i < n; i++) {
        out.push({ id: rows[r][i].id, label: rows[r][i].label,
                   x: x0 + i * (unit + gap), y: y, w: unit, h: bh });
      }
    }
    return out;
  };

  /* ==================== 试炼场 · 试卡面板（2026-10） ====================
     用户口径：「在练武场中，提供一个可以体验指定卡片的功能」。
     为什么需要：升级是"三选一 + 随机"，一张卡一局最多露一两次脸，要判断"这张卡到底好不好使"
     只能靠运气刷。这里给一个**直接点名**的面板 —— 只能从试炼场打开（正式关卡里必须打不开）。

     三条设计口径：
       ① **点一下就用上**，不做二次确认：试卡是"连点十几张找手感"，多一步确认就废了。
       ② 「清空本局卡」一键回裸装 —— 不然试到第 5 张时数值已经滚起来了，后面试什么都测不准。
       ③ 金色版单独一个开关：真实池子里金色只有 12% 概率，不给入口就永远试不到。
     走的是**真实选卡路径**（Prog.applyUpgrade），所以试出来的效果和正式局里完全一致
     （代价卡的副作用、开天那种 burst 登记，都走同一条路）。 */

  /** 面板的四个分类。⚠️ 机制卡靠 config 里的 `cat:'mechanic'` 标，其余按 weapon/cost 推 ——
      以后新加机制卡记得打这个标，否则它会落在「数值」页（不致命，但会误导） */
  Game.prototype.trialCardCats = function () {
    return [{ id: 'stat', label: '数值' }, { id: 'mechanic', label: '机制' },
            { id: 'cost', label: '代价' }, { id: 'weapon', label: '武器' }];
  };

  Game.prototype.trialCardCatOf = function (u) {
    if (u.weapon) return 'weapon';
    if (u.cost) return 'cost';
    return u.cat === 'mechanic' ? 'mechanic' : 'stat';
  };

  /** 某个分类下的卡。停用的（sprint）不列 —— 用户口径"没做完的先藏起来" */
  Game.prototype.trialCardList = function (cat) {
    var self = this;
    return this.cfg.upgrades.filter(function (u) {
      return !u.disabled && self.trialCardCatOf(u) === cat;
    });
  };

  /** 面板矩形：渲染层画它、核心层判定它，共用同一份（和 trainingRects 一个规矩） */
  Game.prototype.trialCardPanelRects = function () {
    var vp = this.viewport, ins = vp.insets || {};
    var pad = 14;
    var px = pad + (ins.left || 0), py = 10 + (ins.top || 0);
    var pw = vp.w - pad * 2 - (ins.left || 0) - (ins.right || 0);
    var ph = vp.h - 20 - (ins.top || 0) - (ins.bottom || 0);
    var panel = { x: px, y: py, w: pw, h: ph };

    var cats = this.trialCardCats();
    var tw = 92, th = 26, tg = 8;
    var tabsW = tw * cats.length + tg * (cats.length - 1);
    var tabs = [];
    for (var i = 0; i < cats.length; i++) {
      tabs.push({ id: cats[i].id, label: cats[i].label,
                  x: px + (pw - tabsW) / 2 + i * (tw + tg), y: py + 30, w: tw, h: th });
    }

    var cols = 3, rows = 4, cg = 10, rg = 8, inner = 12;
    var gridX = px + inner, gridW = pw - inner * 2;
    var gridY = tabs[0].y + th + 10;
    var footH = 42;
    var gridH = py + ph - footH - gridY;
    var cellW = (gridW - cg * (cols - 1)) / cols;
    var cellH = (gridH - rg * (rows - 1)) / rows;
    var tiles = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        tiles.push({ x: gridX + c * (cellW + cg), y: gridY + r * (cellH + rg), w: cellW, h: cellH });
      }
    }

    var bw = 150, bh = 30, bg = 12;
    var fy = py + ph - 34;
    var fx = px + (pw - (bw * 3 + bg * 2)) / 2;
    var foot = [
      { id: 'clear', label: '清空本局卡', x: fx, y: fy, w: bw, h: bh },
      { id: 'gold', label: this.trialCardGold ? '金色版：开' : '金色版：关', x: fx + bw + bg, y: fy, w: bw, h: bh },
      { id: 'close', label: '关闭', x: fx + (bw + bg) * 2, y: fy, w: bw, h: bh }
    ];
    return { panel: panel, tabs: tabs, tiles: tiles, foot: foot };
  };

  Game.prototype.openTrialCards = function () {
    /* ⚠️ 只有试炼场能开。这条是硬门槛：正式关卡里能白拿卡 = 整个升级系统作废。 */
    if (!this.training) return false;
    this.state = 'trialcards';
    this.cardPanelGuard = 0.12;
    this.emit('openBag', { x: this.player.x, y: this.player.y });
    return true;
  };

  Game.prototype.closeTrialCards = function () {
    this.state = 'play';
    this.cardPanelGuard = 0.12;
    return true;
  };

  /**
   * 试用一张卡（可重复点：数值卡会叠加，属性页里能直接看到累积结果）。
   * gold=true 时走金色版（没有金色版的卡自动退化成普通版）。
   */
  Game.prototype.applyTrialCard = function (id, gold) {
    var cfg = this.cfg, P = this.player;
    var u = cfg.upgrades.filter(function (x) { return x.id === id; })[0];
    if (!u || u.disabled) return false;
    var useGold = !!(gold && u.rare);
    var full = useGold ? id + '#rare' : id;
    if (!this.Prog.applyUpgrade(cfg, P, full)) return false;
    /* 限次爆发卡（开天）：和正式选卡一样要登记 burst（金色版用金版的参数） */
    if (u.burst) {
      this.grantBurst({ id: full, name: useGold ? u.rare.name : u.name,
                        burst: (useGold && u.rare.burst) ? u.rare.burst : u.burst });
    }
    /* 血量按新上限补满：不然试「坚韧」（+生命上限）看不出效果 —— 试炼场本来就无敌，
       血条只有"上限有没有涨"这一个信息量。 */
    P.hp = P.stats.maxhp;
    this.trialCardLast = useGold ? u.rare.name : u.name;
    this.parts.text(P.x, P.y - 78, this.trialCardLast + '（试用）', '#ffd166');
    return true;
  };

  /** 清空本局拿过的卡：base 回裸装 + taken/进化/爆发全清（试卡要能重来） */
  Game.prototype.clearTrialCards = function () {
    var cfg = this.cfg, P = this.player, k;
    P.base = {};
    /* 这一段和 entities.makePlayer 里那段是同一件事（裸装副本来自 cfg.player.base）——
       两处要一起改。 */
    for (k in cfg.player.base) if (Object.prototype.hasOwnProperty.call(cfg.player.base, k)) P.base[k] = cfg.player.base[k];
    P.taken = {};
    P.evolutions = {};
    P.burst = null;
    this.Prog.recompute(P, cfg);
    P.hp = P.stats.maxhp;
    P.frenzy = 0; P.frenzyCharge = 0;
    this.trialCardLast = '已全部清空';
    this.parts.text(P.x, P.y - 78, '卡片已清空（回裸装）', '#9beaff');
    return true;
  };

  Game.prototype.updateTrialCards = function (input) {
    if (!input.tap) return;
    if (this.cardPanelGuard > 0) return;                  // 刚弹出/刚切页签：还在护栏期
    var R = this.trialCardPanelRects(), i;
    for (i = 0; i < R.tabs.length; i++) {
      if (this.inRect(R.tabs[i], input.tap)) {
        if (this.trialCardCat !== R.tabs[i].id) { this.trialCardCat = R.tabs[i].id; this.cardPanelGuard = 0.1; }
        return;
      }
    }
    for (i = 0; i < R.foot.length; i++) {
      if (!this.inRect(R.foot[i], input.tap)) continue;
      var f = R.foot[i];
      if (f.id === 'clear') this.clearTrialCards();
      else if (f.id === 'gold') this.trialCardGold = !this.trialCardGold;
      else this.closeTrialCards();
      return;
    }
    var list = this.trialCardList(this.trialCardCat);
    for (i = 0; i < list.length && i < R.tiles.length; i++) {
      if (this.inRect(R.tiles[i], input.tap)) { this.applyTrialCard(list[i].id, this.trialCardGold); return; }
    }
    /* 点空白处**不关**面板：试卡时会连着点错位置，误关比"找不到关闭键"更烦（关闭键就在下面中间）。 */
  };

  Game.prototype.updateTrainingInput = function (input) {
    if (!input.tap) return false;
    var rects = this.trainingRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (input.tap.x < r.x || input.tap.x > r.x + r.w) continue;
      if (input.tap.y < r.y || input.tap.y > r.y + r.h) continue;
      if (r.id === 'prev') this.cycleWeapon(-1);
      else if (r.id === 'next') this.cycleWeapon(1);
      else if (r.id === 'reset') this.resetDummies();
      else if (r.id === 'boss') this.cycleTrainingBoss();
      else if (r.id === 'charger') this.toggleTrainingChargers();
      else if (r.id === 'cards') this.openTrialCards();
      else if (r.id === 'exit') this.setTraining(false);
      return true;
    }
    return false;
  };

  Game.prototype.weaponKindList = function () {
    var keys = [];
    for (var k in this.cfg.weapons) {
      if (Object.prototype.hasOwnProperty.call(this.cfg.weapons, k)) keys.push(k);
    }
    return keys;
  };

  /** 切上一把 / 下一把。返回换成了哪把 */
  Game.prototype.cycleWeapon = function (dir) {
    var list = this.weaponKindList();
    var i = list.indexOf(this.weaponKind());
    if (i < 0) i = 0;
    var n = list.length;
    return this.setWeapon(list[((i + (dir || 1)) % n + n) % n]);
  };

  /**
   * 试炼场用：直接把武器换成指定种类（正常玩法靠掉落 + tryEquip 的自动比较）。
   *
   * ⚠️ 2026-10 真机 bug：这里原来是**写死**的
   *   `{ id:'training-'+kind, rarity:3(稀有), affixes:[攻击 +14], score: 50 }`
   * 两个后果都很糟：
   *   ① 数值和真掉落对不上 —— 真·稀有武器是"攻击 +27、score 3.86"，写死的却是 +14/50；
   *      真机上表现为"我两把都是稀有，为什么大剑的攻击比双刀小"（大剑正是试炼场留下的那把）。
   *   ② score 50 比真·史诗武器(5.8)还大 → 一旦被存进存档，**真掉落永远顶不掉它**，
   *      等于玩家在试炼场试过的武器被永久削弱。
   * 现在改成走和 Boss 掉落**同一个函数**（rollItem + forceKind），默认还是钉在"稀有"
   * 那一档（试炼场要能同品质比较），但词条值和 score 都是真算出来的。
   * 另外：进出试炼场会原样还回真实武器（见 setTraining），所以这把临时件不会留在手上。
   */
  Game.prototype.setWeapon = function (kind, rarityId) {
    var P = this.player, cfg = this.cfg, wdef = cfg.weapons[kind];
    if (!wdef) return null;
    var wave = (cfg.stage && cfg.stage.wavesPerStage) || 7;      // Boss 波次 → 和真掉落同一档
    var it = this.Prog.rollItem(cfg, wave, {
      allowWeapon: true, weaponChance: 1, forceKind: kind, rarity: rarityId || 3
    });
    it.id = 'training-' + kind;                                  // 只是标记"这是试炼场的临时件"
    P.equip.weapon = it;
    this.Prog.recompute(P, cfg);
    this.emit('equip', { x: P.x, y: P.y });
    return kind;
  };

  /** 法杖：发射玩家方投射物 */
  Game.prototype.castSpell = function (W, S) {
    var P = this.player, pr = W.projectile;
    var n = pr.count || 1;
    var aim = this.skillAim();
    var tr = W.trait;
    for (var i = 0; i < n; i++) {
      var ang = aim + (n > 1 ? (i - (n - 1) / 2) * (pr.spread || 0) : 0);
      var shot = this.Entities.makeProjectile(
        P.x, P.y - 14, ang, pr.speed, S.attackDamage * pr.damageMul,
        pr.r, W.color, 'player');
      if (tr && tr.id === 'pierce') shot.pierce = tr.maxHits;   // 穿透：能多穿几个
      shot.skillWeapon = 'staff';
      shot.chainSkill = this.hasWeaponSkill('staff_chain');
      shot.splitSkill = this.hasWeaponSkill('staff_split');
      if (this.playerShotCount() < this.cfg.skillLimits.projectiles) this.projectiles.push(shot);
    }
    this.parts.burst(P.x, P.y - 14, W.color, 5);
  };

  /**
   * 扇形范围伤害。reach/arc/dmg/kb 由武器算好传进来。
   * 先收集命中目标、再统一结算 —— 因为"贯穿"要按距离排序算递增伤害，
   * 而且这样也避免了边遍历 this.foes 边被 onFoeDeath 删元素的隐患。
   * 返回有没有打到人（音效策略要用）。
   */
  /* 原来的 resolveSwing（扇形判定 + 贯穿排序）已删除：换环绕之后没有任何调用点。
     判定改在 updateOrbit 里按"扫过的弧"做，命中冷却挂在每一只怪身上（f.orbCd）。 */

  /**
   * 对敌人造成伤害。**所有**伤害都从这里走，所以免疫门也放在这里（只放一处，不会漏）。
   * src：'weapon'（默认，玩家武器/弹体/武器溅射）| 'reflect'（尖甲反伤）| 'env'（环境）
   * 甲壳兽合壳时**只免疫 weapon** —— 反伤和环境照常吃，
   * 否则"免疫怪"会变成"必须有尖甲卡才打得过"（等于把卡变成必需卡）。
   */
  /**
   * 顿帧只在这里设，而且**已经有一次在跑就不再刷新**。
   * 为什么（2026-10 换成环绕攻击时踩的）：环绕是"环里的怪持续挨打"，
   * 一秒钟能命中好几次，每次都给顿帧的话 → update 反复提前返回 →
   * ① 冷却不递减，实测攻速比配置慢 20%+；② 怪一多画面就一直在冻结。
   * 所以命中不再顿帧（靠火花/伤害数字/音效/击退给反馈），顿帧只留给击杀、受伤、起转。
   */
  Game.prototype.punchHitstop = function (v) {
    if (this.hitstop > 0) return;
    this.hitstop = Math.max(this.hitstop, v || 0);
  };

  /**
   * 旋刃用：从 a0 扫到 a1 这一段弧，有没有扫过 bearing（含 tol 容差）。
   * 必须按"扫过的弧"判 —— 只比当前帧角度的话，转速快时刀刃会从一只怪身上直接跳过去（穿怪）。
   */
  function sweptOver(a0, a1, bearing, tol) {
    var span = a1 - a0;
    if (span <= 0) span += Math.PI * 2;
    var TWO = Math.PI * 2;
    var delta = ((bearing - a0) % TWO + TWO) % TWO;
    return delta <= span + tol || delta >= TWO - tol;
  }

  Game.prototype.areaPulse = function (x, y, radius, damage, source) {
    var targets = this.foes.slice();
    for (var i = 0; i < targets.length; i++) {
      var f = targets[i], dx = f.x - x, dy = f.y - y;
      if (f.hp > 0 && dx * dx + dy * dy <= (radius + f.r) * (radius + f.r))
        this.damageFoe(f, damage, 80, source);
    }
    this.parts.burst(x, y, source === 'flame' ? '#ff9b45' : '#ffd166', 20);
    this.emit('splash', { x: x, y: y, radius: radius });
  };

  Game.prototype.buildHint = function () {
    var P = this.player, kind = this.weaponKind();
    var cards = this.cfg.upgrades.filter(function (u) { return u.weapon === kind; });
    var owned = cards.filter(function (u) { return !!P.taken[u.id]; });
    return this.weapon().name + '技能 ' + owned.length + '/' + cards.length + ' · ' +
      (owned.length ? owned.map(function (u) { return u.name; }).join('＋') : '升级可选专属卡');
  };

  Game.prototype.damageFoe = function (f, dmg, knockback, src, dirAng) {
    if (!f || f.hp <= 0) return false;
    if (this.entranceScene || (f.arrival && (f.arrival.elapsed<f.arrival.total || f.arrival.grace>0))) return false;
    var P = this.player, cfg = this.cfg;

    if (f.shell && !f.shellOpen && src !== 'reflect' && src !== 'env') {
      /* 砍在闭合的壳上：不掉血、**不给击退**（否则双刀能把免疫怪一路推着走）、
         不给 hitsound 之外的反馈 —— 但必须有反馈，否则玩家以为是自己没打中。 */
      f.blockT = 0.20;
      this.parts.burst(f.x + Math.cos(P.face) * f.r * 0.9, f.y - 6 + Math.sin(P.face) * f.r * 0.5,
        '#ffe9a8', 5);
      this.parts.text(f.x + (Math.random() * 14 - 7), f.y - f.r - 10, '免疫', '#cfe3ff');
      this.emit('block', { x: f.x, y: f.y });
      return false;
    }

    /* 处决（卡片「处决」）：残血怪**碰一下就倒**，不走伤害计算。
       ⚠️ 三条限制：只认武器命中（src==='weapon'，反伤/环境不算）、Boss 不吃（否则一刀秒 Boss）、
          开壳免疫的甲壳兽在上面那条就 return 了（处决不能绕过免疫）。
       为什么要有：血少了以后每只都要再补一刀很烦，这一张把"收拾残局"变成爽点。 */
    var exe = (P.stats && P.stats.execute) || 0;
    if (exe > 0 && src === 'weapon' && f.kind !== 'boss' && !f.trialElite && f.hp > 0 && f.hp <= f.maxhp * exe) {
      f.hp = 0;
      this.parts.text(f.x + 12, f.y - f.r - 26, '处决!', '#ffd166');
      this.parts.burst(f.x, f.y - 4, '#ffd166', 16);
      this.emit('execute', { x: f.x, y: f.y });
    }

    var mul = (f.shell && f.shellOpen) ? f.shell.openDmgMul : 1;   // 开壳窗口：伤害加成（耐心有回报）
    if (this.cfg.trial.enabled && src === 'skill') dmg *= 0.65;
    f.hp -= dmg * mul * (1 - (f.dr || 0));      // 护盾词缀：减伤
    f.hurt = 0.16;
    var kb = (knockback === undefined ? cfg.combat.knockback : knockback)
             * (f.kind === 'boss' ? cfg.combat.bossKnockbackScale : 1);
    // dirAng：环绕攻击按"扫到它的那个方位"推（沿切向甩出去）；不传就用玩家面朝方向（老挥砍）
    var kang = (dirAng === undefined || dirAng === null) ? P.face : dirAng;
    f.kb.x += Math.cos(kang) * kb;
    f.kb.y += Math.sin(kang) * kb;
    this.parts.burst(f.x, f.y - 6, '#bff58a', 6);
    this.parts.text(f.x + (Math.random() * 16 - 8), f.y - f.r - 6, String(Math.round(dmg * mul)), '#ffe9a8');
    if (src === 'weapon') this.recordSkillHit();
    if (f.hp <= 0) {
      this.emit('kill', { x: f.x, y: f.y, boss: f.kind === 'boss' });
      this.punchHitstop(cfg.feel.hitstop.kill);
      if (this.weaponKind() === 'greatsword' && P.evolutions && P.evolutions.quake &&
          src !== 'echo' && !this.quakePulse) {
        this.quakePulse = { x: f.x, y: f.y, t: 0.18, damage: P.stats.attackDamage * 0.7 };
      }
      this.onFoeDeath(f);
    } else {
      this.emit('hit', { x: f.x, y: f.y });     // 命中不再给顿帧（见 punchHitstop 的说明）
    }
    return true;
  };

  Game.prototype.onFoeDeath = function (f) {
    var cfg = this.cfg, P = this.player;

    P.kills++;
    if (!(P.frenzy > 0)) {
      var previous = P.frenzyCharge || 0;
      P.frenzyCharge = Math.min(this.cfg.frenzy.threshold, previous + 1);
      if (previous < this.cfg.frenzy.threshold && P.frenzyCharge === this.cfg.frenzy.threshold) {
        this.frenzyNotice = '狂热就绪 · 点击右侧按钮释放'; this.frenzyNoticeT = 2;
        this.emit('frenzyReady', {});
      }
    }
    if (this.trial && f.trialFoe && !f.tideFoe) {
      var born=f.trialWave===undefined?this.wave:f.trialWave;
      var ledger=this.trial.killsByWave||(this.trial.killsByWave={});ledger[born]=(ledger[born]||0)+1;
      if(born===this.wave)this.trial.killed++;
    }
    if (this.trial && f.trialElite) {
      this.trial.eliteDead = true;
      P.hp = Math.min(P.stats.maxhp, P.hp + 15);
      this.parts.text(P.x, P.y - 68, '精英击破 · 恢复15生命', '#8fd6a5');
      /* 精英 = 武器技能的来源（2026-10）。掉落**不自动进包**：掉在地上等玩家自己来捡
         （用户口径"不自动消失、附近可以吸附、不自动飞过来"）。 */
      this.dropSkillScroll(f.x, f.y);
      /* 熟练度：精英也给一点（2026-10 用户口径）。**教学精英（第 1 波那只）给得最少** ——
         它是唯一能"打完就送死重开"刷的，所以按 config.mastery.gains.tutorialElite 发。
         判定用 f.eliteTips（精英身上带的"这是教学那只"标记，spawnTrialFoe 里从 E.tips 写的），
         **不用波次号** —— 以后关数变了、教学精英不在第 1 波了，这条也不会错。
         once 键按**这只精英出生的波次**去重（一局同一只只给一次）；不把武器 kind 放进键里 ——
         键越"具体"越容易留下第二条领分路径，这里只要保证"同一只精英一局只结算一次"就够。
         ⚠️ 键必须**跨重刷稳定**（这就是用波次而不是自增 uid 的原因）：重刷出来的精英会拿到
            新的 uid，用它当键等于没防住"强杀进程 → 继续上次"那条路。
            带上 tips 标记是为了同一波里万一有两只（教学 + 普通）时也能分开。 */
      var MG = this.cfg.mastery && this.cfg.mastery.gains;
      if (MG) {
        var bornWave = (f.trialWave === undefined) ? this.wave : f.trialWave;
        this.gainMastery(f.eliteTips ? MG.tutorialElite : MG.elite,
                         'elite:' + bornWave + (f.eliteTips ? ':tutorial' : ':normal'));
      }
    }
    if(f.type==='spitter'&&f.spitWindup>0)this.hazards=this.hazards.filter(function(h){return h.kind!=='poison'||h.spitId!==f.spitId||h.launched;});
    P.xp += f.xp;
    if (P.stats.lifesteal > 0) {
      P.hp = Math.min(P.stats.maxhp, P.hp + P.stats.lifesteal);
      this.parts.text(P.x, P.y - 46, '+' + P.stats.lifesteal, '#8fd6a5');
    }
    // 死亡碎屑按体型来：大怪炸得多、用的是它自己的颜色（"这只怪碎了"而不是"爆了一团绿"）
    this.parts.burst(f.x, f.y, f.kind === 'boss' ? '#ff9b6b' : f.color,
      f.kind === 'boss' ? 60 : Math.round(8 + f.r * 0.7));

    /* 金币。goldMul：甲壳兽这种"打得费劲"的怪掉一大笔（装备只有 Boss 掉之后，
       它的"等开壳"回报就落在这里，否则这只怪没人愿意打）。
       第 5 关起 Boss 那一笔再乘 lateReward.goldMul（四把武器都给完了，改发"钱 + 品质"）。 */
    var goldN = Math.round(f.gold * (f.goldMul || 1) * (f.kind === 'boss' ? this.lateReward().goldMul : 1));
    // Preserve the exact reward while limiting physics, draw and audio work.
    var coins = Math.min(5, goldN);
    for (var i = 0; i < coins; i++) {
      var value = Math.floor(goldN / coins) + (i < goldN % coins ? 1 : 0);
      this.pickups.push(this.Entities.makePickup('gold', f.x, f.y, value));
    }
    /* **装备和武器一样：只有 Boss 掉，而且是概率掉**（真机口径）。
       杂兵 / 精英 / 甲壳兽一件都不掉 → 所以这里没有 guaranteedDrop 分支了。
       Boss：一件，部位**均匀随机**（weaponChance = 1/3 → 武器 1/3、防具 1/3、饰品 1/3）。 */
    if (f.kind === 'boss') {
      var late = this.lateReward();
      /* ① **必掉一件**：前四关是这一关的专属武器（见 rollStageWeapon）；
         第 5 关起四把武器都给过了 → rollStageWeapon 返回 null，这一件改成装备，
            并且整批掉落都带"越往后越好"的品质加成（见 lateReward / config.items.lateReward）。 */
      var kind = this.rollStageWeapon();
      this.pickups.push(this.Entities.makePickup('item', f.x, f.y,
        this.Prog.rollItem(cfg, this.wave, {
          allowWeapon: !!kind, weaponChance: 1, forceKind: kind || undefined,
          rarityBonus: late.rarityBonus, affixMul: late.affixMul
        })));
      /* ② 另外按概率掉防具/饰品（bossItems - 1 件，永不再出武器：武器只有上面那一条路） */
      for (var k = 1; k < (cfg.items.bossItems || 1); k++) {
        if (Math.random() >= cfg.items.dropChance.boss) continue;
        this.pickups.push(this.Entities.makePickup('item', f.x, f.y,
          this.Prog.rollItem(cfg, this.wave, {
            allowWeapon: false, rarityBonus: late.rarityBonus, affixMul: late.affixMul
          })));
      }
    }
    if (f.kind === 'boss') this.emit('bossDown', { x: f.x, y: f.y });

    // 爆裂词缀：死亡时原地炸一下，只打玩家（不给经验，纯压力）
    if (f.affix && f.affix.id === 'burst') {
      var R = f.affix.radius, dmg = f.affix.damage;
      this.parts.burst(f.x, f.y, f.affix.color, 20);
      this.emit('burst', { x: f.x, y: f.y, radius: R });
      if (Math.hypot(P.x - f.x, P.y - f.y) < R + P.r) this.hurtPlayer(dmg, f.x, f.y, f, 'enemy_burst');
    }

    if (f.kind === 'boss') {
      this.bossAlive = Math.max(0, (this.bossAlive || 0) - 1);
      // 关底 Boss 全清 = 过关条件满足 → 直接过关（见 stageClear）
      if (this.bossAlive === 0 && this.stageBossPending) this.stageClear();
    } else {
      if (!f.harvest) this.stageKills++; // 奖励怪计击杀与狂热，但不加速关卡/Boss
    }

    // 移除
    for (i = this.foes.length - 1; i >= 0; i--) {
      if (this.foes[i] === f) { this.foes.splice(i, 1); break; }
    }
    this.checkLevelUp();
  };

  /* ==================== 升级 ==================== */

  Game.prototype.checkLevelUp = function () {
    var cfg = this.cfg, P = this.player;
    while (P.xp >= P.xpNext) {
      P.xp -= P.xpNext;
      P.level++;
      P.xpNext = this.Prog.xpForNext(P.level, cfg);
      P.pendingLevels++;
      P.hp = Math.min(P.stats.maxhp, P.hp + cfg.growth.healOnLevelUp);
    }
    if (P.pendingLevels > 0 && this.state === 'play' && !(this.trial && this.trial.finished)) this.openLevelUp();
  };

  Game.prototype.weaponSkillRows = function (kind) {
    var self = this;
    var hasWeapon = kind === 'sword' || (this.player.bag || []).some(function(it){return it && it.kind === kind;}) ||
      !!(this.player.equip.weapon && this.player.equip.weapon.kind === kind);
    return this.cfg.upgrades.filter(function (c) { return c.weapon === kind; }).map(function (c) {
      // Home shows permanent access, never the previous run's active skills.
      var owned = hasWeapon && !self.homeLibrary && !!self.player.taken[c.id];
      var status;
      if (!hasWeapon) status = '未解锁 · 先获得对应武器';
      else if (owned) status = (kind === self.weaponKind()) ? '已获得 · 生效中' : '已获得 · 装备后生效';
      else if (c.masteryMin && !self.masteryUnlocked(kind, c.masteryMin))
        status = '未解锁 · 需' + ((self.cfg.weapons[kind] && self.cfg.weapons[kind].name) || kind) +
                 '熟练度 Lv' + c.masteryMin;
      else status = '可获取 · 局内精英掉落';
      return { id: c.id, name: c.name, desc: c.desc, owned: owned, status: status };
    });
  };

  /* ⚠️ 2026-10 删掉 `skillHudRects()`：屏幕底部那两个武器技能格不再显示
     （用户口径"在武器库里面有"），对应的点击热区也删了。
     想找武器技能/属性：左下角「武器库」→「技能」页签（`bagBtnRect()` + `bagTabs()`）。 */

  /**
   * 武器库「技能」页 / 「熟练度」页**共用的外框**：那排武器页签 + 整页 body。
   * 两页的头部一模一样（布局确定性：切页时下面的东西不许挪），所以只算一份。
   *
   * 比例是**按 812x375 横屏反推的**：
   *   · body.h = 199.5（vp.h 375 - 底部 21 安全区 - y 46.5 - 68 页脚）
   *   · 技能页：body 整块给技能卡（卡片高 = body.h - 26 = 173.5，名字 +9 / 状态 +30 / 描述 +52，
   *     多出来的高度是描述换行的余量，不会再像以前那样只有 74px 必须压字号）
   *   · 熟练度页：body 上半一行进度（复用 drawMasteryBlock，26px）+ 下半 Lv1~LvN 竖排（一级一行）
   *
   * ⚠️ `tabs` 是**武器**页签（长剑/双刀/…），不是顶部那排「武器/技能/熟练度/属性」——
   *    顶部那排来自 bagTabs()，两者别混。
   * ⚠️ body 仍然是**整页**——判定用的就是它（点 body 里 = 什么都不做，点外面 = 关掉）。
   */
  Game.prototype.weaponPageFrame = function () {
    var vp = this.viewport, ins = vp.insets || {}, y = this.bagTabs()[0].y + 40;
    var width = Math.min(700, vp.w - (ins.left || 0) - (ins.right || 0) - 32), x = (vp.w - width) / 2;
    var kinds = Object.keys(this.cfg.weapons), gap = 6, w = (width - gap * (kinds.length - 1)) / kinds.length;
    return {
      tabs: kinds.map(function (kind, i) {
        return { kind: kind, x: x + i * (w + gap), y: y, w: w, h: 27 };
      }),
      body: { x: x, y: y + 36, w: width, h: vp.h - (ins.bottom || 0) - y - 68 }
    };
  };

  /**
   * 武器库「技能」页：**2026-10 起只有一块** —— 这把武器的全部技能。
   * 熟练度奖励原来挤在这页下半块，现在独立成页（见 masteryPanelRects / drawMasteryPanel）；
   * 拆开的原因和口径见 bagTabs 那段注释。
   */
  Game.prototype.skillPanelRects = function () {
    var f = this.weaponPageFrame();
    return {
      tabs: f.tabs,
      body: f.body,
      /* 技能块 = 整个 body（一页一块，不再和熟练度分高度） */
      skills: { x: f.body.x, y: f.body.y, w: f.body.w, h: f.body.h }
    };
  };

  /**
   * 武器库「熟练度」页（熟练度奖励）：这一页只说一件事 —— **练这把武器，每级能拿到什么**。
   *   ① 顶部一行进度（drawMasteryBlock：当前点数 / 本级上限 + 进度条 + 下一级给什么）
   *   ② 下面 Lv1~LvN **一级一行**（drawCodexLevelRow：等级 + 门槛 + 这一级给什么）
   * ⚠️ 行数按 config.mastery.levels 的实际长度算（写死 4 行，改门槛表就会漏画一级）。
   * ⚠️ 内容一个字都不在这里拼：等级/门槛/奖励文案全来自 codexMasteryRows（再往上是 config.mastery）。
   */
  Game.prototype.masteryPanelRects = function () {
    var f = this.weaponPageFrame();
    var kind = this.skillViewKind || this.weaponKind();
    var rows = this.codexMasteryRows(kind).length || 1;
    /* head = 顶部那块进度占的高度（drawMasteryBlock 本体 26px + 上下留白）。
       ⚠️ 这块**必须实占高度**：2026-10 出图抓到过——把它压成 26 时，进度条的"下一级 Lv3：…"
          正好落在第一行 Lv1 的框线上（字压框，看着像画崩）。 */
    var head = 34, vgap = 8, list = { x: f.body.x, y: f.body.y + head, w: f.body.w, h: f.body.h - head };
    return {
      tabs: f.tabs,
      body: f.body,
      progress: { x: f.body.x, y: f.body.y, w: f.body.w, h: head },
      /* 每级一行：行高按实际行数分，一行都不许掉出 body */
      rows: rows,
      rowsGap: vgap,
      rowH: (list.h - vgap * (rows - 1)) / rows,
      list: list
    };
  };

  Game.prototype.openLevelUp = function () {
    var cfg = this.cfg;
    /* lastMechanic：上一排出现过机制卡 ⇒ 这一排机制卡权重被压低（config.growth.repeatMechWeight）。
       用户口径：机制卡"连着出来"看着不对 —— 实测确实是纯随机的必然结果（单排 49%），
       但代价卡有限流、机制卡没有，所以显得扎眼；这条只压"连着出"的密度，不改总量。 */
    this.cards = this.Prog.drawUpgrades(cfg, this.player.taken, cfg.growth.chooseFrom, {
      /* ⚠️ 武器技能卡**不再进升级池**（2026-10 用户口径："武器的技能别用卡片形式给，
         改成某个精英怪掉落，并且跟着武器走"）。allowSkill:false 就是这条开关 ——
         卡定义仍然留在 cfg.upgrades 里（技能页 / 属性页 / 试炼场试卡面板都要用它），
         只是升级永远不会抽到。想改回"抽卡给技能"就把这里换成
         `this.skillOfferAllowed(this.weaponKind())` 并恢复那个节奏函数（见 dropSkillScroll 的说明）。 */
      weapon: this.weaponKind(), allowSkill: false,
      lastMechanic: !!this.lastRowMechanic,
      /* 三选一里**至少一张成长卡**（长刃/巨刃/旋刃）——
         用户口径："就算拿满增加长度的卡，打完剑还是不够长"。配套改动：
         成长卡加了 stackable（一局可反复拿）+ 保底（每排至少一张），见 progression.drawUpgrades。 */
      guaranteeGrowth: true,
      /* 熟练度解锁的卡（叠刃，masteryMin:3 + onlyWeapon:'sword'）按**手上这把武器**的点数过滤。
         不传 = 按 0（Lv1）算，那张卡就永远抽不到 —— 而且不会报错，最难查的那一类。 */
      masteryPts: this.masteryOf()
    });
    /* ⚠️ 记的是**这一排出现过**机制卡（不是"玩家拿了"）—— 这才是玩家感知到的"连着出来"。 */
    this.lastRowMechanic = this.cards.some(function (u) { return this.Prog.isMechanic(u); }, this);
    this.state = 'levelup';
    this.cardGuard = 0.12;       // 见 update()：刚弹出的这 0.12 秒忽略点选
                                 // （够挡住"手指已经在落下、卡片正好弹出"这一瞬；
                                 //   再长就会吃掉真人看到卡之后的第一下点选）
    // 升级瞬间给一小段无敌：这是"变强了"最直接的体感，也让玩家有时间看卡片
    this.player.inv = Math.max(this.player.inv, 1.2);
    this.emit('levelup', { x: this.player.x, y: this.player.y, level: this.player.level });
    this.saveNow();
  };

  /** 升级卡的矩形（屏幕坐标）。渲染层和点击判定共用同一份布局 */
  Game.prototype.cardRects = function () {
    var n = this.cards.length, vw = this.viewport.w, vh = this.viewport.h;
    if (!n) return [];
    var gap = 14;
    var w = Math.min(210, (vw - gap * (n + 1)) / n);
    var h = Math.min(166, vh * 0.43);
    var totalW = w * n + gap * (n - 1);
    var x0 = (vw - totalW) / 2;
    var y0 = Math.max(((this.viewport.insets || {}).top || 0) + 44,
      Math.min((vh - h) / 2 + 20, this.rerollBtnRect().y - h - 12));
    var out = [];
    for (var i = 0; i < n; i++) out.push({ x: x0 + i * (w + gap), y: y0, w: w, h: h });
    return out;
  };

  Game.prototype.updateLevelUp = function (input) {
    if (!input.tap) return;
    if (this.cardGuard > 0) return;      // 刚弹出：还在护栏期（防误选）
    /* ⚠️ 2026-10 起不再需要"点在武器库按钮上的手不算选卡"那条排除：左下角的按钮已经删了
       （入口在「暂停 → 换武器」里），留着就是死分支。 */
    /* 重刷按钮也排除掉：点在按钮上的手不算选卡（按钮在卡片下面，正常够不着，
       但它比卡片先判 —— 万一以后布局变了一点都不会误选）。刷不了也照样 return，
       免得手指落在按钮上又"顺手选了最下面那张卡"。 */
    if (this.inRect(this.rerollBtnRect(), input.tap)) { this.doReroll(); return; }
    var rects = this.cardRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (input.tap.x >= r.x && input.tap.x <= r.x + r.w &&
          input.tap.y >= r.y && input.tap.y <= r.y + r.h) {
        var beforeEvo = this.player.evolutions || {};
        var kind = this.weaponKind(), selected = this.cards[i];
        this.Prog.applyUpgrade(this.cfg, this.player, this.cards[i].id);
        /* 限次爆发卡（开天）：登记状态，但**不立刻生效** —— 下次起转才算第一刀 */
        if (this.cards[i].burst) this.grantBurst(this.cards[i]);
        var names = { flame: '烈焰冲刺', storm: '旋刃风暴', quake: '重剑回响' };
        for (var key in names) if (!beforeEvo[key] && this.player.evolutions[key]) {
          this.parts.text(this.player.x, this.player.y - 85, '进化：' + names[key], '#ffd166');
          this.emit('levelup', { x: this.player.x, y: this.player.y });
        }
        this.parts.text(this.player.x, this.player.y - 52, this.cards[i].name + (this.cards[i].weapon ? '已获得' : ''), '#ffd166');
        this.player.pendingLevels--;
        if (this.player.pendingLevels > 0) this.openLevelUp();
        else { this.cards = []; this.state = 'play'; }
        this.saveNow();
        return;
      }
    }
  };

  /* ==================== 重刷升级卡（花金币） ====================
     2026-10 用户选**方案 2：不限次数 · 递增价**（原来是"每局第一次免费、之后每次 30、上限 3 次"）。
     口径：本局第 1 次免费，之后 30 → 60 → 90 → 120 …（见 config.growth.reroll 的说明）。
     为什么要有：卡池越来越大，玩家会遇到"这一排全是我不要的" —— 给一个用金币买"再来一次"的口子。

     形态：升级面板底部居中的一个按钮（和左下角武器库同一行）。**重刷 = 整排全换**，
     不锁卡（锁卡明显更强也更贵，先不做）。
     与选卡的关系：**点重刷不算选卡** —— pendingLevels 不变，卡只是换了一批。
     ⚠️ 两处细节：
       ① P.rerolls 是**每局**的计数（死亡重开清零），金币才是跨局累积的
       ② 重刷后给一次和"刚弹出"一样的 0.12s 护栏（怕同一只手连点，一下就刷掉两次）
   */

  /**
   * 第 n 次重刷（n 从 0 数）要多少金币：前 `free` 次免费，之后按 `cost + (n-free)*step` 递增。
   * ⚠️ 递增价是**方案 2** 的核心：金币跨局累积，固定价到后期 ≈ 白刷；递增才能自己收敛。
   *    改价只动 config.growth.reroll（cost / step / free / max 四个数），这里不用改。
   */
  Game.prototype.rerollCostAt = function (n) {
    var r = this.cfg.growth.reroll, free = r.free || 0;
    if (n < free) return 0;
    return r.cost + (n - free) * (r.step || 0);
  };

  /** 这一次重刷要多少金币（本局第 free 次之前免费） */
  Game.prototype.rerollCost = function () {
    return this.rerollCostAt(this.player.rerolls);
  };

  /** 下一次重刷的价格（面板副字显示「下次 60 金币」用，让玩家看见"越刷越贵"） */
  Game.prototype.rerollNextCost = function () {
    return this.rerollCostAt(this.player.rerolls + 1);
  };

  /** 本局还剩几次重刷。`max` ≤ 0 = **不限次数** → 返回 Infinity（判定只看 > 0，用不到具体的数） */
  Game.prototype.rerollLeft = function () {
    var max = this.cfg.growth.reroll.max;
    if (!max || max <= 0) return Infinity;
    return Math.max(0, max - this.player.rerolls);
  };

  Game.prototype.canReroll = function () {
    return this.rerollLeft() > 0 && this.player.gold >= this.rerollCost();
  };

  /** 重刷：扣钱 → 重抽这一排卡（taken 排除规则和金色卡概率照旧） */
  Game.prototype.doReroll = function () {
    if (!this.canReroll()) return false;
    var cfg = this.cfg, P = this.player, cost = this.rerollCost();
    if (cost > 0) P.gold -= cost;
    P.rerolls++;
    /* ⚠️ 参数必须和 openLevelUp **逐字对齐**（allowSkill:false + lastMechanic）：
       ① allowSkill 这里以前调的是已经删掉的 skillOfferAllowed() —— 2026-10 技能改成精英掉落时
          漏改了这一处，结果是**点刷新直接抛 TypeError**，整个 update 中断 → 升级面板卡死、
          刷新键完全没反应（真机报障："卡片点击刷新没有用，卡住了"）。
          修完顺手补一条断言（verify-card-reroll.js），这类"只有一条路径漏改"的洞只能靠测试兜。
       ② lastMechanic 不传的话，重刷出来的这一排会绕过机制卡限流（神不知鬼不觉地变随机）。 */
    this.cards = this.Prog.drawUpgrades(cfg, P.taken, cfg.growth.chooseFrom, {
      weapon: this.weaponKind(), allowSkill: false,
      lastMechanic: !!this.lastRowMechanic,
      guaranteeGrowth: true,                       // 和 openLevelUp 一致：重刷也要有成长卡保底
      /* 熟练度解锁的门槛卡（叠刃）也必须在重刷时按同一把尺子过滤 ——
         少这一条的话，未解锁的卡会从"重刷"这条路漏进来（和上面 ① 漏改 allowSkill
         是同一类洞：只有一条路径漏改，主线看起来完全正常）。 */
      masteryPts: this.masteryOf()
    });
    this.lastRowMechanic = this.cards.some(function (u) { return this.Prog.isMechanic(u); }, this);
    this.cardGuard = 0.12;                       // 见 update()：刚换过卡这一瞬忽略点选
    this.emit('reroll', { x: P.x, y: P.y, cost: cost });
    this.saveNow();                              // 金币花掉了，立刻落盘
    return true;
  };

  /** 重刷按钮（升级面板底部居中，和左下角武器库同一行）。渲染和判定共用 */
  Game.prototype.rerollBtnRect = function () {
    var vp = this.viewport, ins = vp.insets || {};
    var w = 168, h = 42;
    return { x: (vp.w - w) / 2, y: vp.h - 82 - (ins.bottom || 0), w: w, h: h };
  };

  /* ==================== 武器库（拿到多把武器之后随时切换） ====================
     2026-10 口径（用户："获得多把武器之后，让玩家可以随意切换武器吧"）：
     左下角一个按钮 → **暂停** + 弹出武器库一排卡片 → 点一张就换上并继续。
     为什么用"暂停式"而不是轮盘/滑动手势：换武器是决策，不是操作 ——
     暂停不会干扰战斗，也不用在打怪时精确点到小按钮（和升级卡、通关面板是同一套交互语言）。

     代价（不额外加冷却，用机制自带的）：
       **切换 = 当前这把立刻收刃 + 新武器从收刃状态重新起转**，空档 = 新武器自己的 rest。
       所以重武器（大剑/法杖，起刃慢）切上去要等更久，轻武器随时能接上 ——
       这既堵住了"战斗中无脑切最优解"，又不会让人不敢换。

     ⚠️ 两条护栏（和升级卡同一个理由，见 input.js 的 tap 两段判定）：
       ① bagGuard 0.12 秒：刚弹出/刚关掉的这一瞬忽略点选
       ② 升级卡弹出时**点在武器库按钮上的手不算选卡**（卡片最多 4 张时会压到这个角）
     ⚠️ 按钮和卡片的矩形都在这里算，渲染层和判定共用（cardRects 的老规矩）。
  */

  /**
   * 武器库入口要不要显示。**有一把就显示**（用户口径："就算一个武器也要显示"）——
   * 开局那把默认长剑也在库里（见 progression.makeDefaultWeapon），所以入口从第一秒就在，
   * 面板里那张卡会把"我现在拿的是什么、有什么词条"写清楚。
   * ⚠️ 判定和绘制必须用同一个函数（渲染层调的就是它）。
   */
  Game.prototype.canSwitchWeapon = function () {
    return ((this.player && this.player.bag) || []).length >= 1;
  };

  /** 武器库入口按钮（左下角，避开安全区）。只在 state==='play' 时可点 */
  Game.prototype.bagBtnRect = function () {
    /* ⚠️ 2026-10 已废弃：左下角的「武器库」按钮删掉了（入口在暂停面板的「换武器」行）。
       函数还留着是给**老测试/工具**用的兜底（返回 null 表示"没有这个按钮了"），
       新代码不要再调它 —— 更不要拿它当热区判定。 */
    return null;
  };

  /** 武器库卡片矩形（屏幕坐标）。渲染层和点击判定共用 */
  Game.prototype.bagRects = function () {
    var bag = (this.player && this.player.bag) || [], n = bag.length;
    if (!n) return [];
    var vw = this.viewport.w, vh = this.viewport.h, ins = this.viewport.insets || {};
    var available = vw - (ins.left || 0) - (ins.right || 0);
    var gap = 12;
    var w = Math.max(96, Math.min(168, (available - gap * (n + 1)) / n));
    var h = Math.max(150, Math.min(180, vh * 0.48));
    var totalW = w * n + gap * (n - 1);
    var x0 = (ins.left || 0) + (available - totalW) / 2, y0 = (vh - h) / 2 + 14;
    var out = [];
    for (var i = 0; i < n; i++) out.push({ x: x0 + i * (w + gap), y: y0, w: w, h: h });
    return out;
  };

  /**
   * 武器库面板顶部的页签（渲染和判定共用同一份矩形）。**2026-10 起四个**：
   *   武器 / 技能 / **熟练度（Lv1~LvN 每级给什么 = 熟练度奖励表）** / 属性。
   *
   * ⚠️ 熟练度**数据源一个字没改**（config.mastery → codexMasteryRows / masteryShortText），
   *    这里只换了它的"家"：原来说好并进技能页下半块，实际一页塞两块谁都放不开 ——
   *    技能卡只有 74px 高、熟练度格子被压成两行小字（用户 2026-10 口径："技能模块看着有点错乱"），
   *    拆成独立一页后两块各自拿到整页高度。
   * ⚠️ 宽度按**页签数**算 —— 原来写死 `w * 3 + gap * 2`，加第 4 个页签会把右边那个顶出屏幕
   *    （与 drawBagPanel 底部那排按钮同一个坑：别再写死个数）。
   */
  Game.prototype.bagTabs = function () {
    var vp = this.viewport, ins = vp.insets || {};
    var w = 108, h = 30, gap = 10;
    var rects = this.bagRects();
    /* 页签压在卡片上面一点：卡片位固定（bagRects 是按视口算的），页签跟着它走，
       这样两个页签之间切换时**下面的内容不会挪**（用户口径：布局确定性，别忽高忽低）。 */
    var y = rects.length ? Math.max((ins.top || 0) + 10, rects[0].y - 44) : vp.h / 2 - 70;
    var defs = [
      { id: 'weapon',  label: '武器' },
      { id: 'skills',  label: '技能' },
      { id: 'mastery', label: '熟练度' },
      { id: 'stats',   label: '属性' }
    ];
    var x0 = (vp.w - (w * defs.length + gap * (defs.length - 1))) / 2;
    return defs.map(function (d, i) {
      return { id: d.id, label: d.label, x: x0 + i * (w + gap), y: y, w: w, h: h };
    });
  };

  Game.prototype.openBag = function () {
    this.bagReturnState = this.state;
    this.state = 'bag';
    this.skillViewKind = this.weaponKind();
    this.bagTab = this.bagTab || 'weapon';      // 上次停在哪个页签就还在哪（不强制跳回武器页）
    this.bagGuard = 0.12;
    this.emit('openBag', { x: this.player.x, y: this.player.y });
    return true;
  };

  Game.prototype.closeBag = function () {
    /* ⚠️ 2026-10：从暂停面板开出来的武器库，关掉要**回暂停面板**（用户口径：
       「关掉武器库回到暂停面板」）—— 换完武器 / 只是看了看，都停在面板上，由玩家自己点「继续」。
       以前不管从哪儿开都直接回 play（换完武器立刻接着打，没个"我准备好了"的动作）。
       levelup 那条路照旧回选卡；其余（容错）回 play。
       ⚠️ 顺手立 pauseGuard：否则"点空白关掉武器库"那一下手指会被暂停面板当成一次点击。 */
    this.state = this.bagReturnState === 'levelup' ? 'levelup'
               : (this.bagReturnState === 'paused' ? 'paused' : 'play');
    this.bagGuard = 0.12;
    if (this.state === 'paused') this.pauseGuard = 0.12;
    return true;
  };

  /**
   * 换上武器库里第 idx 把。返回是否真的换了。
   * 切换的代价见这一段开头的注释；这里顺手把"这把武器自己的状态"也归零
   * （连击层数是双刀攒的，换武器当然要清）。
   */
  Game.prototype.switchWeapon = function (idx) {
    var P = this.player, cfg = this.cfg, bag = (P && P.bag) || [];
    var it = bag[idx];
    if (!it || !cfg.weapons[it.kind]) return false;
    if (P.equip.weapon === it) return false;              // 点的就是当前这把
    P.equip.weapon = it;
    this.Prog.recompute(P, cfg);
    var op = this.orbitParams();
    P.orbOn = false;                                     // 收刃
    P.orbT = Math.max(0.25, op.rest);                    // 新武器自己起刃要多久（重武器更久）
    P.orbTotal = P.orbT;                                 // 充能环的分母（这一段也是"收刃期"，环照常填）
    P.orbAng = P.face; P.orbPrev = P.face; P.orbAng0 = P.face;
    P.orbPass = 0; P.orbRev = 0; P.orbCastT = 0; P.orbSwingT = 0;
    P.comboStacks = 0; P.comboTimer = 0;
    this.emit('equip', { x: P.x, y: P.y });
    this.saveNow();
    return true;
  };

  Game.prototype.updateBag = function (input) {
    if (!input.tap) return;
    if (this.bagGuard > 0) return;                       // 刚弹出/刚关掉：还在护栏期
    /* 页签先判：切页也要上护栏 —— 页签就在卡片上方，
       点完页签这一瞬下面正好是卡片/属性行，同一下手指不能再触发别的动作。 */
    var tabs = this.bagTabs();
    for (var t = 0; t < tabs.length; t++) {
      if (this.inRect(tabs[t], input.tap)) {
        if (this.bagTab !== tabs[t].id) { this.bagTab = tabs[t].id; this.bagGuard = 0.12; }
        return;
      }
    }
    /* 技能页 / 熟练度页共用一套判定（两页的页签和 body 来自同一个 weaponPageFrame）：
       点页内那排武器页签 = 换看哪把武器；点 body 里 = 什么都不做；点 body 外 = 关掉。 */
    if (this.bagTab === 'skills' || this.bagTab === 'mastery') {
      var frame = this.weaponPageFrame();
      for (var k = 0; k < frame.tabs.length; k++) if (this.inRect(frame.tabs[k], input.tap)) {
        this.skillViewKind = frame.tabs[k].kind; return;
      }
      if (this.inRect(frame.body, input.tap)) return;
      this.closeBag(); return;
    }
    if (this.bagTab !== 'weapon') { this.closeBag(); return; }   // 属性页：点空白处关掉
    var rects = this.bagRects();
    for (var i = 0; i < rects.length; i++) {
      if (this.inRect(rects[i], input.tap)) {
        this.switchWeapon(i);                            // 点当前那把时它自己会 return false，等于只关面板
        return this.closeBag();
      }
    }
    this.closeBag();                                     // 点面板外 → 关掉（不换）
  };

  /* ==================== 刷怪 ==================== */

  /**
   * 当前**这一波**能出哪些怪 = 关卡池 + 关内分波换池（theme）。
   * theme: ['A','A','B','mix'] → A 波只出主怪、B 波只出副怪、mix 波用整池权重。
   * 这样一关之内就有三段不同的节奏（认新怪 → 换口味 → 混编），
   * 而**出场密度/总量完全不变** —— 只是换"谁出场"，所以不会顺带改难度。
   */
  Game.prototype.typesForWave = function (wave) {
    var st = this.World.stageOf && this.World.stageOf(this.cfg, this.stage);
    var pool = (st && st.pool) || { slime: 1 };
    if (!st || !st.theme || !st.main) return pool;
    var w = Math.max(1, Math.floor(wave || this.wave));
    var tag = st.theme[Math.min(st.theme.length - 1, w - 1)];
    var only = tag === 'A' ? st.main : (tag === 'B' ? st.second : null);
    if (!only || !pool[only]) return pool;
    var one = {};
    one[only] = 1;
    return one;
  };

  /**
   * 挑一个敌人种类。
   * 新解锁的种类**第一次出现时必定被选中** —— 否则"新敌人登场"全靠运气，
   * 玩家可能整局都遇不到铁角，围绕它做的蓄力预警/走位机制就白做了。
   * swarmSafe：敌群生成时传 true —— **免疫怪不进敌群**（20 只围着你、里面还混着打不死的，那是耍赖）。
   */
  Game.prototype.pickType = function (wave, swarmSafe) {
    var types = this.typesForWave(wave), keys = [], weights = [], total = 0;
    var counts = this.stageTypeCount || (this.stageTypeCount = {});
    for (var k in types) {
      var t = this.cfg.enemyTypes[k] || {};
      if (swarmSafe && t.shell) continue;                                  // 免疫怪不进敌群
      if (t.maxPerStage && (counts[k] || 0) >= t.maxPerStage) continue;    // 每关限量（甲壳兽）
      keys.push(k); weights.push(types[k]); total += types[k];
    }
    if (!keys.length) return 'slime';       // 兜底：全都限满了也不能返回 undefined（makeFoe 会崩）
    for (var j = 0; j < keys.length; j++) {
      if (!this.seenTypes[keys[j]]) {
        this.seenTypes[keys[j]] = 1;
        counts[keys[j]] = (counts[keys[j]] || 0) + 1;
        return keys[j];
      }
    }
    var r = Math.random() * total;
    for (var i = 0; i < keys.length; i++) {
      r -= weights[i];
      if (r <= 0) { counts[keys[i]] = (counts[keys[i]] || 0) + 1; return keys[i]; }
    }
    var last = keys[keys.length - 1];
    counts[last] = (counts[last] || 0) + 1;
    return last;
  };

  /* ==================== 敌群（包围事件） ==================== */

  /** 这一关的敌圈大小：第 1 关 = 0（不触发），之后逐关变大（见 config.swarm 注释） */
  Game.prototype.swarmSize = function () {
    var sw = this.cfg.swarm, arr = sw.countByStage;
    if (arr && arr.length) {
      var i = Math.min(arr.length - 1, Math.max(0, this.stage - 1));
      return arr[i] || 0;
    }
    return sw.count || 0;
  };

  /** 到点就来一次：但 Boss 波没结束 / 入口已开时不叠加（否则变成不公平的围杀） */
  Game.prototype.checkSwarm = function () {
    if (this.cfg.trial.enabled) return;
    var sw = this.cfg.swarm;
    if (this.swarmWarn || this.harvestMode()) return;
    if (this.stage < (sw.minStage || 1)) return;     // 第 1 关（教学关）不来：玩家还没卡就被围两轮 = 过不去
    if (this.stageKills < this.swarmAt) return;
    if (this.stageBossPending || this.clearT > 0) return;
    this.swarmAt = Math.floor(this.stageKills / sw.everyKills + 1) * sw.everyKills;
    this.startSwarm();
  };

  Game.prototype.startSwarm = function () {
    var sw = this.cfg.swarm, P = this.player;
    var n = this.swarmSize();
    if (!n) return;                                  // 这一关不触发（第 1 关）
    var rx = this.viewport.w * sw.rx, ry = this.viewport.h * sw.ry;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = i * Math.PI * 2 / n + Math.random() * 0.15;
      var x = Math.max(70, Math.min(this.world.w - 70, P.x + Math.cos(a) * rx));
      var y = Math.max(70, Math.min(this.world.h - 70, P.y + Math.sin(a) * ry));
      pts.push({ x: x, y: y });           // 环的位置**锁定**在触发那一刻：
    }                                     // 玩家在预警时间里跑开，圈就偏了 —— 这是留给玩家的应对
    this.swarmWarn = { t: sw.warn, total: sw.warn, pts: pts, rx: rx, ry: ry };
    this.swarmCount++;
    this.emit('swarmWarn', { count: n });
  };

  Game.prototype.updateSwarm = function (dt) {
    if (!this.swarmWarn) return;
    if (this.stageBossPending || this.clearT > 0) { this.swarmWarn = null; return; }
    // 不把高压包围叠到狂热奖励怪潮上；保留预警，之后再落地。
    if (this.harvestMode()) return;
    this.swarmWarn.t -= dt;
    if (this.swarmWarn.t > 0) return;

    var cfg = this.cfg, sw = cfg.swarm, warn = this.swarmWarn;
    this.swarmWarn = null;
    var spawned = 0;
    for (var i = 0; i < warn.pts.length && this.foes.length < this.enemyCap() - 1; i++) {
      var p = warn.pts[i];
      // 敌群里**不掺免疫怪**（swarmSafe=true）—— 被 20 只围着还混着打不死的，那是耍赖
      var f = this.Entities.makeFoe(cfg, this.pickType(this.wave, true), p.x, p.y, this.wave, this.stageDiff(), null);
      f.hp *= sw.hpMul; f.maxhp *= sw.hpMul;          // 略硬
      f.hp = Math.round(f.hp); f.maxhp = Math.round(f.maxhp);
      var floor = cfg.player.base.spd * (sw.minSpdRatio || 0);
      f.spd = Math.max(f.spd * sw.spdMul, floor);       // 倍率收敛上限 + 速度下限保底
      f.spd0 = f.spd;                                   // （见 config.swarm 注释：不然各关差天远）
      f.xp = Math.round(f.xp * sw.xpMul);              // 削掉落：压力事件，不是补给
      f.gold = Math.round(f.gold * sw.goldMul);
      f.swarm = true;
      this.world.collide(f);                            // 落点可能在墙里 → 推出来
      this.foes.push(f); spawned++;                     // 与普通怪共享预算
    }
    if (spawned) this.emit('swarm', { count: spawned });
  };

  Game.prototype.harvestMode = function () {
    var P = this.player, threshold = P.evolutions && P.evolutions.storm ? 18 : 25;
    return P.frenzy > 0 || (P.frenzyCharge || 0) >= threshold - this.cfg.harvest.prepareKills;
  };

  Game.prototype.enemyCap = function () {
    if (this.cfg.trial.enabled) return this.trial && this.trial.tide && this.trial.tide.phase==='active' ? this.cfg.tide.cap : this.cfg.waves.cap;
    return this.harvestMode() && !this.stageBossPending ? this.cfg.harvest.cap : this.cfg.waves.cap;
  };

  // 在当前视野外沿选点，地图边缘只使用仍在地图内的那几侧；不钳制到玩家脸上。
  Game.prototype.harvestPoint = function () {
    var P = this.player, vw = this.viewport.w, vh = this.viewport.h;
    var left = Math.max(0, Math.min(this.world.w - vw, P.x - vw / 2));
    var top = Math.max(0, Math.min(this.world.h - vh, P.y - vh / 2));
    for (var i = 0; i < 16; i++) {
      var side = Math.floor(Math.random() * 4), offset = 38;
      var x = side < 2 ? left + (side ? vw + offset : -offset) : left + Math.random() * vw;
      var y = side >= 2 ? top + (side === 3 ? vh + offset : -offset) : top + Math.random() * vh;
      if (x < 40 || y < 40 || x > this.world.w - 40 || y > this.world.h - 40) continue;
      var p = { x: x, y: y, r: 15 };
      this.world.collide(p);
      if (Math.hypot(p.x - P.x, p.y - P.y) < 150) continue;
      if (p.x > left - 25 && p.x < left + vw + 25 && p.y > top - 25 && p.y < top + vh + 25) continue;
      return p;
    }
    return null;
  };

  Game.prototype.updateHarvest = function (dt) {
    if (this.cfg.trial.enabled) return;
    var P = this.player, H = this.cfg.harvest;
    if (this.stageBossPending || this.bossAlive || this.clearT > 0 || this.training) return;
    if (!this.harvestMode()) {
      this.harvestAnnounced = false; this.harvestWarn = 0;
      this.harvestPrep = 0; this.harvestActive = 0; this.harvestSpawnT = 0;
      return;
    }
    if (!this.harvestAnnounced) {
      this.harvestAnnounced = true; this.harvestWarn = H.warning;
      this.parts.text(P.x, P.y - 82, '收割怪潮将至！', '#ffd166');
      this.emit('harvestWarn', { x: P.x, y: P.y });
    }
    if (this.harvestWarn > 0) { this.harvestWarn = Math.max(0, this.harvestWarn - dt); return; }
    this.harvestSpawnT -= dt;
    if (this.harvestSpawnT > 0) return;
    this.harvestSpawnT = H.interval;
    var active = P.frenzy > 0, key = active ? 'harvestActive' : 'harvestPrep';
    var budget = active ? H.activeBudget : H.prepBudget;
    for (var i = 0; i < H.group && this[key] < budget && this.foes.length < this.enemyCap() - 1; i++) {
      var p = this.harvestPoint();
      if (!p) break;
      var f = this.Entities.makeFoe(this.cfg, 'slime', p.x, p.y, this.wave, this.stageDiff(), null);
      f.hp *= H.hpMul; f.maxhp = f.hp; f.dmg *= H.damageMul;
      f.spd = H.speed[0] + Math.random() * (H.speed[1] - H.speed[0]); f.spd0 = f.spd;
      f.xp = Math.max(1, Math.round(f.xp * H.xpMul)); f.gold = 1;
      f.harvest = true;
      this.foes.push(f); this[key]++;
    }
  };

  Game.prototype.updateSpawns = function (dt) {
    if (this.cfg.trial.enabled) return this.updateTrialSpawns(dt);
    var cfg = this.cfg;

    // 本关最后一波：出关底 Boss。打倒它 = 直接过关
    if (this.wave >= cfg.stage.wavesPerStage && this.bossSpawnedForStage !== this.stage && this.clearT <= 0 &&
        this.stageT >= cfg.harvest.minBossSeconds && !(this.player.frenzy > 0)) {
      this.bossSpawnedForStage = this.stage;
      this.spawnBoss();
      return;
    }
    if (this.clearT > 0) return;    // 已击杀 Boss、正在过关延迟：场子安静下来

    /* Boss 战期间**停止普通刷怪**（场上已有的留着，变成 Boss 的杂兵）。
       真机反馈"第一关过不去、无限出怪"就是这个：原来 Boss 活着就一直刷到同屏上限。
       实测（tools/balance.js --trace）：Boss 在场的 20 秒里同屏钉死 27 只，
       玩家杀了 58 只小怪还没打完 880 血的 Boss —— 那不是 Boss 战，是无限磨血。 */
    if (this.stageBossPending || this.bossAlive > 0) return;

    this.spawnT -= dt;
    var W = cfg.waves;
    this.updateHarvest(dt);
    var cap = Math.min(this.enemyCap() - 1, W.capBase + this.wave * W.capPerWave);
    // 狂热新增预算只供应薄血杂兵，不提高精英/远程怪数量。
    if (this.spawnT <= 0 && this.foes.length < cap) {
      // 成组刷：一次 2~3 只。原来是"一只一只挤牙膏"，屏幕上永远稀稀拉拉
      var grp = W.spawnGroup[0] + Math.floor(Math.random() * (W.spawnGroup[1] - W.spawnGroup[0] + 1));
      for (var si = 0; si < grp && this.foes.length < cap; si++) this.spawnFoe();
      this.spawnT = Math.max(W.interval[1], W.interval[0] - this.wave * W.rampPerWave);
    }
  };

  /** 出 Boss：**每关一只专属 Boss**（`bossOrder` 按关卡循环，第 5 关之后从头）。
      原来是两只交替 + 第 2 只起双 Boss 同场 —— 现在五关五只，双 Boss 就没必要了
      （双 Boss 是"只有两只"时的凑数做法，而且两只同场会把血量摊薄、手感变差）。 */
  Game.prototype.spawnBoss = function () {
    var cfg = this.cfg, order = cfg.bossOrder;
    var id = order[(this.stage - 1) % order.length];
    this.bossCount++;
    this.pushBoss(id, 1);
  };

  Game.prototype.pushBoss = function (kind, hpMul) {
    var cfg = this.cfg, P = this.player;
    var b = this.Entities.makeBoss(cfg, P.x + 460, P.y - 300, this.stage, kind, hpMul);
    this.world.collide(b);      // 别把 Boss 生成在墙里
    this.world.collide(b);
    this.foes.push(b);
    this.bossAlive = (this.bossAlive || 0) + 1;
    this.stageBossPending = true;      // 本关 Boss 已出场，全部清掉才开入口
    this.emit('boss', { x: b.x, y: b.y, bossType: kind });
  };

  /**
   * 这一关的 Boss 该给哪把武器（2026-10 口径）：
   *   1) 前四关每关一把（`cfg.items.stageWeapons` 按关卡取：第 N 关第 N 把）
   *   2) **优先给这一轮还没给过的** —— 本关这把要是之前给过了（上局已经拿在手上、
   *      或武器表短于关卡数），就改从"还没给过的"里随机，保证一轮把这四把都见一遍
   *   3) **第 5 关起返回 null**：四把都给完了，不再发武器 → Boss 必掉的那件改成装备，
   *      品质按 lateReward 加成（"越往后打越强"落在装备上，而不是硬塞第五把武器）
   * 长剑是开局默认武器，不在这张表里（它不该当奖励发）。
   */
  Game.prototype.rollStageWeapon = function () {
    /* 试玩版（单关）**不再从这里发武器**（2026-10 改，配合用户口径"满级解锁双刀"）：
       原来这一条是 `1/3 几率返回手上那把` —— 掉出来的其实是**重复武器**，没意义；
       而且首页「开局武器」面板上写的是"双刀 = 第 N 关 Boss 掉落"（面板按多关版算的），
       实际走的是这条分支 → 面板和实际对不上。
       现在试玩版的武器奖励统一走熟练度：长剑满级 → 打完 Boss 有几率掉双刀，
       见 `grantMasteryWeaponReward`（在 stageClear 里、熟练度入账**之后**调用）。
       这里返回 null = "这件必掉的落到装备上"，下面的调用方本来就是这么处理的。 */
    if (this.cfg.trial.enabled) return null;
    var cfg = this.cfg, list = cfg.items.stageWeapons || [];
    if (!list.length) return null;
    if (this.stage > list.length) return null;        // 第 5 关起：武器已经给全了
    if (!this.weaponGifted) this.weaponGifted = {};
    var want = list[(this.stage - 1) % list.length];
    if (this.weaponGifted[want]) {
      var fresh = [];
      for (var i = 0; i < list.length; i++) if (!this.weaponGifted[list[i]]) fresh.push(list[i]);
      if (fresh.length) want = fresh[Math.floor(Math.random() * fresh.length)];
    }
    this.weaponGifted[want] = true;
    return want;
  };

  /**
   * 第 5 关起（四把可掉武器都给完了）的奖励加成：Boss 必掉的那件从武器改成装备，
   * 并且整批掉落带品质加成 —— 稀有度 +k 档、词条 ×(1+0.15k)、金币 ×(1+0.30k)。
   * k = 超出的关数（第 5 关 → 1）。数值与理由见 config.items.lateReward。
   */
  Game.prototype.lateReward = function () {
    var L = this.cfg.items.lateReward;
    var k = Math.max(0, this.stage - ((this.cfg.items.stageWeapons || []).length));
    if (!L || k <= 0) return { k: 0, rarityBonus: 0, affixMul: 1, goldMul: 1 };
    return {
      k: k,
      rarityBonus: Math.min(L.rarityBonusMax, k * L.rarityBonusPer),
      affixMul: Math.min(L.affixMax, 1 + L.affixPerStage * k),
      goldMul: Math.min(L.goldMax, 1 + L.goldPerStage * k)
    };
  };

  /** 本关难度倍率（关卡表里配的 diff，越往后越硬） */
  Game.prototype.stageDiff = function () {
    var st = this.World.stageOf && this.World.stageOf(this.cfg, this.stage);
    return (st && st.diff) || 1;
  };

  /** 精英词缀：概率随关卡推进上升（C2） */
  Game.prototype.rollAffix = function () {
    var A = this.cfg.affixes;
    if (!A || !A.list || !A.list.length) return null;
    var chance = Math.min(A.chanceMax, A.chanceBase + A.chancePerStage * (this.stage - 1));
    if (Math.random() >= chance) return null;
    return A.list[Math.floor(Math.random() * A.list.length)];
  };

  Game.prototype.spawnFoe = function () {
    if (this.cfg.trial.enabled && !this.training) return;
    var cfg = this.cfg, P = this.player;
    if (!this.training && this.foes.length >= this.enemyCap() - 1) return;
    var a = Math.random() * 6.28;
    var d = cfg.waves.dist[0] + Math.random() * (cfg.waves.dist[1] - cfg.waves.dist[0]);
    var x = P.x + Math.cos(a) * d, y = P.y + Math.sin(a) * d;
    x = Math.max(60, Math.min(this.world.w - 60, x));
    y = Math.max(60, Math.min(this.world.h - 60, y));
    var affix = this.rollAffix();
    var foe = this.Entities.makeFoe(cfg, this.pickType(this.wave), x, y, this.wave, this.stageDiff(), affix);
    this.world.collide(foe);      // 有墙之后，生成点可能落在墙里 → 推出来，否则怪会卡死在墙里
    this.foes.push(foe);
    // 成群：身边再带几只同类的普通个体（它们不带词缀，免得雪崩）
    if (affix && affix.id === 'swarm') {
      for (var i = 0; i < affix.extra && this.foes.length < this.enemyCap() - 1; i++) {
        var ax = x + (Math.random() * 2 - 1) * 90, ay = y + (Math.random() * 2 - 1) * 90;
        var m = this.Entities.makeFoe(cfg, foe.type, ax, ay, this.wave, this.stageDiff(), null);
        this.world.collide(m);
        this.foes.push(m);
      }
    }
  };

  /* ==================== 敌人 ==================== */

  Game.prototype.updateFoes = function (dt) {
    var cfg = this.cfg, P = this.player;
    var crowd=Object.create(null),cell=64;
    for(var ci=0;ci<this.foes.length;ci++){var cf=this.foes[ci],key=Math.floor(cf.x/cell)+','+Math.floor(cf.y/cell);(crowd[key]||(crowd[key]=[])).push(cf);}

    for (var i = this.foes.length - 1; i >= 0; i--) {
      var f = this.foes[i];
      // ⚠️ 本帧的循环里可能会移除敌人（反伤/溅射一次打死好几只）→ 索引短暂越界。
      //    不容忍 undefined 的话真机上会直接崩：Cannot read property 'hurt' of undefined
      if (!f) continue;
      if(f.arrival&&(f.arrival.elapsed<f.arrival.total||f.arrival.grace>0))continue;
      f.hurt = Math.max(0, f.hurt - dt);
      f.ph += dt * 3;
      if (f.blockT > 0) f.blockT = Math.max(0, f.blockT - dt);
      if (f.orbCd > 0) f.orbCd = Math.max(0, f.orbCd - dt);   // 旋刃命中冷却（undefined 不进这个分支）
      /* 甲壳兽的壳：合壳 closed 秒 → 开壳 open 秒，循环往复。
         只有开壳窗口吃武器伤害（免疫门在 damageFoe）；合壳的最后 tell 秒甲片开始抖，
         渲染层靠 shellT 画这个"要开了"的预告 —— 没有预告就是在赌命。 */
      if (f.shell) {
        f.shellT += dt;
        if (!f.shellOpen && f.shellT >= f.shell.closed) {
          f.shellOpen = true; f.shellT = 0;
          this.emit('shellOpen', { x: f.x, y: f.y });
        } else if (f.shellOpen && f.shellT >= f.shell.open) {
          f.shellOpen = false; f.shellT = 0;
        }
      }
      /* 上一帧的实际位移 → 这一帧的移动方向。渲染层靠它做"朝运动方向倾斜/挤压"，
         让怪看起来是"在走"而不是"贴图在飘"。纯视觉量，不参与任何碰撞/伤害计算。 */
      if (f.px !== undefined) { f.vx = (f.x - f.px) / dt; f.vy = (f.y - f.py) / dt; }
      f.px = f.x; f.py = f.y;
      // 狂暴词缀：残血时加速（用基础速度重算，避免叠加乘爆）
      if (f.affix && f.affix.id === 'rage' && f.spd0) {
        f.spd = f.spd0 * (f.hp < f.maxhp * 0.4 ? f.affix.spdMul : 1);
      }

      var dx = P.x - f.x, dy = P.y - f.y, d = Math.hypot(dx, dy) || 1;
      f.aimX = dx / d; f.aimY = dy / d;      // 朝玩家的方向（投手的眼睛/背囊用它）
      var move = 1;
      if(f.tideFoe){
        // Finish the rush before contact; no sudden speed boost next to the player.
        if(d<210)f.rushDone=true;
        f.spd=f.rushDone?f.spd0:f.spd0*1.7;
      }

      if (f.kind === 'boss') {
        move = this.updateBoss(dt, f, dx, dy, d);
      } else if (cfg.enemyTypes[f.type] && cfg.enemyTypes[f.type].charge) {
        move = this.updateCharger(dt, f, dx, dy, d);
      } else if (f.type==='spitter') {
        move=this.updateSpitter(dt,f,d);
      } else if (f.ranged) {
        // 远程：保持距离，太近就后退，进入射程就开火
        var keep = f.ranged.keepDist;
        move = (d < keep * 0.7) ? -1 : (d > keep * 1.25 ? 1 : 0);
        f.shootT -= dt;
        if (f.shootT <= 0 && d < f.ranged.range) {
          f.shootT = f.ranged.cooldown;
          this.projectiles.push(this.Entities.makeProjectile(
            f.x, f.y, Math.atan2(dy, dx), f.ranged.speed, f.ranged.damage, f.ranged.r, '#c9a2ff'));
          this.emit('shoot', { x: f.x, y: f.y });
        }
      }

      var px = f.x, py = f.y;
      if (move) {
        f.x += dx / d * f.spd * move * dt;
        f.y += dy / d * f.spd * move * dt;
      }

      if(f.kind!=='boss'&&!f.charging&&Math.hypot(f.kb.x,f.kb.y)<60){
        var cx=Math.floor(f.x/cell),cy=Math.floor(f.y/cell),sx=0,sy=0;
        for(var gx=-1;gx<=1;gx++)for(var gy=-1;gy<=1;gy++){
          var neighbors=crowd[(cx+gx)+','+(cy+gy)]||[];
          for(var ni=0;ni<neighbors.length;ni++){var other=neighbors[ni];if(other===f)continue;
            var nx=f.x-other.x,ny=f.y-other.y,nd=Math.hypot(nx,ny),space=(f.r+other.r)*.88;
            if(nd<space){if(nd<.01){nx=i%2?1:-1;ny=.5;nd=Math.hypot(nx,ny);}var push=(space-nd)/space;sx+=nx/nd*push;sy+=ny/nd*push;}
          }
        }
        var sm=Math.hypot(sx,sy);if(sm>0){var distance=Math.min(1,sm)*24*dt;f.x+=sx/sm*distance;f.y+=sy/sm*distance;}
      }
      f.x += f.kb.x * dt; f.y += f.kb.y * dt;
      f.kb.x *= 0.86; f.kb.y *= 0.86;
      var bx = f.x, by = f.y;                    // collide 之前的位置
      this.world.collide(f);
      // 被 collide 推出来多少 —— 这才是"撞墙了"的精确信号。
      // 别用"这一帧没怎么动"来判断：被击退 + 追人相互抵消时位移也很小，
      // 会把"被双刀打退的怪"误判成撞墙，于是它掉头去缺口、越走越远（实测距离 30→154）。
      var pushedOut = Math.hypot(f.x - bx, f.y - by);

      /* 「有没有在靠近玩家」—— 这才是"撞墙/走不通"的正确判据。
         ⚠️ 原来用 collide 的推出量（pushedOut > 0.5）判，会漏掉"贴着墙滑行"：
         怪已经在墙外，每帧几乎推不出来 → 判定不成立 → 它顺着墙一直蹭。
         实测（玩家站桩 60 秒）：史莱姆 31.3% 的帧在磨墙，而"改道缺口"只触发 3.2%，
         玩家看到的就是"不追我、在旁边乱跑"。 */
      /* 「走不动」= ①自走位移被吃掉（正面撞墙）或 ②在动但方向完全偏离玩家（贴墙斜着滑行）。
         两个都要：贴墙斜滑时它"速度正常"，但方向早就不是玩家了 —— 玩家看到的正是这种"乱跑"。
         ⚠️ 位移必须减掉击退分量：否则被双刀打退的怪会被当成"撞墙" → 扭头奔缺口走人
         （调试实测：距离 30→171 一路变远，连击因此断掉）。 */
      var selfX = (f.x - px) - f.kb.x * dt, selfY = (f.y - py) - f.kb.y * dt;
      var selfMag = Math.hypot(selfX, selfY);
      var toPx = P.x - px, toPy = P.y - py, toPl = Math.hypot(toPx, toPy) || 1;
      var closing = (selfX * toPx + selfY * toPy) / toPl;
      var step = f.spd * dt;
      if (move > 0 && toPl > 50 && (selfMag < step * 0.55 || closing < step * 0.25)) {
        f.noProg = (f.noProg || 0) + dt;
      } else {
        f.noProg = 0;
      }

      /* 撞墙就改道去最近的缺口。
         地形化（墙 + 缺口）之后必须补这一步：怪不会绕路，直线追人就会顶着墙站着不动，
         玩家往墙后一躲就成了"安全口袋"—— 等于给玩家加掩体，和加地形的初衷正好相反。

         试过两种"纯局部避障"（每帧挑离玩家更近的一侧 / 扇形探路）都不行：
         玩家正好在正前方时左右完全对称，怪会来回横跳、原地磨（实测 6 秒只挪 23px）。
         有目标就不一样了 —— 缺口是墙上的"门"，怪奔门去，过门之后自然就直奔玩家。
         顺带带来一个想要的效果：怪会从缺口成串地涌进来，缺口变成真正的瓶颈。 */
      if (move > 0) {
        var blocked = (f.noProg || 0) > 0.30 || pushedOut > 2.5;   // 走不动，或正面撞实了
        if (blocked && !f.gapTo) f.noProg = 0;
        // 撞墙了（被墙/石头推出来）→ 选最近的缺口当路标
        if(blocked&&!f.gapTo&&this.cfg.trial.enabled){
          var nearest=null,nearDist=Infinity;
          for(var ri=0;ri<this.world.rocks.length;ri++){var rock=this.world.rocks[ri],rd=Math.hypot(px-rock.x,py-rock.y);if(rd<rock.r+f.r+22&&rd<nearDist){nearest=rock;nearDist=rd;}}
          if(nearest){var ra=Math.atan2(py-nearest.y,px-nearest.x),turn=f.avoidSide||(f.avoidSide=(i%2?1:-1));
            ra+=turn*1.25;var rr=nearest.r+f.r+35;
            f.gapTo={x:nearest.x+Math.cos(ra)*rr,y:nearest.y+Math.sin(ra)*rr};f.gapT=2;
          }
        }
        if (blocked && !f.gapTo) {
          var gp = this.world.nearestGap(px, py);
          if (gp) {
            // 目标不是缺口本身，而是"穿过缺口后、朝玩家那侧 70px"的点：
            // 只盯缺口会在门口提前解除改道，然后在墙的圆头端上磨（实测卡在门口 37px 处）
            var pdx = P.x - gp.x, pdy = P.y - gp.y, pd = Math.hypot(pdx, pdy) || 1;
            f.gapTo = { x: gp.x + pdx / pd * 70, y: gp.y + pdy / pd * 70 };
            f.gapT = 6;
          }
        }
        if (f.gapTo) {
          f.gapT -= dt;
          var gdx = f.gapTo.x - px, gdy = f.gapTo.y - py;
          var gd = Math.hypot(gdx, gdy) || 1;
          if (gd < 35 || f.gapT <= 0) {
            f.gapTo = null;                     // 已经穿过去（或绕太久放弃）→ 恢复直奔玩家
            f.noProg = 0;
          } else {
            f.x = px + gdx / gd * f.spd * dt;
            f.y = py + gdy / gd * f.spd * dt;
            this.world.collide(f);
          }
        }
      } else {
        f.gapTo = null;
      }

      // 接触伤害（铁角冲刺中撞到人，伤害翻倍）
      var contact = f.dmg;
      if (contact > 0 && f.charging > 0) {
        contact *= cfg.enemyTypes.charger.charge.damageMul;
      }
      if (contact > 0 && d < f.r + P.r + 3) this.hurtPlayer(contact, f.x, f.y, f);
    }
  };

  /** Boss 行为分派：两种 Boss 机制完全不同 */
  Game.prototype.updateBoss = function (dt, b, dx, dy, d) {
    /* 新形态是有朝向的（蝎子的双钳和头、鹿的角），所以 Boss 必须朝向玩家 ——
       原来都是"圆球 + 一圈尖刺"，看不出朝向，也就一直没设过 face。 */
    b.face = Math.atan2(dy, dx);
    if (b.bossType === 'golem') return this.updateBossGolem(dt, b, dx, dy, d);
    if (b.bossType === 'frost') return this.updateBossFrost(dt, b, dx, dy, d);
    if (b.bossType === 'magma') return this.updateBossMagma(dt, b, dx, dy, d);
    if (b.bossType === 'eye')   return this.updateBossEye(dt, b, dx, dy, d);
    return this.updateBossWarden(dt, b, dx, dy, d);
  };

  /* ==================== 三只新 Boss 的机制（2026-10） ====================
     设计口径（写在前面，以后别再改成"只会掉血放弹"的 Boss）：
       · 每只只做**一件主打的事**，但要把这件事做绝：巨像封地面、巨兽拉近身、眼球逼你变位
       · 动作**先给预警**（抬手/变亮/收拢），预警就是玩家的输出窗口 —— 这是"能读懂"的关键
       · 地面区（裂痕/火痕/岩浆池）统一走 hazards，用 active + hold 表示"预警 → 持续伤害" */

  /** 碎石巨像：抬手（预警）→ 三条放射裂痕封锁地面；平时抖扇形碎石 */
  Game.prototype.updateBossGolem = function (dt, b, dx, dy, d) {
    var cfg = this.cfg, B = cfg.bossTypes.golem;

    if (b.cast) {                                   // 抬手期间钉住不动（这就是输出窗口）
      b.castT -= dt;
      if (b.castT <= 0) {
        b.cast = null;
        var a0 = Math.atan2(dy, dx), n = B.slam.count, sp = B.slam.spread;
        for (var i = 0; i < n; i++) {
          var a = a0 + (i - (n - 1) / 2) * sp;
          this.hazards.push({
            kind: 'crack', x: b.x, y: b.y,
            x2: b.x + Math.cos(a) * B.slam.length, y2: b.y + Math.sin(a) * B.slam.length,
            w: B.slam.width, r: B.slam.width * 0.5,
            t: 0, total: 0.001, fired: true, active: true,
            hold: B.slam.active, tick: 0, damage: B.slam.damage
          });
        }
        this.parts.burst(b.x, b.y + b.r * 0.3, '#b9c0c8', 20);
        this.emit('slam', { x: b.x, y: b.y });
      }
      return 0;
    }

    b.golemSlamT -= dt;
    b.rubbleT -= dt;
    if (b.golemSlamT <= 0 && d < B.slam.length * 0.85) {
      b.golemSlamT = B.slam.cooldown;
      b.cast = 'slam';
      b.castT = B.slam.telegraph;
      b.castTotal = B.slam.telegraph;
      b.castRadius = B.slam.length;
      b.castX = b.x; b.castY = b.y;
      return 0;
    }
    if (b.rubbleT <= 0) {
      b.rubbleT = B.rubble.cooldown;
      var base = Math.atan2(dy, dx);
      for (var k = 0; k < B.rubble.count; k++) {
        var ang = base + (k - (B.rubble.count - 1) / 2) * 0.26;
        this.projectiles.push(this.Entities.makeProjectile(
          b.x, b.y, ang, B.rubble.speed, B.rubble.damage, B.rubble.r, '#9aa2aa'));
      }
      this.emit('shoot', { x: b.x, y: b.y });
    }
    return 1;
  };

  /** 熔心巨兽：蓄力（变亮）→ 直线冲刺，路径留火痕；平时脚下岩浆池 */
  Game.prototype.updateBossMagma = function (dt, b, dx, dy, d) {
    var cfg = this.cfg, B = cfg.bossTypes.magma, C = B.charge;

    if (b.charging > 0) {                           // 冲刺中：位移在这里做完
      b.charging -= dt;
      var step = C.speed * dt;
      b.x += Math.cos(b.chargeDir) * step;
      b.y += Math.sin(b.chargeDir) * step;
      b.chargeRange -= step;
      this.world.collide(b);
      b.trailT -= dt;
      if (b.trailT <= 0) {                          // 火痕：走一路留一路
        b.trailT = 0.14;
        this.hazards.push({
          kind: 'fire', x: b.x, y: b.y, r: 32, w: 0,
          t: 0, total: 0.001, fired: true, active: true,
          hold: 2.0, tick: 0, damage: C.trailDamage
        });
      }
      if (b.charging <= 0 || b.chargeRange <= 0) { b.charging = 0; b.chargeT = C.cooldown; }
      return 0;
    }
    if (b.windup > 0) {                             // 蓄力：钉住（全身发亮 = 该跑了）
      b.windup -= dt;
      if (b.windup <= 0) {
        b.charging = C.time;
        b.trailT = 0;
        this.emit('windup', { x: b.x, y: b.y });
      }
      return 0;
    }

    b.chargeT -= dt;
    b.poolT -= dt;
    if (b.chargeT <= 0 && d < C.range) {
      b.chargeT = C.cooldown;
      b.windup = C.windup;
      b.windupTotal = C.windup;
      b.chargeDir = Math.atan2(dy, dx);             // 方向在蓄力开始就锁死
      b.chargeRange = C.range;
      this.emit('charge', { x: b.x, y: b.y });
      return 0;
    }
    if (b.poolT <= 0) {
      b.poolT = B.pool.cooldown;
      var P = this.player;
      this.hazards.push({
        kind: 'fire', x: P.x, y: P.y, r: B.pool.radius, w: 0,
        t: B.pool.telegraph, total: B.pool.telegraph, fired: false, active: true,
        hold: B.pool.active, tick: 0, damage: B.pool.damage
      });
      this.emit('pool', { x: P.x, y: P.y });
    }
    return 1;
  };

  /** 虚空之眼：收拢 → 瞬移到你侧后方；5 发追踪弹；掉到一半血分裂成 3 只小眼 */
  Game.prototype.updateBossEye = function (dt, b, dx, dy, d) {
    var cfg = this.cfg, B = cfg.bossTypes.eye, P = this.player;

    if (b.teleport > 0) {                           // 瞬移中：碎片收拢、眼睛闭合
      b.teleport -= dt;
      if (b.teleport <= 0) {
        var side = Math.random() < 0.5 ? -1 : 1;
        var a = Math.atan2(dy, dx) + side * (B.teleport.spread * 0.6 + Math.random() * 0.5);
        b.x = Math.max(70, Math.min(this.world.w - 70, P.x + Math.cos(a) * B.teleport.dist));
        b.y = Math.max(70, Math.min(this.world.h - 70, P.y + Math.sin(a) * B.teleport.dist));
        this.parts.burst(b.x, b.y, '#7a5bb0', 20);
        this.emit('teleport', { x: b.x, y: b.y });
      }
      return 0;
    }

    // 二阶段：掉到 atHp 以下分裂（只裂一次；小眼不再裂）
    if (!b.mini && !b.split && b.hp <= b.maxhp * B.split.atHp &&
        this.foes.length + B.split.count <= this.cfg.harvest.cap) {
      b.split = true;
      for (var i = 0; i < B.split.count; i++) {
        var ang = i / B.split.count * 6.283 + Math.random() * 0.4;
        var m = this.Entities.makeBoss(cfg, b.x + Math.cos(ang) * 74, b.y + Math.sin(ang) * 74,
          this.stage, 'eye', B.split.hpMul);
        m.mini = true;
        m.r = B.split.r;
        m.maxhp = m.hp;
        this.world.collide(m);
        this.foes.push(m);
        this.bossAlive++;                        // 小眼也算 Boss：全部清掉才过关
      }
      this.parts.burst(b.x, b.y, '#c9a6ff', 30);
      this.emit('split', { x: b.x, y: b.y });
    }

    b.teleT -= dt;
    b.homingT -= dt;
    if (!b.mini && b.teleT <= 0 && d > B.teleport.dist * 0.5) {
      b.teleT = B.teleport.cooldown;
      b.teleport = B.teleport.fade;
      this.emit('vanish', { x: b.x, y: b.y });
      return 0;
    }
    if (b.homingT <= 0) {                           // 追踪弹幕
      b.homingT = B.homing.cooldown * (b.mini ? 1.5 : 1);
      var base = Math.atan2(dy, dx);
      for (var k = 0; k < B.homing.count; k++) {
        var p = this.Entities.makeProjectile(b.x, b.y, base + (k - (B.homing.count - 1) / 2) * 0.5,
          B.homing.speed, B.homing.damage, B.homing.r, b.color, 'foe');
        p.homing = B.homing.turn;                 // 会转弯：躲弹要靠"绕圈"而不是"直线跑"
        p.life = B.homing.life;
        this.projectiles.push(p);
      }
      this.emit('shoot', { x: b.x, y: b.y });
    }
    // 远程型：贴太近就后撤（否则弹一出生就贴脸炸）
    if (d < 150) return -1;
    return d > 330 ? 1 : 0;
  };

  /** 霜缚行者：旋转扫射 + 召唤小怪。核心是"逼你一直移动" */
  Game.prototype.updateBossFrost = function (dt, b, dx, dy, d) {
    var cfg = this.cfg, B = cfg.bossTypes.frost, P = this.player;

    if (b.cast === 'summon') {                 // 召唤前先蓄一下（有预警圈）
      b.castT -= dt;
      if (b.castT <= 0) {
        b.cast = null;
        for (var i = 0; i < B.summon.count && this.foes.length < this.enemyCap(); i++) {
          var a = i / B.summon.count * 6.283 + Math.random() * 0.8;
          var f = this.Entities.makeFoe(cfg, B.summon.type,
            b.x + Math.cos(a) * 92, b.y + Math.sin(a) * 92, this.wave);
          this.world.collide(f);
          this.foes.push(f);
        }
        this.parts.burst(b.x, b.y, b.color, 22);
        this.emit('summon', { x: b.x, y: b.y });
      }
      return 0;
    }

    if (b.sweeping > 0) {                      // 扫射中：站着转圈吐弹
      b.sweeping -= dt;
      b.sweepTick -= dt;
      b.sweepAngle += B.sweep.spin;
      if (b.sweepTick <= 0) {
        b.sweepTick = B.sweep.interval;
        this.projectiles.push(this.Entities.makeProjectile(
          b.x, b.y, b.sweepAngle, B.sweep.speed, B.sweep.damage, B.sweep.r, b.color, 'foe'));
        this.emit('shoot', { x: b.x, y: b.y });
      }
      return 0;
    }

    b.sweepT -= dt;
    b.summonT -= dt;
    if (b.sweepT <= 0) {
      b.sweepT = B.sweep.cooldown;
      b.sweeping = B.sweep.duration;
      b.sweepTick = 0;
      b.sweepAngle = Math.atan2(dy, dx);
    } else if (b.summonT <= 0) {
      b.summonT = B.summon.cooldown;
      b.cast = 'summon';
      b.castT = B.summon.telegraph;
      b.castTotal = B.summon.telegraph;
      b.castRadius = 92;
      b.castX = b.x; b.castY = b.y;
    }

    // 它是个远程型 Boss：贴太近就后撤。
    // 不加这句它会一路追到你身上 —— 扫射的弹一出生就在你身上炸掉，等于没有扫射（测试抓到的）
    if (d < 170) return -1;
    return 1;
  };

  /**
   * 荒原巨蝎（第 1 关教学 Boss，2026-10 机制重做）。
   *
   * 设计口径：**严格按距离分段**，任何一个距离上只有一件事要玩家回应 ——
   *   近身（< claw.range 140）：双钳夹击，扇形预警 → 夹下去（疼 + 把你推开）
   *   中距（140 ~ slam.range 330）：震荡波，圈落在你脚下 → 离开那个圈
   *   远程（>  slam.range）：尾针锁定，一条直线毒刺 → 只能横向挪（后退躲不掉）
   * 分段为什么是"严格"的（实测过一版不严格的）：贴着打的时候钳夹和震荡波会交替出，
   *   平均 2.4 秒一个动作，玩家读不出"这个距离我该做什么"，又回到"一堆招乱砸"。
   * 顺带得到一个好循环：被钳夹推开 → 正好落进中距吃震荡波 → 想拉开 → 吃尾针。
   * 半血裂壳：移速 +30%、尾针变三连、钳夹冷却减半 —— 给"打了一半"一个进度感。
   *
   * ⚠️ 旧的「环形弹幕」已删：和尾针同为远程招、且没有任何蝎子身份。
   *    所有动作的预警期都**钉住不动** = 玩家的输出窗口（Boss 通用口径）。
   */
  Game.prototype.updateBossWarden = function (dt, b, dx, dy, d) {
    var cfg = this.cfg, B = cfg.bossTypes.warden, P = this.player, PH = B.phase2;

    /* 二阶段 · 裂壳（只裂一次）：壳一裂就更快、招更密。
       ⚠️ 必须靠 phase2 这个标记挡住，不能用"血量低于一半"反复判定 ——
          否则每帧都会重新乘一次 spdMul，Boss 会越跑越快。 */
    if (!b.phase2 && b.hp > 0 && b.hp <= b.maxhp * PH.atHp) {
      b.phase2 = true;
      b.crack = 0.9;
      b.spd *= PH.spdMul;
      this.parts.burst(b.x, b.y, '#ffd166', 34);
      this.parts.text(b.x, b.y - b.r - 35, '裂壳！', '#ffd166');
      this.emit('boss', { x: b.x, y: b.y });
    }
    if (b.crack > 0) b.crack = Math.max(0, b.crack - dt);

    /* ⚠️ 三个冷却**每帧都要走**，而且要写在下面的预警/硬直分支**之前**：
       写在后面的话，预警（钉住 1.15 秒）和硬直（0.9~1.6 秒）期间冷却不走，
       实际出手间隔就变成 config + 各段动画时长 —— 数值和体感对不上，
       而且调 config 也调不准。 */
    b.clawT -= dt; b.stingT -= dt; b.slamT -= dt;

    if (b.recovery > 0) { b.recovery -= dt; return 0; }   // 出手后的硬直（通用节流）

    /* ---- 尾针锁定：高举尾针 windup 秒（钉住）→ 沿锁定方向射细长毒刺 ---- */
    if (b.sting > 0) {
      b.sting -= dt;
      if (b.sting <= 0) {
        b.sting = 0;
        b.recovery = 0.9;
        var shots = b.phase2 ? B.sting.burst : 1;      // 裂壳后三连
        for (var si = 0; si < shots; si++) {
          var sa = (b.chargeDir || 0) + (si - (shots - 1) / 2) * B.sting.spread;
          var sp = this.Entities.makeProjectile(b.x, b.y, sa, B.sting.speed,
            B.sting.damage, B.sting.width, '#c8e06a', 'foe');
          sp.spike = true;                              // 渲染层画成针形，不是圆点
          sp.slow = B.sting.slowMul; sp.slowTime = B.sting.slowTime;   // 命中中毒（减速）
          sp.life = B.sting.range / B.sting.speed + 0.15;
          this.projectiles.push(sp);
        }
        this.emit('shoot', { x: b.x, y: b.y });
      }
      return 0;
    }

    /* ---- 双钳夹击：扇形预警 telegraph 秒（钉住）→ 前方扇形夹下，命中就推开你 ---- */
    if (b.claw > 0) {
      b.claw -= dt;
      if (b.claw <= 0) {
        b.claw = 0;
        b.recovery = 1.1;
        this.parts.burst(b.x + Math.cos(b.clawDir || 0) * b.r, b.y + Math.sin(b.clawDir || 0) * b.r, '#ffb27a', 16);
        this.emit('slam', { x: b.x, y: b.y });
        var ca = Math.atan2(P.y - b.y, P.x - b.x);
        var cdiff = Math.abs(((ca - (b.clawDir || 0) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < B.claw.range + P.r && cdiff < B.claw.arc) {
          this.hurtPlayer(B.claw.damage, b.x, b.y, b, 'boss_claw');
          /* 额外推开 = 这一招的真正代价不是掉血，是"被赶出你原来的输出位置"。
             方向按当前位置现算（不按预警方向），这样被夹住的人一定被往外送。 */
          var ka = Math.atan2(P.y - b.y, P.x - b.x);
          P.x += Math.cos(ka) * B.claw.push; P.y += Math.sin(ka) * B.claw.push;
          this.world.collide(P);
        }
      }
      return 0;
    }

    /* ---- 震荡波：圈落在玩家**当前位置**（预警 1.15 秒）→ 圈内挨打 ---- */
    if (b.cast) {
      b.castT -= dt;
      if (b.castT <= 0) {
        b.cast = null;
        b.recovery = 1.6;
        this.parts.burst(b.castX, b.castY, '#ff8a5c', 26);
        this.emit('slam', { x: b.castX, y: b.castY });
        if (Math.hypot(P.x - b.castX, P.y - b.castY) < B.slam.radius) {
          this.hurtPlayer(B.slam.damage, b.castX, b.castY, b, 'boss_slam');
        }
      }
      return 0;
    }

    /* ---- 选招：**严格按距离分段** —— 同一时刻只有一段的招是"允许"的。
       这三条 if 的距离区间互不重叠（<140 / 140~330 / >330），所以玩家在任何一个
       距离上只会面对一件事，"这个距离我该做什么"永远是清楚的。 ---- */
    var clawCd  = B.claw.cooldown  * (b.phase2 ? PH.clawCdMul : 1);
    var stingCd = B.sting.cooldown * (b.phase2 ? PH.stingCdMul : 1);

    if (b.clawT <= 0 && d < B.claw.range) {
      b.clawT = clawCd;
      b.claw = B.claw.telegraph; b.clawTotal = B.claw.telegraph;
      b.clawDir = Math.atan2(dy, dx);            // 方向在预警开始就锁死 → 侧身能躲
      b.clawRange = B.claw.range; b.clawArc = B.claw.arc;   // 渲染层按这两个数画扇形
      this.emit('cast', { x: b.x, y: b.y });
      return 0;
    }
    if (b.slamT <= 0 && d >= B.claw.range && d < B.slam.range) {
      b.slamT = B.slam.cooldown;
      b.cast = 'slam';
      b.castT = B.slam.telegraph; b.castTotal = B.slam.telegraph;
      b.castRadius = B.slam.radius;
      b.castX = P.x; b.castY = P.y;              // 落点 = 你按下此刻站的地方
      return 0;
    }
    if (b.stingT <= 0 && d >= B.slam.range && d < B.sting.range) {
      b.stingT = stingCd;
      b.sting = B.sting.windup; b.stingTotal = B.sting.windup;
      b.chargeDir = Math.atan2(dy, dx);          // 锁定方向：只能横向挪，后退没用
      b.chargeRange = B.sting.range;
      this.emit('cast', { x: b.x, y: b.y });
      return 0;
    }
    return 1;                                    // 平时追击
  };

  /**
   * 铁角：靠近 → 蓄力（原地抖，给玩家反应时间）→ 高速直线冲撞 → 冷却。
   * 它是唯一"不能用站桩对砍解决"的敌人，逼你走位。
   */
  Game.prototype.updateSpitter=function(dt,f,d){
    if(f.recovery>0){f.recovery-=dt;return 0;}
    if(f.spitWindup>0){
      f.spitWindup-=dt;
      if(f.spitWindup<=0){
        var h=this.hazards.find(function(h){return h.spitId===f.spitId;});
        if(h){h.launched=true;h.fromX=f.x;h.fromY=f.y;}
        f.recovery=.8;f.shootT=5.5;this.emit('shoot',{x:f.x,y:f.y});
      }return 0;
    }
    f.shootT-=dt;
    var bossTell=this.foes.some(function(b){return b.kind==='boss'&&b.cast;});
    var clouds=this.hazards.filter(function(h){return h.kind==='poison';}).length;
    var otherTell=this.foes.some(function(other){return other!==f&&other.spitWindup>0;});
    if(f.shootT<=0&&d<430&&!bossTell&&!otherTell&&clouds<2){
      this.spitSerial=(this.spitSerial||0)+1;f.spitId=this.spitSerial;f.spitWindup=.45;
      this.hazards.push({kind:'poison',spitId:f.spitId,x:this.player.x,y:this.player.y,r:30,t:1,total:1,hold:2,active:true,tick:0,damage:7,fromX:f.x,fromY:f.y});return 0;
    }
    return d>300?1:d<150?-1:0;
  };

  Game.prototype.updateCharger = function (dt, f, dx, dy, d) {
    var C = this.cfg.enemyTypes.charger.charge;
    if(this.cfg.trial.enabled&&!f.trialElite) C={range:290,windup:.9,speed:5.2,time:.42,cooldown:4.8};
    if (f.trialElite) C = { range: 380, windup: 1.15, speed: 4.6, time: 0.65, cooldown: 4.2 };
    if (f.recovery > 0) { f.recovery -= dt; return 0; }

    if (f.charging > 0) {                     // 冲刺中：位移在这里做完，外层不要再加
      f.charging -= dt;
      f.x += Math.cos(f.chargeDir) * (f.chargeSpeed || f.spd * C.speed) * dt;
      f.y += Math.sin(f.chargeDir) * (f.chargeSpeed || f.spd * C.speed) * dt;
      if (f.charging <= 0) { f.recovery = f.trialElite ? 1.5 : 1.1; f.chargeCd = C.cooldown; f.kb.x = 0; f.kb.y = 0; }
      return 0;
    }

    if (f.windup > 0) {                       // 蓄力：钉住不动
      f.windup -= dt;
      if (f.windup <= 0) f.charging = C.time; // 方向在蓄力开始时就已经锁死
      return 0;
    }

    f.chargeCd -= dt;
    if (f.chargeCd <= 0 && d < C.range && !this.foes.some(function(other){return other!==f&&(other.windup>0||other.charging>0);})) {
      // 蓄力开始时锁定方向 —— 玩家看到预警线就能侧身躲开，冲撞才是"可读的威胁"
      f.windup = C.windup;
      f.windupTotal = C.windup;
      f.chargeSpeed=this.cfg.trial.enabled&&!f.trialElite?Math.min(260,d)/C.time:f.spd*C.speed;
      f.chargeRange = f.chargeSpeed*C.time;
      f.chargeDir = Math.atan2(dy, dx);
      this.emit('windup', { x: f.x, y: f.y });
      return 0;
    }
    return 1;                                 // 平时就是普通追击
  };

  /* ==================== 投射物 ==================== */

  Game.prototype.updateProjectiles = function (dt) {
    var P = this.player, W = this.world;
    for (var i = this.projectiles.length - 1; i >= 0; i--) {
      var p = this.projectiles[i];
      if (!p || this.clearT > 0) break;
      if (p.skillWeapon && p.skillWeapon !== this.weaponKind()) { this.projectiles.splice(i, 1); continue; }
      var oldX = p.x, oldY = p.y;
      p.t += dt;
      if (p.skillShape === 'return' && p.t >= 0.45) {
        if (!p.returning) { p.returning = true; p.hitSet = []; }
        p.angle = Math.atan2(P.y - p.y, P.x - p.x);
        p.vx = Math.cos(p.angle) * 460; p.vy = Math.sin(p.angle) * 460;
        if (Math.hypot(P.x - p.x, P.y - p.y) < 20) { this.projectiles.splice(i, 1); continue; }
      }
      if (p.homing) {                                  // 追踪弹（虚空之眼）：慢慢转向玩家
        var want = Math.atan2(P.y - p.y, P.x - p.x);
        var diff = ((want - p.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        var mx = p.homing * dt;
        p.angle += Math.max(-mx, Math.min(mx, diff));
        var sp = Math.hypot(p.vx, p.vy);
        p.vx = Math.cos(p.angle) * sp;
        p.vy = Math.sin(p.angle) * sp;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;

      var dead = p.t > p.life || p.x < 0 || p.y < 0 || p.x > W.w || p.y > W.h;
      if (!dead) {
        for (var j = 0; j < W.rocks.length; j++) {
          var o = W.rocks[j];
          if (Math.hypot(o.x - p.x, o.y - p.y) < o.r) { dead = true; break; }
        }
      }
      // 敌我分流：玩家的弹打敌人，敌人的弹打玩家（不能互相打到）
      if (!dead && p.owner === 'player') {
        if (!p.hitSet) p.hitSet = [];
        for (var k = this.foes.length - 1; k >= 0; k--) {
          var foe = this.foes[k];
          if (!foe) continue;                            // 见 updateFoes 里的说明：循环途中数组可能缩短
          if (p.hitSet.indexOf(foe) >= 0) continue;        // 同一发不能反复打同一个
          if (segmentDistance(foe.x, foe.y, oldX, oldY, p.x, p.y) < foe.r + p.r) {
            p.hitSet.push(foe);
            var connected = this.damageFoe(foe, p.damage, this.cfg.combat.knockback * 0.5, 'spell');
            if (connected && !p.skillTriggered && (p.chainSkill || p.splitSkill)) {
              p.skillTriggered = true;
              this.staffSkillImpact(p, foe);
            }
            if (p.pierce > 0 && p.hitSet.length <= p.pierce) {
              this.emit('pierce', { x: p.x, y: p.y });   // 还有得穿，给个视觉反馈
            }
            // pierce = 还能多穿几个；0 表示打完就消失
            if (p.hitSet.length > (p.pierce || 0)) dead = true;
            break;
          }
        }
      } else if (!dead && Math.hypot(P.x - p.x, P.y - p.y) < P.r + p.r) {
        this.hurtPlayer(p.damage, p.x, p.y, null, p.slow ? 'boss_sting' : 'enemy_projectile');
        if (p.slow) this.applySlow(p.slow, p.slowTime);   // 尾针毒刺：命中附带中毒减速
        dead = true;
      }
      if (dead) {
        this.parts.burst(p.x, p.y, p.color, 5);
        this.projectiles.splice(i, 1);
      }
    }
  };

  /* ==================== 拾取 ==================== */

  Game.prototype.updatePickups = function (dt) {
    var cfg = this.cfg, P = this.player;
    var magnet = cfg.player.xpMagnet;

    for (var i = this.pickups.length - 1; i >= 0; i--) {
      var u = this.pickups[i];
      u.t += dt;
      u.life = u.t;

      var dx = P.x - u.x, dy = P.y - u.y, d = Math.hypot(dx, dy) || 1;

      /* ⚠️ 技能卷轴**不吸附**（用户 2026-10 口径："武器掉落去掉自动吸附吧，只能自己去捡"）——
         它必须靠玩家走过去踩到（判定半径还是 P.r+14），不然"去捡"这个动作就不存在了。
         其它掉落（金币/装备）照旧 150px 内吸附，不然满地的金币得一个个踩。 */
      if (u.kind !== 'skill' && d < magnet) {
        // 吸附：越近越快
        u.x += dx / d * cfg.pickups.magnetSpeed * dt;
        u.y += dy / d * cfg.pickups.magnetSpeed * dt;
      } else {
        u.x += u.vx * dt; u.y += u.vy * dt;
        u.vx *= 0.9; u.vy *= 0.9;
      }

      if (d < P.r + 14) {
        this.collect(u);
        this.pickups.splice(i, 1);
        continue;
      }
      /* ⚠️ 武器技能卷轴**不吃寿命**（用户口径"不消失，等玩家自己来捡"）：
         其他掉落照旧 26 秒消失，否则满地的金币/装备永远不清理。 */
      if (u.kind !== 'skill' && u.t > cfg.pickups.life) this.pickups.splice(i, 1);
    }
  };

  /**
   * 拾取一件东西。
   * @returns 装备的话返回一条记录（过关面板要列"这关拿到了什么"），金币返回 null
   */
  Game.prototype.collect = function (u) {
    var cfg = this.cfg, P = this.player;
    if (u.kind === 'gold') {
      P.gold += u.value;
      P.runGold = (P.runGold || 0) + u.value;
      this.emit('pickup', { x: u.x, y: u.y, kind: 'gold' });
      return null;
    }
    if (u.kind === 'item') {
      var had = P.equip[u.item.slot] || null;          // 记下被替换掉的那件（面板要写"替换了 X"）
      /* ⚠️ 武器和防具/饰品**不是一套规则**：
         武器进**武器库**（同种只留更好的那把、新种类自动装上、拿到多把之后可以随时切 ——
         见 switchWeapon / progression.tryEquipWeapon）；防具/饰品还是老的"比身上这件强就换上"。 */
      var rec;
      if (u.item.slot === 'weapon') {
        rec = this.Prog.tryEquipWeapon(P, cfg, u.item);
      } else {
        var swapped = this.Prog.tryEquip(P, cfg, u.item);
        rec = {
          item: u.item,
          equipped: swapped,
          replaced: swapped && had ? had : null,
          better: !swapped && had ? had : null           // 没换上：说明身上那件更好
        };
      }
      this.emit(rec.equipped ? 'equip' : 'pickup', { x: u.x, y: u.y, kind: 'item' });
      this.parts.text(P.x, P.y - 58,
        (rec.equipped ? '装备 ' : '') + u.item.rarityName + u.item.slotName, u.item.color);
      if (this.stageGained) this.stageGained.push(rec);  // 记进本关清单（通关面板要列）
      return rec;
    }
    if (u.kind === 'skill') {
      /* 武器技能卷轴：学会它（跟着武器走 —— 换武器后自动休眠，见 hasWeaponSkill） */
      /* 第 1 波的教学 gate（见 updateTrialSpawns）：**捡到就算过关**，哪怕 grantSkill 返回 null
         （极端情况：两份技能都已学会、只是地上还留着旧卷轴）也必须解锁，否则这一波永远不出怪。 */
      if (this.trial) this.trial.skillTaken = true;
      var got = this.grantSkill(u.skill);
      if (got) {
        this.emit('skillGet', { x: u.x, y: u.y, id: u.skill });
        this.parts.text(P.x, P.y - 58, '技能 ' + got.name, '#ffd166');
      }
      return null;
    }
    return null;
  };

  /**
   * 学会一个武器技能。**和选卡走同一条 apply 路径**（Prog.applyUpgrade）：
   * taken / base / recompute 一处都不少，所以技能页、属性页、试卡面板看到的
   * 和"以前从抽卡拿到"完全一致 —— 换掉的只是"怎么得到"。
   * @returns {name, weapon, id} 拿到的技能；重复或已满返回 null
   */
  Game.prototype.grantSkill = function (id) {
    var cfg = this.cfg, card = null;
    for (var i = 0; i < cfg.upgrades.length; i++) if (cfg.upgrades[i].id === id) card = cfg.upgrades[i];
    if (!card || !this.Prog.applyUpgrade(cfg, this.player, id)) return null;
    var wname = (cfg.weapons[card.weapon] && cfg.weapons[card.weapon].name) || '';
    /* 全屏一行（渲染层读它）：主行"获得 · XX" + 副标"长剑的技能 · 跟随武器生效" ——
       在**捡起来的这一刻**把"跟着武器走"讲清楚（不能只靠玩家自己去技能页发现）。 */
    this.skillNotice = { name: card.name, weapon: wname, t: 2.6 };
    return { name: card.name, weapon: wname, id: id };
  };

  /**
   * 精英死亡 → 掉一个武器技能卷轴（2026-10 用户口径：技能不再从升级卡出，改成精英掉落）。
   * 给的是**当前手上这把武器**的、还没拿到的那个技能 —— 一局两只精英正好把手上的两个技能给全。
   * 手上这把已经拿满（切武器又切回来之类）→ 改成掉金币，不掉一个"捡了没反应"的东西。
   */
  Game.prototype.dropSkillScroll = function (x, y) {
    var cfg = this.cfg, P = this.player, kind = this.weaponKind(), next = null;
    /* 候选 = 手上这把武器的、**还没拿到的**、**熟练度已解锁的**技能，然后**随机取一个**。
       ⚠️ 这里必须随机，不能"按 config 顺序取第一个"（2026-10 改）：用户口径是
          "熟练度解锁的新技能**有几率**掉落"。按顺序取的话，池子从 2 个变 3 个而一局只掉 2 次，
          排在最后的那个（正好是新解锁的）**永远轮不到** —— 解锁了等于没解锁。
          随机取才有"这一把碰碰运气"的期待。
       ⚠️ 熟练度门槛**只有这一处**对它生效：武器技能卡带 `weapon`，而升级卡池那边是
          `allowSkill:false`（口径：技能不给卡，改精英掉卷轴），所以 drawUpgrades 里的
          masteryMin 过滤对武器技能卡根本跑不到。两边都写是故意的，但要知道哪边真的在起作用。 */
    var mlevels = (cfg.mastery && cfg.mastery.levels) || [0];
    var mPts = this.masteryOf(kind);
    var cands = [];
    for (var i = 0; i < cfg.upgrades.length; i++) {
      var u = cfg.upgrades[i];
      if (u.weapon !== kind || u.disabled || P.taken[u.id]) continue;
      if (u.masteryMin) {
        var need = mlevels[u.masteryMin - 1];
        if (need === undefined || mPts < need) continue;
      }
      cands.push(u);
    }
    if (cands.length) next = cands[Math.floor(Math.random() * cands.length)];
    if (!next) {
      /* 手上这把已经拿满 → 改掉金币（不掉一个"捡了没反应"的东西）。
         ⚠️ 同时要解锁第 1 波的教学 gate：没有卷轴可捡时，玩家不可能靠"捡卷轴"解锁，
            不解锁这一波就永远不刷怪（老存档带着技能继续打就是这个情况）。 */
      if (this.trial) this.trial.skillTaken = true;
      this.pickups.push(this.Entities.makePickup('gold', x, y, (cfg.pickups.skill && cfg.pickups.skill.cappedGold) || 20));
      return null;
    }
    this.pickups.push(this.Entities.makePickup('skill', x, y, next.id));
    /* 掉落飘字写**技能名**（用户口径："掉落的技能都显示出具体的名字"），
       光写"武器技能"玩家不知道掉的是哪一招。 */
    this.parts.text(x, y - 28, '掉落 · ' + next.name, '#ffd166');
    this.emit('skillDrop', { x: x, y: y, id: next.id });
    return next.id;
  };

  /* ==================== 过关（区域推进） ====================
     打死本关 Boss = **直接过关**（2026-10 改）。
     原来 Boss 死后会在全图随机开一道"入口"，要跑过去站 0.9 秒读条才进下一关 ——
     真机反馈的问题是"Boss 都死了还在找路"，节奏断掉。现在：
       击杀 → 停 clearDelay 秒（让爆炸/掉落看得见）→ **自动收走场上掉落** → 过场 → 下一关。
     ⚠️ 必须自动收掉落：Boss 掉的装备/金币就是这局的奖励，不自动收等于直接蒸发。
     ⚠️ 这段时间要继续挡住刷怪（见 updateSpawns 里的 clearT 判断）。 */
  Game.prototype.stageClear = function () {
    this.track('wave_complete');
    this.track('run_complete');
    this.finishRanked(true);
    /* 熟练度：**打完 Boss 通关**那一下（2026-10 用户口径"每次过关打完 boss 增加熟练度"）。
       ⚠️ 顺序有讲究：**先入账、再判满级奖励** —— 于是"差一点升满级"的那一把，
          这一把就能吃到满级奖励（"打完 boss 有几率掉双刀"）。反过来放会白等一整把，像卡了。
       once='clear'：一局只结算一次（试玩版一局本来就只过一次，但别依赖"恰好成立"）。
       `!this.training`：试炼场是沙盒，不练熟练度、也不掉奖励武器。 */
    var MG = this.cfg.mastery && this.cfg.mastery.gains;
    if (MG && !this.training) {
      this.gainMastery(MG.clear, 'clear');
      this.grantMasteryWeaponReward();
    }
    if (this.cfg.trial.enabled) { this.trial.finished = true; this.foes.length = 0; this.projectiles.length = 0; this.hazards.length = 0; }
    this.stageBossPending = false;
    this.clearT = this.cfg.stage.clearDelay;
    this.emit('stageClear', { stage: this.stage });
  };

  /** 过关收尾：场上掉落直接进包（不演吸附动画 —— 这一帧之后就要切关了） */
  /** 过关时把场上掉落一次收干净，返回这一批的拾取记录（面板用） */
  Game.prototype.collectAll = function () {
    var got = [];
    for (var i = this.pickups.length - 1; i >= 0; i--) {
      var rec = this.collect(this.pickups[i]);
      if (rec) got.push(rec);
    }
    this.pickups.length = 0;
    return got;
  };

  Game.prototype.updateClear = function (dt) {
    if (this.clearT <= 0) return;
    this.clearT -= dt;
    if (this.clearT > 0) return;
    this.clearT = 0;
    this.collectAll();
    this.nextStage();          // 记成绩 → 换关 → 过场
  };

  /** 进下一关：记成绩 → 重建世界里那一关的地形/配色/怪物池 */
  /* 通关成功面板（2026-10 真机需求："打完 Boss 之后增加一个通关成功的步骤"）。
     流程：打死 Boss → clearT 0.9 秒（让爆炸/掉落看得见）→ 自动收掉落 →
     **面板**（本关成绩 + 这关拿到什么 + 下一关是什么）→ 点任意处继续 → 下一关开打。
     设计取舍：
       · 用"点任意处"而不是按钮 —— 上次真机反馈"走位时容易误选"，按钮目标小更容易点错
       · 面板有 0.25 秒护栏（刚打死的瞬间手还在动，别一下就把面板点掉）
       · 面板里直接写"下一关：第 N 关 · XX"，所以**不再单独播旧过场**（少一道屏、更利落）
       · 旧的 intro 状态没删：以后想给第一关开场加个"第 1 关 · 荒原"可以直接复用 */
  Game.prototype.nextStage = function () {
    var cfg = this.cfg;
    this.stageSummary = {
      name: this.world.stageName, stage: this.stage, time: this.stageT,
      kills: this.stageKills, hits: this.stageHits, level: this.player.level,
      gained: this.stageGained || []                  // 这关拿到的装备（含过关时自动收的那批）
    };
    var next = this.stage + 1;
    var def = this.World.stageOf ? this.World.stageOf(cfg, next) : null;
    this.clearInfo = { stage: next, name: (def && def.name) || '更深处' };
    this.clearGuard = cfg.stage.clearGuard;
    this.state = 'clear';
    if (cfg.trial.enabled) { this.clearInfo = { complete: true }; this.saveNow(); }
  };

  /** 面板期：护栏过后点任意处 → 进下一关（不再走过场） */
  Game.prototype.updateClearPanel = function (dt, input) {
    if (this.clearGuard > 0) this.clearGuard = Math.max(0, this.clearGuard - dt);
    if (this.clearGuard > 0) return;
    if (!input.tap) return;
    if (this.cfg.trial.enabled) { this.toTitle(); return; }
    var info = this.clearInfo || {};
    this.clearInfo = null;
    this.enterStage(info.stage || (this.stage + 1));
    this.introT = 0;
    this.state = 'play';
  };

  Game.prototype.enterStage = function (n) {
    var cfg = this.cfg, P = this.player;
    if (cfg.trial.enabled) n = 1;
    this.stage = n;
    var spawn = cfg.trial.enabled ? {x:cfg.map.w*.5,y:cfg.map.h*.5} : { x: Math.round(cfg.map.w * 0.133), y: Math.round(cfg.map.h * 0.8125) };
    this.world = this.World.createWorld(cfg, spawn, n);
    this.foes.length = 0;
    this.projectiles.length = 0;
    this.pickups.length = 0;
    this.hazards.length = 0;
    this.clearT = 0;
    this.wave = 1;
    this.stageKills = 0;
    this.stageTypeCount = {};                // 每关限量的怪（甲壳兽）重新计数
    this.stageGained = [];                   // 本关拿到的装备（通关面板列出来）
    this.stageHits = 0;
    this.stageT = 0;
    this.bossSpawnedForStage = 0;
    this.bossAlive = 0;
    this.stageBossPending = false;
    this.swarmAt = cfg.swarm.everyKills;    // 每一关都要来几次 → 换关就重置阈值
    this.swarmWarn = null;
    this.harvestWarn = 0; this.harvestAnnounced = false;
    this.harvestSpawnT = 0; this.harvestPrep = 0; this.harvestActive = 0;
    this.spawnT = 0.8;
    this.hazardT = cfg.hazards.startAt;      // 新关卡重新给 20 秒缓冲
    this.seenTypes = {};                     // 新关卡的怪第一次登场也要必定出现
    P.x = spawn.x; P.y = spawn.y;
    this.quakePulse = null;
    this.skillFields = []; this.skillShadow = null; this.skillDash = null; this.skillVisuals = [];
    this.skillEchoSwords = []; this.skillEchoStrike = null;   // 剑阵回响：进新关也不背上一关的阵
    if (!cfg.trial.enabled) for (var fi = 0; fi < 4; fi++) this.spawnFoe();
    P.inv = Math.max(P.inv, 1.5);            // 进场短暂无敌，别一睁眼就挨打
    this.updateCamera();
    this.emit('stage', { stage: n, name: this.world.stageName });
  };

  /* ==================== 地面威胁 ====================
     为什么不给经验：怪 = 经验 = 升级卡，"加怪"提难度会被玩家成长吃掉（实测反超）。
     地面圈是唯一"纯压力"手段：伤害固定、不掉落、不升级，只惩罚站着不动和一直跑直线。

     落点按玩家速度预判：跑直线会被追着落，必须变向。这是对"跑圈无敌"的直接回应
     —— 玩家 205px/s 比所有普通怪都快，光靠怪解决不了"我绕圈就赢了"。 */
  /** 点到线段的距离（裂痕是线段，不能用圆心距离判） */
  function distToSeg(px, py, x1, y1, x2, y2) {
    var vx = x2 - x1, vy = y2 - y1;
    var L2 = vx * vx + vy * vy;
    var t = L2 > 0 ? ((px - x1) * vx + (py - y1) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t));
  }

  /** 玩家站在某个地面区里吗（圆 or 裂痕线段） */
  function inHazardArea(h, P) {
    var pad = P.r * 0.5;
    if (h.kind === 'crack') return distToSeg(P.x, P.y, h.x, h.y, h.x2, h.y2) < h.w * 0.5 + pad;
    return Math.hypot(P.x - h.x, P.y - h.y) < h.r + pad;
  }

  /** 玩家留的地面火（灼痕卡）：把站进来的怪烧一遍（每 0.4 秒一次，见 updateHazards） */
  Game.prototype.burnFoesIn = function (h) {
    for (var i = this.foes.length - 1; i >= 0; i--) {
      var f = this.foes[i];
      if (!f) continue;                                  // 循环途中数组可能缩短
      if (inHazardArea(h, f)) this.damageFoe(f, h.damage, 0, 'hazard');
    }
  };

  Game.prototype.updateHazards = function (dt) {
    var cfg = this.cfg, H = cfg.hazards, P = this.player;

    /* 1) 结算已有的：两类分开处理
       · **Boss 造的地面区**（h.active）：预警（t>0）→ 生效 hold 秒，期间每 0.4 秒掉一次血
         —— 踩上去会掉血，但因为有无敌帧，实际是"每段无敌帧挨一次"，不会被秒
       · 世界威胁（原来的）：到点炸一次 */
    for (var i = this.hazards.length - 1; i >= 0; i--) {
      var h = this.hazards[i];
      h.t -= dt;
      if (h.active) {
        if (h.t > 0) continue;                                  // 还在预警
        var activeDt=h.kind==='poison'?Math.min(dt,Math.max(0,-h.t)):dt;
        h.hold -= activeDt;
        h.tick -= activeDt;
        if (h.tick <= 0) {
          h.tick = 0.4;
          /* friendly = 玩家自己留的火痕（灼痕卡）：**只烧怪、不烧自己**。
             走的是"环境伤害"那条路 → 合壳的甲壳兽照吃（免疫只针对武器，见 config）。 */
          if (h.friendly) this.burnFoesIn(h);
          else if (inHazardArea(h, P)) this.hurtPlayer(h.damage || 14, h.x, h.y, null, h.kind || 'hazard');
        }
        if (h.hold <= 0) this.hazards.splice(i, 1);
        continue;
      }
      if (h.t > 0) continue;
      if (!h.fired) {
        h.fired = true;
        h.t = 0.2;                                     // 落地余波：只为了看得见，不再造成伤害
        if (Math.hypot(P.x - h.x, P.y - h.y) < h.r + P.r * 0.5) {
          this.hurtPlayer(H.damage, h.x, h.y, null, 'hazard');   // 只打玩家；不给经验、不触发反伤
        }
        this.parts.burst(h.x, h.y, '#ff7a4d', 14);
        this.emit('hazardHit', { x: h.x, y: h.y });
      } else {
        this.hazards.splice(i, 1);
      }
    }

    // 2) 世界威胁：落新圈（开局先给 startAt 秒的缓冲）
    if (!H || !H.enabled) return;          // 关掉世界威胁不影响上面 Boss 的地面区
    this.hazardT -= dt;
    if (this.hazardT > 0) return;
    this.hazardT = H.interval[0] + Math.random() * (H.interval[1] - H.interval[0]);
    for (var k = 0; k < H.count; k++) {
      var r = H.radius[0] + Math.random() * (H.radius[1] - H.radius[0]);
      // 预判：玩家朝哪跑就往哪落 —— 直线跑躲不掉，变向才有用
      var x = P.x + (P.vx || 0) * H.lead + (Math.random() * 2 - 1) * H.jitter;
      var y = P.y + (P.vy || 0) * H.lead + (Math.random() * 2 - 1) * H.jitter;
      x = Math.max(cfg.world.border + r, Math.min(this.world.w - cfg.world.border - r, x));
      y = Math.max(cfg.world.border + r, Math.min(this.world.h - cfg.world.border - r, y));
      this.hazards.push({ x: x, y: y, r: r, t: H.telegraph, total: H.telegraph, fired: false });
    }
    this.emit('hazard', { x: this.hazards[this.hazards.length - 1].x, y: this.hazards[this.hazards.length - 1].y });
  };

  /* ==================== 受伤 ==================== */

  Game.prototype.hurtPlayer = function (dmg, fromx, fromy, from, source) {
    if (this.trial && this.trial.finished) return;
    if(this.entranceScene||(from&&from.arrival&&(from.arrival.elapsed<from.arrival.total||from.arrival.grace>0)))return;
    var cfg = this.cfg, P = this.player;
    /* 试炼场默认无敌（试武器时不该被怪打断）。
       但"试 Boss"是无敌就没意义了 —— `debug.damage` 打开时照样挨打，
       只是**血量掉到 1 就不再往下掉、也不进入死亡**（试招不该真的死）。 */
    var sandboxHit = this.training && !!(cfg.debug && cfg.debug.damage);
    if (this.training && !sandboxHit) return;
    if (P.inv > 0 || this.state !== 'play') return;

    P.hp -= dmg;
    this.stageHits++;
    P.inv = Math.max(.7, P.stats.invulnTime);
    var a = Math.atan2(P.y - fromy, P.x - fromx);
    P.x += Math.cos(a) * P.stats.knockbackTaken;
    P.y += Math.sin(a) * P.stats.knockbackTaken;
    this.world.collide(P);
    this.parts.burst(P.x, P.y - 16, '#ff8f6b', 8);
    this.parts.text(P.x, P.y - 50, '-' + Math.round(dmg), '#ff9b8a');
    this.emit('hurt', { x: P.x, y: P.y });
    this.punchHitstop(cfg.feel.hitstop.hurt);

    /* 反伤（尖甲卡）：反伤 = 这次受到的伤害 × 40%，且 0.5 秒内只触发一次。
       ⚠️ 原来是"固定 18 点、无冷却、贴身一圈全挨" —— 怪一多就成了常驻清场光环，
          站着不动都能赢（真机反馈）。 */
    if (P.stats.thorns > 0 && (P.thornsCd || 0) <= 0) {
      P.thornsCd = 0.5;
      var reflect = Math.max(1, Math.round(dmg * (P.stats.thornsMul || 0.4)));
      for (var i = this.foes.length - 1; i >= 0; i--) {
        var f = this.foes[i];
        if (!f) continue;                   // 见 updateFoes 里的说明：反伤自己也会缩短数组
        if (Math.hypot(f.x - P.x, f.y - P.y) < f.r + P.r + 34) this.damageFoe(f, reflect, undefined, 'reflect');
      }
    }

    if (P.hp <= 0) {
      if (sandboxHit) { P.hp = 1; }        // 试炼场：掉到 1 就停，不进入死亡/不落盘
      else {
      P.hp = 0;
      P.dead = true;
      /* 「输在哪」：**只有真死在一只 Boss 手上时**才有内容（2026-10 用户口径：
         这条是真信息，要留）。原来自带一个"下局目标：突破第 N 关"的兜底，那句被去掉了
         （试玩版只有一关、永远是同一句，见 renderer.drawGameOver 那段）。
         ⚠️ 面板上**别做成常驻行**：有内容才画，没有就整行不占。 */
      this.deathLostTo = null;
      for (var bi = 0; bi < this.foes.length; bi++) {
        var bf = this.foes[bi];
        if (bf && bf.hp > 0 && bf.kind === 'boss') {
          this.deathLostTo = bf.name + '还剩 ' + Math.ceil(bf.hp / bf.maxhp * 100) + '% 生命';
          break;
        }
      }
      this.state = 'dead';
      this.track('run_death', { detail: source || (from && (from.bossType || from.type || from.kind)) || 'unknown' });
      this.finishRanked(false);
      this.bestKills = Math.max(this.bestKills, P.kills);
      this.runs++;
      this.saveNow();          // 死亡立刻存一次，不等下次自动存档
      this.emit('die', { x: P.x, y: P.y });
      }
    }
  };

  /**
   * 中毒减速（荒原巨蝎的尾针命中时挂上）。
   * 取"更慢的那个 + 更长的那个"：连吃两针不会叠成走不动（mul 相乘会越来越离谱），
   * 但会续上时间 —— 一直在吃针就是一直在慢。
   */
  Game.prototype.applySlow = function (mul, time) {
    var P = this.player;
    P.slowMul = Math.min(P.slowMul === undefined ? 1 : P.slowMul, mul || 1);
    P.slowT = Math.max(P.slowT || 0, time || 0);
    this.parts.text(P.x, P.y - 52, '中毒', '#c8e06a');
  };

  /**
   * 登记一个"限次爆发"（config.upgrades 里带 `burst` 的卡，目前是「开天」）。
   *
   * ⚠️ 只登记、**不在这一帧生效**（用户口径"抽到之后，下次起转的时候才生效"）：
   *    真正开始算"砍了几刀"是下次起转时，见 updateOrbit 的起转分支。
   *    这样抽卡那一刻不管你在收刃还是正在转，都是"下一次转起来变巨刀"，
   *    也不会出现"抽到的瞬间把一个转动窗口用掉半截"。
   * burst 里的字段：swings = 生效几个转动窗口；radiusMul = 半径倍率（乘在 orbitParams 的半径上）。
   * 以后加同族卡（刃数 / 转速 / 处决）就在 config 那张卡的 burst 里加字段、这里按字段登记。
   */
  Game.prototype.grantBurst = function (card) {
    var b = card && card.burst, P = this.player;
    if (!b) return false;
    /* ⚠️ 同族**只有一个槽**（`P.burst`）：抽到第二张爆发卡会顶掉第一张。
       这是有意的（HUD 只有一个徽标位、存档也只存一份），但必须**说出来** ——
       默默顶掉的话玩家会以为自己两张都有。burst 里的字段是照搬的白名单：
       以后加新维度（转速/处决/无敌）只要写进 config 的 burst，这里和消费点各加一行即可。 */
    var replaced = (P.burst && P.burst.left > 0 && P.burst.id !== card.id) ? P.burst.name : null;
    P.burst = {
      id: card.id, name: card.name, left: b.swings || 1, active: false,
      radiusMul: b.radiusMul || 1, bladesAdd: b.bladesAdd || 0, bladesMax: b.bladesMax || 0,
      bladesSet: b.bladesSet || 0,
      dmgMul: b.dmgMul || 0, healPerHit: b.healPerHit || 0, healCap: b.healCap || 0,
      tint: b.tint || null, healed: 0, capNoticed: false
    };
    this.parts.text(P.x, P.y - 78, card.name + ' · 下次起转生效', '#ffd166');
    if (replaced) this.parts.text(P.x, P.y - 100, '（顶掉了「' + replaced + '」）', '#ffd166');
    return true;
  };

  /**
   * 限次爆发（血刃）的命中回血：**每个转动窗口有总量上限**（`burst.healCap`）。
   * 返回这一次实际回了多少血（0 = 没在爆发 / 这个窗口已经吸满）。
   *
   * 为什么要封顶：一圈 60 只怪、每只每秒挨一刀 × 0.5 血 = 一个窗口 70+ 血 ——
   * 100 血的角色不封顶就是"两个窗口满血无敌"（方案阶段点名的风险）。
   * 封顶值写在 config 的 burst 里，面板/属性页读同一份，玩家能算出来。
   */
  Game.prototype.burstHeal = function () {
    var P = this.player, B = P.burst;
    if (!B || !B.active || !B.healPerHit) return 0;
    var left = (B.healCap || 0) - (B.healed || 0);
    if (left <= 0) return 0;
    var heal = Math.min(B.healPerHit, left);
    B.healed = (B.healed || 0) + heal;
    P.hp = Math.min(P.stats.maxhp, P.hp + heal);
    if (B.healed >= (B.healCap || 0) && !B.capNoticed) {      // 刚到上限：说一声，别让玩家以为回血坏了
      B.capNoticed = true;
      this.parts.text(P.x, P.y - 66, '吸血到上限', '#ff8f7a');
    }
    return heal;
  };

  /* ==================== 波次 ==================== */

  Game.prototype.tickWave = function () {
    if (this.cfg.trial.enabled) return;
    var cfg = this.cfg;
    var nw = Math.min(cfg.stage.wavesPerStage, 1 + Math.floor(this.stageKills / cfg.waves.killsPerWave));
    // 至少给一段杂兵战斗，且不在狂热刚开始时打断收割。
    if (!this.stageBossPending && nw >= cfg.stage.wavesPerStage &&
        (this.stageT < cfg.harvest.minBossSeconds || this.player.frenzy > 0)) nw = cfg.stage.wavesPerStage - 1;
    if (nw !== this.wave) this.wave = nw;
    if (this.bestWave < this.stage) this.bestWave = this.stage;   // 最高记录 = 打到过的最深关卡
  };

  Game.prototype.updateCamera = function () {
    var W = this.world.w, H = this.world.h;
    var zoom=this.cfg.camera?this.cfg.camera.zoom:1;
    var vw = this.viewport.w/zoom, vh = this.viewport.h/zoom;
    var x = this.player.x - vw / 2, y = this.player.y - vh / 2;
    this.cam.x = (W < vw) ? (W - vw) / 2 : Math.max(0, Math.min(W - vw, x));
    this.cam.y = (H < vh) ? (H - vh) / 2 : Math.max(0, Math.min(H - vh, y));
  };

  /**
   * 面板通用布局：按 rows 自上而下摆（矩形由核心层算，渲染和点击判定共用同一份）。
   * rows: [{ id, label, kind?, h }] → { panel, rows:[{x,y,w,h,kind,id,label}] }
   */
  function panelRects(vp, ins, rows, opts) {
    opts = opts || {};
    var w = Math.min(opts.maxW || 320, vp.w - 40);
    var pad = 22, gap = 10, titleH = 36;
    var body = 0, i;
    for (i = 0; i < rows.length; i++) body += rows[i].h + (i ? gap : 0);
    var h = titleH + body + pad;
    var x = Math.round((vp.w - w) / 2);
    /* 竖向居中，但不能顶到安全区、也不能溢出屏幕（矮屏优先保证不越界） */
    var y = Math.round(Math.max((ins.top || 0) + 12,
      Math.min(vp.h / 2 - h / 2, vp.h - h - 16 - (ins.bottom || 0))));
    var out = { panel: { x: x, y: y, w: w, h: h }, rows: [], title: opts.title || '' };
    var cy = y + titleH;
    for (i = 0; i < rows.length; i++) {
      out.rows.push({
        id: rows[i].id, label: rows[i].label, kind: rows[i].kind || 'btn',
        x: x + pad, y: cy, w: w - pad * 2, h: rows[i].h
      });
      cy += rows[i].h + gap;
    }
    return out;
  }

  /* ==================== 启动流程：首页 / 继续上次 / 重新开始 ====================
     为什么要有这一步（用户 2026-10 口径）：原来一进来就已经在打了（state='play'），
     玩家没有"我准备好了"的动作；而且存档是**静默恢复**的 —— 看不到"金币/装备回来了"，
     也没有"我想从头开始"的入口。 */

  /**
   * 切到首页。平台**启动**时调一次（opts.keep=false）；暂停面板的「回首页」也调它。
   *
   * ⚠️ opts.keep=false 是必须的：平台启动那一刻 state 也是 'play'（reset() 的默认值），
   *    先存一次就等于用一局空档把真正的存档冲掉 —— 首页会永远显示「继续上次」
   *    （实测抓到的 bug：死过之后重进游戏，居然还能"继续上次"）。
   *    只有从"真的在打"的地方回首页（暂停面板）才该存。
   */
  Game.prototype.toTitle = function (opts) {
    if (this.state === 'dead' || this.state === 'clear') this.track('settle_action', { detail: 'home' });
    else if (!opts || opts.keep !== false) this.track('run_leave', { detail: 'home' });
    /* 回首页前先存一次（此时 state 还是 play/paused ⇒ run 块会写进去），回来才能「继续上次」。
       从死亡界面回首页时 saveNow 不会写 run 块（见 saveNow 里的说明）—— 死了就是死了。 */
    if (!opts || opts.keep !== false) this.saveNow();
    this.ranked=false;this.rankOpen=false;
    this.reset();
    this.state = 'title';
    this.settingsOpen = false;
    this.loadResumeInfo();
    return true;
  };

  /** 读存档里有没有"没打完的那一局"（首页据此显示「继续上次」） */
  Game.prototype.loadResumeInfo = function () {
    var data = this.loadMeta();
    this.resumeData = (data && this.Save.hasRun(data)) ? data : null;
    this.pendingResume = this.resumeData ? this.resumeData.run : null;
    return this.pendingResume;
  };

  Game.prototype.hasResume = function () { return !!this.pendingResume; };

  /**
   * 开局。useResume=true → 接着没打完的那一局。
   * @returns 'resumed' | 'new' | 'failed'
   *   'failed' = 想续但存档里没有可续的（不崩，退化成开新局）
   */
  Game.prototype.rankRects=function(){
    var vp=this.viewport,ins=vp.insets||{},x=(ins.left||0)+20,y=(ins.top||0)+12,w=vp.w-x-(ins.right||0)-20,bottom=vp.h-(ins.bottom||0)-12;
    return {x:x,y:y,w:w,h:bottom-y,list:{x:x+12,y:y+78,w:w-24,h:bottom-y-140},
      back:{x:x+w-80,y:y,w:80,h:32,label:'返回'},
      challenge:{x:x+w/2-76,y:bottom-40,w:152,h:36,label:'开始游戏并计榜'},
      refresh:{x:x,y:bottom-40,w:70,h:36,label:'刷新'},
      prev:{x:x+w-148,y:bottom-40,w:70,h:36,label:'上一页'},
      next:{x:x+w-72,y:bottom-40,w:70,h:36,label:'下一页'}};
  };
  Game.prototype.startRanked=function(){
    if(this.ranking)this.ranking.post({type:"hide"});
    this.ranked=false;this.rankOpen=false;
    this.startRun(false);
    return 'ranked';
  };
  Game.prototype.finishRanked=function(completed){
    /* 榜单入口隐藏时（cfg.ui.rankOnTitle=false，2026-10 上线口径）**整块不参与**：
       不提交成绩、不产生 rankResult —— 否则死亡/通关结算上还会冒出一行
       "本局已结束 · 好友榜不可用"（榜单明明藏了，结算上又露一句，前后矛盾）。
       用时/击杀那两行照常显示：它们看的是 rankEligible，跟榜单无关。 */
    if(!this.cfg.ui.rankOnTitle)return;
    if(!this.rankEligible||this.rankResult||this.training)return;
    var stage=completed?4:Math.max(1,Math.min(3,this.wave)),t=this.trial||{},milestone=0,progress=0;
    if(!completed){
      var boss=this.foes.find(function(f){return f.kind==='boss'&&f.hp>0;});
      if(stage===3&&boss){milestone=1;progress=Math.min(999,Math.floor((1-boss.hp/boss.maxhp)*1000));}
      else{var quota=Math.ceil(this.cfg.trial.totals[stage-1]*(stage===1?.9:.8));progress=Math.floor(Math.min(1,(t.killed||0)/quota)*1000);if(stage===2&&t.eliteDead)milestone=1;}
    }
    var score={weapon:this.player.equip.weapon.kind,v:2,stage:stage,milestone:milestone,progress:Math.max(0,progress),ms:Math.max(100,Math.round((this.rankSeconds||0)*10)*100)};
    this.rankResult=this.ranking?this.ranking.submit(score):{ms:score.ms,text:'本局已结束 · 好友榜不可用'};
  };

  Game.prototype.tickRankClock=function(dt){
    if(this.rankEligible&&this.state==='play'&&!this.rankResult&&!this.training&&Number.isFinite(dt)&&dt>0)this.rankSeconds+=dt;
  };

  Game.prototype.track = function (event, detail) {
    if (!this.analytics || this.training || !this.analyticsRun) return;
    try { this.analytics.track(this, event, detail || {}); } catch (_) {}
  };

  Game.prototype.startRun = function (useResume) {
    if (this.state === 'dead' || this.state === 'clear') this.track('settle_action', { detail: 'again' });
    else if (this.state !== 'title') this.track('run_leave', { detail: 'restart' });
    this.ranked=false;
    var data = this.resumeData, out = 'new';
    /* ⚠️ 这里原来有一段"按 selectedWeapon 换开局武器"——那是首页开局武器按钮的落点。
       2026-10 用户口径：开局只能用默认那把（cfg.items.startWeapon），所以整段删掉，
       开局装备由 reset() 保证（别的武器要在局内打 Boss 掉）。 */
    this.reset();                                   // 干净一局（含按 keepOnDeath 接回金币/装备）
    if (useResume) out = this.Save.applyRun(this, data) ? 'resumed' : 'failed';
    this.rankEligible=true;this.rankResult=null;
    this.pendingResume = null;
    this.resumeData = null;
    this.settingsOpen = false;
    this.state = 'play';
    if (this.analytics) {
      try { this.analytics.begin(this, out === 'resumed'); } catch (_) {}
    }
    /* 立刻存一次：新局把旧的 run 块覆盖掉（这就是「重新开始」的含义），
       续局则把"已经开始打"这件事落盘。 */
    this.saveNow();
    return out;
  };

  /** 直接重开一局（R 键 / 面板上的「重新开始」「再来一次」）。
      首页上不响应 —— 那里有两个明确的按钮，不该被一个手势悄悄跳过。 */
  Game.prototype.restartRun = function () {
    if (this.state === 'title') return false;
    this.startRun(false);
    return true;
  };

  /** R 键允许生效的状态（免得打到一半误触把这一局清了） */
  Game.prototype.canRestart = function () {
    return this.state === 'dead' || this.state === 'paused' || this.state === 'clear';
  };

  /** 首页按钮（渲染和判定共用同一份矩形） */
  Game.prototype.titleRects = function () {
    var vp = this.viewport, ins = vp.insets || {};
    var bw = Math.min(280, vp.w - 110), bh = vp.h < 360 ? 40 : 48, gap = 8;
    var x = Math.round((vp.w - bw) / 2), main = [];
    var ty = (ins.top || 0) + Math.round((vp.h - (ins.top || 0) - (ins.bottom || 0)) * 0.14);
    if (this.hasResume()) {
      main.push({ id: 'continue', label: this.cfg.ui.resume, x: x, y: 0, w: bw, h: bh });
      main.push({ id: 'restart', label: this.cfg.ui.restart, x: x, y: 0, w: bw, h: bh });
    } else main.push({ id: 'start', label: this.cfg.ui.start, x: x, y: 0, w: bw, h: bh });
    var footerY = vp.h - (ins.bottom || 0) - 48;
    var blockH = main.length * bh + (main.length - 1) * gap;
    var y0 = Math.max(ty + 76, Math.min(vp.h * 0.57 - blockH / 2, footerY - 34 - blockH));
    for (var i = 0; i < main.length; i++) main[i].y = Math.round(y0 + i * (bh + gap));
    /* 底部那一排：游戏介绍 / 玩法说明 / 开局武器。宽度按**按钮数**重算
       （别再写死 /3 —— 以后再加按钮，右边那个会顶出屏幕）。
       ⚠️ 2026-10：「武器图鉴」这个按钮**已摘掉**。用户口径：「游戏首页的武器图鉴去掉，
       在游戏里面点击暂停后，弹出的菜单里面需要包含武器库」⇒ 四把武器的全部技能 /
       熟练度奖励改看**局内暂停 →「武器库」**。图鉴的代码（openCodex / codexRects /
       drawCodex / codexMasteryRows）一行没删，只是这里不给入口了 —— 想恢复就往
       infoDefs 里加回一行，别的地方不用动。 */
    var infoDefs = [
      { id: 'intro',   label: '游戏介绍' },
      { id: 'guide',   label: '玩法说明' },
      { id: 'loadout', label: '开局：' + this.startWeaponInfo().name }
    ];
    var igap = 8;
    var fw = Math.min(150, (vp.w - 40 - igap * (infoDefs.length - 1)) / infoDefs.length);
    var itotal = fw * infoDefs.length + igap * (infoDefs.length - 1);
    var ix0 = Math.round((vp.w - itotal) / 2);
    var infoBtns = infoDefs.map(function (d, idx) {
      return { id: d.id, label: d.label, x: Math.round(ix0 + idx * (fw + igap)),
               y: footerY, w: Math.round(fw), h: 36 };
    });
    /* 首页右上角那排（设置 / 试炼）也要避让微信**原生胶囊按钮**：
       它和游戏内暂停键是同一个角，以前同样被胶囊盖住（2026-10 真机）。左边那枚「好友排行榜」
       和它们同一行 —— 一起下移，否则两枚按钮一高一低。 */
    var sy = Math.max(16 + (ins.top || 0), this.menuReserveTop || 0), sw = 40;
    /* 试炼场入口（调试专用）：就摆在「设置」左边一个身位。**只在 debug.enabled 时才存在** ——
       正式版这里返回 null，渲染和判定都拿不到矩形，等于入口彻底消失。
       位置固定 = 不会误触（用户口径"从指定位置进去"）。 */
    var trial = this.cfg.debug && this.cfg.debug.enabled
      ? { id: 'trial', label: '试炼', x: vp.w - 56 - sw - 10 - (ins.right || 0), y: sy, w: sw, h: sw }
      : null;
    /* 调试提示那行：位置也放进 titleRects（渲染和断言共用一份）——
       它以前画在屏幕底部往上 18px 的位置，**正好压在底部按钮排上**（出图才发现的）。
       现在钉在按钮排上面 11px，并给个矩形让测试能断言"不许重叠"。 */
    var infoY = footerY;
    var hint = (this.cfg.debug && this.cfg.debug.enabled)
      ? { x: vp.w / 2, y: infoY - 11, w: 420, h: 14 }
      : null;
    return { main: main, titleY: ty, trial: trial, hint: hint,
      /* 好友排行榜入口（开关见 cfg.ui.rankOnTitle）：关掉时**返回 null** ——
         渲染层不画、updateTitle 也点不到，入口彻底消失；面板代码一行没删，开关打开就回来。 */
      rank: this.cfg.ui.rankOnTitle
        ? { x: 16 + (ins.left || 0), y: sy, w: 108, h: 36, label: "好友排行榜" }
        : null,
      settings: { id: 'settings', x: vp.w - 56 - (ins.right || 0), y: sy, w: sw, h: sw },
      info: infoBtns
    };
  };

  Game.prototype.infoRects = function () {
    var vp = this.viewport, ins = vp.insets || {}, pages = this.cfg.infoPages[this.infoOpen] || [];
    var w = Math.min(760, vp.w - (ins.left || 0) - (ins.right || 0) - 32);
    var x = (ins.left || 0) + (vp.w - (ins.left || 0) - (ins.right || 0) - w) / 2;
    var y = (ins.top || 0) + 10, h = vp.h - y - (ins.bottom || 0) - 10;
    var gap = 8, tabW = (w - 32 - gap * (pages.length - 1)) / pages.length;
    return { panel: { x: x, y: y, w: w, h: h },
      tabs: pages.map(function (p, i) { return { x: x + 16 + i * (tabW + gap), y: y + 48, w: tabW, h: 32, label: p.title }; }),
      body: { x: x + 24, y: y + 100, w: w - 48, h: h - 154 },
      back: { x: x + w - 126, y: y + h - 46, w: 110, h: 34, label: '返回首页' }
    };
  };

  Game.prototype.updateInfoPanel = function (p) {
    var r = this.infoRects();
    if (this.inRect(r.back, p)) { this.infoOpen = null; return true; }
    for (var i = 0; i < r.tabs.length; i++) if (this.inRect(r.tabs[i], p)) {
      this.infoPage = i; return true;
    }
    return true; // 模态界面吃掉其余点击，不能穿透到开始游戏。
  };

  /* ==================== 武器图鉴（2026-10） ====================
     用户连着两轮问的其实是同一件事：「一个地方能看到每把武器每级的熟练度奖励」+
     「一个地方能看到武器的所有技能」。所以做成一页，一把武器一个 tab，页内两块。
     为什么必须放在**首页**：局内那条路（暂停 →「换武器」→ 武器库 →「技能」页）只在
     手里 ≥2 把武器时才出现（pauseRects 里 `bag.length >= 2`），开局只有一把长剑、
     双刀要长剑熟练度 Lv4 才掉 ⇒ 绝大多数时候根本进不去，技能页等于没有。
     用户口径（2026-10）：Aa = 入口放首页底部按钮排；Ba = 技能**没拿到也显示完整描述**。
     ⚠️ 这里一个数据都不拼：技能走 `weaponSkillRows`、熟练度走 `masteryReward` +
     `cfg.mastery.levels`（和结算页 / 首页武器行同一个来源），渲染层只负责画。 */

  Game.prototype.openCodex = function (kind) {
    this.codexOpen = true;
    this.codexKind = kind || this.startWeaponInfo().kind;
    return true;
  };

  /** 图鉴矩形（渲染和判定共用一份，改布局只改一处）。style：'A' 上下两块 / 'B' 左右两块 */
  Game.prototype.codexRects = function (style) {
    style = style || this.codexStyle || 'A';
    var vp = this.viewport, ins = vp.insets || {};
    var w = Math.min(720, vp.w - (ins.left || 0) - (ins.right || 0) - 24);
    var x = Math.round((vp.w - w) / 2);
    var y = (ins.top || 0) + 8;
    var h = vp.h - y - (ins.bottom || 0) - 8;
    var kinds = Object.keys(this.cfg.weapons), tgap = 8;
    var tabW = Math.min(88, (w - tgap * (kinds.length - 1)) / kinds.length);
    var tabsW = tabW * kinds.length + tgap * (kinds.length - 1);
    var tabs = kinds.map(function (k, i) {
      return { kind: k, x: Math.round(x + (w - tabsW) / 2 + i * (tabW + tgap)),
               y: y + 8, w: Math.round(tabW), h: 30 };
    });
    /* ⚠️ body 要从 y+70 起，不是贴着页签 —— 页签下面那「武器名 + 手感」一行要自己的高度，
       贴着写会和两块的标题行（技能 / 熟练度）**叠字**（第一版就是这么出的图：
       左上角"技能"和"长剑"压在一起）。 */
    var body = { x: x + 12, y: y + 70, w: w - 24, h: h - 70 - 40 };
    var back = { x: x + w - 106, y: y + h - 36, w: 94, h: 32, label: '返回首页' };
    var gap = 12, skills, mastery;
    if (style === 'B') {                     // 左右两块
      var lw = Math.round((body.w - gap) * 0.62);
      skills  = { x: body.x, y: body.y, w: lw, h: body.h };
      mastery = { x: body.x + lw + gap, y: body.y, w: body.w - lw - gap, h: body.h };
    } else {                                 // 上下两块
      var sh = Math.round((body.h - gap) * 0.56);
      skills  = { x: body.x, y: body.y, w: body.w, h: sh };
      mastery = { x: body.x, y: body.y + sh + gap, w: body.w, h: body.h - sh - gap };
    }
    return { panel: { x: x, y: y, w: w, h: h }, tabs: tabs, body: body,
             skills: skills, mastery: mastery, back: back };
  };

  Game.prototype.updateCodex = function (p) {
    var r = this.codexRects(), i;
    if (this.inRect(r.back, p)) { this.codexOpen = false; return true; }
    for (i = 0; i < r.tabs.length; i++) if (this.inRect(r.tabs[i], p)) {
      this.codexKind = r.tabs[i].kind; return true;
    }
    return true;   // 模态页：吃掉其余点击，别穿透到「开始游戏」
  };

  /**
   * 图鉴的熟练度表：Lv1~LvN 每级的门槛 + 解锁内容。
   * `text` 为 null = 那一级的内容还没配（双刀现在就是）⇒ 面板留白，**不写"待开发"**
   * （用户口径：露"待开发"很难看，"敬请期待"又像画饼）。
   * ⚠️ `label` 也在这儿给（渲染层不许自己拼 "Lv" 字样，见 masteryShortText 那段说明）。
   */
  Game.prototype.codexMasteryRows = function (kind) {
    var cfg = this.cfg, L = (cfg.mastery && cfg.mastery.levels) || [0];
    var pts = this.masteryOf(kind), lv = this.Prog.masteryLevel(pts, cfg), out = [];
    for (var i = 0; i < L.length; i++) {
      var level = i + 1, rw = this.masteryReward(kind, level);
      out.push({
        level: level, label: 'Lv' + level,
        need: L[i], needText: L[i] > 0 ? L[i] + ' 点' : '起始',
        reached: pts >= L[i], current: level === lv,
        text: this.codexRewardText(rw)
      });
    }
    return out;
  };

  /**
   * 图鉴里"这一级给什么"的短文案。null = 内容还没定（面板留白）。
   * ⚠️ 和结算页那句（masteryRewardText）**故意不同**：那句是"下一级 Lv2：…"的叙述句，
   *    表格里每行都写"下一级"就乱了；但类别词只有这一处给，渲染层别自己拼。
   */
  Game.prototype.codexRewardText = function (rw) {
    if (!rw) return null;
    var label = '「' + (rw.label || rw.id) + '」';
    if (rw.kind === 'weapon') return '打完 Boss 有几率掉落 ' + label;
    if (rw.kind === 'skill') return '解锁专属技能 ' + label + '（精英掉落）';
    if (rw.kind === 'card') return '解锁专属机制卡 ' + label;
    return label;
  };

  /** 开局默认武器（一把）。所有"开局是哪把"的地方都读这里，别再各自写 'sword'。 */
  Game.prototype.startWeaponInfo = function () {
    var cfg = this.cfg;
    var kind = (cfg.items && cfg.items.startWeapon) || 'sword';
    if (!cfg.weapons[kind]) kind = 'sword';        // 配置写错别把开局弄崩：退回长剑
    return { kind: kind, name: cfg.weapons[kind].name };
  };

  /** 造**一件新的**开局武器（别把同一件塞两处：渲染层靠 === 认"当前那把"）。 */
  Game.prototype.makeStartWeapon = function () {
    var info = this.startWeaponInfo();
    var it = this.Prog.makeDefaultWeapon(this.cfg);
    it.kind = info.kind; it.name = info.name;
    return it;
  };

  /**
   * 首页「开局武器」面板（2026-10）：**只有默认那把是"你的"**，其他四把显示成锁着。
   * 用户口径原话：「开局的时候禁止玩家选择武器，只能有默认的长剑使用，其他变成不可选」。
   * 锁着的行要写明**哪一关的 Boss 掉** —— 只锁不解释就是"莫名其妙不能点"。
   * 已经拿到手的（上一局捡的）不写"未解锁"，写"局内武器库可切"（别把已得的说成没有）。
   */
  Game.prototype.loadoutRects = function () {
    var cfg = this.cfg, self = this;
    var start = this.startWeaponInfo().kind;
    var stages = (cfg.items && cfg.items.stageWeapons) || [];
    /* 反查"这把武器是靠哪把武器的熟练度解锁的"（长剑 Lv4 → 双刀）。
       面板文案必须和**真正发武器的地方**一致：2026-10 起试玩版（单关）的武器奖励
       统一走熟练度（rollStageWeapon 在试玩版返回 null，见那段说明），
       所以双刀不能再照 stageWeapons 写"第 1 关 Boss 掉落"——那是多关版的规则。
       ⚠️ 遗留：大剑/长枪/法杖 这三把现在只能靠多关版的 stageWeapons 拿，
          而试玩版走不到那条路 → 面板上它们写的还是"第 N 关 Boss 掉落"（暂时对不上）。
          这是"试玩版 vs 多关版"的落差，不在这次改动范围内，等版本定了一起处理。 */
    function unlockNoteFor(kind) {
      var R = cfg.mastery && cfg.mastery.rewards;
      if (!R) return null;
      for (var wk in R) {
        if (!Object.prototype.hasOwnProperty.call(R, wk)) continue;
        for (var lv in R[wk]) {
          var rw = R[wk][lv];
          if (rw && rw.kind === 'weapon' && rw.id === kind) {
            var wn = (cfg.weapons[wk] && cfg.weapons[wk].name) || wk;
            return wn + '熟练度 Lv' + lv + ' 后 · 打完 Boss 有几率掉落';
          }
        }
      }
      return null;
    }
    /* 熟练度读数（2026-10 用户选的方案 1：并进这个面板，零新增入口）：
       **只有配了熟练度奖励表的武器才写读数**。大剑/长枪/法杖 现在没有表
       （`cfg.mastery.rewards` 里没它们）—— 给它们写 `Lv1 · 0/300` 等于承诺"练了有奖励"，
       其实练到最后什么都不给；锁着的时候写清"怎么解锁"就够了。
       哪天给它们配了表，面板上自动就有读数（一处配置，别在渲染层另开名单）。 */
    function hasMastery(kind) {
      var R = cfg.mastery && cfg.mastery.rewards;
      return !!(R && R[kind]);
    }
    var rows = Object.keys(cfg.weapons).map(function (kind) {
      var cur = (kind === start), st = stages.indexOf(kind);
      var owned = (self.player.bag || []).some(function (it) { return it && it.kind === kind; });
      var mstr = null, next = null;
      if (hasMastery(kind)) {
        var mi = self.masteryInfo(kind);
        mstr = self.masteryShortText(mi);
        /* "下一级解锁什么"只给**当前手上这把**：面板每行只有一句说明的位置，
           其余行那句得用来说"这把怎么解锁"（已有口径，见上面 unlockNoteFor）。
           奖励内容还没定（双刀那种 null）时 masteryRewardText 返回 null → 不写 → 自动退回 note。 */
        if (cur) next = self.masteryRewardText(mi.maxed ? mi.rewardNow : mi.reward, mi.maxed);
      }
      return {
        id: kind, label: cfg.weapons[kind].name, h: 36,
        kind: cur ? 'current' : 'locked',
        mstr: mstr, next: next,
        note: cur ? '开局武器' : (owned ? '已获得 · 局内武器库可切'
          : (unlockNoteFor(kind) || (st >= 0 ? '第 ' + (st + 1) + ' 关 Boss 掉落' : '未解锁')))
      };
    });
    rows.push({ id: 'back', label: '知道了', h: 36, kind: 'btn', note: '' });
    /* 行高压到 36：6 行 + 标题在 812x375 的竖屏里刚好不顶到屏幕边，
       底下还留一条能"点面板外关掉"的地方（点外面关闭是这个面板唯一的退路）。 */
    var out = panelRects(this.viewport, this.viewport.insets || {}, rows, { maxW: 340, title: '开局武器' });
    /* ⚠️ panelRects 会**重建**行对象（只带 id/label/kind/x/y/w/h）—— 自定义字段要在这里显式透传，
       漏一个的表现是"字段在 loadoutRects 里明明有、出去就 undefined"，渲染层静默不画。 */
    for (var i = 0; i < out.rows.length; i++) {
      out.rows[i].note = rows[i].note;
      out.rows[i].mstr = rows[i].mstr;
      out.rows[i].next = rows[i].next;
    }
    return out;
  };

  Game.prototype.updateLoadoutPanel = function (p) {
    var r = this.loadoutRects(), i;
    for (i = 0; i < r.rows.length; i++) {
      if (!this.inRect(r.rows[i], p)) continue;
      var row = r.rows[i];
      if (row.id === 'back') { this.loadoutOpen = false; return true; }
      /* 锁着的四把：点了不动（面板也不关 —— 让人看清为什么不能选）。
         这就是"不可选"：**不做成按钮**，点了也没有任何后果。 */
      if (row.kind === 'locked') return true;
      this.loadoutOpen = false;      // 点当前那把 = 关掉
      return true;
    }
    if (!this.inRect(r.panel, p)) this.loadoutOpen = false;   // 点面板外 = 关掉
    return true;
  };

  /** 首页上的点按。设置面板开着时只认面板里的东西。 */
  Game.prototype.updateTitle = function (input) {
    var p = input.tap;
    if (!p) return false;
    if (this.infoOpen) return this.updateInfoPanel(p);
    if (this.codexOpen) return this.updateCodex(p);     // 武器图鉴（首页，2026-10）
    if (this.settingsOpen) return this.updateSettingsPanel(p);
    if (this.loadoutOpen) return this.updateLoadoutPanel(p);
    if(this.rankOpen){var R=this.rankRects();
      if(this.inRect(R.back,p)){this.rankOpen=false;if(this.ranking)this.ranking.post({type:"hide"});return true;}
      if(this.inRect(R.challenge,p)){this.startRanked();return true;}
      if(this.ranking){if(this.inRect(R.refresh,p))this.ranking.show(R.list);if(this.inRect(R.prev,p))this.ranking.page(-1);if(this.inRect(R.next,p))this.ranking.page(1);}return true;
    }
    var r = this.titleRects(), i;
    /* 排行榜入口：开关关掉时 r.rank 是 null，这里连同 inRect 一起短路（点原来的位置没反应） */
    if (r.rank && this.inRect(r.rank, p)) { this.rankOpen=true;if(this.ranking)this.ranking.show(this.rankRects().list);return true; }
    /* 试炼场（调试入口）：点了就**从首页直接进**（用户 2026-10 口径 B："不用先开局"）。
       矩形只有 debug.enabled 时才存在，所以正式版这里永远是 null。 */
    if (r.trial && this.inRect(r.trial, p)) { this.setTraining(true); return true; }
    if (this.inRect(r.settings, p)) { this.settingsOpen = true; return true; }
    for (i = 0; i < r.info.length; i++) if (this.inRect(r.info[i], p)) {
      /* 开局武器：**不再是"点一下换一把"**（用户 2026-10：「开局的时候禁止玩家选择武器，
         只能有默认的长剑使用，其他变成不可选」）。点开只是一个"交代"面板：
         默认那把亮着，其他四把锁着 + 写明哪一关的 Boss 掉。 */
      if (r.info[i].id === 'loadout') { this.loadoutOpen = true; return true; }
      if (r.info[i].id === 'codex') { this.openCodex(); return true; }   // infoDefs 里已没有 codex ⇒ 到不了这儿（图鉴页没删，只是没入口）
      this.infoOpen = r.info[i].id; this.infoPage = 0; return true;
    }
    for (i = 0; i < r.main.length; i++) {
      if (!this.inRect(r.main[i], p)) continue;
      this.startRun(r.main[i].id === 'continue');
      return true;
    }
    return false;
  };

  Game.prototype.settingsRects = function () {
    return panelRects(this.viewport, this.viewport.insets || {}, [
      { id: 'music',   kind: 'toggle', label: '音乐', h: 46 },
      { id: 'sound',   kind: 'toggle', label: '音效', h: 46 },
      { id: 'vibrate', kind: 'toggle', label: '震动', h: 46 },
      { id: 'back',    label: '返回', h: 46 }
    ], { maxW: 300, title: '设置' });
  };

  Game.prototype.updateSettingsPanel = function (p) {
    var r = this.settingsRects(), i;
    // Owner-only convenience: five quick taps on the settings heading open a local test-device switch.
    if (this.analytics && this.inRect({ x:r.panel.x, y:r.panel.y, w:r.panel.w, h:38 }, p)) {
      var now = Date.now();
      this.analyticsTapCount = now - (this.analyticsTapAt || 0) < 1200 ? (this.analyticsTapCount || 0) + 1 : 1;
      this.analyticsTapAt = now;
      if (this.analyticsTapCount >= 5) {
        this.analyticsTapCount = 0;
        try { this.analytics.configureTestDevice(); } catch (_) {}
      }
      return true;
    }
    this.analyticsTapCount = 0;
    for (i = 0; i < r.rows.length; i++) {
      if (!this.inRect(r.rows[i], p)) continue;
      if (r.rows[i].kind === 'toggle') { this.toggleSetting(r.rows[i].id); return true; }
      if (r.rows[i].id === 'back') { this.settingsOpen = false; return true; }
    }
    if (!this.inRect(r.panel, p)) this.settingsOpen = false;   // 点面板外 = 关掉
    return true;
  };

  /* ==================== 暂停 ====================
     两个入口：右上角的暂停键、切后台自动暂停（平台层调 pause()）。 */

  Game.prototype.pauseAvailable = function () {
    return this.state === 'play' && !this.training;
  };

  /** 暂停键矩形（右上角，避开安全区）。注意 HUD 的击杀/金币卡会给它让位（见 renderer）。 */
  Game.prototype.pauseBtnRect = function () {
    var vp = this.viewport, ins = vp.insets || {};
    var size = 40;
    /* ⚠️ y 要避开**微信原生胶囊按钮**（右上角 ⋯／⊙）：safeArea 只管刘海/底部横条，
       管不到胶囊 —— 胶囊是平台自己画在最上层的东西，撞上就是"点了暂停弹出退出菜单"。
       胶囊矩形由平台层 wx.getMenuButtonBoundingClientRect() 量出来传进来（见 setMenuReserve）；
       工具/网页端拿不到 → reserve 为 0，版式和以前一样。 */
    var y = Math.max(12 + (ins.top || 0), this.menuReserveTop || 0);
    return { x: vp.w - 16 - (ins.right || 0) - size, y: y, w: size, h: size };
  };

  /** 平台层量到的"右上角必须让开的高度"（胶囊底 + 间距）。0 = 没有胶囊（网页/开发者工具）。 */
  Game.prototype.setMenuReserve = function (r) {
    this.menuReserveTop = (r && r.top) || 0;
    return this.menuReserveTop;
  };

  Game.prototype.pause = function () {
    if (!RUN_STATES[this.state]) return false;
    if (this.state !== 'paused') this.pausedFrom = this.state;
    this.state = 'paused';
    this.pauseGuard = 0.15;      // 点暂停键那一下别顺手点到"继续"
    this.saveNow();              // 切后台随时可能被杀掉，先落盘
    return true;
  };

  Game.prototype.resume = function () {
    if (this.state !== 'paused') return false;
    this.state = this.pausedFrom || 'play';
    this.pausedFrom = null;
    this.pauseGuard = 0.15;
    return true;
  };

  Game.prototype.pauseRects = function () {
    /* ⚠️ 2026-10 大改（用户口径：「首页的武器图鉴去掉，点暂停后弹出的菜单里要包含武器库」）：
       · 第一行从「换武器」改名「武器库」，并且**去掉 ≥2 把武器的门槛** —— 恒显。
         原来那行只在手里两把以上才出现（开局只有一把长剑、双刀要长剑熟练度 Lv4 才掉）
         ⇒ "进去看技能/属性"这条路大多数时候根本不存在。
         一把武器时它是"查看"入口，两把以上才是"换"（面板内部逻辑一点没变，还是那个 state='bag'）。
       · 音乐/音效/震动 三行并成一行三个小开关（用户选的 4a）。**不是为了好看，是必须**：
         多一行「武器库」= 7 行 = 434px，横屏 812x375 直接出屏 70px（最后两行被切掉）。
         并成一行后 5 行 = 328px，比改动前（6 行 378px）还矮，横竖屏都放得下。
       ⚠️ 关掉武器库回的是**暂停面板**（不是直接继续），见 closeBag。 */
    var rows = [];
    rows.push({ id: 'bag',     label: '武器库', h: 46 });
    rows.push({ id: 'resume',  label: '继续', h: 46 });
    rows.push({ id: 'restart', label: this.cfg.ui.restart, h: 46 });
    rows.push({ id: 'home',    label: '回首页', h: 46 });
    rows.push({ id: 'switches', kind: 'switches', h: 46 });
    var R = panelRects(this.viewport, this.viewport.insets || {}, rows, { maxW: 300, title: '已暂停' });
    /* 三个开关的子矩形挂在那一行上（核心层算，渲染层只画 —— 改布局只改 pauseSwitchRects 一处） */
    for (var i = 0; i < R.rows.length; i++) {
      if (R.rows[i].kind === 'switches') R.rows[i].toggles = this.pauseSwitchRects(R.rows[i]);
    }
    return R;
  };

  /**
   * 暂停面板里那一行的三个小开关（音乐 / 音效 / 震动）—— 渲染和判定共用同一份矩形。
   * 每个开关是"标签 + 开/关"两行字的淡色小卡片，不是实心胶囊（用户口径：表现要小要淡）。
   */
  Game.prototype.pauseSwitchRects = function (row) {
    var defs = [{ id: 'music', label: '音乐' }, { id: 'sound', label: '音效' }, { id: 'vibrate', label: '震动' }];
    var gap = 8, ch = row.h - 10, cy = row.y + 5;
    var cw = (row.w - gap * (defs.length - 1)) / defs.length;
    return defs.map(function (d, i) {
      return { id: d.id, label: d.label, toggle: true, h: ch,
               x: Math.round(row.x + i * (cw + gap)), y: cy, w: Math.round(cw) };
    });
  };

  Game.prototype.updatePaused = function (input) {
    var p = input.tap;
    if (!p) return false;
    if (this.pauseGuard > 0) return false;        // 护栏在 update() 开头统一递减
    var r = this.pauseRects(), i, k;
    for (i = 0; i < r.rows.length; i++) {
      var b = r.rows[i];
      /* 合并后的开关行：一行三个小开关，各自有自己的热区（这一行本身不是按钮） */
      if (b.kind === 'switches') {
        var ts = b.toggles || [];
        for (k = 0; k < ts.length; k++) if (this.inRect(ts[k], p)) { this.toggleSetting(ts[k].id); return true; }
        continue;
      }
      if (!this.inRect(b, p)) continue;
      /* 武器库：暂停面板第一行，**唯一入口**（左下角那个 HUD 按钮 2026-10 已删）。
         ⚠️ openBag 会自己把 bagGuard 立起来挡连点，这里不用另外加护栏。 */
      if (b.id === 'bag') { this.openBag(); return true; }
      if (b.id === 'resume') return this.resume();
      if (b.id === 'restart') { this.startRun(false); return true; }
      if (b.id === 'home') { this.toTitle(); return true; }
    }
    return false;
  };

  /* ==================== 设置（音乐 / 音效 / 震动） ====================
     存在存档里；平台层的音效/震动适配器每帧读 game.settings（见 platform 下各端适配器）。
     核心层只管"值是多少"，怎么静音/怎么震/怎么放音乐是平台的事。 */
  Game.prototype.toggleSetting = function (id) {
    if (id !== 'sound' && id !== 'vibrate' && id !== 'music') return null;
    this.settings[id] = !this.settings[id];
    this.saveNow();
    return this.settings[id];
  };
  Game.prototype.toggleSound = function () { return this.toggleSetting('sound'); };

  /* ==================== BGM：现在该放哪一首 ====================
     判定只写在这里一处（平台层每帧问一次，幂等）。规则：
       · cfg 里禁用 / 玩家关了音乐 → null（平台层会淡出）
       · 场上有 Boss（bossAlive > 0）且配了 boss 曲 → 'boss'
       · 否则 → 'stage'（**首页也放**：一进游戏就有声，不用等开局）
     ⚠️ 返回值里没有"暂停"这个概念 —— 切后台/来电话要不要停音乐是平台层的事
        （platform/wechat/audio.js 的 BGM 通道自己跟 onHide/中断），
        核心层不该知道"音频被系统抢走了"这种事。
     ⚠️ boss 曲路径可以是 null（还没做）：那就自动退回 stage，不会静音。 */
  Game.prototype.bgmTrack = function () {
    var bgm = this.cfg.audio && this.cfg.audio.bgm;
    if (!bgm || !bgm.enabled || !this.settings.music) return null;
    if (this.bossAlive > 0 && bgm.tracks.boss) return 'boss';
    return bgm.tracks.stage ? 'stage' : null;
  };

  /* ==================== 死亡结算（按钮 + 分享 + 广告） ====================
     设计取舍：以前是"点屏幕任意处重开"，现在结算上有好几个按钮了，
     任意处重开会和「晒战绩」「看视频复活」抢同一个手势 —— 所以改成明确的按钮。 */

  /** 结算页布局：文字块在中间偏上，按钮自下而上排（拇指够得着） */
  Game.prototype.deadRects = function () {
    var vp = this.viewport, ins = vp.insets || {};
    var w = Math.min(340, vp.w - 48);
    var x = Math.round((vp.w - w) / 2);
    var gap = 10, i, rows = [];

    /* 广告按钮只在"真的配了广告位"时存在（cfg.ads.enabled 默认 false） */
    if (this.adsReady() && this.reviveLeft() > 0) {
      rows.push({ id: 'revive', kind: 'ad', label: '看视频复活（剩 ' + this.reviveLeft() + ' 次）', h: 46 });
    }
    if (this.adsReady() && this.cfg.ads.doubleGold && !this.doubled) {
      rows.push({ id: 'double', kind: 'ad', label: '看视频 · 金币 ×2', h: 46 });
    }
    rows.push({ id: 'again', kind: 'primary', label: '再来一次', h: 50 });
    var sec = [{ id: 'home', label: '回首页', h: 46 }];
    if (this.shareReady()) sec.push({ id: 'share', label: '晒战绩', h: 46 });

    var btnH = 0;
    for (i = 0; i < rows.length; i++) btnH += rows[i].h + gap;
    btnH += 46;                                  // 次级行（并排）
    var totalH = DEAD_TEXT_H + 12 + btnH;
    /* 整块居中；矮屏时优先保证不越界（宁可往上顶一点，也不要溢出被人挡住） */
    var top = Math.round(Math.max((ins.top || 0) + 10,
      Math.min(vp.h / 2 - totalH / 2, vp.h - totalH - 16 - (ins.bottom || 0))));

    var out = { textTop: top, textH: DEAD_TEXT_H, rows: [] };
    var cy = top + DEAD_TEXT_H + 12;
    for (i = 0; i < rows.length; i++) {
      out.rows.push({ id: rows[i].id, kind: rows[i].kind, label: rows[i].label, x: x, y: cy, w: w, h: rows[i].h });
      cy += rows[i].h + gap;
    }
    var half = (w - gap) / 2;
    for (i = 0; i < sec.length; i++) {
      out.rows.push({
        id: sec[i].id, kind: 'btn', label: sec[i].label,
        x: x + i * (half + gap), y: cy, w: sec.length > 1 ? half : w, h: sec[i].h
      });
    }
    return out;
  };

  Game.prototype.updateDeadPanel = function (input) {
    var p = input.tap;
    if (!p) return false;
    var r = this.deadRects(), i;
    for (i = 0; i < r.rows.length; i++) {
      var b = r.rows[i];
      if (!this.inRect(b, p)) continue;
      if (b.id === 'again') { this.startRun(false); return true; }
      if (b.id === 'home') { this.toTitle(); return true; }
      if (b.id === 'share') { this.shareNow(); return true; }
      if (b.id === 'revive') { this.requestReward('revive'); return true; }
      if (b.id === 'double') { this.requestReward('double'); return true; }
    }
    return false;      // 点空白：什么都不做（看见按钮才点得准，不给"任意处重开"）
  };

  /* ---- 分享（可选适配器：平台不注入就没有这个按钮） ---- */

  Game.prototype.shareReady = function () {
    return !!(this.cfg.share.enabled && this.share && this.share.share);
  };

  /** 分享文案。{stage}/{kills} 在核心层替换 —— 内容归核心层，平台只管发出去。 */
  Game.prototype.shareText = function (text) {
    var t = text || this.cfg.share.title || '';
    return t.replace('{stage}', String(this.stage))
            .replace('{kills}', String(this.player.kills))
            .replace('{gold}', String(this.player.gold));
  };

  Game.prototype.shareNow = function () {
    if (!this.shareReady()) return false;
    try {
      this.share.share({ title: this.shareText(), stage: this.stage, kills: this.player.kills });
      this.emit('share', { x: this.player.x, y: this.player.y });
      return true;
    } catch (e) { return false; }
  };

  /* ---- 广告（可选适配器：没配广告位就整个不出现） ----
     ⚠️ 激励视频要先去微信后台开通流量主才拿得到广告位 id，所以默认是关的。
        核心层只负责"什么时候该给什么"，播哪条视频、失败了怎么办，全在平台适配器里。 */

  Game.prototype.adsReady = function () {
    if(this.ranked)return false;
    return !!(this.cfg.ads.enabled && this.ads && this.ads.showRewarded);
  };

  Game.prototype.reviveLeft = function () {
    if(this.ranked)return 0;
    return Math.max(0, (this.cfg.ads.revivePerRun || 0) - (this.revives || 0));
  };

  /**
   * 请求播一条激励视频（kind: 'revive' | 'double'）。
   * ok 由平台回调 —— **看完才算数**（中途关掉什么都不给）。
   */
  Game.prototype.requestReward = function (kind) {
    if(this.ranked)return false;
    if (!this.adsReady() || this.adPending) return false;
    if (kind === 'revive' && (this.state !== 'dead' || this.reviveLeft() <= 0)) return false;
    if (kind === 'double' && (this.state !== 'dead' || this.doubled || !this.cfg.ads.doubleGold)) return false;
    var self = this, done = false;
    this.adPending = kind;
    function finish(ok) {
      if (done) return;                    // 平台重复回调（onClose + onError）只认第一次
      done = true;
      self.adPending = null;
      self.onReward(kind, !!ok);
    }
    try {
      this.ads.showRewarded(kind, finish);
    } catch (e) {
      finish(false);
      return false;
    }
    return true;
  };

  Game.prototype.onReward = function (kind, ok) {
    if (!ok) return false;                 // 没看完（提前关掉/失败）→ 什么都不给
    if (kind === 'revive') return this.revivePlayer();
    if (kind === 'double') return this.doubleDeathGold();
    return false;
  };

  /** 复活：半血 + 清掉身边的威胁 + 2 秒无敌，回到 'play' */
  Game.prototype.revivePlayer = function () {
    var P = this.player, cfg = this.cfg;
    if (this.state !== 'dead' || this.reviveLeft() <= 0) return false;
    this.revives++;
    this.track('run_revive');
    this.rankResult=null; // Continued progress after revival may improve the recorded result.
    P.dead = false;
    P.hp = Math.max(1, Math.round(P.stats.maxhp * (cfg.ads.reviveHpPct || 0.5)));
    P.inv = Math.max(P.inv, 2.0);
    this.clearFieldNear(P.x, P.y, 460);
    this.state = 'play';
    this.hitstop = 0;
    this.quakePulse = null; this.flameCd = 0;
    this.lowHpAlarm = false; this.lowHpTimer = 0;    // 复活回半血：低血档要重新判定（否则残留状态会立刻再响）
    this.skillCooldowns = {}; this.skillHitCounts = {};
    this.skillVisuals = []; this.skillFields = []; this.skillShadow = null; this.skillDash = null;
    this.skillEchoSwords = []; this.skillEchoStrike = null;   // 剑阵回响：换场景必须清场
    this.skillActiveKind = null; this.skillQuakePending = false;
    this.pauseGuard = 0.2;
    /* 借用升级那套"亮一下 + 炸一圈"的反馈：复活必须看得出来（不然像卡了个 bug） */
    this.emit('levelup', { x: P.x, y: P.y });
    this.saveNow();
    return true;
  };

  /** 看广告：这一局的金币 ×2（一局只能用一次） */
  Game.prototype.doubleDeathGold = function () {
    if (this.state !== 'dead' || this.doubled || !this.cfg.ads.doubleGold) return false;
    this.doubled = true;
    this.player.gold += this.player.runGold || 0;
    this.emit('pickup', { x: this.player.x, y: this.player.y });
    this.saveNow();
    return true;
  };

  /** 清掉玩家附近的威胁（复活/续局用）：近处的怪直接移走，弹幕和地面威胁全清 */
  Game.prototype.clearFieldNear = function (x, y, r) {
    for (var i = this.foes.length - 1; i >= 0; i--) {
      var f = this.foes[i];
      if (!f) continue;                                  // 循环途中数组可能缩短
      if (Math.hypot(f.x - x, f.y - y) <= r) this.foes.splice(i, 1);
    }
    this.projectiles.length = 0;
    this.hazards.length = 0;
    this.hazardT = this.cfg.hazards.startAt;
  };

  /* Weapon cards: all secondary hits use 'skill', so they never recursively proc. */
  function segmentDistance(x, y, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    var t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  }

  /* ==================== 武器熟练度（2026-10） ====================
     数值与"为什么是这组数"的推导全在 config.mastery 那一段，这里只有四个动作：
       读 masteryOf / masteryInfo　　加 gainMastery　　查奖励 masteryReward
     ⚠️ 三条口径（踩过一次就别再踩）：
       ① 熟练度**不吃 keepOnDeath**（连 'none' 也留）—— 它是元进度，不是这一局的战利品。
          落点在 save.applyMeta 里、那个 early return **之前**。
       ② 等级**不存盘**，由点数算出来（Progression.masteryInfo）。存了就有两份数据。
       ③ 精英那笔是**击杀当场入账 + 立刻存盘**，所以必须配 `once` 去重键 ——
          否则"打死精英 → 强杀进程 → 首页继续上次"能反复领同一只。 */

  /** 某把武器（默认手上这把）的熟练度点数 */
  Game.prototype.masteryOf = function (kind) {
    kind = kind || this.weaponKind();
    var P = this.player;
    if (!P.mastery) P.mastery = {};
    return Math.max(0, Math.floor(P.mastery[kind] || 0));
  };

  /** 面板要的一整套读数（等级 / 本级区间 / 本局拿到多少 / 下一级解锁什么） */
  Game.prototype.masteryInfo = function (kind) {
    kind = kind || this.weaponKind();
    var info = this.Prog.masteryInfo(this.masteryOf(kind), this.cfg);
    info.kind = kind;
    info.name = (this.cfg.weapons[kind] && this.cfg.weapons[kind].name) || kind;
    info.gainedRun = Math.max(0, Math.floor((this.player.masteryGainRun || {})[kind] || 0));
    info.reward = this.masteryReward(kind, info.level + 1);      // 满级时不存在这一级 → null
    if (info.reward) info.reward = Object.assign({}, info.reward, { level: info.level + 1 });
    /* 满级时"下一级"没有了，面板要改说**本级已经拿到的那个奖励**（满级奖励）。
       两条都带上，渲染层按 maxed 挑一条画 —— 别让面板在满级时那行空掉。 */
    info.rewardNow = this.masteryReward(kind, info.level);
    if (info.rewardNow) info.rewardNow = Object.assign({}, info.rewardNow, { level: info.level });
    return info;
  };

  /**
   * 熟练度奖励 → 一句话（渲染层直接用，**别各自拼字符串**）。null = 奖励内容还没定，那半行不画。
   *
   * 2026-10 用户口径（原话「结算页面还得优化, 写清楚, 下一级:解锁剑阵回响专属技能 这种描述」）：
   * 这句话要把四件事**一次说全**：这是第几级 / 解锁（不是"变强一点"）/ 是什么类别 / 具体叫什么。
   * 之前的写法是未满级那支在渲染层自己拼的 `→ Lv2 · 剑阵回响` —— 只有个名字，
   * 玩家看不出它是技能还是卡（`→ Lv3 · 叠刃` 更看不出）；而**满级那支早就调了这个函数**、
   * 说得很清楚 ⇒ 同一个位置两套写法，用户就是从这儿觉得"没写清楚"的。
   * 现在两支都走这里，句式统一；名字统一加「」，类别词按 kind 给。
   *
   * ⚠️ 长度：那半行的可用宽度约 258px（块自身只占 180，但那一行的右半边是空的、可以借到面板右缘；
   *    满级那句实测 221px 就是这么放下的）⇒ 10px 字号下约 20~23 个汉字。
   *    渲染层有"超了就降字号"的兜底，但**加新奖励前先按这个预算算一遍长度**。
   */
  Game.prototype.masteryRewardText = function (rw, atMax) {
    if (!rw) return null;
    var label = '「' + (rw.label || rw.id) + '」';
    var head = atMax ? '满级奖励：' : '下一级 Lv' + rw.level + '：';
    if (rw.kind === 'weapon') return head + '打完 Boss 有几率掉' + label;
    if (rw.kind === 'skill') return head + '解锁专属技能' + label;
    if (rw.kind === 'card') return head + '解锁专属机制卡' + label;
    return head + label;
  };

  /**
   * 行内**紧凑读数**（首页「开局武器」面板每行右上角，2026-10 用户选的方案 1）。
   * 例：`Lv2 · 150/300`；满级 `Lv4 · 满级`。
   * ⚠️ 和结算页那块**共用一个来源**：等级/点数都来自 `masteryInfo`（再往上是 config 的门槛表），
   *    渲染层不许自己算等级、也不许自己拼 `Lv` 字样 —— "同一个数写两处"已经栽过四次
   *    （开天半径 / 千刃刃数 / 叠刃刃数 / 熟练度奖励文案）。
   * ⚠️ 分母是**本级上限**（mi.to），跟结算页一致；满级时 mi.to == mi.from，写 `满级` 而不是数字。
   */
  Game.prototype.masteryShortText = function (mi) {
    if (!mi) return null;
    if (mi.maxed) return 'Lv' + mi.level + ' · 满级';
    return 'Lv' + mi.level + ' · ' + mi.pts + '/' + mi.to;
  };

  /** 某把武器的熟练度是否已经到 `level` 级（卡的 masteryMin / 技能的解锁都用它） */
  Game.prototype.masteryUnlocked = function (kind, level) {
    var L = (this.cfg.mastery && this.cfg.mastery.levels) || [0];
    var need = L[level - 1];
    return need !== undefined && this.masteryOf(kind) >= need;
  };

  /** 某把武器到某一级解锁什么。返回 null = 还没定（双刀就是这种）——
      面板靠这个 null 决定**不画**"下一级解锁"那一行（露出"待开发"很难看）。 */
  Game.prototype.masteryReward = function (kind, level) {
    var R = this.cfg.mastery && this.cfg.mastery.rewards;
    var w = R && R[kind];
    return (w && w[level]) || null;
  };

  /**
   * 加熟练度。
   * @param once 一局之内的去重键（'elite:教学' / 'elite:1' / 'clear'）。
   *   同一个键第二次调用会被挡掉并返回 0 —— 这就是"重复领"的护栏。
   *   传 null/undefined 表示"不用去重"（目前没有这种调用，留着给以后的来源）。
   * @return 实际加进去的点数（被挡掉 = 0）
   */
  Game.prototype.gainMastery = function (amount, once, kind) {
    var cfg = this.cfg, M = cfg.mastery, P = this.player;
    if (!M || !(amount > 0)) return 0;
    kind = kind || this.weaponKind();
    if (!cfg.weapons[kind]) return 0;
    if (once) {
      if (!this.masteryClaimed) this.masteryClaimed = {};
      if (this.masteryClaimed[once]) return 0;
      this.masteryClaimed[once] = true;
    }
    var before = this.masteryOf(kind);
    P.mastery[kind] = before + amount;
    P.masteryGainRun = P.masteryGainRun || {};
    P.masteryGainRun[kind] = (P.masteryGainRun[kind] || 0) + amount;

    var wname = (cfg.weapons[kind] && cfg.weapons[kind].name) || kind;
    var lvBefore = this.Prog.masteryLevel(before, cfg);
    var lvAfter = this.Prog.masteryLevel(P.mastery[kind], cfg);
    /* 即时反馈：核心层直接飘字（和别处一样，渲染层不参与）。
       升级那一下多一行 —— 结算页那块是"结果"，这里是"当下"。 */
    if (this.parts) {
      this.parts.text(P.x, P.y - 84, wname + ' 熟练度 +' + amount, '#ffd166');
      if (lvAfter > lvBefore) {
        this.parts.text(P.x, P.y - 106, wname + '熟练度 Lv' + lvAfter, '#8fd6a5');
        this.parts.burst(P.x, P.y, '#8fd6a5', 16);
        this.emit('masteryUp', { kind: kind, level: lvAfter });
      }
    }
    /* ⚠️ **立刻存盘**：精英那笔是击杀当场入账的，不马上落盘的话"打死精英 → 强杀进程"
       会把这笔点丢掉 —— 那是玩家的净损失，比"重复领"更不可接受。 */
    this.saveNow();
    return amount;
  };

  /**
   * 某一级的"掉一把武器"奖励（长剑 Lv4 → 双刀）。三条口径：
   *   ① 只有**当前等级挂着 kind:'weapon' 奖励**的武器才可能掉
   *   ② **有几率**（config 里的 chance），不是必掉
   *   ③ 武器库里**已经有这把**就不再掉 —— 反复掉重复武器没意义
   * 掉落照旧走 Boss 那条管线（rollItem + makePickup 掉在地上），
   * 过一会儿 updateClear 的 collectAll() 会把它收进武器库 —— 不另写一条入库路径。
   * @return 掉出来的物品（没掉 = null）
   */
  Game.prototype.grantMasteryWeaponReward = function () {
    var cfg = this.cfg, kind = this.weaponKind(), P = this.player;
    var lv = this.Prog.masteryLevel(this.masteryOf(kind), cfg);
    var rw = this.masteryReward(kind, lv);
    if (!rw || rw.kind !== 'weapon' || !cfg.weapons[rw.id]) return null;
    if ((P.bag || []).some(function (it) { return it && it.kind === rw.id; })) return null;
    if (Math.random() >= (rw.chance || 0)) return null;
    var item = this.Prog.rollItem(cfg, this.wave, { allowWeapon: true, weaponChance: 1, forceKind: rw.id });
    this.pickups.push(this.Entities.makePickup('item', P.x, P.y, item));
    this.parts.text(P.x, P.y - 72, '满级奖励 · ' + (rw.label || rw.id), '#ffd166');
    this.emit('masteryDrop', { kind: kind, id: rw.id });
    return item;
  };

  Game.prototype.hasWeaponSkill = function (id) {
    if (!this.player.taken[id]) return false;
    for (var i = 0; i < this.cfg.upgrades.length; i++) {
      var u = this.cfg.upgrades[i];
      if (u.id === id) return u.weapon === this.weaponKind();
    }
    return false;
  };

  Game.prototype.skillAim = function () {
    var P = this.player, best = 520 * 520, target = null;
    for (var i = 0; i < this.foes.length; i++) {
      var f = this.foes[i], dx = f.x - P.x, dy = f.y - P.y, d = dx * dx + dy * dy;
      if (f.hp > 0 && d < best) { best = d; target = f; }
    }
    return target ? Math.atan2(target.y - P.y, target.x - P.x) : P.face;
  };

  Game.prototype.playerShotCount = function () {
    var n = 0;
    for (var i = 0; i < this.projectiles.length; i++) if (this.projectiles[i].owner === 'player') n++;
    return n;
  };

  Game.prototype.skillShot = function (x, y, angle, speed, damage, shape, color) {
    if (this.cfg.trial.enabled && shape) damage *= 0.65;
    if (this.playerShotCount() >= this.cfg.skillLimits.projectiles) return null;
    var p = this.Entities.makeProjectile(x, y, angle, speed, damage, shape === 'wave' ? 18 : 9, color, 'player');
    p.skillWeapon = this.weaponKind(); p.skillShape = shape; p.pierce = shape === 'wave' ? 4 : 0;
    p.life = 1.2; this.projectiles.push(p); return p;
  };

  Game.prototype.skillVisual = function (v) {
    if (this.skillVisuals.length >= this.cfg.skillLimits.visuals) this.skillVisuals.shift();
    v.t = 0; v.life = v.life || 0.25; this.skillVisuals.push(v);
  };

  Game.prototype.skillLine = function (x, y, x2, y2, width, damage, color, hits) {
    hits = hits || [];
    var targets = this.foes.slice();
    for (var i = 0; i < targets.length; i++) {
      var f = targets[i];
      if (f.hp > 0 && hits.indexOf(f) < 0 && segmentDistance(f.x, f.y, x, y, x2, y2) <= width / 2 + f.r) {
        hits.push(f); this.damageFoe(f, damage, 60, 'skill');
      }
    }
    this.skillVisual({ kind: 'line', x: x, y: y, x2: x2, y2: y2, width: width, color: color });
  };

  Game.prototype.skillHeavySlash = function () {
    var P = this.player, angle = this.skillAim(), radius = 175, targets = this.foes.slice();
    for (var i = 0; i < targets.length; i++) {
      var f = targets[i], dx = f.x - P.x, dy = f.y - P.y;
      var diff = Math.atan2(Math.sin(Math.atan2(dy, dx) - angle), Math.cos(Math.atan2(dy, dx) - angle));
      if (f.hp > 0 && Math.hypot(dx, dy) <= radius + f.r && Math.abs(diff) <= 1.05)
        this.damageFoe(f, P.stats.attackDamage * 3.5, 220, 'skill', angle);
    }
    this.skillVisual({ kind: 'cone', x: P.x, y: P.y, angle: angle, radius: radius, color: '#ffdb8a', life: 0.3 });
    this.emit('skillHeavy', { x: P.x, y: P.y });
  };

  Game.prototype.recordSkillHit = function () {
    if (this.hasWeaponSkill('greatsword_quake')) {
      var n = (this.skillHitCounts.quake || 0) + 1;
      if (n >= 4) { n = 0; this.skillQuakePending = true; }
      this.skillHitCounts.quake = n;
    }
    if (this.hasWeaponSkill('dagger_shadow')) {
      var count = (this.skillHitCounts.shadow || 0) + 1;
      if (count >= 5 && !this.skillShadow) {
        count = 0; this.skillShadow = { life: 2, tick: 0, x: this.player.x, y: this.player.y };
        this.parts.text(this.player.x, this.player.y - 70, '影分身！', '#8fffea');
      }
      this.skillHitCounts.shadow = Math.min(5, count);
    }
  };

  /* ==================== 剑阵回响（长剑技能，熟练度 Lv2 解锁） ====================
     用户设计原话："走过的路，变成你的杀招"：每完成一次普通攻击在脚下留一把虚幻小剑，
     三把连成三角区域，短暂预警后同时向内斩击一次；绕着怪群移动，把怪引进自己布的剑阵。
     用户自己定的三条限制（逐条落到代码）：
       ① 「限制三角形最大范围」→ echoArmStrike 里的 maxR 等比压缩
       ② 「三把剑靠得太近时只形成小范围攻击，站着不动收益低」→ **故意不设最小值**：
          三个点挨在一起就是一个面积 ≈ 0 的三角，判定几乎打不到怪。这是设计，不是 bug
       ③ 「不持续伤害、不无限留剑」→ 斩击一次性（没有 tick）、三把触发即清
          ⇒ 场上最多 3 把剑 + 1 次斩击，零性能负担
     ⚠️ 换武器要清场：地上的剑和"正在预警的三角"都跟着长剑走
        （照 skillFields/skillShadow 那套，见 updateWeaponSkills 里 skillActiveKind 那段）。 */

  /** 三角面积（叉积一半，取绝对值）。退化判定用它 —— 别去比"三点是否相等"，
      浮点下差 1e-9 也会让符号判定翻面。 */
  function triArea(a, b, c) {
    return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }
  var TRI_EPS = 1e-6;      // 面积小于它 = 退化（三点共线 / 重合）

  /**
   * 点是否在三角形内（重心符号法；落在边上算命中 —— 贴着边站的怪不该被漏掉）
   *
   * ⚠️⚠️ **退化三角（面积 ≈ 0）必须直接返回 false。**
   * 三点共线/重合时，三条边的符号**全是 0** ⇒ `!(neg && pos)` 对**平面上任何一点**都成立
   * —— 也就是"全图每一只怪都算在阵里"。本项目实测（2026-10，用户报的
   * 「我如果站着不动, 剑阵的刺会攻击所有人」）：站着不动 ⇒ 三把剑落在同一个坐标
   * ⇒ 面积正好 0 ⇒ 全图 12 只怪全被锁成目标、每只脚下都长出一根刺。
   * 偏 1px 面积就是 0.5、行为完全正常 ⇒ 这是个**刀锋上的洞**，只有正好重合才炸
   * （所以旧版齐斩也有同一个洞，只是表现成"三道光打中所有人"，不像刺长满地图这么扎眼）。
   */
  function pointInTri(px, py, a, b, c) {
    if (triArea(a, b, c) < TRI_EPS) return false;
    function side(p1, p2) { return (p2.x - p1.x) * (py - p1.y) - (p2.y - p1.y) * (px - p1.x); }
    var s1 = side(a, b), s2 = side(b, c), s3 = side(c, a);
    var neg = (s1 < 0) || (s2 < 0) || (s3 < 0), pos = (s1 > 0) || (s2 > 0) || (s3 > 0);
    return !(neg && pos);
  }

  /** 点到三角三条边的最近距离（>0 = 在里面）。用来"别把刺扎在边界线上"和排剑刺的先后。 */
  function triEdgeDist(px, py, t) {
    var best = Infinity;
    for (var i = 0; i < 3; i++) {
      var a = t[i], b = t[(i + 1) % 3], c = t[(i + 2) % 3];
      var ex = b.x - a.x, ey = b.y - a.y, L = Math.hypot(ex, ey) || 1;
      var nx = -ey / L, ny = ex / L;
      if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) { nx = -nx; ny = -ny; }   // 法线转向内侧
      best = Math.min(best, (px - a.x) * nx + (py - a.y) * ny);
    }
    return best;
  }

  /** 一次普通攻击走完 → 脚下留一把虚幻小剑；攒够 maxSwords 把就起阵 */
  Game.prototype.echoDropSword = function (x, y) {
    var C = this.cfg.swordEcho;
    if (!C) return;
    if (!this.skillEchoSwords) this.skillEchoSwords = [];
    if (this.skillEchoStrike) return;          // 预警/斩击期间不叠剑（这一段本来也不算布阵）
    /* 落点先推墙：剑钉在石头/墙里的话三角顶点会卡在障碍里
       （和 spear_field 那个枪阵同一套做法）。 */
    var c = { x: x, y: y, r: 6 };
    this.world.collide(c);
    this.skillEchoSwords.push({ x: c.x, y: c.y, t: 0 });   // t=落地计时：渲染层靠它画"插下去"的扬尘/涟漪
    this.emit('echoSword', { x: c.x, y: c.y });
    if (this.skillEchoSwords.length >= (C.maxSwords || 3)) this.echoArmStrike();
  };

  /** 三把到齐 → 定三角、进预警。三角超过 maxR 就整体等比压回来（用户口径"限制最大范围"） */
  Game.prototype.echoArmStrike = function () {
    var C = this.cfg.swordEcho, pts = this.skillEchoSwords || [];
    if (!C || pts.length < 3) return null;
    var cx = (pts[0].x + pts[1].x + pts[2].x) / 3;
    var cy = (pts[0].y + pts[1].y + pts[2].y) / 3;
    var maxd = 0, i;
    for (i = 0; i < 3; i++) maxd = Math.max(maxd, Math.hypot(pts[i].x - cx, pts[i].y - cy));
    var k = (C.maxR > 0 && maxd > C.maxR) ? C.maxR / maxd : 1;
    var tri = [];
    for (i = 0; i < 3; i++) tri.push({ x: cx + (pts[i].x - cx) * k, y: cy + (pts[i].y - cy) * k });
    this.skillEchoSwords.length = 0;           // 三把触发即清（"不无限留剑"）
    this.skillEchoStrike = {
      tri: tri, cx: cx, cy: cy, warn: C.warn || 0.35,
      slashed: false, wave: 0, hold: 0, hits: []
    };
    this.echoBuildSpikes(this.skillEchoStrike);
    this.emit('echoArm', { x: cx, y: cy });
    return this.skillEchoStrike;
  };

  /**
   * 地刺式的刺阵（2026-10 第 3 版攻击表现，用户在 A/B/D 编排里选了 **A：三边向内收拢**）：
   * 三角内按网格撒点 + **阵内的怪各吸附一根**，每根算好"第几个冒"（delay）。
   * ⚠️ 几何只在**起阵这一刻算一次**，之后渲染层只读（`spike.p` 每帧由 updateSwordEcho 更新）——
   *    "渲染层自己重算 → 效果有、画面没有"那个老坑见 drawOrbit 的注释。
   * ⚠️ 打谁也在这一刻**锁定**：被围住那一刻是谁就扎谁，预警的 0.35 秒里走进走出不改结果
   *    （刺的位置本来就是按这一刻的地面排的，怪跑了刺也还在原地）。
   */
  Game.prototype.echoBuildSpikes = function (st) {
    var C = this.cfg.swordEcho, P = this.player, tri = st.tri;
    /* ---- 0. 退化三角（三点共线 / 重合）：根本不成阵 ----
       用户口径「三把剑靠得太近时只形成小范围攻击，站着不动收益低」——
       退化到零面积的"阵"就该一根刺都不排、一个目标都不锁。
       （点判定自己也有同一道兜底，见 pointInTri；这里显式拦一次，是为了让"不成阵"
        这件事在起阵这一步就写在明面上，而不是靠遍历恰好一个都命中不到。） */
    if (triArea(tri[0], tri[1], tri[2]) < TRI_EPS) { st.spikes = []; st.targets = []; return; }
    var step = C.spikeStep || 36, margin = C.spikeMargin || 7, gap = C.spikeGap || 32;
    var span = Math.max(0.05, 1 - (C.spikeRise || 0.22));   // 最后一根也要在 wave=1 之前出齐
    var xs = [tri[0].x, tri[1].x, tri[2].x], ys = [tri[0].y, tri[1].y, tri[2].y];
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    /* ---- 1. 三角内按网格撒点 ---- */
    var pts = [], i, j, gx, gy, ed;
    for (gy = minY + step * 0.5; gy < maxY; gy += step) {
      for (gx = minX + step * 0.5; gx < maxX; gx += step) {
        ed = triEdgeDist(gx, gy, tri);
        /* 角色脚下不冒刺（阵不扎自己人）：一是"自己站在阵里也会被扎"说不通，
           二是刺是从下往上画的，画在角色身上会像插在自己身上。 */
        if (ed >= margin && Math.hypot(gx - P.x, gy - P.y) > gap) {
          pts.push({ x: gx, y: gy, depth: ed, delay: 0, p: 0, lead: -1 });
        }
      }
    }
    /* ---- 2. 阵内的怪：最近的网格点搬到它脚下（保证"被围住的每只都被扎到"）+ 锁定目标 ---- */
    var targets = [];
    for (i = 0; i < this.foes.length && targets.length < (C.maxHits || 12); i++) {
      var f = this.foes[i];
      if (f.hp <= 0 || !pointInTri(f.x, f.y, tri[0], tri[1], tri[2])) continue;
      var best = null, bd = C.spikeSnap || 26;
      for (j = 0; j < pts.length; j++) {
        if (pts[j].taken) continue;
        var dd = Math.hypot(pts[j].x - f.x, pts[j].y - f.y);
        if (dd < bd) { bd = dd; best = pts[j]; }
      }
      if (best) { best.x = f.x; best.y = f.y; best.depth = triEdgeDist(f.x, f.y, tri); best.taken = true; }
      else { best = { x: f.x, y: f.y, depth: 1, delay: 0, p: 0, lead: -1, taken: true }; pts.push(best); }
      targets.push({ foe: f, spike: best, hit: false });
    }
    /* ---- 3. 谁先冒（A 编排：贴三条边的先冒、中心最后）。
       delay 按 (1-rise) 归一 —— 不归一的话最后那根永远差一点冒不出来（rise 那段被吃掉了）。 */
    var maxDepth = 0.001;
    for (i = 0; i < pts.length; i++) maxDepth = Math.max(maxDepth, pts[i].depth);
    for (i = 0; i < pts.length; i++) pts[i].delay = Math.max(0, pts[i].depth) / maxDepth * span;
    st.spikes = pts;
    st.targets = targets;
  };

  /** 每帧推进剑阵：预警倒计时 → 剑刺波（一根根破土，扎到谁当场结账）→ 停留 → 清掉 */
  Game.prototype.updateSwordEcho = function (dt) {
    var C = this.cfg.swordEcho, P = this.player;
    if (!C) return;
    if (!this.skillEchoSwords) this.skillEchoSwords = [];
    /* 剑的落地计时：渲染层只读这个 t（不许自己按帧算时间） */
    for (var k = 0; k < this.skillEchoSwords.length; k++) this.skillEchoSwords[k].t += dt;
    var st = this.skillEchoStrike;
    if (!st) return;
    if (!st.slashed) {
      st.warn -= dt;
      if (st.warn <= 0) { st.warn = 0; st.slashed = true; st.wave = 0; }
      return;
    }
    var SP = st.spikes || [], rise = C.spikeRise || 0.22, hitP = C.spikeHitP || 0.6, i;
    if (st.wave < 1) {
      st.wave = Math.min(1, st.wave + dt / (C.spikeTime || 0.32));
      /* 每根刺的进度在这里算好 —— 渲染层直接读 spike.p / spike.lead，不自己算 */
      for (i = 0; i < SP.length; i++) {
        SP[i].lead = st.wave - SP[i].delay;
        SP[i].p = Math.max(0, Math.min(1, SP[i].lead / rise));
      }
      /* 扎到谁就当场结账：**一次性**，每只只吃一次（用户口径"不持续伤害"）。
         伤害跟着刺的进度走 → 画面上是"剑刺穿到身上那一刻"才掉血，不是一次全掉。 */
      var tg = st.targets || [];
      for (i = 0; i < tg.length; i++) {
        var t = tg[i];
        if (t.hit || t.spike.p < hitP) continue;
        t.hit = true;
        if (t.foe.hp > 0) {
          st.hits.push({ x: t.foe.x, y: t.foe.y });    // 命中点交给渲染层画火花/冲击痕
          this.damageFoe(t.foe, P.stats.attackDamage * (C.dmgMul || 1), 90, 'skill');
        }
      }
      if (st.wave >= 1) this.emit('echoSlash', { x: st.cx, y: st.cy, hits: st.hits.length });
    } else {
      st.hold += dt;
      if (st.hold >= (C.hold || 0.28)) this.skillEchoStrike = null;
    }
  };

  /**
   * 叠刃：起转时 +1 把刃（本局累积）。
   * 上限取 `bladesMax - 1`（"总刃数上限"在 orbitParams 里再兜一次 —— 那里才算得出
   * "旋刃卡 + 叠刃"加起来是几把）。到顶之后**连代价一起停**，否则会出现
   * "刃数不涨了、却越转越慢"的怪事（代价是跟着刃数走的，见 config.bladeUnity）。
   */
  Game.prototype.gainBladeUnity = function () {
    var U = this.cfg.bladeUnity || {}, P = this.player;
    var cap = Math.max(0, (U.bladesMax || 12) - 1);
    var n = Math.max(0, Math.floor(P.bladeUnityStacks || 0));
    if (n >= cap) return n;
    P.bladeUnityStacks = n + 1;
    /* 飘字只给第一次（每 1.5 秒飘一次会烦；刃数本身在画面上就看得见） */
    if (n === 0 && this.parts) this.parts.text(P.x, P.y - 78, '叠刃 · 每转一圈 +1 把', '#a8f3ff');
    return P.bladeUnityStacks;
  };

  Game.prototype.updateWeaponSkills = function (dt) {
    var P = this.player, kind = this.weaponKind(), cd = this.skillCooldowns;
    if (this.skillActiveKind !== kind) {
      this.skillActiveKind = kind; this.skillShadow = null; this.skillDash = null;
      this.skillFields = []; this.skillVisuals = []; this.skillHitCounts = {}; this.skillQuakePending = false;
      /* 剑阵回响也一起清：地上的虚剑和"正在预警的三角"都跟着武器走 ——
         不清的话切走武器之后，三角还会在原地替你把怪斩了（技能已经不在手上了）。 */
      this.skillEchoSwords = []; this.skillEchoStrike = null;
    }
    for (var key in cd) cd[key] = Math.max(0, cd[key] - dt);
    for (var i = this.skillVisuals.length - 1; i >= 0; i--) {
      this.skillVisuals[i].t += dt;
      if (this.skillVisuals[i].t >= this.skillVisuals[i].life) this.skillVisuals.splice(i, 1);
    }
    /* 剑阵回响：剑是在 updateOrbit 里"一次攻击走完"时落的，这里只推进预警倒计时/齐斩/收尾 */
    if (this.hasWeaponSkill('sword_echo')) this.updateSwordEcho(dt);
    if (this.hasWeaponSkill('sword_wave') && !(cd.wave > 0)) {
      cd.wave = 1.2;
      this.skillShot(P.x, P.y, this.skillAim(), 470, P.stats.attackDamage * 1.5, 'wave', '#a8f3ff');
    }
    if (this.hasWeaponSkill('spear_pierce') && !(cd.pierce > 0)) {
      cd.pierce = 2;
      var a = this.skillAim();
      this.skillLine(P.x, P.y, P.x + Math.cos(a) * 330, P.y + Math.sin(a) * 330, 24,
        P.stats.attackDamage * 2.2, '#ffe3a1');
      this.emit('skillPierce', { x: P.x, y: P.y });
    }
    if (this.hasWeaponSkill('spear_field') && !(cd.field > 0)) {
      cd.field = 2;
      if (this.skillFields.length < this.cfg.skillLimits.fields) {
        var field = { x: P.x - Math.cos(P.face) * 48, y: P.y - Math.sin(P.face) * 48,
          r: 78, life: 3, tick: 0, damage: P.stats.attackDamage * 0.55 };
        var center = { x: field.x, y: field.y, r: 8 };
        this.world.collide(center); field.x = center.x; field.y = center.y;
        this.skillFields.push(field);
      }
    }
    for (i = this.skillFields.length - 1; i >= 0; i--) {
      var zone = this.skillFields[i]; zone.life -= dt; zone.tick -= dt;
      if (zone.life <= 0) { this.skillFields.splice(i, 1); continue; }
      if (zone.tick <= 0) {
        zone.tick = 0.5; this.areaPulse(zone.x, zone.y, zone.r, zone.damage, 'skill');
      }
    }
    if (this.skillQuakePending && this.hasWeaponSkill('greatsword_quake') && !(cd.quake > 0)) {
      this.skillQuakePending = false; cd.quake = 0.45;
      this.areaPulse(P.x, P.y, 160, P.stats.attackDamage * 1.8, 'skill');
      this.skillVisual({ kind: 'ring', x: P.x, y: P.y, radius: 160, color: '#ffdb8a', life: 0.35 });
    }
    if (this.skillShadow) {
      var sh = this.skillShadow; sh.life -= dt; sh.tick -= dt;
      var ang = this.skillAim(); sh.x = P.x + Math.cos(ang) * 46; sh.y = P.y + Math.sin(ang) * 46;
      if (sh.life <= 0) this.skillShadow = null;
      else if (sh.tick <= 0) {
        sh.tick = 0.35; this.areaPulse(sh.x, sh.y, 64, P.stats.attackDamage * 0.65, 'skill');
      }
    }
  };

  Game.prototype.staffSkillImpact = function (p, first) {
    // Secondary bullets have neither split nor chain flags. Each primary procs only once.
    if (p.chainSkill && this.hasWeaponSkill('staff_chain')) {
      var visited = p.hitSet.slice(), from = first;
      for (var jump = 0; jump < 2; jump++) {
        var nearest = null, dist = 170 * 170;
        for (var i = 0; i < this.foes.length; i++) {
          var f = this.foes[i], dx = f.x - from.x, dy = f.y - from.y, d = dx * dx + dy * dy;
          if (f.hp > 0 && visited.indexOf(f) < 0 && d < dist) { nearest = f; dist = d; }
        }
        if (!nearest) break;
        visited.push(nearest);
        this.skillVisual({ kind: 'lightning', x: from.x, y: from.y, x2: nearest.x, y2: nearest.y,
          width: 3, color: '#91dfff', life: 0.22 });
        this.damageFoe(nearest, p.damage * (jump ? 0.45 : 0.65), 0, 'skill');
        from = nearest;
      }
    }
    if (p.splitSkill && this.hasWeaponSkill('staff_split')) {
      for (var side = -1; side <= 1; side += 2) {
        var child = this.skillShot(first.x, first.y, p.angle + side * 0.48, 430, p.damage * 0.6, null, '#e1b6ff');
        if (child) { child.hitSet = [first]; child.pierce = 1; child.life = 0.8; }
      }
    }
  };

  Game.prototype.initTrial = function () {
    if (!this.cfg.trial.enabled) return;
    /* skillTaken（2026-10 新加）：第 1 波的教学 gate —— 学到精英掉的技能之前不刷怪群。
       老存档没有这个字段时按「没打完就别卡住」补默认值，见 save.js 的 applyRun。 */
    this.trial = { spawned: 0, killed: 0, eliteSpawned: false, eliteDead: false, skillTaken: false, warning: 0, warningKind: '', delay: 0, finished: false };
    this.frenzyNoticeT = 0; this.frenzyStartKills = 0;
    /* ⚠️ 这里原本还有一段"把 5 把武器全塞进包里"—— 那是**试炼场试招用的便利**，
       但 initTrial() 是 reset() 调的（正式局也会跑），于是**开局就能换出大剑/长枪/法杖**，
       掉落系统形同虚设。2026-10 用户口径：开局只能有默认的长剑，其他不可选。
       → 全武器现在只在进试炼场时发（见 setTraining），退出时收回。 */
    this.Prog.recompute(this.player, this.cfg);
  };

  /**
   * 低血警报（2026-10，用户口径"血量和经验值放左上角"以后补的一层反馈）。
   *
   * 为什么要有它：条挪到左上角之后，"血量变红"这件事在打斗中很容易被忽略
   * （眼睛在角色身上）。核心层只负责**在跨进低血档的那一刻发一个事件**，
   * 怎么表现是渲染层（角色身上红色心跳脉冲 + 屏幕四边泛红分档）和平台层
   * （震动 + 心跳音）的事 —— 核心层不认识这些。
   *
   * 两条口径：
   *   · 进 ratio 立刻响一次，之后每 repeat 秒重复（心跳感），不是只响一次
   *   · 回到 release 以上才重新武装 —— 滞回防抖：卡在阈值上下抖一下不会连发
   * ⚠️ 只在 state==='play' 时判定：升级选卡/暂停/倒地时不响（倒在结算页还在"咚"很怪）。
   */
  Game.prototype.updateLowHp = function (dt) {
    var cfg = (this.cfg.feel && this.cfg.feel.lowHp) || {};
    var enter = cfg.ratio === undefined ? 0.30 : cfg.ratio;
    var release = cfg.release === undefined ? 0.42 : cfg.release;
    var repeat = cfg.repeat === undefined ? 3.2 : cfg.repeat;
    var P = this.player;
    var ratio = (P.stats && P.stats.maxhp > 0) ? P.hp / P.stats.maxhp : 1;

    if (this.state !== 'play' || P.dead) return;
    if (ratio > release) { this.lowHpAlarm = false; this.lowHpTimer = 0; return; }   // 加回来 → 重新武装
    if (ratio > enter) return;                                                      // 还没进档

    if (!this.lowHpAlarm) {
      this.lowHpAlarm = true; this.lowHpTimer = repeat;
      this.emit('lowHp', { ratio: ratio });
      return;
    }
    this.lowHpTimer -= dt;
    if (this.lowHpTimer <= 0) {
      this.lowHpTimer = repeat;
      this.emit('lowHp', { ratio: ratio });        // 还在低血：隔着 repeat 秒再提醒一次
    }
  };

  Game.prototype.frenzyRect = function () {
    var vp=this.viewport, ins=vp.insets||{};
    return {x:vp.w-232-(ins.right||0), y:Math.max((ins.top||0)+78,vp.h-222-(ins.bottom||0)), w:84,h:64};
  };
  Game.prototype.activateFrenzy = function () {
    var P=this.player,F=this.cfg.frenzy;
    if(this.state!=='play'||this.clearT>0||P.frenzy>0||(P.frenzyCharge||0)<F.threshold)return false;
    P.frenzyCharge=0;P.frenzy=P.evolutions&&P.evolutions.storm?F.upgradedDuration:F.duration;
    this.frenzyTotal=P.frenzy;this.frenzyStartKills=P.kills;
    P.orbOn=false;P.orbT=0;this.frenzyNotice='狂热收割！';this.frenzyNoticeT=1.2;
    this.emit('frenzyStart',{x:P.x,y:P.y});this.saveNow();return true;
  };
  // Spawn at a validated viewport edge; do not clamp an invalid point onto the player.
  Game.prototype.trialSpawnPoint = function (preferredSide) {
    var vp=this.viewport,cam=this.cam,P=this.player;
    var zoom=this.cfg.camera?this.cfg.camera.zoom:1;
    var vw=(vp.w||812)/zoom,vh=(vp.h||375)/zoom;
    for(var i=0;i<24;i++){
      var side=preferredSide===undefined?Math.floor(Math.random()*4):preferredSide,p={r:28};
      p.x=side===0?cam.x-48:side===1?cam.x+vw+48:cam.x+Math.random()*vw;
      p.y=side===2?cam.y-48:side===3?cam.y+vh+48:cam.y+Math.random()*vh;
      if(p.x<60||p.y<60||p.x>this.world.w-60||p.y>this.world.h-60)continue;
      this.world.collide(p);
      if(p.x<60||p.y<60||p.x>this.world.w-60||p.y>this.world.h-60)continue;
      if(Math.hypot(p.x-P.x,p.y-P.y)<180)continue;
      if(p.x>cam.x-20&&p.x<cam.x+vw+20&&p.y>cam.y-20&&p.y<cam.y+vh+20)continue;
      return p;
    }
    return null;
  };
  // Prefer a landmark-facing edge, retaining the viewport exclusion and collision checks.
  Game.prototype.realmEntrance = function (boss) {
    var L=this.world.landmarks;if(!L)return this.trialSpawnPoint();
    var target=boss?L.ancientTree:(this.wave===1?L.houses[0]:L.well);
    var dx=target.x-this.player.x,dy=target.y-this.player.y;
    var side=Math.abs(dx)>Math.abs(dy)?(dx<0?0:1):(dy<0?2:3);
    var fallback=null;
    for(var n=0;n<12;n++){
      var p=this.trialSpawnPoint(n<4?side:undefined);if(!p)continue;
      if(!this.world.isFree(p.x,p.y,boss?40:30))continue;
      if(!fallback)fallback=p;
      if(!boss||this.world.isFree(p.x,p.y,125))return p;
    }
    return fallback||this.trialSpawnPoint();
  };
  Game.prototype.spawnTrialFoe = function (elite, point) {
    var t=this.trial,C=this.cfg.trial,p=point||(elite?this.realmEntrance(false):this.trialSpawnPoint());if(!p)return false;
    var n=t.spawned, type='slime';
    /* 精英的外形/数值全部来自 cfg.trial.elite[波次]（一只按波定义，不再硬编码"裂钳守卫"）。 */
    var E=(C.elite||[])[this.wave-1]||null;
    var tankEvery=(C.tankEvery||[40,18])[Math.min(this.wave,2)-1]||18;
    if(elite)type=(E&&E.base)||'charger';
    else if(n%tankEvery===tankEvery-1)type='tank';
    else if(this.wave>=2&&n%18===9&&this.foes.filter(function(f){return f.type==='charger'&&!f.trialElite;}).length<2)type='charger';
    if(!elite&&this.wave<=2&&n%26===20&&(this.wave===2||t.killed>=this.cfg.trial.totals[0]/2)&&this.foes.filter(function(f){return f.type==='spitter';}).length<(this.wave===1?1:2))type='spitter';
    var f=this.Entities.makeFoe(this.cfg,type,p.x,p.y,this.wave,1,null);
    if(elite){
      f.trialElite=true;f.affix={id:'guardian',color:E?E.color:'#ffd166'};
      f.name=(E&&E.name)||'精英';f.r=(E&&E.r)||28;
      f.hp=f.maxhp=(E&&E.hp)||C.eliteHp;f.spd=(E&&E.spd)||64;f.color=(E&&E.color)||'#dbae62';
      f.xp=(E&&E.xp)||35;f.gold=(E&&E.gold)||12;f.dmg=(E&&E.dmg)||14;
      /* 顶部血条那块要用的（渲染层不猜波次，直接读精英身上的）：
         tips = 教学关才给的那半句"（击败精英 · 可能掉落武器技能）"，和名字同一行。 */
      f.eliteTips=!!(E&&E.tips);
      t.eliteSpawned=true;
    }
    else {
      // More bodies, approximately the previous wave reward budget.
      var rewardScale=this.cfg.trial.rewardScale[this.wave-1];
      var xpStep=(this.cfg.trial.xpBudgets[this.wave-1]-(this.wave<=2?this.cfg.tide.xp:0))/this.cfg.trial.totals[this.wave-1];
      f.xp=Math.floor((n+1)*xpStep+1e-8)-Math.floor(n*xpStep+1e-8);
      f.gold=Math.floor((n+1)*f.gold*rewardScale)-Math.floor(n*f.gold*rewardScale);
      if(type==='slime'&&n%3!==0){f.hp=f.maxhp=Math.round(f.maxhp*.65);f.r*=.88;}
      f.trialFoe=true;f.trialWave=this.wave;t.spawned++;
    }
    /* ⚠️ 必须先定完 r 再推墙：生成点是用 r=28 探过的，但精英比这更粗（铁甲母蟹 r=30）
       → 落点可能压在石头/墙里。和普通刷怪（spawnFoe）一样建完再推一次，
       否则它会卡在墙里出不来（verify-encircle 抓到的：教学精英一开场就卡在石头里）。 */
    this.world.collide(f);
    this.foes.push(f);return true;
  };
  Game.prototype.updateTide = function(dt){
    var t=this.trial,C=this.cfg.tide;if(this.wave>2||this.stageBossPending||t.finished)return;
    if(t.breath>0)t.breath=Math.max(0,t.breath-dt);
    if(!t.tide&&t.killed>=C.triggers[this.wave-1]){
      var side=Math.floor(Math.random()*4),point=null;
      for(var tries=0;tries<4&&!point;tries++){side=(side+1)%4;point=this.trialSpawnPoint(side);}
      if(!point)return;
      t.tide={phase:'warning',side:side,timer:C.warning,spawned:0,batch:0};this.emit('boss',{});
      return;
    }
    var e=t.tide;if(!e||e.phase==='done')return;
    if(e.phase==='warning'){e.timer-=dt;if(e.timer>0)return;e.phase='active';e.timer=C.duration;return;}
    e.timer-=dt;e.batch-=dt;
    if(e.timer<=0||e.spawned>=C.count){e.phase='done';t.breath=4;return;}
    if(e.batch>0)return;e.batch=.65;
    var anchor=this.trialSpawnPoint(e.side);if(!anchor)return;
    for(var i=0;i<6&&e.spawned<C.count&&this.foes.length<C.cap;i++){
      var side=e.side,lane=(i%3-1)*32,depth=Math.floor(i/3)*32;
      var x=anchor.x+(side<2?(side===0?-depth:depth):lane),y=anchor.y+(side<2?lane:(side===2?-depth:depth));
      if(x<60||y<60||x>this.world.w-60||y>this.world.h-60||!this.world.isFree(x,y,20))continue;
      var f=this.Entities.makeFoe(this.cfg,'slime',x,y,this.wave,1,null);
      f.tideFoe=true;f.trialWave=this.wave;f.name='暴走裂壳虫';f.hp=f.maxhp=Math.round(f.maxhp*.45);f.r*=.85;f.xp=e.spawned%2;f.gold=0;
      this.foes.push(f);e.spawned++;
    }
  };

  Game.prototype.advanceTrialWave = function () {
    this.track('wave_complete');
    var ledger=this.trial.killsByWave||{};ledger[this.wave]=this.trial.killed;
    this.wave++;this.trial={spawned:0,killed:0,eliteSpawned:false,eliteDead:false,skillTaken:false,warning:0,warningKind:'',delay:2,finished:false};
    this.trial.killsByWave=ledger;
    this.spawnT=0;this.player.hp=Math.min(this.player.stats.maxhp,this.player.hp+8);
    this.parts.text(this.player.x,this.player.y-70,'第'+this.wave+'波 · 残兵仍在追击','#ffd166');this.saveNow();
  };
  Game.prototype.updateTrialSpawns = function (dt) {
    var t=this.trial,C=this.cfg.trial;if(!t||t.finished||this.clearT>0||this.stageBossPending)return;
    if(t.delay>0){t.delay=Math.max(0,t.delay-dt);return;}
    var E=(C.elite||[])[this.wave-1]||null;
    /* 第 1 波（教学波）开场：**只有精英 + 随行 2~3 只慢速杂兵**，不放怪群也不起敌潮。
       2026-10 用户口径原话：「先单独出精英怪，等角色打死精英怪获得技能后，再正常出怪」——
       先让新手把「打精英 → 捡卷轴 → 学会技能」这条链走完，再面对怪潮。
       ⚠️ 解锁条件是**真的捡到卷轴学会技能**（t.skillTaken），不是精英一死就放怪：
          精英死了但卷轴还躺在地上 → 仍然不刷怪，逼玩家去捡（有出屏箭头指引 + 目标行提示）。 */
    if(E&&E.at==='start'&&!t.eliteSpawned&&this.foes.length<this.enemyCap()){
      this.spawnTrialFoe(true);
      var mate=(C.startMates===undefined?3:C.startMates),Pl=this.player;
      var host=this.foes[this.foes.length-1];
      for(var mi=0;mi<mate&&host;mi++){
        /* 往**远离玩家的方向**排开，并且必须落在视野外（和精英同一条规矩）——
           在玩家眼前凭空冒出来是硬伤，verify-encircle 盯着这条。
           每个位置最多试 4 个角度，落点被石头/边界挡住或进了屏幕就换个角度，都不行才少一只。 */
        var TH=[0,0.5,-0.5,1.0];                          // 都取小角度：保证径向始终"更远"
        var dxs=host.x-Pl.x,dys=host.y-Pl.y,dd=Math.hypot(dxs,dys)||1;
        var cam=this.cam||{x:0,y:0},z=(this.cfg.camera&&this.cfg.camera.zoom)||1,mgn=20;
        var placed=false;
        for(var at=0;at<TH.length&&!placed;at++){
          var th=TH[at],cs=Math.cos(th),sn=Math.sin(th);
          var ex=(dxs*cs-dys*sn)/dd,ey=(dxs*sn+dys*cs)/dd;   // 单位向量按 th 旋转
          var off=(mi+1)*34+(at>2?26:0),sd=((mi%2)?1:-1)*24*(1+Math.floor(mi/2));
          var mx=host.x+ex*off-ey*sd,my=host.y+ey*off+ex*sd;
          if(mx<60||my<60||mx>this.world.w-60||my>this.world.h-60||!this.world.isFree(mx,my,22))continue;
          if(!(mx<=cam.x-mgn||mx>=cam.x+this.viewport.w/z+mgn||my<=cam.y-mgn||my>=cam.y+this.viewport.h/z+mgn))continue;
          this.spawnTrialFoe(false,{x:mx,y:my});
          var f0=this.foes[this.foes.length-1];
          /* 随行的要比场上其它怪明显慢：它们是"陪练"，不是压力（教学波的压力全在精英身上）。 */
          if(f0&&f0!==host){f0.spd*=.55;f0.startMate=true;placed=true;}
        }
      }
    }
    if(this.wave===1&&!t.skillTaken)return;
    this.updateTide(dt);
    var tideBusy=t.tide&&t.tide.phase!=='done';
    var total=C.totals[this.wave-1];
    /* 第 1 波的精英已在上面（gate 之前）连带随行小怪一起放好了，这里不再重复生成。 */
    /* 两只精英都"不死不推进波次"（第 1 波 gate 在教学能力上，第 2 波本来就 gate）：
       精英是慢速的，不 gate 玩家会绕过去 —— 那就学不到"精英给武器技能"这件事。 */
    if(!tideBusy&&this.wave===1&&t.eliteDead&&t.spawned>=total&&t.killed>=Math.ceil(total*.9)){this.advanceTrialWave();return;}
    if(!tideBusy&&this.wave===2&&t.eliteDead&&t.killed>=Math.ceil(total*.8)){this.advanceTrialWave();return;}
    if(!tideBusy&&!t.warningKind&&((E&&typeof E.at==='number'&&!t.eliteSpawned&&t.killed>=E.at)||(this.wave===3&&t.spawned>=total&&t.killed>=Math.ceil(total*.8)))){
      t.warningKind=(E&&typeof E.at==='number'&&!t.eliteSpawned)?'elite':'boss';t.warning=1.5;this.emit('boss',{});
    }
    if(t.warning>0){t.warning=Math.max(0,t.warning-dt);}
    if(t.warningKind&&t.warning===0){
      if(t.warningKind==='elite'){if(this.foes.length<this.enemyCap()&&this.spawnTrialFoe(true))t.warningKind='';}
      else {
        var p=this.realmEntrance(true);if(!p)return;
        var b=this.Entities.makeBoss(this.cfg,p.x,p.y,1,'warden',1);
        this.foes.push(b);this.bossAlive=1;this.stageBossPending=true;this.bossSpawnedForStage=1;this.bossCount++;
        t.warningKind='';return;
      }
    }
    this.spawnT-=dt;
    if(this.spawnT>0||t.spawned>=total)return;
    var cap=Math.min(C.caps[this.wave-1],this.enemyCap()),group=C.groups[this.wave-1];
    // Two compact squads enter on rotating sides. No reserved safe sector.
    if(t.side===undefined)t.side=Math.floor(Math.random()*4);
    var sides=[0,2,1,3];
    for(var squad=0;squad<2&&t.spawned<total&&this.foes.length<cap;squad++){
      var anchor=null,side;
      for(var attempt=0;attempt<4&&!anchor;attempt++){side=sides[t.side%4];t.side++;anchor=this.trialSpawnPoint(side);}
      if(!anchor)continue;
      for(var i=0;i<group&&t.spawned<total&&this.foes.length<cap;i++){
        var lane=(i%4-1.5)*36,depth=Math.floor(i/4)*34;
        var point={x:anchor.x+(side<2?(side===0?-depth:depth):lane),y:anchor.y+(side<2?lane:(side===2?-depth:depth))};
        if(point.x<60||point.y<60||point.x>this.world.w-60||point.y>this.world.h-60||!this.world.isFree(point.x,point.y,24))continue;
        this.spawnTrialFoe(false,point);
      }
    }
    this.spawnT=C.intervals[this.wave-1]*(t.breath>0?1.8:1);
  };
  Game.prototype.trialObjective = function () {
    var t=this.trial;if(!t)return '';
    if(t.finished)return '荒原通关';
    if(t.delay>0)return '下一波准备中';
    if(t.tide&&t.tide.phase==='warning')return ['左侧','右侧','上方','下方'][t.tide.side]+'敌群袭来';
    if(t.tide&&t.tide.phase==='active')return '敌潮涌入 · 寻找突破口';
    if(t.warningKind)return t.warningKind==='elite'?'精英即将入场':'首领即将入场';
    if(this.stageBossPending)return '击败荒原巨蝎';
    var E0=(this.cfg.trial.elite||[])[this.wave-1];
    if(E0&&t.eliteSpawned&&!t.eliteDead)return '击败'+E0.name;
    /* 第 1 波教学 gate：精英死了但还没学会技能 → 明确告诉新手去捡卷轴（不然会以为卡住了）。 */
    if(this.wave===1&&!t.skillTaken)return '捡起技能卷轴 · 学会武器技能';
    return '清理怪群 '+t.killed+'/'+this.cfg.trial.totals[this.wave-1];
  };

  return Game;
});
