# delivery v2 — 终态通知交付子系统状态机重设计（架构 · rev2）

> 输入约束 = `docs/dev/notification-complement/plan.md` 文末"下批预研"三条清单。
> rev2 修订：P0-1（折叠优先级必达违例）+ P1-2…P1-9 + P2-10/11 + 开放问题裁决。
> 全部行号按当前 HEAD 复核（HEAD 已含上批 A/B/C：consume 改序、cache 回滚、F1/F2/F3）。

## 0. 基线核实（行号 = 当前 HEAD）

| 事实                                                                                                                                                                                                  | 位置                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| settle 构造 payload，key=`runId:gen:status`，内容取 settle 时 diag                                                                                                                                    | `core/state-machine.ts:250,293,297,305-306`                                          |
| effect 解释器过滤 nested child（CC2）后 `notifier.enqueue`                                                                                                                                            | `service/runtime-adapter.ts:161,170-177,275,401`                                     |
| `applyStructuredOutputPolicy` 在 `runtime.run()` **返回后**执行，可 completed→failed(schema)                                                                                                          | `service/runtime-adapter.ts:394-397`；`core/json-schema.ts:128-153`                  |
| post-policy outcome 只进 spawn-service 内存 records，从不 `store.put`；故 sender 的 `store.get` 恒为 pre-policy 快照，而 live registry 优先 records（post-policy）→ 两视图不一致                      | `service/spawn-service.ts:103-138`；`stack.ts:145-148`；`service/run-registry.ts:40` |
| `enqueue` 同 key no-op，仅 dropped/abandoned 可复活                                                                                                                                                   | `delivery/notifier.ts:127-133`                                                       |
| `attempt` 同步 `send()` 返回即标 delivered；两处 `store.update` 独立 catch                                                                                                                            | `delivery/notifier.ts:89-125`（update 在 101 / 114）                                 |
| `reconcile` 输入源仅 `store.list()`，排除 consumed/abandoned/delivered                                                                                                                                | `delivery/notifier.ts:156,165-166`                                                   |
| `sendMessage` 无 ack；`triggerTurn:true` 是控制流信号；sender 现依赖 `store.get` 取 stats/label/failReason                                                                                            | `stack.ts:139-183`（145-157 读 store，170-181 发送）                                 |
| schema-flip fallback 现存两处                                                                                                                                                                         | `tools/result-tool.ts:51-63`；`stack.ts:222-233`                                     |
| F1 补投的 state 分治（前缀扫描 + fail-open）                                                                                                                                                          | `stack.ts:235-262`（prefix 252、list 255、guard 260、enqueue 261）                   |
| F2 后台 config-failure 入队                                                                                                                                                                           | `service/runtime-adapter.ts:227-262`（enqueue 248）                                  |
| `waits` 仅 resolver 集合（`finish()` 同步 resolve 后即 delete）；waitAll 超时裸 `setTimeout` 不注销                                                                                                   | `service/spawn-service.ts:77,137-138,410`                                            |
| outbox = append-only + cache 折叠；`update(key)` **按物理 key** 查 cache，miss 即静默 return                                                                                                          | `adapters/pi-outbox-store.ts:22-27,30-40,41-52`                                      |
| snapshot 落盘 best-effort（appendEntry 异常被吞）                                                                                                                                                     | `adapters/pi-run-log.ts:24-32`                                                       |
| 每次 `session_start` 重建 stack 并同步 `reconcile()`；dispose 前任的既有模式                                                                                                                          | `index.ts:186-197`；`stack.ts:85-87`                                                 |
| `newRunId` 唯一性**仅查进程内** records/running/tombstones（8 位 Crockford base32 = 40 bit ≈1.1e12）；跨 stack 重建时旧 stack 未 settle 的 runId 既不在新进程索引也不在 outbox（→ M17-residual §4.3） | `core/ids.ts:9-16,13-23`；`service/spawn-service.ts:317`                             |
| `RunStatus` 含非终态（queued/starting/running/stopping）；`DeliveryPayload.status` 只取终态四值                                                                                                       | `core/types.ts:20-21,305,309`                                                        |
| `onDelivery` 的对外签名是 `state: string`（非 union）                                                                                                                                                 | `core/types.ts:457`                                                                  |
| 依赖方向纪律（"依赖应指向另一边"）                                                                                                                                                                    | `config/agent-types.ts:26`                                                           |

**核心病灶**：通知内容有两个独立真相源（settle 时 payload + send 时 `store.get`），两者都早于 policy；post-policy outcome 只活在进程内存，重启后无处可寻。

---

## 1. 决策 D1：status 无关稳定 key `runId:gen`（采纳）

- settle 时立即 `enqueue` 并落盘（`staged` 或 `pending`），**保住 reconcile 兜底**；
- policy 之后 `finalize(runId, gen, patch)` 对**同一逻辑 key** 做一次 `store.update`；
- `send` 只在 release 之后发生。

**否决的替代**

| 替代                                  | 否决理由                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| (a) 延迟 enqueue 到 policy 之后       | settle 后崩溃 → outbox 无记录 → 通知永久丢失                                          |
| (b) 两 key 迁移（drop 旧 + put 新）   | 非原子：旧 key 已 retire、新 key 未落盘时崩溃 = 丢失（plan.md P0-1）                  |
| (c) 保留 status key + 扩大 fallback   | 症状治疗；每个未来新 status 都要加分支，组合爆炸                                      |
| (d) state-machine 等 policy 再 settle | policy 需 host 侧 captured 值（只有 adapter 有），下压进 core = core→service 反向依赖 |

**key 归属**：构造函数上移 `src/core/delivery-key.ts`（core 无出边），由 `core/state-machine.ts` 与 `delivery/notifier.ts` 同时引用；notifier 重导出保旧 importer。

**hold 只对需要 policy 的 run 生效**：state machine 不知道 `request.schema`；`runtime-adapter` 维护 `policyPendingRunIds`（`run()` 入口按 `spec.request.schema !== undefined` 加入、`finally` 清理——与
`childRunIds` 同一模式，`runtime-adapter.ts:161,275,401`），解释器调用 `enqueue(payload,{hold: policyPendingRunIds.has(runId)})`。**非 schema run 一律 `hold:false`。**

### 1.1 P1-2 裁决：canonical record 携带 `storageKey`（不回写迁移）

问题（P1-2 实证）：`pi-outbox-store.update(key)` 按**物理** key 查 cache、miss 即静默 `return`（`adapters/pi-outbox-store.ts:42-43`）。只做读路径归一时 `update("r_x:1")` 对物理 key `r_x:1:completed` 是 no-op → 内存已改盘面未改 = 分叉。

**裁决：`PersistedDelivery` 增 `storageKey?: string`（缺省 = `key`）；notifier 的一切写回 （`store.put/update`）一律用 `storageKey`，逻辑 key 只用于索引/查找/去重。**

| 方案                                   | 取舍                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **storageKey（采纳）**                 | 零额外写、无第二 key 生命周期、无崩溃窗口；代价 = 一个字段 + notifier 5 处写回改用 `storageKey`                                                     |
| 回写迁移（put 新 key + retire 旧 key） | 与已否决的 (b) 同形：必须"先 put 新再 retire 旧"才只产生重复而非丢失，仍多一次 append/记录一段双活期；对**已 delivered** 的历史记录纯属无收益写放大 |

新建记录 `storageKey === key`，代码路径统一；旧记录的 `storageKey` 保留其三段物理 key，直至 自然过期（TTL/abandoned）。**不做**任何回写（不做清单 6）。

### 1.2 P0-1 裁决：折叠优先级 = 未投递恒优先（必达 > 去重）

原规则（`consumed > delivered > … > staged`）存在必达违例：旧版可能同时留下 `r_x:1:completed`(delivered) 与 `r_x:1:failed`(pending)，按"已触达优先"折叠会让 pending 被 delivered 隐藏 = **未投递通知被吞**。

**修正原则（硬规则）**：

1. 同一 (runId,gen) 的物理记录分两组：**未投递** = {pending, staged, batched, dropped}（dropped 仍是候选且可被 F1 复活，`notifier.ts:165`、`stack.ts:260-261`）；**已终结** = {delivered, consumed, abandoned}。
2. **只要未投递组非空，就取未投递组**——`delivered/consumed` 永不隐藏任何未投递记录。
3. 组内多条：取 `createdAt` 最大者（并列时取 `attempts` 最大者）。
4. 未投递组为空时才在已终结组内按同一"最新优先"规则取一条（仅用于 consume/ack 命中与统计）。
5. 未被选中的物理记录**不删除、不改写**，仅从逻辑视图隐去。

代价是**明确接受的重复**：delivered+pending 并存时会再发一条（内容为 pending 那条）。方向与 全局纪律一致——宁重复不隐藏。风险表 R7 因此**升级为"中"**（见 §10）。

### 1.3 P1-3 裁决：payload 优先 + store fallback（放弃"纯格式化"表述）

评审指出的矛盾成立：schema run 有 finalize 可填字段，**非 schema run 没有 finalize**，而 `stats/label/failReason` 今天来自 sender 的 `store.get`（`stack.ts:145-157`）。

state-machine 在 `finish()` 内**能**拿到：`d.text`（textPreview，已有）、`d.label` （`core/types.ts:259` 显示元数据）、`d.error?.message ?? d.timeoutReason`（failReason）。
**不能**拿到：`formatOutcomeSummary` 的 stats 行——该函数在 `tools/agent-tool.ts:82`，属展示层， core 引用它即 core→tools 反向依赖。

**裁决（方案 b，侵入更小且诚实）**：

- **payload 字段优先，`store.get` 作 fallback**。sender 取值序：`payload.X ?? store.get(...)`。
- settle/F1/F2 三条 enqueue 路径统一补 `label` + `failReason`（两者都只是 diag 里现成的值， 改动局限于 `state-machine.ts:290-307`、`stack.ts:235-251`、`runtime-adapter.ts:248-261`）。
- `stats` 行**不进 payload**：由 `stack.ts` 用 `formatOutcomeSummary(store.get(...))` 算好后传给 `delivery/format.ts` 的纯函数（`formatSingle(payload,{stats})`）——`delivery/**` 因此不依赖 `tools/**`。
- **明确放弃**"sender 退化为纯格式化"的表述：sender = "payload 优先的双源取值 + 纯函数格式化"。真正被消除的是**内容正确性对 store 的依赖**（status/failReason/structuredPreview 由 finalize 写入 payload）。
- **同时补一处漏写**：policy 之后应 `deps.store.put(correctedSnapshot)`，否则 `get_subagent_result` 重启后仍返回 completed（现存独立 bug，随 P1 一并修）。

### 1.4 release 触发点与失败处理（含 O2 裁决）

**O2 裁决：`policyHoldMs` 默认 0 = 不排任何保险定时器**；policy 是同步纯函数（`core/json-schema.ts:128-153`，无 I/O、不抛），finalize 必在同一同步链内到达 → 正常路径**零延迟**。`policyHoldMs>0` 仅作可选保险，且与 P3 的 `ackWindowMs` **分开命名、互不复用**。

| 触发                                | 行为                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalize()` 正常到达               | `store.update`（用 storageKey）→ 内存转 pending → 立即进入发送汇点                                                                                                  |
| `finalize()` 的 `store.update` 抛错 | 记 `degraded`，**仍然**转 pending 并发送（落盘失败 ≠ 不发，`notifier.ts:79-87` 既有 F3 语义）；盘面仍 staged → 重启可能重投 stale = 重复                            |
| `policyHoldMs>0` 且超时             | 自动 release，payload 打 `degradedReason:"pre-finalize"`，文案追加降级标注                                                                                          |
| 崩溃于 staged                       | 重启 `reconcile()` 按 §4.1 规则以盘面 stale payload 发送 + 降级标注                                                                                                 |
| adapter 从未调 finalize（代码回归） | `policyHoldMs=0` 下该通知**本进程内无界不发**（liveness 缺陷，非仅延迟），直到下次重启/显式 reconcile 才降级发出——故 finalize 位置由下面的不变量强制，不靠 timer 兜 |

**P1-3 liveness 不变量（强制）**：`finalize` 必须位于 adapter 处理 schema run 的**统一出口**，而非 policy 之后的某条正常返回路径。实现形态： `run()` 内 `let settled: RunOutcome | undefined`，policy
后赋值并返回；`finally`（`runtime-adapter.ts:399-402`，已有的 `perRun`/`childRunIds` 清理汇点）中 `if (policyPendingRunIds.delete(spec.runId)) notifier.finalize(runId, gen, settled ?
patchOf(settled) : { degradedReason: "policy-error" })`。 不变量：**staged 记录的 release 与 adapter `run()` 的出口一一对应——正常返回、抛出、提前 return（H2/CP2 config-failure）三条路径都必经
finally**， 故"忘记调 finalize"在结构上不可能，只可能"finalize 落盘失败"（M2，已覆盖）。R10 因此从"低"升为**"中"**并归入 P1 期 liveness 风险（§10）。

**"policy 前崩溃 → 重投 stale payload"可接受但必须标注**：翻转发生在崩溃之后，盘面 completed 是当时唯一已知事实，正确行为是"发出已知事实 + 声明未定稿"。降级文案：`… completed (pre-finalize snapshot; run get_subagent_result "<8位前缀>" to confirm)`。

**暂存与清理**：staged 的唯一权威是 outbox 记录 + notifier 的 `state` Map（`notifier.ts:62`，键为逻辑 key）；**不新增** per-run 暂存 Map。`policyHoldMs>0` 的定时器句柄放 `holds` Map，在 release/consume/ack/dispose 处 clear+delete。

**与 schema-flip fallback 的关系**：稳定 key 后调用方无需知道 final status → **删除两处 fallback**（`result-tool.ts:57-60`、`stack.ts:226-232`），P1 的净减代码。

`notifier` 的三处 `store.list()` 读取（`notifier.ts:142,156,195`）先 canonicalize 再按 §1.2 折叠；`consume/ack/finalize` 的入参 key 也过 canonicalize，旧 key 调用照样命中。

**P1-2 收窄：status 剥离只认终态四值。** `canonicalizeDeliveryKey` 仅当第三段 ∈ {`completed`,`failed`,`timed_out`,`aborted`} 时剥离（这正是 `DeliveryPayload.status = RunOutcome["status"]`
的值域，`core/types.ts:309`）。 第三段是 `queued/starting/running/stopping` 或任何其他串时**不归一**：该记录被判为非法/异物，`audit({key, state:"pending", error:"illegal legacy key"})`
记录一条后**排除于折叠与重投之外**（既不当逻辑记录、也不当未投递候选）。理由：`r_x:1:running` 这种键从未由本仓任何路径写出，把它折进 `r_x:1` 会用非终态内容污染真实终态记录；而"未投递恒优先"规则若接纳它，反而会让非法记录压过真实 delivered 记录。

---

## 2. 决策 D2：coalesce 窗口

**裁决：新增 `delivery/coalescer.ts`；用 sender 返回值表达 delivered-after-flush；默认 `coalesceWindowMs = 0`（完全关闭，零行为变化）。**

```ts
export type SendResult = "sent" | "buffered";
interface MessageSender {
  sendMessage(p: DeliveryPayload): SendResult | void;
} // void 兼容旧 sender = "sent"
```

- `attempt()`（`notifier.ts:89-125`）见 `"buffered"` → 标 **`batched`**（持久化，属未投递）， **不**递增 attempts、**不**排 backoff；等 coalescer 回调。
- flush 后 `notifier.settleBatch(keys, ok)`：`ok=true` → **统一发送汇点** `settleDelivered(keys)`； `ok=false` → 统一失败汇点 `settleFailed(keys, err)`（attempts++ → backoff →
  dropped，**与 immediate send 失败同一实现**；O5 裁决：flush 失败递增 attempts，不动 `reconcileRound`）。

**P1-5 不变量修正**：`delivered` 不是"只由 `settleBatch(true)` 写入"——失败类通知走 immediate send，不经 coalescer。正确表述：**所有成功发送都经唯一汇点 `settleDelivered(keys)`，其两个 来源为 ① immediate send 返回
`"sent"` ② batch flush 成功；该汇点是 `state="delivered"` 与 `store.update` 的唯一写入处，且必在 `pi.sendMessage` 已返回之后执行。**

**准入规则（SLA）**

| 类别                                   | 进窗口                                 |
| -------------------------------------- | -------------------------------------- |
| `status === "completed"` 且无降级标注  | 是（最坏延迟 = `coalesceWindowMs`）    |
| `failed / timed_out / aborted`         | **否，立即发**                         |
| 带 `degradedReason`（pre-finalize 等） | 否，立即发（内容已不确定，不叠加延迟） |
| `reconcileRound > 0`（重启补投）       | 否，立即发                             |

推荐 `windowMs` 300–800，settings 硬上限 5000；`coalesceMaxBatch`（默认 8）满即 flush。

**生命周期**：`coalescer.dispose()` 同步 flush；flush 抛错 → `settleBatch(keys,false)` → 记录回 pending → reconcile 兜底。接线复用 `stack.ts:85-87` 的 `previousX?.dispose()` 模式。

**digest 形状**：单条时**逐字节复用单条文案路径**；多条时 `content` = 汇总行 + 每条一行，`details = { kind:"digest", items: DeliveryPayload[] }` **保留每条完整 payload**，`triggerTurn:true` 只发一次，`onDelivery` 仍**逐条** fire（§6.1）。

**否决的替代**：① coalescer 放 notifier 外部（stack 层拦 enqueue）——绕过 outbox，窗口内崩溃即丢失；② notifier 内部自建窗口——展示层策略下压进状态机；③ 复用 backoff 定时器作窗口——会污染 attempts 与 dropped 判定。

**文案抽取**：`stack.ts:139-183` 的格式化移入 `delivery/format.ts` 纯函数（stats 由 stack 传入， §1.3），顺带解决 plan.md 项 B 抱怨的"sender 文案不可测"。

---

## 3. 决策 D3：caller-ack 与 waiter 抑制

**裁决**：ack 点 = 工具 `execute` 的 promise **正常解析前的最后一步**，是"outcome 已作为工具结果交给模型"的**最佳可得近似**（best available approximation），不构成 harness 已接收的证明（P1-9）。ack 永不撤回已发通知；一切不确定 fail-open。

| ack 调用点（execute 正常返回前最后一步）             | 位置                                                   |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Agent tool 前台成功返回                              | `tools/agent-tool.ts:314-338`                          |
| `get_subagent_result` get 分支返回                   | `tools/result-tool.ts:102-118`                         |
| `get_subagent_result` wait 分支返回                  | `tools/result-tool.ts:161-173`                         |
| （现有 `onOutcomeConsumed`，`spawn-service.ts:364`） | 降级为"resolver 已交付"：只标 consumed，**不授权抑制** |

**为什么只是近似**：`return` 之后仍可能 turn abort / 结果被丢弃 / 未注入上下文——无 `sendMessage` 回执（O3）即无法证明接收。故 ack 作用域**仅限抑制尚未发送的重复**，任何不确定（tool 抛错、ack 抛错、update 失败）都退化为"照常发送"。

`ack(runId, gen, by)` 分支语义：

| 记录状态                                 | 行为                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `staged` / `pending`（attempts=0，未发） | 转 `consumed`(reason `acked`) + clear hold timer → 不发（抑制生效） |
| `batched`（窗口内未 flush）              | `coalescer.cancel(key)` + 转 `consumed` → 不发（抑制生效）          |
| `delivered`                              | 只标 `consumed`（既有语义），已发不撤回                             |
| `pending`（attempts>0，backoff 中）      | 只标 `consumed` 并停止后续重试；已发过的不撤回                      |
| `dropped` / `abandoned` / 不存在         | 返回 false，无副作用                                                |

**竞态**：ack 是**事后事实**，不做"当前是否有 waiter"的推断（E1 `hasLiveWaiter` 已砍除），故 "spawn 返回前 waiter 未注册"与"waitAll 不注销 waiter"（`spawn-service.ts:410`）都不再影响正确性。

**抑制率（诚实说明）**：`finish()` 同步 resolve waiter（`spawn-service.ts:137`），而 `enqueue→attempt→send` 也是同一同步链（`notifier.ts:131-132`）——`coalesceWindowMs=0` 且 `ackWindowMs=0`
时抑制几乎不命中（fail-open 发通知，正确但无收益）。收益来自把 completed 类 延后：`coalesceWindowMs>0`（P2）或 P3 的**独立命名** `ackWindowMs>0`（默认 0，与 `policyHoldMs` 分离，不复用同一 timer 语义）。这是 P3 依赖 P2 的原因。

**否决的替代**：① `waits.has(runId)` 判活抑制——resolver 存在 ≠ 结果被接收（plan.md P0-4）；② settle 时**无条件**给所有 run hold claim 窗口——纯后台 run 无 caller 可 ack，延迟纯损（`ackWindowMs` 仅对有 caller 的 completed 生效且默认关）；③ 依赖 pi 提供 ack——不可得（O3）。

**可选增强 E2（默认关闭，P3 内）**：前台 spawn（`agent-tool.ts:266-297`）在 `SpawnRequest` 打 `foreground:true`，其 completed 通知 hold 至 ack-or-`ackWindowMs`。裁决：**先不做**，等 P2 的真实重复率数据。

---

## 4. 完整状态转移表

状态集：`staged`(新) / `pending` / `batched`(新) / `delivered` / `consumed` / `dropped` / `abandoned`；未投递 = {staged, pending, batched, dropped}（dropped 可被 reconcile/F1 复活）。

| #   | 起 → 止                     | 触发者 / 时机                                     | 持久化时机                                        | 崩溃于此转移的恢复行为                                  |
| --- | --------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| 1   | ∅ → staged                  | `enqueue(p,{hold:true})`，settle（schema run）    | `store.put` 先于发送                              | put 未落盘 → 内存 only（degraded）→ 重启无记录（M1/M8） |
| 2   | ∅ → pending                 | `enqueue(p)`，settle（非 schema run）/ F1 / F2    | `store.put`                                       | 同上                                                    |
| 3   | staged → pending            | `finalize()` / `policyHoldMs` 超时                | `store.update`(storageKey) 先于发送               | 盘面 staged → reconcile 按 §4.1 降级重投                |
| 4   | pending → delivered         | `settleDelivered`（来源①：send 返回 `"sent"`）    | send **之后** update（`notifier.ts:99-107` 位置） | 盘面 pending → 重启重投 = **重复**（degraded 可观测）   |
| 5   | pending → batched           | send 返回 `"buffered"`                            | `store.update` 立即                               | 盘面 batched（未投递）→ 重投；内存缓冲丢失无害          |
| 6   | batched → delivered         | `settleDelivered`（来源②：flush 成功）            | flush **之后** update                             | 同 #4：重复方向                                         |
| 7   | batched → pending/dropped   | `settleFailed`（flush 抛错 / dispose flush 失败） | `store.update`（attempts++）                      | 盘面未投递 → 重投（O5：不动 reconcileRound）            |
| 8   | pending → pending           | send 失败且 attempts < maxAttempts                | `store.update` + backoff 定时器                   | 重启重投（attempts 从盘面继承）                         |
| 9   | pending → dropped           | send 失败且 attempts ≥ maxAttempts                | `store.update`                                    | dropped 仍是 reconcile 候选，可被 F1 复活（§4.2）       |
| 10  | 未投递 → consumed           | `ack()`（抑制生效）                               | **先写盘后改内存**（上批纪律）                    | update 抛错 → 返回 false、内存不变 → 照发（fail-open）  |
| 11  | delivered → consumed        | `ack()` / `consume()`                             | 先写盘后改内存                                    | 同上，失败恒为"重投=重复"方向                           |
| 12  | 未投递 → abandoned          | `reconcile()` TTL / rounds 超限                   | `store.update`（`notifier.ts:169-183`）           | 终态，不再重投（既有语义）                              |
| 13  | 任意 → 同态（payload 更新） | `finalize()` 迟到（记录已 delivered/consumed）    | `store.update` 仅改 payload                       | 只更新 details 供审计，不重发                           |

**不变量**：① 一个 (runId,gen) 只有**一条逻辑记录**（多条物理记录按 §1.2 折叠，未投递恒优先）； ② `state="delivered"` 只在唯一汇点 `settleDelivered` 写入，且必在 `sendMessage` 已返回之后； ③ 任意崩溃点恢复后逻辑记录必属 {未投递,
delivered, consumed, abandoned}，**未投递必被 reconcile 覆盖**；④ 一切写回用 `storageKey`，一切查找用逻辑 key。

### 4.1 P1-4：reconcile 的新增状态处理规则（候选筛选条件不变，处理逻辑必须新增）

`notifier.ts:165-166` 的排除式筛选（排除 consumed/abandoned/delivered）无需改动即可涵盖 `staged/batched`；但 reconcile **必须**新增以下显式转换，否则 staged 会被当作正常 completed 发出：

| 输入状态  | reconcile 行为                                                                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staged`  | **必经唯一 helper `releaseStale(record, round)`**（§6，禁止任何路径绕过它直接 `attempt()`）：置 `degradedReason:"pre-finalize"`+`finalized:false` → 用 `storageKey` 写回 → 转 `pending` → 立即发（不进 coalesce）→ 文案带降级标注，**禁止**按正常 completed 文案发送 |
| `batched` | 视为未投递（上次进程的窗口已随内存消失）→ 转 `pending` → 正常重投（可再次进窗口）                                                                                                                                                                                    |
| `pending` | 既有行为不变（attempts/round 从盘面继承）                                                                                                                                                                                                                            |
| `dropped` | 既有行为不变（仍是候选，round+1）                                                                                                                                                                                                                                    |
| 折叠冲突  | 先按 §1.2 折叠为一条逻辑记录，**再**做上述判定；被隐去的物理记录不参与重投                                                                                                                                                                                           |

`releaseStale` 的职责边界（单一实现，P1-4）：① `degradedReason`/`finalized` 写回；② 一切持久化用 `storageKey`；③ `attempts` 原样继承、 `reconcileRound = (p.reconcileRound ?? 0) + 1`；④ **调用序**必在
§1.2 折叠之后（先得到唯一逻辑记录，再判 staged）；⑤ 强制 immediate 发送标记， 使 coalescer 的准入规则（§2"带 degradedReason 不进窗口"）必然命中。`reconcileRound` 只表"重启/显式 reconcile 轮次"（O5），flush 失败不递增它。

### 4.2 P1-6：F1（runner rejection 补投）在稳定 key 下的 state 分治

HEAD 规则（`stack.ts:252-261`）是前缀扫描 + `state !== dropped/abandoned` 则跳过。稳定 key 后 前缀扫描退化为**单 key 查找**（不做清单 8），规则平移如下：

| 既有逻辑记录状态                   | F1 行为                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无记录                             | `enqueue`（补投，唯一渠道）                                                                                                                               |
| `delivered` / `consumed`           | 跳过（已触达，重复无价值）                                                                                                                                |
| `pending` / `batched`              | 跳过（在途；重试/窗口会送达）                                                                                                                             |
| `staged`                           | **不跳过、不二次 enqueue**：改为 `finalize(runId, gen, failedPatch)` 合流——settle 已入队但 runner 又 reject，failed 内容更权威，走同一 key 原地更新后发送 |
| `dropped` / `abandoned`            | `enqueue` 复活（重置 `state="pending"`, `attempts=0`，`notifier.ts:129` 既有复活语义）                                                                    |
| `list()` 抛错 / 状态缺失（旧记录） | **fail-open**：不确定时照常 `enqueue`（宁重复不丢失，`stack.ts:256-258` 既有裁决保留）                                                                    |

### 4.3 P0 终裁：runId 唯一性检查为主防线，M17-residual 量化接受

**缺陷成立**：`newRunId` 只查进程内 `records/running/tombstones`（`core/ids.ts:13-23`、`spawn-service.ts:317`），新进程可复用仍留在 outbox 里的旧 runId（两者 `generation` 均为 1）。
此时新 run 的 runner rejection 走 F1，§4.2 见旧记录 `delivered/consumed` 即**跳过**且不留 pending → 新 run 的 failed 被遮蔽、reconcile 无从补 = **真丢失**（不落回 M16）。

**主防线（采纳，不变）**：把持久化 outbox 的 runId 集合并入 `newRunId` 的排除集，封死"outbox 全程可读"这一**常态路径**（占绝对主导）下的碰撞。

- stack 构建时一次性快照 `taken = new Set(outbox.list().map(r => parseDeliveryKey(r.key).runId))`，作为 `SpawnServiceDeps.runIdTaken` **纯谓词**注入
  （`service/**` 不 import `delivery/**`；`taken` 由 stack 组装层读同一个 outbox 实例构造，notifier **不**承担 runId 分配语义——见 §6 单一来源约束）；
  `spawn-service.ts:317` 变为 `newRunId(id => records.has(id) || running.has(id) || tombstones.has(id) || deps.runIdTaken?.(id) === true)`。
- **每次 spawn O(1)**：集合只在 stack 构建时算一次——会话期内 outbox 的新增记录全部由本进程写出，其 runId 早已被进程内索引排除。
- 常态路径下排除集与 F1 读**同一 store 实例**（cache 由 `getEntries()` 一次 seed，`pi-outbox-store.ts:22-27`），F1 可见的记录必已在排除集内；`readBack=false` 时 store 全新为空，无旧记录可碰撞亦无可遮蔽。

**残余面 M17-residual（显式量化并接受）**——四审两条反例成立，主防线覆盖不到：

1. `outbox.list()` 在 **stack 构建时**与在 **F1 时**是两次调用，其间故障状态可能翻转（构建时抛错→排除集空；F1 时恢复→不再 fail-open 而按 delivered 跳过）：三审的"自洽性"不是时序保证，只是高概率巧合。
2. **跨 stack 重建**（P1-2）：旧 stack 中尚未 settle 的 run，其 runId 既不在新进程索引，也不在新 `taken` 快照（outbox 里还没有它的记录）——同属 epsilon 缺口。

量级：runId = 8 位 Crockford base32 = 40 bit ≈ **1.1e12** 空间（`core/ids.ts:9-16`）。**可证上界**取自单一因子 ① 撞上持久化记录 ≈ `N/2^40`（N = 24h TTL 内记录数，量级 10^1–10^3）→ **≤~9e-10/spawn**；触发还需**复合**满足 ② 新 run 恰走
runner-rejection F1 × ③ 旧记录恰为 `delivered/consumed` × ④ 恰逢 `list()` 时间差降级或跨 stack 重建未 settle——②③④ 无独立概率上界，**只作定性收窄、不参与数值主张**。接受依据：~1e-9 级可证上界 + 复合罕见触发条件，相对更强机制（持久化 reservation、跨 stack drain）的成本不成比例；与 M1/M8 的比较不作数值断言。
按一致性原则：既然接受 M1/M8，就同级接受 M17-residual，**不再追零**；**不使用**"构造上不可达/零概率"表述（那是三审的错误结论）。

**否决的替代**：runId 加宽 8→12 位（空间 32^12≈1.2e18，残余 ~1e-15）——把 epsilon 再压 6 个数量级，但破坏人工转录长度与既有 8 位短前缀约定（`resolve-target.ts:112-121`、`stack.ts:161` 的 `slice(0,8)`）；
残余已低于既有接受面，不划算。session 重建时 drain 旧 stack 未 settle 的 run（消除反例 2）列为 **P2+ 可选加固，非必达项**。

---

## 5. 失败矩阵

| ID  | 故障 × 阶段                                                  | 结果                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `store.put` 抛错（enqueue）                                  | 内存保留 + degraded + 照常发送（`notifier.ts:79-87`）。**此后立即崩溃 → 丢失**（G5a 既有降级面，O1 已裁决维持）                                                                                                                                                                                  |
| M2  | `store.update` 抛错（finalize）                              | 延迟 0、内容正确、盘面 stale → 重启可能重投 stale = 重复 + 降级标注                                                                                                                                                                                                                              |
| M3  | `store.update` 抛错（settleDelivered）                       | 重复（重启重投），degraded 可观测；既有行为不回归                                                                                                                                                                                                                                                |
| M4  | `store.update` 抛错（ack/consume）                           | 返回 false、内存不变 → 照发/仍可重投 = 重复方向（上批已锁定）                                                                                                                                                                                                                                    |
| M5  | `sendMessage` 抛错（immediate）                              | attempts++ → backoff → dropped；dropped 仍是 reconcile/F1 候选                                                                                                                                                                                                                                   |
| M6  | `sendMessage` 抛错（digest flush）                           | `settleFailed(keys)` → **每条**独立 attempts++/backoff，不整批丢弃                                                                                                                                                                                                                               |
| M7  | policy 抛错（理论；现为纯函数）                              | adapter `finally` 仍 release（无 patch）→ 发 pre-policy 内容 + 降级标注                                                                                                                                                                                                                          |
| M8  | 崩溃：settle 后、put 前                                      | 无记录 → 无通知（M1 的时序孪生，窗口为同步微秒级）                                                                                                                                                                                                                                               |
| M9  | 崩溃：put 后、finalize 前                                    | 盘面 staged → §4.1 降级重投（**内容降级，非丢失**）                                                                                                                                                                                                                                              |
| M10 | 崩溃：finalize 后、send 前                                   | 盘面 pending（内容已定稿）→ 正常重投，内容正确                                                                                                                                                                                                                                                   |
| M11 | 崩溃：batched 未 flush                                       | 盘面 batched → §4.1 转 pending 重投                                                                                                                                                                                                                                                              |
| M12 | 崩溃：sendMessage 已返回、update 前                          | 盘面 pending → 重投 = **重复**（无 ack 的理论下界，不可消除）                                                                                                                                                                                                                                    |
| M13 | 崩溃：delivered 后、ack 前                                   | 盘面 delivered → reconcile 不重投（`notifier.ts:165` 既有裁决），不重复                                                                                                                                                                                                                          |
| M14 | session 重建（非崩溃）                                       | `dispose()` 同步 flush；未成功者留未投递 → 新 stack 的 `reconcile()`（`index.ts:197`）重投                                                                                                                                                                                                       |
| M15 | ack 调用自身抛错                                             | 调用点 try/catch（`result-tool.ts:61-63`、`stack.ts:231-233` 模式）→ 不 ack → 照发                                                                                                                                                                                                               |
| M16 | **旧格式折叠：delivered + pending 并存**                     | §1.2 规则取 pending → **重投**（内容为 pending 那条，可能与已发的 delivered 不同）；结果 = 重复 + 可能内容不一致，**不隐藏**。若反其道取 delivered = 丢失，故此格是 P0-1 修正的直接依据                                                                                                          |
| M17 | **旧记录 runId 被新 run 碰撞复用 + 后续 F1**（M17-residual） | 主防线（§4.3：runId 唯一性纳入 outbox）封死常态路径。残余两条：`list()` 两次调用间故障状态翻转、跨 stack 重建未 settle 的 runId 不在快照内。命中即**丢失**（旧记录 delivered → F1 跳过 → 新 run 的 failed 无渠道），可证上界 ≤~9e-10/spawn（另需复合罕见条件，定性收窄），**已量化接受**（§4.3） |

**丢失集合最终结论 = {M1, M8, M17-residual}**——三者都是**已量化、已显式接受**的降级面，不再声称任何一条"不可达"。M1/M8 同源于"outbox `put` 未落盘 + 随即崩溃"（O1 维持 fail-open）；
M17-residual 是碰撞遮蔽在主防线外的 epsilon 残余（可证上界 ≤~9e-10/spawn，另需复合罕见触发条件，§4.3）。M16 不属丢失面（"重复 + 内容不一致"）；其余全部落在"重复"或"内容降级 + 显式标注"两类。

---

## 6. 接口契约（signature 级）

```ts
// src/core/delivery-key.ts（新，core 无出边）
export function deliveryKey(runId: RunId, generation: Generation): DeliveryKey; // `${runId}:${generation}`
export function canonicalizeDeliveryKey(key: string): DeliveryKey; // 三段旧 key → 剥去 status

// src/core/types.ts — DeliveryPayload 增量（全部可选，向后兼容；现有字段不变）
interface DeliveryPayload {
  finalized?: boolean; // finalize 已应用
  degradedReason?: "pre-finalize" | "policy-error"; // 持久化，跨重启驱动降级文案（§6.1）
  structuredPreview?: string; // policy 后 structuredResult 预览
  failReason?: string; // error.message ?? timeoutReason
  label?: string; // 来自 diag.label（core/types.ts:259）
}
// src/delivery/notifier.ts — PersistedDelivery 增 storageKey（物理 key，缺省 = key；一切写回用它，§1.1）
interface Notifier {
  enqueue(payload: DeliveryPayload, opts?: { hold?: boolean; holdMs?: number }): void;
  finalize(
    runId: RunId,
    generation: Generation,
    patch: Pick<DeliveryPayload, "status" | "textPreview" | "structuredPreview" | "failReason" | "label" | "diag">,
  ): "sent" | "updated" | "late" | "missing";
  ack(runId: RunId, generation: Generation, by?: ConsumerIdentity): boolean;
  settleBatch(keys: readonly DeliveryKey[], ok: boolean): void; // → settleDelivered / settleFailed
  dispose(): void;
  consume(key: DeliveryKey, by?: ConsumerIdentity): boolean; // 旧三段 key 亦可（canonicalize）
  /* reconcile / verifyPersisted / degraded 不变；stats 见 §6.1 */
}
// notifier 模块内私有唯一出口（P1-4）：staged 的降级释放只有这一条路径，reconcile 与任何未来调用方都不得绕过它直接 attempt()
function releaseStale(record: PersistedDelivery, round: number): void;
// P1-3 单一来源：Notifier **不**暴露 knownRunIds()，不承担 runId 分配语义；taken 集合由 stack 组装层直接读同一 outbox 构造后注入下面的纯谓词
// src/service/spawn-service.ts — deps 增量（纯谓词，service/ 不 import delivery/）
interface SpawnServiceDeps {
  runIdTaken?: (id: string) => boolean;
}
interface NotifierOptions {
  /* …既有… */ policyHoldMs?: number;
}

// src/delivery/coalescer.ts（新）— 不认识 pi
export interface Coalescer {
  submit(p: DeliveryPayload): SendResult;
  cancel(key: DeliveryKey): boolean;
  flush(): void;
  dispose(): void;
}
export function createCoalescer(deps: {
  clock: Clock;
  windowMs: number;
  maxBatch: number;
  send(items: readonly DeliveryPayload[]): void; // 抛错 = flush 失败
  onSettled(keys: readonly DeliveryKey[], ok: boolean): void; // → notifier.settleBatch
}): Coalescer;

// src/delivery/format.ts（新，纯函数；stats 由 stack 注入，§1.3）
export function formatSingle(p: DeliveryPayload, ctx?: { stats?: string }): string;
export function formatDigest(items: readonly DeliveryPayload[], ctx?: { stats?: Record<string, string> }): string;
```

**P1-8 前提约束（写入契约）**：`pi.appendEntry` **不得同步重入同一 outbox store**。 `adapters/pi-outbox-store.ts:30-52` 的 cache 回滚以"调用期间无其他写入"为前提；若未来 pi 在 appendEntry 内同步回调触发本 store 的
put/update，回滚会写回过期值。届时必须改为 版本号/token 校验（`update(key, patch, expectedVersion)`），而不是继续依赖"旧值"语义。 此前提同样是 `storageKey` 写回路径正确性的基础。

**settings 增量**：`policyHoldMs`（默认 **0**，钳制 [0,30_000]）、`coalesceWindowMs`（默认 **0**， 钳制 [0,5_000]）、`coalesceMaxBatch`（默认 8）、`ackWindowMs`（P3，默认 **0**，钳制 [0,5_000]）。

### 6.1 P2-11：新增状态的对外契约

| 面向                      | 裁决                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onDelivery` 是否观察新态 | **是**，`staged`/`batched` 转换照常 fire（H4 契约原文即"every state transition"，`notifier.ts:36-38`）。对外签名 `state: string`（`core/types.ts:457`）→ 扩展**不构成类型破坏**；digest 仍逐条 fire |
| `DeliveryState` union     | 扩展为 7 态。仅 `NotifierOptions.onDelivery` 与 `stats` 的内部类型受影响（本仓内）                                                                                                                  |
| `stats` 枚举              | `Record<DeliveryState, number>` 自动扩展为 7 键（`notifier.ts:198-202` 初始化需补两键）；`commands/status.ts:400-402` 的 Delivery 行补 `staged=`/`batched=`                                         |
| `degradedReason` 归属     | **放 payload（持久化）**，因为它必须跨重启驱动文案降级；**同时**镜像一条 `audit` 记录用于可观测。不做 audit-only（audit 不落盘，重启即失）                                                          |
| 外部消费者兼容            | 未知状态字符串对 `pi-hud` 之类消费者是 additive；`details` 结构不变（digest 时新增 `kind/items`）                                                                                                   |

---

## 7. 模块划分与依赖方向

```
core/      delivery-key.ts · types.ts · state-machine.ts · clock.ts · store.ts     （无出边）
  ↑
delivery/  notifier.ts（状态机）· coalescer.ts（窗口）· format.ts（纯文案）          （只依赖 core）
  ↑
service/   runtime-adapter.ts（hold 决策 + finalize + post-policy store.put）· spawn-service.ts（ack 出口）
  ↑
tools/     agent-tool.ts · result-tool.ts（ack 调用点）
  ↑
stack.ts   组装：pi.sendMessage ← format(+stats) ← coalescer ← notifier；唯一 store 读取处
```

**纪律**：① 新逻辑全部落 `delivery/`，**不进 `service/`**；② `delivery/**` 禁 import `service/**`、`adapters/**`、`tools/**`（stats 由 stack 注入，§1.3）；③ `core/state-machine.ts` 只引用
`core/delivery-key.ts`——这是 key 上移 core 的唯一动机；④ 文案格式化从 `stack.ts` 下移， `stack.ts` 回归组装 + store 读取（D7）。

---

## 8. 分期实施建议

**P1 — 稳定 key + staged/finalize + storageKey** 序：`core/delivery-key.ts` → `state-machine.ts:293` 换 key 并补 `label/failReason` → notifier
（staged/finalize/canonicalize/§1.2 折叠/storageKey 写回）→ runtime-adapter （`policyPendingRunIds` + finalize + `store.put(corrected)`）→ F1 规则改单 key 分治（§4.2）→ 删两处 fallback
→ status 计数。 验收：① schema-flip run 通知文案为 `failed` 且含 `error.message`；② 非 schema run 文案与延迟 逐字节不变；③ 注入"finalize 前崩溃"→ 重启重投一条带 `pre-finalize` 标注的通知；④ **旧记录
`r:1:completed`(delivered) + `r:1:failed`(pending) 并存 → 重启后重投 failed 那条**（P0-1 回归）； ⑤ 旧 key 记录的 update 经 `storageKey` 落到物理 key（`list()` 可读回新状态，无分叉）； ⑥
`get_subagent_result` 重启后返回 failed(schema)；⑦ staged + F1 → 单条 finalize 合流； ⑧ **finalize 统一出口**：正常返回 / policy 抛错 / H2-CP2 提前 return 三条路径都产生 release（无 staged
残留，`policyHoldMs=0` 下亦然）； ⑨ **runId 唯一性**：预置旧 outbox 记录后 `newRunId` 永不返回其 runId；`list()` 抛错时降级为进程内检查 + `degraded`（不断言与 F1 自洽，残余按 §4.3 接受）； ⑩ **canonicalize
收窄**：`r_x:1:running` 不归一、记 audit、不参与折叠与重投；`r_x:1:timed_out` 正常归一； ⑪ **storageKey 双索引**：读旧记录时填 `storageKey`（三段物理 key）、canonical key 仅用于 `state` Map
查找、`update`/TTL-abandoned/`consume`/`finalize`/retry 五条写回全部落到 `storageKey`、被折叠隐去的物理记录不被他条记录的 `storageKey` 误写； ⑫ **releaseStale 唯一出口**：reconcile 处理 staged 必经 helper（计数断言），绕过 helper 直接 `attempt()` 的路径在测试中失败。

**P2 — coalescer + delivered-after-flush** 序：`SendResult` → notifier 的 `batched` + `settleDelivered/settleFailed` 双汇点 → `delivery/format.ts` →
`delivery/coalescer.ts` → `stack.ts` 接线 + dispose → settings。 验收：① `windowMs=0` 行为与 P1 一致；② `windowMs>0` 且 3 条 completed 并发 → 1 次
`sendMessage`、`details.items.length===3`、`onDelivery` 3 次；③ 窗口内单条文案逐字节相同； ④ 失败类/降级类/`reconcileRound>0` 不进窗口；⑤ flush 前 `dispose()` → 立即发；⑥ flush 抛错 → 3 条各自 attempts++
进 backoff，`reconcileRound` 不变（O5）；⑦ "batched 未 flush 即崩溃" → 重启后 3 条全部重投（丢失为空集）。

**P3 — caller-ack 抑制** 序：`notifier.ack` 五分支 → `coalescer.cancel` → `ackWindowMs` → result-tool / agent-tool / spawn-service 的 ack 调用点（`onOutcomeConsumed` →
`onOutcomeAcked`，语义升级）。 验收：① `ackWindowMs>0` 或 `windowMs>0` 下前台 `spawnAndWait` 成功返回 → 0 条通知、记录 `consumed(acked)`；② 两窗口均为 0 → 通知照发（fail-open）；③ ack 晚于 send → 不重发只标
consumed；④ ack 时 `store.update` 抛错 → 返回 false 且通知照发；⑤ 后台 run 无 ack → 必达。

依赖：**P1 是 P2/P3 的共同前提**（稳定 key 让两者都无需知道 final status）；**P3 的实际收益 依赖延后窗口**（§3）。

---

## 9. 明确的不做清单

1. **不**改 `sendMessage` 无 ack 的事实，也不自建"通知已读"确认。
2. **不**延迟 settle、**不**把 policy 下压进 `core/state-machine.ts`。
3. **不**做跨 generation 的合并/去重（gen 仍是 key 的一部分）。
4. **不**把 `policyHoldMs` 与 `ackWindowMs` 合并为一个 timer（O2 裁决：分开命名、默认均 0）。
5. **不**改 CC2"nested child 不发顶层通知"（`runtime-adapter.ts:176`）。
6. **不**回写/删除旧格式物理记录（只做读路径归一 + `storageKey` 写回，§1.1）。
7. **不**做 E2 前台 hold（P3 可选，默认关闭）。
8. **不**扩展 `OutboxStore` 接口（`core/store.ts:22-26` 保持三方法）；稳定 key 后 F1 的前缀扫描 （`stack.ts:252-255`）简化为单 key 查找，是 P1 的顺带净减。
9. **不**把 `stats` 行搬进 payload 或 `delivery/**`（§1.3，避免 delivery→tools 反向依赖）。

## 10. 残余风险

| ID  | 风险                                                                                    | 等级           | 缓解 / 裁决                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | outbox `put` 未落盘 + 立即崩溃 → 丢失（M1/M8）                                          | 中             | G5a 既有降级面；O1 已裁决维持 fail-open；`degraded` 可观测                                                                                                                     |
| R2  | pre-finalize stale 通知（M9）与最终 outcome 不一致                                      | 中             | 强制降级标注 + 指引句；仅"崩溃于 staged"窄窗触发                                                                                                                               |
| R3  | sendMessage 已返回但 update 前崩溃 → 重复（M12）                                        | 低             | 无 ack 的理论下界，方向为重复                                                                                                                                                  |
| R4  | coalesce 使 completed 延迟至多 `windowMs`                                               | 低             | 失败类免疫；默认 0；硬上限 5s                                                                                                                                                  |
| R5  | digest 改变外部消费者看到的消息形状                                                     | 低             | `details.items` 保留每条 payload；`onDelivery` 逐条 fire；默认关闭                                                                                                             |
| R6  | ack 近似误判（结果实际未进上下文，如 turn abort）                                       | 低             | ack 仅授权抑制未发者、不撤回已发；一切不确定 fail-open（§3）                                                                                                                   |
| R7  | **旧格式折叠：delivered+pending 并存 → 有意的重复/内容不一致（M16）**                   | **中**         | P0-1 硬规则"未投递恒优先"= 宁重复不隐藏；P1 验收④ 用回放用例锁定；旧记录随 TTL 自然消退                                                                                        |
| R8  | `storageKey` 漏用（某处写回仍用逻辑 key）→ 内存/盘面分叉                                | 中             | 收敛到 notifier 内部 5 处写回 + 单一 helper；P1 验收⑤ 直测 `list()` 回读                                                                                                       |
| R9  | 新增 2 态使 status/`onDelivery` 语义变宽                                                | 低             | 对外签名本就是 `string`（`core/types.ts:457`）；status 行显式展示                                                                                                              |
| R10 | **`policyHoldMs=0` 下 staged 无保险 timer：finalize 缺失 = 本进程无界不发（liveness）** | **中**         | §1.4 不变量把 finalize 钉在 adapter `run()` 的 `finally` 统一出口（三条退出路径必经）；P1 验收⑧ 直测三路径；`policyHoldMs>0` 仅作可选二级保险                                  |
| R11 | 非法旧 key（第三段非终态）污染折叠                                                      | 低             | canonicalize 只认终态四值，其余判非法 + audit + 排除于折叠/重投（§1.4）                                                                                                        |
| R12 | **M17-residual：runId 碰撞遮蔽（`list()` 时间差 / 跨 stack 重建未 settle）**            | **已接受残余** | 主防线 = runId 唯一性纳入 outbox（封死常态路径）+ 可证上界 ≤~9e-10/spawn（复合罕见条件定性收窄，不作与 M1/M8 的数值比较）；session 重建 drain 旧 stack 为 P2+ 可选加固，非必达 |

## 11. 开放问题（含裁决结果）

- **O1（关闭）**：维持 fail-open——`store.put` 失败仍照常发送。被接受的丢失面共三条：M1/M8（G5a，本条裁决）与 M17-residual（§4.3 量化接受，不与 M1/M8 作数值概率比较）；§4.3 主防线未落地前 M17 是常态风险而非 epsilon。
- **O2（关闭）**：`policyHoldMs` 默认 **0**，同步 policy 路径不引入任何延迟；ack 专用窗口以 独立命名的 `ackWindowMs` 留给 P3，与 policy 保险 timer 分离（不做清单 4）。
- **O3（保留）**：`sendMessage` 投递回执不可得，故 ack 只能是近似（§3）；若 pi 未来提供回执， M12/R3 可消除、ack 可上移到真正的接收确认。
- **O4（保留至 P2 观测）**：digest 的 `triggerTurn` 合并（N→1）是否让模型漏掉单条紧急性？
- **O5（关闭）**：flush 失败递增 `attempts` 并进 backoff（与 immediate send 失败同一实现）； `reconcileRound` 只表重启/显式 reconcile 轮次。
