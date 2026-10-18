# dsh-agent-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的智能体记忆与知识库插件。

每个智能体有一段**可继承的短记忆**；所有智能体共用**一个详细的共享知识库**；每个对话可以单独绑定一个智能体，因此同一时间可以有多个对话分别处于不同角色。

---

## 它解决什么

DSH 的会话本身是无状态的。跨任务时，你需要自己把上下文重新灌进去；而做完一件事之后，踩过的坑、验证过的命令、为什么这么选，通常散落在对话里，下次用不上。

这个插件补两块：

- **记忆**：智能体在任务完成或交接时，把结果压缩成一段很短的话（默认上限 4000 字）。这段记忆不自动生效——**由用户决定**把它读进哪个对话。
- **知识库**：详细经验（路径、命令、坑、决策理由）。**由智能体自己决定**什么时候查、查什么、何时补充。

两者权限刻意分开：模型没有任何"读记忆"的工具，只能写；知识库的读则只对模型开放，用户侧只能浏览和编辑。

## 功能

| 能力 | 说明 |
|---|---|
| 智能体管理 | 新建 / 改名 / 删除，互不影响 |
| 短记忆 | 每个智能体一份，上限可配，面板里直接编辑，改动留审计日志 |
| 共享知识库 | 所有智能体读写同一库，每条记录贡献者，支持搜索 / 标签 |
| 按对话绑定 | 新建对话时在下拉里选智能体；各对话互不干扰 |
| 记忆注入 | 只注入该对话绑定（或默认）智能体的记忆 |
| 记忆不自动读 | 面板里没有任何"注入"入口，只有绑定；模型侧也没有读记忆的工具 |
| 知识库自主查 | `agent_knowledge_search` / `read` / `write` 由模型自行决定调用 |

## 安装

DSH 插件以 profile 包的形式安装。任选一种：

### 方式一：从目录安装

```bash
dsh plugin --profile <你的 profile> add /path/to/dsh-agent-memory
```

### 方式二：手工加到 patch 层

把仓库放到任意位置，然后确保 profile 的 `node_modules` 能解析到它（`pnpm add link:<路径>`），再在 profile 的 `cordis.patch.yml` 末追加：

```yaml
- insert:
    - id: agent-memory
      name: "dsh-agent-memory"
```

**装完必须完全退出并重开 DSH**，不要依赖热加载。

## 配置

配置写在插件条目上，全部可选：

```yaml
- insert:
    - id: agent-memory
      name: "dsh-agent-memory"
      config:
        memoryDir: "D:\\dsh\\agent-memory"   # 记忆与注册表根目录，默认 ~/.dsh/agent-memory
        knowledgeDir: "E:\\Agent-knowledge"  # 知识库目录，默认 <memoryDir>/knowledge
        memoryLimit: 4000                    # 记忆上限字数，500-20000
        entryLimit: 48000                    # 单条知识上限字数，2000-200000
```

知识库目录也可以直接在面板「设置」里改，立即生效（不迁移已有内容）。

## 数据布局

```
<memoryDir>/agents.json                 智能体注册表
<memoryDir>/settings.json               知识库目录、默认智能体
<memoryDir>/bindings.json               对话 → 智能体 绑定
<memoryDir>/memory/<agentId>.md         该智能体的记忆
<memoryDir>/memory/<agentId>.log.md     记忆写入审计（追加式）

<knowledgeDir>/<entryId>.md             共享知识库条目（front matter 带 agent 贡献者）
```

全部是普通 Markdown / JSON，可以直接用编辑器改，也可以纳入 git。

## 模型侧工具

| 工具 | 作用 |
|---|---|
| `agent_memory_save` | 写该智能体的短记忆（覆盖式） |
| `agent_knowledge_search` | 检索共享知识库；空查询列出最近条目 |
| `agent_knowledge_read` | 读一条完整内容 |
| `agent_knowledge_write` | 新增或按 `entry` 修订已有条目 |

工具通过调用会话的绑定解析智能体；显式传 `id` 时优先。

## 面板

侧栏出现「智能体」图标，打开后：

- 左侧：智能体列表（记忆字数、贡献条数、被几个对话使用）
- 右侧三个页签：记忆 / 共享知识库 / 设置
- 记忆页底部列出正在使用它的对话（显示**对话标题 + 短 id**），可一键解除绑定

新建对话时，新会话那一行右侧会出现「智能体」下拉。

## 已知限制

- **改动插件后必须完全重启 DSH。** 运行中热加载这类 Host 插件会让工具执行上下文失效（所有工具报 `cannot get requested service "sessionProjections" in inactive context`）。这是实测结论，与插件逻辑无关。
- 知识库是全库共享：不做按智能体的隔离，只有贡献者标记。
- 对话标题来源有两处：live 会话走 `sessionTitle` 服务，已关闭会话读投影缓存；两者都取不到时显示「未命名对话」。
- 面板的视觉细节依赖宿主主题变量 `--dsw-alias-*`，换主题不会破版，但不会跟随自定义设计系统。

## 开发

纯 JavaScript，无构建步骤。两个半片：

- `index.js` — Host：工具、提示词段落、`/api/agent-memory` 路由
- `client.js` — 浏览器：面板与新建对话选择器（手写 ModuleLoader bundle）
- `store.js` — 存储层，不依赖 Cordis，可单独测试

测试（无需安装依赖）：

```bash
node test-store.mjs      # 记忆与知识库文件层
node test-host.mjs       # 用 mock ctx 跑注册、工具与 HTTP 分发
node test-migrate.mjs    # 旧「按智能体分目录」布局合并到共享库
node test-binding.mjs    # 对话绑定与解析优先级
```

## 许可

MIT，见 [LICENSE](LICENSE)。
