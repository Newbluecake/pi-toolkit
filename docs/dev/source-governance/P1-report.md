# P1 报告 · AGENTS.md 瘦身拆分

> 基线：`fcbf71dc`（dev，P6B/P2/P3/P6M 已合入）。方案：`plan-lowrisk.md` r2.1 §1 + 附录 C。

## 交付

- `AGENTS.md`：157 630 B → 25.8 KB（守卫上限 32 KiB）。
- 新建 README 25 份 + 追加 2 份（`feishu-bot`、`external-agent`），D01–D66 逐字搬运，共 89 个块（A 类 23 块含 16 个短条目，D 类 66 块）。
- `tests/docs/agents-md.test.ts`（K0–K9，10 条全绿）。
- `skills/dev-flow/SKILL.md`：原则 7「先读目录 README」。
- `scripts/dev/agents-split.mjs`：`build`/`check`/`parts` 三模式，块表即附录 C（按字符偏移切，标记唯一性在脚本里断言）。

## 守恒检查（`node scripts/dev/agents-split.mjs check fcbf71dc`）

```
coverage: 89 blocks + 7 headings, overlaps=0, gaps=0
blocks checked: 89, missing: 0
E1 path replacements (block:count): D09:1 D10:1 (total 2)
CHECK OK: 0 missing / 0 overlap / full coverage
```

- 源区间首尾相接：89 块 + 7 个 `## ` 标题行，0 重叠 / 0 空隙。
- 例外：E1 路径替换共 2 处（D09 `switch-context-tool.ts`、D10 `cache-keepalive.ts`）；**E2（prettier 转义差异）0 处**——prettier 前后文本均逐块命中；E3（A3 `docs/dev/` 格追加说明）、E4（Conventions 追加「see the pi peer bump checklist」）已追加，原文仍完整命中。
- 变异验证：往 fabric README 的 D12 里插入一个字符 → check 报 1 条 MISSING 并给出分歧位置；还原后 OK。

## 与方案的偏差（均为实现细节，供评审）

1. **「表」用 `<!-- prettier-ignore -->` 的两列表（条目 | 必读 README · 何时读）**：repo 的 prettier 对 markdown 表会按最长格对齐补空格，长格会把文件撑大数倍；加 ignore 注释后仍通过 `prettier --check`。A3 短条目整段原文放第一列（保证守恒的连续子串）。冻结物表同样。
2. **冻结物分级核对**（按 §1.4 实施者提示查测试文件头）：`quota-kimi-zai-golden.json`（"NEVER regenerate"）与 `tools/agent-nested-surface-golden.json`（FROZEN byte-for-byte）从方案的 B 档升到 A 档；`memory-legacy-golden.json` 留在 B（测试拒绝已存在时重生，但头注释不是 never）。
3. 表里新增 `src/archive/`（登记在 web-hub README 下）、`src/date/` `src/title/` `src/vendor/` 行，满足 K9。
4. 子 README 头部「相关」链接已逐个校验存在；web-hub 与 fabric README 顶部有目录，web-hub 另有 6 个子 README 索引。
5. 首个 README commit 漏掉两个新目录（`subagent-core/`、`workflow/`），用单独的 follow-up commit 补上（未改历史）。

## consult 清单（供 #40 PS2；`rg -n -i consult AGENTS.md docs/dev/*/README.md`）

各文件命中数：consult/README 24 · subagent-core 4 · fabric-cross-session 4 · AGENTS.md 4 · workflow 2 · external-agent 2 · web-hub / sysload / scheduled-reports / data-encryption / context-switch 各 1。完整结果：

```
docs/dev/workflow/README.md:33:`agent({ experts })` lets a workflow child consult in-turn (`expert-scope.ts`: resolution order is `"main"` → this
docs/dev/workflow/README.md:35:candidate) → the consult wiring's `resolveExperts(refs, { completedOnly: true })`, D8 — stricter than the top-level
docs/dev/web-hub/README.md:201:`handlePrompt` consults synchronously, idle-only, before its native dispatch; claiming replies
docs/dev/sysload/README.md:19:run/label/worktree), workflow `agent()` waits FIFO via the injected `LoadAdmission` (`src/workflow/host.ts`), consult /
docs/dev/scheduled-reports/README.md:55:Anthropic stub, C-S6 needs tsx else skip) — **run before any pi peer bump**, together with fabric C-P/C-X and consult-preserve.
docs/dev/subagent-core/README.md:36:settings.json itself: a non-consult `create()`/`resume()` call whose counter never advances during
docs/dev/subagent-core/README.md:40:once per process (deduped). Consult forks are exempt (their read-only tool domain makes the
docs/dev/subagent-core/README.md:54:slotless-exclusion rule as the real pool) for the Agent tool to surface. Workflow children/consult/resume/`/task`
docs/dev/subagent-core/README.md:64:terminal rebuilds, and inherited by resumes (R-inherit). Program-derived runs (workflow children, consult,
docs/dev/external-agent/README.md:75:- 只读工具域（consult 专家、tidy）拒绝走 droid。
docs/dev/external-agent/README.md:111:is refused for droid (consult and tidy can never use it — droid cannot be sandboxed read-only). Resume pins the
docs/dev/fabric-cross-session/README.md:44:(`wakeExclusion`: consult fork, readonly domain, caller-owned incl. workflow children, external/droid) + worktree gone /
docs/dev/fabric-cross-session/README.md:62:(`tests/conformance/fabric-wake.test.ts`; run before any pi peer bump together with consult-preserve), state-machine
docs/dev/fabric-cross-session/README.md:100:and a local Anthropic stub, alongside fabric-wake C-P1–C-P5 and consult-preserve C1–C7; C-X7 records
docs/dev/fabric-cross-session/README.md:205:the alias layer is consulted FIRST and a hit is final — an unreachable alias (offline, not joined, other channel, self, cool
docs/dev/data-encryption/README.md:10:**Plugin guards**: `initSecureDomain()` is the FIRST statement of `activate()` (`src/index.ts`, before any settings read), freezing
docs/dev/context-switch/README.md:19:plan §2/§3, `src/context-switch/child.ts` + `capability.ts`): every non-consult child run is granted
docs/dev/consult/README.md:1:# consult · 开发者要点
docs/dev/consult/README.md:3:> 何时读：改动 `src/consult/**` 之前（该子系统将被 #40 移除）。
docs/dev/consult/README.md:5:> 相关：`plan.md`、`expert-keepalive-plan.md`、`../consult-removal/`
docs/dev/consult/README.md:7:> **本文件由 #40 移除 consult 子系统时整体删除（同时删 AGENTS.md 目录表里的 `src/consult/` 一行）。**
docs/dev/consult/README.md:9:## src/consult/
docs/dev/consult/README.md:11:`src/consult/` — in-turn expert consultation (`consult` tool). A subagent dispatched with an
docs/dev/consult/README.md:13:`consult` tool and can synchronously ask an already-finished expert run: the expert's persisted
docs/dev/consult/README.md:14:session is streaming-forked (`fork-store.ts`), a short readonly run (`CONSULT_READONLY_TOOLS`,
docs/dev/consult/README.md:20:dispatched child consult the HOST main session the same way — live facts (session file / model /
docs/dev/consult/README.md:24:concurrently appended to or rewritten. `consult.enabled=false` leaves the wiring inert (both
docs/dev/consult/README.md:26:`docs/dev/consult/plan.md`. **A/B instrumentation** (`docs/dev/consult/ab-instrumentation-plan.md`): runs carry
docs/dev/consult/README.md:27:`diag.experts` (`refs` + `granted`), `diag.consults` (per-run consult outcome/cost/latency fold from the
docs/dev/consult/README.md:28:consult tool_end), `diag.dispatchMeta` (the Agent tool's analytics-only `meta`, inherited on resume) and
docs/dev/consult/README.md:30:analyzed offline by `scripts/exp/consult-ab-analyze.mjs` (protocol: `skills/dev-flow/references/consult-ab.md`).
docs/dev/consult/README.md:31:**C2 preserve (`docs/dev/consult/expert-keepalive-plan.md` v3.1, supersedes plan.md's §5.4 option B)**: a
docs/dev/consult/README.md:32:finished-expert consult no longer swaps in a readonly tool table — it scans the expert session for its last
docs/dev/consult/README.md:36:Read-only is enforced by `preserve-guard.ts`, not by the tool table: `createConsultGuard(snapshot)` (single
docs/dev/consult/README.md:40:(`set_model`/`message_agent`/`Agent`/`consult`/`StructuredOutput`) become implementation-free shadows with the
docs/dev/consult/README.md:42:refuses with `[consult-preserve:<code>:<detail>]`, mapped by the tool to `identity_mismatch` (no recorded
docs/dev/consult/README.md:45:(`identity.predicted`, M2) — it costs a cache miss, never a refusal. Every consult records a
docs/dev/consult/README.md:46:`ConsultCacheProbe` in `diag.consults[].cache` (per-request cache read/write, wire prefix comparison via
docs/dev/consult/README.md:49:ratio, blocked-call counters), analyzed by `scripts/exp/consult-cache-analyze.mjs` (`--retro` for pre-C2
docs/dev/consult/README.md:51:form above. `tests/conformance/consult-preserve.test.ts` (real pi + local Anthropic stub, C1–C7; C8 skipped
docs/dev/consult/README.md:53:(`PROVIDER_PREFIX_FIELDS`) fails it on purpose. No new settings (`consult.enabled=false` still disables all).
AGENTS.md:82:2. Run `npm run test:conformance` (= `vitest run tests/conformance`, the whole directory): `pi-boundary`/context-switch capability, `consult-preserve.test.ts
AGENTS.md:95:| `skills/` — agent skills shipped with the package (`pi.skills` in package.json; also in npm `files`): `dev-flow` (dev workflow lanes, model routing, para
AGENTS.md:110:| `src/consult/` — in-turn expert consultation (`consult` tool). **#40 将删除。** | `docs/dev/consult/README.md` · 动 consult 前（#40 将删除）
AGENTS.md:139:| `docs/dev/` — per-feature design docs (agent-background-only (supersedes auto-background), workflow-background, workflow-agent-queue (agent() 排队 + w
```

## 盲测（§1.11 的 10 问；仅用新 AGENTS.md + 其表指向的 README，未读其它文件）

| #   | 能否答出 | 答案（出处）                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 是       | `npm run test:conformance`（= `vitest run tests/conformance`）；droid：`PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts`（「pi peer bump checklist」 1–3）                                                                                                                                                                                                                          |
| 2   | 是       | 清单第 2 条列出 pi-boundary/context-switch、consult-preserve、fabric-wake、fabric-xs、schedule、traffic(+coexist)、cmd-history、slash-args、rpc-spawn、keepalive-pipeline、web-resume、secure-gocryptfs 及「the rest」；完整目录以 `tests/conformance/` 为准                                                                                                                                                               |
| 3   | 是       | 「Frozen artifacts」A 档（三个 off golden、compact-hint、schedule-off、secure-off、secure-contract-parity、keepalive-legacy、bash-tools、quota-kimi-zai、agent-nested-surface、legacy-xs-v071/）；A′ = `secure-launcher-off-golden.json` 仅 USAGE 变化                                                                                                                                                                     |
| 4   | 是       | 清单 1–4：改 peer 范围 + 复查 `pi-compat.ts` → conformance 全目录 → droid/gocryptfs 额外套件 → A 档 golden 不变                                                                                                                                                                                                                                                                                                            |
| 5   | 是       | 「Releasing」Branch strategy：patch 直接在 `dev` 发；minor/major 先 PR dev→master，在 master 发（releasing minor/major on dev is forbidden）                                                                                                                                                                                                                                                                               |
| 6   | 是       | I5 / pi-extension specifics：timer 必须 `unref()`，ref'd timer 会卡住 `pi -p`（print mode）                                                                                                                                                                                                                                                                                                                                |
| 7   | 是       | I4：`/reload` 同进程重激活且不清模块缓存，模块级状态会跨激活残留；改用 per-`activate()` 重建或 `Symbol.for("pi-subagent:*")` 全局并写明容量/TTL                                                                                                                                                                                                                                                                            |
| 8   | 部分     | I3：pre-guard（子会话也有）= secure guards、command capture、web_search、date、todo、prompt-section hub、memory、子会话接线；其余仅主会话。inert 原因（子会话重新 import 扩展，必须被 HOST_KEY 守卫挡住）见 pi-extension specifics；各功能为何属于哪一侧需读 plugin-merge README                                                                                                                                           |
| 9   | 是       | 不能：I7 / What this is——`pi-subagent.json` 与 `Symbol.for("pi-subagent:*")` 等运行时旧名承载现有会话数据与跨模块契约，不要在 `src/` 里「完成改名」                                                                                                                                                                                                                                                                        |
| 10  | 部分     | 改 `src/web-hub/hub/feishu/` 前读 `docs/dev/feishu-bot/README.md`（表中子行，并先看 web-hub 索引）；hub 能否导入 `src/core/format.ts`：I8 只说明 hub 仅可导入 `node:*`、typebox 和白名单文件，AGENTS.md 不列白名单，答案是「不可，除非它在 `tests/web-hub/boundary.test.ts` 白名单里」——实际核对该测试：白名单仅含 `src/core/clock.ts` 等，不含 `format.ts` ⇒ 不能（最后一步需读测试文件，已超出「只用 AGENTS.md」的范围） |

结论：10 问中 8 问可由 AGENTS.md 直接作答，2 问（#8 的功能归属、#10 的白名单具体成员）需要再读一份指向的 README / 边界测试，符合「AGENTS.md 给规则、README 给细节」的设计；建议 verifier 另派只读子 agent 复测。
