# 源码治理第二批 · ⑩-U 实施报告（gov/step10u）

> 基线 `dev@74703578`（2026-10-27 开工时的 worktree HEAD）。范围：`batch2-plan.md` §7.1 ——
> `password-client.js` / `token-client.js` 共用的 EventSource 生命周期抽成
> `ui/src/logic/transport-core.js`。**只去重，不做 TS 化**（D10-1）。

## 行数前后

| 文件                                               | 前（74703578） | 后   |
| -------------------------------------------------- | -------------- | ---- |
| `src/web-hub/ui/src/logic/token-client.js`         | 1998           | 1868 |
| `src/web-hub/ui/src/logic/password-client.js`      | 2474           | 2334 |
| `src/web-hub/ui/src/logic/transport-core.js`（新） | —              | 250  |
| 合计                                               | 4472           | 4452 |

## 提交列表

1. `9bb8b040` refactor(web-hub): extract the shared EventSource lifecycle into transport-core.js (token side)
   —— 新建 `transport-core.js`（WATCHDOG_TICK_MS / BACKOFF_MIN_MS / BACKOFF_MAX_MS /
   CONNECT_TIMEOUT_MS 四个移出的导出常量、私有 ES_CLOSED、`createTimer()`、
   `createStreamLifecycle(deps, hooks)`）；`token-client.js` 改为委托，token 差异经 hooks 注入
   （`onHello` 复位 `reloginUsed`、`onClosedError` 跑一次静默 relogin）；无兼容 re-export，
   `logic-client.test.ts` 的 `CONNECT_TIMEOUT_MS` 导入改指 `transport-core.js`。
2. `e7506f68` refactor(web-hub): move the password client's stream lifecycle onto transport-core.js
   —— `password-client.js` 删除重复的流机械（状态、timer、watchdog、退避重开、握手截止、
   openStream/closeStream、四个常量导出），改用 `createStreamLifecycle()`；password 差异留在本文件：
   `handleFrame`（`event: auth` 立即关流上报 revoked/expired，钩子位置 = 原 hello/onMessage 之前的内联分支）、
   `onClosedError`（`/api/session` 关闭探测，lan-plan.md §15.9 #8 —— 探测体留在本文件，因为它要用
   `request()`/`sleep()`，经 `currentIs`/`clearCurrent` 做取代守卫）；登录握手 / 2fa / logout 经
   `resetBackoff()`/`openStream()`/`closeStream()` 复位退避。`logic-client-password.test.ts` 的
   `BACKOFF_MIN_MS`/`CONNECT_TIMEOUT_MS` 导入改指 `transport-core.js`。

## 零行为证据

- **逐字移动**：`armWatchdog`/`scheduleReopen`/`openStream`/`closeStream`/握手截止定时器/帧解析管线
  原样进入 `createStreamLifecycle`，操作顺序不变；两个客户端原先的 `timer` 助手逐字相同，合并为
  `createTimer` 后两边（以及 lifecycle 内部）仍各持一份等价闭包。
- **unref 计数（I5）**：基线两客户端各 1 处真实 `t.unref()` 调用；现 `transport-core.js:49` 一处
  （`createTimer` 内），两个客户端的全部计时器仍经它包裹 —— 运行时每一处 timer 依然 unref。
- **唯一有意的顺序差异**：password `close()` 里 `stream.close()`（锁存 closed + 拆流）现在先于
  `abortWaitSession()`（原先 `closed=true → abort → closeStream`）。不可观测：abort 的效果只经
  wait loop 的异步续体显现，而续体的 cancelled 判定读到的都是已锁存的同一状态。
- **`opens++`** 现在对 password 流也递增，但只有 token 的 `stats()` 读它（password 的 `stats()` 仍只暴露
  `{open, backoff}`，形状不变）；token `stats()` 仍返回 `{opens, open, reloginUsed, backoff}`。
- **行为测试面**（§7.1 证据清单，全绿）：
  - `tests/web-hub/ui/{transport-contract,logic-contract,logic-client,logic-client-password,password-auth,logic-proxy,source-scan,hub-http-integration}.test.ts` —— 836 tests passed
    （含 transport-contract 的 375 条双模式 parity 用例与 hub-http-integration 的真 HTTP 端到端）；
  - `tests/web-hub/hub/{lan-auth,deadline-nesting}.test.ts` —— 同批全绿（deadline-nesting 仍从两个
    客户端文件导入 `CMD_REQUEST_TIMEOUT_MS`，未移动）；
  - `tests/web-hub/http/lan-password-client.test.ts`（真 LAN HTTP 驱动 `createPasswordClient`）——
    含在下面全量 tests/web-hub 中，绿。
- **全量**：`npx vitest run tests/web-hub --maxWorkers=3` —— 707 files / 15854 passed / 3 skipped / 0 failed。
- **构建门**：`npm run build:web` + `npm run check:web` —— ✓ dist OK（86 files，first-screen JS
  365981B gz/524288B，懒加载/mermaid/CSS 均在限内）。
- **真浏览器探针**：`npm run probe:csp` —— 实际运行（本地 Playwright + Chromium 1243 +
  Firefox 1543，离线），PASS：CSP-clean，P5 worker 在两种浏览器下均 OK。
- **类型**：`npm run typecheck`（TS7 ×2 + vue-tsc）每个提交后均通过。
- **格式**：`npm run format:check` 通过。
- **冻结面**：`git diff --quiet 74703578 -- tests/fixtures/` —— 空（本包不触碰任何 golden；
  新文件自动纳入 `source-scan.test.ts` 的 UI 扫描，无违禁模式）。

## 范围外未动（按 §7.1 边界）

- 端点层的重复（`request`/`errorOf`/`runErrorOf`/`uploadFromResponse`/`spawnFromResponse`/`wtdiffGet`/
  `avatar*`/`privacyPost`/`proxyPost` 等两客户端各一份）不在本节范围 —— §7.1 只点名 EventSource
  生命周期（看门狗、退避、重开、状态回调），这些继续保持「两个 transport 各自独立 +
  transport-contract.test.ts 钉 parity」的现状。
- `⑩-S`（`secure/bin/helper.mjs` 拆分）是另一个子包，不在本 worktree。

## 遗留

- 无功能遗留。文档层面：`password-client.js`/`token-client.js` 头注释里关于「两个 transport 是完全独立
  模块」的表述已就流生命周期部分改为指向 `transport-core.js`；端点层的同类表述仍然属实，未动。
