/** Real owned Node children and synthetic SDK protocol fixtures, NOT real SDK
 * acceptance. No session, PTY, shell, mounts or site paths are loaded. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSelectedPackageProbe } from "../../scripts/web-hub/terminal-v2-retained/load-probe.js";
import { probeDiagnostics } from "../../scripts/ci/safe-diagnostics.mjs";
afterEach(() => vi.restoreAllMocks());
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), "lp-")),
    dist = join(root, "dist"),
    entry = join(root, "index.ts"),
    pid = join(root, "pid");
  mkdirSync(dist, { mode: 0o700 });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0", type: "module" }),
  );
  writeFileSync(join(dist, "cli.js"), "");
  writeFileSync(
    join(dist, "index.js"),
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));\n${body}`,
  );
  return {
    root,
    entry,
    pid,
    piCli: join(dist, "cli.js"),
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root },
  };
}
const sdk = (reload: string, extensions = "({errors:[],extensions:[{path:ENTRY}]})") => `
export const SettingsManager={create(home,dir){if(home!==process.env.HOME||dir!==process.env.PI_CODING_AGENT_DIR)throw Error('wrong settings');return {}}};
export class DefaultResourceLoader {
 constructor(options){if(options.noExtensions||!options.noSkills||!options.noThemes||!options.noPromptTemplates||!options.noContextFiles)throw Error('weakened loader');}
 async reload(){${reload}}
 getExtensions(){return ${extensions}}
}`;
it("actual child completion requires reload and the exact original receipt, success emits no diagnostics", async () => {
  const f = fixture(sdk("", "({errors:[],extensions:[{path:process.argv[2]}]})"));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const result = await runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000);
  expect(JSON.parse(result)).toEqual({ v: 1, kind: "selected-package-loaded-without-session", entry: f.entry });
  expect(diagnostic).not.toHaveBeenCalled();
});
it.each(["sdk-import", "loader-reload"] as const)(
  "parent deadline keeps last %s stage and kills its exact owned blocked child",
  async (stage) => {
    const f = fixture(stage === "sdk-import" ? "while(true){}" : sdk("while(true){}"));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 1000)).rejects.toThrow(
      "E_RETAINED_LOAD_PROBE_DEADLINE",
    );
    const pid = Number(readFileSync(f.pid, "utf8"));
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref();
      });
    }
    expect(() => process.kill(pid, 0)).toThrow();
    const lines = diagnostic.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(probeDiagnostics(lines)).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage, reason: "deadline" })]),
    );
    expect(lines).not.toContain(f.root);
  },
  5000,
);
it.each(["loader-error", "missing-extension"] as const)(
  "%s is not load success; arbitrary stderr never escapes the closed diagnostic channel",
  async (failure) => {
    const secret = "FAKE_COOKIE_DO_NOT_PUBLISH";
    const f = fixture(
      `process.stderr.write(${JSON.stringify(secret)});\n` +
        sdk(
          "",
          failure === "loader-error"
            ? "({errors:[{message:'private'}],extensions:[{path:process.argv[2]}]})"
            : "({errors:[],extensions:[]})",
        ),
    );
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000)).rejects.toThrow(
      "E_RETAINED_LOAD_PROBE_FAILED",
    );
    const text = diagnostic.mock.calls.flat().join(" ");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(f.root);
    expect(probeDiagnostics(text)).toEqual([expect.objectContaining({ stage: "extensions", reason: "child-failed" })]);
  },
);
