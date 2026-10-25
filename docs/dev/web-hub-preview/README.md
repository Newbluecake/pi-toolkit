# Web Hub 内容预览 · 开发者要点

> 何时读：改动 `src/web-hub/hub/preview/**`、`/api/preview`、HTML 预览（`/pv*`）、`webHub.preview` 设置键、预览相关 UI 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`dir-plan.md`、`chunked-plan.md`、`acceptance.md`、`../web-hub-html-preview/`、`../web-hub-preview-windows/`、`../preview-perf/`

## Content preview

**Content preview (web-hub-preview plan v3 + dir-plan v3.1, setting `webHub.preview` — `"on" | "loopback" | "off"`, default
`"on"` per the 2026-10-05 user ruling U1: sole LAN user behind password auth, risk explicitly accepted; change
is non-live — `/reload` then `/webhub restart`)**: an absolute path in a settled message (assistant text, user
bubble, or a ToolCard's Input section, all rendered through `ui/src/components/preview/PathText.vue` — never
`markdown.js`; streaming replies stay plain text until they settle) opens a read-only dialog via the single
endpoint `GET /api/preview` (`X-PWH: 1`; raw bytes + `X-PWH-Preview-*` metadata headers; no new SSE/frames).
**Admission (dir-plan U4, 2026-10-08): uploads + ANY absolute path** — an authenticated user (LAN included) may
read any file the hub uid can read that the denylist does not name, and browse directories; that boundary is
deliberately accepted (U1/U4), and the denylist (`hub/preview/admit.ts`, `PREVIEW_DENYLIST_VERSION`) is a
best-effort credential BLACKLIST, not a whitelist — changing a rule means bumping the version, refreshing
`tests/fixtures/preview-denylist-corpus.json` in the same PR, and running `node scripts/dev/preview-denylist-audit.mjs`
before release. Defence stack on every fs-class request (all steps bounded, zombie-IO tracker ⇒ 503 busy):
literal denylist + virtual roots (zero-fs) → realpath → denylist/virtual-root re-check on the resolved path
(home/agentDir checked in literal AND canonical forms — the startup `resolvePreviewDenyContext`, degraded
members backstopped by home-independent twin rules) → stat → `O_NOFOLLOW` open → fstat dev/ino →
`/proc/self/fd` re-check. **Upload attachments** (`hub/uploads.ts`'s `openForPreview`: structural re-check of
the generated `<uploadId>.<ext>` / legacy `<id>/<safeName>` layouts, sha256 re-verification) are shared with
the **session's viewers** (U3 — revises upload-plan §5.1's "uploader-only" read rule; writes/abort/dedup/pinning
stay principal-bound, recorded as an appended note in that plan). **Directories**: `&dir=1` opt-in answers a
JSON listing (`X-PWH-Preview-Kind: dir`) — dirs-first sort, dotfiles dimmed but listed, denylist hits vanish
from both entries and counts, triple caps (scan 10 000 → entries 1 000 → body 512 KiB); the dialog drills down
(in-dialog back/up history, cap 64) and each child click re-runs the full admission chain. Caps `preview.abs.v1`
(abs-path recognition) and `preview.dir.v1` (dir listing + recognition; NOT declared on platforms without
`/proc/self/fd` — fail-closed, directories stay 415 there). Markdown files (`.md`/`.markdown`) render by
default with a source-code toggle (reset per open, path-keyed; parser stays `v-html`-free with a 20 000-node
budget degrading to source). File caps: text 256 KiB (UTF-8
boundary), images 16 MiB loopback / 4 MiB LAN / 40 MP (unparseable dims ⇒ reject; touch clients budget 20 MP);
preview reads never pin or extend upload TTLs; the audit line's `cls` is `upload|cwd|abs` (literal prefix,
stats only — never a path or entry name). `mode:"loopback"` keeps the endpoint LAN-absent (404, byte-
identical to `off` on LAN) while loopback keeps previewing. Design + real-device acceptance:
`docs/dev/web-hub-preview/{plan,dir-plan,acceptance}.md`.

## Preview multi-windows

**Preview multi-windows** (preview-windows plan r2, W1–W4 merged): on ≥768px that dialog becomes MODELESS floating
preview windows (z-layer 25 — over chat/composer, under drawers/popups/ask-float; EXCEPTION 2026-10-24:
windows opened FROM the ask_user float ride a dedicated z-46 root above ask-float, placement avoiding the
float's rect, and an ask-tagged ref landing on an existing window promotes it to that tier): conversation clicks APPEND
windows (cap 6, staggered cascade), known dirs navigate in place, unknown types speculatively open + fold back,
drag/8-way resize with keyboard equivalents on the title bar, 「⋯」 window menu (close-all/reset/list),
`Ctrl+`` / `Ctrl+Shift+`` conversation⇄window MRU ring, same-path dedup focuses + moves focus, cap-limit
`role=status` notice, session switch/relock closes all; <768px keeps a fullscreen stack (top-only trap, others
`inert`); HTML previews share a tab-local cap-FIFO ledger for the deterministic 「可能已被挤掉」 notice with a
standing 「重新加载」. Design + real-device checklist: `docs/dev/web-hub-preview-windows/{plan,acceptance}.md`.

## Chunked text preview

**Chunked text preview** (cap `preview.chunk.v1`, opt-in `chunk=1` / `offset=N` / `ident=i1.…` query; every chunk re-walks the full admission chain; UI ceiling 8 MiB desktop / 4 MiB touch, hub hard cap 16 MiB): design `docs/dev/web-hub-preview/chunked-plan.md`.

## Large-source virtualization

**Large-source virtualization** (preview-perf plan r3, `docs/dev/preview-perf/`): source previews above the **600-line** threshold (and every line-numbered stream) render through `VirtualCode` block virtualization (32-line blocks, in-window Ctrl+F find, window-level 完整视图 escape hatch, logical Ctrl+A) — build-time kill switch `PREVIEW_VIRTUAL_ENABLED`; virtual-body highlighting runs in a **Worker** under the relaxed **256 KiB / 80k-token** gate with sticky fallback to the original main-thread gates; `npm run probe:preview-perf` (NOT in CI — a mermaid-class manual gate over the real csp-probe build) measures it, `--write-baseline` (+ `--virtual`) being the only way to touch the tracked `docs/dev/preview-perf/baseline{,.virtual}.json`, and `--gate` (virtual mode only) evaluating the plan §6.1 thresholds (register: `docs/dev/preview-perf/acceptance.md`).

## HTML preview

**HTML preview (rendered)** (cap `preview.html.v1`, plan `docs/dev/web-hub-html-preview/plan.md` v2 + §R1/§R2): `POST /api/preview/html-cap` mints one path-shaped capability per render; scripts run SANDBOXED in an opaque origin (`/pv/<cap>/<rel>` served with `CSP: sandbox ${PV_SANDBOX}` = `allow-scripts allow-forms allow-popups` — never `allow-same-origin`/top-nav/modals/downloads — framed by the dialog iframe or the script-free `/pvw/<cap>` wrapper tab, both carrying the identical sandbox attribute). The cap admits the entry's own directory + subdirectories only (F2; denylist on every subresource), external network allowed (F3); capability TTL idle 15 min / absolute 60 min, per-principal 8 / global 64 caps, per-cap 200-req bucket + 10 000 lifetime, bounded FIFO queue (6/16 active, 64/256 queued, 10 s wait) and a 2-slot physical-IO semaphore (never-settling ops zombie their slot only — T-I1 pins preview/uploads/LAN-scrypt liveness). Admission is fd-anchored on a held `O_DIRECTORY|O_NOFOLLOW` dir fd, resolved through `/proc/self/fd/<dirFd>/…` with post-open fd-readlink containment; D2 refuses `/`, `$HOME`, agent-dir and uploads-root entries ⇒ source view only; `cls:"upload"` ⇒ 403. Invariants I1–I4: `/pv*` never reads cookies/auth (the capability is the only credential), opaque-origin `/api/*` carries no usable credential (HttpOnly + SameSite=Strict ⇒ 401), no `/api/*` response ever carries ACAO (unreadable), every state-changing `/api` route demands X-PWH/JSON + rejects `Origin: null`. Revocation: logout (both listeners, by sidTag/userId), passwd commit, token rotate (per listener), hub dispose — seq-recheck before insert, `isLive` before head, in-flight aborts. `redactLogUrl` keeps caps/rel out of fallback logs. Accepted residual: a page script can exfiltrate non-denylisted files in its own directory and set its own Referrer — F2+F3 by design; raw `/pv` top-level self-navigation harms only the sandboxed page. Real-browser gate: `docs/dev/web-hub-html-preview/acceptance.md` (selfcheck page in `selfcheck/`).
