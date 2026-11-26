# paseo-task-manager

插件在中心所在机器的 Paseo daemon 中运行采集、入库、摘要调度、网页和 MCP。远端机器通过本机 daemon 已登记的一跳连接读取。

## 配置和安装

插件从 daemon 的运行记录取得本机地址和 serverId。中心配置位于 `$XDG_CONFIG_HOME/paseo-task-manager/<serverId>/config.json`，未指定配置根目录时使用 `~/.config`。首次使用时自动生成权限为 600 的配置，端口为 7718，只监听本机；显式配置可用 listen 指定监听地址，省略 listen 时沿用全网卡监听。令牌在配置文件内。默认数据库位于状态目录下的 task-manager.db，独立的 database.json 记录它的身份。库不见时可在设置中重试或确认重建；身份不符时请移走异库或改用其他路径。网页设置的凭据保存在同级 `secrets/`。采集器的身份、锁与 outbox 按来源保存在该 daemon 的状态目录里。

使用 Paseo 0.17 以上和 Node 26 以上。从仓库根目录运行以下命令。服务端包从本检出的根依赖加载 Claude Agent SDK 及其可执行文件，运行期间须保留检出和依赖。

```sh
npm ci
npm run build:web
(cd plugin && npm ci && npm run build)
paseo plugin install "$PWD/plugin"
```

修改本地代码后重新构建并执行 `paseo plugin reload paseo-task-manager`。安装看门狗时将 plist 内的 `$HOME` 替换为运行账户的实际 home，并确认 launchd 的 PATH 能找到 node 与 paseo。

## 设置与数据

打开 **设置 → 当前中心主机 → Plugins → 任务看板中心**。初始没有选中任何主机。可以逐台勾选或全选，公开 SDK 的 `hosts.client(serverId)` 只走一跳。插件读取目录、会话状态和时间线；消息与工具输入输出遵循原采集器的 64 Ki / 16 Ki 字符单元上限，保留截断信息。采集范围内包括个人事务会话和工具输出，数据在插件进程内入库。插件不给 agent 发消息，不启动对话轮次。中心后续如何调用模型取决于中心配置。

“读取已关闭和已归档 session 的内容”默认关闭，关闭时仅采这类会话的元数据。开启后设置页显示完成数、总数和导入进度，进度跨插件重载保存。0.17.3 上读取可能把 closed 会话恢复到 idle。未归档 Codex 可启动常驻进程；已归档的 Claude/Codex 保留归档标记，实测读取归档历史后未留下常驻 provider 进程。每页与订阅前复查状态，复查与实际读取之间仍有并发关闭的窗口。

![隔离环境中的历史读取开关及已完成的导入进度](assets/history-import.png)

远端仓库描述从目标 host 读取。分支、工作树根及相对 origin 的领先/落后数来自公开接口。只有精确未提交文件数需要可选的 `@getpaseo/client/internal/daemon-client` 与 `internal/hosts`，经同一登记短时打开一跳通道读取 uncommitted diff，只保留文件数。公开描述轮询缓存为 120 秒。首次读取或 `isDirty`、`diffStat.additions/deletions` 变化才重新核对计数，已知干净直接记 0。聚合值相同的不同变更可能复用同一计数及其原检查时间。

SDK 缺少内部导出、握手或 RPC 失败、整份 diff 过大时，公开 SDK 上的会话采集和目录扫描继续工作。该目录从失败结束起退避 30 分钟，向要求精确计数的中心沿用上次成功快照和原时间，从未成功则留空。新读取的分支、origin 计数和 isDirty 可在插件 `history.progress.unknownFileCounts` 查看。

## 重载和恢复

手动重载前查看中心的 `/status`，确认 `understanding.running` 为空。Paseo 0.17.3 的插件重载和 daemon 重启会在约 4 秒后强行结束仍在进行的模型调用；收到 SIGTERM 的进程也可能更早退出。中心清理会等待在途调用，宿主决定进程的最长退出时间。被中断且尚未写入的摘要窗口在下次启动时仍可处理。

## 交接和协议

上线时按仓库计划 8 的切换步骤先停独立中心，交接各来源的租约和检查点。插件直接复用根目录 `src/shared/` 的协议以及 HTTP 入库使用的事务函数。插件只监控已登记并选中采集的 Paseo 主机。herdr 的历史仍可读取；herdr 采集器的上报入口仅在独立中心模式下可用。

采集器源自 agent-pm 的 `feat/paseo-collector-plugin@82bfb29`。根目录和 `plugin/` 各用自己的 `npm run typecheck`、`npm test` 做验证。
