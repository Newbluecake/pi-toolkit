# `fabric-xs-inbox` web xsInbox 断言 flakes 修复报告

任务 #35 · L1 快车道 · 只改测试，不改 `src/**`。日期：2026-11-05。

## 根因（产品无缺陷）

`tests/integration/fabric-xs-inbox.test.ts` 原第 23 行：

```ts
const lastHubInbox = async (hub) => (await hubInbox(hub)).at(-1)?.xsInbox;
```

读的是 hub 收到的**所有 agent** 的最后一帧 status，而断言针对的是接收方 beta 自己的
`xsInbox.unread`。两台 agent 各自异步发布 status（attach、link live、首个 1 Hz tick 帧等），
发送方 alpha 的帧经常晚于 beta 那帧到达成为「最后一帧」，之后稳态再无帧，`until` 等满 12 s 抛
`timeout: web xsInbox 1`（实测约 1/8 概率）。`hubInbox` 本身已支持 agentKey 过滤参数却未被使用；
`fabric-xs-alias-v2.test.ts` 已有按 sessionId 查 agentKey 的惯例（`inspect` 的
`agents[].session.sessionId`）。

补充探测发现：beta 的 unread 帧（含 `xsInbox`）落地后的第一秒内仍可能有零星后续帧
（alpha 的 turn_end 帧等），靠 `until` 重试轮询「最后一帧」的断言既会 flakes、也无法作为
回归探针（去掉过滤后轮询仍可能碰巧等到 beta 帧 → 假绿，见下文变异验证第一轮）。

## 改动（仅 `tests/integration/fabric-xs-inbox.test.ts`）

1. **按接收方 agentKey 过滤**：新增 `agentKeyOf(hub, sessionId)`（沿用 alias-v2 的
   `agents[].session.sessionId` 惯例）；`hubInbox` 改为纯函数
   `(frames, agentKey) => frames.filter(f => f.key === agentKey)`，`lastHubInbox(hub, agentKey)`
   一律按接收方 key 过滤。三处调用（`web xsInbox 1`、`web xsInbox absent at 0`、reload 用例的
   `web retains after reload`）全部改为传 beta 的 key —— 清零断言现在真正检查 beta 自己
   turn 之后的帧不含 `xsInbox`（原实现用任意 agent 的帧判断，是假通过）。
2. **确定性回归断言**（修复前必红）：新增 `untilQuiet(hub)` —— 等到 hub 连续 500 ms 无任何
   新 status 帧（稳态）；确认 beta 过滤后的末帧已是 `unread === 1`；对发送方 alpha 单发一个
   `turn_end`（STATUS_EVENTS ⇒ 无条件 `publishStatus`，alpha 必出一帧）；在**同一次** inspect 里
   捕获帧序列（`snap`，无重试轮询可钻空子），断言：
   - 全局最后一帧是 alpha 的且无 `xsInbox`；
   - 按 beta key 过滤后的末帧 `unread === 1`。
     若 beta 在 alpha 帧之后又发帧（顺序不确定），显式抛错而非静默通过。

## 验证输出（真实日志）

- **连跑 10 次全绿**（`/tmp/xifix-1.log` … `/tmp/xifix-10.log`，总耗时 4m59s）：

  ```
  run 1 exit=0
  run 2 exit=0
  run 3 exit=0
  run 4 exit=0
  run 5 exit=0
  run 6 exit=0
  run 7 exit=0
  run 8 exit=0
  run 9 exit=0
  run 10 exit=0
  ```

- **变异验证**（`/tmp/xifix-mutant.log`）：把 `hubInbox` 临时改为忽略 key（`=> frames`），
  回归断言 5.3 s 内确定性变红（非 12 s 超时，直接断言失败）：

  ```
  × IBW unread inbox (real stacks) > exit 1 (receiver host): ... 5336ms
    → expected undefined to be 1 // Object.is equality
  Test Files  1 failed | 5 skipped
  ```

  注：第一版变异探针（`turn(a)` + `until` 轮询「最后一帧」）在未过滤时仍假绿——稳态前第一秒
  的零星帧让轮询碰巧等到 beta 帧；最终版改为「静默稳态 + 单次 inspect 捕获」后变异必红。

- `npx prettier --check tests/integration/fabric-xs-inbox.test.ts` →
  `All matched files use Prettier code style!`
- `npm run typecheck` → 通过（tsc ×2 + vue-tsc，无输出即无错误）。

## 遗留问题

无。未改 `src/**`、未改 helper、无 git 写操作。
