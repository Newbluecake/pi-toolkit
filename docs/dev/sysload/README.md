# sysload · 开发者要点

> 何时读：改动 `src/sysload/**`、`load.*`/`webHub.load` 设置键、spawn 负载准入之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`

## src/sysload/

`src/sysload/` — load-aware dispatch (`docs/dev/sysload/plan.md` v2.1). Pi-free core except `hook.ts`: `procfs`/`mounts`/`sampler`
read CPU (incl. PSI), memory, IO pressure and per-mount disk from /proc + statfs under a process-wide IO ledger
(`io-ledger.ts`, `Symbol.for("pi-subagent:sysload-io")` — the one documented process-global: ≤2 async ops, ≤1 per key, slots
released only when the operation really settles, late results generation-fenced); `tracker.ts` runs the frozen
sustain(60s)/recover(30s)/hysteresis state machine per metric (overall = max known level, all unknown ⇒ unknown;
`levelSinceMono`/`gatingSinceMono` give the gate duration); `top.ts` scans /proc on demand (deadline, single ledger slot,
pid+starttime reuse check, aggregated by comm, instantaneous CPU% across scans, `cpuPct`/`rssBytes` omitted ⇔ n/a — never
NaN on the wire); `gate.ts` evaluates admission + renders the rejection text; `hook.ts` turn_end hints (`subagent:load`,
`triggerTurn:false`). Settings `load.*` + `webHub.load` are non-live (session_start / hub start). Entry matrix (P2a,
`src/stack.ts` + `spawn-service.ts`): top-level and nested `Agent` (incl. resume) are rejected while gated (before any
run/label/worktree), workflow `agent()` waits FIFO via the injected `LoadAdmission` (`src/workflow/host.ts`), `/goal` verifier / tidy / `/task` / @mention / RPC / cron are exempt; gate off, unknown, stale, print/json ⇒ fail open.
Hub side (`src/web-hub/hub/load.ts`): one hub sampler, fingerprint-gated `load` SSE frames, cap `load.v1`,
`GET /api/load/top` (X-PWH + same auth as other GETs, LAN same width, per-principal rate limit, 1.5 s deadline); UI
`src/web-hub/ui/src/components/load/` (pill / card / drawer banner from `StatusInfo.loadGate`). `load.enabled=false` /
`webHub.load=false` ⇒ zero wiring.
