# cache-ttl / keepalive · 开发者要点

> 何时读：改动 `src/cache-ttl/**`、`cacheTtl.*` 设置键、keepalive/断路器/TTL/ping 逻辑之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`breaker-recovery-plan.md`、`capture-pairing-plan.md`、`measure-plan.md`、`webhub-plan.md`

## src/cache-ttl/

`src/cache-ttl/` — prompt-cache TTL modes `auto`/`on`/`off`, status-bar indicator,
persisted settings override, and `/cache-ttl`; main-session-only `/cache-ttl measure` measures TTL/read renewal over Anthropic or OpenAI with a 17-request hard cap, revocable process claim and bounded async result store (`docs/dev/cache-ttl-keepalive/measure-plan.md`). Auto follows pi/env; on explicitly forces 1h;
off strips the TTL override. No automatic 1h upgrades remain (user decision 2026-10-11).
Copilot (`github-copilot`) is token-billed and is no longer provider-denied (2026-10-18 user ruling);
only Anthropic-messages API requests remain eligible, subject to every normal safety/budget gate.
Keepalive captures only the provider payload of each real request (pi's `onPayload`; a strict-tools
fallback's second payload replaces the first) and replays it through pi's own provider pipeline
(`src/cache-ttl/pipeline-ping.ts` → `ModelRegistry.streamSimple` with a wrapped fetch, one 20 s deadline over
auth+fetch+read, at most one POST, cancel fired never awaited), so auth and headers are resolved by pi exactly
as for a real request (plan `docs/dev/cache-ttl-keepalive/capture-pairing-plan.md` r7). The capability probe
lives in `src/adapters/pi-compat.ts` and fails closed (`transport-unsupported`, non-persisted
`activationDisabled`, forgotten on `/reload`); pi's built-in `github-copilot` provider is
`provider-unsupported` for technical reasons (custom copilot-* providers are not); extension-added request
headers are not detected (user ruling 6, noted in `/cache-ttl status`); a ping whose transport has not
physically settled holds `io-busy` (no retry/next ping), and each child ping-ledger lease settles exactly once.
Pings run under bounded ping budgets,
fingerprint/session/epoch guards, and unref'd timers (service in `src/cache-ttl/keepalive-service.ts`).
A single ping retries until the cache window runs out (2s→5s→10s→20s→30s then constant 30s, bounded by
`aliveUntil − TTL_SAFETY_MARGIN_MS`; 3 attempts when `aliveUntil` is unknown; retryable = network + HTTP
408/429/500/502/503/504/529; r2 2026-10-14). Never-processed transients (network / retryable HTTP) no longer
pause the session — the next window retries afresh (legacy `disabled{transient:true}` snapshots are lifted on
read-back); only possibly-billed transients (accepted-then-lost / malformed) still use the streak/total
limits, cleared by a successful real response. `/reload` restores the branch's breaker state. `no-usage` (200 without cache usage) is line-level too
(`session.noUsageStates`, same line key and per-line streak/total thresholds, never `session.disabled`; user
ruling 2026-10-20): it lifts with NO cooldown on a same-line real success whose response reported cache usage
(read>0 or write>0 — a success without usage leaves it tripped), another line keeps pinging, a model switch
resumes, switching back stays tripped until such a success; HUD `ping off:no-usage`; a legacy persisted
`disabled{no-usage}` migrates to a wildcard no-usage breaker.
`proven-write` (the ping found the cache gone and paid a full write; user ruling 2026-10-20, supersedes the old
session-permanent disable) is line-level as well (`session.provenWriteStates`, same line key, own map so reasons
never share counters): it trips on the FIRST occurrence (no thresholds), never sets `session.disabled`, and lifts
with NO cooldown on ANY successful real request on that line (no cache-usage requirement — a real request re-
establishes the cache; unlike no-usage), another line keeps pinging, a model switch resumes, switching back stays
tripped until such a success; HUD `ping off:proven-write`; a legacy persisted `disabled{proven-write}` migrates to a
wildcard proven-write breaker; child keepalive lifts it the same way (only this breaker recovers in a child). The
web panel marks line-scoped last pings (`lastPing.line`, proven-write/no-usage) 「线路级」, never 「永久」.
Non-transient HTTP rejections (4xx, zero-billing) are line-level (`session.lineStates`, key =
provider+baseUrl+model): a same-line successful real request resets them (backoff 30m×2^(n-2) on repeat,
cap 24h; legacy session-level http disables migrate to a wildcard breaker), and `/cache-ttl keepalive reset`
manually clears every breaker (design: `docs/dev/cache-ttl-keepalive/breaker-recovery-plan.md`).
Design: `docs/dev/cache-ttl-keepalive/plan.md`. **Child-session keepalive** (child-context-switch
plan §2.4, `src/cache-ttl/child.ts` + `child-registry.ts`): capture-only (never rewrites the
outgoing payload); per-window cap uses the CAPTURED payload model's registry-mapped cache
prices (whole tier from that real response's full input usage; missing tier usage ⇒ fallback 11),
clamped to 0–96 (`clamped` above 96); this budgets the cache PREFIX only, not uncached input/output,
and fallback 11 has no profitability proof. The removed `cacheTtl.keepaliveMaxPings` key (even 0)
is ignored, with a status-only deprecation note (never session_start notify); turn off with
`cacheTtl.keepalive:false` then `/reload` (master wiring is non-live). Other child limits stay
24/run · 4 concurrent · $1.5/run · $10/24h process-rolling
(`ping-ledger.ts`), no price info ⇒ no ping (`usd-unpriced`); ping cost folds into the child run's
own `usage.costUsd` (fleet/HUD visible); disposed on `agent_settled` and defensively via the
registry's `onReaped`. **`warmth.ts`** (topic-switch plan P2): a pi-free, never-throwing
`CacheWarmthPort` (`wireCacheTtl`'s return value, `CacheTtlWiring.warmth`) that judges whether
the NEXT Anthropic request would read a warm prompt cache from a proven recent ledger or
keepalive touch (`provenCacheReadAt()`). `mode`/`lastSent`/1h-write traces only raise the bar
for PROVING cold (Anthropic's 1h max TTL) and pick `nextWriteTtl`; anything unprovable is
`unknown` (topic-switch's gate 3a treats that as "don't ask", same I6 fail-open direction).
**Late-usage lines (2026-10-20, plan.md 「late-usage lines」)**: relays that report cache stats only in the stream's final
`message_delta.usage` (measured: kimi-coding/k3, `api.kimi.com`; `message_start` shows 0/0 even on a hit) are either seeded by
baseUrl host (`LATE_USAGE_SEED_HOSTS` in `late-usage.ts`) or learned (a 0/0 ping followed by a real `cacheRead>0` sets a
persisted `lateUsageAt` on the route in provider-evidence). Their ping replays the capture byte-for-byte except `max_tokens`
clamped to 4 (never 1 — kimi special-cases it and skips the cache; thinking is never touched — it keys the cache), reads
until the first `message_delta` with usage under the same single 20 s deadline (scan cap 256 KiB for this mode only), bills its
≤4 output tokens, and `/cache-ttl status` shows `late-usage: seeded|learned`; non-late lines stay byte-identical.
**Provider evidence layer (2026-10-12, plan v3 — ten-line probe measurements)**: `provider-evidence.ts`
(pi-free, `~/.pi/agent/cache-provider-evidence.json`, 0600/atomic/1MiB cap/30d rolling TTL/200-route
FIFO/fail-silent) records per provider+model whether 1h writes ever LANDED (relay collapse is real:
cr-anthropic/kimi-coding write zero 1h entries), probe verdicts, and the no-cache-value streak.
warmth's 1h ceiling requires landing EVIDENCE (intent like mode=on no longer raises the window);
keepalive gate #7 splits on it (no evidence ⇒ 1h captures get a ttl-stripped 5m ping; evidence ⇒
legacy skip; store absent ⇒ byte-identical legacy); 3 consecutive keepalive-active-but-zero-read
sessions trip a self-healing `no-cache-value` ping breaker; `/cache-ttl probe` runs a 3-request
live checkup that feeds the same store.
