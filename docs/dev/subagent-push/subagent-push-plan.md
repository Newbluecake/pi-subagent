# subagent-push → message fabric 实施方案（agent 间消息织网）· v5.1

> v5.1 = 第五轮评审"**有条件通过**"的四个放行条件（§0.2c），小改，不动其他内容；变更处标注"**v5.1**"。
> v5 = 第四轮评审"再次打回"后的**增量修补**：缺口已收敛为 5 个局部点 + 1 个建议项（§0.2b），全部接受；
> v4 已闭环的部分（六态状态机、D17–D20、root ingress gate、死信维度/原子序）语义不动，只在受影响处补严。
> v4 = 第三轮评审后的定向修订（§0.2a 保留）。三轮沉淀的方向性决策（三层内核、树边路由、kind 分级、admission 前移、
> Route B 旁路、digest 移出 MVP）**全部维持**。
> v1→v4 决策记录保留（§0.1），v5 变更点逐条标注"**v5**"。所有源码行号按当前 HEAD 逐条复核（§0.3）。
> 与 `docs/dev/result-text-fix/` 完全独立。原有原则不变：fire-and-forget、限速必需、复用投递状态机语义、不中断主 agent 当前 turn。

## 0. 评审处置

### 0.1 决策留存表（v1→v2→v3→v4→v5）

| 决策                       | 历程                                                       | 现状                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一 envelope              | v1 立；v2 加 via/channel；v3 ref 顶层化                    | 维持（§4.1 形状不变）；**v4** 在 envelope 之外定义持久化壳 `FabricRecord`（§4.3），envelope 本身零改动                                                                                                                                        |
| 树边路由 + 核心直投        | v1 立；v2 双源；v3 自持边表+onSpawnEdge                    | 维持（§7.0）                                                                                                                                                                                                                                  |
| kind 分级授权              | v1 立；v2 O4 关闭                                          | 维持                                                                                                                                                                                                                                          |
| canMessage 默认 ["parent"] | v1 立；v2 effectiveCanMessage/configHash                   | 维持                                                                                                                                                                                                                                          |
| deliveryKey 四段 branded   | v2 立；v3 rejected 共用 seq                                | 维持；**v4** rejected 的正式类型化见 §4.3（`rejected` 字段，state 恒 `dropped`）                                                                                                                                                              |
| QoS 逐链路                 | v1 立；v2 分级配额；v3 finding 独立子配额                  | 维持；**v4** 新增 root ingress gate（目标侧 cap + 目标侧最小间隔，§8.2/§8.5）—— 这是唯一新增的配额维度                                                                                                                                        |
| 死信回投发送者             | v2 立；v3 ref.keys 幂等 + router 生成；v4 维度/原子序/终态 | 维持；**v5** 修补 §9.2 crash 恢复分支：ref 命中时**同段**把原记录转终态（v4 只 annotate，原记录永久 pending —— 阻断 1）；写入 I-F13                                                                                                           |
| Route B                    | v2 立；v3 线性化点前移                                     | 维持；**v4** settle × claimed 区分（§10）；reload 重复投递明示为 at-least-once 允许行为并进集成测试（§10/§13）                                                                                                                                |
| 接收侧双通道               | v2 立；v3 能力探测 + fallback                              | 维持；**v4** 补 renderer 探测的完整接线清单（§6.4）                                                                                                                                                                                           |
| D12 异步投递契约           | v2 立；v3 转移表；v4 六态 + P/V 两段                       | 维持；**v5** V 段 stale 判定改为 `claimToken`（实例 id + epoch，D22）；verdict 来源加 fabric 级 steer timeout → retryable（D21）（§4.5/§4.6）                                                                                                 |
| D13 DeliveryEngine 分层    | v2 立                                                      | 维持（Stage A1/A2 不变）；**v4** 定义内核 API（§4.6）：`claim` 内存态、`freeze`、`annotate`                                                                                                                                                   |
| D14 分级配额               | v2 立；v3 模型重定义                                       | 维持；**v4** 配额计数维度全部写死（§8.2 表 + §9.1）                                                                                                                                                                                           |
| D15 目标状态语义           | v2 立；v3 onSnapshot 观察                                  | 维持；**v4** 措辞修正：announcedStarts 是 one-shot 事件观察先例，借用的只是 hook 位置，不是 flush 先例（§8.0）                                                                                                                                |
| D16 digest 移出 MVP        | v3 立                                                      | 维持；**v4** 单 turn 有界性论证由"链路速率 × 并发上限"（已证伪，§0.3）改为 root ingress gate 数学上界（§8.5）                                                                                                                                 |
| —                          | —                                                          | **v4 新增 D17**：`claimed` 只存在于内存，不落盘；磁盘上的可投递态永远是 `pending`（§4.4）；**v5** claimed 记录携带内存态 `claimToken`（§4.3/§4.6）                                                                                            |
| —                          | —                                                          | **v4 新增 D18**：root ingress gate = `rootInboxCap`（admission 时拒绝）+ `rootMinIntervalMs`（投递时延迟），对 to=root 且 channel=context 的记录生效（§8.2）；**v5** `rootMinIntervalMs=0` 定义为"interval 关闭、只宣称瞬时 cap"（D23，§8.5） |
| —                          | —                                                          | **v4 新增 D19**：throttle/backoff 零持久化，全部由 `deliveredAt`/`updatedAt`/`attempts` 三个已持久化字段重建（§4.7）                                                                                                                          |
| —                          | —                                                          | **v4 新增 D20**：终态语义分类 —— `consumed` = 系统有意丢弃（无死信义务），`dropped`/`abandoned` = 投递失败（finding/directive 有死信义务）（§4.4）                                                                                            |
| —                          | —                                                          | **v5 新增 D21**：run 目标发送在 mailbox sender adapter 层包 fabric 级 timeout（数值复用 `settings.budget.steerMs`，不加新键）；超时 = retryable verdict（§5.1/§4.5）                                                                          |
| —                          | —                                                          | **v5 新增 D22**：`claimToken = mailboxInstanceId + ":" + attempts`，claim 时绑定，verdict 只被原 mailbox 实例消费；freeze 后的实例不触碰任何持久化（§4.6/§10.1）                                                                              |
| —                          | —                                                          | **v5 新增 D23**：`rootMinIntervalS=0` ⇒ 不启用速率项，I-F12 只宣称瞬时 cap；`>0` 时最小 1s（存储单位为整数秒）；"+1 松弛"限定为单次 channel 翻转 reload（§8.5）                                                                               |

### 0.2a v4 处置速查（保留）

| 缺口                        | 处置                                                                                                                                                                                        | 落点            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1 pump 缺 claim/in-flight   | 六态状态机加 `claimed`；`engine.claim` 同步、仅内存（D17）；dispose = freeze，不回滚（磁盘本来就是 pending）；verdict 用 `attempts` 作 epoch；settle/supersede/consume 只作用 `pending`     | §4.4/§4.5/§4.6  |
| 2 root context 有界性不成立 | 承认 v3 论证错误（nested slotless + 无 fan-out cap + concurrencyLimit=0 合法）；改为 fabric 自有 root ingress gate（D18），给出与发送者数量无关的数学上界                                   | §8.2/§8.5/§16-③ |
| 3 死信配额维度              | 写死：per **原发送者 run**（= 死信 `to`，跨 generation，= system 链路维度），与 seq 维度一致；aggregation 是打包规则不是计数维度                                                            | §9.1            |
| 4 死信幂等原子性            | `issueDeadLetter` 单同步段：set 先占位 → engine.put → 原记录终态转移；四条触发路径共享同一入口；stack 内靠"终态无出边"，跨 reload 靠 ref.keys 集合 + freeze                                 | §9.2/§16-②      |
| 5 onRunSettled × 在飞       | `consume` 只作用 `pending`；claimed progress 的 verdict 到达时若发送者已 settle → V2' 行转 `consumed`；claimed finding/directive 不受影响                                                   | §10             |
| 6 notBefore 持久化          | 不持久化（D19）；重建规则完整写出：link.notBefore、rootNotBefore、backoffUntil 三者的重建公式与 reload 后 "+1" 松弛量                                                                       | §4.7            |
| 7 rejected 正式类型         | `FabricRecord = MessageEnvelope & {state, attempts, updatedAt, deliveredAt?, rejected?, deadLetter?}`；rejected 恒 `dropped`；reload 计数规则；工具返回 `ok` 语义 = "是否产生 pending 记录" | §4.3/§6.1       |
| 8a onSnapshot 措辞          | 修正为 hook 位置先例                                                                                                                                                                        | §8.0            |
| 8b 死信自身终态             | 三种审计终态：`issued` / `suppressed_quota` / `suppressed_sender_gone`，落在**原记录**的 `deadLetter` 字段；死信记录自身失败 → `dropped`("dead_letter_undeliverable")，永不再死信           | §9.3            |
| 8c 多失败原因单死信         | 由 §4.4 终态无出边 + §9.2 set 占位双重保证；转移表 P/V 行按序互斥                                                                                                                           | §9.2            |
| 8d renderer 探测接线        | 五处编辑清单（pi-compat 三处、index.ts 一处、stack 签名一处）                                                                                                                               | §6.4            |
| 8e reload 重复投递          | 明示为 at-least-once 允许行为（唯一来源：claimed 不落盘）；集成测试 T17                                                                                                                     | §10/§13         |

### 0.2b 本轮（v5）处置速查

| 项                           | 处置                                                                                                                                                                                                                                                                           | 落点                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 阻断 1 死信恢复漏洞          | §9.2 步骤 1 重写：ref 命中 ⇒ **同一同步段**内 `transition(orig, pending/claimed → 终态)` + `deadLetter:{reason,status:"issued",key:existingKey}`；终态按本次命中原因选（P1→abandoned，其余→dropped）；`dlRefs` 从 Set 升级为 `Map<origKey, DeadLetterOutcome>`；写入 **I-F13** | §9.2/§2/§16-①②       |
| 阻断 2 run sender 无超时     | mailbox sender adapter `boundedSend = race(ports.inject, clock.setTimer(steerMs))`；超时 ⇒ `{retryable:true, reason:"steer_timeout"}`（V2/V3 路径，attempts+1）；数值复用 `DeadlineBudget.steerMs`（`core/types.ts:64`，默认 5 000 ms）；写入 **I-F14**；§8.0 P4 行前提改写    | §5.1/§4.5/§8.0/§16-① |
| 重要 3 旧栈 verdict 隔离     | `engine.claim(key, token)` 把 `claimToken`（`mailboxInstanceId:attempts`）写进内存态记录；V 段 stale 判定 = `frozen ∨ state≠claimed ∨ claimToken≠token`；verdict 回调闭包绑定原实例，freeze 后零写盘；写入 **I-F15**                                                           | §4.6/§4.5/§10.1      |
| 重要 4 `rootMinIntervalMs=0` | 二选一定案为 **0 = 关闭速率项**：`rootNotBefore ≡ 0`，I-F12 只宣称瞬时 cap C 与静默尾巴 ≤ C；`>0` 时存储为整数秒 ⇒ 最小 1 000 ms，公式 ⌈W/R⌉+1 有定义；"+1 松弛"限定为**单次** channel 翻转 reload，k 次翻转 ⇒ +k                                                              | §6.3/§8.5/§16-③      |
| 重要 5 终态所有权矩阵        | 新增 §10.1：admission / pump P 行 / 本实例 V 行 / onRunSettled / freeze / 旧实例 verdict / 新栈 reconcile 七方 × pending/claimed；三问明答（settled 后 V1 更新 lastDeliveredAt = 是；frozen 后写盘 = 否；新栈与旧 verdict 同记录归属 = 新栈）                                  | §10.1                |
| 建议 6 证明前提 + 测试锚点   | §16 开头加"证明前提 A1–A7"清单并与测试一一对应；新增 T18'（死信 put 后、orig 转移前 reload ⇒ orig 终态且死信恰一）、T21（`rootMinIntervalS=0` 边界）                                                                                                                           | §16/§13              |

### 0.2c v5.1 放行条件

| 条件                         | 处置                                                                                                                                                                                                                      | 落点                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1 repair 分支按 outcome 分支 | `dlRefs` 命中：`issued` ⇒ 恢复 `{status:"issued", key}`（唯一做 ref repair 的分支）；`suppressed_*` ⇒ 恢复原 suppressed status、**不写 key**；I-F13 措辞同步                                                              | §9.2/§2/§16-②/§13           |
| 2 I-F14 限定范围             | "每次 dispatch 恰一个 verdict"改为"**未 freeze** 的 mailbox 的 dispatch 在 steerMs 内恰一个**可消费** verdict；freeze 后的 dispatch 显式丢弃，不属 delivery liveness 范围"；A3 同步                                       | §2/§5.1/§16 A3              |
| 3 root 速率证明改基          | 不再依赖"claim 与 V1 同段"（`FabricPorts` 是 Promise 接口，V1 在 microtask 结算）；改为"单 root in-flight gate + V1 结算后才推进 rootNotBefore / 释放 inFlight"的归纳证明；同步修正 §0.3/§4.7/§5.1 中"root send 同步"措辞 | §8.5-2/§16-③/§0.3/§4.7/§5.1 |
| 4 R=0 + 翻转的保证范围       | R=0：**单 stack 生命周期内** `pending+claimed`(context) ≤ C；翻转 reload 只改变哪些记录计入 context cap（起始重计数可能 > C，admission 关闭直至降回）；**不宣称**跨多次 stack 重建的累计速率界                            | §6.3/§8.5/§2/§16-③          |

### 0.3 源码接缝核实表（v4 + v5 逐条复核，评审"文档 vs 源码"失分点专项）

| 断言                                                                                                              | 位置                                                                                       | 对 v4 的影响                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nested run 恒 slotless：nested Agent tool 强制 `forceSlotless`，pool 对 slotless 直接放行不计数                   | `tools/agent-tool.ts:189-190,255`；`runtime/slot-pool.ts:40-43`                            | 缺口 2：concurrencyLimit 不约束 nested run 数量                                                                                                                                                                                          |
| `concurrencyLimit: 0` 合法且语义为无限                                                                            | `runtime/slot-pool.ts:44,111`；`config/settings.ts:200-203`                                | 缺口 2：即使只算 top-level，"6 条/30s" 也不是配置无关的上界                                                                                                                                                                              |
| 单 parent 的 nested 子节点数无任何上限（`childrenOf` 无 cap，仅 `maxNestedDepth` 限深度）                         | `service/spawn-service.ts:94-96,363-368`；全仓无 maxChildren（workflow 的 500 是编排预算） | 缺口 2：并发 sender 数在协议层不可界定，上界必须由 fabric 自持                                                                                                                                                                           |
| `pi.sendMessage` 返回 `void`，无 ack                                                                              | pi `extensions/types.d.ts:970-974`                                                         | root 的 verdict 不携带信息（不抛即 ok）。**v5.1 更正**：`FabricPorts.sendRootContext` 是 Promise 接口（v3 §5.2），V1 在 microtask 结算，claim 与 V1 **不**在同一同步段；root in-flight ≤1 靠 `inFlight` gate（P4），不靠同步性（§8.5-2） |
| 现有 notifier 的 `send` 是同步调用，故 DeliveryState 无中间态也不双发                                             | `delivery/notifier.ts:8,179-193`                                                           | 缺口 1：fabric 对 run 目标的发送是异步的（下行），不能照抄 notifier 的无中间态模型                                                                                                                                                       |
| run 目标发送 = `runner.steerRun` **await** `handle.steer`；无 active session 时 throw                             | `runtime/runner.ts:254-258`；`runtime/session-driver.ts:184-186`                           | 缺口 1：异步 verdict 窗口真实存在；throw "no active session" 映射 permanent `target_gone`                                                                                                                                                |
| `registerEntryRenderer` 是 load-time `ExtensionAPI` 成员                                                          | pi `extensions/types.d.ts:969`                                                             | 缺口 8d：可在 `activate()` 结构探测（不同于 sessionManager 的 session-time 探测）                                                                                                                                                        |
| `PiCapabilities`/`MinimalPiHost`/`detectPiCapabilities` 均无 renderer 字段                                        | `adapters/pi-compat.ts:17-33,35-42,65-75`                                                  | 缺口 8d：三处都要加                                                                                                                                                                                                                      |
| `caps` 在 `activate()` 探测但**未传入** `buildSessionStack`                                                       | `index.ts:105`；`stack.ts:279-285`（签名五参，无 caps）                                    | 缺口 8d：stack 签名要加 caps（或 fabric 自行 `detectPiCapabilities(pi)`——选后者，零签名改动，§6.4）                                                                                                                                      |
| `onSnapshot` 在 spawn-service 每次快照都触发；stack.ts 里 announcedStarts 是 one-shot 事件发射                    | `service/spawn-service.ts:59,186-191`；`stack.ts:526-536`                                  | 缺口 8a：借用的是 hook 位置，不是 flush 语义                                                                                                                                                                                             |
| `LifecycleEvent` 只在 finish 发出；settled snapshot 携带 `parentRunId`                                            | `core/state-machine.ts:272,289,282`；`core/types.ts:352`                                   | tree 重放来源确认                                                                                                                                                                                                                        |
| shutdown 时序：widget.dispose → scheduler.stop → rpc.close → stop runs → waitAll → bash kill                      | `index.ts:226-252`                                                                         | fabric dispose 插入点不变（rpc.close 后、stop 前）                                                                                                                                                                                       |
| `createPiOutboxStore` 构造自扫 getEntries；`wrapWithRunLog` **不**在构造期扫描（只在 `verifyLanded()` 按需扫）    | `adapters/pi-outbox-store.ts:21-29`；`adapters/pi-run-log.ts:19-52`                        | §4.7 prefetch 参数覆盖构建期的全部两次扫描（两个 outbox store）                                                                                                                                                                          |
| `systemClock.setTimer` 已 unref                                                                                   | `core/clock.ts:12-20`                                                                      | mailbox 只用 `Clock` 接口，自动满足 `pi -p` 纪律                                                                                                                                                                                         |
| `pi-outbox-store.put/update` 失败时回滚 cache 后 rethrow                                                          | `adapters/pi-outbox-store.ts:30-52`                                                        | §9.2 "put 抛错 → set 回退"的前提成立：抛错 ⇒ 未持久化                                                                                                                                                                                    |
| **v5** `runner.steerRun` 直接 `await entry.handle.steer(text)`，无任何超时                                        | `runtime/runner.ts:254-258`                                                                | 阻断 2：Promise 悬挂 ⇒ 记录永久 `claimed`；超时只能在 fabric 层加                                                                                                                                                                        |
| **v5** `DeadlineBudget.steerMs` 已存在，默认 5 000 ms，`/agent settings` 可调                                     | `core/types.ts:64`；`core/deadline.ts:15`；`config/setting-specs.ts:92`                    | 阻断 2：fabric 超时数值直接复用，不加新键                                                                                                                                                                                                |
| **v5** reaper 已有"用 `Clock` 定时器给 `handle.steer` 加界"先例（`bounded()`），且用 `min(steerMs, abortGraceMs)` | `runtime/reaper.ts:120-125,182-200`                                                        | 阻断 2：sender adapter 的 `boundedSend` 照此模式；fabric 不在 abort 路径上，直接用 `steerMs`                                                                                                                                             |
| **v5** `QueryService.steer` 的返回类型声明了 `steer_timeout`，但实现从不产生它                                    | `service/query-service.ts:23,97-105`                                                       | fabric 不经 QueryService（直连 `Runner.steer`），此处只作事实记录，不动                                                                                                                                                                  |

## 1. 背景与现状核实

v2 §1 与 v3 §1 的核实项全部保留且仍成立；v4 新增核实项见 §0.3。

## 2. 术语与不变量

节点 = run / `"root"` / `"system"`。链路 = `(from, to, generation)`。I-F1..I-F8 同 v2；I-F9（admission 即承诺）同 v3。**v4 新增**：

- **I-F10 claim 单写者**：`pending → claimed` 是 record 离开可投递集的唯一途径，且 select→claim→dispatch 在**一个无 await 的同步段**内完成。推论：任意时刻一条 record 至多有一个在飞 send。
- **I-F11 义务函数**：finding/directive 记录的"死信义务"是持久化字段 `(state, kind, deadLetter)` 的纯函数：`state ∈ {dropped, abandoned} ∧ kind ∈ {finding, directive} ∧ deadLetter === undefined` ⇔ 义务未履行。任何 reload、任何测试、任何审计都可以只读磁盘判定。
- **I-F12 root ingress 有界**：to=root 且 channel=context 的记录，**在单个 stack 生命周期内（两次 freeze 之间）**任意时刻 `pending + claimed` 计数 ≤ `rootInboxCap`；**当 `rootMinIntervalMs = R > 0` 时**，任意长度 W 的时间窗内 delivered 计数 ≤ ⌈W / R⌉ + 1 + f（f = 该窗内发生 channel 推导翻转的 reload 次数，通常 0）；**R = 0 时不宣称速率项**（D23）。**v5.1**：channel 翻转的 reload 只改变哪些已持久化记录计入 context cap（§8.5-4'）；不宣称跨多次 stack 重建的累计速率界。上述数都与发送者数量、嵌套深度、concurrencyLimit 无关。

**v5 新增**：

- **I-F13 ref 查重与终态修复同段**：`issueDeadLetter` 中"发现 orig.key 已在 `dlRefs`"与"把该 orig 从 pending/claimed 转到终态并按**已恢复的 outcome** 写 `deadLetter`"发生在同一个无 await 的同步段内。**v5.1**：outcome 为 `issued` 时写 `{status:"issued", key}`（这是唯一的 ref repair 分支，key 来自真实死信记录）；outcome 为 `suppressed_*` 时写 `{status: 原 suppressed}`、**不写 key**（不存在死信记录）。推论：不存在"死信已持久化而 orig 仍 pending"的稳定状态（它只能是同步段内的瞬态或崩溃点，后者由 reload 后的同一函数一次修复）。
- **I-F14 verdict 有限到达（v5.1 限定范围）**：对**未 freeze** 的 mailbox 实例，每一次 dispatch 的 send 在 ≤ `fabricSteerTimeoutMs`（= `settings.budget.steerMs`）内**必定**产生恰一个**可消费** verdict（真实结果或 `steer_timeout` retryable），由 mailbox 自己的 `Clock` 定时器保证，不依赖 sender 实现的任何契约。**freeze 后**：raceTimers 已 clear，底层 Promise 若永不 resolve 则 `boundedSend` 随之悬挂 —— 这是**显式丢弃**（无人等待、V 段因 frozen 也不会写），不属于 delivery liveness 的范围；该记录的 liveness 由新栈（磁盘 pending）承接。推论：未 freeze 实例内 `claimed` 的驻留时间有上界。
- **I-F15 verdict 实例隔离**：verdict 只能被**发起该 claim 的 mailbox 实例**消费（`claimToken` 含实例 id），且已 freeze 的实例对任何持久化介质零写入。推论：跨 reload 的同一 record 的所有权是单调移交的（旧 → 新），不存在两实例同时对一条记录写盘的窗口。

## 3. 设计决策总览（v4 + v5）

D1–D16 见 §0.1；v4 新增 D17（claimed 仅内存）、D18（root ingress gate）、D19（throttle 零持久化）、D20（终态语义分类）；**v5 新增** D21（fabric 级 steer timeout）、D22（claimToken 实例绑定）、D23（`rootMinIntervalMs=0` 语义与松弛量范围）。

## 4. 协议设计

### 4.1 envelope（`src/core/message.ts`；同 v3，零改动）

```ts
export type NodeRef = RunId | "root" | "system";
export type MessageKind = "progress" | "finding" | "directive" | "result" | "dead_letter";
export type MessageChannel = "context" | "display"; // 推导值（§6.4），不落 envelope
export interface MessageEnvelope {
  key: MessageKey;
  from: NodeRef; // 普通消息恒为发送 run（host 钉死）；dead_letter 恒 "system"
  to: NodeRef;
  kind: MessageKind;
  seq: number; // 逐链路单调；admitted+rejected 都消耗 seq；system 链路=(system,to,0)
  generation: Generation; // 发送者 generation；system 恒 0
  payload: { text: string };
  ref?: { keys: MessageKey[]; omittedCount: number }; // 仅 dead_letter
  via?: { lca: NodeRef; hops: NodeRef[] }; // 仅 from 为 run；编码见 v3 §4.1
  ttlMs: number; // progress = fabric.progressTtlMs；finding/directive/dead_letter = settings.reconcileTtlMs（既有键）
  createdAt: Millis;
}
```

### 4.2 deliveryKey（同 v3，零改动）

### 4.3 持久化记录 `FabricRecord`（v4 新增：缺口 6/7 落点）

envelope 是协议形状，record 是 envelope 加投递壳。**envelope 字段永不被投递壳改写**（`payload`/`seq`/`key` 只写一次）。

```ts
export type FabricDeliveryState = "pending" | "claimed" | "delivered" | "consumed" | "dropped" | "abandoned";

export interface FabricRecord extends MessageEnvelope {
  state: FabricDeliveryState; // 磁盘上永不出现 "claimed"（D17）
  attempts: number; // 已完成（收到 verdict）的发送次数；claimToken 的 epoch 分量（§4.6）
  /** v5（D22）：仅 state==="claimed" 时存在、**仅内存**（engine.memoryOnlyFields，持久化时剥离）。形如 `${mailboxInstanceId}:${attempts}`。 */
  claimToken?: string;
  updatedAt: Millis; // 每次持久化写都刷新；backoffUntil 的重建基准（§4.7）
  deliveredAt?: Millis; // 仅 state==="delivered"；link.notBefore / rootNotBefore 的重建基准（§4.7）
  /** admission 拒绝。存在 ⇒ state 恒 "dropped"、attempts 恒 0、不计 kind 配额、永不进入 pump 候选。 */
  rejected?: { reason: "quota_exhausted" | "target_backpressure" };
  /** 死信义务的履行审计，只出现在 kind ∈ {finding, directive} 且 state ∈ {dropped, abandoned} 的记录上（I-F11）。 */
  deadLetter?: {
    reason: "ttl_expired" | "target_gone" | "attempts_exhausted";
    status: "issued" | "suppressed_quota" | "suppressed_sender_gone";
    key?: MessageKey; // status==="issued" 时指向死信记录（聚合死信多条原记录共享同一 key）
  };
  /** 终态原因审计（policy / sender_settled / superseded / dead_letter_undeliverable / …），仅审计用。 */
  terminalReason?: string;
  storageKey?: string; // 与 notifier 同款：pi outbox 的物理 key，默认 = key
}
```

**为什么 rejected 不是独立 state**：state 集合是 pump 的选择依据，rejected 记录永不参与投递；把它编码为 `dropped + rejected` 让 pump 的过滤条件保持唯一（`state === "pending"`），rejected 只影响 §4.7 的两条重建规则（seq 计入、配额不计入）。

**为什么 `deadLetter` 落在原记录而不是只落在死信记录**：I-F11 要求义务判定是原记录字段的纯函数；死信记录可能因 `suppressed_*` 根本不存在，若只靠死信记录，"被抑制"与"漏发"在磁盘上不可区分。

### 4.4 状态机（v4 重写：缺口 1 落点）

```
                 admit                    claim (内存)              verdict ok
  (工具提交) ───────────▶ pending ───────────────────▶ claimed ──────────────▶ delivered
                            │  ▲                          │
   admit(rejected) ─▶ dropped  │  │  retryable & attempts+1 < max │ retryable & attempts+1 ≥ max
                            │  └──────────────────────────┤ ─────────────────────────▶ dropped
                            │                             │ permanent target_gone / policy
                            │                             └─────────────────────────▶ dropped
                            │ TTL(P1) ────────────────────────────────────────────▶ abandoned
                            │ target gone(P2) ────────────────────────────────────▶ dropped
                            │ supersede / sender_settled(progress) ───────────────▶ consumed
```

| 状态        | 持久化 | 语义                                                  | 出边                                                     | 死信义务（I-F11）                           |
| ----------- | ------ | ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `pending`   | 是     | 可投递集成员                                          | claimed / delivered? 否 / consumed / dropped / abandoned | —                                           |
| `claimed`   | **否** | 有且仅有一个 send 在飞（I-F10）                       | pending / delivered / consumed / dropped                 | —                                           |
| `delivered` | 是     | 收到 `{ok:true}` 一次                                 | 无                                                       | 无                                          |
| `consumed`  | 是     | **系统有意丢弃**（supersede / sender settled）        | 无                                                       | **无**（D20：只有 progress 会进此态）       |
| `dropped`   | 是     | 投递失败（gone / attempts / policy）或 admission 拒绝 | 无                                                       | finding/directive 且非 rejected 且非 policy |
| `abandoned` | 是     | TTL 过期                                              | 无                                                       | finding/directive                           |

**D17 论证（claimed 不落盘为什么是对的而不是偷懒）**：
① 若落盘，reload 时磁盘上的 `claimed` 必须被当作 `pending`（旧栈的在飞 send 不可能被新栈接管），即落盘信息在唯一需要它的场合恰好无用；
② 不落盘使"磁盘上的可投递态 = pending"成为定理，reload 恢复只需一条 fold 规则（§4.7），且 at-least-once 的唯一重复来源被收窄为"claimed 期间发生 dispose"（§10）；
③ 省一次 appendEntry/attempt。代价：audit 回调（run log）仍会收到 "claimed" 事件，观测性不丢。

**D20 论证**：v3 把 target gone 归到 `consumed`，与 supersede 共用一个终态，使得"这条 finding 有没有死信义务"要回看审计文本才知道。v4 让 `consumed` 只承载"系统有意丢弃、无义务"，`dropped`/`abandoned` 承载"失败、有义务"——义务成为 `(state, kind)` 的函数，这是 §16-② 证明与 T-reload 测试都能只读磁盘工作的前提。

### 4.5 转移表（v4 重写 v3 §4.3：拆为 pre-claim 与 post-verdict 两段）

**P 段 —— pump 对每条 `pending` 候选按序判定，先匹配先生效，全部同步：**

| #   | 条件                                                                                                    | 转移                                                             | 后续                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P1  | `now - createdAt > ttlMs`                                                                               | → `abandoned`                                                    | finding/directive：`router.issueDeadLetter(rec,"ttl_expired")`（§9.2 序：先死信后转移） |
| P2  | `targetState(to) === "gone"`                                                                            | → `dropped`（terminalReason "target_gone"）                      | finding/directive：进入本次 pump 的死信聚合批（§9.4）                                   |
| P3  | `targetState(to) === "pending_start"`                                                                   | 不动                                                             | 等 onSnapshot hint（§8.0）；TTL 由 P1 兜底                                              |
| P4  | `inFlight.has(to)`                                                                                      | 不动                                                             | 该目标的 verdict 处理结尾会 `pump(to)`（§4.6）                                          |
| P5  | `now < eligibleAt(rec)`，其中 `eligibleAt = max(link.notBefore, rootNotBefore(rec), backoffUntil(rec))` | 不动                                                             | 纳入 nextWakeAt（§8.0 单定时器）                                                        |
| P6  | 其余                                                                                                    | `engine.claim(key)` → `claimed`（内存）；`inFlight.set(to, key)` | dispatch 异步 send；**本目标本次 pump 只 claim 一条**                                   |

**V 段 —— verdict 到达时，先做 stale 检查（v5：`!frozen && engine.get(key)?.state === "claimed" && record.claimToken === token`，三者任一不成立即丢弃 verdict，零副作用），再按序判定：**

| #   | 条件                                                                  | 转移                                            | 后续                                                                                       |
| --- | --------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| V1  | `{ok:true}`                                                           | → `delivered`（attempts+1, deliveredAt=now）    | `link.lastDeliveredAt=now`；若 to=root 且 channel=context：`rootLastDeliveredAt=now`       |
| V2' | retryable ∧ attempts+1 < maxAttempts ∧ kind=progress ∧ sender settled | → `consumed`（terminalReason "sender_settled"） | 缺口 5：这是 claimed progress 的"迟到 settle"出口，onRunSettled 本身不碰 claimed           |
| V2  | retryable ∧ attempts+1 < maxAttempts                                  | → `pending`（attempts+1, updatedAt=now）        | backoffUntil 由 (updatedAt, attempts) 推导（§4.7）；纳入 nextWakeAt                        |
| V3  | retryable ∧ attempts+1 ≥ maxAttempts                                  | → `dropped`（"attempts_exhausted"）             | finding/directive：`issueDeadLetter(rec,"attempts_exhausted")`（单条，非聚合）             |
| V4  | permanent `target_gone`                                               | → `dropped`（"target_gone"）                    | finding/directive：`issueDeadLetter(rec,"target_gone")`（单条；每目标至多 1 条，因 I-F10） |
| V5  | permanent `policy`                                                    | → `dropped`（"policy"）+ console.warn           | 不生成死信（授权在 admission 已判定；发送期 policy 失败是防御分支，不是可投递性问题）      |
| V∗  | 任一 V 行结束                                                         | `inFlight.delete(to)`                           | `pump(to)`                                                                                 |

verdict 来源映射（`AsyncSender`，经 §5.1 的 `boundedSend` 包装）：run 目标 `steerRun` resolve → V1；reject 且 message 匹配 `no active session` → V4；其他 reject → retryable；**v5：`fabricSteerTimeoutMs` 内未 settle → retryable（reason `steer_timeout`），走 V2/V3，attempts+1**；root context `pi.sendMessage` 不抛 → V1，抛 → retryable；root display `appendEntry` 同理。maxAttempts/backoffMs 复用 `deliveryAttempts`/`deliveryBackoffMs`（既有键）。

**V1 与 sender settled（重要 5 三问之一）**：V1 **总是**更新 `link.lastDeliveredAt`（及 root 项），与发送者是否已 settle 无关 —— 该链路上可能仍有 pending finding/directive（admission 后与发送者生死解耦，I-F9），它们仍需按 minInterval 排布；发送者 settle 只意味着该链路不再有新 admission，不意味着链路历史失效。

**互斥性论证（缺口 8c）**：P 行与 V 行分别只在 `pending`、`claimed` 两个不同状态上求值；每段内按序 first-match；每个终态无出边。故一条 record 在其生命周期内至多触发一次 `issueDeadLetter` —— 不需要任何额外去重就能保证"同一原记录多失败原因不产多死信"；§9.2 的 ref.keys 集合只为 reload 边界服务。

### 4.6 DeliveryEngine 内核 API（`src/delivery/engine.ts`；v4 定义）

纯同步、无 I/O 以外的副作用、无定时器。泛型于 record 类型与 state 类型，转移合法性由构造参数注入（Stage A2 迁移终态通知时复用同一内核、不同表）。

```ts
export interface EngineOptions<
  R extends { key: string; state: S; attempts: number; updatedAt: number },
  S extends string,
> {
  store: OutboxStore<R>; // core/store.ts 既有接口
  allowed: Readonly<Record<S, readonly S[]>>; // 出边表；终态为 []
  memoryOnly: ReadonlySet<S>; // fabric: {"claimed"}
  memoryOnlyFields: readonly (keyof R)[]; // v5：持久化时剥离的字段；fabric: ["claimToken"]
  now: () => number;
  onDegraded?: (key: string, reason: string) => void;
}
export interface DeliveryEngine<R, S> {
  put(record: R): boolean; // key 已存在 → false；store.put 抛错 → 抛出（不入内存，见下）
  get(key: string): R | undefined;
  select(pred: (r: R) => boolean): R[];
  /** 同步原子转移。前置：当前 state ∈ from 且 guard 通过。返回新 record；失败返回 undefined（不改任何状态）。 */
  transition(key: string, from: S | readonly S[], to: S, patch?: Partial<R>, guard?: (r: R) => boolean): R | undefined;
  /** = transition(key, "pending", "claimed", { claimToken: token })，且不写 store（memoryOnly）。v5：token 由调用方（mailbox 实例）生成。 */
  claim(key: string, token: string): R | undefined;
  /** 只补审计字段、不改 state（deadLetter/terminalReason）。写 store。 */
  annotate(key: string, patch: Partial<R>): boolean;
  /** dispose 用：之后所有 put/transition/claim/annotate 返回 false/undefined，get/select 照常。 */
  freeze(): void;
  fold(list: readonly R[]): Map<string, R>; // §4.7 规则
  readonly stats: Record<S, number>;
}
```

- **`claim` 的原子性论证**：JS 单线程；`claim` 内部无 await；pump 的 select→claim→dispatch 也无 await（I-F10 是编码纪律，T-mailbox-claim 用"同一 tick 两次 pump + 永不 resolve 的 sender"断言 sender 只被调用一次）。"两个 pump 并发"在此模型下只能是两个宏任务，后者看到的已是 `claimed`。
- **claimToken（v5，D22，替代 v4 的裸 epoch）**：`token = mailboxInstanceId + ":" + attempts`，`mailboxInstanceId` 在 mailbox 构造时生成（`newRunId()` 同款随机 id，每次 `buildSessionStack` 一个新值）。V 段 stale 检查 = `!frozen ∧ state==="claimed" ∧ record.claimToken===token`。
  - **同实例内**：epoch 分量排除"claim→V2 回 pending→再 claim"后旧 verdict 晚到（attempts 已 +1，token 不等）。
  - **跨实例**：v4 的裸 epoch 在"dispose → 新栈 reload 同记录（fold 后 attempts 相同）→ 新栈再 claim"场景下恰好相等，旧 verdict 若能触达新 engine 就会被误消费。v5 双重隔离：① verdict 回调是闭包，只持有**发起 claim 的那个** mailbox/engine 引用，物理上触达不到新栈的 engine；② 即便未来重构成共享注册表，实例 id 分量也让 token 不等。两层各自独立充分。
  - **freeze 后零写盘**：旧实例的 engine 已 freeze，所有 mutator 返回 false/undefined；旧实例的 `boundedSend` 定时器在 dispose 时全部 clearTimer，未清到的回调也先查 frozen。共享介质（`pi.appendEntry`）只经 engine 触达 ⇒ 旧实例对它零写入（I-F15）。
- **写失败语义**（与 notifier 同款，明示）：`put` 抛错 ⇒ 不入内存、向上抛（admission 失败，工具抛 "persist failed"，I-F9 不成立即不承诺）；`transition`/`annotate` 的 store 写抛错 ⇒ **内存已更新、磁盘落后**，记 degraded，不回滚。落后的后果全部收敛为 at-least-once（磁盘 pending 比内存旧 ⇒ reload 后重发），不会产生磁盘比内存"更前进"的情况（§16-① 依赖此方向性）。
- **`freeze` 与在飞 verdict**：freeze 后 V 段 stale 检查前先查 frozen → 直接丢弃。旧栈的 sender 可能已成功送达 ⇒ 磁盘仍 pending ⇒ 新栈重发 ⇒ 这是 §10 明示的唯一重复来源。

### 4.7 outbox 运维与 reload 恢复（v4：缺口 6/7 完整规则）

- **单扫描落地**（同 v3）：`createPiOutboxStore(pi, customType = OUTBOX_CUSTOM_TYPE, prefetched?)`；stack 构建期 `getEntries()` 一次，喂两个 outbox store（构建期仅此两次扫描；`pi-run-log.ts` 只在 `verifyLanded()` 按需扫，不在构建期）。fabric customType = `"subagent:fabric"`（与 `"subagent:outbox"` 不相交，I-F5）。
- **fold**（`engine.fold`）：同 key 多条取 `updatedAt` 最大者（同 updatedAt 取 attempts 大者）；**归一化：`state==="claimed"` → `"pending"`，并删除 `claimToken`**（D17/D22 下磁盘不应出现，防御性规则，出现即 WARN）。
- **恢复清单（全部为持久化字段的函数，无运行期状态被读取）**：

| 恢复量                | 重建公式                                                                                                                                                                                                       | 松弛量（reload 后最坏偏差）                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastSeq[link]`       | `max(seq)` over 该链路全部记录，**含 rejected、含 system 链路**                                                                                                                                                | 0（seq 单调性不受 reload 影响）                                                                                                                                                                                                   |
| `used[from][kind]`    | `count(r.from===from ∧ r.kind===kind ∧ r.rejected===undefined)`，跨 generation                                                                                                                                 | 0                                                                                                                                                                                                                                 |
| `deadLetterUsed[to]`  | `count(r.kind==="dead_letter" ∧ r.to===to)`                                                                                                                                                                    | 0                                                                                                                                                                                                                                 |
| 死信幂等映射 `dlRefs` | **v5** `Map<origKey, DeadLetterOutcome>`：issued 项 = 对每条 kind==="dead_letter" 记录 d，`d.ref.keys[i] → {status:"issued", key:d.key}`；suppressed 项 = 每条带 `deadLetter.status==="suppressed_*"` 的原记录 | 0                                                                                                                                                                                                                                 |
| `link.notBefore`      | `max(deliveredAt)` over 该链路 delivered 记录 `+ minIntervalMs`；无则 0                                                                                                                                        | 0（deliveredAt 与 V1 同一写）                                                                                                                                                                                                     |
| `rootNotBefore`       | `max(deliveredAt)` over `to==="root" ∧ delivered ∧ effectiveChannel(r)==="context"` `+ rootMinIntervalMs`                                                                                                      | channel 是推导值：若 caps 在 reload 前后翻转，计数集合变化 ⇒ 最坏多放行 1 条（§8.5 上界的 "+1" 项已含）                                                                                                                           |
| `backoffUntil(rec)`   | `pending ∧ attempts>0` ⇒ `updatedAt + backoffMs · 2^(attempts-1)`；否则 0                                                                                                                                      | 0（V2 写 updatedAt 与 attempts 同一写）；旧栈的 setTimer 丢失，由 §8.0 单定时器在 reconcile 时重排                                                                                                                                |
| root inbox 计数       | `count(to==="root" ∧ state==="pending" ∧ effectiveChannel==="context")`（fold 后 claimed 已归一化为 pending）                                                                                                  | 同 rootNotBefore 的 channel 翻转项                                                                                                                                                                                                |
| tree 边               | `RunSnapshot.parentRunId` 重放（`core/types.ts:352`）+ 终态 snapshot → tombstone                                                                                                                               | 同 v3                                                                                                                                                                                                                             |
| 在飞记录              | 不存在（D17）                                                                                                                                                                                                  | 旧栈 claimed 期间成功送达但 verdict 被 freeze 丢弃 ⇒ 重发 1 次（§10 at-least-once）；**v5.1**：root 记录同样适用（claim 与 V1 之间有 microtask 边界，dispose 理论上可落入其中），且因 inFlight gate 每次 dispose 对 root 亦 ≤1 条 |

恢复完成后 `mailbox.pump()` 一次（等价于 notifier 的 `reconcile()` 位置，`index.ts:225` 之后同点）。

## 5. 组件设计（文件级）

### 5.1 新文件（v4 修订职责）

| 文件                              | 职责                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/message.ts`             | envelope（§4.1）、`FabricRecord`（§4.3）、key 函数、relation、`authorize()` 纯函数、`effectiveChannel()` 纯函数                                                                               |
| `src/delivery/engine.ts`          | §4.6 内核                                                                                                                                                                                     |
| `src/fabric/tree.ts`              | 自持 append-only 边表（§7.0）、relation/lca/hops、tombstone、`targetState()`                                                                                                                  |
| `src/fabric/router.ts`            | admission 线性化点（§8.2，含 root inbox cap）、配额计数、supersede、`issueDeadLetter`/`issueDeadLetters`（§9.2/§9.4）、`onRunSettled`（§10）                                                  |
| `src/fabric/throttle.ts`          | 纯 bookkeeping：`link.notBefore`、`rootNotBefore`、`backoffUntil`、`eligibleAt()`；**无状态持久化，全部可由 §4.7 重建**；构造时接收 fold 结果一次性回填                                       |
| `src/fabric/mailbox.ts`           | `pump()`（§8.0 算法）、in-flight 表、单定时器 nextWakeAt、verdict 处理（§4.5 V 段）、`dispose()`=engine.freeze + clearTimer；**v5** `mailboxInstanceId`、`boundedSend` sender adapter（见下） |
| `src/tools/message-agent-tool.ts` | 注入工具（§6.1）                                                                                                                                                                              |

**v5 `boundedSend`（D21，阻断 2 落点）** —— mailbox 内部的 sender adapter，位于 `FabricPorts` 之上、V 段之下：

```
boundedSend(rec): Promise<Verdict>            // 永不 reject；恰 resolve 一次
  return new Promise(resolve => {
    let done = false
    const finish = (v) => { if (done) return; done = true; clock.clearTimer(t); raceTimers.delete(t); resolve(v) }
    const t = clock.setTimer(fabricSteerTimeoutMs, () => finish({ ok:false, retryable:true, reason:"steer_timeout" }))
    raceTimers.add(t)
    ports.inject(rec).then(v => finish(v), e => finish(toVerdict(e)))   // toVerdict：§4.5 映射
  })
```

- `fabricSteerTimeoutMs = settings.budget.steerMs`（`core/types.ts:64`，默认 5 000 ms；`/agent settings` 可调），**不加新配置键**；模式与 `reaper.ts:182-200` 的 `bounded()` 同源，只是把 boolean 换成 Verdict。fabric 不在 abort 升级路径上，故不取 `min(steerMs, abortGraceMs)`。
- 超时后底层 `handle.steer` 可能仍在进行并最终成功：该成功**不被观察**（Promise 已 settle），记录走 V2 → pending → backoff 后重发 ⇒ 可能重复 ⇒ 属 at-least-once 允许面（§10），与 reload 重复同类。这是 I-F14 的代价，也是唯一代价。
- root 路径（`sendRootContext`/`sendRootDisplay`）：底层 `pi.sendMessage`/`appendEntry` 同步无 ack（不抛即 ok），但 `FabricPorts` 是 Promise 接口 ⇒ verdict 在下一 microtask 结算，定时器随即 clear；**v5.1**：不依赖其"同步性"做任何证明（§8.5-2）。
- `dispose()` 追加动作：`for t of raceTimers: clock.clearTimer(t)`（§5.5）。定时器经 `Clock` ⇒ 自动 unref。**v5.1**：clear 后若底层 Promise 永不 resolve，对应 `boundedSend` 悬挂 —— 无人 await 它，V 段回调即便触发也因 frozen 零副作用，闭包随实例被 GC；属 I-F14 的显式排除面。

### 5.2 FabricPorts（同 v3：`inject` / `sendRootContext` / `sendRootDisplay` / `targetState` / `resolveHandle`；无 digest）

### 5.3–5.4（同 v3）

### 5.5 生命周期闭环（v4 补 freeze 语义）

| 场景                                     | 契约                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session_shutdown 的 dispose 位置         | 同 v3：`index.ts:226-252` 中 `rpc.close()` 之后、`query.stop()` 循环之前                                                                                                                                                                                                                  |
| **dispose 的精确动作（v4/v5）**          | ① `engine.freeze()`；② `clock.clearTimer(wake)`；③ **v5** `raceTimers` 全部 clearTimer；④ `inFlight.clear()`；⑤ router disposed 标志（工具调用抛 "shutting down"）。**不**回滚 claimed（磁盘本来就是 pending，D17）；**不**等待在飞 promise（其 verdict 撞 frozen 直接丢弃，I-F15）；幂等 |
| session_start 的新栈                     | 先 dispose 上一栈（同 fleetWidget 模式，`stack.ts:286-299`），再 prefetch 扫描、fold、§4.7 恢复、`pump()`                                                                                                                                                                                 |
| 双扫描预防                               | §4.7 prefetched 参数                                                                                                                                                                                                                                                                      |
| 其余（unref / 不阻塞 drain / swap 顺序） | 同 v2/v3；定时器全部经 `Clock`（`core/clock.ts:12-20` 已 unref）                                                                                                                                                                                                                          |

## 6. 工具、门控与配置

### 6.1 `message_agent` 工具返回（v4：缺口 7 落点）

```ts
type MessageAgentResult =
  | { ok: true; status: "accepted"; key: MessageKey; seq: number; superseded?: MessageKey }
  | {
      ok: false;
      status: "quota_exhausted";
      key: MessageKey;
      seq: number;
      kind: MessageKind;
      used: number;
      quota: number;
    }
  | { ok: false; status: "target_backpressure"; key: MessageKey; seq: number; retryAfterMs: number };
```

- **`ok` 的语义 = "是否产生了一条 `pending` 记录"**，即 I-F9 承诺是否成立、§16-① 义务是否附着。`ok:false` 时**也**有一条持久化记录（rejected，§4.3），所以两种拒绝都带 `key/seq`（审计可追）。
- 拒绝不抛错的理由：这两种都是发送者 LLM 可合理应对的软结果（精简/延后/放弃）；抛错的保留给"不该发生"的类别 —— 策略拒绝（授权矩阵不允许）、发送者非 running、fabric 已 disable/disposed、persist 失败。
- `superseded`：progress latest-wins 时被 consume 的旧 key（§8.3）。
- `retryAfterMs = max(0, rootNotBefore - now)`：只是提示，fire-and-forget 不等待。
- 截断（code-point，保头 75%/尾 25%）、from 钉死 —— 同 v2。

### 6.2 策略门控（同 v2/v3）

### 6.3 配置块 `fabric.*`（v4：9 键 → 11 键）

| 存储键                        | 内部路径                   | 默认        | 说明                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fabric.enabled`              | `fabric.enabled`           | `true`      | 总开关                                                                                                                                                                                                                                                       |
| `fabric.minIntervalS`         | `fabric.minIntervalMs`     | `30`        | 逐链路最小投递间隔（发送者侧）                                                                                                                                                                                                                               |
| `fabric.maxPerRun`            | `fabric.maxPerRun`         | `20`        | 仅约束 progress                                                                                                                                                                                                                                              |
| `fabric.findingQuota`         | `fabric.findingQuota`      | `10`        | finding 独立子配额（per 发送者 run，跨 generation）                                                                                                                                                                                                          |
| `fabric.directiveQuota`       | `fabric.directiveQuota`    | `5`         | directive 独立子配额（同上）                                                                                                                                                                                                                                 |
| `fabric.deadLetterQuota`      | `fabric.deadLetterQuota`   | `5`         | 死信限额，**per 原发送者 run**（§9.1）                                                                                                                                                                                                                       |
| `fabric.maxChars`             | `fabric.maxChars`          | `2000`      | 单条截断                                                                                                                                                                                                                                                     |
| `fabric.progressTtlS`         | `fabric.progressTtlMs`     | `900`       | progress TTL（finding/directive/dead_letter 用既有 `reconcileTtlMs`）                                                                                                                                                                                        |
| `fabric.progressChannel`      | `fabric.progressChannel`   | `"display"` | progress→root 通道                                                                                                                                                                                                                                           |
| **`fabric.rootMinIntervalS`** | `fabric.rootMinIntervalMs` | `10`        | **v4** root ingress 目标侧最小间隔（context 通道）；**v5** 解析 `Math.max(0, Math.floor(x))`：`0` = 关闭速率项（D23）；`≥1` ⇒ ≥1 000 ms；**v5.1** `0` 时的保证 = 单 stack 生命周期内 context 记录 pending+claimed ≤ `rootInboxCap`，不宣称跨 reload 累计速率 |
| **`fabric.rootInboxCap`**     | `fabric.rootInboxCap`      | `12`        | **v4** root context 待投递上限（pending+claimed），超出 admission 拒绝                                                                                                                                                                                       |

`TIME_SETTING_MS_PATHS` 追加 `fabric.rootMinIntervalMs`；`parseFabricSettings` 逐字段容错；`SETTING_SPECS` 登记 —— 同 v2 纪律。**v5**：fabric 级 steer 超时**不新增键**，直接读 `settings.budget.steerMs`（§5.1）。

### 6.4 display 通道能力探测（v4：缺口 8d 完整接线清单）

| #   | 文件                          | 编辑                                                                                                                                                                                        |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `adapters/pi-compat.ts:17-33` | `PiCapabilities` 加 `canRenderEntries: boolean`                                                                                                                                             |
| 2   | `adapters/pi-compat.ts:35-42` | `MinimalPiHost` 加 `registerEntryRenderer?: unknown`                                                                                                                                        |
| 3   | `adapters/pi-compat.ts:65-75` | `detectPiCapabilities` 加 `canRenderEntries: typeof pi.registerEntryRenderer === "function"`；`assertCompatible` **不**把它列入 critical（非必需能力，缺失只 WARN）                         |
| 4   | `index.ts:105` 之后           | `if (caps.canRenderEntries) pi.registerEntryRenderer("subagent:fabric", renderFabricEntry)` —— 与工具注册同点、同 HOST_KEY 守卫，每次 activate 一次（/reload 重导入 ⇒ 重注册，与工具一致）  |
| 5   | `stack.ts`                    | fabric 构建处自行调用 `detectPiCapabilities(pi).canRenderEntries`（load-time 成员，session 内不变；避免改 `buildSessionStack` 五参签名）；也可选传 caps，二择一，实施时以不改公共签名为优先 |

`effectiveChannel(env, settings, caps)` 纯函数与 fallback 语义同 v3（推导值不落盘）。

### 6.5 注入点（同 v2 四件套；`finally` 调 `fabric.onRunSettled`）

## 7. 授权与路由（§7.0–7.3 同 v3，零改动）

## 8. QoS / 限速 / 配额

### 8.0 目标状态、pump 算法与唤醒完备性（v4：缺口 1/8a 落点）

三种 `TargetState`：`pending_start`（queued/starting）/ `running` / `gone`（stopping/终态/未知/tombstone）；`"root"` 恒 `running`（root 是宿主会话，若它在拆除，mailbox 已先 dispose，§5.5）。

**onSnapshot 措辞修正（8a）**：`stack.ts:526-536` 的 announcedStarts 是"每 run 一次的事件发射"，它证明的只是 `SpawnServiceDeps.onSnapshot` 在每次状态转移时都会被调用（`spawn-service.ts:186-191`），可以作为 fabric 的 hook 挂点；它**不是** flush 语义的先例。fabric 在同一回调体内追加 `if (snapshot.status === "running") mailbox.pump(snapshot.runId)`，pump 自身以 engine 状态为准（hint 语义）。

**pump 算法**（全同步，I-F10）：

```
pump(hint?: NodeRef):
  if frozen: return
  targets = hint ? [hint] : distinct(to) over select(state==="pending")
  goneBatch = []
  for T of targets:
    for rec of select(to===T ∧ state==="pending") sorted by (createdAt, seq):
      P1..P6 按序；P2 命中的 finding/directive 推入 goneBatch；P6 命中后 break（本目标一条）
  router.issueDeadLetters(goneBatch)            // §9.4 聚合，仍在本同步段
  rescheduleWake()                              // 见下
```

**唤醒完备性论证（liveness）**：一条 `pending` 记录停留的每一个原因都有且只有一个唤醒源，且该源不依赖"我以为它 pending"的快照：

| 停留原因（P 行） | 唤醒源                                                                      | 为什么不会漏                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3 目标未启动    | onSnapshot(status==="running") → `pump(to)`                                 | 目标若永不 running ⇒ 必经终态 ⇒ 变 gone ⇒ 下一次任何 pump 走 P2；且 TTL（P1）由单定时器兜底                                                       |
| P4 目标在飞      | V∗ 行 `pump(to)`                                                            | **v5**：`boundedSend` 保证 verdict 在 ≤ `steerMs` 内有限到达（I-F14），**不依赖** sender 契约；若栈被 dispose，磁盘 pending 由新栈 reconcile 接手 |
| P5 未到时刻      | 单定时器 `wake` = `min(eligibleAt, createdAt+ttlMs)` over 所有 pending 记录 | `rescheduleWake()` 在每次 pump 结尾、每次 admission 结尾、每次 V 行结尾重算；定时器只有一个，clear 后重设                                         |
| reload           | session_start 恢复后 `pump()`                                               | 磁盘上的可投递态恒 pending（D17），fold 后一次 pump 覆盖全部                                                                                      |

三触发源（onSnapshot / 单定时器 / V∗）去重规则同 v3：全部是 hint，`engine.transition` 对非预期当前态返回 undefined。

### 8.1 动机（同 v2）

### 8.2 分级配额与 admission 序（v4：加 root ingress cap）

| 类别             | 规则                                                                                                                  | 计数维度（v4 写死）                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| progress         | `used[from].progress < maxPerRun`                                                                                     | per 发送者 run，跨 generation、跨目标 |
| finding          | `used[from].finding < findingQuota`                                                                                   | 同上                                  |
| directive        | `used[from].directive < directiveQuota`                                                                               | 同上                                  |
| dead_letter      | `deadLetterUsed[to] < deadLetterQuota`                                                                                | per **目标**（= 原发送者 run；§9.1）  |
| **root ingress** | `rootInbox < rootInboxCap`，`rootInbox = count(to==="root" ∧ state∈{pending,claimed} ∧ effectiveChannel==="context")` | 全局单计数器；与 from 无关            |

**admission 序**（`router.admit()` 单同步段；缺口 2 新增第 ④ 步）：
① `getRunState(from)` 校验 running → ② relation/authorize（失败抛错） → ③ kind 配额 → ④ **root ingress cap**（仅 to=root ∧ 推导 channel=context） → ⑤ seq 分配（admitted/rejected 共用递增序列） → ⑥ via → ⑦ progress supersede（同链路 `pending` progress → `consumed`，**只碰 pending**，claimed 不动） → ⑧ `engine.put`（admitted：`state:"pending", attempts:0`；③/④ 拒绝：`state:"dropped", rejected:{reason}`） → ⑨ `rescheduleWake()`；若 to 目标 running 且不在飞则 `pump(to)`。

拒绝也走 ⑤⑧：所以 seq 单调覆盖一切提交、审计全量（I-F8）；③ 与 ④ 的拒绝都**不计**该 kind 的 `used`（§4.7 规则）。

### 8.3 supersede（同 v3；v4 明确只作用 `pending`）

### 8.4 逐 kind context policy（同 v2；channel 推导见 §6.4）

### 8.5 root context 有界性（v4 重写：缺口 2 落点）

**v3 论证为何不成立**（§0.3 已核实三条）：nested run slotless、单 parent fan-out 无上限、`concurrencyLimit=0` 合法 ⇒ "并发 sender 数"在协议层没有任何配置无关的上界；任何形如 `速率 × sender 数` 的论证都随之失效。

**v4 方案 = 目标侧自持上界（D18）**。三种候选的取舍：

- (a) fabric 自有 root gate（cap + interval）—— **采纳**。记录本来就已持久化在 engine，"target-side 持久化队列"（候选 b）实质上就是 engine 的 pending 集合，缺的只是把它变成上界的两个数；(b) 与 (a) 是同一件事的两种叫法，(a) 表述更诚实。
- (c) dead_letter 改 display-only —— **无关**。发送者恒为 run（root 不使用 `message_agent`），死信 `to` = 原发送者 ⇒ **root 永不接收 dead_letter**；root 的 context 流量在默认配置下只有 finding（progress 走 display；directive 只能祖先→子，root 不是任何节点的子；result 不在 MVP）。

**数学上界（I-F12）**。记 `C = rootInboxCap`、`R = rootMinIntervalMs`、`M = maxChars`（+固定 header）。**v5（D23）**：`R` 的取值域为 `{0} ∪ [1000, ∞)`（存储单位整数秒，§6.3）；`R = 0` 时 `rootNotBefore ≡ 0`、P5 的 root 项恒成立，下列第 2/3 条**不宣称**，只保留第 1/4 条 —— 这是配置者显式选择"只要背压、不要限速"时得到的诚实承诺，而不是让 ⌈W/0⌉ 出现在证明里。

1. **瞬时积压**：`rootInbox ≤ C` 恒成立。证：`rootInbox` 只在 admission ⑧ 增（同步段内先判 ④ 再增，判增之间无 await），只在 V 行减；admission 是唯一增点且被 ④ 守卫 ⇒ 归纳成立。与 sender 数无关。
2. **速率（R > 0）**：任意长度 W 的窗内 root context delivered ≤ ⌈W/R⌉ + 1 + f。**v5.1 证明改基（不再依赖 root send 同步）**。事实：`FabricPorts.sendRootContext` 返回 Promise，V1 在 microtask 结算，claim 与 V1 之间可插入其他 microtask（如 tool `execute` 中的 admission ⑨ `pump(root)`）。归纳基础：(i) P6 claim root 记录时同步 `inFlight.set(root, key)`；(ii) 此后任何 pump 对 root 的候选都被 P4 挡住，直到 V∗ 行 `inFlight.delete(root)`；(iii) V1 在 V∗ **之前**写 `rootLastDeliveredAt = t_i`（同一同步段内先 V1 后 V∗）；(iv) 下一条 root 记录被 claim 需通过 P5：`now ≥ rootLastDeliveredAt + R = t_i + R`。归纳：设第 i 次 root delivered 时刻 t_i，则第 i+1 次的 claim 时刻 ≥ t_i + R（由 ii–iv），而 delivered 时刻 t_{i+1} ≥ claim 时刻 ⇒ t_{i+1} − t_i ≥ R。故任意窗内 delivered ≤ ⌈W/R⌉ + 1。所需前提只有 A1（V1→V∗ 在一个同步段）与 A2（claim 唯一入口）；不需要 root send 同步。"+1" 只覆盖窗口边界。**v5 松弛量 f 的精确范围**：f = 窗内"`effectiveChannel` 推导集合发生翻转"的 reload 次数。单次 reload 且 caps 未变 ⇒ `rootNotBefore` 由 `max(deliveredAt)` 精确重建，f = 0；每一次 caps 翻转的 reload 最坏多放行 1 条 ⇒ f = 翻转次数（≤ reload 次数）。翻转只在 pi 版本/扩展变更导致 `canRenderEntries` 改变时发生，同一 pi 下反复 `/reload` 的 f 恒为 0。**v5.1**：reload 对 root 亦可能造成 ≤1 条重复投递（dispose 落在 claim 与 V1 的 microtask 边界内；§4.7 在飞记录行），属 at-least-once 允许面，不计入速率界（它是重发而非新 admission，且仍受 P5/P4 约束）。
3. **单 turn 注入（R > 0）**：turn 时长 T ⇒ 注入条数 ≤ ⌈T/R⌉ + 1 + f，字节 ≤ 该数 · M（默认 R=10s、M=2000、f=0：一个 60s 的 turn ≤ 7 条 ≤ 14 KB）。
4. **静默后尾巴（任意 R，含 R=0）**：所有 sender 停止提交后，root 还会收到 ≤ C 条（由 1），之后为 0。R=0 时这 C 条可能在同一 tick 内连续送达 —— 这正是 D23 下配置者明确接受的行为。
   4'. **v5.1：R=0 与 channel 翻转的保证范围**。第 1 条的 `≤ C` 精确表述为：**在单个 stack 生命周期内**（构造完成到 freeze），admission 永不使 context 计数超过 C（④ 守卫）。跨 stack：reload 时按**新** `effectiveChannel` 推导重新计数（§4.7）；同一 caps 下重计数与旧栈内存值相等，`≤ C` 无缝延续；caps 翻转的 reload 只改变**哪些已持久化记录计入 context cap**（例：display→context 翻转把原本不计的 pending progress 计入），起始计数因此**可能 > C**（最多 + 有 pending progress→root 的 sender 数，每 sender ≤1 因 latest-wins）；此时 ④ 拒绝一切新 root context admission，计数只经 V 行单调下降，降回 ≤ C 后恢复正常。R=0 时**不宣称**任何跨多次 stack 重建的累计投递速率界 —— 唯一承诺是上述逐 stack 的 cap 与静默尾巴。
5. **总量**：单 sender 生命周期内 ≤ `findingQuota` 条到 root（kind 配额），但 sender 数无界 ⇒ **总量上界只能是"任意时刻 ≤ C、任意窗 ≤ ⌈W/R⌉+1"这种时间相对形式**；这与 fire-and-forget 语义一致 —— 不存在"整个会话 root 最多收 N 条"这样的常数，也不应存在（否则长会话会静默丢消息）。超额提交的处置是 admission 拒绝（`target_backpressure`，发送者可见），不是静默丢。

display 通道（progress→root 默认）不在 I-F12 范围：`appendEntry` 不进 LLM context；其数量上界 = 每条 admitted progress 至多 1 次 appendEntry ≤ 审计日志条数，属 I-F8 既有接受面。

## 9. 死信（v4：维度 / 原子性 / 终态 / 聚合）

### 9.1 配额维度（缺口 3 定案）

`deadLetterQuota` 按 **死信的 `to`（= 原发送者 run id）** 计数，跨 generation、跨失败原因、跨触发路径；聚合死信计 1。理由：① 死信的唯一目的是回投发送者 context，上界该落在被注入的那个 context 上；② 与 seq 维度一致 —— 死信 seq 在 system 链路 `(system, to, 0)` 上分配，配额与 seq 同维度，reload 重建只需一次 group-by（§4.7）；③ 拒绝 per-reap-event（同一 sender 可跨多个 reap 事件被反复打满）与全局（一个失控 sender 吃光所有 sender 的死信额度）。

### 9.2 生成的同步原子序（缺口 4 定案）

`router.issueDeadLetter(orig, reason)` 是**唯一**入口（P1/V3/V4 单条路径与 P2 聚合路径 `issueDeadLetters(batch)` 内部逐 sender 调用同一函数），整个函数无 await。**v5 重写步骤 1（阻断 1）**：v4 的"命中 ⇒ 只 annotate"不改 state，让 crash 恢复路径上的 orig 永久停在 pending（每次 pump 都命中、每次都只 annotate）—— 这是一个活锁，违反 §16-①。修正为命中即在同段修复终态：

```
type DeadLetterOutcome = { status:"issued", key:MessageKey } | { status:"suppressed_quota" | "suppressed_sender_gone" }
dlRefs: Map<MessageKey /*orig*/, DeadLetterOutcome>       // §4.7 重建

terminalFor(reason) = reason==="ttl_expired" ? "abandoned" : "dropped"     // 与 P1/P2/V3/V4 的转移一致

issueDeadLetter(origs: FabricRecord[] /* 同一 from */, reason):
  0. if frozen: return                                   // 旧栈不再生成（§5.5/I-F15）
  1. for o of origs.filter(o => dlRefs.has(o.key)):      // ★ v5：命中 ⇒ 同段修复，不是 annotate
       prior = dlRefs.get(o.key)                          // ★ v5.1：按已恢复的 outcome 分支
       patch = prior.status === "issued"
             ? { reason, status:"issued", key: prior.key }              // ref repair：key 来自真实死信记录
             : { reason, status: prior.status }                         // suppressed_*：无死信记录、无 key
       engine.transition(o.key, ["pending","claimed"], terminalFor(reason), { terminalReason: reason, deadLetter: patch })
     fresh = origs.filter(o => !dlRefs.has(o.key))
     if fresh.length === 0: goto 5
  2. for o of fresh: dlRefs.set(o.key, PLACEHOLDER)      // 先占位，再 I/O
  3. sender = origs[0].from
     if targetState(sender)==="gone":      outcome = { status:"suppressed_sender_gone" }
     else if deadLetterUsed[sender] ≥ quota: outcome = { status:"suppressed_quota" }
     else:
       env = { from:"system", to:sender, kind:"dead_letter", seq:nextSeq(system,sender,0), generation:0,
               ref:{ keys: fresh.slice(0,5).map(k), omittedCount: max(0, fresh.length-5) }, ttlMs: reconcileTtlMs, ... }
       try engine.put({...env, state:"pending", attempts:0})   // 持久化死信
       catch: for o of fresh: dlRefs.delete(o.key); rethrow → 调用方记 degraded，orig 保持原状（下次 pump 重试）
       deadLetterUsed[sender]++; outcome = { status:"issued", key: env.key }
     for o of fresh: dlRefs.set(o.key, outcome)
  4. for o of fresh: engine.transition(o.key, ["pending","claimed"], terminalFor(reason),
                                       { terminalReason: reason, deadLetter: { reason, ...outcome } })
                                                        // 原记录终态转移 + 义务履行审计，一次写
  5. rescheduleWake(); if sender running: pump(sender)
```

- **终态按"本次命中的失败原因"选**（P1 → abandoned，P2/V3/V4 → dropped）。为什么不是"首次原因"：崩溃点在 3–4 之间时 orig 在磁盘上仍是 pending，首次原因没有任何持久化载体（envelope §4.1 不改，`ref` 只有 keys）；新栈重新 pump 观察到的原因才是可判定的事实。首次原因已写在死信 payload 文本里，两者可以不同、均为审计事实，不影响义务函数 I-F11（它只看 `deadLetter !== undefined`）。
- **同一 orig 的两个字段写在一次 transition 里**（state + deadLetter），不拆成 transition + annotate 两次写 —— 拆开会重新制造"state 已终态、deadLetter 未写"或反向的中间态。
- **v5.1：`suppressed_*` 命中的来源与语义**。`dlRefs` 的 suppressed 项来自磁盘上**已终态**且带 `deadLetter.status==="suppressed_*"` 的原记录（§4.7），它们没有出边，正常不会再进入 issue；该分支只在防御场景触发（如步骤 1 修复写盘失败后 reload，磁盘 orig 仍 pending 而 `dlRefs` 无该项 ⇒ 走 fresh 路径重新判定 quota/sender —— 结果可能是 issued 或再次 suppressed，两者都恰一个 outcome，死信总数仍 ≤1）。suppressed 是最终审计态（§9.3），命中时**不**重新评估配额、不产生死信、不写 key。

**为什么这样就不会双发死信、也不会漏修（§16-①②）**：

- **栈内**：一条 orig 至多进入一次 issue（§4.5 互斥性）；步骤 2 在任何 I/O 前占位，同一同步段内没有第二个调用者能观察到"未占位"状态。
- **跨 reload（I-F13）**：步骤 3 的 put 在步骤 4 之前。崩溃/重载落在 3–4 之间 ⇒ 磁盘上死信已存在（ref.keys 含 orig.key）、orig 仍 pending ⇒ 新栈 §4.7 重建 `dlRefs`（含该 orig → issued/key）⇒ 重新 pump ⇒ 再次失败 ⇒ 进入 issue ⇒ **步骤 1 在同段把 orig 转终态并按 outcome 写 deadLetter（issued ⇒ 含 key；suppressed ⇒ 无 key）**，不再 put ⇒ 死信总数 1、orig 终态、义务已履行。落在 3 之前 ⇒ 什么都没发生 ⇒ 新栈从头做，恰好一次。落在 4 之后 ⇒ 全部完成。落在 1 之内（修复写盘失败）⇒ 内存已终态、磁盘 pending ⇒ 再 reload 再走一次步骤 1，幂等。
- **旧栈 verdict 晚到**：步骤 0 的 frozen 检查；V 段本身也先查 frozen。
- **put 抛错回退占位**：`pi-outbox-store.ts:30-52` 抛错 ⇒ cache 已回滚 ⇒ 磁盘无此记录 ⇒ 回退集合成员是安全的（不会出现"磁盘有、集合无"）。

### 9.3 死信自身的终态（缺口 8b）

| 情形                                   | 落点                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 生成被抑制（quota 满 / sender gone）   | **不生成记录**；原记录 `deadLetter.status = suppressed_*`（§9.2 步骤 4）—— 这就是最终审计态                             |
| 死信记录投递中 sender 变 gone（P2/V4） | → `dropped`（terminalReason "dead_letter_undeliverable"）；**不再生成死信**（kind==="dead_letter" 在 I-F11 义务函数外） |
| 死信 attempts 耗尽 / TTL               | → `dropped` / `abandoned`，同上不再死信                                                                                 |
| 死信 delivered                         | → `delivered`                                                                                                           |

### 9.4 聚合规则

聚合单位 = **一次 pump 中同一 gone 目标的 P2 批**，按 `from` 分组，每组一条死信（≤5 keys + omittedCount）。P2 只处理 `pending`，该目标此刻若有 1 条 claimed（I-F10 ⇒ 至多 1 条）待 verdict，它走 V4 单条生成 ⇒ 每个 reap 事件最多产生 `sender 数 + 1` 条死信，且每条都受 §9.1 配额约束。

## 10. Route B 竞态语义（v4：settle × claimed 定案，reload 重复明示）

- **线性化点**：工具提交时的 `router.admit()`（同 v3）。
- **`onRunSettled(from)` 三动作**（缺口 5）：① `select(from===from ∧ kind==="progress" ∧ state==="pending")` → `consumed`("sender_settled")——**只碰 pending**（`transition(key,"pending","consumed")`，claimed 记录返回 undefined 被跳过）；② tree 登记 tombstone（此后 `targetState(from)==="gone"`）；③ `pump(from)` 扫描发往它的 pending（走 P2/§9.4）。
- **claimed progress 的迟到出口**：verdict 到达 → V1 则 delivered（临终进度照常送达，无害）；retryable 则 V2' → `consumed`，不再重试；permanent 则 V3/V4 → `dropped`（progress 无义务）。
- **claimed finding/directive**：与 settle 完全无关，按 V 段处理（admission 后与发送者生死解耦，I-F9）。
- **generation 递增（resume）**：同 v3。
- **shutdown/reload 的重复投递 —— 明示为 at-least-once 允许行为（缺口 8e）**：唯一来源 = 记录处于 `claimed`（内存态）时栈被 dispose，旧栈 sender 实际送达但 verdict 撞 frozen 被丢弃 ⇒ 磁盘 `pending` ⇒ 新栈重发。每次 dispose 对每个目标至多制造 1 条重复（I-F10）。接收侧通过 header 中的 `key/seq` 可识别重复；不做接收侧去重（fire-and-forget、无接收端状态）。集成测试 T17 固定此行为。

### 10.1 终态所有权矩阵（v5：重要 5 落点）

七方对一条记录在 `pending` / `claimed` 两个非终态上的合法动作。"—" = 不允许触碰（实现上为 `transition` 的 from 不匹配返回 undefined，或 frozen 返回 false，零副作用）。

| 参与方（触发点）                                 | 对 `pending` 记录                                                        | 对 `claimed` 记录                                                                                                | 写盘？                 |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| admission（`router.admit` ⑦ supersede）          | 同链路旧 progress → `consumed`                                           | —（并存，§8.3）                                                                                                  | 是                     |
| pump P 行（本实例）                              | P1→abandoned / P2→dropped（含 §9.2）/ P6→claimed（内存）                 | —                                                                                                                | P1/P2 是；P6 否（D17） |
| V 行（本实例，token 匹配）                       | —                                                                        | V1→delivered / V2'→consumed / V2→pending / V3、V4、V5→dropped；**V1 总是更新 link/root lastDeliveredAt**（§4.5） | 是                     |
| `onRunSettled(from)`                             | 该 sender 的 progress → `consumed`（只 pending，kind 过滤）              | —（claimed progress 由 V2' 处理；claimed finding/directive 不受影响）                                            | 是                     |
| freeze / dispose（本实例）                       | 不动（磁盘已是 pending）                                                 | 不动（内存态随实例消亡；磁盘是 pending）                                                                         | **否**                 |
| 旧实例 verdict（frozen 或 token 实例分量不匹配） | —                                                                        | —（V 段 stale 检查三条件任一失败即丢弃）                                                                         | **否**（I-F15）        |
| 新栈 reconcile（fold 后 `pump()`）               | 全部 pending（含旧栈 claimed 归一化而来）：所有权**归新栈**，按 P 行处理 | 不存在（fold 归一化）                                                                                            | 是                     |

三问明答：

1. **sender settled 后 V1 是否更新 `link.lastDeliveredAt`？** 是（§4.5 V1 段落）。链路历史服务于该链路上仍 pending 的 finding/directive 的排布；发送者 settle 只关闭 admission，不关闭链路。
2. **旧栈 frozen 后 verdict 是否允许写盘？** 否。三层各自独立充分：engine frozen（所有 mutator 拒绝）、token 实例分量不等、回调闭包只持旧 engine 引用。旧栈对 `pi.appendEntry` 的唯一通路是其 engine，故物理上零写入。
3. **新栈 reconcile 与旧 verdict 同记录的归属？** 归新栈。磁盘 pending 是唯一真相（D17），新栈 fold 后拥有它；旧 verdict 被丢弃。唯一可观测后果 = 旧栈实际送达 + 新栈重发 ⇒ 一次重复（at-least-once，§10/T17）。不存在两栈同时写同一记录的窗口，因为旧栈 freeze 严格先于新栈构造（`stack.ts:286-299` 顺序 + `index.ts:226-252` shutdown 顺序）。

## 11. 兼容路径（同 v2/v3）

## 12. MVP 切割（v4）

**MVP**：§4.1 envelope + §4.3 record + §4.4/4.5 六态状态机 + §4.6 engine（Stage A1）+ tree/router/throttle/mailbox（含 **v5** `boundedSend`/`claimToken`）+ 三 kind + 死信（§9，**v5** 修复分支）+ canMessage 默认 ["parent"] + `message_agent` + `fabric.*` **11 键**（steer 超时复用 `budget.steerMs`）+ context policy（含 display 探测 fallback）+ root ingress gate（含 **v5** R=0 语义）+ 全量审计 + §13 测试。
**后续迭代 / 非目标**：同 v3（digest、result 上 fabric、steer 重实现、Stage A2、list_agents/组播/daemon 等）。

## 13. 测试策略（v4 增补 + v5 增补，沿用编号，v4 新增标 ★，v5 新增标 ★★）

| 文件                                           | 用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/core/message.test.ts`                   | 同 v3；★`FabricRecord` 形状：rejected ⇒ state dropped ∧ attempts 0；deadLetter 只出现在 finding/directive 终态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/core/message-property.test.ts`          | 同 v3；★seeded 随机操作序列（admit/claim/verdict/settle/supersede/freeze/reload）下不变量：I-F10（每 key 同时 ≤1 在飞）、I-F11（义务函数 ⇔ 是否调用过 issueDeadLetter）、死信 ref.keys 全局无重复、rootInbox ≤ cap、seq 逐链路严格递增                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/delivery/engine.test.ts`                | ★`claim` 不写 store；★`transition` 非法 from 返回 undefined 且零副作用；★`annotate` 不改 state；★`freeze` 后全部 mutator 拒绝、get/select 正常；★store 抛错：put 不入内存并 rethrow，transition 内存先行 + degraded；★fold：claimed→pending 归一化 + updatedAt 取最新；★★`claim(key, token)` 把 token 写入内存记录、`memoryOnlyFields` 在 store.put/update 载荷中被剥离（断言 appendEntry 载荷无 claimToken）；★★fold 删除 claimToken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/fabric/tree.test.ts`                    | 同 v3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/fabric/router.test.ts`                  | 同 v3；★root cap：第 cap+1 条 to=root finding → `target_backpressure`，seq 消耗、不计 finding used；display progress 不占 cap；★死信维度：同一 sender 跨两次 reap 累计到 quota 后 suppressed_quota 且原记录带审计；不同 sender 各自独立；★§9.2 序：put 抛错 ⇒ 集合回退 ⇒ 下次重试成功且只一条；★supersede 只碰 pending（存在 claimed progress 时新 progress 与之并存）；★★**T-repair**（v5.1 三子用例）：预置 `dlRefs` 命中的 pending orig，调用 issue ⇒ 同一同步段内（无 await、检查在 issue 返回时）orig.state ∈ {dropped, abandoned} 按 reason、store.put 未被调用；(a) prior=issued ⇒ `deadLetter` = {reason, status:"issued", key: existingKey}；(b) prior=suppressed_quota ⇒ `deadLetter` = {reason, status:"suppressed_quota"}、**无 key 字段**；(c) prior=suppressed_sender_gone ⇒ 同 (b) 对应 status；★★**T-repair-retry**：repair 的 `transition` 触发 store.update 抛错 ⇒ 内存终态、磁盘 pending、degraded 记一条；以该磁盘快照重建新栈 ⇒ `dlRefs` 从 ref.keys 恢复 issued 项 ⇒ pump 再次进入 issue ⇒ 步骤 1 重入修复成功、磁盘 orig 终态、死信记录总数仍 1；★★`rootMinIntervalS=0`：admission 仍按 cap 拒绝第 C+1 条 |
| `tests/fabric/throttle.test.ts`                | ★三个重建公式各一组黄金用例（含无 delivered 记录 ⇒ 0）；★reload 松弛 "+1"：caps 翻转前后 rootNotBefore 计数集合变化；★★**T21 R=0 边界**：`rootMinIntervalMs=0` ⇒ `rootNotBefore ≡ 0`、`eligibleAt` 不含 root 项、C 条 to=root 记录可在同一 tick 全部 delivered；★★同一 caps 下 reload ⇒ rootNotBefore 重建值与 reload 前内存值相等（f=0）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/fabric/mailbox.test.ts`                 | §4.5 P/V 逐行；★T-claim：同一 tick 两次 `pump()` + 永不 resolve 的 sender ⇒ sender 调用 1 次；★V 段 stale：旧 epoch verdict 被丢弃；★V2'：claimed progress + onRunSettled + retryable verdict ⇒ consumed 且不重试；★per-target in-flight ≤1：两条到同目标的 finding 串行；★单定时器：pending 集合变化时 wake 被重排且只有一个 timer（FakeClock.pendingTimers===1）；★dispose：freeze 后在飞 verdict 无副作用；★P2 聚合：一次 pump 内 N 条到 gone 目标、来自 2 个 sender ⇒ 恰 2 条死信、ref.keys ≤5、omittedCount 正确；★★**T-timeout**：永不 resolve 的 `inject` + FakeClock 推进 `steerMs` ⇒ 恰一个 retryable verdict、attempts+1、record 回 pending、`inFlight` 释放、backoff 后再 claim；底层 promise 稍后 resolve ⇒ 零副作用；★★**T-token**：两个 mailbox 实例（不同 instanceId）在同一 store 快照上各自 fold，实例 A claim 后 freeze，用 A 的 token 向 B 的 V 段投 verdict ⇒ 丢弃；用 B 自己的 token ⇒ 处理；★★dispose 清空 raceTimers（`FakeClock.pendingTimers===0`）                                                                                                                                                     |
| `tests/tools/message-agent-tool.test.ts`       | 同 v2；★三态返回形状与 `ok` 语义（ok:false 仍带 key/seq）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/service/runtime-adapter-fabric.test.ts` | 同 v2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/integration/fabric-wiring.test.ts`      | 同 v3（T7/T9/T10/T11/T12/shutdown 时序）；★**T17 at-least-once**：sender 在 claimed 期间 dispose 旧栈 → sender 稍后 resolve ok → 新栈从同一 outbox 快照恢复 → 断言目标共收到 2 次、磁盘最终 delivered 1 条、无死信；★★**T18'（v5 加强，建议 6 锚点）** reload 死信恰一次且 orig 修复：在 §9.2 步骤 3 后、4 前切栈（store 快照含死信、orig 仍 pending）⇒ 新栈 fold + pump 后：死信记录总数 1、store.put 未再被调用、**orig.state ∈ {dropped, abandoned}（不再 pending）**、`orig.deadLetter = {reason, status:"issued", key: 同一死信 key}`、后续 pump 不再产生任何写；★T19 root 有界：N=50 个 slotless nested sender 各发 1 条 finding to root ⇒ rejected ≥ 50-cap、任意 10s 窗内 sendMessage ≤ 2                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/adapters/pi-compat.test.ts`             | ★`canRenderEntries` 有/无 `registerEntryRenderer` 两态；`assertCompatible` 对其缺失不拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 14. 风险与开放问题（v4）

- R1 上下文膨胀：§8.5 由 root ingress gate 给出配置无关上界；digest 降噪留后续。
- R2 abort 在飞：§10。
- R3/R4/O1/O2/O3'：同 v3。
- （新）R5 root cap 的公平性：cap 满时先到先得，一个多产 sender 可能挤占他人的 root 名额。MVP 不做 per-sender 份额（会引入第二个维度的计数与重建）；发送者收到 `target_backpressure` 可自行退避。记为后续迭代候选。
- （新）R6 `claimed` 不落盘 ⇒ 每次 dispose 每目标 ≤1 条重复：已明示为 at-least-once 允许行为（§10/T17）。若未来需要 exactly-once，需要接收侧按 key 去重，这是接收端状态，与 fire-and-forget 原则冲突，不在本方案考虑。
- （v5 新）R7 `steerMs` 超时后的迟到成功不可观察 ⇒ 重复投递（§5.1）：与 R6 同一允许面。若目标 run 的 steer 队列持续 > steerMs 才消费，该目标会以 `maxAttempts` 次重复为上界后 dropped + 死信 —— 这是正确行为（目标事实上不可达），不是缺陷。
- （v5 新）R8 `rootMinIntervalS=0` 放弃速率项（D23）：配置者显式选择；`/agent settings` 描述文本须写明"0 = 不限速，仅背压"。

## 15. 实施顺序

同 v2 五步；第 2 步（engine）按 §4.6 API 实现（含 `claim(key, token)` / `memoryOnlyFields`）并先过 `tests/delivery/engine.test.ts`；第 3 步（fabric 三件）按 §8.0 pump / §5.1 boundedSend / §9.2 issue（v5 步骤 1）的伪码逐行落地；第 4 步接线清单：pi-outbox-store prefetch 参数、§6.4 五处编辑、spawn-service onSpawnEdge、onSnapshot 回调追加 pump hint、shutdown 插入点、settings 11 键（`rootMinIntervalS` 的 0 语义进 `SETTING_SPECS` 描述）、mailbox 读取 `settings.budget.steerMs`。

## 16. 三不变量的证明结构（评审核心，汇总）

### 证明前提（v5，建议 6）—— 每条前提对应一个可执行的测试锚点

| #   | 前提                                                                                                                              | 成立依据                                                         | 测试锚点（§13）                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A1  | JS 单线程；pump 的 select→claim→dispatch、admit ①–⑨、issueDeadLetter 0–5、V 段处理 各为**无 await 的同步段**                      | 编码纪律（I-F10/I-F13）；运行时无并行                            | T-claim（同 tick 两次 pump ⇒ 一次 send）；T-repair（issue 返回即终态） |
| A2  | `engine.claim` 是 `pending → claimed` 的**唯一**入口；`claimed` 不落盘                                                            | §4.6 API；D17；`allowed` 表中 pending→claimed 只经此函数         | engine.test：claim 不写 store；fold 归一化                             |
| A3  | **未 freeze** 的 mailbox 实例，每次 dispatch 在 ≤ `steerMs` 内恰产生一个**可消费** verdict；freeze 后的 dispatch 显式丢弃（v5.1） | §5.1 `boundedSend`（I-F14）；`Clock` 定时器；§5.5 dispose        | T-timeout；dispose 清 raceTimers                                       |
| A4  | `store.put` 抛错 ⇔ 未持久化；`transition`/`annotate` 写失败 ⇒ 磁盘只会**落后**于内存，不会超前                                    | `pi-outbox-store.ts:30-52` 回滚后 rethrow；§4.6 写失败语义       | engine.test：put 抛错不入内存；transition 内存先行                     |
| A5  | ref 查重命中与 orig 终态修复在同一同步段（I-F13）                                                                                 | §9.2 步骤 1                                                      | T-repair；T18'                                                         |
| A6  | `rootMinIntervalMs ∈ {0} ∪ [1000, ∞)`；R>0 时才宣称速率项（D23）                                                                  | §6.3 解析规则；§8.5                                              | T21；throttle 重建 f=0 用例                                            |
| A7  | 旧 mailbox 实例的 verdict 不触达新栈：engine frozen ∧ token 实例分量不等 ∧ 回调闭包只持旧引用（I-F15）                            | §4.6 claimToken；§5.5 dispose；`stack.ts:286-299` 旧栈先 dispose | T-token；dispose 清 raceTimers；T17                                    |

### ① 每条 admitted finding/directive 至少投递一次，或以带审计的死信义务终结（永不静默丢失）

- **持久化前置**（I-F9，§8.2 ⑧）：`ok:true` ⇔ 磁盘存在 `pending` 记录；put 失败即不承诺。
- **磁盘单向落后**（§4.6 写失败语义）：内存可以比磁盘"更前进"，反之不可能 ⇒ 任何崩溃/重载后磁盘状态 ≤ 真实进度 ⇒ 恢复只会多做（重发），不会少做。
- **可投递态唯一**（D17 + §4.7 fold）：磁盘上的非终态恒为 `pending`，reload 后一次 `pump()` 覆盖全部。
- **唤醒完备**（§8.0 表）：pending 停留的四种原因各有唤醒源；TTL 由单定时器兜底 ⇒ 每条 pending 记录在有限时间内必然离开 pending。**v5**：P4（目标在飞）的有限性由 A3 保证，不再引用 sender 契约。
- **离开 pending 的每条出边**（§4.4 表）要么到 `delivered`（投递成功 ≥1 次），要么到 `claimed`（**≤ steerMs 内**必有 verdict 或 freeze，A3；freeze ⇒ 回到"磁盘 pending"分支），要么到 `dropped/abandoned`（I-F11：finding/directive 必经 `issueDeadLetter`，结果三态之一落在原记录 `deadLetter`），要么到 `consumed`（D20：只有 progress 能到达，finding/directive 无此出边——`onRunSettled` 与 supersede 都按 kind 过滤）。
- **v5 修复分支不构成活锁**（A5）：reload 后 `dlRefs` 命中的 orig 在下一次 issue 的步骤 1 就转终态；v4 的 annotate-only 会让它每次 pump 都回到同一分支（永久 pending），这正是阻断 1，现已关闭。
- 故：admitted finding/directive 的终局 ∈ {delivered, dropped/abandoned ∧ deadLetter 已写}。∎

### ② 一条原始消息至多生成一条死信

- **栈内**：§4.5 P/V 两段各按序 first-match、在不同状态上求值、终态无出边 ⇒ 每条 orig 至多一次进入 `issueDeadLetter`（§4.5 互斥性）。
- **同步段内**：§9.2 步骤 1–4 无 await；步骤 2 在 I/O 前占位 ⇒ 不存在第二个观察到"未占位"的调用者。
- **跨 reload**（A5）：步骤 3（死信 put）先于步骤 4（orig 终态）；`dlRefs` 从磁盘 `ref.keys` 重建（§4.7）⇒ 任一切点下，新栈要么看到"死信已在映射"（步骤 1 同段修复 orig 终态、按 outcome 写 deadLetter，**不** put），要么看到"什么都没发生"（从头一次）。**v5.1**：suppressed 项不会导致 put（不重评配额），issued 项只写回已有 key ⇒ 修复分支在任何 outcome 下都不新增死信。
- **旧栈残留**（A7）：freeze 后 §9.2 步骤 0 与 V 段 stale 检查（frozen / claimToken 实例分量）双重拒绝；旧实例对持久化介质零写入（I-F15）。
- **put 失败**：抛错 ⇒ 未持久化（`pi-outbox-store.ts:30-52`）⇒ 回退占位安全。
- **死信不再死信**：§9.3，kind==="dead_letter" 在 I-F11 义务函数之外。∎

### ③ root LLM context 的速率与总量有真实上界

- **上界与 sender 数无关**是必要条件（§0.3 三条核实证明 sender 数无配置无关上界）⇒ 上界必须由目标侧计数器给出（D18）。
- **瞬时积压 ≤ `rootInboxCap`（单 stack 生命周期内，v5.1）**：栈内唯一增点 = admission ⑧，被同一同步段的 ④ 守卫（§8.5-1）；`claimed` 计入计数，故 claim/V1 之间的 microtask 边界不影响 cap 安全性。跨 stack 的重计数与翻转语义见 §8.5-4'。
- **速率 ≤ ⌈W/R⌉+1+f（仅 R>0，A6）**：**v5.1 改基**——归纳于单 root in-flight gate：claim 时 `inFlight.set(root)`（P6）⇒ P4 阻止同目标并发 claim ⇒ V1 先写 `rootLastDeliveredAt` 再由 V∗ 释放 inFlight（同一同步段，A1）⇒ 下一次 claim 需过 P5 `now ≥ t_i + R` ⇒ 相邻 delivered 间隔 ≥ R（§8.5-2）。不依赖 root send 的同步性。R=0 时本条不宣称，只保留逐 stack 的瞬时 cap 与静默尾巴（D23/§8.5-4'）。
- **root 不接收 dead_letter、directive**（§8.5 (c)）；progress 默认 display ⇒ 默认配置下 root context 流量 = finding only。
- **reload 松弛量 f**（v5 精确化）：单次 reload 且 caps 未变 ⇒ f=0（`rootNotBefore` 精确重建）；每次 channel 推导翻转的 reload ⇒ +1；反复 reload/翻转 ⇒ f 线性累加（§8.5-2 如实说明）。**v5.1**：reload 对 root 亦可能引入 ≤1 条 at-least-once 重复（§4.7 在飞记录行），它是重发、非新 admission，仍受 P4/P5 约束，不改变上述界；R=0 时不宣称跨 stack 累计速率界（§8.5-4'）。
- **超额的处置是可见拒绝**（`target_backpressure`），不是静默丢 ⇒ 上界不以牺牲 ① 为代价。∎
