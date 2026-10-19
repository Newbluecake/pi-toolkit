# created-dirs — F5 golden delta (reviewed per key)

Plan: `docs/dev/web-hub-spawn/created-dirs-plan.md` r2 §7. Fixture: `tests/fixtures/feishu-spawn-http-golden.json`.
Rules followed: **no regeneration, no `BASELINE_SHA` change, no masking of E_DIR** — the fixture was
hand-edited in place (single line), `golden.setup.ts` / `golden.config.ts` are untouched.

## Procedure

1. Baseline on the untouched tree (`timeout 900 npx vitest run --config tests/web-hub/hub/spawn/golden.config.ts`):
   9 files / 192 tests green.
2. Implemented P2, re-ran the HTTP-layer golden files: exactly **one** key differed (below). Every other
   key — all loopback E_DIR bodies, every LAN confirm/202/409 body, every mkdir body and audit line —
   stayed byte-identical (the mkdir tests in `api-headless-mkdir.test.ts` wire no `createdDirs`/roots,
   so their replies are the legacy `{ok,path}`).
3. Grep of the fixture for every other `not-allowed` / LAN E_DIR entry:
   - `api-headless.test.ts :: … admit rejections map 1:1 onto 400 E_DIR{reason}` (fixture line 67) —
     **loopback** listener, `not-allowed` body stays `{"error":"E_DIR","reason":"not-allowed"}`, length 40
     (pinned unchanged; the whole point of the LAN-only `detail`).
   - `lan-headless.test.ts :: LAN scope threading … unknown dir rejected` (fixture line 275) — the only
     LAN `not-allowed` entry ⇒ the one delta below.
   - Other E_DIR entries (`browse-unavailable`, `session-changed`, `session-too-large`, `session-missing`,
     `moved`) carry other reasons and are unaffected (`detail` is only ever added to `not-allowed`).

## Per-key before / after

### `tests/web-hub/http/lan-headless.test.ts :: LAN scope threading (arch §6.4: roots capped to known on plaintext direct) > lan:roots + plain-HTTP DIRECT ⇒ policy gets (http,false), scope known ⇒ unknown dir rejected`

Why: LAN listener, `lan:"roots"` on a plaintext direct connection ⇒ `lanScopeCap("roots","http",false)`
= `"plaintext-lan"` ⇒ the LAN-only `detail` is added to the `E_DIR{not-allowed}` body.

| field            | before                                            | after                                                               |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| status           | `400`                                             | `400`                                                               |
| body             | `{"error":"E_DIR","reason":"not-allowed"}`        | `{"error":"E_DIR","reason":"not-allowed","detail":"plaintext-lan"}` |
| `content-length` | `40`                                              | `65` (= 40 + `,"detail":"plaintext-lan"` 25 bytes)                  |
| other headers    | unchanged                                         | unchanged                                                           |
| `audits`         | one reject line, `code:"E_DIR"`, `listener:"lan"` | **unchanged** (the audit line never carries the detail)             |

The test's own assertion (`lan-headless.test.ts`, the `toEqual({ error: "E_DIR", reason: "not-allowed" })`
right after `expect(res.status).toBe(400)`) was updated in the same way; the test name — the golden key —
is unchanged.

## Unchanged-by-design keys (explicitly pinned)

- Loopback `E_DIR{not-allowed}` — `api-headless.test.ts:311-320` untouched, golden line 67 untouched.
- mkdir success/failure bodies and audits — no recorded dir in these tests (no roots, no store), so `known`
  never appears; the new recording behavior is covered only by non-golden files
  (`tests/web-hub/http/lan-spawn-created-dirs.test.ts`, `tests/integration/web-hub-created-dirs.test.ts`).
