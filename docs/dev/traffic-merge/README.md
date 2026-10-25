# traffic 录制 · 开发者要点

> 何时读：改动 `src/traffic/**`、`traffic.*` 设置键、provider 请求录制/重写、peer bump 前跑 traffic conformance 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`../plugin-merge/README.md`（合并总览）

合并总览见 [plugin-merge](../plugin-merge/README.md)。

## src/traffic/

`src/traffic/` — merged pi-traffic-record (design + rulings: `docs/dev/traffic-merge/plan.md` r3; reports T1–T7): provider request/response/stream recording into a fixed `homedir()/.pi/agent/records/traffic.db` (`node:sqlite`, zero deps, lazy-loaded on first explicit DB access — `/record on|status`; needs Node ≥22.13; legacy `dumps/` layout is detected and refused, never auto-migrated), per-request ticket identity (`x-pi-traffic-ticket` minted in `before_provider_headers`, proven pairing (`L={T}`) + payload generations, stripped at the single fetch trampoline; whitelist anthropic-messages / openai-completions / openai-responses — codex stays OUTSIDE: its WS handshake carries the header past fetch, so codex sessions only get hook-level rows and no rewriting), a write-behind ledger behind a 2 ms-per-tick budget (`busy_timeout=0`, BUSY backoff, bounded FIFO drops visible in `/record status`, WAL checkpoint only while `-wal` ≤2 MiB — beyond that runtime checkpoints stop, `db.close()` warns >64 MiB), jq rewrite rules (unchanged `serialize_*` keys are dead), and a hardened web viewer (`/record`, main-session tui/rpc only — print/json records but never serves/replays; default `127.0.0.1`, Host allowlist + 421, token (digest + timingSafeEqual) on every `/api/*` and header-only on state changes, XFO DENY/CSP/no-store, unref'd sockets, session_shutdown aborts in-flight replays). `traffic.enabled` (default off) gates everything: off ⇒ no command, no hooks, no symbols, no records-dir access. Child sessions register recording hooks pre-guard — `traffic.childSessions` (default true) records child prompts/outputs too (拍板①; `false` stops DB rows but never stops rewriting), while toolkit-internal keepalive/quota/title/topic-judge requests are structurally ticketless and never recorded/rewritten (拍板⑥). A one-way claim protocol (`Symbol.for("pi-traffic-record:claim")` / `external-active`, plus a session_start `getCommands()` recheck) keeps exactly one recorder active when the external pi-traffic-record is still installed — toolkit yields. Secure domains force `traffic.enabled=false` (both settings load paths) and every persist re-checks the domain. Armed rewrite rules veto cache-ttl keepalive pings (`ping off:traffic-rewrite`; process-level rewrite marks survive engine close) and stop pi-native cache warming (`cache_warming_decision` → `{action:"stop"}`); any observed warming decision suspends rewriting (fail closed, rows marked `suspended`) until `/record off→on`. Gates: `tests/traffic/**`, `tests/integration/traffic-lifecycle-process.test.ts`, conformance `tests/conformance/traffic{,-coexist}.test.ts` (peer bump — see Conventions), perf gate `npm run test:traffic-gate` (`PI_TRAFFIC_PERF_GATE=1`, timing assertions off in the normal suite) + real-machine V11.

## Peer-bump conformance premises (traffic)

**Also run `tests/conformance/traffic.test.ts` and `tests/conformance/traffic-coexist.test.ts`**
(traffic-merge T6): they pin traffic's ticket-identity premises against real pi/pi-ai — hook order
headers → payload → fetch → response; only the 400 strict-tools fallback re-fires `onPayload`;
no `onPayload` after 2xx response headers; non-2xx never reaches `after_provider_response`; the
cache warmer fires BOTH hooks while compaction fires headers only; whitelisted SDKs carry
`options.headers` to `globalThis.fetch` (codex WS handshakes carry them outside fetch, which is
why it stays off the rewrite whitelist) — plus the claim-protocol single-recorder matrix under
the real resource loader (old v0.2.x external, tombstone v0.3.0, both load orders, filtered
package entries, missing paths). Any premise breaking on a new pi/pi-ai must fail there before
the bump ships.
