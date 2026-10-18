import { describe, expect, it } from "vitest";
import { dirOfPreviewPath, resolveMdLinkTarget } from "../../../src/web-hub/ui/src/logic/mdLinkPath.js";

const SC = { cwd: "/p", abs: true, dirs: true } as const;

describe("mdLinkPath", () => {
  it("dirOfPreviewPath", () => {
    expect(dirOfPreviewPath("/a/b/c.md")).toBe("/a/b");
    expect(dirOfPreviewPath("/c.md")).toBe("/");
    expect(dirOfPreviewPath("c.md")).toBeNull();
    expect(dirOfPreviewPath("")).toBeNull();
  });
  it("resolves ../ against the file dir", () => {
    expect(resolveMdLinkTarget("../dev/web-hub/arch.md", "/r/docs/guide", SC)).toEqual({
      path: "/r/docs/dev/web-hub/arch.md",
      dir: false,
    });
    expect(resolveMdLinkTarget("./x.md", "/r/docs", SC)?.path).toBe("/r/docs/x.md");
    expect(resolveMdLinkTarget("x/y.md", "/r", SC)?.path).toBe("/r/x/y.md");
  });
  it("absolute targets ignore the base; strips query/fragment; decodes", () => {
    expect(resolveMdLinkTarget("/abs/x.md?a=1#h", "/r", SC)?.path).toBe("/abs/x.md");
    expect(resolveMdLinkTarget("a%20b.md#h", "/r", SC)?.path).toBe("/r/a b.md");
  });
  it("falls back to cwd when no base; never escapes /", () => {
    expect(resolveMdLinkTarget("a.md", null, SC)?.path).toBe("/p/a.md");
    expect(resolveMdLinkTarget("../../../../x.md", "/r", SC)?.path).toBe("/x.md");
    expect(resolveMdLinkTarget("/../../etc/x", "/r", SC)?.path).toBe("/etc/x");
  });
  it("directories need preview.dir; trailing slash folds out", () => {
    expect(resolveMdLinkTarget("../dev/spawn/", "/r/docs/guide", SC)).toEqual({ path: "/r/docs/dev/spawn", dir: true });
    expect(resolveMdLinkTarget("../dev/spawn/", "/r/docs/guide", { cwd: "/p", abs: true })).toBeNull();
  });
  it("null when empty / no scope / outside cwd without abs / tilde without cap / control chars", () => {
    expect(resolveMdLinkTarget("#h", "/r", SC)).toBeNull();
    expect(resolveMdLinkTarget("a.md", "/r", null)).toBeNull();
    expect(resolveMdLinkTarget("a.md", "/r", { cwd: "/p" })).toBeNull();
    expect(resolveMdLinkTarget("a.md", "/p/sub", { cwd: "/p" })?.path).toBe("/p/sub/a.md");
    expect(resolveMdLinkTarget("a.md", "~/n", SC)).toBeNull();
    expect(resolveMdLinkTarget("../a.md", "~/n", { ...SC, tilde: true })?.path).toBe("~/a.md");
    expect(resolveMdLinkTarget("../../a.md", "~/n", { ...SC, tilde: true })).toBeNull();
    expect(resolveMdLinkTarget("a%00.md", "/r", SC)).toBeNull();
    expect(resolveMdLinkTarget("rel.md", "", { cwd: null, abs: true })).toBeNull();
  });
});
