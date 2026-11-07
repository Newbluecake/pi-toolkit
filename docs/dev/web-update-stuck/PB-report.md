# #23 P-B（hub/protocol/agent caps）交付报告

> 依据：`docs/dev/web-update-stuck/plan.md`（r3）§2.2 D12–D14、§2.3 兼容口径、§3 P-B；根因见 `explore.md`。
> 本包只动 P-B:hub 文件域；P-A、#20（`src/fabric/xs/**`、`src/web-hub/agent/xs.ts`）的在途改动未触碰。

## 1 改动清单（绝对路径）

**src（3 个）**

| 文件                                                           | 决策 | 内容                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/version.ts` | D12  | `HOLD_*` 之后新增 `EPOCH_UP_CAP = "epoch.up.v1"`、`EPOCH_UP_AGENT_CAPS`；头注写明与 hold.v1 互补、agent 面专属、hub 不在任何 cap 面广播、默认 hello 不含、无新帧不 bump PROTO                                       |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/registry.ts`     | D14  | `epochRefresh = epochChanged && prevPhase !== "stale" && (caps ∋ HOLD_CAP ∨ caps ∋ EPOCH_UP_CAP)`；顺序不变（先 agent_up 后 gap），stale 分支仍只发一次；Y7.2 注释保留并追加 #23 段                                 |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts`      | D13  | 原 `capsExtra` 函数体改名 `baseCapsExtra()`；外层 `capsExtra = () => { const c=[...baseCapsExtra()]; if (!c.includes(HOLD_CAP)) c.push(...EPOCH_UP_AGENT_CAPS); return c; }` —— 只在缺 `hold.v1` 时**尾部唯一追加** |

**tests（6 个改动 + 1 新建 + 1 新 fixture）**

| 文件                                                                                                                | 内容                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/epoch-up-compat.test.ts`（新建）                                    | §2.3 compat golden 测试：真实 `createRegistry` + 真实 `createHttpFrontend`（经 `tests/web-hub/http/helpers.ts` 的 `fakeDeps`），真实 login/`/api/subscribe`/SSE，采集**总线 HubEvent 序列 + SSE 原文**（固定时钟 ⇒ SSE ring id 确定；clientId/端口归一化占位）。三场景 s1/s2/s3；`PI_TOOLKIT_EPOCH_UP_GOLDEN_CAPTURE=1` 录制且已存在时拒绝覆盖 |
| `/home/bluecake/ai/pi-toolkit/tests/fixtures/web-hub/epoch-up-compat-golden.json`（新建，P-B 唯一允许的新 fixture） | 在**未修改实现**上录制（见 §3）                                                                                                                                                                                                                                                                                                                |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/version.test.ts`                                               | 常量稳定：`EPOCH_UP_CAP === "epoch.up.v1"`、数组恒等、不含 hold.v1                                                                                                                                                                                                                                                                             |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/registry.test.ts`                                                   | 新增 #23 describe：claiming/live 下 epoch 变化 + `epoch.up.v1` ⇒ 先 agent_up（携带新 epoch **和新版本**）后 gap；stale ⇒ 只一次；同 epoch ⇒ 静默；双 cap 并存 ⇒ 仍只一次。新增 reap 窗口 describe（见 §4）                                                                                                                                     |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/caps-coexist.test.ts`                                               | 默认配置 + threads 组合两处断言：hub 两个 cap 面（`HubInfo.caps`/`hello_ack.caps`）都**不含** `epoch.up.v1`                                                                                                                                                                                                                                    |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-control.test.ts`                                           | 18 组合 runtx 矩阵声明式更新：`control=false` 行（hold.v1 缺席）追加 `epoch.up.v1`                                                                                                                                                                                                                                                             |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-hold.test.ts`                                              | 新增 D13 describe：`steerRecall:false` ⇒ hello 以 `epoch.up.v1` 结尾、仅一个、前缀与默认配置 caps 去 hold.v1 后逐项相等（「只在尾部追加、只多这一个」）；`control:false` 同理；默认配置不含该 cap                                                                                                                                              |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-private-ns.test.ts`                                        | **未改**（无精确 caps 数组断言，plan P-B §3「只在有精确数组断言时才改」）                                                                                                                                                                                                                                                                      |

## 2 第 0 步：golden 录制（先于任何 src 改动）

录制前核对 `git diff --stat` 确认三个 src 文件干净（输出为空 ⇒ 未修改）。录制命令与真实结果（`/tmp/pb-capture1.log`）：

```console
$ PI_TOOLKIT_EPOCH_UP_GOLDEN_CAPTURE=1 npx vitest run tests/web-hub/hub/epoch-up-compat.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

- 5 通过 = s1/s2 在**旧实现**上与刚写入的 golden 逐字节相等 + 确定性双跑相等。
- 1 失败 = `s3 (new hub × new agent)` 断言 agent_up→gap，旧实现只有 gap —— 这正是待引入的行为，失败即「行为尚未存在」的证据。
- 重复运行录制命令，golden md5 前后均为 `3c03a04e33af0684f330a7365edec813` ⇒ 拒绝覆盖生效。

golden 内容（每场景记 bus 事件序列 + SSE 原文）：

| 场景                                                    | 总线事件                  | SSE 帧                                                                                                                                          |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| s1 老 caps 无 hold（`["ev.v1","cmd.v1"]`，e-old→e-new） | `agent_up, gap`           | `hello, hub, agents, agent_up, history, gap`                                                                                                    |
| s2 老 caps 含 hold                                      | `agent_up, agent_up, gap` | `hello, hub, agents, agent_up, history, agent_up, gap`                                                                                          |
| s3 老 hub × 新 agent（尾部多 `epoch.up.v1`）            | `agent_up, gap, caps`     | `hello, hub, agents, agent_up, history, gap`（第二个 agent_up **不存在** ⇒ 老 hub 忽略新 cap；`caps` 事件只进 run-transcript 重校验，不进 SSE） |

## 3 兼容四组合证据（plan §2.3 逐项）

| 组合                  | 断言                                                                        | 证据                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 新 agent 默认 hello   | 字节与 A 级 golden 相同                                                     | 五份 A 级 golden 套件全绿（§5 门禁 2）；wiring-hold「默认配置不含该 cap」；D13 只在缺 hold.v1 时追加，五份 golden 的默认 hello 均含 hold.v1                                          |
| 新 agent 非默认 hello | 只在尾部追加 `epoch.up.v1`                                                  | wiring-hold D13 describe（尾部唯一追加 + 前缀逐项相等）；compat golden s3 的 secondCaps 即该形态                                                                                     |
| 老 hub × 新 agent     | 可观察输出与老 hub × 老 agent 相同（只 gap）；唯一差别是 hub 内部 caps 事件 | golden s3 存证（单 agent_up + gap + caps 总线事件、SSE 无第二个 agent_up）；P-B 附带在当前实现上把 s3 场景断言为 agent_up→gap（新 hub 行为），并存证测试钉住 golden s3 的老 hub 形态 |
| 新 hub × 老 agent     | 无两个 cap ⇒ 与改动前逐字节相同（只有 gap）；带 hold.v1 ⇒ 与改动前相同      | compat 测试 s1（无 cap：bus+SSE 与 golden 逐字节相等）、s2（hold：逐字节相等）在**改动后**实现上通过；同 epoch 静默由 registry #23 describe 钉住                                     |

**旧实现只读复验**（verifier 口径预演）：`git archive HEAD` 解至 `/tmp/pb-verify` + 软链 node_modules（只读，无 git 写操作），仅放入新测试与 golden，运行 `/tmp/pb-old-impl-recheck.log`：`1 failed | 5 passed (6)` —— s1/s2 在旧实现上与 golden 逐字节相等（即 golden 可由旧实现独立复现），唯一失败仍是那条「新行为」断言，与录制时一致。

改动后主树上 `npx vitest run tests/web-hub/hub/epoch-up-compat.test.ts` ⇒ `6 passed (6)`（`/tmp/pb-compat-after.log`）。

## 4 reap 窗口测试（plan 处置 #7 的 registry 层钉法）

`registry.test.ts` 新增 `post-reap re-registration keys` describe，全部使用 `register()` **实际返回的 key**，不预设是否换 key：

- **同进程同 identity**（同 pid+nonce）：claiming → stale → 60s reap（`agent_down`）后以新 epoch/新版本重新注册 ⇒ 返回 key 与旧 key **相同**、`reclaimed:false`（全新记录路径）、发全新 `agent_up`（带新 epoch 与新版本）。
- **新进程新 identity**（不同 pid+nonce）：reap 后顶上 ⇒ 返回**新** key；旧 key 随 `agent_down` 消失且不再回来。

（UI 层的「同 key 收敛 done / 新 key 保持 E_OFFLINE」闭环按 plan 归 P-C 的跨层测试。）

## 5 自验门禁（真实输出均 tee 至 /tmp，未截断）

| #   | 命令                                                                                                                                                                                                               | 结果                                                                                                                                                                                                                                                                                                                                                                                                        | 日志                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | `npx vitest run tests/web-hub/hub tests/web-hub/agent tests/web-hub/protocol tests/web-hub/boundary.test.ts tests/governance`                                                                                      | ✅ `Test Files 394 passed (394)` · `Tests 9426 passed \| 3 skipped (9429)` EXIT=0                                                                                                                                                                                                                                                                                                                           | `/tmp/pb-gate-final.log`                                                           |
| 1′  | 同上 + `tests/web-hub/http/sse.test.ts`（plan P-B §4 完整口径，prettier 收尾前跑）                                                                                                                                 | ✅ `395 passed (395)` · `9445 passed \| 3 skipped` EXIT=0（sse.test.ts 未受其后格式化影响）                                                                                                                                                                                                                                                                                                                 | `/tmp/pb-gate1.log`                                                                |
| 2   | `npx vitest run tests/integration/{thread-off,thread-rebind-off,fabric-xs-off,fabric-xs-reply-off,schedule-off}-golden.test.ts tests/integration/fabric-xs-channel-compat.test.ts tests/reload/activation.test.ts` | ✅ `Test Files 7 passed (7)` · `Tests 17 passed (17)` EXIT=0（五份 A 级 golden 逐字节原样通过）                                                                                                                                                                                                                                                                                                             | `/tmp/pb-gate2.log`                                                                |
| 3   | `npm run typecheck`                                                                                                                                                                                                | ⚠️ 共享树红：唯一报错 `src/fabric/xs/activate.ts(667,87) TS2339 'progressPhaseOf' does not exist` —— **#20 包在途改动**（root 已确认为其等待中的 facade 补丁，非本包文件；本包文件 0 报错）。**隔离验证**：`git archive HEAD` 解至 `/tmp/pb-verify`，仅叠加本包 3 个 src + 6 个测试文件后 `tsc --noEmit -p tsconfig.json` EXIT=0、`tsc --noEmit -p tsconfig.typecheck.json` EXIT=0（root 认可作为本包证据） | `/tmp/pb-typecheck2.log`、`/tmp/pb-tsc-isolated1.log`、`/tmp/pb-tsc-isolated2.log` |
| 4   | `npm run build`                                                                                                                                                                                                    | ⚠️ 同 #3 同一外部原因。**隔离验证**：同上树仅叠加本包 3 个 src 文件后 `tsc -p tsconfig.build.json` EXIT=0                                                                                                                                                                                                                                                                                                   | `/tmp/pb-build.log`、`/tmp/pb-build-isolated.log`                                  |
| 5   | `npx prettier --check`（全部改动文件）                                                                                                                                                                             | ✅ `All matched files use Prettier code style!`（4 个文件先经 `--write` 归一，golden 仅 JSON 排版变化、语义断言复跑全绿）                                                                                                                                                                                                                                                                                   | `/tmp/pb-prettier.log`                                                             |
| 6   | `git diff --quiet HEAD -- tests/fixtures/ ':!tests/fixtures/web-hub/epoch-up-compat-golden.json'`                                                                                                                  | ✅ EXIT=0（`git status tests/fixtures/` 仅 `??` 新 golden，其余 fixture 零改动）                                                                                                                                                                                                                                                                                                                            | —                                                                                  |

## 6 遗留问题

1. **共享树 typecheck/build 红**：`src/fabric/xs/activate.ts:667`（#20 包在途改动）。root 已确认按已知问题处理，本包以隔离验证作为证据；P-C 合流门禁须在两包都合入后于完整树上重跑（plan §3 P-C 第 3 条）。
2. **`git diff --quiet origin/dev -- tests/fixtures/`**（plan P-B §4 原文口径）：本包工作区基于 HEAD（未提交），HEAD 即 dev 当前提交；`git diff HEAD -- tests/fixtures/` 已验证除新 golden 外零改动，origin/dev 与 HEAD 之间当前无 fixtures 差异。
3. reap 窗口的 UI 收敛闭环（同 key ⇒ done、新 key ⇒ E_OFFLINE）、`docs/dev/web-hub/README.md` 更新、全量 `npm test` 按 plan 归 P-C。
