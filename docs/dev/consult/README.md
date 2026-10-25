# consult · 开发者要点

> 何时读：改动 `src/consult/**` 之前（该子系统将被 #40 移除）。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`expert-keepalive-plan.md`、`../consult-removal/`

> **本文件由 #40 移除 consult 子系统时整体删除（同时删 AGENTS.md 目录表里的 `src/consult/` 一行）。**

## src/consult/

`src/consult/` — in-turn expert consultation (`consult` tool). A subagent dispatched with an
`experts` whitelist (`Agent({ experts })`, resolved to verified runIds at dispatch) gets the
`consult` tool and can synchronously ask an already-finished expert run: the expert's persisted
session is streaming-forked (`fork-store.ts`), a short readonly run (`CONSULT_READONLY_TOOLS`,
enforced at both pi `sessionSpec.tools` and tool-scope; no injections, cannot spawn) answers,
and the fork file is deleted when the runner reaps it (`RunnerDeps.onReaped`). Guards: first
request cost / context preflight, turn-boundary turn and cost caps (`watcher.ts`, cap aborts map
to `user_stop`). The main session never registers the tool itself, but a reserved expert id
`"main"` (`Agent({ experts: ["main"] })`, priority over any same-named label/run) lets a
dispatched child consult the HOST main session the same way — live facts (session file / model /
context usage) come from `main-facts.ts` read fresh off the `ExtensionContext` on every call
(never a dispatch-time snapshot), and the fork gets an extra post-copy consistency check +
one retry (`forkMainSessionSnapshot`) because that file, unlike a finished expert's, can be
concurrently appended to or rewritten. `consult.enabled=false` leaves the wiring inert (both
forms). Wired in `src/stack.ts` through a late-bound ref. Design + test anchors:
`docs/dev/consult/plan.md`. **A/B instrumentation** (`docs/dev/consult/ab-instrumentation-plan.md`): runs carry
`diag.experts` (`refs` + `granted`), `diag.consults` (per-run consult outcome/cost/latency fold from the
consult tool_end), `diag.dispatchMeta` (the Agent tool's analytics-only `meta`, inherited on resume) and
`diag.schemaPreset` (`schema:"verdict/v1"`); all write-once, absent on runs that never set them, and
analyzed offline by `scripts/exp/consult-ab-analyze.mjs` (protocol: `skills/dev-flow/references/consult-ab.md`).
**C2 preserve (`docs/dev/consult/expert-keepalive-plan.md` v3.1, supersedes plan.md's §5.4 option B)**: a
finished-expert consult no longer swaps in a readonly tool table — it scans the expert session for its last
recorded tool loadout (`expert-index.ts`/`fork-store.ts` snapshot) and resumes with that exact loadout +
the expert's model/thinking, so the provider request prefix (tools/system/messages) can stay byte-identical
and hit the expert's prompt cache; the read-only R2 instructions ride only as a user message (`prompt.ts`).
Read-only is enforced by `preserve-guard.ts`, not by the tool table: `createConsultGuard(snapshot)` (single
param, no widening seam) blocks every non-allowed call in `beforeToolCall` under forced sequential execution,
`installNestedCallBlock` blocks every nested `ctx.executeTool` regardless of name, and the 2nd consecutive
all-blocked batch terminates the run as `blocked_cap`; adapter-owned tools the expert declared
(`set_model`/`message_agent`/`Agent`/`consult`/`StructuredOutput`) become implementation-free shadows with the
snapshot's exact declaration (`shadow-tools.ts`). Fail closed, zero requests sent: the driver's `preflight` (`preserve-identity.ts`)
refuses with `[consult-preserve:<code>:<detail>]`, mapped by the tool to `identity_mismatch` (no recorded
loadout / unreadable snapshot / non-reproducible definitions) or `guard_unavailable` (hooks missing) with a
fixed refusal text; system prompt / model / thinking / cwd / forced prompt drift is record-only
(`identity.predicted`, M2) — it costs a cache miss, never a refusal. Every consult records a
`ConsultCacheProbe` in `diag.consults[].cache` (per-request cache read/write, wire prefix comparison via
`prefix-probe.ts`'s process registry + `compareRecordedPrefix` — the hashed mirror of `comparePayloadPrefix`,
breakpoint rule RELATIVE: each side only on its own last user/tool_result with matching ttl; settle gap, hit
ratio, blocked-call counters), analyzed by `scripts/exp/consult-cache-analyze.mjs` (`--retro` for pre-C2
runs). **The `"main"` expert is the one documented exception** (user ruling Q1): it keeps the readonly-table
form above. `tests/conformance/consult-preserve.test.ts` (real pi + local Anthropic stub, C1–C7; C8 skipped
until Q5 is ruled) must pass before any pi peer bump — an unknown top-level provider field
(`PROVIDER_PREFIX_FIELDS`) fails it on purpose. No new settings (`consult.enabled=false` still disables all).
