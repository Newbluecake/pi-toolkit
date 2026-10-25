# PT report — Agent tool / schedule / wording (#40, base b8f9a43e)

## What changed

- **Agent tool**: `experts` removed from both schemas (top-level and nested); `timeout_s` text no longer says "consult, "; `meta.abArm`, the A/B consistency checks, `expertEcho` and `AB_ARM_EXPERTS_OPTIONAL_AGENT_TYPES` removed. An `experts` argument is ignored with one notice line (`prepared.notices`); nothing reaches the spawn request. `deps.resolveExperts?` kept as `@deprecated`, never read (PS1b drops it).
- **dispatch meta**: `abArm` removed from `DispatchMeta`/`DISPATCH_META_KEYS` (now an unknown key); new `pickInheritableDispatchMeta`, used by `resolveResumeTarget` — a legacy `abArm` in an old run entry is dropped on resume.
- **schedule**: tool param `consultMain` removed; `/schedule --consult` errors, `--no-consult` accepted and ignored; `bg.consultMain` stays a persisted field (defHash unchanged, proven by the frozen vector + a new approval test); executor ignores a legacy `true` and prepends a visible note; `bg`/`executors` `consult?` deps kept `@deprecated`, never read; `view.ts` and `ScheduleReview.vue` show the option only for legacy `true`.
- **wording**: `list-subagents-tool`, `extend-timeout-tool` (error text + description), `quota/render.ts droidPoolAdviceLine` (kept 「不能当验收」+ full-permission note), droid `capabilitiesText` (no "consulting experts"; sentence omitted when nothing is unavailable) and `externalModelsPromptHeader`.
- `MSG_EXPERTS_UNSUPPORTED` / `msgExpertIsExternal` untouched (spawn-service and consult still use them).

## Tests

- `agent-tool-experts.test.ts` rewritten as the compat suite; `agent-tool.test.ts` loses the abArm / arm-consistency cases and gains "abArm is an unknown key"; `dispatch-meta.test.ts` (+`pickInheritableDispatchMeta`); `resolve-target` / `spawn-service` inherit expectations now drop `abArm` (input still carries it); `consult-ab-instrumentation` → `git mv` `dispatch-meta-instrumentation.test.ts`, abArm removed; `explicit-timeout-producers` X2 case deleted; `bg.test.ts` consult cases replaced; `spec.test.ts` +legacy consultMain approval/hash; `commands/schedule.test.ts` +`--consult` error; quota / external-agent expectations updated.
- Outside the appendix-A PT list but required by the changed source string: `tests/tools/extend-timeout-tool.test.ts:260` (one phrase). Not added (out of domain): a `schedule-tool.test.ts` assertion that the schema has no `consultMain`.

## Verification

```
PT targeted: npx vitest run tests/tools tests/schedule tests/quota tests/external-agent tests/core/dispatch-meta.test.ts tests/service tests/commands tests/integration/{explicit-timeout-producers,dispatch-meta-instrumentation,external-disabled-bytes}.test.ts tests/web-hub/ui/schedule-panel.test.ts tests/core/run-journal.test.ts
 Test Files  157 passed (157) · Tests  2455 passed (2455)
tests/tools tests/commands (re-run after prettier): 739 passed
npm run typecheck: clean (tsc ×2 + vue-tsc)
npx prettier --check on changed files: clean (pre-commit hook also ran)
git diff --stat b8f9a43e -- tests/fixtures:
 tests/fixtures/tools/agent-nested-surface-golden.json | 2 +-   (only file)
```

Closure checks (§4.3 PT):

- `rg abArm src/tools src/core/dispatch-meta.ts src/service/resolve-target.ts` → only the legacy-drop comment in `dispatch-meta.ts`.
- `rg -ln abArm src tests scripts` ⊆ allowed list: `src/core/{dispatch-meta,run-journal}.ts` (comments), `tests/core/{dispatch-meta,run-journal}.test.ts`, `tests/service/{resolve-target,spawn-service}.test.ts`, `tests/tools/agent-tool.test.ts`, `tests/service/runtime-adapter-instrumentation.test.ts`; plus PDOC's (`scripts/exp/consult-ab-lib.mjs`, `tests/exp/consult-ab-analyze.test.ts`, `tests/fixtures/consult-ab/**`) which PDOC deletes. `src/service/resolve-target.ts` has no `abArm` token.

Nested golden assertion (script of §4.5 PT, `<base>` = b8f9a43e):

```
nested golden diff OK
```

Not run (as instructed): full suite, `build:web`/`check:web`, conformance.

## Residual / notes

- The `experts` notice line is to be removed at the next minor (R-F3).
- `src/consult/**` still compiles against the retained `@deprecated` deps (`resolveExperts`, `consult?`).
