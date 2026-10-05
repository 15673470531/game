/**
 * 核心层：成长与装备（纯运算，无渲染、无平台 API）
 *
 * 数值模型：player.base（裸装） --升级卡--> 装备词条 --> player.stats（实际生效）
 * 游戏逻辑一律读 player.stats。任何改动之后必须调 recompute()。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.__GAME__ = root.__GAME__ || {}).Progression = api;
})(typeof GameGlobal !== 'undefined' ? GameGlobal
   : (typeof window !== 'undefined' ? window : globalThis), function () {
  'use strict';

  /* ---------- 随机工具 ---------- */
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

  function pickWeighted(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].weight;
    var r = Math.random() * total;
    for (i = 0; i < list.length; i++) {
      r -= list[i].weight;
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 等级 ---------- */
  function xpForNext(level, cfg) {
    return Math.round(cfg.growth.baseXp * Math.pow(cfg.growth.xpGrowth, level - 1));
  }

  /* ---------- 升级卡 ---------- */
  /** 抽 n 张不同的卡；已拿过的优先排除，不够就允许重复 */
  /* 金色卡的 id 后缀：taken 记的是带后缀的 id，所以**普通版和金色版可以各拿一次** */
  var RARE_SUFFIX = '#rare';

  /** 抽 n 张卡。opts.rareChance 可覆盖金色卡概率（测试用 0/1 钉死，别靠随机数碰运气） */
  /** 机制卡：改"你能做什么"的卡（config 里标了 `cat:'mechanic'`）。
      ⚠️ 判断只看 `cat`，不要用"有没有 burst"之类的间接特征 —— 处决/灼痕不是 burst 卡。 */
  function isMechanic(u) { return !!u && u.cat === 'mechanic'; }
  /** 成长卡：`growth:true`（长刃/巨刃/旋刃）。抽卡保底只认这个标记，别在别处另写一份名单 */
  function isGrowth(u) { return !!u && !!u.growth; }

  /**
   * 从池子里**加权**、不重复地抽 n 张。`weightOf(card)` 返回权重（缺省 1）。
   * 用途：2026-10 用户选的"同类连续限流" —— 上一排出现过机制卡时，这一排把机制卡权重降到 0.35。
   * ⚠️ 用加权抽取而不是"抽完发现有就重抽"：重抽会悄悄改变**其他卡**的概率分布，
   *    加权抽取的概率是可解释、可复算的（写在 config 里）。 */
  function pickWeightedN(pool, weightOf, n) {
    var left = pool.slice(), out = [], i;
    while (out.length < n && left.length) {
      var total = 0;
      for (i = 0; i < left.length; i++) total += Math.max(0, weightOf(left[i]));
      var k = 0;
      /* ⚠️ `total > 0` 这个分支不能省：权重全为 0（比如把 repeatMechWeight 调成 0 想"硬禁"）时
         除零会算出 NaN，抽出来的卡是 undefined —— 表现是"整排空白"，很难查。 */
      if (total > 0) {
        var r = Math.random() * total;
        k = left.length - 1;
        for (i = 0; i < left.length; i++) {
          r -= Math.max(0, weightOf(left[i]));
          if (r <= 0) { k = i; break; }
        }
      } else {
        k = Math.floor(Math.random() * left.length);   // 全 0：退回等概率
      }
      out.push(left.splice(k, 1)[0]);
    }
    return out;
  }

  function drawUpgrades(cfg, taken, n, opts) {
    opts = opts || {};
    /* 熟练度解锁（2026-10）：卡上可以带两条门槛，这里一起过 ——
         · `masteryMin`  该武器熟练度要到这个**等级**才进池（点数门槛查 config.mastery.levels）
         · `onlyWeapon`  只有拿这把武器才抽得到
       ⚠️ 表达"只有长剑能抽到"**不要复用卡上现成的 `weapon` 字段**：`weapon` 会被
          `allowSkill:false` 一起过滤掉（那条口径是"武器技能不给卡，改精英掉卷轴"），
          卡会**静默消失** —— 抽卡逻辑看起来一切正常，就是永远抽不到，极难查。
       ⚠️ opts.masteryPts 缺省按 0（= Lv1）处理：不传它的调用方（老验收脚本、试卡面板）
          会退化成"未解锁的卡一律不出现"，而不是崩。 */
    var mlevels = (cfg.mastery && cfg.mastery.levels) || [0];
    var mPts = Math.max(0, opts.masteryPts || 0);
    function unlockedByMastery(u) {
      if (!u.masteryMin) return true;
      var need = mlevels[u.masteryMin - 1];
      return need !== undefined && mPts >= need;
    }
    function weaponAllowed(u) {
      if (u.onlyWeapon && u.onlyWeapon !== opts.weapon) return false;
      return !u.weapon || (u.weapon === opts.weapon && opts.allowSkill !== false);
    }
    var eligible = cfg.upgrades.filter(function (u) {
      return !u.disabled && weaponAllowed(u) && unlockedByMastery(u);
    });
    /* `stackable`（成长类卡）**不受"已拿过"限制**：一局可以反复拿。
       2026-10 用户口径："就算拿满增加长度的卡，打完剑还是不够长" —— 根因就是这一行：
       原来所有卡一局只能拿一次，尺寸卡最多只能凑到 2 张（×1.24），想堆也堆不了。
       （`taken` 的 key 可能带 `#rare` 后缀，所以金色版本来就是另一条记录；这里放行的是可叠卡本身。） */
    var pool = eligible.filter(function (u) { return !taken[u.id] || u.stackable; });
    // Exhaustion may repeat general stat cards, never an already-owned one-shot skill.
    if (pool.length < n) pool = eligible.filter(function (u) { return !u.weapon || !taken[u.id] || u.stackable; });
    var out = shuffle(pool).slice(0, n);
    var skills = shuffle(pool.filter(function (u) { return !!u.weapon; }));
    // Game controls skill eligibility by completed choices; eligible rows offer one skill.
    if (skills.length && out.length) {
      var chosen = skills[0];
      /* 通用卡那两个位置：**加权抽**（见 config.growth.repeatMechWeight 的说明）。
         opts.lastMechanic = 上一排出现过机制卡 ⇒ 这一排机制卡权重被压低。 */
      var mechW = (opts.lastMechanic && cfg.growth && cfg.growth.repeatMechWeight !== undefined)
        ? cfg.growth.repeatMechWeight : 1;
      var nonW = pool.filter(function (u) { return !u.weapon; });
      out = [chosen].concat(pickWeightedN(nonW, function (u) {
        return isMechanic(u) ? mechW : 1;
      }, n - 1));
    } else if (out.length) {
      /* ⚠️ 没有武器卡可给时（`allowSkill:false` —— 2026-10 技能改成精英掉落之后这是个常态，
         或者这把武器的技能都拿过了）走的是上面那条 `shuffle().slice()` 的**统一抽样**分支。
         机制卡的连续限流必须在这里也做一遍，否则"机制卡别连着出"那条口径会**静默失效**：
         实测把技能卡移出卡池后，不补这段的话出现率会从 49% 跳到 66%，而且 lastMechanic 完全不起作用
         （verify-skill-drop 里那条 66% vs 66.5% 的读数就是它）。 */
      var mechW2 = (opts.lastMechanic && cfg.growth && cfg.growth.repeatMechWeight !== undefined)
        ? cfg.growth.repeatMechWeight : 1;
      out = pickWeightedN(pool, function (u) { return isMechanic(u) ? mechW2 : 1; }, n);
    }
    /* 成长保底（opts.guaranteeGrowth，2026-10 用户选的方案 3）：这一排里**至少一张成长卡**。
       为什么保底而不是加权重：加权只能提高概率，"想专门堆长度"的玩家还是可能连着两排抽不到 ——
       而"一局打完武器天差地别"这条口径要求它**必得**。
       ⚠️ 放在 limitCostCards **之前**，而且优先挑**非代价**的成长卡（长刃/旋刃）：
          放到限流之后的话，一排里已经有两张代价卡时会把保底塞进来的那张再换走，保底等于白设。
          放前面 + 用非代价卡，限流就算把别的代价卡换掉，保底那张也稳稳留着。
       ⚠️ 换位子优先挑"非武器 + 非机制卡"（机制卡有它自己的连出限流口径，别搅在一起）；
          一排三张全是机制/代价卡时退而求其次换机制卡 —— 保底比"这一排一张机制卡都没有"更重要
          （实测 seed 1 就是这样漏了一排）。 */
    if (opts.guaranteeGrowth && out.length && !out.some(isGrowth)) {
      var gsrc = pool.filter(function (u) { return u.growth && !u.weapon && !u.cost; });
      if (!gsrc.length) gsrc = pool.filter(function (u) { return u.growth && !u.weapon; });
      if (gsrc.length) {
        var slot = -1;
        for (var si = out.length - 1; si >= 0; si--) if (!out[si].weapon && !isMechanic(out[si])) { slot = si; break; }
        if (slot < 0) for (var sj = out.length - 1; sj >= 0; sj--) if (!out[sj].weapon) { slot = sj; break; }
        if (slot >= 0) out[slot] = shuffle(gsrc.slice())[0];
      }
    }
    out = limitCostCards(out, pool.filter(function (u) { return !u.weapon; }), (opts && opts.maxCost !== undefined) ? opts.maxCost : 1);
    /* 金色卡：每次抽卡有 rareCardChance 的概率把其中一张换成强化版（强度约 2 倍）。
       它是"卡池越大越平"的解药：抽中就有记忆点（见 config.growth.rareCardChance）。 */
    var chance = (opts && opts.rareChance !== undefined) ? opts.rareChance
               : ((cfg.growth && cfg.growth.rareCardChance) || 0);
    if (out.length && chance > 0 && Math.random() < chance) {
      var i = Math.floor(Math.random() * out.length);
      if (out[i].rare) out[i] = rareCard(out[i]);
    }
    return out;
  }

  /**
   * 代价卡（`cost: true` 的两向卡）**每排最多 maxCost 张**（默认 1）。
   * 为什么必须有这条：一排三张全是"有代价的"就等于逼玩家吃亏（没有"跳过"这个选项）。
   * 实测证据：4 张新卡刚混进池子时，站桩 AI 存活 45.2s → 28.9s、过关 0.3 → 0 ——
   * 变的不是数值平衡，而是"AI 被迫拿了代价卡"。限制成每排最多 1 张之后，
   * 玩家永远有不选代价的余地，代价卡才是**选项**而不是**陷阱**。
   */
  function limitCostCards(out, pool, maxCost) {
    var i, costIdx = [], free = [], inOut = {};
    for (i = 0; i < out.length; i++) if (out[i].cost) costIdx.push(i);
    if (costIdx.length <= maxCost) return out;
    for (i = 0; i < out.length; i++) inOut[out[i].id] = 1;
    for (i = 0; i < pool.length; i++) if (!pool[i].cost && !inOut[pool[i].id]) free.push(pool[i]);
    while (costIdx.length > maxCost && free.length) out[costIdx.pop()] = free.pop();
    return out;
  }

  /** 金色版的卡片对象。
      ⚠️ 标记必须叫 gold 不能叫 rare：config 里**每张卡**都有 rare（金色版定义），
      卡对象上再挂 rare 的话"这张卡是不是金色版"就永远为真（第一版就是这么翻车的）。
      ⚠️ `burst` 必须显式带过来：限次爆发卡（开天）的参数就放在这里，
         漏带的话金色版抽到会退化成"没有参数"，游戏层读不到 ×8 / 3 刀 —— 这种字段漏带最难查。 */
  function rareCard(u) {
    return {
      id: u.id + RARE_SUFFIX, name: u.rare.name, desc: u.rare.desc,
      gold: true, cost: !!u.cost, apply: u.rare.apply,
      cat: u.cat || null,              // ⚠️ 也要带：出卡的"同类连续限流"靠 cat 认机制卡
      /* ⚠️ 也必须带 growth/stackable：金色版是**重新拼的对象**，漏带就是"换了个身份"。
         实际踩到的坑（2026-10）：成长保底塞进来的长刃一旦中了 12% 金色，就变成一张
         "不被认定成成长卡"的卡 —— 保底等于白设，测试也会判这一排没有成长卡。 */
      growth: !!u.growth, stackable: !!u.stackable,
      /* ⚠️ 解锁门槛也必须带过来：金色版是**重新拼的对象**，漏带就是"换了个身份" ——
         金色版会绕过熟练度门槛被抽出来（和之前漏带 growth 那个坑同一类）。 */
      masteryMin: u.masteryMin || 0, onlyWeapon: u.onlyWeapon || null,
      burst: u.rare.burst || u.burst || null
    };
  }

  /** 把某张卡应用到 base 上（只改 base，改完要 recompute）。id 可以是金色版的 */
  function applyUpgrade(cfg, player, id) {
    for (var i = 0; i < cfg.upgrades.length; i++) {
      var u = cfg.upgrades[i];
      var rare = (id === u.id + RARE_SUFFIX);
      if (!rare && id !== u.id) continue;
      if (rare && !u.rare) continue;
      if (u.weapon && player.taken[u.id]) return false;
      (rare ? u.rare : u).apply(player.base);
      player.taken[id] = (player.taken[id] || 0) + 1;
      recompute(player, cfg);
      if (id.indexOf('hp') === 0) player.hp = Math.min(player.stats.maxhp, player.hp + (rare ? 22 : 15));   // 坚韧只回复本次增加的生命，不再回满
      return true;
    }
    return false;
  }

  /* ---------- 装备 ---------- */
  /**
   * 滚一件装备。
   * @param opts { allowWeapon: bool, weaponChance: number, forceKind: string,
   *               rarityBonus: number, affixMul: number }
   *   武器单独一个池，默认**不允许**出（只有 Boss 掉落会传 allowWeapon）——
   *   非武器池里再按 weaponChance 滚一次"这次到底给不给武器"，
   *   所以实际概率就等于 weaponChance（而不是"三选一里占三分之一"那种含混的概率）。
   *   rarityBonus / affixMul：第 5 关起 Boss 掉落的"品质加成"（见 config.items.lateReward）。
   */
  function rollItem(cfg, wave, opts) {
    opts = opts || {};
    var slots = cfg.items.slots, i;
    var weapon = null, others = [];
    for (i = 0; i < slots.length; i++) {
      if (slots[i].id === 'weapon') weapon = slots[i]; else others.push(slots[i]);
    }
    var slot = null;
    if (weapon && opts.allowWeapon && Math.random() < (opts.weaponChance || 0)) slot = weapon;
    if (!slot) slot = others[Math.floor(Math.random() * others.length)];
    /* opts.rarity：**钉死稀有度**（试炼场用它保证"同一品质比武器"）。
       只钉"这一档"，后面的 rarityBonus 照常往上抬。 */
    var rarity = (opts.rarity !== undefined)
      ? cfg.items.rarities[Math.max(0, Math.min(cfg.items.rarities.length - 1, opts.rarity - 1))]
      : pickWeighted(cfg.items.rarities);
    /* rarityBonus：把这次滚到的稀有度**往上抬 k 档**（抬到顶就停在史诗）。
       按稀有度表的顺序抬（普通→精良→稀有→史诗），所以"第 5 关起最低也是精良"。 */
    if (opts.rarityBonus) {
      var ri = cfg.items.rarities.indexOf(rarity) + opts.rarityBonus;
      rarity = cfg.items.rarities[Math.max(0, Math.min(cfg.items.rarities.length - 1, ri))];
    }
    if (cfg.trial.enabled && rarity.id > 2) rarity = cfg.items.rarities[1];
    var defs = cfg.items.affixes[slot.id];
    var affixes = [];

    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var v = d.base * rarity.mult * (1 + wave * d.scale) * (opts.affixMul || 1);
      // 攻速这类负数词条保留小数，属性类取整
      v = (Math.abs(v) < 1) ? Math.round(v * 1000) / 1000 : Math.round(v);
      if(cfg.trial.enabled){var limits={attackDamage:7,maxhp:30,spd:12,attackCooldown:0.025};if(limits[d.k])v=Math.min(v,limits[d.k]);}
      affixes.push({ k: d.k, v: v, label: d.label, negate: !!d.negate });
    }

    // 武器：再滚一个种类（决定攻击方式与外观），这是"换武器"最有感知的部分
    var kind = null, displayName = slot.name;
    if (slot.id === 'weapon') {
      kind = opts.forceKind || pickWeighted(cfg.items.weaponKinds).id;   // forceKind：Boss 专属武器
      displayName = cfg.weapons[kind].name;
    }

    // 评分：所有词条相对其基准的倍数之和 —— 用来判断"新装备是否更好"
    var score = 0;
    for (i = 0; i < affixes.length; i++) score += Math.abs(affixes[i].v) / defs[i].base;

    return {
      id: slot.id + '-' + rarity.id + '-' + Math.floor(Math.random() * 1e6),
      slot: slot.id,
      slotName: slot.name,
      kind: kind,
      name: displayName,
      rarity: rarity.id,
      rarityName: rarity.name,
      color: rarity.color,
      affixes: affixes,
      score: score
    };
  }

  function itemText(item) {
    var out = [];
    if (item.kind) out.push('武器类型：' + item.name);
    for (var i = 0; i < item.affixes.length; i++) {
      var a = item.affixes[i];
      var sign = a.negate ? '-' : '+';
      var val = (Math.abs(a.v) < 1) ? a.v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : a.v;
      out.push(a.label + ' ' + sign + Math.abs(val));
    }
    return out.join('  ');
  }

  function rollGold(range) { return randInt(range[0], range[1]); }

  /* ---------- 核心：把 base + 装备算成 stats ---------- */
  function recompute(player, cfg) {
    var b = player.base, s = {}, k;
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) s[k] = b[k];

    var slots = cfg.items.slots;
    for (var i = 0; i < slots.length; i++) {
      var it = player.equip[slots[i].id];
      if (!it) continue;
      for (var j = 0; j < it.affixes.length; j++) {
        var a = it.affixes[j];
        s[a.k] = (s[a.k] || 0) + a.v * (a.negate ? -1 : 1);
      }
    }

    if (cfg.trial && cfg.trial.enabled) {
      s.attackDamage = Math.min(s.attackDamage, b.attackDamage + 10);
      s.maxhp = Math.min(s.maxhp, b.maxhp + 30);
      s.attackCooldown = Math.max(s.attackCooldown, b.attackCooldown - 0.025);
      s.spd = Math.min(cfg.player.base.spd * 1.25, s.spd, b.spd + 12);
      s.dashCooldown = Math.max(0.55, s.dashCooldown);
    }
    // 下限保护：别让词条叠出负数或零
    s.attackCooldown = Math.max(0.08, s.attackCooldown);
    s.attackRange = Math.max(24, s.attackRange);
    s.attackArc = Math.min(2.4, Math.max(0.3, s.attackArc));
    s.spd = Math.max(70, s.spd);
    s.maxhp = Math.max(10, Math.round(s.maxhp));
    s.attackDamage = Math.max(1, s.attackDamage);
    if (!s.thorns) s.thorns = 0;
    if (!s.lifesteal) s.lifesteal = 0;

    var t = player.taken || {};
    function has(id) { return !!(t[id] || t[id + '#rare']); }
    player.evolutions = {
      flame: has('trail') && has('dash'),
      storm: has('blades') && has('aspd'),
      quake: has('giantblade') && has('dmg')
    };
    player.stats = s;
    if (player.hp > s.maxhp) player.hp = s.maxhp;
    return s;
  }

  /**
   * 武器入库（2026-10 武器库口径）。规则和防具/饰品**不一样**：
   *   ① 同一种武器只留**更好的那把**（不然武器库会塞满重复的长枪）
   *   ② 新种类 → 入库并**自动装上**（"你拿到了新武器"要立刻有手感上的反馈）
   *   ③ 同种但更好 → 换掉库里那件；**如果你正拿着这种**，手上那把顺带升级，
   *      否则不打扰你正在用的武器（不然打一半手上突然换了一把，很突然）
   * @returns 记录（过关面板要列"这关拿到了什么"），形状和 collect 里防具那条一致
   */
  /**
   * 「属性」页签要显示的行（2026-10 用户口径）【本段属于 statText/statRows，和上面的 tryEquipWeapon 无关】：
   *   **只列本局拿过的卡**（A1），一条 = 一项属性，写成 `攻击力 36 → 64（+77%）`（C3）。
   * 数值口径：`player.base` 是"裸装基准 + 卡片"，装备词条加在 `player.stats` 上 ——
   *   所以这里比的是 base，**不含装备**（装备不在这页，免得两个来源混在一起说不清）。
   * 多张卡改同一项时（锋利 / 锋利·极）**合成一行**：数值是累计的，右边列出贡献的卡名。
   * 一行都没有 = 本局还没拿过卡（渲染层出空状态，不画 12 个 0）。
   * ⚠️ 每张卡都要有 `stat: {label, field, kind}`（smoke 里有结构性断言兜底），
   *    以后加卡忘了写会被测试当场抓住。
   */
  function statRows(cfg, player) {
    var taken = (player && player.taken) || {}, base = cfg.player.base, rows = [], seen = {};
    var probe = { base: base };                       // 假装一个"什么都没拿"的玩家，用来取基准值
    for (var i = 0; i < cfg.upgrades.length; i++) {
      var u = cfg.upgrades[i];
      /* stat 可以是**数组**（代价卡：一个卡改两项）—— 两个方向都要列出来，
         只写好处不写代价 = 面板在骗人（"我明明选了玻璃大炮，生命上限怎么不看提示就掉了"）。 */
      var list = !u.stat ? null : (u.stat.length ? u.stat : [u.stat]);
      if (!list || !list.length) continue;
      var plain = !!taken[u.id], gold = !!taken[u.id + RARE_SUFFIX];
      if (!plain && !gold) continue;
      for (var s = 0; s < list.length; s++) {
        var st = list[s], key = st.field || u.id;
        var row = seen[key];
        if (!row) {
          var v0 = statValueOf(st, probe, cfg, base), v1 = statValueOf(st, player, cfg, base);
          row = seen[key] = { label: st.label + (u.weapon ? '（' + cfg.weapons[u.weapon].name + '）' : ''), kind: st.kind, field: st.field,
                              baseV: v0, nowV: v1, cards: [], text: '' };
          rows.push(row);
        }
        if (plain) row.cards.push({ name: u.name, gold: false });
        if (gold) row.cards.push({ name: u.rare.name, gold: true });
        row.text = statText(row);
      }
    }
    return rows;
  }

  /** 取某一项属性的"显示值"（卡可以自带 get，比如转速要取倒数、半径要换算成画面上的半径） */
  function statValueOf(st, P, cfg, base) {
    var v = st.get ? st.get(P, cfg) : (P.base || base)[st.field];
    return (v === undefined || v === null || isNaN(v)) ? 0 : v;
  }

  /** 一行文案：`攻击力 36 → 64（+77%）`；基准是 0 的项（回血/反伤）不硬凑百分比 */
  function statText(r) {
    var L = r.label, a = r.baseV, b = r.nowV;
    var pct = a ? Math.round((b / a - 1) * 100) : 0;
    var pcts = (a && (b !== a)) ? '（' + (pct >= 0 ? '+' : '') + pct + '%）' : '';
    if (r.kind === 'flat') return L + ' ' + Math.round(a) + ' → ' + Math.round(b) + pcts;
    if (r.kind === 'sec') return L + ' ' + a.toFixed(2) + ' → ' + b.toFixed(2) + ' 秒' + pcts;
    if (r.kind === 'mul') return L + ' ×' + a.toFixed(2) + ' → ×' + b.toFixed(2) + pcts;
    if (r.kind === 'pct') return L + ' ' + Math.round(a * 100) + '% → ' + Math.round(b * 100) + '%';
    if (r.kind === 'bool') return L + ' ' + (a ? '有' : '无') + ' → ' + (b >= 2 ? '有（更强）' : (b ? '有' : '无'));
    return L + ' ' + Math.round(b);
  }

  /** 武器入库：同种只留更好的那把、新种类自动装上（上面 209 行那段注释说的是这个函数） */
  function tryEquipWeapon(player, cfg, item) {
    var bag = player.bag || (player.bag = []);
    var cur = player.equip.weapon;
    var same = null, i;
    for (i = 0; i < bag.length; i++) {
      if (bag[i] && bag[i].kind === item.kind) { same = bag[i]; break; }
    }
    var rec = { item: item, bagged: false, equipped: false, replaced: null, better: null };

    if (same) {
      if (item.score <= same.score) { rec.better = same; return rec; }   // 库里那把更好 → 不入库
      bag[bag.indexOf(same)] = item;
      rec.bagged = true;
      rec.replaced = same;
      if (cur && cur.kind === item.kind) {                 // 正拿着这种 → 顺带升级
        player.equip.weapon = item;
        rec.equipped = true;
        recompute(player, cfg);
      }
      return rec;
    }

    bag.push(item);
    rec.bagged = true;
    rec.equipped = true;
    rec.replaced = cur || null;                            // 自动装上：原来手里那把被换下来（没丢，还在库里）
    player.equip.weapon = item;
    recompute(player, cfg);
    return rec;
  }

  /**
   * 开局那把默认长剑的"物品形态"：普通品质、**没有任何词条**（它就是基准）。
   * 为什么要给默认武器一个物品：
   *   ① 用户口径"**就算一个武器也要显示**"—— 武器库入口/面板从开局第一秒就该在
   *   ② 切回长剑也应该是合法的（不想用新武器时换回基准）
   * 零加成 ⇒ 和以前"equip.weapon = null 时回退到 cfg.weapons.sword"完全等价，
   * 数值上一分不差（recompute 加的是空词条表）。
   */
  function makeDefaultWeapon(cfg) {
    var r = cfg.items.rarities[0];
    return {
      id: 'sword-default', slot: 'weapon', slotName: '武器', kind: 'sword',
      name: cfg.weapons.sword.name, rarity: r.id, rarityName: r.name, color: r.color,
      affixes: [], score: 0
    };
  }

  /** 拾取装备（防具 / 饰品）：比身上这件强就换上，返回是否换装 */
  function tryEquip(player, cfg, item) {
    var cur = player.equip[item.slot];
    if (cur && cur.score >= item.score) return false;
    player.equip[item.slot] = item;
    recompute(player, cfg);
    if (item.slot === 'armor') player.hp = Math.min(player.stats.maxhp, player.hp + 0.2 * player.stats.maxhp);
    return true;
  }

  /* ---------- 武器熟练度 ---------- */
  /**
   * 武器熟练度换算（纯函数，改数值只改 config.mastery，别在别处另写一份）。
   * ⚠️ **等级不存盘**，只由点数算出来 —— 存了就有两份数据（点数 + 等级），迟早对不上。
   */
  /** 点数 → 等级（**1 起算**）。levels 是累积门槛，下标 0 = Lv1（起始等级，门槛 0） */
  function masteryLevel(pts, cfg) {
    var L = (cfg.mastery && cfg.mastery.levels) || [0];
    var p = Math.max(0, pts || 0), lv = 1;
    for (var i = 0; i < L.length; i++) if (p >= L[i]) lv = i + 1;
    return lv;
  }

  /** 某一级需要多少累积点数（Lv1 = 0）。**不存在的那一级返回 Infinity** —— 调用方靠它判满级 */
  function masteryNeed(level, cfg) {
    var L = (cfg.mastery && cfg.mastery.levels) || [0];
    if (level <= 1) return 0;
    return L[level - 1] !== undefined ? L[level - 1] : Infinity;
  }

  /**
   * 面板要的一整套读数。`from`/`to` 是**本级区间的两端**：
   * 进度条按 (pts-from)/(to-from) 画，文字按 "pts / to" 显示（用户口径：
   * 分母用"当前等级的满级熟练度"，不做成满级大数 —— 否则刚起步就看着没戏）。
   * 满级时 to = from（进度条画满），maxed = true。
   */
  function masteryInfo(pts, cfg) {
    var p = Math.max(0, Math.floor(pts || 0));
    var lv = masteryLevel(p, cfg);
    var from = masteryNeed(lv, cfg);
    var to = masteryNeed(lv + 1, cfg);
    var maxed = !(to < Infinity);
    return {
      pts: p, level: lv, maxed: maxed,
      from: from, to: maxed ? from : to,
      remain: maxed ? 0 : Math.max(0, to - p)
    };
  }

  return {
    xpForNext: xpForNext,
    masteryLevel: masteryLevel,
    masteryNeed: masteryNeed,
    masteryInfo: masteryInfo,
    drawUpgrades: drawUpgrades,
    isMechanic: isMechanic,          // 机制卡判定：只认 config 里的 cat:'mechanic'（一处定义，别各写各的）
    isGrowth: isGrowth,              // 成长卡判定：只认 config 里的 growth:true（同上，一处定义）
    statRows: statRows,
    applyUpgrade: applyUpgrade,
    rollItem: rollItem,
    itemText: itemText,
    rollGold: rollGold,
    recompute: recompute,
    tryEquip: tryEquip,
    tryEquipWeapon: tryEquipWeapon,
    makeDefaultWeapon: makeDefaultWeapon,
    pickWeighted: pickWeighted,
    shuffle: shuffle,
    randInt: randInt
  };
});
