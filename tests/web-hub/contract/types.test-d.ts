/**
 * Compile-time contract test (plan §11 "typecheck" row): pins the frozen
 * type-level guarantees that a plain `vitest run` (which only type-strips via
 * esbuild) cannot catch on its own. This repo's `tsconfig.json` `include`
 * only covers `src/**`, and `vitest.config.ts` has no `test.typecheck` block,
 * so — unlike a project wired for `vitest typecheck` — the `expectTypeOf`
 * assertions below are enforced by running `tsc --noEmit` with this file
 * temporarily added to the program (documented in the W1 delivery report;
 * not a permanent script change, since editing `tsconfig.json`'s `include`
 * risks `tsconfig.build.json`'s `rootDir: "src"` and pulling all of `tests/`
 * into the build). At the vitest-run level this file still executes its
 * `it()` bodies (all no-ops at runtime — `expectTypeOf(...).toEqualTypeOf<...>()`
 * never throws) so a collection/syntax regression is still caught.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { FrontendDeps, HubConfig } from "../../../src/web-hub/hub/ports.js";
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
});
