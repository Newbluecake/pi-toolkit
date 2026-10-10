/**
 * tilde-expansion addendum — `hub/preview/tilde.ts`'s `expandTildePath`. Pure, zero-fs: these
 * tests pin the exact string transformation the route layer relies on BEFORE any admission
 * check runs (see routes.test.ts / api-preview.test.ts for the full admission-chain coverage
 * through a real tmpdir).
 */

import { describe, expect, it } from "vitest";
import { expandTildePath } from "../../../../src/web-hub/hub/preview/tilde.js";

describe("expandTildePath", () => {
  const HOME = "/home/tester";

  it("expands a bare `~` to the literal home", () => {
    expect(expandTildePath("~", HOME)).toBe(HOME);
  });

  it("expands `~/<rest>` by splicing home in place of the tilde", () => {
    expect(expandTildePath("~/snap/x.png", HOME)).toBe(`${HOME}/snap/x.png`);
    expect(expandTildePath("~/a", HOME)).toBe(`${HOME}/a`);
    expect(expandTildePath("~/", HOME)).toBe(`${HOME}/`);
  });

  it("never expands `~user/...` (only a BARE ~ expands, POSIX shell semantics)", () => {
    expect(expandTildePath("~bob/x", HOME)).toBe("~bob/x");
    expect(expandTildePath("~root/.ssh/id_rsa", HOME)).toBe("~root/.ssh/id_rsa");
    expect(expandTildePath("~.hidden", HOME)).toBe("~.hidden");
  });

  it("leaves ordinary absolute paths, and anything else, byte-identical", () => {
    expect(expandTildePath("/a/b", HOME)).toBe("/a/b");
    expect(expandTildePath("", HOME)).toBe("");
    expect(expandTildePath("relative/x", HOME)).toBe("relative/x");
    expect(expandTildePath("~~/x", HOME)).toBe("~~/x"); // doesn't start with "~/" OR equal "~"
  });

  it("degrades to a no-op when home is empty (defensive — never happens at runtime)", () => {
    expect(expandTildePath("~/x", "")).toBe("~/x");
    expect(expandTildePath("~", "")).toBe("~");
  });

  it("a trailing-slash home is never produced by resolvePreviewDenyContext, but the function itself does not re-trim — the CALLER's convention (home already trimmed) is what keeps the splice correct", () => {
    // documents the contract rather than asserting a defensive re-trim: callers MUST pass a
    // trimmed home (resolvePreviewDenyContext / denyCtxOf both already trim).
    expect(expandTildePath("~/x", "/home/tester/")).toBe("/home/tester//x");
  });
});
