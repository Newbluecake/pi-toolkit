# system prompt 稳定化 · 开发者要点

> 何时读：改动 `src/sysprompt/**`、`src/prompt-sections/**`、`systemPrompt.*` 设置键、任何向 system prompt 注入动态段的代码之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`acceptance.md`

## src/sysprompt/ + src/prompt-sections/

`src/sysprompt/` + `src/prompt-sections/` — system-prompt stabilization: the three dynamic sections
(project memory, agent types, available models) that used to get re-appended to `before_agent_start`'s
`{ systemPrompt }` every turn — invalidating the whole cached prefix on every write — now fold a
**frozen snapshot** instead, with real changes surfacing as a bounded tail `message` (≤3 chunks / ≤32KB
per section since the last refresh, then a pointer). `src/prompt-sections/` is the pi-free half (no pi
imports): `stable-section.ts` (the per-section state machine: snapshot/announced/stale, `SKIP` sentinel
for a failed provider, `POINTED` for the post-limit pointer state), `fold.ts` (byte-identical to the old
three-hook append chain), `update-message.ts` (renders the tail message), `store.ts` (serialize/sanitize/
read-back for the persisted snapshot). `src/sysprompt/` is the pi-facing half: `hub.ts`
(`createPromptSectionHub` — one `before_agent_start` handler per activate that every section registers
into via `hub.register(name, registration)`; also owns `context_with_system`/`session_start`/
`session_compact`/`model_select`/`session_tree`/`turn_start`/`agent_settled`), `core-sections.ts` (the
agent-types / available-models `SectionRegistration` factories — `resolvePromptModels`'s scoped → stack
port → registry priority itself lives in `src/config/available-models.ts`, kept there as its long-term
home per plan §4.6), `wake-replay.ts` (mirrors pi's own forced-prompt projection shape onto notification
wake runs), `compat.ts` (the only place touching the 0.87 `context_with_system` event / `forceSystemPrompt`
/ pi-ai's `getCurrentSystemMessage`). Three states, not two: `systemPrompt.mode` is `stable` (frozen
snapshot + tail updates, default) / `live` (refresh every turn through the hub, no freezing) / `legacy`
(raw append, byte-identical to pre-hub behavior, never persists). `systemPrompt.wakeReplay` (default
true) independently gates the notification-wake-run replay (`false` = not registered at all, not
registered-but-inert) (dormant on pi ≥1.2: pi's own forced-prompt projection runs last and supersedes
it; kept for the 1.0/1.1 peer floor); `systemPrompt.adoptForeignForcedPrompt` (default false) gates whether a later
extension's forced-prompt text gets adopted into the replay instead of just WARNed about. A snapshot's
state persists via a `subagent:prompt-sections` session entry (`pi.appendEntry`, read back through
`getBranch()` — never `getEntries()`, which can resurrect a stale fork's snapshot) so it survives
`/reload` and cross-process resume; the hub itself holds no module-scope state (all closure-local, per
`activate()`). Registered pre-guard — child sessions share the identical hook set, it is simply inert
with zero sections registered until `src/index.ts`'s post-guard call adds agent-types/models (memory
registers pre-guard too, so child sessions with memory enabled get that section). Design + the full
decision log (three review rounds): `docs/dev/sysprompt-stable/plan.md`; manual acceptance steps (traffic.db
system-prompt byte-stability checks): `docs/dev/sysprompt-stable/acceptance.md`.
