# topic-switch · 开发者要点

> 何时读：改动 `src/topic-switch/**`、`topicSwitch.*` 设置键、`/topic-switch`、web prompt gate 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`requirements.md`、`arch.md`、`plan.md`

## src/topic-switch/

`src/topic-switch/` — new-request relevance judge → suggest a clean new session
(`docs/dev/topic-switch/{requirements,arch,plan}.md`). Post-guard, main-session only, settings-
gated (`topicSwitch.enabled`, default on). The judge model chain is a configurable LIST
(`topicSwitch.model`: csv string or JSON array → live `topicSwitch.models`; configured in order
→ `title.model` → session model) with runtime failover inside the total `judgeTimeoutMs` budget
(`judgeWithFailover`: per-attempt `min(remaining, max(1500, ceil(total/2)))`, external abort
stops immediately, all-fail ⇒ the existing fail-open verdict; `/topic-switch status` shows the
last answering model + per-model failure counts). Layered like the rest of the repo: pi-free decision
core (`types/settings/filters/economics/gate/judge/state/records.ts`, P1) → `confirm.ts` (TUI
⟂ web dialog race, P3a) → pi-facing assembly (`wire/hold/release/recovery/command.ts`, P3b).
Invariants I1–I6: the `input` handler only ever holds `interactive`/`rpc` sources (never its own
`extension`-sourced re-injections — structurally impossible to double-hold); every held request
gets exactly one decision (current session via the release queue, or the new session via PONR);
a crash/`/reload` window auto-redelivers AT MOST once (`pending→delivering→resolved` CAS, never
retried); unprovable inputs (cold/cost/judge) always fail open (`continue`). PONR = the instant
`ctx.newSession` is called from the `/topic-switch __go <nonce>` command trampoline (never
reachable through the `input` event, S3); before it everything rolls back to the current
session, after it only `withSession`/the transfer's own CAS (`pending→delivering→resolved`,
bypass `→cancelled|manual`) ever delivers — recoverable via `/topic-switch last [--send]`. Four
translation-flip points (each defined exactly once): D1 non-Anthropic routes stay `unknown`
(`cache-ttl/warmth.ts`'s `WARMTH_SUPPORTED_APIS`), D2 web prompts judged too
(`promptGateRef.current = …` above), D3 judge-model fallback to the session model
(`judge.ts`'s `JUDGE_SESSION_MODEL_FALLBACK`), D4 a confirm timeout counts as declining
(`state.ts`'s `COOLDOWN_OUTCOMES`). The process-global transfer map
(`Symbol.for("pi-subagent:topic-switch-transfer")`, cap 4/TTL 10min/FIFO, worktree-origin
precedent) survives a `/reload` ONLY (it is in-process memory, wiped by a real crash/restart);
crash recovery instead relies on the persisted `pending` session-entry record `persistPending`
writes to disk alongside the transfer (`planRecovery`'s rule 4 in `records.ts`). A B1-class fix
(mid-switch marker on the same global, excluded from recovery until the switch resolves) keeps a
brand-new activation's `session_start` — which real pi always re-runs on session replacement, not
just `/reload` — from racing a PONR hop still in flight.
