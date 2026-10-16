# P4 delivery report (dev:web-resume-p4)

All verification complete. Final report:

---

# P4 (web-resume conformance + docs) — 交付报告

## ⚠️ STOP 项：发现真实产品缺陷（C2 pin 红灯，未修产品代码，按指示 STOP 并报告）

**`__pick` 的唯一一次 `cmd_late` 在真实会话切换后永不上报** — 违反 plan §2.5 d「exactly one late result per armed ticket」。

- **复现**：真实 `pi --mode rpc` + 真实 socket `__list`/`__pick` → 切换本身完全成功（session 帧、re-bind、withSession 三重校验全部完成），但 `cmd_late` 永不到达（C2 测试 15s 超时，确定性复现 3 次）。
- **根因**（在 pi 1.2.0 上逐句插桩定位，插桩已全部还原、`git diff src/...agent/{resume-exec,commands,index}.ts` 为空）：
  `resume-exec.ts` finally → `sendLateFor` → `commands.ts:196 settleLate` → `deps.ledger.settle` ✓ → `deps.onChanged()`（`index.ts:878`）→ `publishStatus()` ✓ → `publishCtl()` ✓ → **`refreshStatusLine()`（`index.ts:657`）→ `readStatusTheme(ctx)`（`index.ts:1768`）→ 守卫 getter `ctx.ui` 抛出 `Error: This extension ctx is stale after session replacement or reload`**。首次激活的闭包 `ctx` 在 `ctx.switchSession` 后已失效；异常在 `deps.send(toLateFrame(…))` 之前中断 settleLate，并替换 `internalExecResume` 的返回。真实插桩输出（节选）：
  ```
  [RE-DBG] step c: switching → withSession enter → withSession id=<target> file=<target> → finally rejected=false → sendLateFor
  [CMD-DBG] settleLate enter → settleLate settled
  [IDX-DBG] onChanged begin → status done → ctl done
  [IDX-DBG] onChanged THREW: Error: This extension ctx is stale after session replacement or reload...
  ```
- **为何 P2 自测漏掉**：`tests/web-hub/agent/wiring-resume.test.ts` 的 `switchSession` 是假的（无真实 session replacement ⇒ ctx 从不失效）。`publishStatus`/`publishCtl` 内部有 `safe()` 包裹，唯独 `refreshStatusLine` 没有。
- **影响**：切换功能本身可用；仅 late 通道丢失（UI 的 switching 态 10s 超时收尾，ctl 项停在进行中）。已写入 `acceptance.md` 顶部与测试 C2 describe 注释。修复属产品代码（如 `refreshStatusLine` 的 stale-safe 化或 late 发送避开 onChanged），留给 dispatcher。

## 改动文件清单（绝对路径）

| 文件                                                                | 内容                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/home/bluecake/ai/pi-toolkit/tests/conformance/web-resume.test.ts` | **新增** — 真 pi 1.2 conformance：C1×4 + C2×1 + C3×1 + C4×1 + C5×2 = 9 测试（8 绿 1 红=产品缺陷 pin）。真 `AgentSession`/`AgentSessionRuntime`（`createAgentSessionRuntime` + `bindExtensions` commandContextActions + `setRebindSession`，镜像 rpc-mode 布线）、真 `SessionManager`、真 `pi --mode rpc` CLI 子进程 + 假 hub socket；模型全部用本地 fake runtime，零外网 |
| `/home/bluecake/ai/pi-toolkit/AGENTS.md`                            | session-nav 段落重写（D1 彻底隐藏规则、provenance 索引 + cache v2 及容量、残差、temp→real 映射）+ web-hub P2 段落新增 web resume 块（`resume.v1`、`__list`/`__pick`、同步 pick + 与 /new 共享 claim、执行点复验、D4/D5-a、W1/W2、「恢复」按钮）                                                                                                                          |
| `/home/bluecake/ai/pi-toolkit/docs/dev/web-resume/acceptance.md`    | **新增** — 真机验收清单 R1–R7：TUI /resume 过滤、web 入口/列表/切换/切回、busy 拒绝、D5-a 二次确认、手机 LAN、rpc 托管会话、兼容矩阵；含已知残差与上述产品缺陷的验收口径                                                                                                                                                                                                 |

产品代码零改动；`skills/**` 未触碰。

## C-pin 覆盖

| Pin        | 覆盖                       | 说明                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1         | ✅ 4 测试                  | idle 下 sendUserMessage 的 handler 同步前缀在调用返回前运行（F5）；streaming 中命令立即执行不入队（F5）；agent_settled 发射期内 defer（§2.5 step-7 "still armed" 窗口，顺序 `settled-return → cmd`）；真 runtime `ctx.switchSession` ⇒ `session_start(reason:resume, previousSessionFile)` + withSession 拿到目标 + 旧会话 `session_shutdown(resume, targetSessionFile)` |
| C2         | ✅ 实现，1 断言红=产品缺陷 | 真 rpc CLI：`__list`（真文件 gen，rows 含目标）→ `__pick` 同步 `completion:"async"` → 切换后新 session 帧带目标 id（这些断言全绿）→ `cmd_late` 等待红（缺陷 pin，见 STOP 项）。rpc-mode 基础设施无需 gap：rpc-spawn 的 launch 形状在本文件内复刻                                                                                                                         |
| C3         | ✅                         | 3 参 progress 两种形态（1st/10th/last 有 partials，中间 undefined）×13 文件；partial/final 行均带 temp 路径；异 cwd header 行在 partials 与 final 都被过滤（F4）                                                                                                                                                                                                         |
| C4         | ✅                         | 真 `PiSessionDriver` 子会话（line 2 = `subagent:child`，F3）+ 同目录真 main 会话带真 `subagent:run` mark；TUI `listRecentSessions` partials+final、web `createResumeList`(defaultResumeCore) gen 都不含子会话（D1）                                                                                                                                                      |
| C5         | ✅ 2 测试                  | open 级：missing path ⇒ 新 id、磁盘不动、append 才在**该路径**落文件且 header 为新 id；runtime 级：switch 到已删路径 `cancelled:false`、id ≠ 原、`session_start(resume)` —— `resume:mismatch` 的依据                                                                                                                                                                     |
| 文档化 gap | —                          | Vue UI 层（弹窗/按钮/横幅）无法在本 harness 驱动，属 P3 测试 + `acceptance.md` R1–R7 真机清单；rpc 模式无基础设施 gap                                                                                                                                                                                                                                                    |

## 自验（真实输出）

```
$ timeout 600 npx vitest run tests/conformance/web-resume.test.ts
 ❯ tests/conformance/web-resume.test.ts (9 tests | 1 failed) 27786ms
   × C2: ... exactly one cmd_late ok 21280ms → timeout waiting for cmd_late   ← 产品缺陷 pin（见上）
   ✓ C1 idle/streaming/settle-deferred/switchSession（4） ✓ C3 ✓ C4
   ✓ C5 open-level / runtime-level（2）
 Test Files  1 failed (1)      Tests  1 failed | 8 passed (9)

$ npm run test:conformance 选择确认：package.json:95 "vitest run tests/conformance" — 本文件在目录内（`npx vitest list` 列出全部 9 条）

$ timeout 300 npm run typecheck ; echo EXIT
TYPECHECK EXIT: 0   （tsc main + tsconfig.typecheck + vue-tsc 全过）

$ npx prettier --check tests/conformance/web-resume.test.ts AGENTS.md docs/dev/web-resume/acceptance.md
All matched files use Prettier code style!
```

未运行全量 `npm test`、未 commit、无 stash/全树 git 操作。

## 遗留问题 / 范围外发现

1. **产品缺陷（本包 STOP 项）**：见顶部 — `refreshStatusLine` stale ctx 抛错吞掉 resume 的 `cmd_late`。
2. **master 上既有破损（P1 遗留，非本包文件）**：`tests/integration/child-session-marker.test.ts` M5 仍在 import P1 已删除的 `collectSubagentMarks`/`markSubagentSessions` ⇒ `TypeError: collectSubagentMarks is not a function`（实测 4 passed / 1 failed）。全量 `npm test` 会红；需 P1 侧或后续包修。
3. **工作区他人改动**：`src/web-hub/ui/src/components/control/ContextRing.vue`（hover-peek，2026-10-16）非本包所为，未触碰。
4. P3 报告中的首屏预算超支（+561 B）仍待 dispatcher 裁定（非本包范围）。
