# paseo-task-manager

在中心所在的 Mac mini 的 Paseo daemon 上安装这一个插件，即可将本机和已登记主机中选定的 Paseo 会话同步到 agent-pm 中心。插件在后台运行，关掉 app 后仍会采集。远端主机只需支持 Paseo 的一跳连接。项目看板、Web、MCP 和摘要整理仍由现有中心提供。

## 配置

需要 Paseo **0.17.0 或以上**、Node **26 或以上**、可达的 agent-pm 中心，以及每个来源自己的 ingest token。目录锁面向 macOS/Linux 本地文件系统。在安装插件前，把[配置样例](config.example.json)复制到运行 daemon 的账户下的 `~/.config/agent-pm-paseo-plugin/config.json`。也可在 **daemon 环境**中用 `AGENT_PM_PASEO_PLUGIN_CONFIG` 指定其他文件。配置和状态目录沿用拆分前的路径。

| 字段 | 如何填写 |
|---|---|
| `daemonUrl`、`daemonServerId` | Mac mini 自身 daemon 的实际 WebSocket 地址（含 `/ws`）和身份。用指定 endpoint 的 `paseo status` 核对。若只监听 Tailscale 地址，使用实际地址替换样例中的环回地址。 |
| `centerUrl` | 现有中心的 HTTP(S) 地址。 |
| `sources[].serverId` | 本机或已登记目标 daemon 的 serverId。用 Mac mini 的 `paseo host ls` 核对，不能填 registrationId。 |
| `sources[].sourceId`、`machine` | 原样使用中心为该来源登记的名称及机器标签，例如 `paseo-gx10-090e` 和 `gx10-090e`。 |
| `sources[].tokenFile` | **Mac mini 本地**的文件路径，内容为该来源的 ingest token。让 daemon 账户可读并设权限 0600。一个来源一份凭据。 |
| `stateRoot` | 可选，默认 `~/.local/state/agent-pm-paseo-plugin`。每个 sourceId 有单独的锁、身份、outbox、仓库缓存和导入记录。放在 daemon home 和插件安装目录之外。 |

路径接受绝对路径或 `~/`。每个 serverId 和 sourceId 只能绑定一次。设置页列出本机和已登记的 host，新 host 开始采集前还须补齐配置和 token。改动配置文件后重载插件。

## 构建和安装

在准备安装的机器上从仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
paseo plugin install "$PWD"
```

本地目录安装使用当前工作树。构建生成 `server/bundle.mjs` 和 `client/bundle.mjs`，根目录的 `index.server.ts` 和 `index.client.tsx` 分别加载它们。更新本地代码后先重新构建，再对该 daemon 执行 `paseo plugin reload paseo-task-manager`。使用多个 daemon 时在命令中显式指定 `--host`。插件是受信任的本地代码，需要在目标 daemon 开启插件支持。

在 GitHub 仓库可用后，Git 来源可用 `paseo plugin install github:yiju-zhao/paseo-task-manager` 安装，也可用 `--ref <提交或标签>` 选择版本。Git 安装与更新会按 `paseo-plugin.json` 的 argv 数组执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` 和 `npm run build`。需要 npm 在 daemon 的 PATH 上，且能取得锁文件指定的包。esbuild 是构建依赖，随生产安装集提供。用户的本地配置和 token 不随 Git 分发。[Paseo 插件参考](https://paseo.sh/docs/plugins/reference.md) · [发布规范](https://paseo.sh/docs/plugins/publishing.md)

## 设置与数据

打开 **设置 → 当前中心主机 → Plugins → agent-pm 任务看板采集**。初始没有选中任何主机。可以逐台勾选或全选，公开 SDK 的 `hosts.client(serverId)` 只走一跳。插件读取目录、会话状态和时间线；消息与工具输入输出遵循原采集器的 64 Ki / 16 Ki 字符单元上限，保留截断信息。采集范围内包括个人事务会话和工具输出，数据经配置的中心地址上报。插件不给 agent 发消息，不启动对话轮次。中心后续如何调用模型取决于中心配置。

“读取已关闭和已归档 session 的内容”默认关闭，关闭时仅采这类会话的元数据。开启后设置页显示完成数、总数和导入进度，进度跨插件重载保存。0.17.3 上读取可能把 closed 会话恢复到 idle。未归档 Codex 可启动常驻进程；已归档的 Claude/Codex 保留归档标记，实测读取归档历史后未留下常驻 provider 进程。每页与订阅前复查状态，复查与实际读取之间仍有并发关闭的窗口。

![隔离环境中的历史读取开关及已完成的导入进度](assets/history-import.png)

远端仓库描述从目标 host 读取。分支、工作树根及相对 origin 的领先/落后数来自公开接口。只有精确未提交文件数需要可选的 `@getpaseo/client/internal/daemon-client` 与 `internal/hosts`，经同一登记短时打开一跳通道读取 uncommitted diff，只保留文件数。公开描述轮询缓存为 120 秒。首次读取或 `isDirty`、`diffStat.additions/deletions` 变化才重新核对计数，已知干净直接记 0。聚合值相同的不同变更可能复用同一计数及其原检查时间。

SDK 缺少内部导出、握手或 RPC 失败、整份 diff 过大时，公开 SDK 上的会话采集和目录扫描继续工作。该目录从失败结束起退避 30 分钟，向要求精确计数的中心沿用上次成功快照和原时间，从未成功则留空。新读取的分支、origin 计数和 isDirty 可在插件 `history.progress.unknownFileCounts` 查看。

## 线上逐来源交接

1. 在 Mac mini 上准备配置、token、构建和中心备份，从本仓库安装，先保持来源未选中。保留中心、Web、herdr 服务及原采集器状态目录。
2. 先交接 `paseo-mac-mini`，通过对账后再交接 `paseo-gx10-090e`。记录每个流的 `epoch/seq/last_batch_id` 和最后批次 ACK。等该来源旧 outbox 排空，正常停止相应旧 `collect-paseo` 服务，确认不被守护程序拉起，并复查 outbox 仍为空。未确认批次优先交给原写者排空。
3. 在插件设置勾选该来源。插件使用原 sourceId 和新 instanceId，旧租约到期后取得下一 lease epoch，从中心 checkpoint 接读。检查来源心跳、完整快照、批次 ACK、未确认 outbox 和 gap。在相同 epoch 和固定 seq 下按 event_key/revision、seq 范围、content_hash 对账，重放应无新增重复证据。
4. 回退时让插件排空该来源 outbox，取消勾选，待写者退出、租约到期，再用原目录和 token 启动旧采集器，从当前中心位置继续。上述切换仅涉及插件和对应旧采集进程，无需改变 herdr-pm 检出、重启中心或倒拨游标。

## 代码来源、协议与测试

本仓库从 **agent-pm 的 `feat/paseo-collector-plugin@82bfb297eb4873183177d2654e021f2886058628`** 拆出。下表记录采集源码的对应关系，插件宿主代码源自该提交的 `plugin/`。

| agent-pm 中的来源 | 本仓库 |
|---|---|
| `src/collector/config.ts` | `server/paths.ts` 的 `expandHome` |
| `src/paseo-collector/{client,config,discovery,history-import,loop,normalize,outbox,sdk,state-store,timeline}.ts` | `server/collector/` 下的同名文件。保留插件使用的采集路径，去掉独立 CLI 的加载入口。 |
| `src/shared/{ingest-v2,protocol,workspace}.ts` | `server/protocol/`。`protocol.ts` 只需机器标签和 session 状态定义。 |

**入库协议以 agent-pm 中心为准**。`/ingest/v2/{lease,snapshot,checkpoint,batches}` 的请求、回执、幂等和租约契约发生变化时，应对照中心的 `src/shared/ingest-v2.ts`、`src/shared/protocol.ts`，同步这里的 schema、客户端和契约测试。

`npm test` 使用本仓库的 FakePaseo、HTTP 回执与原始投影 fixtures，可在没有 agent-pm 检出的机器运行。覆盖目录与时间线、归一化、锁、outbox 重发、进度、只读边界和远端文件数退避。可选环境变量 `PASEO_CONTRACT_URL` 指向有加载会话的测试 daemon 时，还会运行 SDK 实机契约用例。

原来的跨层测试直接核对中心 SQLite、摘要和证据格式，随仓库保存在 `tests/paseo-collector/*.compat.test.ts`。使用已安装开发依赖的中心源码运行：

```sh
AGENT_PM_CHECKOUT=/absolute/path/to/agent-pm npm run test:compat
```

兼容测试使用临时数据库和假模型。它们通过测试专用别名加载该检出的实现，插件构建和运行均不依赖这个检出。
