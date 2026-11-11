// /mem jev & /mem tags command branches (jev-plan §4 J4 第 6 条: 分支路由、
// 子会话/无 UI 拒绝写操作、有端口时状态行、无端口时补全与输出不变).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../src/memory/command.js";
import type { MemoryPaths } from "../../src/memory/paths.js";
import { parseMemorySettings } from "../../src/memory/settings.js";
import type { JevCommandPort, ReviewSuggestionView, TagDefInput } from "../../src/memory/jev/contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): { cwd: string; paths: MemoryPaths } {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-jev-"));
  roots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const memDir = join(tmp, "mem", cwd.replace(/\//g, "-"));
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "core.md"), "# Core\n\n## Rules\n\n- rule one\n", "utf8");
  return { cwd, paths: { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") } };
}

function fakeCtx(cwd: string, opts: { hasUI?: boolean; modelRegistry?: unknown } = {}) {
  const notifications: { message: string; level?: string }[] = [];
  const hasUI = opts.hasUI !== false;
  const ctx = {
    mode: hasUI ? "tui" : "rpc",
    hasUI,
    cwd,
    ...(opts.modelRegistry === undefined ? {} : { modelRegistry: opts.modelRegistry }),
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

/** Recording stub port: every method echoes its name+args. */
function stubPort(over: Partial<JevCommandPort> = {}): JevCommandPort & { calls: string[] } {
  const calls: string[] = [];
  const port: JevCommandPort = {
    statusLine: (cwd) => {
      calls.push(`statusLine:${cwd}`);
      return "jev: full · opencode/jev-1.13-free · 1/1 tagged";
    },
    report: async (cwd) => {
      calls.push(`report:${cwd}`);
      return "REPORT-TEXT";
    },
    probe: async (registry) => {
      calls.push(`probe:${registry === undefined ? "no-reg" : "reg"}`);
      return "PROBE-TEXT";
    },
    retag: async (cwd, all) => {
      calls.push(`retag:${cwd}:${String(all)}`);
      return "RETAG-TEXT";
    },
    resetIndex: async (cwd) => {
      calls.push(`reset-index:${cwd}`);
      return "RESET-TEXT";
    },
    tags: {
      list: (cwd) => {
        calls.push(`tags-list:${cwd}`);
        return "TAGS-LIST-TEXT";
      },
      add: async (cwd, def) => {
        calls.push(`tags-add:${cwd}:${JSON.stringify(def)}`);
        return "TAGS-ADD-TEXT";
      },
      remove: async (cwd, id) => {
        calls.push(`tags-rm:${cwd}:${id}`);
        return "TAGS-RM-TEXT";
      },
      setEnabled: async (cwd, id, enabled) => {
        calls.push(`tags-set:${cwd}:${id}:${String(enabled)}`);
        return "TAGS-SET-TEXT";
      },
    },
    review: {
      list: (cwd) => {
        calls.push(`review-list:${cwd}`);
        return [] as readonly ReviewSuggestionView[];
      },
      run: async (cwd) => {
        calls.push(`review-run:${cwd}`);
        return "REVIEW-RUN-TEXT";
      },
      dismiss: async (cwd, id) => {
        calls.push(`review-dismiss:${cwd}:${id}`);
      },
      resolve: async (cwd, id) => {
        calls.push(`review-resolve:${cwd}:${id}`);
      },
    },
    isChildSession: false,
    ...over,
  };
  return Object.assign(port, { calls });
}

const REGISTRY = { __registry: true };

describe("/mem jev routing", () => {
  test("bare /mem jev renders the report and passes ctx.modelRegistry", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const { ctx, notifications } = fakeCtx(cwd, { modelRegistry: REGISTRY });
    await cmd.handler("jev", ctx);
    expect(port.calls).toEqual([`report:${cwd}`]);
    expect(notifications).toEqual([{ message: "REPORT-TEXT", level: "info" }]);
  });

  test("probe / retag [--all] / reset-index dispatch with the registry", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const mk = () => fakeCtx(cwd, { modelRegistry: REGISTRY });
    await cmd.handler("jev probe", mk().ctx);
    await cmd.handler("jev retag", mk().ctx);
    await cmd.handler("jev retag --all", mk().ctx);
    await cmd.handler("jev reset-index", mk().ctx);
    expect(port.calls).toEqual(["probe:reg", `retag:${cwd}:false`, `retag:${cwd}:true`, `reset-index:${cwd}`]);
  });

  test("unknown jev subcommand shows usage (warning)", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const { ctx, notifications } = fakeCtx(cwd);
    await cmd.handler("jev frobnicate", ctx);
    expect(port.calls).toEqual([]);
    expect(notifications[0]!.message).toContain("usage: /mem jev");
    expect(notifications[0]!.level).toBe("warning");
  });

  test("retag/reset-index refused without UI or from a child session", async () => {
    const { cwd, paths } = fixture();
    const mainPort = stubPort();
    const cmd = createMemCommand({ paths, jev: mainPort });
    const noUi = fakeCtx(cwd, { hasUI: false });
    await cmd.handler("jev retag", noUi.ctx);
    await cmd.handler("jev reset-index", noUi.ctx);
    expect(noUi.notifications).toHaveLength(0); // notify gated on hasUI too
    expect(mainPort.calls).toEqual([]);

    const childPort = stubPort({ isChildSession: true });
    const childCmd = createMemCommand({ paths, jev: childPort });
    const ui = fakeCtx(cwd);
    await childCmd.handler("jev retag", ui.ctx);
    expect(childPort.calls).toEqual([]);
    expect(ui.notifications[0]!.message).toContain("requires the interactive main session");
  });

  test("bare report/probe work without a UI (read-only)", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const { ctx, notifications } = fakeCtx(cwd, { hasUI: false, modelRegistry: REGISTRY });
    await cmd.handler("jev", ctx);
    expect(port.calls).toEqual([`report:${cwd}`]);
    expect(notifications).toHaveLength(0); // nothing to render without UI
  });
});

test("scoped help recommends status while preserving the no-router description", () => {
  const plain = createMemCommand({});
  const scoped = createMemCommand({ scopedRouter: async () => ({ handled: false }) });
  expect(plain.description).not.toContain("session|hub status");
  expect(scoped.description).toContain("session|hub status (list equivalent; status recommended)");
});

test.each(["blocks", "tiered"] as const)("scoped %s help puts daily entries before maintenance", (layout) => {
  const settings = parseMemorySettings({ layout });
  const jev = stubPort();
  const scoped = createMemCommand({ settings, jev, scopedRouter: async () => ({ handled: false }) });
  const unscoped = createMemCommand({ settings, jev });
  const scopedIndex = scoped.description.indexOf("/mem session|hub status");
  const maintenanceIndex = scoped.description.indexOf("维护:");
  expect(scopedIndex).toBeGreaterThan(scoped.description.indexOf("/mem expired"));
  expect(maintenanceIndex).toBeGreaterThan(scopedIndex);
  expect(unscoped.description).not.toContain("/mem session|hub status");
});

describe("/mem tags routing", () => {
  test("bare /mem tags and `tags list` both list; quoted --desc/--label survive parsing", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const mk = () => fakeCtx(cwd);
    await cmd.handler("tags", mk().ctx);
    await cmd.handler("tags list", mk().ctx);
    await cmd.handler(
      'tags add my-tag --label "My Tag" --desc "Two words here" --risk high --commands "foo bar,baz"',
      mk().ctx,
    );
    expect(port.calls.slice(0, 2)).toEqual([`tags-list:${cwd}`, `tags-list:${cwd}`]);
    expect(port.calls[2]!.startsWith(`tags-add:${cwd}:`)).toBe(true);
    expect(JSON.parse(port.calls[2]!.slice(`tags-add:${cwd}:`.length)) as TagDefInput).toEqual({
      id: "my-tag",
      label: "My Tag",
      description: "Two words here",
      risk: "high",
      commands: ["foo bar", "baz"],
    });
  });

  test("tags add accepts the legacy --description flag", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    await cmd.handler('tags add old-tag --label Old --description "legacy description"', fakeCtx(cwd).ctx);
    expect(JSON.parse(port.calls[0]!.slice(`tags-add:${cwd}:`.length))).toMatchObject({
      id: "old-tag",
      label: "Old",
      description: "legacy description",
    });
  });

  test("tags add missing required flags shows usage; rm/enable/disable dispatch", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const mk = () => fakeCtx(cwd);
    await cmd.handler("tags add my-tag --label only", mk().ctx);
    expect(port.calls).toEqual([]);
    const bad = fakeCtx(cwd);
    await cmd.handler("tags add my-tag --label a --desc b --bogus x", bad.ctx);
    expect(bad.notifications[0]!.message).toContain("unknown option --bogus");
    await cmd.handler("tags rm docs", mk().ctx);
    await cmd.handler("tags disable docs", mk().ctx);
    await cmd.handler("tags enable docs", mk().ctx);
    expect(port.calls).toEqual([`tags-rm:${cwd}:docs`, `tags-set:${cwd}:docs:false`, `tags-set:${cwd}:docs:true`]);
  });

  test("write subcommands refused without UI / from child sessions", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const noUi = fakeCtx(cwd, { hasUI: false });
    await cmd.handler("tags add x --label a --desc b", noUi.ctx);
    await cmd.handler("tags rm x", noUi.ctx);
    await cmd.handler("tags disable x", noUi.ctx);
    await cmd.handler("tags enable x", noUi.ctx);
    expect(port.calls).toEqual([]);

    const childCmd = createMemCommand({ paths, jev: stubPort({ isChildSession: true }) });
    const ui = fakeCtx(cwd);
    await childCmd.handler("tags rm x", ui.ctx);
    expect(ui.notifications[0]!.message).toContain("requires the interactive main session");
  });

  test("unknown tags subcommand shows usage; `tags list` works without UI", async () => {
    const { cwd, paths } = fixture();
    const port = stubPort();
    const cmd = createMemCommand({ paths, jev: port });
    const { ctx, notifications } = fakeCtx(cwd);
    await cmd.handler("tags frobnicate", ctx);
    expect(port.calls).toEqual([]);
    expect(notifications[0]!.message).toContain("usage: /mem tags");
  });
});

describe("default listing + completions (I9 surface)", () => {
  test("with a port the default listing appends exactly the status line", async () => {
    const { cwd, paths } = fixture();
    const cmd = createMemCommand({ paths, jev: stubPort() });
    const { ctx, notifications } = fakeCtx(cwd);
    await cmd.handler("", ctx);
    const message = notifications[0]!.message;
    expect(message).toContain("core.md");
    expect(message.endsWith("\njev: full · opencode/jev-1.13-free · 1/1 tagged")).toBe(true);
  });

  test("with a port the description and completions gain jev/tags", () => {
    const { paths } = fixture();
    const cmd = createMemCommand({ paths, jev: stubPort() });
    expect(cmd.description).toContain("/mem jev");
    expect(cmd.description).toContain("/mem tags");
    expect(cmd.description).toContain("维护: /mem jev reset-index");
    expect(cmd.getArgumentCompletions("jev reset")[0]?.description).toContain("维护");
    const values = (prefix: string) => cmd.getArgumentCompletions(prefix).map((c) => c.value);
    expect(values("j")).toEqual(["jev"]);
    expect(values("")).toContain("jev");
    expect(values("")).toContain("tags");
    expect(values("tags ")).toContain("tags add");
    expect(values("jev ")).toContain("jev probe");
    expect(values("jev ")).toContain("jev retag --all");
  });

  test("WITHOUT a port: description, completions and /mem jev output stay on the old surface", async () => {
    const { cwd, paths } = fixture();
    const plain = createMemCommand({ paths });
    const withPort = createMemCommand({ paths, jev: stubPort() });
    // description: byte-identical, no jev mention
    expect(plain.description).not.toContain("jev");
    expect(plain.description).not.toContain("tags");
    // completions: no jev/tags entries at any level
    for (const prefix of ["", "j", "je", "tags ", "r"]) {
      const plainValues = plain.getArgumentCompletions(prefix).map((c) => c.value);
      expect(plainValues.some((v) => v.startsWith("jev") || v.startsWith("tags"))).toBe(false);
      expect(plainValues).not.toContain("jev retag --all");
    }
    expect(plain.getArgumentCompletions("t")).toEqual(
      withPort.getArgumentCompletions("t").filter((v) => !v.value.startsWith("tags")),
    );
    // handler: /mem jev and /mem tags fall through to the default listing
    const { ctx, notifications } = fakeCtx(cwd);
    await plain.handler("jev", ctx);
    await plain.handler("tags", ctx);
    expect(notifications).toHaveLength(2);
    for (const n of notifications) {
      expect(n.message).toContain("core.md");
      expect(n.message).not.toContain("jev:");
    }
    // default listing without a port has NO status trailer
    await plain.handler("", ctx);
    expect(notifications[2]!.message).not.toMatch(/\njev:/);
  });
});
