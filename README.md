# pi-subagent

**中文** | [English](README.en.md)

[pi](https://github.com/earendil-works/pi) 的防卡死 subagent 扩展 —— `@tintinweb/pi-subagents` 核心(`Agent` / `get_subagent_result` / `steer_subagent`)的即插即用替代实现。整个项目围绕一条显式的 run 状态机重建,让卡住的子 agent 始终**可见、可诊断、有硬边界**——绝不无声挂死。

## 为什么

子 agent 的失败方式,"spawn + await" 式的简单封装根本看不见:模型 API 在 turn 中途停滞、工具调用永不返回、session 在 abort 时拒绝退出。pi-subagent 把每个 run 当作带分相 deadline 的状态机:看门狗负责触发,升级阶梯负责物理回收资源——同时把这一切实时流式呈现在编辑器上方的 **agent tree** 里。

## 功能

- **`Agent` 工具** —— 发起有边界的 subagent run:`description`、`prompt`、`subagent_type`,可选 `model` 覆盖(`provider/id`)、`run_in_background`、`resume`(续跑已结束的会话)、`isolation: "worktree"`(每个 run 一个 git worktree)、`timeout_ms`、`schema`(结构化输出,经 schema 校验)。
- **`get_subagent_result`** —— 默认非阻塞轮询;`wait: true` + `wait_ms` 为有界阻塞。
- **`steer_subagent`** —— 向运行中的子 agent 发送追加指令。
- **`SubagentWorkflow`** —— 沙箱化 JS 编排(`agent()` / `parallel()` / `pipeline()` / `phase()`),带独立 wall-clock 预算和可回放 journal。默认关闭(`workflow.enabled`)。
- **Agent tree 组件** —— run 活跃期间常驻编辑器上方(见下文)。
- **`@mention` 引导** —— 在编辑器输入 `@<label> <消息>`,可引导运行中的子 agent,或复活已结束的。
- **成本核算** —— 每个 run 的用量汇入 pi 的会话总计;`/agent costs` 查看明细。
- **Agent 类型** —— 从 `.pi/agents/`、`.agents/agents/`、`~/.pi/agent/agents/` 发现 `.md` 定义;注入系统提示词,让模型知道合法的 `subagent_type` 取值。

## Agent tree

```
● 4 active · $0.92
  后端实现 surface 截断 #6b7201c9 general-purpose cloudrouter-response/gpt-5.6-sol 🔧工具 3m32s $0.91
  TaskUpdate→edit✗→read→edit×3 ▸edit src/core/quota-bucket.ts
  ↳ 并行检索候选实现 #c3d4e5f6 explore 🔧工具 48s
    bash ▸grep monthlyQuota
  前端联调 #d4e5f607 · ♻重试2/3 1m15s
  修订方案:月额度纳入调度 #81ab2a94 Plan droid-completion/kimi-k3 🧠思考 6s $0.0021
  » 调度模块需要支持月额度,我倾向于在 quota-bucket 里加一个 monthly 窗口,然后
✓ 单元测试补齐 #0718293a test completed 40s $0.11
```

- 头部:bullet 取全场最严重的高亮色,活跃数、实时花费、`+N more` 溢出。
- 每个 run 一行主行:标签、`#id`、类型、`provider/id` 模型、人性化相位(`🧠思考` / `🔧工具` / `♻重试2/3` / `⏸排队` / `🗜压缩` / `⏹停止中`)、耗时、费用。嵌套 run 缩进在父级下方(`↳`);进行中的 workflow 渲染为 `⚙` 组头。
- run 处于工具调用或思考中时,追加一行**活动行**:近期工具轨迹(`bash×3→read`)+ 高亮的在途 `▸工具` 及参数预览,或模型流式文本的一行 `»` 尾部。工具调用 vs 模型请求的状态始终准确——包括并行工具调用。
- 高亮:`!` 黄 = 空闲超过 idle 预算一半(可疑地安静);`✗` 红 = 停止中或超过总 deadline。刚结束的 run 暗色驻留几秒。

## 命令

| 命令                    | 内容                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `/agent status`         | 所有非终态 run 的诊断:相位、最近事件、空闲时长、孤儿 session |
| `/agent status <runId>` | 单个 run 的完整工具时间线                                    |
| `/agent costs`          | 按花费降序的逐 run 明细                                      |

## 防卡死架构

每个 run 都是一条纯状态机(`src/core/state-machine.ts`),由会话事件驱动:

```
queue_wait → resolve_config → session_create → extension_bind
  → prompt_dispatch → model_turn ⇄ tool_exec (⇄ retry_backoff, compaction)
  → settled        (超时/停止:→ abort_grace → reap → settled)
```

1. **信号**:每个会话事件(文本增量、工具 start/end/update、retry、compaction)都会刷新 `lastEventAt`。空闲 = `now - lastEventAt`——正在流式输出的模型、有心跳的工具永远不算"卡住"。
2. **Deadline**:每个相位挂独立计时器(`dueAtFor`)——启动 30s、首事件 120s、模型 turn 空闲 240s、单工具 600s、压缩 300s、总计 30min(全部可配)。`EventWatchdog` 以 1Hz tick,派发 `deadline_fired`。
3. **升级**:运行中相位超时 → `cancel_signal` + `soft_steer`("wrap up now",给 agent 体面收尾的机会)→ 10s abort 宽限 → 强制 abort。若仍失败,`EscalatingReaper` 逐级爬升 L0 cancel → L1 steer → L2 requestAbort → L3 dispose(强杀进程句柄)→ 仍杀不掉的登记为 **orphan**,绝不遗忘。

重试有独立的 backoff 相位,不会误触 idle 计时器;并行工具调用会让 run 停留在 `tool_exec` 直到**最后一个**兄弟调用结束。

## 配置

用户配置:`~/.pi/agent/pi-subagent.json`(文件缺失/格式错误 → 用默认值,绝不抛错)。

```jsonc
{
  "concurrencyLimit": 6,
  "fleetWidget": true, // 编辑器上方的 agent tree
  "maxNestedDepth": 2, // 子 agent 再 spawn 子 agent 的深度上限
  "worktree": { "enabled": false },
  "workflow": { "enabled": false },
  "budget": {
    "idleMs": 240000, // 模型 turn 静默多久算超时
    "toolMs": 600000, // 单次工具调用上限
    "totalMs": 1800000, // 整个 run 的上限
    // … queueWaitMs, startupMs, bindMs, firstEventMs, compactionMs,
    //   abortGraceMs, steerMs, reapMs, startupRetries, retrySlackMs
  },
}
```

## 开发

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest:970+ 测试——状态机迁移矩阵、
                     # 带种子的属性不变量、组件渲染……
npm run typecheck
npm run format
```

版本化 pre-commit hook(对暂存文件跑 prettier):

```sh
git config core.hooksPath .githooks
```

目录结构:`core/` 纯状态机 + deadline(无 I/O)· `runtime/` 看门狗、会话驱动、回收器 · `service/` spawn/query/registry · `tools/` 四个面向 LLM 的工具 · `ui/` agent-tree 视图模型 + 组件(纯函数,可单测)· `workflow/` 沙箱编排器 · `adapters/` 面向 pi 的胶水层。

Node.js ≥ 22(用了 `fs.globSync`)。

## License

MIT
