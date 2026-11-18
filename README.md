# DSH Feishu Bridge

把 **DeepSeek Harness（DSH）** 的每一轮对话，变成飞书里**一张持续更新的互动卡片**——状态、正文、执行过程、统计都在同一张卡上刷新，而不是刷出一串消息。审批与提问也落在卡片里。

> 两个独立的 DSH 插件：`dsh-feishu-card`（桥）与 `dsh-feishu-panel`（控制面板）。它们不修改 DSH 本体，也不额外调用模型：卡片内容来自本地 session 事件。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **流式卡片** | 直连飞书 OpenAPI（~150–300ms/次）更新卡片，正文边生成边出现 |
| **打字机效果** | CardKit 卡片实体 + `streaming_mode`，文字按节奏逐字铺开 |
| **会话 1:1** | 每个 DSH 会话自动建一个独立飞书群，卡片发在群里，不用话题 |
| **卡内审批** | 审批块插进当前回合卡片，不产生第二张卡；完成后记录收进折叠面板 |
| **卡内提问** | 多题一卡、一次提交；单选/多选下拉/自由输入/自定义答案 |
| **失败通知** | 模型额度、网络等错误会 `@你` 并说明原因，不再静默卡住 |
| **控制面板** | DSH 设置里一页图形化配置：会话形态、流式节奏、展示内容、登录与授权检查 |

## 组成

```
packages/
  dsh-feishu-card/    桥：流式卡片、审批、提问、会话映射、失败通知（Host 插件）
  dsh-feishu-panel/   面板：DSH 设置 →「飞书」页（Host 路由 + Client 页面）
```

## 安装

前置：**DSH**（内置 Cordis 插件系统）、**lark-cli**（已 `auth login`）、一个**飞书自建应用**。

### 1. 安装两个插件

在 DSH 里打开 **Plugins → Add plugin**，分别选择本仓库的两个包目录：

```
packages/dsh-feishu-card
packages/dsh-feishu-panel
```

也可以用 CLI：

```powershell
dsh plugin add <本仓库绝对路径>/packages/dsh-feishu-card
dsh plugin add <本仓库绝对路径>/packages/dsh-feishu-panel
```

安装后**重启 DSH**。

### 2. 配置机器人凭据

两种方式任选：

- 在面板「登录与凭据」里填 App ID / App Secret，保存后重启；
- 或手写 `~/.dsh/feishu-card.secret.json`：

```json
{ "appId": "cli_xxxxxxxxxxxx", "appSecret": "xxxxxxxxxxxxxxxx" }
```

没有密钥文件时，插件退回 `lark-cli` 通道（可用但更慢，约 1.1s/次）。

### 3. 开通应用权限与事件

**应用权限（tenant）**：

```
im:message  im:message:group_msg  im:message:readonly  im:message:update
im:resource  im:chat  im:chat.members:read  cardkit:card:write
```

**事件订阅**：

```
im.message.receive_v1        收消息
card.action.trigger          卡片按钮/表单回调
application.bot.menu_v6      （可选）机器人菜单点击
```

`im:message.group_msg` 是关键：没有它，机器人只能收到私聊和群里 @ 它的消息，普通群消息收不到。

### 4. 配置

`~/.dsh/feishu-card.json`（不写则用默认值；面板会读写同一个文件）：

```json
{
  "sessionChats": true,
  "thread": false,
  "feishuOnly": true,
  "card": {
    "widthMode": "default",
    "intervalMs": 350,
    "maxInflight": 3,
    "showTools": true,
    "showReasoning": false,
    "reasoningPreview": true,
    "footer": true,
    "multiSelectStyle": "dropdown"
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sessionChats` | `true` | 每个会话一个独立飞书群 |
| `thread` | `false` | 话题模式（仅 `sessionChats=false` 时生效） |
| `feishuOnly` | `true` | 审批/提问只在飞书出现，抑制桌面弹窗 |
| `card.intervalMs` | `350` | 最小刷新间隔，250–400 最佳 |
| `card.maxInflight` | `3` | 并发更新数；CardKit 路径下单路串行 |
| `card.showTools` | `true` | 执行过程面板 |
| `card.showReasoning` | `false` | 完成后保留思考过程 |
| `card.reasoningPreview` | `true` | 运行中显示思考预览 |
| `card.footer` | `true` | 页脚统计（模型/用时/token） |
| `card.multiSelectStyle` | `dropdown` | 多选控件样式：`dropdown` / `checker` |

改完重启 DSH 生效。

## 飞书里的用法

- **会话群**：每个 DSH 会话一个群，直接说话就继续该会话，不需要「回复」；
- **控制台（机器人私聊）**：`/dsh sessions`、`/dsh workspaces`、`/dsh new`、`/dsh doctor`、`/dsh preview`、`/dsh approval-test`；
- **快捷指令**：面板可把上述命令注册成 `/dsh-*` 斜杠指令；机器人菜单可绑定 `dsh_sessions` 等 `event_key`。

## 架构

```
DSH 会话事件 ──▶ dsh-feishu-card（Host 插件）
                    │  卡片视图 & 状态机
                    ├─▶ 直连 OpenAPI：发消息 / 更新卡片
                    ├─▶ CardKit：实体卡 + 流式文本（打字机）
                    └─▶ 事件消费：im.message.receive_v1 / card.action.trigger
                                      ▲
DSH 设置 →「飞书」 ──▶ dsh-feishu-panel ──┘ 读写 feishu-card.json + 状态/登录/授权检查
```

## 已知限制

- CardKit 对同一张卡的 `sequence` 要求严格递增，插件内部串行化写入；外部脚本不要并发写同一张卡。
- 应用权限（tenant scope）只能由企业管理员在开放平台审批，面板只能探测并跳转，不能自授。
- 「信任本会话」等价于切换会话的权限预设到完全放行，属于提权操作。
- 飞书卡片里不能引用本地图片路径；图片需先上传拿 `image_key`。

## 开发

```powershell
# 语法自检（无需 DSH 运行）
npm run check
```

改 `packages/dsh-feishu-card/lib/*.js` 后需要重启 DSH 生效（插件走 ESM 缓存）；`dsh-feishu-panel` 可用 Plugins 里禁用/启用触发重载。

## License

MIT
