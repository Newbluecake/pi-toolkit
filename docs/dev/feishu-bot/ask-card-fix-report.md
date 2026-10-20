# ask_user card PATCH field fix — 2026-10-20

## Root cause and evidence

The interactive JSON was invalid for Feishu schema 2.0. This was **not** caused by long option labels, option count,
`column_set` callbacks, `update_multi`, or the 20 KB cap for the reported dialogs.

Read-only evidence:

- State: `~/.pi/agent/web-hub/feishu-bot/state.json`. Both reported `fd9C-K9…` / `fdn4fi…` records belong to the reported
  agent and bound session `01a1333a…` (label 认知进化); the binding has no offline flag. The second short code is `#f4a308`.
- Each card has six persisted nonces: four options, submit, cancel. Nonce message ids match the card, tenant matches the
  pinned tenant, installation generations match the installed credentials, and the nonce operators remain allow-listed.
  Thus binding/source-dialog/epoch/active-install/tenant/operator/allow-list gates **were passed when these nonces were
  issued**. Initial card creation also proves `deps.session(agentKey)` matched the binding then. This is not a reconstruction
  of every later call: the old code did not log gates or PATCH results, and a failed commit on an individual call cannot be
  retrospectively excluded from persisted nonces alone.
- Session: `~/.pi/agent/sessions/--home-bluecake-ai-rsi-evo--/2026-10-13T03-07-09-578Z_01a1333a-6d8a-73c3-871c-9521ede29b4c.jsonl`,
  ask_user calls at lines 1675 and 1692. Both have one question, four short Chinese option labels, no descriptions,
  no multiSelect, and no explicit allowOther (so the Other input is generated). Neither is an excessive-options/long-label case.
- Hub log 12:01–12:09Z: both Feishu prompts were dispatched to the reported agent; successful LAN `dialog_answer` calls at
  12:03:00Z and 12:09:16Z match these dialog ids. There is no PATCH failure trace because the old service discarded
  non-capability failures. No successful interactive PATCH should be inferred from these web answers.
- `git blame` attributes both invalid fields to F8 commit `f6d528da7`; they remain in the pre-fix HEAD and the reported old
  running code. State's `#95df6b` record is a different agent, created **2026-10-20T10:11:45.276Z** (not October 19). Its
  historical client appearance/success cannot be established from state alone; this report does not claim to explain it.

### Real tenant probes (exactly two cards, both deleted)

Both initial cards were prefixed `[pi-toolkit 自检，可忽略]` in the bound p2p chat. No credentials, tokens or raw responses were
printed or stored in this repository. No connector/second long connection was started.

```text
probe 1 POST placeholder: code=0, success
probe 1 PATCH old shape: code=230099
  ErrCode: 11310
  ErrPath: ROOT -> body -> elements -> [1](tag: form)
  ErrMsg: max_length exceed the default maximum 1000
probe 1 PATCH changing only max_length to 1000: code=230099
  ErrCode: 300123
  ErrPath: ROOT -> body -> elements -> [1](tag: form)
  ErrMsg: there is no submit button in the form container, at least one
probe 1 DELETE: code=0, success
probe 2 POST placeholder: code=0, success
probe 2 PATCH max_length=1000 + form_action_type="submit": code=0, success
probe 2 PATCH same layout with long Chinese/emoji labels: code=0, success
probe 2 DELETE: code=0, success
```

The successful corrected PATCH retained schema 2.0, `config.update_multi:true`, select + Skip + input + form-submit,
and option/cancel callback `behaviors` inside `column_set`. It demonstrates server acceptance, **not** a phone-client
click/form-submit acceptance test. No third card was sent.

## Design → implementation

Design amendment: [plan.md §6.3.1](plan.md#631-patch-recovery-and-phone-links-2026-10-20-field-fix).

| Requirement                                                                                       | Implementation                                           |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Valid schema-2.0 input and submit                                                                 | `src/web-hub/hub/feishu/dialogs.ts:267`, `:274`          |
| Initial card already contains questions/options/text hint; bounded JSON                           | `src/web-hub/hub/feishu/dialogs.ts:73`, `:421`           |
| One non-capability failure fallback, without marking a live dialog closed                         | `src/web-hub/hub/feishu/dialogs.ts:300-314`              |
| Refresh early-return reasons, including binding/session mismatch and commit failure               | `src/web-hub/hub/feishu/dialogs.ts:187-208`, `:296-298`  |
| Typed PATCH result, failure API code/safe msg, existing capability handling                       | `src/web-hub/hub/feishu/service.ts:545-565`              |
| Once/minute per reason, 20/minute overall, 64 keys; no arbitrary reflected prose                  | `src/web-hub/hub/feishu/diagnostics.ts:8-43`             |
| Reverse-proxy → latest authenticated direct LAN Host → first non-loopback allowed Host → loopback | `src/web-hub/hub/feishu/link.ts:5-46`                    |
| Invalid injected URL → `web 会话页面`, shared by all existing Feishu deep-link uses               | `src/web-hub/hub/feishu/link.ts:49-59`, `service.ts:394` |
| Observe only successful cookie auth, after Host admission; memory-only                            | `src/web-hub/hub/http.ts:1521-1527`, `ports.ts:117`      |
| Hub assembly and shared link port for dialogs/notices/F8 unattributed fallback                    | `src/web-hub/hub/hub.ts:605-609`, `:878`, `:1491`        |

Quick-button display text is limited to 40 Unicode code points, selector text to 80; full option labels remain in the
question markdown and index-based answers map to original labels. At most eight quick options / three columns per row;
99 select options plus Skip is a conservative local control cap, not a claimed new tenant measurement. Oversized
controls/JSON use the same text-card fallback. Text-card fields shrink only to honor 20000 serialized UTF-8 bytes; at an
extreme size the card explicitly points to the full web content.

The non-interactive fallback is a **closed-card rendering**, not a closed dialog state. Single-question text answers still
work through existing admission. Multi-question text answering remains unsupported per R2-g and is honestly redirected to web.
If both PATCH calls fail, the already-sent initial card still contains the questions and options. Existing recall behavior is
preserved; an in-flight failure cannot initiate fallback after authoritative settlement.

## Verification

Behavior assertions cover long labels/full-label answer mapping, corrected native fields, initial/failure cards, single-question
text answer after failure, multi-question web fallback, capability errors, 8 s stuck calls, settlement races, count/byte caps,
early-return diagnostics, API code/msg privacy, URL priority/invalid inputs/allow-list revalidation, real HTTP auth observation,
and hub assembly. Existing Feishu integration tests also run.

Final requested gate tails (real output):

```text
$ npx vitest run tests/web-hub/hub tests/integration/web-hub-feishu-bot.test.ts
 Test Files  180 passed (180)
      Tests  4317 passed (4317)
   Start at  20:34:43
   Duration  62.58s (transform 6.97s, setup 3.16s, collect 25.69s, tests 286.16s, environment 31ms, prepare 9.67s)
VITEST_EXIT=0

$ npx tsc --noEmit -p tsconfig.json
TSC_EXIT=0

$ npx prettier --check src/web-hub/hub/feishu/{dialogs,service,diagnostics,link}.ts src/web-hub/hub/{hub,http,ports}.ts tests/web-hub/hub/feishu/{dialogs,service,diagnostics,link,link-auth}.test.ts tests/web-hub/hub/hub-feishu.test.ts docs/dev/feishu-bot/{plan,README,ask-card-fix-report}.md
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ npm run build
> pi-toolkit@0.6.3 build
> tsc -p tsconfig.build.json
BUILD_EXIT=0
```

Extra gates: `npm run typecheck` (all three project checks) exit 0; `npx vitest run tests/web-hub/http`:
71 files / 844 tests passed (17.73 s). `git diff --check` on the exact changed domains passed.
One intermediate rerun was blocked by a concurrent type error in `src/fabric/wake.ts`; its owner corrected it without
any edits from this task, and the final TypeScript/build reruns above are green.

Changed files (all under `/home/bluecake/ai/pi-toolkit/`):

- `src/web-hub/hub/feishu/dialogs.ts`
- `src/web-hub/hub/feishu/service.ts`
- `src/web-hub/hub/feishu/diagnostics.ts` (new)
- `src/web-hub/hub/feishu/link.ts` (new)
- `src/web-hub/hub/http.ts`
- `src/web-hub/hub/hub.ts`
- `src/web-hub/hub/ports.ts`
- `tests/web-hub/hub/feishu/dialogs.test.ts`
- `tests/web-hub/hub/feishu/service.test.ts`
- `tests/web-hub/hub/feishu/diagnostics.test.ts` (new)
- `tests/web-hub/hub/feishu/link.test.ts` (new)
- `tests/web-hub/hub/feishu/link-auth.test.ts` (new)
- `tests/web-hub/hub/hub-feishu.test.ts`
- `docs/dev/feishu-bot/plan.md`
- `docs/dev/feishu-bot/README.md`
- `docs/dev/feishu-bot/ask-card-fix-report.md` (new)

## Remaining acceptance / operation

- No production hub restart, live dialog replay, commit or stash was performed. Updating the running daemon requires
  `/reload` then `/webhub restart`; this report does not claim the old daemon has been replaced.
- Phone-side button click/form submission and the selected LAN/reverse-proxy URL still need user acceptance. The two-card
  allowance was spent only on server validation probes and both cards were removed successfully.
- Unknown API message prose is deliberately omitted from logs (it can echo user content); numeric API/inner codes and known
  validation descriptions remain available. The original 12:01–12:09Z PATCH responses are unrecoverable from the old log.
- W2/concurrent-agent files outside the exact Feishu/web-hub/doc paths were not edited. No new timers, packages, auth grants,
  persistence schema, environment/config seams or automatic retries were added.
