# created-dirs-plan review r1 (gpt-6.1-sol, run r_4WHKRANY) — pass-with-changes, Blocker 0 / Major 5 / Minor 5

Product boundary NOT re-litigated: plaintext LAN stays `known`; hub-created dirs inside roots become known;
cookie-replay → mkdir → spawn is an accepted residual; LAN always-confirm stays. User ruling 2026-10-19:
created dirs count FULLY as known (so unknown-dir confirm is skipped where it applies) — confirmed.

Line numbers below refer to docs/dev/web-hub-spawn/created-dirs-plan.md (r1).

1. **Major — identity ≠ current canonical path still inside roots** (plan:59–72; dirs.ts:393–408,451–465). On a
   cache hit the plan compares the step-2 stat with the record identity, then does a string roots check on `rp`.
   Window: after realpath/stat, move the original dir outside the root and put a symlink (at the path or a parent)
   pointing to the same inode — dev/ino unchanged, `insideRoots(rp)` string still inside; `pinSync` uses
   `O_RDONLY|O_DIRECTORY` + dev/ino compare and follows the symlink. Fix: for created-only admission check the
   canonical path of the finally-opened object (re-check canonical path at admission; at fork pin verify the fd's
   path, cover parent symlinks). Tests: "inode moved out of root, symlink back at original path", "parent swap".
   If a race window remains, state the guarantee honestly.
2. **Major — R5 eviction is an authorization regression, not convenience** (plan:39–41,65–67,234–235;
   dirs.ts:363–370,422–424; dirs.test.ts:469–486 pins that #51 is rejected). 50 recent mkdirs could evict still-valid
   history/session known dirs ⇒ plaintext LAN and Feishu `spawnScope:known` can no longer start them. Fix: separate
   the display cap from the authorization set (keep the existing bounded known set, union a bounded created set;
   recent list separately capped at 50). Test: 50 real known + 50 created ⇒ old dirs still admitted.
3. **Major — new source can starve old sources** (plan:56–67,74–78; dirs.ts:273–278,289–306,344–370). Source ④
   inserted after ③ does per-entry realpath/stat/insideRoots while ①③ are only in `byCwd`; one slow/hung root can
   burn the shared 2 s budget and `out()` exits before old candidates are canonicalized. Fix: resolve roots once per
   scan; give ④ its own sub-budget / failure domain that cannot consume the original candidates' budget. Test: normal
   known + created records + one slow/missing root ⇒ old dirs still admitted; a timeout must not leave an empty known
   set cached for long. No background scheduler.
4. **Major — "copy prefs" doesn't make hostile-file load hang-proof** (plan:23–28,43–46; prefs.ts:197–218). lstat
   then sync open with `O_RDONLY|O_NOFOLLOW` only stops a final symlink; a FIFO swapped in between blocks the sync
   open forever. No fstat on the fd. Fix: non-blocking safe open flags (O_NONBLOCK|O_NOFOLLOW), fstat the fd
   (regular file, uid, size) before reading; fix mode via fd. Test with a controllable fs seam (swap to FIFO after
   lstat). Do not refactor prefs in this package.
5. **Major — existing golden gate + ownership missing** (plan:194–205,213–221; tests/web-hub/hub/spawn/golden.setup.ts:65–102).
   tests/fixtures/feishu-spawn-http-golden.json:274–276 pins the plaintext-LAN E_DIR response; adding `detail`
   changes body + Content-Length; the observer compares exactly and guards via the original routes source SHA;
   golden.config.ts:9–14 wildcard will also pick up new headless tests without fixture entries. Fix: assign golden
   fixture/observer/config ownership to P2; keep the F5 baseline meaning, add a reviewed explicit delta / new baseline
   (no blind full regeneration, no masking E_DIR); add the golden command as an acceptance gate; also check the
   loopback E_DIR assertion tests/web-hub/http/api-headless.test.ts:311–320.
6. **Minor — 256 KiB cap ignores JSON escaping** (plan:29–45; protocol/spawn.ts:555–560; protocol/preview.ts:232–242).
   Constrain the actual UTF-8 JSON byte size before writing so any file we write passes our own load; define load-time
   entry count / dedupe / trim. Tests: escaped paths, >50 small records, exact byte-cap boundary, restart round-trip.
7. **Minor — short-write gap copied from prefs** (prefs.ts:234–244: single writeSync without checking the length).
   Serialize to a Buffer, loop until fully written, 0-byte progress = failure; rename only after full write + close.
   Tests: short write then continue / short write then error / 0-byte write; failure keeps old file + old memory.
8. **Minor — TTL not closed on the cached admission path** (dirs.ts:258–267). Cache stores only dev/ino; an entry
   expiring after the scan is still admitted for up to ~60 s. Store createdAt/expiresAt in the cache and check at
   admission (or cap cache life at the nearest created-only expiry). Fake-clock test.
9. **Minor — auto-select late response can overwrite the user's newer choice** (DirPicker.vue:332–343,399–418,635–661).
   Add an operation generation / intent check for mkdir results: a late success may say "created" but must not
   overwrite a newer cwd or re-open a closed panel. Tests: edit cwd during pending mkdir, pick B, close panel, old
   request returns after a newer one.
10. **Minor — cross-consumer / real assembly gaps** (hub.ts:1166–1174; feishu/router.ts:139; feishu/service.ts:1122–1157;
    feishu tests use fake dirs service.test.ts:273–280). Add a real-DirService Feishu known-scope test (created ⇒
    start, no roots confirm card; expired / replaced / out-of-roots ⇒ reject, zero starts) and a real startHub
    assembly mkdir → spawn → restart test passing through real pinSync. Add `npm run build` to acceptance.

Minor location fix: plan cites routes.ts:531 — that is the history handler; fresh-spawn policy var is routes.ts:561.
