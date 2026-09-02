# delivery v2 — P3 实施方案：caller-ack 通知抑制（rev2）

> 权威依据：`architecture.md` §3（D3 五分支语义 + ack 调用点表）、§4（转移 #10/#11/#13）、§4.1、§5（M4/M12/M13/M15）、§6/§6.1（`ack()`/`Coalescer.cancel` 契约、settings 增量）、§8 P3 验收①–⑤、§9 不做清单 1/4/7、§11（O2/O3）。
> 基线 = HEAD `f3741a1`（P1 `918694c` + P2 `5e042ac` 已落地）。行号均按 HEAD 复核。
> rev2：评审打回修订——P0 ack 改 persist-first 次序、P1-1 `hasLiveWaiter` 改 `expectAck` 登记制、P1-2 `cancelBuffered` 必需化、P2 "timer 类型"措辞。
> P3 目标：调用方已同步拿到 outcome（前台 Agent execute 正常返回 / `get_subagent_result` 取到终态）时，**尚未发送**的通知不再发送；已发送不撤回；一切不确定 fail-open（§3）。

## 0. P2 后现状（本方案的挂点）

| 事实                                                                                                                                                                                                                                                                                                              | 位置                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `consume(key, by?)`：canonicalize → 排除 consumed/abandoned → `writeBack({state:"consumed"})`（抛错返回 false、内存不变）→ 改内存 + audit/notify。**只影响 reconcile 重投，不摘除任何在途发送**                                                                                                                   | `src/delivery/notifier.ts:270-285`                                                 |
| `attempt()` 首行已有 consumed guard → **backoff 定时器到期自动 no-op，无需取消 timer**                                                                                                                                                                                                                            | `notifier.ts:158-159`                                                              |
| `finalize` 对非 staged 记录走 "late" 分支：仅更新 payload **不发送** → ack 后 finalize 迟到天然安全（转移 #13）                                                                                                                                                                                                   | `notifier.ts:245-258`                                                              |
| `settleBatch(keys, ok)` 无状态检查：ok → 逐条 `settleDelivered`（**会覆盖 consumed → delivered**）；!ok → `settleFailed`                                                                                                                                                                                          | `notifier.ts:259-267`                                                              |
| `Coalescer.cancel(key)` 已存在（`buffered.delete`，幂等、不抛）；缓冲摘空后 flush no-op                                                                                                                                                                                                                           | `src/delivery/coalescer.ts:55-57,31-33`                                            |
| mark-first（P2 裁决 a）：`attempt` 先 `willBuffer` → `markBatched` 持久化 → 再 `send()`；全程同步单线程                                                                                                                                                                                                           | `notifier.ts:160-175`                                                              |
| sender 谓词-发送分离接线在 stack；coalescer 仅当 `coalesceWindowMs>0` 创建；`previousCoalescer?.dispose()` 重建模式                                                                                                                                                                                               | `src/stack.ts:207-232,86-89`                                                       |
| 消费点已就位：result-tool 两分支 `tryConsume`（get L102-104、wait L160）；`spawnAndWait` 的 `onOutcomeConsumed`（L383）                                                                                                                                                                                           | `src/tools/result-tool.ts:46-56`；`src/service/spawn-service.ts:60,383`            |
| 前台 M-B 路径 `progress.waitOutcome` → `spawn.waitOutcome` **不调 onOutcomeConsumed**——P1 遗留缺口，P3 一并补                                                                                                                                                                                                     | `src/index.ts:126,239`；`src/tools/agent-tool.ts:319`；`spawn-service.ts:389-415`  |
| **spawn 时序实证（P1-1）**：`spawn()` admission 段（`newRunId` L316 → `void start` L367）**全部同步、无 await**；`spawnAndWait` 在 spawn() 返回后才注册 waits（L377-379）→ 同步完成/config-failure 的 run enqueue 时 waiter 必不在，waits 启发式**不成立**（根因：runId 在 spawn() 内部生成，调用方无法提前注册） | `spawn-service.ts:316,367,370-388`                                                 |
| `finish()` 在 `runner.run()` 返回后执行（L189/211），正常/失败/异常三路径必经；waits Map 语义不动                                                                                                                                                                                                                 | `spawn-service.ts:81,108,151-152`                                                  |
| settings 平铺三处 + isFinite 钳制先例；`SETTING_SPECS` 白名单；Delivery 行已含 `staged=`/`batched=`                                                                                                                                                                                                               | `src/config/settings.ts:65-66,85-86,144-150`；`src/commands/status.ts:116-140,405` |
| notifier 无 dispose（backoff timer 不追踪，到期靠 consumed guard 自愈）；P1 未落 `policyHoldMs`/holds Map → ack 无需 clear hold timer                                                                                                                                                                             | `notifier.ts:51-72`                                                                |

## 1. 裁决汇总

### 裁决 1（ack 通道形状）：**新增 `Notifier.ack()`，persist-first 两步序**（rev2 P0 修正）

`consume` 保留不动（向后兼容）；三个调用点切到 `ack`。差异：consume 对 batched 记录是**错误**的（flush 照发且 `settleDelivered` 把 consumed 覆盖回 delivered，两头都错）。
**rev2 P0：次序由"先摘缓冲后写盘"改为 persist-first**——原次序下 update 抛错时缓冲已摘、盘面仍 batched、无任何机制再发 = 通知被抑制（违反 fail-open）。

```ts
// NotifierOptions 增量（rev2 P1-2：**必需依赖**，缺失即抛配置错误，删除可选语义；
// delivery 不 import coalescer（§7 ②）——由 stack 回调接线，同 willBuffer 模式）
cancelBuffered: (key: DeliveryKey) => void;
// createNotifier 构造首行校验：if (typeof options.cancelBuffered !== "function") throw new Error(
//   "createNotifier: cancelBuffered is required (delivery v2 P3)");
ack(runId: string, generation: number, by?: ConsumerIdentity): boolean; // Notifier 增量（§6 签名）
ack(runId, generation, by) { // 实现 ~30 行，紧邻 consume
  const k = deliveryKey(runId, generation);
  const record = state.get(k) ?? load().get(k);
  const s = record?.state ?? "pending";
  if (!record || ["consumed", "abandoned", "dropped"].includes(s)) return false; // §3 表末行
  try { writeBack(record, { state: "consumed" }); } // ① persist-first（转移 #10，M4）
  catch (e) { fail(k, `ack persist failed: ${...}`); return false; } // ①失败：内存不变、**缓冲不摘** → 照发 = 重复 ✓
  state.set(k, { ...record, state: "consumed" }); // 内存随盘面（先写盘后改内存，上批纪律）
  let cancelled = true;
  try { options.cancelBuffered(k); } // ② 摘除缓冲（仅 batched 有意义，其余态幂等）
  catch (e) { cancelled = false; fail(k, `cancelBuffered failed: ${...}`); }
  // ②失败：consumed 已持久化但缓冲残留 → flush 照发 → settleBatch(ok) → settleDelivered
  // 覆盖为 delivered = 重复方向 ✓（终态 delivered，重启不重投，无害）
  if (cancelled && ["staged", "pending", "batched"].includes(s)) suppressed++; // 裁决 5：两步均成功才计数（cancel 抛错实际会照发，计入则虚假）
  audit(k, "consumed", "acked");
  notify({ ...record, state: "consumed" }, "consumed");
  return true;
}
```

**两步失败矩阵（各自独立落在重复方向）**：

| ① update | ② cancel | 结果                                                                                                             |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| 抛错     | 未执行   | 返回 false、内存/盘面/缓冲全不变 → flush/backoff 照发 = **重复** ✓                                               |
| 成功     | 抛错     | 盘面 consumed、缓冲残留 → flush 照发 → `settleDelivered` 覆盖 → 终态 **delivered**（重启不重投）= **重复一次** ✓ |
| 成功     | 成功     | 抑制生效（唯一不发送路径）✓                                                                                      |

### 裁决 2（ackWindowMs）：**实现**，复用形态 = 第二个 coalescer 实例（ackHold）

**措辞精确化（rev2 P2）**：零新增 timer **类型**——复用 coalescer 组件与其 `clock.setTimer` 机制，运行时为**独立窗口实例**。与架构 O2 的关系：O2/不做清单 4 禁止的是与 `policyHoldMs` 合并为一个 timer、复用同一 timer 语义；ackHold 独立命名、独立实例、语义为 ack-or-timeout 释放，互不复用，符合 O2。§3 要求 `ackWindowMs` 独立命名、默认 0、"仅对有 caller 的 completed 生效"——全部满足。

- `stack.ts`：`const ackHold = settings.ackWindowMs > 0 ? createCoalescer({ clock: systemClock, windowMs: settings.ackWindowMs, maxBatch: settings.coalesceMaxBatch, send: (items) => items.forEach((i) => sendFormatted([i])), onSettled: (keys, ok) => notifier.settleBatch(keys, ok) }) : undefined;`
  **send 逐条 `sendFormatted([i])`**：ackHold 永不产 digest（`coalesceWindowMs=0` 的用户选择不被偷渡），单条文案与 immediate 逐字节一致；某条抛错 → 整批 `settleBatch(false)` → 已发者重投 = 重复方向（同 M6）。
- sender 路由（stack.ts 现 sender 处改）：
  ```ts
  const isAckHoldable = (p: DeliveryPayload) => isCoalescible(p) && spawnRef.current?.expectsAck(p.runId) === true;
  willBuffer: (p) => (coalescer !== undefined && isCoalescible(p)) || (ackHold !== undefined && isAckHoldable(p)),
  sendMessage: (p) => {
    if (coalescer && isCoalescible(p)) return coalescer.submit(p); // P2 优先：合并窗开启时抑制收益免费获得
    if (ackHold && isAckHoldable(p)) return ackHold.submit(p);
    sendFormatted([p]);
  },
  ```
  准入复用 `isCoalescible`（completed 且无降级、attempts=0、reconcileRound=0——§2 准入表同适用：失败类即使在前台也立即发）。
- 入 ackHold 的记录状态 = `batched`（持久化）→ 崩溃 = M11 语义（reconcile 转 pending 重投）✓；ack = 裁决 1 batched 分支 ✓。**无新状态、新持久化字段、新 reconcile 规则。**
- `cancelBuffered` 接线（必需）：`cancelBuffered: (key) => { coalescer?.cancel(key); ackHold?.cancel(key); }`（幂等 delete）。
- dispose：`previousAckHold` 复用 `previousCoalescer` 模式（stack.ts:51,86-89）；dispose flush → 窗口内记录全部发出 = fail-open ✓。
- settings：`ackWindowMs`（默认 **0**，钳制 [0,5_000]，isFinite）三处平铺 + `SETTING_SPECS` 白名单（§6 settings 增量逐字落地）。

### 裁决 3（"有 caller"判定，rev2 P1-1 修正）：**`expectAck` 登记制，废弃 waits 查询**

评审实证（§0）：spawnAndWait 在 spawn() 返回后才注册 waits，同步完成路径 enqueue 时 waiter 必不在 → waits 启发式对"最早完成的一批 run"系统性漏报。修正为登记制，时序由 spawn() 的同步 admission 段保证：

```ts
// core/types.ts:116 SpawnRequest 增量
expectAck?: boolean; // 调用方声明将以工具结果同步取走 outcome（前台路径）
// spawn-service.ts
const claimedRunIds = new Set<RunId>(); // 进程内、随 finish 清理；崩溃随进程消失，无持久化义务
// spawn()：newRunId（L316）之后、void start（L367）之前的同步段内（紧贴 L367 前一行）
if (req.expectAck) claimedRunIds.add(runId);
// —— 实证：L316→L367 之间无 await，登记先于 start() 的任何同步完成/settle/enqueue ✓
// finish()（L108-153）收尾：claimedRunIds.delete(outcome.runId);
// SpawnService 接口增量（替代 rev1 的 hasLiveWaiter；纯查询，service 不 import delivery ✓）
expectsAck: (runId: RunId) => boolean; // => claimedRunIds.has(runId)
```

- **设置点**：`spawnAndWait`（L370-388）内部 `service.spawn({ ...req, expectAck: true })`——所有 spawnAndWait 调用方自动覆盖；agent-tool M-B 分支的 `deps.spawn.spawn(...)`（agent-tool.ts:~291）显式传 `expectAck: true`。
- **清理**：`finish()` 删除（三退出路径必经，L189/211）；登记点紧贴 `void start`，其前的 admission 早退（`{error}` 返回）不会登记，无泄漏；嵌套 Agent（CC2 不发顶层通知）登记无害。
- **fail-open 双向**：误登记（声明后 turn abort 未 ack）= 白等 ≤ackWindowMs 后照发；漏登记（后台 run + `get_subagent_result`）= 立即发 = 现状。永不丢失。waits Map 语义完全不动；`query.wait` 轮询无注册点的留白结论不变。

### 裁决 4（spawn-service hook）：`onOutcomeConsumed` → `onOutcomeAcked` 语义升级，补 M-B 缺口

- `spawn-service.ts:60` deps 重命名 `onOutcomeAcked?: (outcome: RunOutcome) => void`；L383 调用点改名（位置不动 = spawnAndWait return 前最后一步，满足 §3"execute 正常解析前"近似）。
- `waitOutcome`（L389-415）：settled 三分支（fast-path / waiter resolve / timer-late）收敛为一个 `settle(outcome)` 出口，其中 `try { deps.onOutcomeAcked?.(outcome) } catch {}`——补 M-B 缺口；`kind:"pending"`（auto-backgrounded）不 ack：outcome 未交付 ✓。
- agent-tool 不加新 ack 调用点：前台两路径（progress → waitOutcome；否则 → spawnAndWait）已被两个 spawn-service 出口覆盖（M-B 仅增 `expectAck` 传参）。
- result-tool：`tryConsume` → `tryAck`（deps 换 `Pick<Notifier,"ack">`），两分支位置不动（L102-104、L160），try/catch 保留（M15）。
- stack.ts：`onOutcomeAcked: (outcome) => { try { notifier.ack(outcome.runId, outcome.diag.generation, { extensionOwner: "spawnAndWait" }); } catch {} }`。

### 裁决 5（观测）：轻量 suppressed 计数

notifier 模块内 `let suppressed = 0`，仅当 ack 命中未投递态（staged/pending/batched）**且两步均成功**（batched 分支：cancelBuffered 返回/完成后才递增，cancel 抛错时不计——实际会照发，计入则虚假）时递增；接口增 `readonly ackedSuppressions: number`（不进 `stats`——那是按当前态分布）。`commands/status.ts:405` Delivery 行末追加 `acked=<n>`；audit 的 `"acked"` 标注提供 per-key 轨迹。~5 行，§3 诚实声明的抑制率由此可观测。

## 2. ack 行为矩阵（§3 五分支落地 + 持久化/崩溃恢复）

| 记录状态                            | ack 行为                                                                                                                     | 持久化                          | 崩溃恢复                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `staged`（未 finalize）             | ① 写盘 consumed → ② cancel no-op；后续 finalize → "late" 分支仅更新 payload **不发送**（转移 #13）；无 hold timer 可清（§0） | 先写盘后改内存（转移 #10）      | 盘面 consumed → reconcile 排除（`notifier.ts:296`）✓               |
| `pending`（attempts=0，未发）       | 转 consumed；进程内实际不可达（enqueue 同步 attempt），仅跨重启窗口出现                                                      | 同上                            | 同上 ✓                                                             |
| `pending`（attempts>0，backoff 中） | 转 consumed；**不取消 timer**——到期 attempt 首行 guard 自动 no-op；已发过的那次不撤回                                        | 同上                            | 同上 ✓                                                             |
| `batched`（窗口内）                 | ① 写盘 consumed → ② `cancelBuffered` 摘除；flush 时缓冲已无此条                                                              | 同上                            | ack 前崩溃：盘面 batched → reconcile 重投（M11）；ack 后：不重投 ✓ |
| `delivered`                         | 只标 consumed，已发不撤回（M13）                                                                                             | 同上                            | reconcile 本就不重投 delivered ✓                                   |
| `dropped` / `abandoned` / 不存在    | 返回 false，无副作用（§3 表末行；consume 对 dropped 保持原样，两者语义就此分叉）                                             | 无                              | —                                                                  |
| ① update 抛错                       | 返回 false、内存不变、**缓冲不摘** → 照发 = 重复（M4 + rev2 P0）                                                             | 失败即无                        | 重复 ✓                                                             |
| ② cancel 抛错                       | 返回 true、盘面 consumed、缓冲残留 → flush 照发 → `settleDelivered` 覆盖 → 终态 delivered = 重复一次（rev2 P1-2）            | consumed →（flush 后）delivered | 终态 delivered，重启不重投 ✓                                       |
| ack 调用点自身抛错                  | try/catch → 不 ack → 照发（M15）                                                                                             | 无                              | —                                                                  |

**竞态（ack vs flush）**：全程同步单线程 + mark-first，三种交错全收敛：ack 先于 submit → 非 batched 走对应分支；窗口内 ack → cancel 同步摘除，flush 的 `items` 快照不含此条；ack 晚于 flush 的 `deps.send` 返回 → `settleBatch` 已在同一同步链内置 delivered → ack 只标 consumed（"send 返回与 settleBatch 之间"无可 await 点）。`settleBatch` **不加** consumed 跳过防御——②失败时靠它覆盖回 delivered 正是 rev2 的 fail-open 通道（裁决 1 矩阵第二行）。

## 3. 失败矩阵 P3 增量（§5 表上新增/确认行）

| ID                           | 故障 × 阶段                                                         | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4（重申）                   | `store.update` 抛错（ack ①）                                        | 返回 false、内存/缓冲不变 → 照发 = 重复 ✓（rev2 P0 后语义更强：缓冲也不摘）                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M15（重申）                  | ack 调用点抛错                                                      | try/catch → 照发 ✓                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M18                          | ack 与 flush 交错                                                   | §2 竞态：三窗口全收敛，无丢失无撤回 ✓                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M19                          | ack 后进程崩溃                                                      | consumed 已持久化 → reconcile 不重投 ✓                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M19b（调度裁决：已接受残余） | ack ①持久化成功后、②cancelBuffered 前崩溃（batched 缓冲随进程消失） | 盘面 consumed、通知未发 —— **与 P1 已接受的 consume 取舍同构**（notification-complement 评审 P1-9 定档：consume 对 pending 记录同样产生"consumed 但从未发送"，已作为已知取舍接受）。ack 语义 = 调用方已在 execute 解析前最后一步拿到 outcome，通知被抑制正是意图行为；危害成立需叠加 "harness 在 execute 解析后丢弃工具结果" × "恰在两步之间微秒级窗口崩溃"的复合 epsilon，best-effort 查询兑底（get_subagent_result / /agent status）仍在。不引入两阶段 ack-intent 持久化（保护的场景以 ack 自身错误为前提，属过度设计） |
| M20                          | ackHold 窗口内崩溃                                                  | 盘面 batched → reconcile 转 pending 重投 = 重复，同 M11 ✓                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M21                          | ackHold 逐条 send 中途抛错                                          | 整批 `settleBatch(false)` → 已发者重投 = 重复（同 M6）✓                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M22                          | expectAck 误/漏登记                                                 | 误 = 延迟 ≤ackWindowMs 后照发；漏 = 立即发现状；双向无丢失 ✓                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| M23（新）                    | `cancelBuffered` 抛错（ack ②）                                      | consumed 已持久化、缓冲残留 → flush 照发 → 终态 delivered = 重复一次；重启不重投 ✓                                                                                                                                                                                                                                                                                                                                                                                                                                        |

丢失集合 = {M1, M8, M17-residual, **M19b**}（M19b 与 P1 consume 取舍同类、同源、同兑底，非 P3 新引入的风险面——P1 的 consume 对 pending 记录在无崩溃时就是这个行为）；P3 其余新增行全部落"重复"或"有界延迟"。

## 4. 测试方案

单测（`tests/delivery/notifier.test.ts` 增补，FakeClock + MemoryOutboxStore，仿 P2 的 notifier+coalescer 组装）：

1. **ack 摘除 batched**：windowMs>0，enqueue completed → batched；ack → true、`cancelBuffered` 被调、advance 窗口后 send 0 次、记录 consumed、`ackedSuppressions===1`。
2. **ack 取消 pending backoff**：sender 首抛 → pending(attempts=1)；ack → true；advance 全部 backoff → send 停在 1。
3. **ack 晚于 send 不撤回**：failed 立即 send；ack → true、send 仍 1、状态 consumed、suppressed 不增。
4. **ack on staged**：enqueue(hold) → ack → consumed；finalize → `"late"`、send 0 次、payload 已更新。
5. **ack on dropped/abandoned/missing**：均 false、盘面不变。
6. **ack ① update 抛错 → 不摘缓冲照发（rev2 P0 回归）**：store.update 注入抛错 → ack 返回 false、内存仍 batched、**`cancelBuffered` 未被调**；advance 窗口 → flush 照发 1 次 → settleBatch → delivered。
7. **ack ② cancel 抛错 → flush 覆盖照发、终态 delivered（rev2 P1-2 回归）**：`cancelBuffered` 注入抛错 → ack 返回 true、盘面 consumed；advance 窗口 → flush 照发 1 次 → 终态 delivered；重建 notifier `reconcile(store.list())` → 0 重投。
8. **崩溃回放**：batched ack（①②俱成功）→ 新 notifier reconcile → 0 重投；对照组未 ack → 重投 1 条（M11）。
9. **cancelBuffered 必需化**：createNotifier 缺 `cancelBuffered` → 抛配置错误；既有测试构造点机械补 `cancelBuffered: () => {}`。
10. **纯后台无 ack 照发**：与 P2 逐字节一致（回归哨兵）。

ackWindowMs / expectAck（组装层 + 集成）：

11. expectsAck=true + ackWindowMs>0：enqueue completed → 进 ackHold（batched、不进主 coalescer）；ack → 0 发送；**对照**不 ack → advance ackWindowMs → 1 次单条 sendFormatted、文案与 immediate 逐字节相同、无 digest。
12. expectsAck=false → 立即发。
13. **expectAck 登记时序（rev2 P1-1 回归）**：fake runner 的 `run()` 同步返回 outcome，走 spawnAndWait → enqueue 发生时 `expectsAck(runId)` 已为 true → 进 ackHold 而非 immediate——直接锁定"spawn() 返回前登记"的同步序。
14. coalesceWindowMs>0 且 ackWindowMs>0：completed 优先进主 coalescer（P2 验收② 回归）。
15. ackWindowMs=0（默认）→ ackHold 不存在，行为与 P2 逐字节一致。
16. 端到端（`tests/integration/`）：前台 spawnAndWait 成功 + ackWindowMs>0 → `pi.sendMessage` 0 次、记录 consumed；=0 → 1 次（验收①②）；result-tool get 分支取终态 → ack 后重投放空（验收③）；update 抛错 → 照发（验收④）；后台 run 无 ack → 必达（验收⑤）。

## 5. 实施顺序

1. `src/delivery/notifier.ts`：`NotifierOptions.cancelBuffered`（必需 + 构造校验）、`Notifier.ack`（persist-first 两步）、`ackedSuppressions`（~40 行）。
2. `src/core/types.ts`：`SpawnRequest.expectAck?: boolean`（L116 处）。
3. `src/service/spawn-service.ts`：`claimedRunIds` + 登记（L367 前）+ finish 清理 + `expectsAck` 查询；`onOutcomeConsumed` → `onOutcomeAcked`（L60、L383）；spawnAndWait 传 `expectAck: true`；`waitOutcome` 收敛 `settle(outcome)` 出口并调 hook。
4. `src/tools/agent-tool.ts`：M-B 分支 spawn 传 `expectAck: true`（~L291）。
5. `src/tools/result-tool.ts`：`tryConsume` → `tryAck`（deps 换 `Pick<Notifier,"ack">`）。
6. `src/stack.ts`：`onOutcomeAcked` 接线；`ackHold` + sender 路由 + `cancelBuffered` 接线；`previousAckHold` dispose。
7. `src/config/settings.ts`：`ackWindowMs` 三处平铺（默认 0、[0,5_000]、isFinite）；`src/commands/status.ts`：`SETTING_SPECS` + Delivery 行 `acked=`。
8. 测试：§4 顺序 1→10 → 11→16。9. CHANGELOG 一行（P3 + 默认关）。

依赖方向自检（§7）：新逻辑落 `delivery/`（notifier）与组装层（stack）；coalescer.ts 零改动；service 只出纯查询 `expectsAck`，不 import delivery ✓；不做清单 1/4/7 全满足。

## 6. 验证命令

```bash
npm run typecheck
npx vitest run tests/delivery/notifier.test.ts                   # 单测 1–10
npx vitest run tests/delivery tests/service tests/integration    # 11–16 + 回归
npm test                                                         # 全量（P1/P2 验收用例不得回归）
npm run format:check
```

验收对照（§8 P3）：① 窗口>0 下前台成功返回 → 0 通知 + consumed(acked)（用例 11/13/16）；② 两窗口均 0 → 照发（用例 15/16）；③ ack 晚于 send → 只标 consumed 不撤回（用例 3）；④ update 抛错 → false + 不摘缓冲照发（用例 6/16）；⑤ 后台无 ack → 必达（用例 10/16）。
