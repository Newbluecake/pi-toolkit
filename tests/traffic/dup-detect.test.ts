/**
 * traffic-merge plan §2.4 步骤 2/3：dup-detect 单测——settings 扫描（只告警）与 getCommands
 * 判定（权威证据）。纯函数 + 注入 fs；永不抛错。
 */
import { describe, expect, it } from "vitest";
import {
  findExternalRecorderCommand,
  formatDupWarning,
  isUnder,
  scanExternalTrafficReferences,
  TOOLKIT_PACKAGE_ROOT,
  type DupDetectFs,
} from "../../src/traffic/dup-detect.js";
import { resolve } from "node:path";

function fsWith(files: Record<string, string>, existing: string[] = []): DupDetectFs {
  return {
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    exists: (path) => files[path] !== undefined || existing.includes(path),
  };
}

describe("scanExternalTrafficReferences (advisory only)", () => {
  it("no settings files / no references ⇒ no findings", () => {
    expect(scanExternalTrafficReferences({ agentDir: "/a", cwd: "/c", fs: fsWith({}) })).toEqual([]);
  });

  it("agent settings listing the external package (array form) is reported", () => {
    const agentDir = "/a";
    const fs = fsWith({
      [`${agentDir}/settings.json`]: JSON.stringify({ packages: ["../../ai/pi-traffic-record"] }),
    });
    const findings = scanExternalTrafficReferences({ agentDir, cwd: "/c", fs });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("package");
    expect(findings[0]!.detail).toContain("pi-traffic-record");
  });

  it("scoped name (@bluecake/…) and project-level .pi/settings.json are both caught", () => {
    const agentDir = "/a";
    const cwd = "/proj";
    const fs = fsWith({
      [`${agentDir}/settings.json`]: JSON.stringify({ packages: ["@bluecake/pi-traffic-record"] }),
      [`${cwd}/.pi/settings.json`]: JSON.stringify({ packages: ["pi-traffic-record"] }),
    });
    const findings = scanExternalTrafficReferences({ agentDir, cwd, fs });
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.source).sort()).toEqual(["agent settings", "project settings"]);
  });

  it("extensions object/array shapes are scanned for the package names; pi-toolkit itself never matches", () => {
    const agentDir = "/a";
    const fs = fsWith({
      [`${agentDir}/settings.json`]: JSON.stringify({
        packages: ["../../ai/pi-toolkit"],
        extensions: { "../../ai/pi-traffic-record": true },
      }),
    });
    expect(scanExternalTrafficReferences({ agentDir, cwd: "/c", fs })).toHaveLength(1);
    const fsArray = fsWith({
      [`${agentDir}/settings.json`]: JSON.stringify({ extensions: ["pi-traffic-record"] }),
    });
    expect(scanExternalTrafficReferences({ agentDir, cwd: "/c", fs: fsArray })).toHaveLength(1);
  });

  it("legacy <agentDir>/extensions/traffic-dump.ts file is reported", () => {
    const agentDir = "/a";
    const fs = fsWith({}, [`${agentDir}/extensions/traffic-dump.ts`]);
    const findings = scanExternalTrafficReferences({ agentDir, cwd: "/c", fs });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("extension-file");
  });

  it("unreadable/corrupt JSON ⇒ no findings, never throws", () => {
    const fs = fsWith({ "/a/settings.json": "{not json" });
    expect(scanExternalTrafficReferences({ agentDir: "/a", cwd: "/c", fs })).toEqual([]);
    const throwing: DupDetectFs = {
      readFile: () => {
        throw new Error("EACCES");
      },
      exists: (p) => p === "/a/settings.json" || p === "/c/.pi/settings.json",
    };
    expect(scanExternalTrafficReferences({ agentDir: "/a", cwd: "/c", fs: throwing })).toEqual([]);
  });

  it("formatDupWarning renders one line per finding plus migration steps", () => {
    const text = formatDupWarning([{ kind: "package", source: "agent settings", detail: "/x settings.json" }]);
    expect(text).toContain("agent settings");
    expect(text).toContain("迁移");
  });
});

describe("findExternalRecorderCommand (authoritative evidence)", () => {
  const root = "/pkg/toolkit";

  it("no /record at all ⇒ undefined", () => {
    expect(findExternalRecorderCommand([], root)).toBeUndefined();
    expect(findExternalRecorderCommand([{ name: "agent" }, { name: "record-x" }], root)).toBeUndefined();
  });

  it("own /record (sourceInfo.path under the package root, incl. :N rename) is NOT external", () => {
    expect(
      findExternalRecorderCommand(
        [
          { name: "record", sourceInfo: { path: `${root}/index.ts` } },
          { name: "record:2", sourceInfo: { path: `${root}/src/traffic/index.ts` } },
        ],
        root,
      ),
    ).toBeUndefined();
  });

  it("an external /record (path outside the root) is detected with its path", () => {
    const hit = findExternalRecorderCommand(
      [
        { name: "record", sourceInfo: { path: `${root}/src/traffic/index.ts` } },
        { name: "record:2", sourceInfo: { path: "/home/u/ai/pi-traffic-record/src/index.ts" } },
      ],
      root,
    );
    expect(hit).toBeDefined();
    expect(hit!.name).toBe("record:2");
    expect(hit!.path).toBe("/home/u/ai/pi-traffic-record/src/index.ts");
  });

  it("a prefix-similar path (/pkg/toolkit-other) is NOT under the root", () => {
    expect(
      findExternalRecorderCommand([{ name: "record", sourceInfo: { path: `${root}-other/index.ts` } }], root),
    ).toBeDefined();
  });

  it("missing/malformed sourceInfo counts as external (fail closed)", () => {
    expect(findExternalRecorderCommand([{ name: "record" }], root)).toBeDefined();
    expect(findExternalRecorderCommand([{ name: "record", sourceInfo: { path: 42 } }], root)).toBeDefined();
    expect(findExternalRecorderCommand([{ name: "record", sourceInfo: {} }], root)).toBeDefined();
  });

  it("TOOLKIT_PACKAGE_ROOT resolves to the repository root and contains this module's ancestors", () => {
    expect(isUnder(resolve(TOOLKIT_PACKAGE_ROOT, "src/traffic/index.ts"), TOOLKIT_PACKAGE_ROOT)).toBe(true);
    expect(isUnder("/elsewhere/index.ts", TOOLKIT_PACKAGE_ROOT)).toBe(false);
  });
});
