# 接力 v2：自动续会话的设计草案

> 状态：草案，未实现。v1（beta.2）只做沉淀与检查点；本文件记录 v2 需要的 API 事实与落地路径。

## 目标

检查点落盘（`settled`）之后，让用户一次点击（或可选自动）就得到：

1. 一个**新会话**，上下文从零开始，但已经读入同一段记忆、绑定同一个智能体；
2. 新会话**继承**旧会话的权限（审批策略）与模型；
3. 旧会话被**停放**（archive），不再出现在活跃列表里，但记录完整保留、可随时恢复。

## 已确认的 API 事实（2026-10，DSH 预览版）

用 `cordis_inspect_query` 读到的事实，实现前请重新核对版本：

- **客户端服务** `ctx.uiWorkspace.startSession(workspaceId?, options?)`：创建新会话并切过去。`workspaceId` 省略时继承"当前或最近的"工作区，**不返回 session id**。
  - `options` 只有 `agentPreset`、`prompt`、`clearPreviousDraft`。
- `ctx.uiWorkspace.connectWorkspace(workspaceId, { agentPreset })` 会返回 `SessionId`，但它"复用第一个空会话"，语义不是"永远新建"。
- `ctx.uiWorkspace.archiveSession(sessionId, { stopActivity })`：归档会话；`stopActivity` 允许在运行中归档（会停止其工作）。
- `ctx.sessions.fork({ sessionId })` 是"分叉"，会复制整段对话——**不适合**交棒（等于没换上下文）。
- 主机侧事件 `agent/created`（serial）：新 Agent 进入注册表后触发，参数是 `{ agent, source, signal }`。适合做"新会话初始化"。
- 主机侧 `approval` 服务：`overrideOf(session)` 读当前会话的覆盖策略，`setPolicy(agent, policy)` 写入。
- `agentDefaultModel` 是**全局**默认模型；目前客户端服务目录里**没有**按会话选择模型的面。若真实 UI 存在会话级模型覆盖，需要另找入口。

## 推荐架构

### 1. 主机：armed handoff（武装状态）

检查点写入成功后，在 `handoff-state.json` 里给**源会话**记一段 `next` 意图：

```json
{
  "settledAt": "...",
  "checkpoint": "j-...",
  "next": { "agentId": "agent-...", "cwd": "E:\\...", "approval": "never", "at": "..." }
}
```

`next` 有过期时间（例如 30 分钟），避免很久以后新建会话被误绑。

### 2. 主机：`agent/created` 时继承

监听 `agent/created`：

- 找出与 `next.cwd`（或 source）匹配、且还没绑定智能体的新会话；
- 调用 `store.setBinding({ sessionId, agentId })`，绑定同一智能体；
- 用 `approval.overrideOf(旧 session)` 读旧策略，`approval.setPolicy(新 agent, policy)`；
- 消费掉 `next`（一次性）。

这样即使新会话是用户点"新会话"创建的，也能继承绑定。这一步不依赖客户端插件。

### 3. 客户端：「续会话」按钮

在「接力」页签里，`settled` 的会话行加主按钮「续会话」：

- `ctx.inject(['uiWorkspace'], ...)` 拿到服务；
- 点击后 `uiWorkspace.startSession(undefined, { agentPreset })` 新建并切换；
- 旧会话：等这一步的回合结束后 `archiveSession(旧 id)`；不要在回合中途归档当前会话。

是否**全自动**（settle 即换）需要单独开关 `autoSwitch`，默认关闭：模型正在写的回合里切走会话体验很糟。

### 4. 未决问题

- `startSession` 不返回 id，客户端无法立刻 `binding.set`。目前靠主机 `agent/created` 兜底；若同时开两个新会话会绑错，`next` 只消费一次 + cwd 匹配可以缓解。
- 会话级模型选择没有公开客户端服务；若只能继承全局默认，v2 文档要明确写"模型按全局默认"。
- 旧会话归档会让正在读它的人失去视图；自动模式需要先提示。
- 新会话第一条消息要不要自动带入记忆？建议不带：记忆已由系统提示注入，重复会浪费上下文。

## 验收

1. 手工点「续会话」：新会话出现、绑定同一智能体、审批策略与旧会话一致；
2. 旧会话归档后可恢复，检查点日志仍在；
3. `next` 过期后新建会话不会被误绑；
4. 两个并发新会话不会抢同一个 `next`（一次性 + cwd 校验）；
5. 全自动开关关闭时，结算后不改变当前会话。
