/**
 * 核心层：存档（纯逻辑，不碰 localStorage / wx.setStorageSync 这些平台 API）
 *
 * 分工：
 *   core/save.js      负责 "游戏状态 ⇄ 纯 JS 对象"（这里）
 *   platform/*        负责 "纯 JS 对象 ⇄ 存储介质"（storage 适配器）
 * Game 通过注入的 storage 调这两个函数，所以核心层依然不知道自己在哪跑。
 *
 * 只存"跨局要留下的东西"（等级/经验/金币/装备/升级卡/最好成绩），
 * 不存位置、敌人、顿帧这些瞬时状态 —— 那些存了也没意义，还会因为改版后字段对不上而崩。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.__GAME__ = root.__GAME__ || {}).Save = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof window !== 'undefined' ? window : globalThis), function () {
  'use strict';

  var VERSION = 1;

  /* 当前这一局打到哪儿了 —— 只给「继续上次」用。
     ⚠️ 这些字段全是**本局内**的进度（关卡/血量/计时/本关计数），和上面的
     level/gold/equip（攒下来的成果）是两回事：
       · 攒下来的成果：每次重开都按 cfg.save.keepOnDeath 接回来（'loot' = 只留金币装备）
       · 这一局的进度：只在\"没打完就退出\"时留着，用来接着打；
         死亡 / 主动重开 / 回首页都会把它清掉（用户口径：死亡必须有代价，不能白复活） */
  function runOf(game) {
    var P = game.player;
    return {
      trialVersion: game.cfg.trial.enabled ? game.cfg.trial.version : 0,
      poisonHazards: game.hazards.filter(function(h){return h.kind==='poison';}),
      spitSerial: game.spitSerial||0,
      trial: game.trial ? JSON.parse(JSON.stringify(game.trial)) : null,
      foes: game.cfg.trial.enabled ? JSON.parse(JSON.stringify(game.foes.filter(function(f){return f.hp>0;}))) : [],
      pickups: game.cfg.trial.enabled ? JSON.parse(JSON.stringify(game.pickups)) : [],
      playerPosition: {x:P.x,y:P.y},
      frenzyTotal: game.frenzyTotal || 6, frenzyStartKills: game.frenzyStartKills || 0,
      stage: game.stage || 1,
      /* skillPacing 已删（2026-10：技能改成精英掉落，不再有"第几张武器卡什么时候提供"的节奏）。
         老存档里还带着这个字段 —— 读档时整段忽略即可，不会报错。 */
      harvestAnnounced: !!game.harvestAnnounced,
      harvestWarn: game.harvestWarn || 0,
      harvestPrep: game.harvestPrep || 0,
      harvestActive: game.harvestActive || 0,
      harvestSpawnT: game.harvestSpawnT || 0,
      wave: game.wave || 1,
      hp: Math.round(P.hp),
      kills: P.kills || 0,
      /* 限次爆发的剩余刀数 + 全套参数：**整个对象都存**（以后加新维度不用改这里）。
         ⚠️ 读档时 active/healed 一律清零 —— 口径同"敌方攻击重新预警"：回来重新起转才算第一刀。 */
      burst: P.burst ? JSON.parse(JSON.stringify(P.burst)) : null,
      pendingLevels: P.pendingLevels || 0,
      /* 叠刃：本局累积的额外刃数。**必须存** —— 和 burst 同一个理由：
         不存的话"打到一半退出 → 首页继续上次"刃数清零，玩家会觉得卡了。 */
      bladeUnityStacks: P.bladeUnityStacks || 0,
      /* 熟练度"这一局已经领过的"标记（防重领，见 gainMastery 与 verify-mastery）：
         精英那 15/45 是**击杀当场入账**的。存档里死掉的怪（含精英）本来就不会存回去，
         但那是"恰好成立"、不是护栏 —— 这里显式记一笔，才算真的防住
         "打死精英 → 强杀进程 → 继续上次"重复领同一只。 */
      masteryClaimed: game.masteryClaimed || null,
      runGold: P.runGold || 0, frenzy: P.frenzy || 0, frenzyCharge: P.frenzyCharge || 0,
      elapsed: game.elapsed || 0,
      rankSeconds: game.rankSeconds || 0,
      revives: game.revives || 0,
      stageKills: game.stageKills || 0,
      stageHits: game.stageHits || 0,
      stageT: game.stageT || 0,
      swarmAt: game.swarmAt,
      bossCount: game.bossCount || 0,
      /* ⚠️ 恒为 0：Boss 实体本身不存档（存了也没意义），而 updateSpawns 靠
         `bossSpawnedForStage === stage` 判断"本关 Boss 已经出过"。
         只要照原样存回去，\"打过 Boss / 正在打 Boss 时退出\"再回来就**永远不会再出 Boss**
         → 这一关永远过不了（卡死）。归零 = 回来重新打一次这只 Boss。 */
      bossSpawnedForStage: 0,
      seenTypes: game.seenTypes || {},
      weaponGifted: game.weaponGifted || {},
      stageGained: game.stageGained || []
    };
  }

  /**
   * 游戏状态 → 纯对象
   * @param includeRun 是否带上\"当前这一局\"（默认不带：那是给\"继续上次\"用的，
   *   死了/重开了还留着它就等于死亡没代价）
   */
  function snapshot(game, includeRun) {
    var P = game.player, base = {};
    for (var k in P.base) if (Object.prototype.hasOwnProperty.call(P.base, k)) base[k] = P.base[k];
    var out = {
      v: VERSION,
      movementVersion: 3,
      balanceVersion: 1,
      level: P.level,
      xp: P.xp,
      gold: P.gold,
      kills: P.kills,
      taken: P.taken,
      /* 武器熟练度：**跨局永久**（见 applyMeta 里那段"不吃 keep"的说明）。
         浅拷一份：直接塞引用的话，外面动 player.mastery 会把已经交出去的存档对象也改了。 */
      mastery: Object.assign({}, P.mastery || {}),
      base: base,                 // 升级卡改过的裸装数值，不存就白升了
      equip: {
        weapon: P.equip.weapon,
        armor: P.equip.armor,
        trinket: P.equip.trinket
      },
      /* 武器库：和装备一样是"刷"的成果，跨局保留（见 player.bag / game.switchWeapon）。
         不存的话每次重开就只剩手上那一把，"随时切换"直接废掉。 */
      bag: P.bag || [],
      /* 玩家设置（音效/震动）：和进度存一份，跨启动记住 */
      settings: game.settings || null,
      best: {
        wave: game.bestWave || 1,
        kills: game.bestKills || 0
      },
      runs: game.runs || 0,
      ts: Date.now()
    };
    if (includeRun) out.run = runOf(game);
    return out;
  }

  /** 玩家设置（音乐/音效/震动）。和\"保留几分成果\"无关，keep='none' 也要记住 */
  function applySettings(game, data) {
    var d = (data && data.settings) || null;
    game.settings = game.settings || {};
    if (d) {
      if (typeof d.sound === 'boolean') game.settings.sound = d.sound;
      if (typeof d.vibrate === 'boolean') game.settings.vibrate = d.vibrate;
      /* 老存档里没有 music 这一项 → 保持 config 默认值（true），不能默认成 false：
         那样所有老玩家一更新就没音乐，还找不到原因（设置面板里是亮着的）。 */
      if (typeof d.music === 'boolean') game.settings.music = d.music;
    }
    return game.settings;
  }

  /** 把存档写回玩家。keep 见 config.save.keepOnDeath */
  function applyMeta(game, data, keep) {
    if (!data || typeof data !== 'object') return false;
    var cfg = game.cfg, P = game.player;
    applySettings(game, data);          // 先还原设置（与 keep 无关）

    /* ===== 武器熟练度：**故意放在 keep === 'none' 之前** =====
       2026-10 用户口径：熟练度是"练出来的"，不是这一局的战利品 ——
       死亡要有代价（等级/卡/装备照旧清），但**练度不能白掉**，否则"成长性"根本不成立。
       所以连 keep='none'（纯 roguelite，什么都不留）也要把熟练度接回来。
       ⚠️ 这段必须在下面那个 early return **之前**，挪下去就等于"死亡清空熟练度"。
       只收认得的武器 kind、只收非负数字：老存档没有这个字段时整段跳过（不是崩溃）。 */
    var mIn = data.mastery;
    if (mIn && typeof mIn === 'object') {
      P.mastery = P.mastery || {};
      for (var mk in mIn) {
        if (!Object.prototype.hasOwnProperty.call(mIn, mk)) continue;
        if (!cfg.weapons[mk]) continue;                       // 已删除的武器（scythe/axe）直接丢
        var mv = mIn[mk];
        if (typeof mv === 'number' && isFinite(mv) && mv > 0) P.mastery[mk] = Math.floor(mv);
      }
    }

    if (keep === 'none') return false;

    // 'loot' 也要留：金币和装备是"刷"的成果
    if (typeof data.gold === 'number') P.gold = data.gold;
    if (data.equip) {
      P.equip.weapon = data.equip.weapon || null;
      /* 武器改版迁移：'scythe'（巨镰）和 'axe'（战斧）是 2026-10 试过又整体删掉的两把
         （原因见 config.items.stageWeapons 那段），存档里留着它们就静默退回默认长剑。
         不认得的 kind 本来也会退回长剑，这里写明白是为了"这两把是被删的"不要被当成 bug 查。 */
      if (P.equip.weapon && (P.equip.weapon.kind === 'scythe' || P.equip.weapon.kind === 'axe')) {
        P.equip.weapon.kind = 'sword';
      }
      P.equip.armor = data.equip.armor || null;
      P.equip.trinket = data.equip.trinket || null;
    }
    /* 武器库：**不认得的种类直接丢掉**（比如已删除的 scythe/axe），
       老存档没有 bag 字段时用身上那把补一个 —— 否则"切武器"会是空面板。 */
    P.bag = [];
    var bagIn = data.bag || [], bi;
    for (bi = 0; bi < bagIn.length; bi++) {
      /* ⚠️ `trial-*` 是**试炼场发的试用武器**（id 前缀写死），不该进正式局的库：
         以前试炼场发完就留在包里，退回战场还带着 → 等于白得四把武器。
         （旧存档里可能已经攒了一堆，这里顺手清掉。） */
      if (bagIn[bi] && cfg.weapons[bagIn[bi].kind] && String(bagIn[bi].id || '').indexOf('trial-') !== 0) P.bag.push(bagIn[bi]);
    }
    /* ⚠️ 读档后 equip.weapon 和 bag 里那把是**两份内容相同的副本**（JSON 往返会丢引用）：
       ① 不按 id 去重就会把手上那把又塞一遍（武器库平白多一件）；
       ② 不把 equip.weapon 指回库里那个对象，"当前那把"的高亮、以及
          "点当前那把只关面板不切换"都会失效（渲染层用的是 === 比较）。 */
    var eq = P.equip.weapon;
    if (eq && cfg.weapons[eq.kind]) {
      var hit = -1;
      for (bi = 0; bi < P.bag.length; bi++) {
        if (P.bag[bi] && P.bag[bi].id === eq.id) { hit = bi; break; }
      }
      if (hit >= 0) P.equip.weapon = P.bag[hit];
      else P.bag.push(eq);
    }
    game.bestWave = Math.max(game.bestWave || 1, (data.best && data.best.wave) || 1);
    game.bestKills = Math.max(game.bestKills || 0, (data.best && data.best.kills) || 0);
    game.runs = (data.runs || 0) + 0;

    if (keep === 'all') {
      if (typeof data.level === 'number' && data.level > 0) P.level = data.level;
      if (typeof data.xp === 'number') P.xp = data.xp;
      if (data.taken) P.taken = data.taken;
      if (data.base) {
        for (var k in data.base) {
          if (Object.prototype.hasOwnProperty.call(data.base, k)) P.base[k] = data.base[k];
        }
      }
    }

    if (keep === 'all' && data.base && !data.movementVersion) {
      P.base.spd *= 185 / 205;
      P.base.orbitRetractSpd /= 1.12;
      P.base.dashSpeed *= 205 / 185;
    }
    if (keep === 'all' && cfg.trial.enabled && !data.balanceVersion) {
      P.base = Object.assign({}, cfg.player.base);
      cfg.upgrades.forEach(function(c){
        if(c.disabled)return;
        for(var n=0;n<Math.min(30,(P.taken||{})[c.id]||0);n++)c.apply(P.base);
        if(c.rare)for(var j=0;j<Math.min(30,(P.taken||{})[c.id+'#rare']||0);j++)c.rare.apply(P.base);
      });
    }
    game.Prog.recompute(P, cfg);          // 注意：Game 上的属性名是 Prog
    P.xpNext = game.Prog.xpForNext(P.level, cfg);
    P.hp = P.stats.maxhp;
    return true;
  }

  /** 存档是不是本文档认得的版本（改版后字段对不上就丢掉重建，别崩） */
  function isCompatible(data) {
    return !!data && data.v === VERSION;
  }

  /** 这份存档里有没有\"没打完的那一局\"（首页据此显示「继续上次」） */
  function hasRun(data) {
    return !!(data && data.run && data.run.stage >= 1);
  }

  /**
   * 「继续上次」：接着没打完的那一局往下打。
   * keep='all' 是为了把**这一局的等级/经验/升级卡**也一起还回来
   * （'loot' 会把等级清零 —— 那是\"死亡重开\"的规则，不是\"接着打\"的规则）。
   */
  function applyRun(game, data) {
    if (!hasRun(data)) return false;
    var r = data.run, P = game.player;

    applyMeta(game, data, 'all');

    /* 关卡 > 1 时要重建那一关的地形/配色/怪物池（Boss 也会按关卡表换） */
    if (r.stage > 1 && game.enterStage) game.enterStage(r.stage);

    if (typeof r.hp === 'number') P.hp = Math.max(1, Math.min(P.stats.maxhp, r.hp));
    if (typeof r.kills === 'number') P.kills = r.kills;
    if (typeof r.wave === 'number') game.wave = r.wave;
    if (typeof r.elapsed === 'number') game.elapsed = r.elapsed;
    game.rankSeconds=Number.isFinite(r.rankSeconds)&&r.rankSeconds>=0?r.rankSeconds:Math.max(0,game.elapsed||0);
    game.revives=Math.max(0,Math.floor(r.revives||0));
    if (typeof r.stageKills === 'number') game.stageKills = r.stageKills;
    if (typeof r.stageHits === 'number') game.stageHits = r.stageHits;
    if (typeof r.stageT === 'number') game.stageT = r.stageT;
    if (typeof r.swarmAt === 'number') game.swarmAt = r.swarmAt;
    if (typeof r.bossCount === 'number') game.bossCount = r.bossCount;
    if (typeof r.bossSpawnedForStage === 'number') game.bossSpawnedForStage = r.bossSpawnedForStage;
    if (r.seenTypes) game.seenTypes = r.seenTypes;
    if (r.weaponGifted) game.weaponGifted = r.weaponGifted;
    if (r.stageGained) game.stageGained = r.stageGained;
    game.harvestAnnounced = !!r.harvestAnnounced;
    game.harvestWarn = Math.max(0, r.harvestWarn || 0);
    game.harvestPrep = Math.max(0, r.harvestPrep || 0);
    game.harvestActive = Math.max(0, r.harvestActive || 0);
    game.harvestSpawnT = Math.max(0, r.harvestSpawnT || 0);
    P.pendingLevels = r.pendingLevels || 0;
    /* 叠刃的本局刃数 + 熟练度的"已领过"标记：都要接着上次的状态继续，
       否则① 退出再进刃数清零（卡了）② 精英的熟练度能重复领（刷分）。 */
    P.bladeUnityStacks = Math.max(0, Math.floor(r.bladeUnityStacks || 0));
    game.masteryClaimed = (r.masteryClaimed && typeof r.masteryClaimed === 'object')
      ? JSON.parse(JSON.stringify(r.masteryClaimed)) : {};
    P.runGold = r.runGold || 0; P.frenzy = r.frenzy || 0; P.frenzyCharge = r.frenzyCharge || 0;
    /* 限次爆发：参数整套接回来，但 **active/healed 一律清零** ——
       口径同"继续时敌方攻击重新预警"：回来要重新起转才算第一刀
       （否则读档瞬间刀就是 5 倍长 / 4 把刃，而玩家还没"转起来"，看起来像卡了）。
       ⚠️ 用 JSON 往返而不是认字段：老存档里没有新维度（bladesAdd 等）时它们是 undefined，
         消费点全是 `&&`/`||` 判断，undefined 等于 0/false，不会崩。 */
    if (r.burst) {
      P.burst = JSON.parse(JSON.stringify(r.burst));
      P.burst.left = Math.max(0, P.burst.left || 0);
      P.burst.active = false; P.burst.healed = 0; P.burst.capNoticed = false;
      P.burst.radiusMul = P.burst.radiusMul || 1;
    } else {
      P.burst = null;
    }

    /* 场上不留任何\"上一局的残留\"：怪/弹幕/地面威胁都不存档，回来就是一关的开场状态。
       地面威胁的计时也重新给满缓冲，否则一进来就落圈。 */
    game.foes.length = 0;
    game.projectiles.length = 0;
    game.pickups.length = 0;
    game.hazards.length = 0;
    game.bossAlive = 0;
    game.stageBossPending = false;
    game.clearT = 0;
    game.hazardT = game.cfg.hazards.startAt;
    P.inv = Math.max(P.inv, 1.5);
    if (game.cfg.trial.enabled) {
      game.stage=1;
      if (r.trialVersion===game.cfg.trial.version && r.trial) {
        game.trial=JSON.parse(JSON.stringify(r.trial));game.wave=Math.max(1,Math.min(3,r.wave||1));
        /* ⚠️ skillTaken 是 2026-10 新加的第 1 波教学 gate。老存档里没有这个字段：
           一律补 true —— 老存档在改动之前就没有"学到技能才刷怪"这条规则，
           补 false 会把老玩家的存档卡成"第 1 波永远不出怪"（血淋淋的教训：
           新加的 gate 字段必须给老存档一个"放行"默认值，不能给"拦截"值）。 */
        if(game.trial.skillTaken===undefined)game.trial.skillTaken=true;
        game.spitSerial=r.spitSerial||0;game.hazards=JSON.parse(JSON.stringify(r.poisonHazards||[]));
        game.foes=JSON.parse(JSON.stringify(r.foes||[]));game.pickups=JSON.parse(JSON.stringify(r.pickups||[]));
        game.foes.forEach(function(f){f.windup=0;f.charging=0;f.chargeCd=1;f.cast=null;f.slamT=2.5;f.volleyT=2;
          /* 荒原巨蝎的预警也一律清零（口径同 windup/cast：继续时敌方攻击重新预警）；
             ⚠️ 但 **phase2 和 spd 必须原样保留** —— phase2=true 时 spd 已经是乘过 1.3 的值，
                清成 false 会在下一帧重新触发裂壳、再乘一次 → Boss 越读档越快。 */
          f.claw=0;f.sting=0;f.crack=0;f.clawT=3.4;f.stingT=2.6;f.kb={x:0,y:0};f.orbCd=0;});
        P.slowT=0;P.slowMul=1;                      // 中毒不跨存档（否则回来就是"走不动"的状态）
        game.bossAlive=game.foes.filter(function(f){return f.kind==='boss';}).length;
        game.stageBossPending=game.bossAlive>0;game.bossSpawnedForStage=game.bossAlive?1:0;
        if(r.playerPosition){P.x=r.playerPosition.x;P.y=r.playerPosition.y;game.world.collide(P);}
        game.frenzyTotal=r.frenzyTotal||6;game.frenzyStartKills=r.frenzyStartKills||0;
        game.foes.forEach(function(f){if(f.trialFoe&&f.trialWave===undefined)f.trialWave=game.wave;});
        if(game.trial.finished)game.clearT=0.1;
      } else {
        game.wave=1;game.stageKills=0;game.stageT=0;game.stageHits=0;P.frenzy=0;P.frenzyCharge=0;
        game.initTrial();
      }
      /* ⚠️ 这里原本有"保证 5 把武器每把都在包里"的一段（英文注释写的是
         "Ensure every weapon…"）。2026-10 用户口径：开局只能有默认的长剑，
         其他不可选 —— 所以整段删掉。
         开局那把由 `Game.reset()` 保证（cfg.items.startWeapon）；
         试炼场要的全武器由 `Game.setTraining` 现场发、退出时收回。 */
      game.updateCamera();
    }
    return true;
  }

  return {
    VERSION: VERSION,
    snapshot: snapshot,
    applyMeta: applyMeta,
    applySettings: applySettings,
    isCompatible: isCompatible,
    hasRun: hasRun,
    applyRun: applyRun
  };
});
