# Diagnosis: DirPicker「新建文件夹」silent success + unknown-dir spawn refusal (2026-10-19)

Reported by the user on hub v0.6.1, LAN listener (plaintext HTTP, password auth, user u1), settings
`webHub.spawn = { enabled, lan: "roots", roots: ["~/ai"] }`. Diagnosis by Explore run r_JSRVDPK2
(kimi k3-256k) + live evidence from the main session.

## 1. mkdir works — the UI gives no acknowledgment

- Live: `POST /api/headless/mkdir` → 200 (52-byte JSON); `/home/bluecake/ai/chat/jingdong` created at
  the same second. The hub.log `phase:"request", endpoint:"mkdir"` line IS the success record (failures
  log `phase:"reject"`, `src/web-hub/hub/spawn/routes.ts:1290,1297`).
- UI (`src/web-hub/ui/src/components/spawn/DirPicker.vue` `mkdirConfirm`): on success it only closes the
  inline form and re-lists the directory (`mkdirCancel(); await browseLoad(...)`). No toast, no highlight,
  no auto-drill, no cwd-input update; dirs-first alphabetical order can put the new entry off-screen.
  zh i18n has only `mkdirErr*` strings, no success copy.
- mkdir admission is the preview deny chain only (`src/web-hub/hub/spawn/mkdir.ts:151-208`): it never
  consults `known ∪ roots` / `spawn.lan`, so you can mkdir anywhere non-denylisted.

## 2. Spawning into a never-run dir is refused by design on plaintext LAN

- `supervisor.policy()` (`src/web-hub/hub/spawn/supervisor.ts:2671-2676`): loopback ⇒ `roots`; LAN ⇒
  `roots` only if `spawn.lan === "roots"` AND NOT (`scheme === "http"` && !viaTrustedProxy); otherwise
  `known`. Plaintext direct LAN is therefore capped to `known`.
- Design: `docs/dev/web-hub-spawn/arch.md:285` (threat table — 「LAN 明文嗅探 cookie 后重放 … 明文直连时封顶为
  `known`」) and `:302` (settings table).
- "Known" (`src/web-hub/hub/spawn/dirs.ts`): registry card cwds ∪ session-file header cwds (30 days) ∪ spawn
  history, realpath'd, cap 50. A mkdir'd folder is not known ⇒ `admit()` fails at step 3, the roots step
  (4) is skipped ⇒ `startFresh` returns `400 E_DIR{reason:"not-allowed"}` before the confirm gate
  (`src/web-hub/hub/spawn/entry.ts:223-226`). Pinned by `tests/web-hub/http/lan-headless.test.ts:191-214`.
- UI copy 「目录被拒绝 — 请选择最近目录或允许的目录」 (`i18n/zh/spawn.ts:74`) never mentions the plaintext cap.
- Product trap: on plaintext LAN the picker lets you create folders you can never spawn into.
- Existing ways out: spawn via loopback; HTTPS via a trusted reverse proxy (`webHub.lan.trustProxyFrom`); run
  pi once in the dir.

## 3. Test coverage / gaps

mkdir: `tests/web-hub/hub/spawn/mkdir.test.ts`, `tests/web-hub/http/api-headless-mkdir.test.ts` (loopback
only), `tests/web-hub/ui/dir-picker.test.ts:459-674`. Scope: `tests/web-hub/hub/spawn/dirs.test.ts:269-305`,
`supervisor.test.ts:1366-1376`, `lan-headless.test.ts:191-214`. Gaps: no LAN mkdir test, no mkdir→spawn
journey test, no cause-specific `E_DIR` copy test, no success acknowledgment to test.
