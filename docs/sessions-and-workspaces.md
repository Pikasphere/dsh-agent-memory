# 会话归属、工作区与「对话」页签（1.2）

1.2 把「对话」的组织方式从工作区优先改成智能体优先：聊天的归属是智能体，工作区只是它发生的位置。

## 隐藏已绑定的对话

绑定了智能体的会话不再出现在左侧工作区列表里。

- 实现方式是客户端展示层过滤：按会话行的 `data-row-key="session:<id>"` 注入 `display:none`，每 5 秒与 `/api/agent-memory/state` 的 `bindings` 同步一次。
- **不改任何会话数据**：不归档、不移动、不清当前选择；解除绑定后自动恢复显示。
- 搜索仍然能命中被隐藏的会话（DSH 的搜索走会话存储，不读这份过滤）。
- 设置页有开关「已绑定对话不在工作区显示」，关掉即恢复原生列表。
- 依赖 DSH 侧栏的行属性；如果 DSH 改了这个属性，隐藏会静默失效（不会误伤其它 UI）。

## 对话页签

智能体面板新增「对话」页签，通过 `agent.sessions` 主机操作读取：

- 绑定关系来自插件自己的 `bindings.json`；
- 标题、cwd、最近活动、运行状态来自 `sessionController.list()`；
- 工作区来自 `workspaceRegistry.list()`，按 cwd 规范化后匹配。

每行可以「打开」（`uiWorkspace.openSession`）或「解绑」。日志已不存在（会话删了但绑定还在）会标出来。

## 侧栏「智能体对话」区（1.2.0-beta.2）

DSH 的侧栏没有「再加一个工作区」的插槽（`sidebar.workspaces` 是 single，替换等于重写整个浏览器），所以这块是客户端 DOM 扩展：

- 找一个稳定锚点：`[class*="regionArea"]`（工作区浏览器所在的滚动区域），把 `<div id="am-sidebar-agents">` 插到它前面，视觉上就在「工作区」上方；
- 内容按智能体分组：智能体名 + 会话数，展开后是会话行（标题 + 工作区 + 运行小圆点），点击 `uiWorkspace.openSession` 打开；点标题走 `layout.selectPanel('agent-memory')`；
- 数据来自新的主机操作 `bound.list`（绑定表 + `sessionController.list` + `workspaceRegistry`），5 秒轮询；
- React 重渲染可能移掉节点：对侧栏 root 挂 `MutationObserver` 立即插回，5 秒轮询作为兜底；
- 只在 `state.capabilities.bound === true` 时出现，旧主机不会留下空壳；
- 可整体折叠、按智能体折叠（折叠状态在内存里，刷新重置）。

## 工作区选择

页签顶部是一个工作区下拉：

- **切换过去**：`uiWorkspace.openWorkspace(workspaceId)`，打开该工作区（必要时创建/复用它的会话）。
- **新建对话**：主机 `agent.newSession` 调 `sessionController.create({ workspaceId, cwd })` 新建会话并**立刻**写入绑定，然后客户端 `openSession(newId)`。

这里没有复用「武装意图」，因为 `sessionController.create` 会返回 session id，绑定可以一步到位。

## 继承工作区

「续会话」现在会带上源会话的工作区：

- `handoff.arm` 的响应增加 `workspaceId`（由源会话 cwd 匹配 workspace registry 得到）；
- 客户端 `uiWorkspace.startSession(workspaceId)`，新会话落在源会话所在的工作区。

之前用的是 `startSession(undefined)`，即「当前或最近的工作区」，当用户在别的标签页里点续会话时会落错地方。

## 已知限制

- 隐藏是 DOM 层过滤，不改变 DSH 的会话归属；侧栏中空的工区标题仍会显示。
- 当前正在看的会话如果已绑定，侧栏里也会一并隐藏（主区不受影响）。
- 主机新增的 `workspace.list` / `agent.sessions` / `agent.newSession` 需要完整重启 DSH。
