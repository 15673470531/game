# 《砍到天亮》自建统计上报

已替换 wx.reportEvent，改用 wx.request POST 到：
https://eat.guozeshui.top/api/game-analytics/events

`core/config.js` 中 analytics.reportingEnabled 已开启，build 为 2026-10-07-http1。

## 编译后验证

1. 微信管理后台 → 开发管理 → 开发设置 → 服务器域名，将 https://eat.guozeshui.top 添加为 request 合法域名。真机和正式版必须配置，不能依赖开发工具忽略域名校验。
2. 重新编译，点击开始游戏。开局会立即尝试上传；普通事件约 5 秒批量上传，死亡、通关、切后台也会尝试发送。连续请求之间至少间隔 2 秒。
3. 开发工具、开发版、体验版（以及无法识别的环境）上报 test_device=1；正式版普通设备上报 0。因此编译试玩的数据会进表，但默认管理报表排除测试数据。查询带 include_test=1 才能看见。
4. 如果之前手动设置了“排除本机”，本机仍不上传新事件。在首页 → 设置 → 快速点顶部“设置”标题 5 次 → 恢复统计，然后新开一局。
5. 控制台检查：

```js
__GAME__.analytics.status()
__GAME__.analytics.recent
__GAME__.analytics.flush()
```

status 的 acknowledged 是本进程收到的服务端确认数，pending 是待发条数，lastError 为最近请求错误。pending=0 且 acknowledged>0 表示有事件得到服务器确认。若合法域名未配置，可在 lastError 看见微信网络错误。近期记录的 queued 只表示入队，不表示已入库，以 status 或数据库为准。

## 数据与可靠性

- 每台设备生成并持久保存随机 player_id（UUID），不使用微信登录、openid、昵称、手机号。清缓存/换设备会产生新编号。
- 事件包含 run_id、seq、build、stage、wave、weapon、seconds、detail、test_device、previous_run_id、event_name、UTC occurred_at，与服务端协议一致。
- 开局、续玩、波次、死亡、通关、结算选择的原有触发与去重逻辑保留；暂停/后台不算死亡。
- 待发队列和玩家编号保存在独立的 kdtl-analytics-http-v1 存储键。每批最多 20 条；最多保留 200 条、7 天。超过限额或过期丢弃最旧记录，status.dropped 显示本进程丢弃数。
- 每次入队立即保存；网络失败指数退避（5 秒至 5 分钟），回前台、再次开局或进程重启后可继续尝试。一个请求未结束时不重复并发发送。
- 只按成功响应中 acknowledged 的 run_id+seq 删除当前发送批次的记录。服务端重复确认安全；不因 HTTP 200 无有效确认而删队列。
- 保存最近 200 局的序号上限，避免游戏存档稍旧时重用已上传的事件序号。极旧存档、清缓存、存储失败和强杀进程仍不保证零丢失。
- 422 时只丢弃服务端明确指出字段错误的事件，保留其余记录并退避重试；错误在 lastError 中显示。不会无限重传同一个坏事件堵住全队列。
- 存储失败不影响游戏；queuePersisted=false 时，本次内存记录可能随退出丢失。
- 手动标记测试设备仍为“不发送新增行为事件”；之前已排队的记录保持原标记继续发送，不能撤回已入库记录。开发/体验环境则发送带测试标记的数据，以便联调。调试试炼场不记录。
- 这些标记不会改变微信官方的活跃、时长和留存统计。

## 本次验证

- 生命周期测试：开局、续玩去重、死亡重开、三波通关、回首页、设备开关。
- 传输测试：服务端确认、部分/无关确认、离线与重启补发、序号持久化、单请求锁、退避、开发环境标记、422 坏记录隔离、队列上限及过期。
- 原有三波、暂停面板、熟练度回归测试通过。
- 使用实际客户端模块与 Node HTTPS 适配器访问线上接口，测试 build=http-client-smoke-20261007，run_id=muxwd2df-9k27ux1a32，HTTP 200、acknowledged=1、pending=0。该记录 test_device=1。此验证不替代微信真机的域名白名单与存储验收。

未上传或发布微信版本。
