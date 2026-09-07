# Feishu 通知（合并版）

本包通过 `feishu-notify.ts` 注册 Feishu 通知扩展。配置文件仍为
`~/.pi/agent/feishu-notify.json`，也可使用 `FEISHU_WEBHOOK_URL` 和
`FEISHU_WEBHOOK_SECRET`。

## 触发方式

- 在任务输入中加入 `@notify` 或 `#notify`，只关注本次任务。
- `/watch` 切换会话级关注。
- 模型调用 `feishu_notify`，或使用 `/feishu-test` 验证 webhook。

## 后台门控

主扩展通过 `Symbol.for("pi-subagent:background-status")` 发布当前 session 的
后台 subagent 和后台 bash 数量。默认情况下，结果卡、subagent 汇总卡和空闲提醒
只有在两项均为零时才发送。结果卡与汇总卡在后台忙时暂存于内存，空闲后补发；达到
`backgroundDeferCapMs` 后会补发并在卡片中注明后台任务尚未结束。空闲提醒在忙时
直接丢弃，并在定时器触发时再次检查。

心跳卡、等待输入卡以及 `feishu_notify`、`/feishu-test`、`/watch` 等显式触发不受
后台门控影响。`bashJobs.autoBackgroundS` 为零时，后台 bash 计数为 `null`，该条件
按恒真处理。provider 缺失时受门控通知 fail-closed，并写入
`~/.pi/agent/feishu-notify.log`；豁免通知仍可发送。

可选配置：

```json
{
  "requireBackgroundIdle": true,
  "backgroundIdleRecheckMs": 5000,
  "backgroundDeferCapMs": 600000
}
```

defer 仅存于当前扩展实例内，reload、退出或切换 session 时未发送项会丢弃。

## 从独立包迁移

1. `pi uninstall @bluecake/pi-ask-user`，或从 pi packages 配置移除旧包。
2. 安装/升级 `pi-subagent`，启用其三个 `pi.extensions` 入口。
3. 原 `feishu-notify.json` 无需迁移；按需增加上面的门控设置。
4. 看到旧包冲突 warning 时，先移除旧包再执行 `/reload`。

独立 `pi-ask-user` 与合并版同时安装属于不支持的配置，因为同名工具、命令和事件
处理器可能重复注册并造成重复卡片。
