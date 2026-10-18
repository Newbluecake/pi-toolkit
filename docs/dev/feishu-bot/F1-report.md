# F1 report — pbbp2 codec and bounded fragment reassembly

Implemented `plan.md` §2.3 / §14 F1, with the **R2-i main-session ruling** and the separately approved ACK header-cap asymmetry. No commits. Frozen `src/web-hub/protocol/feishu.ts` and all other packages' files are untouched.

## Files

- `src/web-hub/hub/feishu/frame.ts` — independently implemented pbbp2 wire codec, header helpers, ACK/ping/pong builders.
- `src/web-hub/hub/feishu/chunks.ts` — bounded fragment cache with an injected clock.
- `scripts/dev/feishu-vectors.ts` — upstream-only vector generator; regeneration commands in its header.
- `tests/fixtures/feishu/pbbp2-vectors.json` — 138 upstream-encoded vectors and provenance.
- `tests/web-hub/hub/feishu/frame.test.ts` — 207 tests.
- `tests/web-hub/hub/feishu/chunks.test.ts` — 52 tests.
- `docs/dev/feishu-bot/F1-report.md` — this hand-off.

Both production modules are pure: no I/O, sockets, timers, pi imports, or module-scope mutable state. Every limit/payload comes from `FEISHU_FRAME_LIMITS`, `FEISHU_CHUNK_LIMITS`, and `FEISHU_ACK`; nothing was redeclared. There is no new dependency.

## Public API

### `frame.ts`

- `Frame`: `{seqId:bigint, logId:bigint, service:number, method:number, headers:Header[], payloadEncoding?, payloadType?, payload?:Uint8Array, logIdNew?:string}`. `Header` is `{key,value}`. Field 9 is a **string**, not uint64.
- `encodeFrame(frame): Uint8Array`: canonical upstream field order; required 1–4 always emitted, optional 6–9 only when owned and set (empty is distinct from absent). IDs retain all 64 bits; negative int32 uses the upstream ten-byte varint encoding. Near-limit payloads are copied with bounded segments, never spread into call arguments.
- `decodeFrame(input: unknown): Frame`: accepts `Uint8Array` (including Buffer slices) and `ArrayBuffer`, rejects everything else synchronously. Skips unknown wire types 0/1/2/5, checks required/nested fields and UTF-8 strings, preserves optional presence and unknown headers in order. Payload bytes are opaque and copied, **not parsed here**.
- `FrameError` / `FrameErrorCode`: fixed diagnostic codes only (no untrusted contents). F3 can catch, increment a counter by `code`, and not ACK.
- `header(frame,key)`: **last-wins** event-header lookup, safely handles names such as `__proto__` without using a mutable object dictionary.
- `controlType(frame)`: **first-wins** control `type`, matching upstream `Array.find` (R2-i).
- `ackFrame(frame,elapsedMs=0)`: copies every inbound header and echoes 1–7/9, appends `biz_rt`, replaces payload with `FEISHU_ACK.payload` (`{"code":200}`). Elapsed time is floored/clamped to `[0, 2^31−1]` milliseconds so `biz_rt` is always a decimal integer, never exponent notation; NaN/Infinity becomes zero. Builder only: it does not authorize a send or imply durability.
- `pingFrame(service)`: SDK client ping shape (zero IDs, method 0, type ping).
- `pongFrame(service,config?)`: server/fixture convenience builder (zero IDs, method 0, type pong, optional JSON config). **The client must never use this to answer a server ping**: SDK ignores server pings.

**Approved header-cap asymmetry:** decoder always rejects more than 64 headers, even ACK-shaped inbound data. Encoder allows exactly one extra header (65 total) **only** when the final header is `biz_rt` and the owned payload equals the exact frozen ACK payload. A 64-header incoming frame can therefore be echoed without dropping unknown headers. 66 headers, different final key, different/missing/inherited payload all fail. Header key/value byte caps and the 1 MiB encoded-frame cap still apply. The test compares the 65-header result against independently constructed protobuf bytes, not merely successful encoding.

### `chunks.ts`

```ts
const fragments = new Fragments(() => performance.now()); // finite monotonic ms
const result = fragments.add(frame);
// {status:"pending", duplicate:boolean}
// | {status:"complete", payload:Uint8Array}
// | {status:"rejected", reason:ChunkRejection}
fragments.sweep(); // returns number of expired sets
fragments.stats(); // {messages, bytes}; observation only, does not sweep
fragments.clear(); // idempotent; releases all stored chunks/accounting
```

- `message_id`, `sum`, `seq` use last-wins header lookup. ID must be nonempty and within the frozen header-value byte cap. Numeric metadata is decimal digits (leading zeros accepted), not JS expressions, whitespace, hex, or exponent forms; resulting integers must satisfy `sum ∈ [1,64]`, `seq ∈ [0,sum)`. Missing payload is rejected; an explicitly empty payload is valid.
- Out-of-order arrival is supported. A duplicate `seq` **replaces** bytes (including a conflicting value), matching upstream and R2-i. Accounting applies the byte delta, including shrinkage. Conflicting `sum` refuses only that arrival and leaves the first set intact.
- TTL starts at the **first** fragment and expires at exactly 10,000 ms; subsequent/duplicate fragments do not refresh it. `add` sweeps before admission; `sweep` is optional for an owner's existing maintenance tick. No timer is created. This is a deterministic strict 10 s TTL, not upstream's coarse 10 s interval sweep.
- At 16 pending sets, new **partial** sets are refused; existing sets may progress. A valid `sum=1` message returns an independently owned payload immediately without insertion or accounting changes, even when both storage caps are full; conflicting `sum` for an existing message ID still rejects, and the per-message 4 MiB bound still applies. Per-message 4 MiB / total 8 MiB checks happen before copy or mutation for cached fragments, including replacements. Overflow never evicts partial sets or corrupts previous bytes. Completion removes the set and returns an independently owned, sequence-ordered byte array.
- **Existing-set aggregate-cap decision (verifier follow-up #2):** retained the hard 8 MiB storage bound for existing partial sets too. Same-size/shrinking replacements and empty missing fragments are admitted at the cap; growth is admitted whenever its delta fits the remaining aggregate budget and its own 4 MiB bound. If growth would exceed 8 MiB, it is refused even for an existing set: admitting it would require either exceeding the cap or evicting another partial set. Tests pin zero-growth acceptance, growth refusal preserving bytes/accounting, and successful growth once a replacement releases space. This is intentionally stricter than reading “refuse new chunk sets” as unlimited existing-set growth.
- **Invalid-clock decision (verifier follow-up #4):** a non-finite clock read (`NaN`, `±Infinity`) treats every pending set as expired, frees all count/byte accounting, and makes `add` reject with `invalid-clock` until a finite clock reading returns. `sweep` reports the number expired. No partial set can become immortal from invalid clock arithmetic. The finite monotonic-clock caller contract otherwise remains unchanged.
- Rejections: `fragment-meta`, `fragment-payload`, `fragment-sum`, `message-capacity`, `message-too-large`, `total-too-large`, `invalid-clock`. These are not throws; F3 must counter and not ACK. Partial arrivals also do not authorize ACK. Completed-message redelivery is deliberately **not deduplicated** here.

## Malformed-frame / limits coverage map

| Plan condition                                          | F1 behavior and evidence                                                                                                                                                                                                                                                            | F3 responsibility                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Non-binary WS data                                      | `frame.test.ts`: non-binary matrix; ArrayBuffer/Buffer-offset positive controls                                                                                                                                                                                                     | Drop + counter, no ACK. Set WS binary mode or convert Blob under a generation fence before calling the codec.                                                                                          |
| Protobuf decode error                                   | Independent raw-byte matrix: required fields, truncated/overflow varints, invalid tags, wrong wires, unknown group wires, truncated lengths/fixed fields, nested boundary overrun, missing header key/value, invalid UTF-8 metadata. Unknown 0/1/2/5 fields have positive controls. | Drop + counter, no ACK.                                                                                                                                                                                |
| Frame >1 MiB                                            | Exact-limit positive control and +1 refusal, encode and decode                                                                                                                                                                                                                      | R2-d residual: WS has already allocated the whole incoming frame before this check.                                                                                                                    |
| >64 headers / >4 KiB key or value                       | 64/65 admission boundary, byte-not-character multibyte limits, repeated-field cap bypass refusal; explicit outgoing ACK exception                                                                                                                                                   | Keep inbound admission strict; send failure must not bypass framing limits.                                                                                                                            |
| Control unknown type / server ping                      | Helpers pin control-first/event-last semantics; ping/pong bytes match upstream vectors. No handling side effects in F1.                                                                                                                                                             | Ignore + counter; server ping is ignored; parse/clamp pong config or ignore malformed config.                                                                                                          |
| Data `type != event` (legacy card included)             | Header bytes/type values are preserved; no routing or side effects in F1.                                                                                                                                                                                                           | **R2-i supersedes §2.3: ignore + counter, NO ACK**, matching pinned SDK and probe.                                                                                                                     |
| Invalid chunk metadata / conflicting sum                | `chunks.test.ts` malformed metadata matrix, missing fields, 64/63 positive boundary, conflict preserves first set                                                                                                                                                                   | Drop arrival + counter, no ACK.                                                                                                                                                                        |
| Duplicate/out-of-order/empty fragments                  | SDK replacement behavior, growth/shrink accounting, independent IDs, split-code-point vector assembly, input/output ownership                                                                                                                                                       | Do not dispatch/ACK partial sets; durable dedup after full assembly.                                                                                                                                   |
| Chunk TTL / 16 / 4 MiB / 8 MiB                          | Exact boundaries and +1 refusals; no eviction; existing-set growth/replacement refusal rollback; expiry frees slots AND bytes                                                                                                                                                       | Inject monotonic clock; clear/discard cache on connection retirement.                                                                                                                                  |
| Assembled payload encoding, UTF-8/JSON, envelope schema | Unknown encoding and invalid payload bytes survive codec unchanged; UTF-8 is not decoded per fragment.                                                                                                                                                                              | Parse only complete payload; apply durable `undecodable` → ACK → degraded/notice policy. Empty `payloadEncoding` is normal (tenant V6). Envelope validation and persistence are NOT implemented by F1. |
| R2-d generations / socket and close bounds              | F1 intentionally owns no generation/socket/timer state                                                                                                                                                                                                                              | Fence all async conversions/handlers/ACKs; ≤2 physical sockets, close/termination bounds and stop behavior belong to F3.                                                                               |

Codec hardening deliberately rejects malformed protobuf/UTF-8 metadata rather than reproducing protobufjs's permissive malformed decoding. Valid wire bytes are pinned against upstream; all payload interpretation and ACK policy stay outside F1.

## Vector provenance and regeneration

Reference files read over HTTPS at immutable commit `b188be60134d409b61259546bcf69c731d2b0b7c`: `ws-client/proto-buf/pbbp2.js`, `ws-client/data-cache.ts`, `ws-client/index.ts`, and `ws-client/enum.ts`.

- Pinned `pbbp2.js` SHA-256: `f7989fe3472ef2ea51a5ad9851a956bf978eb5dcc4eeb6258020cf2f16c04ee8` (generator checks before evaluation).
- Generator invokes **upstream Frame.encode**, never our codec. Only the two ESM exports are removed for a CJS VM wrapper so upstream's own `require("protobufjs/minimal")` works. Protobufjs **7.6.6** was used (upstream range `^7.2.6`); it is resolved from the scratch SDK, not added to this package's dependencies.
- Ten curated vectors: ping, pong/config, synthetic tenant-shaped event (empty encoding + extra frontier/instance/trace headers), two chunks splitting a multibyte character, ACK, zero requireds, present-empty optionals, negative int32/full-width IDs, Unicode/BOM/duplicate headers. Another 128 vectors use fixed seed `0x188be601`.
- Upstream's `util.Long = undefined` makes its decoder round uint64 above 2^53. Generator passes explicit low/high words to its **writer** and preserves exact decimal IDs in JSON; our decoder verifies all bits independently. Upstream decoded fields are also sanity-checked with its documented Number precision.
- The fixture contains synthetic data only; no credentials, live IDs, or tenant text.
- An additional scratch-only deterministic differential harness (seed `0x520188be`) checked **3,000** varied frames against this pinned upstream encoder, including full-width IDs, signed int32s, Unicode/BOM/NUL headers, optional-field combinations, and arbitrary payload bytes. Both byte equality and independent production decoding passed; this is additional evidence, not a runtime SDK dependency.
- Regeneration instructions are in the generator header. This run used the exact SHA-checked HTTPS source in a scratch tree and the already installed protobufjs 7.6.6 via a scratch-only node_modules link. No upstream source or dependency change was copied into the repository. Two generator+Prettier runs produced identical fixture SHA-256: `49dc06e48f3fc322570bb7f966dcd0583e45aac495767eaa337330922f132c5f`.

## F3 hand-off

1. Import the codec/builders/cache directly; no frozen-surface changes are required. Create `new Fragments(monotonicNow)` per connection generation; clear/discard on close/stop. F1 has no generation fencing and no async callbacks.
2. Set binary WS delivery, `decodeFrame`, route method 0 with `controlType` and method 1 with `header(frame,"type")`. **R2-i: non-event data is not ACKed; server ping is not answered.** Unknown methods/control types are ignored/counted.
3. Feed only event frames into `add`. Rejected/pending results cannot be ACKed. On complete, parse assembled bytes and keep the **completion-arrival Frame** for ACK, as upstream does (not a synthetic reassembled frame).
4. Match tenant facts: empty `payloadEncoding` is normal; unknown headers must be ignored semantically but echoed. Interpret encoding/UTF-8/JSON/schema only after assembly; durably record undecodable input before ACK/degraded/notice. Never treat successful framing as successful event processing.
5. `ackFrame` merely constructs data. Only call/send it after durable receipt and a final live-generation/current-socket check. Encoding can still refuse an oversized echo (e.g. very large optional metadata), so handle that failure without sending an invalid frame. ACKs are never transferred to a replacement socket.
6. F3 owns group commits, dedup/persist failure behavior, liveness, pong parsing/clamps, bootstrap retries, backpressure, stale-generation suppression, physical socket bounds, and the R2-d platform-allocation residual. None was smuggled into F1.

## Self-verification

- `timeout 280 npm run typecheck` — **PASS** (tsc ×2 + vue-tsc).
- `timeout 280 npm run build` — **PASS**.
- `timeout 300 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts` — **PASS**, latest run 6 files / **459 tests**, including concurrently landed F2 http/token/api tests. After verifier follow-ups, F1 alone is 207 frame + 52 chunks; boundary adds 11 and F2 adds 189.
- `timeout 20 npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck tests/web-hub/hub/feishu/frame.test.ts tests/web-hub/hub/feishu/chunks.test.ts scripts/dev/feishu-vectors.ts` — **PASS** (extra check because root tsconfig excludes these tests/scripts).
- `timeout 40 npx prettier --check` with the seven explicit F1 paths — **PASS**. Prettier writes were restricted to those paths. Full-repository formatting/tests were not run in this concurrent package workspace.

Verifier conditional-pass follow-ups #1–#4 are resolved: uncached single-fragment fast path, explicit existing-set aggregate-budget policy, bounded decimal `biz_rt`, and fail-closed non-finite clock handling. Each is pinned by behavioral assertions; no frozen-file changes or commits. All transport/persistence responsibilities above remain intentionally deferred to F3/F6, not claimed as passing by pure unit tests.
