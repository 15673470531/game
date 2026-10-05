'use strict';
/**
 * BGM（背景音乐）：关卡内的循环背景音乐 + 设置面板的「音乐」开关。
 *
 * 被测模块：
 *   · 核心层 `Game.prototype.bgmTrack()` —— 只回答"现在该放哪一首"（判定只此一处）
 *   · 设置层 `settings.music` / 设置面板 & 暂停面板的「音乐」行 / 存档往返
 *   · 平台层 `platform/wechat/audio.js` 的 BGM 通道（独立实例、淡入淡出、中断/前后台、幂等）
 *
 * 为什么这些断言必须有（每一条都对应一个真机才会暴露的坑）：
 *   ① **幂等**：tickMusic 是每帧调的，不判重就是每帧 restart —— 听起来是"一直在第一拍飘"，
 *      比干脆没音乐还糟；而读代码完全看不出来。
 *   ② **切换要淡出再淡入**：InnerAudioContext 没有 crossfade，硬切会"啪"一下。
 *   ③ **关掉音乐**必须真的停（不是音量调 0 还在后台解码 —— Android 同时只能 10 个音频）。
 *   ④ **中断/退后台**必须停、回来自动接上（来电后音乐不响 = 玩家以为坏了）。
 *   ⑤ **BGM 音量低于所有音效**：BGM 一大，打击感立刻糊。
 *   ⑥ **老存档没有 music 字段**时要保持默认开（默认成关 = 全员更新后静音，还找不到原因）。
 */
const assert = require('assert'), path = require('path'), fs = require('fs');
const root = path.resolve(__dirname, '..'), cfg = require(root + '/core/config');
const Game = require(root + '/core/game');
const WechatAudio = require(root + '/platform/wechat/audio.js');
const deps = {};
for (const [k, f] of Object.entries({ World: 'world', Entities: 'entities', Progression: 'progression', Save: 'save' })) {
  deps[k] = require(root + '/core/' + f);
}

function make(gameCfg) { const g = new Game(gameCfg || cfg, deps); g.setViewport(812, 375); return g; }

/** 假 wx：把 createInnerAudioContext 换成记账对象，并把生命周期事件存起来自己触发 */
function fakeWx() {
  const w = { instances: [], handlers: {}, opts: [] };
  w.createInnerAudioContext = function () {
    const a = {
      src: '', loop: false, volume: 1, plays: 0, stops: 0, pauses: 0, destroys: 0, _on: {},
      play() { this.plays++; }, stop() { this.stops++; }, pause() { this.pauses++; },
      destroy() { this.destroys++; },
      onPlay(f) { this._on.play = f; }, onEnded(f) { this._on.ended = f; }, onError(f) { this._on.error = f; }
    };
    w.instances.push(a);
    return a;
  };
  w.setInnerAudioOption = function (o) { w.opts.push(o); };
  w.vibrateShort = function () { };
  ['onAudioInterruptionBegin', 'onAudioInterruptionEnd', 'onHide', 'onShow'].forEach(function (k) {
    w[k] = function (f) { w.handlers[k] = f; };
  });
  return w;
}
/** 推 n 帧（60fps），返回跑完之后的适配器 */
function frames(au, n, dt) { for (let i = 0; i < n; i++) au.tickMusic(dt === undefined ? 1 / 60 : dt); return au; }

/* ==================== ① 配置：数值口径 + 曲目文件真的在包里 ==================== */
{
  const bgm = cfg.audio && cfg.audio.bgm;
  assert(bgm, 'cfg.audio.bgm 必须存在（曲目路径只写在这里一处）');
  assert.equal(bgm.enabled, true, 'BGM 默认开');
  assert(bgm.volume > 0 && bgm.volume < 1, 'volume 要在 (0,1)');
  assert(bgm.fadeIn > 0 && bgm.fadeOut > 0, '淡入淡出时长必须 > 0（不然就是硬切）');

  const minGain = Math.min.apply(null, Object.keys(WechatAudio.GAIN).map(k => WechatAudio.GAIN[k]));
  assert(bgm.volume < minGain,
    'BGM 音量(' + bgm.volume + ') 必须低于最小的音效音量(' + minGain + ') —— 否则打击感被糊掉');

  const src = bgm.tracks.stage;
  assert(src && typeof src === 'string', "必须配一首 stage 曲（关卡内/首页都用它）");
  const abs = path.join(root, src);
  assert(fs.existsSync(abs), '曲目文件不存在：' + src + '（配了路径但文件没打进包 = 静默无声）');
  const kb = fs.statSync(abs).size / 1024;
  assert(kb > 50 && kb < 900, '曲目体积 ' + kb.toFixed(0) + 'KB 不合理（空文件或大得离谱）');

  /* boss 曲可以先没有（null = 自动退回 stage）；但一旦配了，文件也必须真的在 */
  if (bgm.tracks.boss) assert(fs.existsSync(path.join(root, bgm.tracks.boss)), 'boss 曲配了但文件不存在');
}

/* ==================== ② 核心层：该放哪一首（判定只此一处） ==================== */
{
  const g = make();
  assert.equal(g.settings.music, true, '音乐默认开');
  assert.equal(g.bgmTrack(), 'stage', '首页/关卡内都放 stage（首页也放：一进来就有声）');
  assert.equal(g.bossAlive, 0);

  g.bossAlive = 1;
  assert.equal(g.bgmTrack(), 'stage', 'Boss 曲没配时必须**退回 stage**，不许静音');

  const cfg2 = JSON.parse(JSON.stringify(cfg));
  cfg2.audio.bgm.tracks.boss = 'assets/audio/bgm/boss.mp3';
  const g2 = make(cfg2);
  g2.bossAlive = 2;
  assert.equal(g2.bgmTrack(), 'boss', '场上有 Boss 且配了 boss 曲 → 换 Boss 曲');
  g2.bossAlive = 0;
  assert.equal(g2.bgmTrack(), 'stage', 'Boss 清掉后要切回 stage');

  g2.settings.music = false;
  assert.equal(g2.bgmTrack(), null, '玩家关掉音乐 → null（平台层会淡出）');

  const cfg3 = JSON.parse(JSON.stringify(cfg));
  cfg3.audio.bgm.enabled = false;
  assert.equal(make(cfg3).bgmTrack(), null, 'cfg 里禁用 → null');
}

/* ==================== ③ 平台层：淡入 / 幂等 / 切曲 / 关掉 ==================== */
{
  const wx = fakeWx();
  const au = new WechatAudio(wx, 'assets/audio/', { bgm: cfg.audio.bgm });

  au.setBgmTrack('stage');
  au.tickMusic(1 / 60);
  assert.equal(wx.instances.length, 1, 'BGM 只该建 1 个独立实例（不进音效池）');
  const inst = wx.instances[0];
  assert.equal(inst.loop, true, 'loop 必须交给底层（自己接缝会断）');
  assert.equal(inst.src, cfg.audio.bgm.tracks.stage, 'src 要等于 cfg 里配的路径');
  assert.equal(inst.plays, 1, '第一帧就该起播');
  assert(inst.volume > 0 && inst.volume < cfg.audio.bgm.volume, '要从 0 淡进来（不能一上来就满音量）');

  inst._on.play && inst._on.play();            // 模拟真机确认"在播了"
  const volAfterFirst = inst.volume;
  frames(au, 30);                              // 再跑 0.5 秒
  assert(inst.volume > volAfterFirst, '音量要一路爬升');
  const playsBefore = inst.plays;
  frames(au, 600);                             // 跑 10 秒
  assert.equal(inst.plays, playsBefore, '幂等：同一首跑 600 帧不许重启播放（每帧重启=一直在第一拍）');
  assert(wx.instances.length === 1, '幂等：也不许反复建实例');
  assert.equal(inst.volume, cfg.audio.bgm.volume, '最终音量要停在 cfg 配的值');
  assert.equal(au.bgmTrack, 'stage');

  /* 换曲（boss）：必须先把旧的淡出，再换 src —— 中间那一刻 src 还不该变 */
  const cfgBoss = JSON.parse(JSON.stringify(cfg));
  cfgBoss.audio.bgm.tracks.boss = 'assets/audio/bgm/boss.mp3';
  const au2 = new WechatAudio(fakeWx(), 'assets/audio/', { bgm: cfgBoss.audio.bgm });
  const wx2 = au2.wx;
  au2.setBgmTrack('stage'); frames(au2, 120); wx2.instances[0]._on.play();
  const i2 = wx2.instances[0];
  au2.setBgmTrack('boss');
  au2.tickMusic(1 / 60);
  assert.equal(i2.src, cfgBoss.audio.bgm.tracks.stage, '切换过程中 src 还不该变（正在淡出）');
  assert(au2.bgmVol < cfgBoss.audio.bgm.volume, '切换时要先把音量降下来');
  frames(au2, 120);                            // 0.6s 淡出 + 切过去
  assert(au2.bgmTrack === 'boss', '淡出到底后要切到 boss，实际 ' + au2.bgmTrack);
  assert.equal(i2.src, cfgBoss.audio.bgm.tracks.boss, '同一个实例换 src 复用（不必频繁销毁）');
  assert.equal(i2.plays, 2, '换曲只该多 play 一次');

  /* 关掉音乐：音量降到 0 并真的 stop（不是留着后台解码 —— Android 同时只能 10 个音频） */
  au2.setBgmTrack(null);
  frames(au2, 240);
  assert.equal(au2.bgmVol, 0, '关掉后音量必须归 0');
  assert.equal(au2.bgmTrack, null, '关掉后状态要干净（下次开还要能起播）');
  assert(wx2.instances[0].stops >= 1, '必须真的 stop()');
  au2.setBgmTrack('stage'); frames(au2, 3);
  assert.equal(au2.bgmTrack, 'stage', '再打开要能立刻恢复');
}

/* ==================== ④ 中断 / 退后台：停住 + 回来自动接上 ==================== */
{
  const wx = fakeWx();
  const au = new WechatAudio(wx, 'assets/audio/', { bgm: cfg.audio.bgm });
  au.setBgmTrack('stage'); frames(au, 60); wx.instances[0]._on.play();
  assert.equal(wx.instances.length, 1);

  wx.handlers.onAudioInterruptionBegin();       // 来电 / 被别的 App 抢焦点
  assert.equal(wx.instances[0].pauses, 1, '中断开始要暂停（否则电话里还在放音乐）');
  const playsAtSuspend = wx.instances[0].plays;
  frames(au, 60);
  assert.equal(wx.instances[0].plays, playsAtSuspend, '挂起期间不许偷偷续播');

  wx.handlers.onAudioInterruptionEnd();         // 中断结束
  assert.equal(wx.instances[0].destroys, 1, '中断过的实例不可信 → 销毁重建（和音效池一个道理）');
  frames(au, 3);
  assert.equal(wx.instances.length, 2, '回来要重建实例');
  assert.equal(wx.instances[1].plays, 1, '回来要自动接上（玩家不该发现自己手动去开音乐）');
  assert.equal(wx.instances[1].src, cfg.audio.bgm.tracks.stage);

  wx.handlers.onHide();                          // 退后台
  assert.equal(wx.instances[1].pauses, 1, '退后台要暂停');
  wx.handlers.onShow();
  frames(au, 3);
  assert.equal(wx.instances.length, 3, '回前台也是重建（不重建 = 回来是哑的）');
}

/* ==================== ⑤ 起播失败：记账 + 定期重试（iOS 首次没手势会失败） ==================== */
{
  const wx = fakeWx();
  const au = new WechatAudio(wx, 'assets/audio/', { bgm: cfg.audio.bgm });
  au.setBgmTrack('stage'); au.tickMusic(1 / 60);
  const inst = wx.instances[0];
  inst._on.error(new Error('play fail'));
  assert.equal(au.bgmErr, 1, '失败要记账（控制台 stats().bgm.errors 看得到）');
  assert(au.bgmRetryAt > Date.now(), '失败后要退避 1.5 秒再试（不许每帧重试刷屏）');
  /* 不去真等 1.5 秒：把重试时间拨到过去，等价于"1.5 秒过去了" */
  au.bgmRetryAt = 0;
  const before = inst.plays;
  au.tickMusic(1 / 60);
  assert.equal(inst.plays, before + 1, '退避时间到了要再试一次');
  /* ⚠️ 重试必须有上限：某机型 onPlay 不回调时，无限重试 = 每 1.5 秒把音乐重置回第一拍，
     比没声音更难查（宁可不放，也别在耳朵里反复重启） */
  const total = { plays: inst.plays };
  for (let k = 0; k < 8; k++) {                 // 模拟"一直起不来"
    inst._on.error(new Error('play fail ' + k));
    au.bgmRetryAt = 0;
    au.tickMusic(1 / 60);
  }
  assert(inst.plays - total.plays <= 3, '重试最多 3 次，实际又试了 ' + (inst.plays - total.plays) + ' 次');
  assert.equal(au.stats().bgm.retryLeft, 0, '放弃后 retryLeft 归 0（stats 里一眼看得出）');
  /* 反过来：只要 onPlay 确认过，就不该有任何重试 */
  {
    const wx9 = fakeWx();
    const au9 = new WechatAudio(wx9, 'assets/audio/', { bgm: cfg.audio.bgm });
    au9.setBgmTrack('stage'); au9.tickMusic(1 / 60);
    wx9.instances[0]._on.play();
    au9.bgmRetryAt = 0;                          // 就算退避时间到了
    frames(au9, 120);
    assert.equal(wx9.instances[0].plays, 1, 'onPlay 确认过就不许再 play（否则就是每 1.5 秒重置一次）');
  }
  /* cfg 里没配的曲目名：不许因此静音（回落由核心层保证，这里兜底） */
  const au3 = new WechatAudio(fakeWx(), 'assets/audio/', { bgm: cfg.audio.bgm });
  au3.setBgmTrack('nope'); au3.tickMusic(1 / 60);
  assert.equal(au3.bgmTrack, null, '没配的曲目名 → 不放（而不是放个不存在的地址去报错）');
}

/* ==================== ⑥ 设置面板 / 暂停面板 / 存档往返 ==================== */
{
  const g = make();
  const rows = g.settingsRects().rows.map(r => r.id);
  assert(rows.indexOf('music') >= 0, '设置面板要有「音乐」行，实际：' + rows.join(','));
  assert(rows.indexOf('music') < rows.indexOf('sound'), '音乐排在最上面（它是"有没有背景声"的第一层）');
  const prows = g.pauseRects().rows.map(r => r.id);
  assert(prows.indexOf('music') >= 0, '暂停面板也要有「音乐」行，实际：' + prows.join(','));

  /* ⚠️ 加一行会把面板顶高 —— 面板不许超出"最小常见机型"（320x568 = iPhone SE）的视口：
     别处有断言证明"行存在"，但证明不了"没被挤出屏幕"。实测过：加了「音乐」这行之后
     暂停面板高 378px，在 375 高的矮视口里正好出屏 15px。 */
  {
    const small = make(); small.setViewport(320, 568);
    for (const [name, R] of [['设置面板', small.settingsRects()], ['暂停面板', small.pauseRects()]]) {
      assert(R.panel.y >= 0, name + ' 顶部出屏（y=' + R.panel.y + '）');
      assert(R.panel.y + R.panel.h <= 568, name + ' 底部出屏（底=' + (R.panel.y + R.panel.h) + ' > 568）');
      const last = R.rows[R.rows.length - 1];
      assert(last.y + last.h <= 568, name + ' 最后一行被切掉（底=' + (last.y + last.h) + '）');
    }
  }

  assert.equal(g.toggleSetting('music'), false, '点一下要能关');
  assert.equal(g.settings.music, false);
  assert.equal(g.toggleSetting('music'), true, '再点一下要能开');
  assert.equal(g.toggleSetting('nope'), null, '别的 id 返回 null（别把不认识的键写进设置）');

  /* 存档往返：关掉音乐（顺带关掉音效，用来验"其它设置照旧还原"）→ 下一局读档还是关的 */
  g.toggleSetting('music');                       // 关音乐
  g.toggleSetting('sound');                       // 关音效
  const meta = JSON.parse(JSON.stringify(deps.Save.snapshot(g, false)));
  assert.equal(meta.settings.music, false, 'snapshot 要带上 music');
  const g2 = make();
  g2.loadMeta = function () { return meta; };
  g2.reset();
  assert.equal(g2.settings.music, false, '读档要还原音乐开关');
  assert.equal(g2.bgmTrack(), null, '读档后也不该放音乐（两者必须一致）');

  /* ⚠️ 老存档（更新前存的，没有 music 字段）→ 必须保持默认开 */
  const old = JSON.parse(JSON.stringify(meta));
  delete old.settings.music;
  const g3 = make();
  g3.loadMeta = function () { return old; };
  g3.reset();
  assert.equal(g3.settings.music, true, '老存档没有 music 字段时要保持默认开（默认成关=全员更新后静音）');
  assert.equal(g3.settings.sound, false, '其它设置照旧还原');
}

/* ==================== ⑦ 接线（平台层最容易漏的一环） ==================== */
{
  const entry = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
  assert(/audio\.setBgmTrack\(game\.bgmTrack\(\)\)/.test(entry),
    '小游戏入口必须每帧把"该放哪一首"喂给适配器（漏了 = 音乐永远不响）');
  assert(/audio\.tickMusic\(dt\)/.test(entry), '小游戏入口必须每帧推 tickMusic（漏了 = 淡入淡出/换曲不会发生）');
  assert(/bgm:\s*NS\.Config\.audio\.bgm/.test(entry), 'BGM 配置要从核心层传进适配器（不许在适配器里写死）');

  /* 曲目路径只写一处：别处不许再出现 BGM 地址字面量 */
  const files = ['core/game.js', 'core/save.js', 'render/renderer.js', 'platform/wechat/audio.js', 'game.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert(src.indexOf('assets/audio/bgm') < 0,
      f + ' 里出现了写死的 BGM 路径 —— 曲目只写在 cfg.audio.bgm.tracks 一处');
    assert(src.indexOf('stage.mp3') < 0, f + ' 里出现了写死的曲目文件名');
  }
  const csrc = fs.readFileSync(path.join(root, 'core/config.js'), 'utf8');
  assert.equal((csrc.match(/assets\/audio\/bgm/g) || []).length, 1, 'cfg 里 BGM 路径只该出现一次');
}

console.log('verify-bgm.js      PASS');
