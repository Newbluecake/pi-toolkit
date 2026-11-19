/** Owned synthetic processes only. H4 lifecycle, not real SDK or remote acceptance. */
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROGRAM, runSelectedPackageProbe } from "../../scripts/web-hub/terminal-v2-retained/load-probe.js";
import { observeExternalChild } from "../../scripts/web-hub/terminal-v2-retained/external-observer.mjs";
import { EXTERNAL_MARKER, extractExternal, validExternal } from "../../scripts/ci/external-probe-schema.mjs";
const spawned = vi.hoisted(() => [] as { args: any[]; child: any }[]);
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawned.push({ args, child });
      return child;
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  spawned.length = 0;
});
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), "ext-")),
    dist = join(root, "dist"),
    pid = join(root, "pid");
  mkdirSync(dist, { mode: 0o700 });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0", type: "module" }),
  );
  writeFileSync(join(dist, "cli.js"), "");
  writeFileSync(
    join(dist, "index.js"),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));\n${body}`,
  );
  return {
    root,
    pid,
    entry: join(root, "index.ts"),
    piCli: join(dist, "cli.js"),
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root },
  };
}
const sdk = (reload = "") => `
export const SettingsManager={create(h,d){if(h!==process.env.HOME||d!==process.env.PI_CODING_AGENT_DIR)throw Error('settings');return {}}};
export class DefaultResourceLoader {
 constructor(o){if(o.noExtensions||!o.noSkills||!o.noThemes||!o.noPromptTemplates||!o.noContextFiles)throw Error('options');}
 async reload(){await Promise.resolve();${reload};this.done=true;}
 getExtensions(){if(!this.done)throw Error('not awaited');return {errors:[],extensions:[{path:process.argv[2]}]};}
}`;
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
async function gone(pid: number) {
  for (let i = 0; i < 150; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    await delay(20);
  }
  throw Error("owned PID not gone");
}
function capture() {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    log,
    snapshot: () =>
      extractExternal([
        log.mock.calls
          .flat()
          .filter((x) => String(x).startsWith(EXTERNAL_MARKER))
          .join("\n"),
      ]),
  };
}
it("PROGRAM equals original base byte-for-byte; off/on argv, environment, four FDs and exact receipt match", async () => {
  const base = execFileSync(
    "/usr/bin/git",
    ["show", "7cae4a34a6251e023d455e9925ffc08eb507f229:scripts/web-hub/terminal-v2-retained/load-probe.ts"],
    { encoding: "utf8" },
  );
  const literal = base.slice(
    base.indexOf("const PROGRAM = ") + "const PROGRAM = ".length,
    base.indexOf("\n/** Exported solely"),
  );
  expect(PROGRAM).toBe(Function(`return ${literal}`)());
  const f = fixture(sdk()),
    c = capture();
  const off = runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000);
  expect(spawned[0]!.child.listenerCount("exit")).toBe(0);
  expect(spawned[0]!.child.listenerCount("close")).toBe(1);
  const output = await off;
  expect(c.log).not.toHaveBeenCalled();
  const on = runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000, true);
  expect(spawned[1]!.child.listenerCount("exit")).toBe(1);
  expect(spawned[1]!.child.listenerCount("close")).toBe(1);
  expect(await on).toBe(output);
  expect(spawned[1]!.args).toEqual(spawned[0]!.args);
  expect(spawned[0]!.args[2].stdio).toEqual(["pipe", "pipe", "ignore", "pipe"]);
  expect(JSON.parse(output)).toEqual({ v: 1, kind: "selected-package-loaded-without-session", entry: f.entry });
  const s = c.snapshot();
  expect(s).toMatchObject({
    product: "observed-pass",
    reason: "success",
    lastStage: "receipt",
    exit: { state: "seen", code: "zero" },
    close: { state: "seen", code: "zero" },
  });
  expect(validExternal(s)).toBe(true);
  expect(spawned[1]!.child.listenerCount("exit")).toBe(0);
  await gone(Number(readFileSync(f.pid, "utf8")));
});
it.each([75, 1])("exit%s is observed without inferring timer firing, raw SDK errors never escape", async (code) => {
  const f = fixture(
      `process.stderr.write('FAKE_SECRET_EXTERNAL');${code === 75 ? "process.exit(75)" : "process.nextTick(()=>{throw Error('FAKE_SECRET_EXTERNAL')});await new Promise(()=>{})"};`,
    ),
    c = capture();
  await expect(runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000, true)).rejects.toThrow(
    "E_RETAINED_LOAD_PROBE_FAILED",
  );
  expect(c.snapshot()).toMatchObject({
    product: "observed-fail",
    reason: "child-failed",
    exit: { code: code === 75 ? "probe75" : "other" },
    close: { state: "seen" },
  });
  expect(c.log.mock.calls.flat().join(" ")).not.toMatch(/FAKE_SECRET_EXTERNAL|timer-fired/);
  await gone(Number(readFileSync(f.pid, "utf8")));
});
it("parent deadline preserves original stop and reports not-seen-as-of, never a running assertion", async () => {
  const f = fixture(sdk("while(true){}")),
    c = capture();
  await expect(runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 350, true)).rejects.toThrow(
    "E_RETAINED_LOAD_PROBE_DEADLINE",
  );
  const before = JSON.stringify(c.snapshot());
  expect(c.snapshot()).toMatchObject({
    reason: "deadline",
    lastStage: "loader-reload",
    exit: { state: "not-seen-as-of" },
    close: { state: "not-seen-as-of" },
  });
  await gone(Number(readFileSync(f.pid, "utf8")));
  await delay(30);
  expect(JSON.stringify(c.snapshot())).toBe(before);
  expect(c.log.mock.calls.flat().filter((x) => String(x).startsWith(EXTERNAL_MARKER))).toHaveLength(1);
});
it.each([0, 75])("leader exit%s with inherited open stdout still uses original close-only deadline", async (code) => {
  const f = fixture(
    `
    const {spawn}=await import('node:child_process');
    const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),900)'],{stdio:['ignore',1,'ignore']});
    fs.writeFileSync(${JSON.stringify("HOLDER_PLACEHOLDER")},String(c.pid));
    process.exit(${code});`.replace(JSON.stringify("HOLDER_PLACEHOLDER"), "process.env.HOME+'/holder'"),
  );
  const c = capture();
  await expect(runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 350, true)).rejects.toThrow(
    "E_RETAINED_LOAD_PROBE_DEADLINE",
  );
  const before = JSON.stringify(c.snapshot());
  expect(c.snapshot()).toMatchObject({
    product: "observed-fail",
    reason: "deadline",
    exit: { state: "seen", code: code === 0 ? "zero" : "probe75" },
    close: { state: "not-seen-as-of" },
  });
  await gone(Number(readFileSync(f.pid, "utf8")));
  await gone(Number(readFileSync(join(f.root, "holder"), "utf8")));
  await delay(30);
  expect(JSON.stringify(c.snapshot())).toBe(before);
  expect(c.log.mock.calls.flat().filter((x) => String(x).startsWith(EXTERNAL_MARKER))).toHaveLength(1);
});
it("snapshot deep freezes once and detaches only its own listener; late exit/close cannot mutate it", () => {
  const child = new EventEmitter(),
    original = vi.fn();
  child.on("exit", original);
  let now = 100;
  const observer = observeExternalChild(child, () => now);
  now = 110;
  child.emit("exit", 75, null);
  now = 120;
  const s = observer.freeze("observed-fail", "loader-reload", "deadline", false);
  expect(s.exit).toEqual({ state: "seen", ms: 10, code: "probe75", signal: "none" });
  expect(s.asOfMs).toBe(20);
  expect(Object.isFrozen(s) && Object.isFrozen(s.exit) && Object.isFrozen(s.close)).toBe(true);
  expect(child.listenerCount("exit")).toBe(1);
  observer.close(0, null);
  child.emit("exit", 0, null);
  expect(observer.freeze("observed-pass", "receipt", "success", true)).toBe(s);
  expect(s.close.state).toBe("not-seen-as-of");
  expect(original).toHaveBeenCalledTimes(2);
});
it.each([false, true])(
  "full UNUSED owned sink: observer=%s exits0 before any drain with identical child PROGRAM",
  async (on) => {
    // Test-only fd4, NOT a production transport. Fill synchronously to EAGAIN,
    // then blocking flag: no pending write request can keep the child alive.
    const f = fixture(sdk());
    const prefix = `const fs=require('node:fs'),net=require('node:net');const sink=new net.Socket({fd:4,readable:false,writable:true});let full=false;while(!full){try{fs.writeSync(4,Buffer.alloc(65536));}catch(e){if(e.code!=='EAGAIN')throw e;full=true;}}sink._handle.setBlocking(true);`;
    const child = spawn(process.execPath, ["-e", prefix + PROGRAM, f.piCli, f.entry], {
      cwd: f.root,
      env: f.env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore", "pipe", "pipe"],
    });
    const observer = on ? observeExternalChild(child) : undefined;
    child.stdout!.resume();
    (child.stdio[3] as any).resume();
    let drained = false;
    const safety = setTimeout(() => {
      drained = true;
      (child.stdio[4] as any).resume();
    }, 3500);
    safety.unref();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      expect(code).toBe(0);
      expect(drained).toBe(false);
      if (observer) expect(observer.freeze("observed-pass", "receipt", "success", false).exit.code).toBe("zero");
    } finally {
      clearTimeout(safety);
      (child.stdio[4] as any).resume();
      child.stdin!.end();
      if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
    }
    await gone(child.pid!);
  },
  6000,
);
it("existing fd3 byte cap marks truncation honestly without weakening the product receipt gate", async () => {
  const f = fixture("fs.writeSync(3,'x'.repeat(8193));\n" + sdk()),
    c = capture();
  const output = await runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000, true);
  expect(JSON.parse(output).entry).toBe(f.entry);
  expect(c.snapshot()).toMatchObject({ product: "observed-pass", reason: "success", truncated: true });
});
it("parent diagnostic emitter failure does not replace the original validated product result", async () => {
  const f = fixture(sdk());
  vi.spyOn(console, "error").mockImplementation(() => {
    throw Error("synthetic output failure");
  });
  expect(JSON.parse(await runSelectedPackageProbe(f.piCli, f.entry, f.root, f.env, Date.now() + 3000, true))).toEqual({
    v: 1,
    kind: "selected-package-loaded-without-session",
    entry: f.entry,
  });
});
