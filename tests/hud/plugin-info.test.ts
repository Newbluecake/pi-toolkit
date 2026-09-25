import { describe, expect, it } from "vitest";
import { readPluginInfo, type PluginInfoDeps } from "../../src/hud/plugin-info.js";
import { renderPluginInfo } from "../../src/hud/footer.js";

const theme = { fg: (color: string, text: string) => `<${color}>${text}</>` };

function deps(opts: {
  pkg?: string | Error;
  top?: string | undefined;
  log?: string | undefined;
  status?: string | undefined;
  root?: string;
}): PluginInfoDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    root: opts.root ?? "/pkg/",
    readText: async () => {
      if (opts.pkg instanceof Error) throw opts.pkg;
      return opts.pkg ?? JSON.stringify({ version: "0.2.1" });
    },
    realpath: async (p) => p.replace(/\/+$/, ""),
    git: async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "top" in opts ? opts.top : "/pkg\n";
      if (args[0] === "log") return "log" in opts ? opts.log : "b5edde5\t1790000000\n";
      if (args[0] === "status") return "status" in opts ? opts.status : "";
      return undefined;
    },
  };
}

describe("readPluginInfo", () => {
  it("读 package.json 版本 + HEAD commit / 提交时间 / 干净工作树", async () => {
    expect(await readPluginInfo(deps({}))).toEqual({
      version: "0.2.1",
      commit: "b5edde5",
      commitTime: 1790000000_000,
      dirty: false,
    });
  });

  it("工作树有已跟踪改动 → dirty", async () => {
    const info = await readPluginInfo(deps({ status: " M src/a.ts\n" }));
    expect(info.dirty).toBe(true);
  });

  it("包根不是 git 顶层（npm 装进宿主项目 node_modules）→ 不报宿主的 commit", async () => {
    const d = deps({ top: "/host-project\n", root: "/host-project/node_modules/pi-toolkit/" });
    expect(await readPluginInfo(d)).toEqual({ version: "0.2.1" });
    expect(d.calls.map((c) => c[0])).toEqual(["rev-parse"]);
  });

  it("非 git / git 失败 → 只有版本", async () => {
    expect(await readPluginInfo(deps({ top: undefined }))).toEqual({ version: "0.2.1" });
  });

  it("package.json 缺失或损坏 → 无版本但 git 信息照常", async () => {
    expect(await readPluginInfo(deps({ pkg: new Error("ENOENT") }))).toMatchObject({ commit: "b5edde5" });
    expect((await readPluginInfo(deps({ pkg: "{oops" }))).version).toBeUndefined();
  });

  it("log 输出异常 → 省略 commit / 时间", async () => {
    const info = await readPluginInfo(deps({ log: undefined }));
    expect(info.commit).toBeUndefined();
    expect(info.commitTime).toBeUndefined();
  });
});

describe("renderPluginInfo", () => {
  const t = new Date(2026, 8, 25, 14, 16).getTime();

  it("完整信息：版本@commit 时间", () => {
    expect(renderPluginInfo({ version: "0.2.1", commit: "b5edde5", commitTime: t, dirty: false }, theme)).toBe(
      "<dim>toolkit </><muted>v0.2.1@b5edde5</> <dim>2026-09-25 14:16</>",
    );
  });

  it("dirty 加 * 标记", () => {
    expect(renderPluginInfo({ version: "0.2.1", commit: "b5edde5", dirty: true }, theme)).toBe(
      "<dim>toolkit </><muted>v0.2.1@b5edde5*</>",
    );
  });

  it("只有版本", () => {
    expect(renderPluginInfo({ version: "0.2.1" }, theme)).toBe("<dim>toolkit </><muted>v0.2.1</>");
  });

  it("空信息 / 未就绪 → undefined（不占位）", () => {
    expect(renderPluginInfo(undefined, theme)).toBeUndefined();
    expect(renderPluginInfo({}, theme)).toBeUndefined();
  });
});
