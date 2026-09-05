# subagent-push → message fabric 实施方案（agent 间消息织网）· v3

> v3 = 第二轮评审"打回重做"后的定向修订。方向性问题已闭环（三层内核、树边路由、kind 分级、O3/O4/O5 关闭），
> 本轮全部是同文档内部不一致/协议定义缺口：7 个阻断项 + 3 个重要项 + 1 个建议项，全部接受并修订，处置见 §0.2。
> v1/v2 决策记录保留（§0.1），v3 变更点逐条标注。行号按当前 HEAD 复核（本轮新核实：spawn-service finish() 删边、
> emit_lifecycle 仅见于 finish()、pi-outbox-store 构造自扫、PiCapabilities 无 renderer 探测）。
> 与 `docs/dev/result-text-fix/` 完全独立。原有原则不变：fire-and-forget、限速必需、复用投递状态机语义、不中断主 agent 当前 turn。

## 0. 评审处置

### 0.1 决策留存表（v1→v2→v3）

| 决策                       | 历程                                     | 现状                                                                                                                 |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 统一 envelope              | v1 立；v2 加 via/channel                 | **v3 修订**：payload 保持 `{text}` 不变量，死信引用提升为顶层系统元数据 `ref`（§4.1）                                |
| 树边路由 + 核心直投        | v1 立；v2 树权威双源                     | **v3 修订**：双源改为"事件源 + 自持树"，spawn-service 删边语义不动（§7.0）                                           |
| kind 分级授权              | v1 立；v2 O4 关闭（仅直接 child）        | 维持                                                                                                                 |
| canMessage 默认 ["parent"] | v1 立；v2 effectiveCanMessage/configHash | 维持                                                                                                                 |
| deliveryKey 四段 branded   | v2 立（严格逐段校验）                    | **v3 补**：rejected 记录也分配正式 seq，无特殊 key 形态（§8.2）                                                      |
| QoS 逐链路                 | v1 立；v2 分级配额                       | **v3 修订**：findingQuota 定案为 finding 独立子配额（保底=上限合一），maxPerRun 只约束 progress（§8.2）              |
| 死信回投发送者             | v2 立（system/幂等/聚合/独立限额）       | **v3 补**：幂等集合来源改为 `envelope.ref.keys`（§9）；生成位置定案 router（§4.3 表）                                |
| Route B                    | v2 立（线性化点）                        | **v3 修订**：线性化点前移到工具提交时（throttle 不再持有 draft），settle 竞态语义重写（§10）                         |
| 接收侧双通道               | v2 立（deliverAs:"steer" 显式）          | **v3 补**：display 通道能力探测接入 PiCapabilities，fallback 不改持久化记录（§6.4）                                  |
| 兼容路径                   | v2 立                                    | 维持                                                                                                                 |
| D12 异步投递契约           | v2 立（独立异步 loop）                   | **v3 补**：完整 verdict→状态转移表（§4.3）                                                                           |
| D13 DeliveryEngine 分层    | v2 立                                    | 维持（Stage A1/A2 不变）                                                                                             |
| D14 分级配额               | v2 立                                    | **v3 修订**：模型重定义（§8.2）                                                                                      |
| D15 目标状态语义           | v2 立                                    | **v3 补**：flush 触发源 = onSnapshot 观察，三触发源去重规则（§8.0）；措辞修正为"三种 TargetState × 六种 status 映射" |
| —                          | —                                        | **v3 新增 D16**：root digest 合并窗**移出 MVP**，单 turn 有界性改由链路速率×并发上限论证（§8.5）                     |

### 0.2 本轮（v3）处置速查

| 项                           | 处置                                                                                                                                                        | 落点           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 阻断1 payload 类型矛盾       | 选"顶层系统元数据"：envelope 加可选 `ref:{keys,omittedCount}`，payload 恒 `{text}`                                                                          | §4.1           |
| 阻断2 pending_start 无触发源 | 选 **onSnapshot 观察**（`SpawnServiceDeps.onSnapshot` 已存在，`stack.ts` 的 announcedStarts 是先例）；三触发源去重 = 触发仅作 hint、pump 以 engine 状态为准 | §8.0           |
| 阻断3 verdict 转移表不全     | 补齐完整 transfer table（含 attempts 耗尽、TTL 优先、backoff 复查、policy 无死信、死信生成在 router）                                                       | §4.3           |
| 阻断4 tree 权威矛盾          | 定案：新增 `onSpawnEdge` hook（纯增量），fabric tree **自持** append-only 边表为唯一运行期权威；spawn-service 的 finish() 删边不动                          | §7.0           |
| 阻断5 finding 配额不自洽     | seq 覆盖 admitted+rejected；findingQuota=finding 独立子配额；maxPerRun 只约束 progress                                                                      | §8.2           |
| 阻断6 throttle 与线性化冲突  | 采纳推荐项①：工具提交时即完成授权/配额/seq/持久化；throttle 退化为 per-link `notBefore` bookkeeping，不持 draft                                             | §8.2/§10       |
| 阻断7 root digest 归属矛盾   | digest 移出 MVP（删 `fabric.rootDigestWindowS`）；单 turn 有界靠 链路速率 × concurrencyLimit × 子配额 论证                                                  | §8.5/§12       |
| 重要8 renderer 探测          | `PiCapabilities.canRenderEntries` 结构探测；activate 时注册一次；fallback 纯发送期推导，不改持久化记录                                                      | §6.4           |
| 重要9 措辞/时序/双扫描       | "三 TargetState × 六 status"；shutdown 时 dispose 位置定案（rpc.close 后、stop runs 前）；prefetch 共享单扫描落地为构造参数                                 | §5.5/§8.0/§4.5 |
| 重要10 via.hops 编码         | 方向=sender→recipient，含两端点，root 字面量，system 不出现（死信 via 省略）                                                                                | §4.1           |
| 建议11 属性测试修正          | 包装断言只测 formatter 返回的固定 header 段；seq 单调断言改测 router.admit 输出                                                                             | §13            |

## 1. 背景与现状核实

（v2 §1 全部保留；本轮新核实项：）

| 事实                                                                                              | 位置                                                    | 影响                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `LifecycleEvent` 仅在 `finish()` 发出（终态），enter(running) 无事件                              | `core/state-machine.ts:272,289`                         | 阻断 2：pending_start 的 flush 不能依赖 lifecycle "running" 事件 |
| `SpawnServiceDeps.onSnapshot` 已存在且 stack.ts 已用它做 startedAt 观察（M-D announcedStarts）    | `service/spawn-service.ts:57`；`stack.ts` onSnapshot 块 | 阻断 2：onSnapshot 观察 = 零状态机改动的现成触发源               |
| spawn-service `finish()` **删除** parentOf/childrenOf 边                                          | `service/spawn-service.ts:110-121`                      | 阻断 4：v2 "内存边终身不变"错误；边只能由 fabric tree 自持       |
| `SpawnServiceDeps` 无 onSpawnEdge（有 onSnapshot/onLifecycle/onLabel 先例）                       | `service/spawn-service.ts:53-75`                        | 阻断 4：hook 是纯增量字段                                        |
| `createPiOutboxStore` 构造函数自扫 `getEntries()`                                                 | `adapters/pi-outbox-store.ts:21-29`                     | 重要 9：双扫描预防必须落成构造参数                               |
| `PiCapabilities` 为结构探测模型（canSendMessage/canAppendEntry/…），无 renderer 探测              | `adapters/pi-compat.ts:16-40`                           | 重要 8：`canRenderEntries` 照此模式增加                          |
| shutdown 时序：fleetWidget.dispose → scheduler.stop → rpc.close → stop runs → waitAll → bash kill | `index.ts:226-252`                                      | 重要 9：fabric dispose 插入点定案（§5.5）                        |

## 2. 术语与不变量

节点 = run / `"root"` / `"system"`。链路 = `(from, to, generation)`。I-F1..I-F8 同 v2（fire-and-forget / 树边可达 / 平级即数据 / 头部原则 / key 空间不相交 / 全量审计 / 授权路径≠投递路径 / 审计是 MVP 不变量），新增：

- I-F9 **admission 即承诺**：消息在工具提交的同步段内完成授权/配额/seq/持久化（§10）；此后投递与发送者生死解耦。限速只延迟 delivery，永不延迟 admission（阻断 6）。

## 3. v3 设计决策总览

D1–D15 见 §0.1；新增 **D16：root digest 移出 MVP**（§8.5）。其余结构（新文件清单、注入四件套、配置键、测试矩阵）同 v2 并按下文修订。

## 4. 协议设计

### 4.1 envelope（`src/core/message.ts`；v3：阻断 1 + 重要 10）

```ts
export type NodeRef = RunId | "root" | "system";
export type MessageKind = "progress" | "finding" | "directive" | "result" | "dead_letter";
export type MessageChannel = "context" | "display"; // 推导值（§6.4），不落 envelope
export interface MessageEnvelope {
  key: MessageKey; // branded，§4.2
  from: NodeRef; // 普通消息恒为发送 run（host 钉死）；dead_letter 恒 "system"
  to: NodeRef;
  kind: MessageKind;
  seq: number; // 逐链路单调； admitted+rejected 都消耗 seq（§8.2）；system 链路=(system,to,0)
  generation: Generation; // 发送者 generation；system 恒 0
  payload: { text: string }; // I-F4 头部原则：恒为此形，无判别联合（v3 阻断 1 定案）
  /**
   * v3：死信的系统元数据，仅 kind="dead_letter" 时出现；普通消息恒缺席。
   * 单条死信 keys.length===1；聚合死信 keys.length≤5 且 omittedCount 记录超出部分。
   * 幂等查重集合 = 全部已持久化死信记录的 ref.keys 并集（§4.5③/§9）。
   */
  ref?: { keys: MessageKey[]; omittedCount: number };
  /**
   * v3（重要 10）：授权路径审计。仅 from 为 run 时存在（死信省略）。
   * hops = 从 sender 到 recipient 的有序节点序列，**含两个端点**，方向恒为 sender→…→recipient
   * （上行段到 LCA 后接下行段，折叠为单一数组）；root 以字面量 "root" 出现；
   * "system" 永不出现在 hops。例：直发 parent → [from,to]；sibling → [from,parent,to]；
   * to=root 的深层节点 → [from,parent,…,"root"]。lca = 该路径的最近公共祖先（直发时=parent）。
   */
  via?: { lca: NodeRef; hops: NodeRef[] };
  ttlMs: number;
  createdAt: Millis;
}
```

kind 持久化兼容与 "digest" 命名隔离同 v2（独立 store 无旧记录；合并时 "kind 缺席 ≡ result"；digest 只属于 sendMessage details 包装层）。

### 4.2 deliveryKey（同 v2 §4.2，一处修订）

branded `MessageKey`、`messageKey/parseMessageKey/isMessageKey` 严格逐段校验、双 store 实例隔离、`delivery-key.ts` 不动、stack 占用扫描改显式 `filter` —— 全部维持。**修订**：v2 未覆盖的 rejected 记录现在与 admitted 记录共用同一 key 规则（消耗正式 seq，§8.2），不存在 "r 前缀" 等特殊形态，`parseMessageKey` 无需任何例外分支。

### 4.3 异步投递契约（v3：阻断 3，完整 transfer table）

异步 loop 与 `AsyncSender` 三值 verdict 维持 v2（§0.1 D12）。补齐完整状态转移表 —— **mailbox 每次 pump 一条 record 时按此表执行**：

| #   | 条件（按序判定，先匹配先生效）                                           | 转移                                         | 后续                                                                                        |
| --- | ------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `now - createdAt > record.ttlMs`（发送前必查，优先于一切）               | → `abandoned`（audit "ttl expired"）         | progress：结束；finding/directive：生成死信（reason "ttl_expired"）                         |
| 2   | `targetState(to)` 重查 = gone（每次 attempt 前必查，backoff 到期也复查） | → `consumed`（audit "dead-lettered"）        | 回调 `router.onPermanentFailure(record,"target_gone")` 生成死信                             |
| 3   | verdict = `{ok:true}`                                                    | → `delivered`（attempts+1）                  | 链路 `lastDeliveredAt=now`（notBefore 基准）                                                |
| 4   | verdict = retryable 且 attempts+1 < maxAttempts                          | → `pending`（attempts+1）+ backoff 定时器    | backoff 到期回到本表第 1 行重新判定                                                         |
| 5   | verdict = retryable 且 attempts+1 ≥ maxAttempts                          | → `dropped`（audit "attempts exhausted"）    | progress：结束；finding/directive：回调 router 生成死信（reason "attempts_exhausted"）      |
| 6   | verdict = permanent `target_gone`                                        | 同第 2 行                                    | 同第 2 行                                                                                   |
| 7   | verdict = permanent `policy`                                             | → `dropped`（audit "policy" + console.warn） | **不生成死信**（授权在 admission 已判定，发送期 policy 失败纯属防御分支，不是可投递性问题） |

定案要点：① **死信生成位置 = router**（`onPermanentFailure` 回调），mailbox 只做投递机械 —— router 独占树/审计/幂等集合；② TTL 优先于 backoff；③ backoff 到期复查 targetState（不复查 sender generation —— §10 定案旧 gen 继续投递）；④ progress 任何失败路径都不产死信（可丢 kind）；⑤ maxAttempts/backoffMs 数值复用 `deliveryAttempts`/`deliveryBackoffMs`。

### 4.4 DeliveryEngine 分层（同 v2，无修订）

`engine.ts` 纯同步内核（put/transition/get/reconcileScan/fold/stats）；Stage A1 内核仅 fabric 用、`notifier.ts` 一行不改；Stage A2 终态迁移独立 commit + contract snapshot 门禁。

### 4.5 outbox 运维（v3：重要 9 双扫描落地）

- **单扫描落地为接口**：`createPiOutboxStore(pi, customType = OUTBOX_CUSTOM_TYPE, prefetched?: readonly Entry[])` —— stack.ts 构建期自行 `getEntries()` 一次，同一快照传给两个 store 构造（传了 prefetched 则构造不再自扫；`pi-outbox-store.ts:21-29` 的自扫保留为默认路径，向后兼容）。
- supersede 保留原文、reload 恢复清单（lastSeq / 各 kind 已耗配额 / 死信幂等集合=全部 ref.keys 并集 / tree 边）、日志上界=配额封顶推论 —— 同 v2。**修订②**：配额用量 = admitted 记录计数（rejected 记录带 `rejected:true` 标志、**不计**用量，只占审计）。

## 5. 组件设计（文件级）

### 5.1 新文件（v3 修订）

| 文件                              | 职责                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/core/message.ts`             | envelope（§4.1 新形状）、key 函数、relation、`authorize()` 纯函数                               |
| `src/delivery/engine.ts`          | §4.4 内核                                                                                       |
| `src/fabric/tree.ts`              | **自持** append-only 边表（唯一运行期权威，§7.0）、relation/lca/hops、tombstone                 |
| `src/fabric/router.ts`            | admission 线性化点（§10）、配额计数、死信生成（`onPermanentFailure` 回调的宿主）                |
| `src/fabric/throttle.ts`          | **v3 瘦身**：不再持 draft 缓冲；只维护 per-link `notBefore`（下次可投递时刻）与 lastDeliveredAt |
| `src/fabric/mailbox.ts`           | 异步 delivery loop（§4.3 表）、supersede、pending_start 的 pump 调度（§8.0）、reconcile 驱动    |
| `src/tools/message-agent-tool.ts` | 注入工具（§6.1）                                                                                |

### 5.2 FabricPorts（v3：删 digest，无其他变化）

`inject` / `sendRootContext` / `sendRootDisplay` / `targetState` / `resolveHandle`，全部返回 `Promise<DeliveryVerdict>`（targetState/resolveHandle 同步）。**无 digest 接口**（阻断 7 定案）。

### 5.3 树注册表数据源（见 §7.0 v3 定案）

### 5.4 接收侧通道（同 v2：root context 显式 `deliverAs:"steer"` + `triggerTurn:true`；root display = appendEntry+renderer；run = runner.steer 的 verdict 化映射）

### 5.5 生命周期闭环（v3：重要 9 时序定案）

v2 表格维持，修订/新增两行：

| 场景                                     | 契约                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **session_shutdown 的 dispose 精确位置** | `index.ts:226-252` 时序中插在 **`rpc.close()` 之后、`query.stop()` 循环之前**。语义：先停 admission（router disposed → 工具调用抛 "shutting down"），再停 run —— 若反过来先停 run，drain 窗口内的 run 仍可向活着的 mailbox 提交消息，而它们的 session 正被拆除，投递语义不可定义。已 admitted 记录照常持久化留给下会话；在飞 verdict 丢弃（同 v2） |
| 双扫描预防                               | §4.5 的 prefetched 构造参数（不再是"旧栈先 dispose 所以不可能"的口头论证 —— 那只是时序论证，本行是接口级落地）                                                                                                                                                                                                                                     |

其余行（dispose 幂等、swap 顺序、在飞丢弃、不阻塞 drain、unref、reconcile 接入）同 v2。

## 6. 工具、门控与配置

### 6.1 `message_agent` 工具（同 v2：四态返回含 `quota_exhausted`；策略拒绝抛错；code-point 截断保头 75%/尾 25%；from 钉死）

### 6.2 策略门控（同 v2：`can_message` frontmatter、`effectiveCanMessage()` 统一入口、进 `configHashInput`、可信根特例明文）

### 6.3 配置块 `fabric.*`（v3：删 rootDigestWindowS，10 键 → 9 键）

| 存储键                   | 内部路径                 | 默认        | 说明                            |
| ------------------------ | ------------------------ | ----------- | ------------------------------- |
| `fabric.enabled`         | `fabric.enabled`         | `true`      | 总开关（灰度回滚路径）          |
| `fabric.minIntervalS`    | `fabric.minIntervalMs`   | `30`        | 逐链路最小投递间隔              |
| `fabric.maxPerRun`       | `fabric.maxPerRun`       | `20`        | **v3：仅约束 progress**（§8.2） |
| `fabric.findingQuota`    | `fabric.findingQuota`    | `10`        | finding 独立子配额              |
| `fabric.directiveQuota`  | `fabric.directiveQuota`  | `5`         | directive 独立子配额            |
| `fabric.deadLetterQuota` | `fabric.deadLetterQuota` | `5`         | 死信独立限额                    |
| `fabric.maxChars`        | `fabric.maxChars`        | `2000`      | 单条截断                        |
| `fabric.progressTtlS`    | `fabric.progressTtlMs`   | `900`       | progress reconcile TTL          |
| `fabric.progressChannel` | `fabric.progressChannel` | `"display"` | progress→root 通道（§6.4）      |

内部 `*Ms` / 存储 `*S` 约定、`TIME_SETTING_MS_PATHS` 追加、`parseFabricSettings` 逐字段容错、`SETTING_SPECS` 登记 —— 同 v2。

### 6.4 display 通道能力探测（v3：重要 8）

- `PiCapabilities` 增加 `canRenderEntries: boolean`（`pi-compat.ts:16-40` 的结构探测模式：`typeof pi.registerEntryRenderer === "function"`；版本字符串只进 WARN 文本，不作 gate —— 该文件既有纪律 I14 照守）。
- **启动必需性**：非必需。`canRenderEntries=false` → 仅 WARN + 该 capability 置假，扩展继续工作（与 `canReadBackEntries` 缺失时降级 in-memory 的先例同级）。
- **注册时机**：`registerEntryRenderer("subagent:progress", …)` 在 `activate()` 注册一次（与工具注册同点、同 HOST_KEY 守卫），不在每次 session_start 重复。
- **reload 后保留**：`/reload` 重导入模块 → 新 activate 重新注册（与工具一致）；pi 侧 renderer 表随扩展重注册刷新，无残留问题（同工具）。
- **fallback 不改持久化**：channel 是**发送期推导值**，不落 envelope（§4.1 无 channel 字段）：`effectiveChannel(env) = env.kind==="progress" && env.to==="root" && settings.progressChannel==="display" && caps.canRenderEntries ? "display" : "context"`。capability 翻转只影响后续发送，已持久化记录零改写。

### 6.5 注入点（同 v2 四件套；`finally` 调 `fabric.onRunSettled`）

## 7. 授权与路由

### 7.0 树权威（v3：阻断 4 定案）

- **唯一运行期权威 = `fabric/tree.ts` 的自持边表**（append-only，tombstone 单列）。事件源有两个：① 新增 `SpawnServiceDeps.onSpawnEdge?(child, parent)`（`spawn-service.ts:53-75` 的纯增量字段，`onLabel` 先例），在 admission 点同步触发 —— 先于任何 snapshot 持久化；② `/reload` 恢复时从 snapshot store 的 `RunSnapshot.parentRunId` 重放。
- **spawn-service 的 `finish()` 删边（`spawn-service.ts:110-121`）不动**：那两张内存表服务 CC1 `stopChildrenOf` 的"活跃子节点"语义，保留删边反而正确；fabric tree 与之彻底解耦（只接 hook，不读那两张表）。v2 "内存边终身不变"的论断作废。
- LCA 语义、reap 后 sibling 直投仍允许、tombstone TTL 基准（`settledAt + reconcileTtlMs`）、/reload 原子切换 —— 同 v2。

### 7.1 relation / via 计算（同 v2；via.hops 编码见 §4.1）

### 7.2 kind × 关系授权矩阵（同 v2：directive 仅直接 child；result 仅 parent；dead_letter 仅 system；可信根特例）

### 7.3 接收侧不可信声明（v3：建议 11 联动）

`formatFabricMessage(env)` 的返回形状改为 **`{ header: string; text: string }`**：header = 固定包装段（from/kind/seq/generation/关系/不可信声明），text = header + payload。属性测试只对 **header** 做词表断言（§13-T16），payload 是用户内容，不参与否定断言。

## 8. QoS / 限速 / 配额

### 8.0 目标状态语义（v3：阻断 2 + 重要 9 措辞）

三种 `TargetState` × 六种 status 映射（v2 "六态"措辞作废）：

| 目标 status                                                            | TargetState   | 投递行为                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| queued / starting                                                      | pending_start | record 保持 pending；**flush 触发源 = onSnapshot 观察**（定案，三选一之 b）：`SpawnServiceDeps.onSnapshot` 已在每次状态转移时触发（M-D announcedStarts 先例），mailbox 订阅后见目标 status==="running" 即 pump；零状态机改动。拒绝 (a) 新增 running lifecycle 事件（为旁路功能动核心状态机，违反 Route B 精神）；拒绝 (c) 有界轮询（snapshot 流已存在，轮询是冗余计时器） |
| running                                                                | running       | 发送（§4.3 表）                                                                                                                                                                                                                                                                                                                                                           |
| stopping / completed / failed / timed_out / aborted / 未知 / tombstone | gone          | 表第 2/6 行                                                                                                                                                                                                                                                                                                                                                               |

**三触发源去重**：onSnapshot / reconcile / （pending_start 等待超时的兜底一次性 timer）可能同时指向同一 record —— 触发**只是 hint**：三者统一调 `mailbox.pump(target?)`，pump 从 engine 重取可投递集（state==="pending" 且 `now>=notBefore` 且 TTL 未过），`engine.transition` 对非预期当前态返回 false —— 单线程下先到者转移成功，后到者空转。任何触发路径都不自带"我以为它 pending"的快照判断。

### 8.1 动机（同 v2）

### 8.2 分级配额与 admission 序（v3：阻断 5 + 阻断 6 定案）

**模型重定义**（v2 的"保底+共享池"表述作废）：

| 类别        | 规则                               | 说明                                                                                                                                                                        |
| ----------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| progress    | `progressUsed < maxPerRun`         | 弹性可丢 kind，独占 maxPerRun                                                                                                                                               |
| finding     | `findingUsed < findingQuota`       | **独立子配额：保底与上限合一** —— 对 progress 免疫（保底含义），超出即 `quota_exhausted`（上限含义）；与 maxPerRun 无交叉、无"是否允许超 maxPerRun"问题（maxPerRun 不管它） |
| directive   | `directiveUsed < directiveQuota`   | 独立子配额                                                                                                                                                                  |
| dead_letter | `deadLetterUsed < deadLetterQuota` | 系统侧独立限额                                                                                                                                                              |

- 单 run 上下文最坏注入 = `(maxPerRun 若 progress 走 context) + findingQuota + directiveQuota` 条 × maxChars；progress 默认 display 时实际为 `(findingQuota + directiveQuota) × maxChars`。
- **admission 序**（阻断 6 采纳推荐①）：工具提交 → `router.admit()` **同步段**：getRunState 校验发送者 running → relation/authorize → 配额判定 → **seq 分配（admitted 与 rejected 共用同一递增序列，rejected 也消耗 seq）** → via 计算 → `engine.put`（成功 `state:"pending"` + `notBefore`；配额拒绝的 finding `state:"dropped"` + `rejected:true` + audit "quota_exhausted"）。**rejected 记录的 key = 正式 `messageKey(from,to,gen,seq)`**（阻断 5：key/seq 规则零特例）。
- **throttle 瘦身后语义**：`notBefore = max(now, lastDeliveredAt + minIntervalMs)`；progress 的 latest-wins 由 **admission 时 supersede** 实现（同链路仍有 pending progress → 旧的 transition "consumed"/"superseded"），不再有任何未持久化 draft —— I-F8 审计覆盖每一次提交，包括被合并的。
- 由此 §10 的 settle 竞态简化：admission 之后发送者 settle 不影响投递（mailbox host 自持）；`onRunSettled` 只剩两个动作：① 该 sender 名下仍 pending 的 **progress** 全部 consume（audit "sender settled"，临终进度无意义）；② finding/directive 不动，继续按 §4.3 表投递。

### 8.3 supersede（同 v2；实现位置改为 router.admit 内，见 §8.2）

### 8.4 逐 kind context policy（同 v2；channel 推导见 §6.4）

### 8.5 预算模型（v3：阻断 7 定案 —— digest 移出 MVP）

**`fabric.rootDigestWindowS` 删除，FabricPorts 无 digest 接口，§12 的"root digest 合并"整体留在后续迭代。** MVP 单 turn 注入有界性论证（替代机制）：

1. 逐链路 minInterval（默认 30s）→ 单 sender 对 root 的 context 注入 ≤ 1 条/30s；
2. `concurrencyLimit`（默认 6）封顶并发 run 数 → root 的 context 注入速率 ≤ 6 条/30s；
3. finding/directive/dead_letter 各自被子配额封顶（单 run 生命周期内 ≤ findingQuota+directiveQuota+deadLetterQuota 条）；
4. progress 默认 display 通道，不占 context。

即：rate 有界（①×②）且总量有界（③④），单 turn 注入无需 digest 即收敛。digest 的价值是呈现层降噪，属后续迭代，与协议无关。

## 9. 死信（v3：ref 字段化 + 生成位置定案）

- from=`"system"`、固定不可执行标注、to=原发送者、按 reap 事件聚合（≤5 个 ref.keys + omittedCount）、`deadLetterQuota` 独立限额、发送者 gone 仅审计、死信不再死信 —— 同 v2。
- **v3 修订**：幂等查重集合 = 全部已持久化死信记录的 `ref.keys` 并集（§4.1 顶层字段），不再有 payload.refKey；生成位置 = **router**（mailbox 经 `onPermanentFailure` 回调上报，§4.3 表），router 在生成前查幂等集合，三触发路径（lifecycle gone 判定 / verdict permanent / attempts 耗尽 / TTL 过期）共享同一入口 `router.issueDeadLetter(orig, reason)`。

## 10. Route B 竞态语义（v3：阻断 6 联动重写）

- **线性化点前移到工具提交时**（§8.2 admission 序）；发送者非 running → 抛错，禁止 generation 回退容错。
- **settle 后已接受消息**：全部按 §4.3 表继续投递（finding/directive）；progress 由 `onRunSettled` 主动 consume（§8.2）。
- **generation 递增（X2 resume）**：旧 gen pending finding/directive 继续投递（to 未变；包装带 generation 供识别 seq 回退）；不迁移、不死信。
- **settle × timer 竞态**：瘦身后 throttle 无 draft timer；剩余竞态 = mailbox backoff/兜底 timer 触发时目标/发送者已变 —— 由 §4.3 表第 1/2 行的"每次 attempt 前重查"吸收。

## 11. 兼容路径（同 v2：steer 对照表 / 终态通知不动 / ack 唯一消费路径 / 可信根特例明文）

## 12. MVP 切割（v3）

**MVP**：envelope（§4.1 新形状）/tree/router/throttle（瘦身版）/mailbox/engine（Stage A1）+ 三 kind + 死信 + canMessage 默认 ["parent"] + `message_agent` + `fabric.*` 九键 + context policy（含 display 通道与能力探测 fallback）+ 全量审计 + §13 测试。
**后续迭代**：root digest 合并呈现（含 record 形状与失败拆分重试设计，本版刻意不定）；result 上 fabric；steer 重实现；Stage A2；生命周期 monitor 消息；富 payload；canMessage 词汇扩展。
**非目标**：同 v2（list_agents / 组播 / 堂兄弟寻址 / daemon / 阻塞 RPC / 跨会话 / 大状态）。

## 13. 测试策略（v3：建议 11 修正 + 本轮新增）

| 文件                                           | 用例（沿用 v2 编号，新增标 ★）                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/core/message.test.ts`                   | key 严格校验；`authorize()` 矩阵；★envelope 形状：普通消息 ref/via 缺席、死信 ref 形状、via.hops 含端点且方向正确、system 不入 hops                                                                                                                                                                          |
| `tests/core/message-property.test.ts`          | 属性测试（seeded PRNG）：★修正 —— 包装断言只测 formatter 返回的 **header 段**（含不可信标记、directive header 词表互斥），不断言 payload；★seq 单调断言改测 `router.admit()` 输出（admitted+rejected 混合序列逐链路严格递增）                                                                                |
| `tests/delivery/engine.test.ts`                | 同 v2（转移/持久化/fold/reconcileScan/存储抛错回滚）                                                                                                                                                                                                                                                         |
| `tests/delivery/notifier-contract.test.ts`     | 同 v2（终态 contract 黄金表）                                                                                                                                                                                                                                                                                |
| `tests/fabric/tree.test.ts`                    | ★onSpawnEdge 建边先于 snapshot；★spawn-service finish() 删边后 fabric tree 边仍在（解耦断言）；snapshot 恢复；tombstone TTL；LCA reap 后 sibling 直投                                                                                                                                                        |
| `tests/fabric/router.test.ts`                  | admission 线性化点；★rejected finding 消耗正式 seq 且落 `dropped`+`rejected:true`；★配额模型（progress/finding/directive/dead_letter 四池互不挤占，finding 满即 quota_exhausted 与 maxPerRun 无关）；★死信幂等（三触发路径各触发一次 → 仅一条死信）；聚合/限额；via 计算                                     |
| `tests/fabric/throttle.test.ts`                | ★重写为 notBefore bookkeeping：minInterval 推导、lastDeliveredAt 更新、无 draft 残留；code-point 截断（移至工具测试亦可）                                                                                                                                                                                    |
| `tests/fabric/mailbox.test.ts`                 | §4.3 表逐行（T5 扩展）：TTL 优先于 backoff、attempts 耗尽 → dropped+死信（finding）/仅 dropped（progress）、policy verdict 无死信、backoff 到期重查 targetState；★三 TargetState 映射（T6：pending_start 由 onSnapshot flush、gone 死信）；三触发源去重（pump 幂等）；dispose 后在飞 verdict 丢弃；supersede |
| `tests/tools/message-agent-tool.test.ts`       | 同 v2                                                                                                                                                                                                                                                                                                        |
| `tests/service/runtime-adapter-fabric.test.ts` | 同 v2（门控/共存/finally/注入安全 T15）                                                                                                                                                                                                                                                                      |
| `tests/integration/fabric-wiring.test.ts`      | 双栈切换（T10）；root 三态投递（T7）；settle×timer（T9）；★prefetch 单扫描（T11：getEntries 调用一次、两个 store 各自正确过滤 customType）；unref（T12）；★shutdown 时序：dispose 在 stop runs 前（dispose 后工具调用抛 shutting down、已 admitted 记录留存）                                                |
| `tests/adapters/pi-compat.test.ts`             | ★canRenderEntries 结构探测（有/无 registerEntryRenderer）；fallback 推导：capability 假 → progress→root 走 context 且持久化记录无 channel 字段                                                                                                                                                               |

## 14. 风险与开放问题（v3）

- R1 上下文膨胀：§8.5 四重有界论证（速率×并发×子配额×display 通道）；digest 降噪留后续。
- R2 abort 在飞：§10（admission 后解耦 + onRunSettled 两动作）。
- R3 directive 仅直接 child 的逐跳约束（O4 已关闭，从严）。
- R4 提示注入横向移动：header 双侧声明 + 属性测试词表断言（修正后只测 header）。
- O1 display 通道 pi 版本依赖：§6.4 探测 + fallback 已定案。
- O2 digest 跨链路排序：随 digest 整体移出 MVP，留待后续迭代定义。
- （新）O3'：`onSpawnEdge` 与 X2 resume 的交互 —— resume 不重走 spawn admission，边由 snapshot 恢复路径补建；若 resume 指定了新 parent（当前 X2 不支持改父），届时需补 hook。当前无该能力，记为监视项。

## 15. 实施顺序（同 v2 五步；第 4 步接线清单同步本轮修订：pi-outbox-store prefetch 参数、pi-compat 探测、spawn-service onSpawnEdge、shutdown 插入点）
