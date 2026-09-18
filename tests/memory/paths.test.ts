import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPaths, fromSlug, memoryDirFor, toSlug, type MemoryPaths } from "../../src/memory/paths.js";

describe("toSlug", () => {
  it("maps /a/b/ to -a-b (trailing slash stripped, single leading dash)", () => {
    expect(toSlug("/a/b/")).toBe("-a-b");
    expect(toSlug("/a/b")).toBe("-a-b");
    expect(toSlug("/a")).toBe("-a"); // 前导单 dash
    expect(toSlug("/Users/x/local-dev/core")).toBe("-Users-x-local-dev-core");
  });

  it("maps the bare root / to an empty slug (verbatim algorithm, §5.7: the trailing-slash strip eats the lone slash)", () => {
    // NOTE: §7.1's prose bullet "/ → -" is loose; the §5.7 verbatim algorithm
    // (replace(/\/+$/,"").replace(/\//g,"-")) yields "" for "/". Pinned here so
    // any drift from the original plugin's slugging is caught loudly.
    expect(toSlug("/")).toBe("");
  });
});

describe("fromSlug", () => {
  it("round-trips ordinary paths for display", () => {
    expect(fromSlug("-a-b")).toBe("/a/b");
    expect(fromSlug(toSlug("/Users/x/core"))).toBe("/Users/x/core");
  });

  it("is lossy when real directory names contain '-' (registered, display-only)", () => {
    expect(fromSlug(toSlug("/a/my-dir"))).toBe("/a/my/dir"); // not the original path
  });
});

describe("memoryDirFor", () => {
  it("joins memoryRoot with the cwd slug", () => {
    const paths: MemoryPaths = { memoryRoot: "/mem", ccProjectsRoot: "/cc" };
    expect(memoryDirFor("/a/b", paths)).toBe(join("/mem", "-a-b"));
  });

  it("paths injection overrides the default root", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-paths-"));
    const paths: MemoryPaths = { memoryRoot: root, ccProjectsRoot: root };
    expect(memoryDirFor("/x", paths)).toBe(join(root, "-x"));
  });
});

describe("defaultPaths env overrides", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors ARMORY_MEMORY_ROOT / CC_PROJECTS_ROOT (original plugin test hooks)", () => {
    vi.stubEnv("ARMORY_MEMORY_ROOT", "/tmp/custom-mem");
    vi.stubEnv("CC_PROJECTS_ROOT", "/tmp/custom-cc");
    expect(defaultPaths()).toEqual({ memoryRoot: "/tmp/custom-mem", ccProjectsRoot: "/tmp/custom-cc" });
  });

  it("falls back to ~/.pi/agent/memory and ~/.claude/projects without env", () => {
    vi.stubEnv("ARMORY_MEMORY_ROOT", "");
    vi.stubEnv("CC_PROJECTS_ROOT", "");
    const paths = defaultPaths();
    expect(paths.memoryRoot).toMatch(/\.pi\/agent\/memory$/);
    expect(paths.ccProjectsRoot).toMatch(/\.claude\/projects$/);
  });
});
