# 序章、章节与微信云存档

已实现：新玩家进入荒原教学，依次学习移动、自动攻击、冲刺、击杀精英、拾取技能；护甲默认自动穿戴。死亡从当前步骤重试。序章通关后登录，才能进入第一章。首次进入第一章显示背景剧情；关卡沿用现有祭坛三波战斗。第二章“迷雾旧镇”、第三章“沉钟矿井”显示开发中。

老玩家检测到已有进度后进入登录导入流程，保留旧存档原件，不强制重新教学。教程演示不增加正式金币或熟练度；首次登录导入固定“守夜者旧甲”，同账号不重复领取。

## 部署顺序

先部署 eatWhat 后端，再发布小游戏。新增登录接口未部署或未配置前，客户端会停在登录页并允许重试。

服务器 `.env` 增加以下独立配置，值使用 **砍到天亮小游戏** 的 AppID / AppSecret。不要修改 eatWhat 原有的 `WECHAT_APPID` 和 `WECHAT_APPSECRET`，不要把 AppSecret 放进客户端或 Git。

```dotenv
GAME_WECHAT_APPID=小游戏AppID
GAME_WECHAT_APPSECRET=小游戏AppSecret
```

在服务器 eatWhat 项目目录执行（与仓库 compose.production.yml 对应）：

```sh
docker compose -f compose.production.yml exec app php artisan config:clear
docker compose -f compose.production.yml exec app php artisan migrate --force
docker compose -f compose.production.yml exec app php artisan config:cache
docker compose -f compose.production.yml exec app php artisan route:cache
```

如果线上使用不同 compose 文件，换成现有线上启动文件；非容器环境直接执行对应 `php artisan` 命令。不要运行 migrate:fresh/reset 或回滚已有业务表。

微信后台 request 合法域名仍是 `https://eat.guozeshui.top`，与已有统计上报共用域名。登录通过用户点击按钮后调用 wx.login，由后端换取小游戏用户标识；没有额外索取头像、昵称或手机号。

## 与旧业务的隔离

新增四张表，字段均含中文注释：

|表|用途|
|---|---|
|game_players|小游戏微信账号、序章初始化标记|
|game_player_sessions|30 天登录凭证，服务端仅保存哈希|
|game_player_saves|每人一份长期进度，带版本号|
|game_save_backups|最近 20 次被替换的云存档|

新增路由统一 `/api/game-account/`：POST login、GET me、POST onboarding、PUT save。鉴权使用独立中间件，不复用 eatWhat 的 users、Sanctum token 或登录配置。已有 routes/api.php 只追加一个独立路由文件引用。原统计接口保持不变。

## 保存规则

- 云端保存金币、各武器熟练度、装备、武器库、最好成绩、场次、第一章通关状态、剧情已读状态。
- 当前战斗的血量、位置、敌人、局内升级仍保存在本机；跨设备只恢复长期成长。同设备长期进度匹配时保留未结束战斗。
- 更新使用版本号；断网保留待上传快照，重试沿用请求编号。登录过期后的新进度也继续留在本机，重新登录后处理。
- 本地未上传或其他设备更新时，展示两份进度供选择，不自动覆盖。选择云端时保留本机快照备份；切换账号也备份未上传内容。
- 现有统计事件只记录正式关卡，教学不会混入正式 run 数据；本版未增加教学漏斗报表。
- 这是客户端计算进度、服务端校验格式和版本的存档方案，不是服务器权威战斗结算或完整反作弊。

## 验证

后端自动测试 36 项、321 个断言通过，涵盖原有测试以及独立登录、账号隔离、初始化仅一次、版本冲突、幂等重试和非法存档。

客户端已验证完整教学、死亡重试、中途续玩、未登录限制、章节剧情、老存档保护、上传失败与跨账号备份；原祭坛战斗、熟练度、暂停背包、统计测试通过。Canvas 页面已通过浏览器渲染检查。

真实微信 code 换登录、生产 MySQL 迁移及手机操作手感仍需部署后验证，本次没有操作线上数据库或发布客户端。

真机验收建议：
1. 使用开发测试环境的新存储进入，完成五步教学，登录成功看到章节页。
2. 开始第一章取得熟练度，退出重新进入，确认继续本机战斗及成长数据。
3. 查看 game_players 与 game_player_saves，确认存档更新不会重复创建玩家。
4. 断网打一段、恢复网络，确认上传；第二设备修改进度后确认出现选择页。
5. 验证 eatWhat 原登录和常用业务仍正常。

不要为了测试教程清空自己的真实存档；可使用开发者工具独立项目存储。原旧存档 key 和账号专属存档保留分开。


剧情插图位于 assets/story，随包加载，使用 imagegen 内置工具生成。故事文字居中分页，背景缓慢推进。旧教学步骤 2（装备）自动跳转至冲刺，已有存档保留。
