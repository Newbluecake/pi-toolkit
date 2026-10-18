# F9 report — `/webhub feishu` admin surface, QR rendering, setting-specs

Package **F9** of `plan.md` v2 (§9 settings/commands/setup + §R2-e setup ownership, §10 observability,
§14 F9 row). Everything here is the **agent-side** surface: it sends the F0-frozen `fsb_req` frames over the
existing agent↔hub connection and renders `fsb_res`. The hub side (F1–F8/FA) is not landed, so today every op
reports 「当前 hub 尚不支持飞书机器人（缺少 fsb.v1 能力）」 — by design, `callFsb` refuses to send anything unless
`hello_ack.caps ∋ fsb.v1`.

## Files

| File                                        | Change                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/commands/webhub.ts`                    | `feishu` subcommand (+ usage/completions/description; no other behavior touched)                            |
| `src/web-hub/agent/feishu-admin.ts`         | NEW — port seam, `callFsb`, §10 rendering, §8 coexistence probe, setup device-flow orchestration            |
| `src/vendor/qrcodegen.ts`                   | NEW — vendored Nayuki QR encoder (MIT header kept; byte mode, ECC L, mask 0)                                |
| `src/commands/qr-render.ts`                 | NEW — half-block terminal renderer (the probe's exact rendering, inverted glyphs)                           |
| `src/config/setting-specs.ts`               | appended the `feishuBot.*` editor entries (9 leaves — see the deviation note)                               |
| `tests/commands/webhub-feishu.test.ts`      | NEW (24) — routing, TUI guard, confirms, status/allow/deny/repair/reset/setup, completions                  |
| `tests/commands/qr-render.test.ts`          | NEW (5) — geometry, charset, quiet zone, qr-too-large                                                       |
| `tests/commands/webhub.test.ts`             | usage line + completion list updated for `feishu`                                                           |
| `tests/web-hub/agent/feishu-admin.test.ts`  | NEW (30) — call classification, §10 rendering, coexistence, setup flow (adopt/refuse/timeout/no-cap)        |
| `tests/vendor/qrcodegen.test.ts`            | NEW (9) — published format-info constant cross-check, finders/timing/alignment, version boundaries, goldens |
| `tests/config/setting-specs-feishu.test.ts` | NEW (7) — exposed set, kinds/ranges, defaults, non-live, no-time-flag, write round-trip                     |

## Commands (`/webhub feishu …`, TUI-only per §R2-e — no web/LAN surface in v1)

| Command                              | Wire op                              | Confirm?                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup [--replace]`                  | `setup_begin` (+`replace`,`confirm`) | `--replace` only (§9: plain setup on an unconfigured bot is not destructive; without `--replace` on configured creds the hub answers `E_FSB_CONFIRM_REQUIRED` and the agent relays the hint) | renders the QR as a persistent `aboveEditor` widget (`webhub-feishu-qr`, cleared on every exit path), prints the URL, polls `setup_status` every `FEISHU_SETUP.agentPollMs` (2 s) until `done/expired/denied/cancelled/failed`. **Esc is not hijacked** — the escape hatch is `/webhub feishu cancel` from the editor (the hub fences the generation); documented here as a deliberate cut. |
| `status`                             | `info`                               | —                                                                                                                                                                                            | §10 lines (below) + degraded/status prose + `feishuBot.*` settings warnings (`loadFeishuBotWarnings`) + feishu-notify coexistence warning (§8, agent-side only — never in `FsbInfoData`)                                                                                                                                                                                                    |
| `cancel`                             | `setup_cancel`                       | —                                                                                                                                                                                            | reports the fenced generation (late polls discarded, nothing written)                                                                                                                                                                                                                                                                                                                       |
| `allow <open_id>` / `deny <open_id>` | `allow`/`deny`                       | —                                                                                                                                                                                            | `FEISHU_OPEN_ID_RE` validated client-side before anything is sent; result line `allow: changed allow-list=2`                                                                                                                                                                                                                                                                                |
| `repair`                             | `repair{confirm:true}`               | TUI confirm (keeps creds, re-seeds allow-list with owner)                                                                                                                                    |
| `reset`                              | `reset{confirm:true}`                | TUI confirm (deletes creds+state, reminds the user to delete the app in Feishu)                                                                                                              |

Every op rejects unexpected args; a declined confirm sends **nothing** (「已取消：未发送任何请求」); a throwing
`ctx.ui.confirm` counts as declined (fail closed); the whole `feishu` branch is wrapped so the command handler
never rejects.

## Status lines (§10)

Token lines are English-only (AGENTS.md UI split); prose hints/warnings are Chinese.

```
feishu: status=open brand=feishu gen=3 uptime=1h02m reconnects=2 lastClose=E_SILENCE/1006 2h46m ago
counters: in=128 dup=3 dropped{malformed=2}
outbox: ok=40 failed=1 last=230020
bindings: total=2 offline=1 amb=0
caps: cards=✓ reactions=✓ files=? cb=✗
keepalive=on
owner=ou_ab…0def allow=4: ou_ab…0def, ou_zz…1xxx, ou_short, ou_…9f3c
```

- Absent fields are omitted, never guessed; `dropped{}` omitted when empty; allow-list folds at 6 shown (`+N more`).
- `status=degraded(state-corrupt,…)` inlines the reasons; each reason also gets a Chinese prose line
  (repair/reset hints, credentials-unsafe, persist-failed, ws-unavailable, undecodable-events,
  `capability-denied:<x>`), plus per-status hints for `unconfigured/setup/auth_failed/conn_limit` and the
  keepalive prose line.
- Whole block is a `warning` iff `status ∈ {degraded, auth_failed, conn_limit}`, else `info`.
- **Masking**: the hub already sends masked ids, but `maskFeishuId` re-masks defensively (full `ou_…` ids become
  `ou_ab…0def`; already-masked values pass through) — a misbehaving hub cannot leak a full open_id into the lines.
  The wire `fsb_res.data` union has no secret/device_code/WS-URL field at all (F0-pinned, tested by F0).

## Zero-hang bounds

- `callFsb` pre-checks liveness + `fsb.v1` (nothing sent otherwise), races its own **unref'd** deadline
  (5 s default; 12 s for `setup_begin`/`repair`/`reset`, whose hub side performs network I/O or drain budgets).
- The setup poll loop hard-stops at `expiresAt + 15 s` (fallback `maxExpiresInS` = 600 s), sleep is unref'd,
  mid-flow `no-cap` (hub superseded by an older one) aborts at once, transient poll failures warn once and retry
  within the deadline. Bounded: ≤ ~38 polls for a full window.

## Wiring hand-off for FA (the reason `agent/index.ts`/`src/index.ts` are untouched)

`/webhub feishu` needs **zero rewiring**: `WebHubCommandDeps.feishuPort` defaults to
`defaultFeishuAdminPort()`, which reads `connection.ts`'s process-level `currentConnection()` **lazily per call**
(the `admin-cmds.ts` pattern — `/reload`-replaced connections are picked up automatically). What FA must land:

1. **Agent side** — widen `HubConnection.request()`'s frame union with `FsbReqFrame` (resolve `FsbResFrame`) and
   add `case "fsb_res":` to `Connection.onFrame`'s pending-rid match (next to `lan_res`/`hub_ctl_ack`). Until
   then the port's localized structural cast (`FsbRequestCapableConnection`) is dead code: no hub advertises
   `fsb.v1`, so it is never reached; even a mismatch would only hit `callFsb`'s 5 s deadline, never hang.
   `fsb_res` already flows through `decodeHubFrame`'s table (F0 folded the schema into `messages.ts`).
2. **Hub side** — intercept `fsb_req` in `agent-server.ts` like `lan_req`; fold `FSB_HUB_CAP` into both cap
   surfaces iff `config.feishuBot`; `buildHubConfig` writes `FeishuBotHubConfig` per the F0 hand-off; flip the
   `feishu.test.ts` assertion that pins the cap as not-yet-referenced.
3. If FA prefers a different transport (not the widened `request()`), pass its own adapter through
   `WebHubCommandDeps.feishuPort` (`src/index.ts` wires `createWebHubCommand`, a one-line change) — the command
   and `feishu-admin.ts` are agnostic.

## Deviations / decisions (flagged for the main session)

1. **`feishuBot.debounceMs` is JSON-only** (not in the TUI editor). The shared spec-table invariant
   (`tests/ui/settings-editor.test.ts`: no exposed key may end in `Ms` — editor durations live in the seconds
   domain) is outside F9's file domain, and the storage key is frozen by F0 (milliseconds, never rewritten).
   Followed the `externalAgents.droid.*` JSON-only precedent; pinned by test. If the invariant is ever relaxed,
   add `count("feishuBot.debounceMs", 0, …, max: 10_000)` per F0's suggestion.
2. **Esc-cancels-setup is cut** (plan §9 「until done/expired/denied/Esc」): a slash command cannot own raw
   terminal input without a custom component; `/webhub feishu cancel` from the editor covers the escape hatch
   (hub fences the generation). The QR widget is cleared on every flow exit.
3. QR rendering keeps the probe's **inverted** glyphs (light modules = solid blocks) — that exact rendering was
   OpenCV-verified (probe P1); the vendored encoder carries the verification note in its header.

## Self-verification

- `timeout 280 npm run typecheck` — clean (tsc ×2 + vue-tsc).
- `timeout 600 npx vitest run tests/commands tests/web-hub/agent tests/config tests/ui` (+ `tests/vendor`) —
  112 files, 2 013 passed.
- `npx vitest run tests/web-hub` (boundary + protocol, incl. F0's feishu suites) — 10 974 passed / 3 skipped.
- `npx prettier --check` on every touched file — clean.

## Main-session fixes after verification (r_BM7T028N, conditional pass)

- setup polling stops on a hub refusal (`refused`) and shows `formatFsbRefusal`, instead of retrying until the deadline.
- `callFsb` clears its deadline timer when the race settles.
- `maskFeishuId` only passes through a well-formed masked value (`ou_XX…abcd`); short or malformed values become `ou_…`, anything longer is re-masked (defence in depth against a misbehaving hub).
- `qr-render.ts` comments now describe the actual inverted glyph mapping (`upper-dark << 1 | lower-dark`).
- Open item for F10 real-TUI acceptance: confirm a second slash command (`/webhub feishu cancel`) can be submitted while setup is polling.
