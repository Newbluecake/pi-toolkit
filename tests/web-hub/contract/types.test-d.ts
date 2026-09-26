/**
 * Compile-time contract test (plan §11 "typecheck" row): pins the frozen
 * type-level guarantees that a plain `vitest run` (which only type-strips via
 * esbuild) cannot catch on its own. Enforced by `npm run typecheck`, which
 * runs `tsc --noEmit -p tsconfig.json` (src/**) *and*
 * `tsc --noEmit -p tsconfig.typecheck.json` (src/** + this file) — review
 * fix #1: this file used to be orphaned (neither `tsconfig.json`'s `include`
 * nor any vitest `test.typecheck` block covered it), so a broken assertion
 * here could pass CI silently. At the `vitest run` level this file also
 * still executes its `it()` bodies (all no-ops at runtime —
 * `expectTypeOf(...).toEqualTypeOf<...>()` never throws) so a
 * collection/syntax regression is caught there too.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { RunningHub } from "../../../src/web-hub/hub/hub.js";
import type {
  ConnGuard,
  ConnLease,
  FrontendDeps,
  HubConfig,
  KdfAdmissionPort,
  LanStorePort,
  LanUserSummary,
  PortOptions,
} from "../../../src/web-hub/hub/ports.js";
import type { SseEventName } from "../../../src/web-hub/hub/sse.js";
import type { FenceLoss, SingletonResult } from "../../../src/web-hub/hub/singleton.js";
import type { HostTokenResult } from "../../../src/web-hub/protocol/lan.js";

describe("types.test-d.ts (plan §11 typecheck contract)", () => {
  it("P1-shaped FrontendDeps (no `lan`) is still assignable to FrontendDeps", () => {
    type P1FrontendDeps = Omit<FrontendDeps, "lan">;
    expectTypeOf<P1FrontendDeps>().toMatchTypeOf<FrontendDeps>();
  });

  it("P1-shaped HubConfig (no `lan`) is still assignable to HubConfig", () => {
    type P1HubConfig = Omit<HubConfig, "lan">;
    expectTypeOf<P1HubConfig>().toMatchTypeOf<HubConfig>();
  });

  it("RunningHub's LAN additions (`lan`, `lanStatus`) are optional / function-typed", () => {
    expectTypeOf<RunningHub["lanStatus"]>().toBeFunction();
    expectTypeOf<undefined>().toMatchTypeOf<RunningHub["lan"]>();
  });

  it("RunningHub.identity is present (required — set at bind time, §1.3.2)", () => {
    expectTypeOf<RunningHub>().toHaveProperty("identity");
    expectTypeOf<RunningHub["identity"]>().not.toBeUndefined();
  });

  it('SseEventName includes "auth"', () => {
    expectTypeOf<"auth">().toMatchTypeOf<SseEventName>();
  });

  it("HostTokenResult's ok:false branch `reason` is exactly the 5 documented literals", () => {
    type Reason = Extract<HostTokenResult, { ok: false }>["reason"];
    expectTypeOf<Reason>().toEqualTypeOf<"syntax" | "denylisted" | "ipv6" | "too-long" | "numeric">();
  });

  it("FenceLoss is exactly the 7 documented literals", () => {
    expectTypeOf<FenceLoss>().toEqualTypeOf<
      | "socket-missing"
      | "socket-replaced"
      | "socket-symlink"
      | "socket-not-socket"
      | "dir-replaced"
      | "owner-mismatch"
      | "io"
    >();
  });

  it('SingletonResult\'s failed.reason includes "aborted"', () => {
    type FailedReason = NonNullable<Extract<SingletonResult, { kind: "failed" }>["reason"]>;
    expectTypeOf<"aborted">().toMatchTypeOf<FailedReason>();
  });

  // Review fix #9 (v1): ConnGuard is a frozen interface (not `unknown`), and admits by lease —
  // never by re-keying on `peerIp` (that would double-release / mis-attribute categories
  // when the same peerIp holds multiple connections). Review fix #4 (v2): admit() also takes an
  // `onEvict` callback so §6.3's "evict an older connection and destroy it" is expressible.
  it("ConnGuard.admit returns a ConnLease | undefined, keyed by lease identity (not peerIp), and takes onEvict", () => {
    expectTypeOf<ConnGuard["admit"]>()
      .parameter(0)
      .toEqualTypeOf<{ peerIp: string; viaTrustedProxy: boolean; onEvict: () => void }>();
    expectTypeOf<ReturnType<ConnGuard["admit"]>>().toEqualTypeOf<ConnLease | undefined>();
    expectTypeOf<ConnLease>().toHaveProperty("release");
    expectTypeOf<ConnLease["release"]>().parameters.toEqualTypeOf<[]>(); // no peerIp/category argument
    expectTypeOf<ConnLease>().toHaveProperty("enterLoginPending");
    expectTypeOf<ConnLease>().toHaveProperty("enterAuthed");
  });

  // Review fix #9: request-level ports that may queue/run long enough to matter accept an
  // optional AbortSignal (deadline *values* stay each port's own implementation detail).
  it("KdfAdmissionPort.acquire and LanStorePort's request-level ops accept opts?: PortOptions", () => {
    expectTypeOf<Parameters<KdfAdmissionPort["acquire"]>[2]>().toEqualTypeOf<PortOptions | undefined>();
    expectTypeOf<Parameters<LanStorePort["touchSession"]>[2]>().toEqualTypeOf<PortOptions | undefined>();
    expectTypeOf<Parameters<LanStorePort["getUser"]>[1]>().toEqualTypeOf<PortOptions | undefined>();
    expectTypeOf<PortOptions>().toHaveProperty("signal");
    expectTypeOf<PortOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
  });

  // Review fix #5 (v2): createSession returns the *raw* sid (for the cookie), never a hash;
  // getUserSummary looks a user up by userId (touchSession's LanSessionRecord.userId) for
  // GET /api/session's {username, initialPasswordInUse} (§7, §5.2).
  it("LanStorePort.createSession returns {sid}; getUserSummary(userId) returns a LanUserSummary", () => {
    expectTypeOf<Awaited<ReturnType<LanStorePort["createSession"]>>>().toEqualTypeOf<{ sid: string }>();
    expectTypeOf<Parameters<LanStorePort["getUserSummary"]>[0]>().toEqualTypeOf<number>();
    expectTypeOf<Awaited<ReturnType<LanStorePort["getUserSummary"]>>>().toEqualTypeOf<LanUserSummary | undefined>();
    expectTypeOf<LanUserSummary>().toEqualTypeOf<{ username: string; initialPasswordInUse: boolean }>();
  });
});
