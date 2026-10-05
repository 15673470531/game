/**
 * 核心层：实体工厂与粒子（纯数据 + 纯运算，无渲染）
 * 这里只负责"造出来"，数值公式都在 config / progression 里。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.__GAME__ = root.__GAME__ || {}).Entities = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof window !== 'undefined' ? window : globalThis), function () {
  'use strict';

  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

  /** 玩家。base 是裸装副本；stats 由 Progression.recompute 填（由 Game 调用） */
  function makePlayer(cfg, x, y) {
    var P = {
      x: x, y: y, r: cfg.player.r,
      base: {}, stats: {},
      equip: { weapon: null, armor: null, trinket: null },
      /* 武器库：拿到的武器都留在这里（同一种只留更好的那把），可以随时切换。
         equip.weapon 始终指向"当前拿在手上的那把" —— 其它代码只认它。见 game.switchWeapon */
      bag: [],
      taken: {},                       // 已拿过的升级卡 id -> 次数
      /* ===== 武器熟练度（2026-10）=====
         mastery = { 武器kind: 累积点数 }。**跨局永久**，不走 keepOnDeath（连 'none' 也留）——
         它是"元进度"，不是这一局的成果。等级**不存**，由点数算（Progression.masteryInfo）。
         键是懒建的（拿哪把武器打通就写哪把），所以老存档读过来是 {} 而不是缺字段崩溃。 */
      mastery: {},
      /* 本局"每把武器分别拿了多少熟练度"—— 只给结算页显示"本局 +N"用，不进存档、每局清零 */
      masteryGainRun: {},
      /* 叠刃（熟练度 Lv3 的机制卡）：本局累积的**额外刃数**。
         ⚠️ 和 base/bladeUnity（卡上的"有没有这张卡"开关）是两个东西，别合并 ——
            一个是开关、一个是计数，同名就是"同一个数写两处"。进 run 存档（退出继续不能清零）。 */
      bladeUnityStacks: 0,
      level: 1, xp: 0, xpNext: 0,
      hp: 1, face: 0, atk: 0, cd: 0, dash: 0, dashcd: 0, inv: 0, bob: 0,
      kills: 0, gold: 0, runGold: 0, frenzy: 0, frenzyCharge: 0, dead: false,
      rerolls: 0,               // 本局用掉几次"重刷卡片"（递增价：第1次免费→30→60…，见 config.growth.reroll）
      slowT: 0, slowMul: 1,     // 中毒减速剩余秒数 / 速度倍率（Boss 尾针命中，见 game.applySlow）
      /* 限次爆发（config.upgrades 里带 burst 的卡，如「开天」）：
         null = 没有；否则 { id, name, left: 还剩几个转动窗口, active: 本窗口正在生效, radiusMul }
         口径见 config 那段注释：一次 = 一个转动窗口（起转→收刃），抽到后**下次起转才生效**。 */
      burst: null,
      pendingLevels: 0,                // 待选的升级卡数量
      comboStacks: 0, comboTimer: 0,   // 双刀连击层数（其他武器用不到）
      /* 旋刃（环绕攻击）的运行时状态：
         orbOn=正在转 / orbT=本阶段剩余秒数 / orbAng=当前刃角 / orbPrev=上一帧刃角
         （命中按"这一帧扫过的那段弧"判定，否则转速快时会穿怪）/ orbAng0=起转角
         orbRev=第几圈（长枪的横扫按圈计数）/ orbPass=本圈已扫中几只 / orbCastT=法杖自动施法计时 */
      orbOn: false, orbT: 0, orbAng: 0, orbPrev: 0, orbAng0: 0, orbRev: 1, orbPass: 0,
      /* orbTotal = **本阶段的总时长**（转动=orbitSpin / 收刃=orbitRest）。
         渲染层靠它算"收刃充能环"的进度（1 - orbT/orbTotal），所以核心层每次换阶段都要写；
         不写的话渲染层拿不到分母，环的进度会算成 NaN。
         orbChargeFlash = 收刃填满（= 起转）那一下的"到点了"闪光剩余秒数，见 config.feel.attackRing。 */
      orbTotal: 0, orbChargeFlash: 0,
      orbSwingT: 0,               // 扇形武器的"下一次挥砍"计时（只有 arcSwing 武器用；目前没武器配）
      orbRev: 0, orbPass: 0, orbCastT: 0,
      /* 「这一帧在移动」——只给角色美术用（走路迈腿/摆臂的相位由 updatePlayer 每帧重写）。
         ⚠️ 不进存档、不当逻辑用（渲染层读不到输入，只能读它）。 */
      moving: false
    };
    for (var k in cfg.player.base) {
      if (Object.prototype.hasOwnProperty.call(cfg.player.base, k)) P.base[k] = cfg.player.base[k];
    }
    return P;
  }

  /** 普通敌人。wave 决定关内波次缩放，diff 是关卡难度倍率，affix 是精英词缀（可空） */
  function makeFoe(cfg, typeId, x, y, wave, diff, affix) {
    var t = cfg.enemyTypes[typeId];
    var d = diff || 1;
    var hpMul = (1 + (wave - 1) * cfg.waves.hpPerWave) * d;
    var dmgMul = (1 + (wave - 1) * cfg.waves.dmgPerWave) * d;
    var F = {
      kind: 'foe', type: typeId, x: x, y: y, r: t.r,
      hp: t.hp * hpMul, maxhp: t.hp * hpMul,
      spd: t.spd[0] + Math.random() * (t.spd[1] - t.spd[0]),
      dmg: t.dmg * dmgMul,
      xp: Math.round(t.xp * (cfg.waves.xpMul || 1)),      // 密度高 → 每只经验打折（见 config 注释）
      gold: randInt(t.gold[0], t.gold[1]),
      color: t.color, name: t.name, shape: t.shape,
      ranged: t.ranged || null,
      shootT: t.ranged ? t.ranged.cooldown * Math.random() : 0,
      // 铁角的冲撞状态机（其他敌人用不到，留着是 0 也不影响）
      chargeCd: t.charge ? t.charge.cooldown * (0.4 + Math.random() * 0.6) : 0,
      windup: 0,      // >0 = 蓄力中（原地抖）
      charging: 0,    // >0 = 冲刺中（高速直线）
      chargeDir: 0,
      hurt: 0, ph: Math.random() * 6.28, kb: { x: 0, y: 0 },
      affix: affix || null,        // 精英词缀（渲染层用它画外圈，机制看 game.js）
      dr: 0,                       // 减伤（护盾词缀）
      /* 甲壳兽的壳状态：只有 config 里带 shell 的怪才有（其他怪是 null，不参与任何判断）。
         shellT 初始随机 → 同场几只不会同时开壳（否则玩家只要记住一个节奏就能全清）。 */
      shell: t.shell || null,
      shellOpen: false,
      shellT: t.shell ? Math.random() * t.shell.closed : 0,
      blockT: 0,                   // 刚被弹开（渲染层用来画"当"一下的弧光）
      orbCd: 0,                    // 旋刃命中冷却（同一只怪最短间隔 = 实际攻速）
      goldMul: t.goldMul || 1,          // 甲壳兽这类：装备不再从它身上掉，改成掉一大笔金币
    };
    if (affix) {
      if (affix.hpMul) { F.hp *= affix.hpMul; F.maxhp *= affix.hpMul; }
      if (affix.spdMul) F.spd *= affix.spdMul;
      if (affix.dr) F.dr = affix.dr;
    }
    F.spd0 = F.spd;                // 狂暴词缀要按基础速度重新算
    return F;
  }

  /**
   * Boss：按种类生成（warden 震荡波+弹幕 / frost 扫射+召唤）。
   * 技能状态一次给全，用不到的留着是 0，不影响判断 —— 比按种类写两套实体简单。
   */
  function makeBoss(cfg, x, y, stage, bossKind, hpMul) {
    var id = bossKind || cfg.bossOrder[0];
    var B = cfg.bossTypes[id] || cfg.bossTypes[cfg.bossOrder[0]];
    var st = Math.max(1, Math.floor(stage) || 1);        // 传进来的是"第几关"，越后越强
    var hp = B.hp * (1 + (st - 1) * 0.5) * (hpMul || 1);
    var dmgMul = 1 + (st - 1) * 0.15;
    return {
      kind: 'boss', type: 'boss', bossType: B === cfg.bossTypes[id] ? id : cfg.bossOrder[0],
      x: x, y: y, r: B.r,
      hp: hp, maxhp: hp,
      spd: B.spd[0] + Math.random() * (B.spd[1] - B.spd[0]),
      dmg: B.dmg * dmgMul, xp: B.xp, gold: randInt(B.gold[0], B.gold[1]),
      color: B.color, name: B.name, shape: 'boss',
      ranged: null,
      /* ⚠️ **每个计时器都必须有初值**：undefined - dt = NaN，而 `NaN <= 0` 恒为 false
         → 技能永远不放（或反过来每帧都放）。Boss 的 orbCd 就踩过一次这个坑。 */
      slamT: 1.5, sweepT: 4.0, summonT: 5.0,
      golemSlamT: 2.6, rubbleT: 4.5,              // 碎石巨像
      chargeT: 3.8, poolT: 4.4, trailT: 0,        // 熔心巨兽
      teleT: 4.4, homingT: 3.4,                   // 虚空之眼
      /* 荒原巨蝎（2026-10 机制重做）：双钳夹击 + 尾针锁定 + 半血裂壳。
         ⚠️ 和上面一样，**每个计时器都必须有初值**（undefined 参与运算 = NaN）。 */
      clawT: 3.4, stingT: 2.6,                    // 两个招的冷却
      claw: 0, clawTotal: 0, clawDir: 0, clawRange: 0, clawArc: 0,   // 钳夹预警（扇形）
      sting: 0, stingTotal: 0,                    // 尾针预警（直线，方向锁在 chargeDir）
      phase2: false, crack: 0,                    // 裂壳：是否已裂 + 裂开那一下的闪光计时
      windup: 0, windupTotal: 0, charging: 0, chargeDir: 0, chargeRange: 0,
      split: false, mini: false, teleport: 0,
      cast: null, castT: 0, castX: 0, castY: 0, castRadius: 0,   // 地面预警圈
      sweeping: 0, sweepTick: 0, sweepAngle: 0,                  // 旋转扫射
      hurt: 0, ph: 0, kb: { x: 0, y: 0 },
      orbCd: 0                    // 旋刃命中冷却：Boss 也得有，否则 undefined 参与运算变 NaN → 每帧都挨打
    
    };
  }

  /** 掉落物：经验 / 金币 / 装备 */
  /* kind: 'gold' | 'item' | 'skill'
     ⚠️ value 只对金币有意义（原来写成 `kind === 'item' ? 0 : payload`，
        加 'skill' 之后 payload 是一个**技能 id 字符串**，混进 value 会让金币逻辑拿到字符串）。 */
  function makePickup(kind, x, y, payload) {
    var a = Math.random() * 6.28, s = 40 + Math.random() * 90;
    return {
      kind: kind, x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      value: kind === 'gold' ? payload : 0,
      item: kind === 'item' ? payload : null,
      skill: kind === 'skill' ? payload : null,      // 技能卡 id（掉在地上等人来捡）
      life: 0, t: 0
    };
  }

  /** 投射物。owner: 'foe'（默认）打玩家；'player' 打敌人 */
  function makeProjectile(x, y, angle, speed, damage, radius, color, owner) {
    return {
      x: x, y: y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      r: radius, damage: damage, life: 4.5, t: 0,
      angle: angle,                     // 追踪弹要改方向（虚空之眼），得留一份原始角度
      color: color || '#c9a2ff',
      owner: owner || 'foe',
      pierce: 0,        // 还能多穿几个敌人（法杖特有）
      hitSet: []        // 已经打到过的敌人，避免同一发反复打同一个
    };
  }

  function Particles() { this.list = []; }

  Particles.prototype.burst = function (x, y, color, n) {
    n = Math.min(n, Math.max(0, 220 - this.list.length));
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.28, s = 40 + Math.random() * 190;
      this.list.push({
        x: x, y: y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.45 + Math.random() * 0.35, t: 0,
        c: color, r: 2 + Math.random() * 3
      });
    }
  };

  /** 飘字（伤害数字/拾取提示），纯数据，渲染层画 */
  Particles.prototype.text = function (x, y, str, color) {
    if (this.list.length >= 260) return;
    this.list.push({
      x: x, y: y, vx: 0, vy: -52,
      life: 0.75, t: 0, c: color || '#fff', r: 0, str: str
    });
  };

  Particles.prototype.update = function (dt) {
    var write = 0;
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i];
      p.t += dt;
      if (p.t < p.life) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= p.str ? 0.96 : 0.93;
        p.vy *= p.str ? 0.96 : 0.93;
        this.list[write++] = p;
      }
    }
    this.list.length = write;
  };

  return {
    makePlayer: makePlayer,
    makeFoe: makeFoe,
    makeBoss: makeBoss,
    makePickup: makePickup,
    makeProjectile: makeProjectile,
    Particles: Particles,
    randInt: randInt
  };
});
