# legacy-xs-v071 — frozen v0.7.1 hub-side xs sources

**Content is frozen. NEVER modify, reformat or "fix" any file under this directory.**
(`.prettierignore` excludes it; the self-check `tests/fabric/legacy-xs-v071-fixture.test.ts`
fails on any byte change.)

Purpose: channel-plan §9.4-3 — the CH1 differential test
(`tests/web-hub/hub/xs-router-v071-diff.test.ts`) runs this v0.7.1 router against the current
router on the same member table and asserts byte-equal `xs_res` / `xs_deliver` for default-only
members. Also the "old hub" stand-in for the CH2 legacy-hub tests.

- Source: tag `v0.7.1` → commit `c89a37d4f1c3d2f77b1eb0e29b7dc415ffdd596c`
  (release commit's tree == dev@24b6b2f0 for these paths).
- Extraction: `git show v0.7.1:<path>` verbatim, original relative paths preserved so the
  copies' relative imports resolve inside this directory (`../../protocol/xs.js` → the frozen
  `xs.ts` copy).
- Minimal set (runtime import closure of `router.ts`; all other imports are `import type`, erased at runtime):

| File (under `src/web-hub/`) | sha256 |
| --- | --- |
| `hub/xs/router.ts` | `f3a5cdb8867828d4f29bacc4515b6cef03ba660b9b5572aae01bd24e55ed6e09` |
| `hub/xs/limits.ts` | `65f3abf2a9ac0ea72e777686ff985cd1c134972ef785e577f08c44925f2cab52` |
| `hub/xs/members.ts` | `896f743a989e26c552cab8b9afd03fb1a00114715b5604856e27575f21d362b8` |
| `hub/audit.ts` | `2c24b3f83bcf8df2b66419242b5fdb756c5611453fc8f3b67cfbeb4d9e6efa68` |
| `protocol/xs.ts` | `95e76ff9a14829c11979d0f070f8331198fb652b70b2c24b67c194be3b09cdfe` |

`SHA256SUMS` carries the same list. This directory is outside `tsconfig` `include` (type-only
imports of files not copied would not resolve) and is only loaded at runtime by vitest.
