# 接力 v2：自动续会话的设计草案

> 状态：**1.3 已完成**：settle 时武装 `next` 意图，`agent/created` 自动继承绑定/审批/模型；面板「续会话」一步新建并继承源工作区；开启「检查点后自动开启新对话」后，客户端在回合结束、会话空闲时自动切到新会话（旧会话自动归档）。自动切换是客户端轮询实现（5 秒），需要页面在运行。

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

## 已实现（1.1.0）

- `handoff.armNext / takeNext / nextOf` + `DEFAULT_NEXT_TTL_MS = 30 分钟`；
- `writeCheckpoint` 在 settle 时顺手 arm（带 `cwd`、`approval`、`model`）；
- 主机监听 `agent/created`：只认 `startup`/`clear`，跳过 `origin === 'subagent'` 和已绑定的会话，按 cwd 匹配、一次性消费，然后 `setBinding` + `approval.setPolicy` + `sessionController.selectModel`（失败时 500ms 后重试一次）；
- 模型的来源：源会话最近的 `request/header`（`session.requestHeader().config`），没有就回退 `agentDefaultModel.currentSelection()`；
- 面板对 `settled` 行显示「续会话」主按钮：先调 `handoff.arm` 刷新意图，再 `uiWorkspace.startSession()`；`armed` 的会话显示「待续」标签；
- `handoff.status` 返回 `capabilities.arm`，旧主机（没重启）下按钮自动隐藏，不会露出必然报错的入口；
- 测试：`test-handoff.mjs` 覆盖一次性/cwd/过期/模型透传，`test-host.mjs` 覆盖 resume 不消费、subagent 不抢、startup 绑定 + 策略 + 模型继承 + 不复用。

## 自动切换（1.3 已实现）

- 接力页签开关 `autoSwitch`（handoff.json 里的布尔值，默认关）；
- 客户端每 5 秒拉一次 `handoff.status`，触发条件全部满足才切：
  1. `config.autoSwitch === true`；
  2. 检查点会话就是**当前选中**的会话；
  3. `stage === 'settled'` 且 `armed === true`（检查点写入时武装的意图还在 30 分钟有效期内）；
  4. 该会话当前没有运行中的回合（`bound.list` 的 `running` 为 false）；
  5. 同一个 session 只触发一次。
- 触发后 `uiWorkspace.startSession(row.workspaceId, { agentPreset: row.agentPreset })`；新会话的 `agent/created` 消费意图，继承绑定/审批/模型，并把旧会话记为归档。
- 模式（Agent preset）由客户端透传：`handoff.status` 每行从 `agentPreset` 投影读当前 preset（实时切换后的值，不是 header），`handoff.arm` 响应也带同一个字段，供手动「续会话」复用。
- 这是客户端行为：DSH 页面关掉就不会切换；也不在回合中途切，避免把正在生成的回答甩在旧会话里。

### 4. 未决问题

- `startSession` 不返回 id，客户端无法立刻 `binding.set`。目前靠主机 `agent/created` 兜底；若同时开两个新会话会绑错，`next` 只消费一次 + cwd 匹配可以缓解。
- 模型选择走 `sessionController.selectModel`，它会同时把该选择存成全局默认；这是 DSH 现有行为，不是本插件额外改动。
- 旧会话归档会让正在读它的人失去视图；自动模式需要先提示。
- 新会话第一条消息要不要自动带入记忆？建议不带：记忆已由系统提示注入，重复会浪费上下文。

## 验收

1. 手工点「续会话」：新会话出现、绑定同一智能体、审批策略与模型与旧会话一致；
2. 旧会话归档后可恢复，检查点日志仍在；
3. `next` 过期后新建会话不会被误绑；
4. 两个并发新会话不会抢同一个 `next`（一次性 + cwd 校验）；
5. 全自动开关关闭时，结算后不改变当前会话。
