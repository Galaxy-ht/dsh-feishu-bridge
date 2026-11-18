# dsh-feishu-card

把 **DeepSeek Harness（DSH）** 的每一轮对话变成飞书里**一张持续更新的互动卡片**：状态、正文、执行过程、本轮统计都在同一张卡上刷新，而不是刷出一串消息。审批与提问也直接落在卡片上，同时保留文字回复作为兜底。

本插件是独立的新包，不修改 DSH 本体，也不调用任何模型（卡片内容来自本地 session 事件）。

---

## 你会看到什么

| 阶段 | 卡片表现 |
| --- | --- |
| 开始执行 | header 蓝色 + 「运行中」，显示 `● 执行中 · 用时`，下面是折叠的「执行过程」 |
| 流式输出 | 正文边生成边刷新；工具调用实时追加到执行过程（`✔ pwsh · Get-Date`） |
| 等待你确认 | header 橙色 + 「待确认」，列出工具与原因，按钮为「允许一次 / 拒绝 / 取消」 |
| 需要你回答 | header 橙色 + 「待确认」，问题 + 选项按钮；多选/超长选项自动降级为编号文字 |
| 完成 | header 绿色 + 「已完成」，执行过程自动收起，页脚显示模型 / 用时 / token / 上下文占比 |
| 失败 / 中断 | header 红色（失败）或灰色（已中断），并给出原因与已生成的部分正文 |

每个 DSH 会话在飞书里只开一个话题：**第一张卡是主窗口里的话题入口**，之后的卡片都回复进这个话题，点开第一条就能看到全部历史。

---

## 安装

插件已经放在 DSH home 下：

```text
%USERPROFILE%\.dsh\plugins-src\dsh-feishu-card\
```

### 方式 A：profile patch（当前使用方式，改完即生效）

在活动 profile 的 `cordis.patch.yml`（Desktop 一般是 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）末尾追加：

```yaml
- insert:
    - id: feishu-card
      name: 'file:///C:/Users/<you>/.dsh/plugins-src/dsh-feishu-card/lib/entry.js'
```

patch 层会被热加载，保存后约 1~3 秒插件即挂载，无需重启 DSH。

> ESM 模块按 URL 缓存：**同一进程内再次修改 `lib/*.js` 之后**热加载不会重新执行代码，需要重启 DSH 才能加载新代码。调试期可以把 `lib/` 整体复制到一个新目录（如 `lib/build-2/`）再指向新入口，改完再切回 `lib/entry.js`。

### 方式 B：作为 bundle 安装（重启后生效）

`package.json` 已声明 `dsh.bundle.patch`，可以直接当普通 bundle 装：

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\package.json
{
  "dependencies": { "dsh-feishu-card": "link:C:/Users/<you>/.dsh/plugins-src/dsh-feishu-card" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-feishu-card" ] } }
}
```

然后在 profile 目录执行 `pnpm install` 并重启 DSH。方式 B 不要再保留方式 A 的 `insert`，否则会挂载两次、每轮发两张卡。

### 与旧的 `dsh-feishu-session-notify` 共存

两者都会把输出发到飞书，**同时启用会重复推送**。切换到本插件时在 patch 层禁用它：

```yaml
- id: feishu-session-notify
  disabled: true
```

---

## 飞书端前置条件

| 项目 | 说明 |
| --- | --- |
| 机器人身份 | `lark-cli auth status` 中 bot 为 `ready` |
| 事件订阅 | `im.message.receive_v1`（接收你的回复） |
| 回调订阅 | `card.action.trigger`（卡片按钮）。**未订阅时按钮不生效**，卡片会自动降级为「编号 + 文字回复」，功能不丢 |
| 权限 | `im:message`、`im:message:send_as_bot`、`im:message:update`（更新卡片）、`im:message:readonly` |

检查命令：

```powershell
lark-cli event consume card.action.trigger --as bot --max-events 1 --timeout 10s
```

如果输出 `requires callbacks not subscribed in console`，按其中给出的
`https://open.feishu.cn/page/launcher?...` 链接在开放平台补订阅即可，之后无需重启 DSH。

---

## 传输通道（决定刷新有多快）

插件有两条通道，**有凭据时自动走直连，没有时退回 lark-cli**：

| 通道 | 单次耗时 | 说明 |
| --- | --- | --- |
| `lark-cli`（兜底） | ~1.1s | 每次刷新都新起一个进程、重做一遍鉴权 |
| 直连 OpenAPI + CardKit | **~250ms** | 缓存 `tenant_access_token`（2h）、keep-alive 连接；正文按卡片的**元素**流式推送，客户端带打字机动画 |
| 直连 `im/v1/messages/patch`（降级） | ~150ms | CardKit 不可用时的整卡替换 |

开启直连只需一个文件（**不要提交进任何仓库**）：

```json
// %USERPROFILE%\.dsh\feishu-card.secret.json
{ "appId": "cli_xxx", "appSecret": "xxx" }
```

- 文件建议仅当前用户可读：`icacls %USERPROFILE%\.dsh\feishu-card.secret.json /inheritance:r /grant:r "%USERNAME%:(R,W)"`
- 插件只用来换 `tenant_access_token`，不写日志、不落库；token 失效自动重换一次。
- 该 Secret 泄露后可随时在飞书开放平台重置，改完文件重启 DSH 即可。

实测（本机）：

```text
tenant_access_token     276ms（缓存 2h）
创建卡片实体            225~492ms
发送实体消息            568~707ms
元素文本增量            204~302ms
关闭流式 + 整卡替换      328~347ms
```

流式期间元素更新频率约 3~4 次/秒，远低于单卡片 10 次/秒的限流。

## 会话映射（1 个 DSH 会话 = 1 个飞书会话）

默认开启 `sessionChats`：每个 DSH 会话第一次产出时，插件会**为它建一个独立的飞书私聊群**（只有你和机器人），该会话之后的每轮卡片都直接发在这个群里，**不使用话题/线程**。

- 群名：`DSH · <会话标题>`，会话标题变化时自动改名；
- 在该群里说任何话，都会继续这个 DSH 会话（不需要"回复"某条消息）；
- 原来的机器人和你的 P2P 私聊变成**控制台**：`/dsh sessions`、`/dsh new`、`/dsh workspaces`、`/dsh doctor`；
- `/dsh sessions` 会列出所有会话，并给出「打开会话」链接，点一下直接进入对应群；
- 建群失败时自动退回原来的共享私聊（不会丢消息）。

关掉它（回到"共享私聊 + 话题"模式）：

```json
// ~/.dsh/feishu-card.json
{ "sessionChats": false, "thread": true }
```

> 注意：一个 DSH 会话对应一个群，会话多了群也会多；这是 1:1 映射的代价。不再需要的会话可以在飞书里解散群，插件不会重建（除非该会话再次产出且群里没有它）。

## 配置

配置文件：`%USERPROFILE%\.dsh\feishu-card.json`（全部可选）

```json
{
  "thread": true,
  "feishuOnly": false,
  "cards": true,
  "card": {
    "widthMode": "default",
    "intervalMs": 350,
    "firstUpdateMs": 150,
    "maxInflight": 3,
    "maxCardBytes": 27000,
    "showTools": true,
    "showReasoning": false,
    "reasoningPreview": true,
    "footer": true,
    "title": "",
    "catchUp": true
  }
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `thread` | `true` | 首卡在主窗口、后续卡进话题；`false` 则每轮都是独立消息 |
| `feishuOnly` | `false` | `true` 时审批/提问只等飞书，不再弹桌面卡片 |
| `cards` | `true` | `false` 退回纯 Markdown 消息 |
| `widthMode` | `default` | `default`(≤600px) / `compact`(400px) / `fill`(撑满) |
| `intervalMs` | `350` | 两次 patch 之间的最小间隔（实际按单次调用耗时的 34% 动态放大） |
| `firstUpdateMs` | `150` | 从开始到首次建卡的延迟 |
| `maxInflight` | `3` | 同时在飞的 patch 数（1~4）。每次 `lark-cli` 调用约 1.1 秒，串行只能 ~1 次/秒；并发 3 路实测 9 秒内完成 23 次更新（约 2.5 次/秒），且完成顺序严格有序 |
| `maxCardBytes` | `27000` | 单卡字节预算（接口上限 30KB），超出部分自动截断并在卡后补发「（续）」消息 |
| `showTools` | `true` | 显示「执行过程」折叠面板 |
| `showReasoning` | `false` | 完成后仍保留思考过程 |
| `reasoningPreview` | `true` | 运行中把最近一行思考作为状态说明 |
| `footer` | `true` | 页脚显示模型 / 用时 / token / 上下文 |
| `title` | 空 | 会话还没有标题时的兜底标题（否则用首条提问的前 28 字） |
| `catchUp` | `true` | 启动时补发上次进程退出时没送出的最终回答 |

环境变量覆盖（优先级更高）：

```text
DSH_FEISHU_THREAD=0|1
DSH_FEISHU_ASK_ONLY=0|1
DSH_FEISHU_CARDS=0|1
DSH_FEISHU_CARD_INTERVAL=1200
```

---

## 飞书里的命令

| 命令 | 作用 |
| --- | --- |
| `/dsh workspaces` | 列出所有工作区（别名 → 绝对路径） |
| `/dsh new --workspace <别名> <任务>` | 在指定工作区新建会话，确认卡就是该会话的话题根 |
| `/dsh doctor` | 自检：机器人/用户身份、卡片交互是否可用、绑定数量 |
| `/dsh preview` | 发一张预览卡，用来确认客户端渲染 |
| `/dsh help` | 命令帮助 |

命令只接受**已授权用户**（`lark-cli auth status` 里的 user openId）发送。

---

## 回复与路由

- **回复任意一张卡**（或在话题里说话）→ 回到该卡所属的 DSH 会话。
- 会话正在运行时，消息用 `agent.steer()` 插话；空闲时用 `agent.followup()` 排队下一轮。
- 没有指定回复对象的普通消息，会路由到**该聊天里最近活跃**的会话，避免你还要去找「回复」。
- 只有本插件发过的消息才能把消息路由回会话，陌生群聊里的消息不会被误当成指令。

---

## 审批与提问

DSH 通过两个 Cordis waterfall 找人类：`approval/request` 与 `user-questions/request`。

- 插件会发一张待确认卡片，并把请求同时留给桌面端（除非 `feishuOnly`）；**谁先回答谁赢**，另一边的等待自动放弃。
- 卡片按钮（需 `card.action.trigger` 订阅）：允许 / 拒绝 / 取消 / 选项。
- 文字兜底：回复 `1`、`2`、`1,3`、你的答案，或 `取消`。
- 子代理的审批不会出现在飞书：只处理 root agent 自己的请求。

---

## 可靠性

- 每张卡的状态由**同一份 turn 状态**渲染，流式刷新与最终态走同一个函数，不会出现「先漂亮后错乱」。
- 同一张卡同一时刻只允许一个更新在飞；后到的刷新会等待，避免旧内容覆盖新内容。
- 单次更新失败重试 3 次；仍失败则退化为 Markdown 消息，绝不静默丢内容。
- 卡片超过字节预算时只截断正文，剩余部分在卡后补发「（续）」，不丢字。
- 回复进话题失败时退回新消息，话题被删也不会吞掉结果。
- 进程退出导致的 `turn/end` 缺失，会在下次启动时补发。

诊断文件：

```text
%USERPROFILE%\.dsh\feishu-card.log              # 决策与失败原因
%USERPROFILE%\.dsh\feishu-card-bindings.json    # 消息 ↔ 会话绑定（本地状态）
```

---

## 卸载

1. 从 profile 的 `cordis.patch.yml` 删掉 `feishu-card` 的 insert（或从 bundle 列表移除）；
2. 如需恢复旧插件，删掉 `feishu-session-notify` 的 `disabled: true`；
3. 重启 DSH 或保存 patch 让热加载生效；
4. 可选：删除 `plugins-src/dsh-feishu-card`、`feishu-card.log`、`feishu-card-bindings.json`。

## License

MIT
