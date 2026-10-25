# P0 report — shared-asset migration (#40, base dev@b8f9a43e)

## Done

- `CONSULT_READONLY_TOOLS` → `READONLY_DOMAIN_TOOLS` in `src/runtime/tool-scope.ts` (value unchanged); the old name stays as a `@deprecated` alias. Readonly-domain consumers (`memory/tiered.ts`, `service/runtime-adapter.ts`, and the tests named in the plan) use the new name.
- `createCapWatcher` moved verbatim to `src/runtime/cap-watcher.ts` (type `ConsultCapReason` → `RunCapReason`); `src/consult/watcher.ts` is a re-export shim. `memory/tidy/{command,cost}.ts` import the new path. `tests/consult/watcher.test.ts` was `git mv`'d to `tests/runtime/cap-watcher.test.ts`.
- `consultSessionDir`/sweep/TTL moved verbatim to `src/runtime/legacy-consult-forks.ts` (`legacyConsultForkDir`, `LEGACY_FORK_TTL_MS`, `sweepLegacyConsultForks`, with a minimal header-head scan equivalent to the old `scanSessionHead(file).ok`). `fork-store.ts` exports (`consultSessionDir`, `sweepForkDir`, `FORK_TTL_MS`, `ForkSweepResult`) keep their signatures and delegate. `stack.ts` sweep call and `schedule/agent/wire.ts` use the new module.
- New `tests/runtime/legacy-consult-forks.test.ts`: plain/secure roots, TTL and fragment rules, subdirectory/missing-dir safety, header edge cases, fork-store delegation parity.

## Not changed

Nothing deleted. `tests/fixtures/**`, `tests/secure/**`, `tests/consult/**` (other than the moved watcher test) untouched. Comment-only mentions of `CONSULT_READONLY_TOOLS` remain in `src/runtime/session-driver.ts:908` and `src/core/types.ts:604` (outside the P0 file domain; PS1a/PS1b).

## Verification

See the commit message / reply for the command outputs: closure checks (only the alias line + shim/header comments), P0 targeted vitest (93 files, 1501 tests green), typecheck, prettier, fixtures diff = 0.
