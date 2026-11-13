/** True Linux PTY / Q4 physical half. No real passwd HOME/shell/rc is executed.
 * All launches use the internal, pre-spawn validated UID fixture factory. H owns journal CAS. */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createTerminalTestBackend,
  type TerminalBackend,
  type TerminalBackendOptions,
} from "../../src/web-hub/agent/terminal/backend.js";
import { assertTerminalFixture, type TerminalTestFixture } from "../../src/web-hub/agent/terminal/environment.js";
import { TERMINAL_PYTHON_HELPER } from "../../src/web-hub/agent/terminal/python-helper.js";
import { createTerminalOwner, type TerminalOwner } from "../../src/web-hub/agent/terminal/owner.js";
import { readTerminalIdentity, terminalIdentitiesGone } from "../../src/web-hub/agent/terminal/reaper.js";
import {
  TerminalReapProofSchema,
  terminalFrameOk,
  type TermRes,
  type TermEvent,
  type TermReq,
} from "../../src/web-hub/protocol/terminal.js";
import { Value } from "@sinclair/typebox/value";

const roots: string[] = [],
  backends: TerminalBackend[] = [],
  owners: TerminalOwner[] = [];
const pause = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("terminal fixture deadline");
    await pause();
  }
}
afterEach(async () => {
  for (const o of owners.splice(0)) {
    await o.dispose();
    const proven = o.resourceEntries().filter((e) =>
      o.reapProof(e.identity, {
        hubBootId: "test",
        challengeId: "test",
        linkGen: 1,
        inventoryId: "test",
        revision: 0,
      }),
    );
    if (proven.length) o.forgetResolvedReceipts(proven.map((e) => e.identity));
  }
  for (const b of backends.splice(0)) {
    b.close();
    await b.done;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Before native system rc runs: audit all installed /etc startup inputs for this fixture.
 * Refuse a HOME/ZDOTDIR assignment (including locale.conf's eval input), not post-hoc repair.
 * The fixture wrapper disables optional bash-completion sourcing and verifies HOME pre-exec.
 * No claim to OS isolation: system startup scripts are trusted and not modified. */
function systemRcPreflight(): void {
  const files = [
    "/etc/profile",
    "/etc/bashrc",
    "/etc/zshenv",
    "/etc/zshrc",
    "/etc/zprofile",
    "/etc/zlogin",
    "/etc/locale.conf",
    ...readdirSync("/etc/profile.d")
      .filter((f) => f.endsWith(".sh") || f === "sh.local")
      .map((f) => `/etc/profile.d/${f}`),
  ];
  for (const file of files.filter(existsSync)) {
    const st = lstatSync(file);
    if (!st.isFile() || st.mode & 0o022) throw new Error("unsafe fixture system startup");
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((s) => !s.trim().startsWith("#"))
      .join("\n");
    if (/(?:^|[;\s])(?:export\s+)?(?:HOME|ZDOTDIR)\s*=|(?:unset|read)\s+(?:HOME|ZDOTDIR)/m.test(code))
      throw new Error("system startup redirects fixture HOME: coverage refused before exec");
  }
}
function fixture(kind: "bash" | "zsh" = "bash", delays: Partial<TerminalTestFixture> = {}): TerminalTestFixture {
  systemRcPreflight();
  const root = mkdtempSync(join(tmpdir(), "tp-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const home = join(root, "h"),
    cwd = join(root, "w");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  // No leftover optional init/history files can reference a real user path: fresh owned root.
  const names = [
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".bashrc",
    ".bash_logout",
    ".zshenv",
    ".zprofile",
    ".zshrc",
    ".zlogin",
    ".zlogout",
  ];
  const rcFiles = names.map((n) => join(home, n));
  for (const file of rcFiles) writeFileSync(file, "", { mode: 0o600 });
  writeFileSync(
    join(home, ".bash_profile"),
    'export PROFILE_COUNT=$(( ${PROFILE_COUNT:-0} + 1 ))\n. "$HOME/.bashrc"\n',
  );
  writeFileSync(
    join(home, ".bashrc"),
    'export RC_COUNT=$(( ${RC_COUNT:-0} + 1 ))\nexport RC_API_KEY=from-fixture-rc\nPS1="fixture> "\nHISTFILE=/dev/null\nprintf "RC_READY\\n"\n',
  );
  writeFileSync(join(home, ".zprofile"), "export PROFILE_COUNT=$(( ${PROFILE_COUNT:-0} + 1 ))\n");
  writeFileSync(
    join(home, ".zshrc"),
    'export RC_COUNT=$(( ${RC_COUNT:-0} + 1 ))\nexport RC_API_KEY=from-fixture-rc\nPS1="fixture> "\nHISTFILE=/dev/null\nprintf "RC_READY\\n"\n',
  );
  const shell = join(root, kind);
  expect(existsSync(`/usr/bin/${kind}`), `real ${kind} required; no fallback/skip`).toBe(true);
  const binary = realpathSync(`/usr/bin/${kind}`);
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$HOME" = '${home}' ] || exit 123\nexport BASH_COMPLETION_VERSINFO=fixture-disabled\nexec '${binary}' "$@"\n`,
    { mode: 0o700 },
  );
  const f = {
    root,
    home,
    cwd,
    shell,
    shellKind: kind,
    uid: process.getuid!(),
    gid: process.getgid!(),
    rcFiles,
    ...delays,
  };
  assertTerminalFixture(f);
  return f;
}
function backend(f: TerminalTestFixture, extra: Partial<TerminalBackendOptions> = {}) {
  let output = "";
  const options: TerminalBackendOptions = {
    cwd: f.cwd,
    cols: 91,
    rows: 31,
    inputIdleMs: 3600000,
    maxLifetimeMs: 28800000,
    environment: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      API_KEY: "FAKE_PI_KEY",
      apiKey: "FAKE_CAMEL_KEY",
      CUSTOM_TOKEN: "FAKE_TOKEN",
      RC_API_KEY: "FAKE_INHERITED_RC_KEY",
      MY_PROVIDER_KEY: "FAKE_UNRECOGNIZED",
      LD_PRELOAD: "/fake",
      NODE_OPTIONS: "fake",
    },
    onData: (b) => {
      output += b.toString("utf8");
    },
    ...extra,
  };
  const b = createTerminalTestBackend(options, f);
  backends.push(b);
  return {
    b,
    get output() {
      return output;
    },
    async write(text: string, seq = 0) {
      await b.input(seq, Buffer.from(text), "user");
    },
  };
}
async function waitRc(h: ReturnType<typeof backend>) {
  await h.b.ready;
  await until(() => h.output.includes("RC_READY"));
}
const evidence = { hubBootId: "boot", challengeId: "challenge", linkGen: 1, inventoryId: "inventory", revision: 1 };

describe("Linux agent-owned terminal §§5.1–5.4, T-ISO/T-SUBREAPER", () => {
  it.each(["bash", "zsh"] as const)(
    "native interactive login %s loads profile+rc exactly once; secret inheritance is absent, rc may reset its own secret",
    async (kind) => {
      const f = fixture(kind),
        h = backend(f);
      await waitRc(h);
      await h.write(
        'printf "\\nCHECK:%s:%s:%s:%s:%s:%s:%s:%s\\n" "$PROFILE_COUNT" "$RC_COUNT" "${API_KEY-unset}" "${apiKey-unset}" "${CUSTOM_TOKEN-unset}" "${MY_PROVIDER_KEY-unset}" "$RC_API_KEY" "$HOME"\n',
      );
      await until(() => h.output.includes(`CHECK:1:1:unset:unset:unset:unset:from-fixture-rc:${f.home}`));
      expect(h.output).not.toContain("FAKE_PI_KEY");
      expect(h.output).not.toContain("FAKE_TOKEN");
      await h.write('printf "\\nTTY:%s:%s:%s\\n" "$(test -t 0 && echo yes)" "$(stty size)" "$PWD"\n', 1);
      await until(() => h.output.includes(`TTY:yes:31 91:${f.cwd}`));
      expect(h.b.display).toMatchObject({ shellName: kind, userLabel: "terminal-fixture", cwd: f.cwd });
      expect(h.b.display?.hostLabel).toBeTruthy();
      await h.write("printf 'FINAL_BYTES\\n'; exit 17\n", 2);
      const done = await h.b.done;
      expect(done).toMatchObject({
        outcome: "reaped",
        exitCode: 17,
        spawnSettled: true,
        ptyClosed: true,
        helperReaped: true,
        managedGroupsGone: true,
      });
      expect(await terminalIdentitiesGone(done.identitiesChecked)).toBe(true);
      expect(h.output).toContain("FINAL_BYTES\r\n");
    },
    15000,
  );
  it("background output remains bounded and cannot renew the helper's own idle/lifetime deadline", async () => {
    const h = backend(fixture(), { inputIdleMs: 500, maxLifetimeMs: 10000 });
    await waitRc(h);
    await h.b.input(0, Buffer.from("while :; do printf x; done\n"), "terminal_response");
    const done = await h.b.done;
    expect(done.outcome).toBe("reaped");
    expect(h.output.length).toBeGreaterThan(100);
    expect(h.output.length).toBeLessThan(300000); // pipe/PTY backpressure + fixed byte budget, no runaway staging
    const life = backend(fixture(), { inputIdleMs: 10000, maxLifetimeMs: 500 });
    await waitRc(life);
    expect((await life.b.done).outcome).toBe("reaped");
  }, 15000);
  it("all helper/pipe/owner timers are unref'd: a ready backend cannot pin a print-like Node parent", async () => {
    const f = fixture();
    const script = `import { createTerminalTestBackend } from ${JSON.stringify(join(process.cwd(), "src/web-hub/agent/terminal/backend.ts"))};
      const fixture=JSON.parse(process.argv[1]);
      const guard=setTimeout(()=>process.exit(72),4000);
      const b=createTerminalTestBackend({cwd:fixture.cwd,cols:80,rows:24,inputIdleMs:3600000,maxLifetimeMs:28800000,onData(){}},fixture);
      b.ready.then(()=>{console.log(JSON.stringify(b.managed));clearTimeout(guard);},()=>process.exit(73));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(f)], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 6000,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => {
      out += String(b);
    });
    child.stderr.on("data", (b) => {
      err += String(b);
    });
    const [code] = await once(child, "close");
    expect(code, err).toBe(0);
    const identities = JSON.parse(out);
    expect(identities.some((i: { role: string }) => i.role === "shell")).toBe(true);
    await until(async () => {
      for (const i of identities) {
        const current = await readTerminalIdentity(i.pid);
        if (current && !readFileSync(`/proc/${i.pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return false;
      }
      return true;
    });
  }, 10000);
  it("T-ISO rejects real HOME, external rc/shell, uid mismatch and symlink escape before any helper is created", () => {
    const f = fixture();
    for (const bad of [
      { ...f, home: "/home/bluecake" },
      { ...f, rcFiles: ["/etc/profile"] },
      { ...f, shell: "/usr/bin/bash" },
      { ...f, uid: f.uid + 1 },
    ])
      expect(() =>
        createTerminalTestBackend(
          { cwd: f.cwd, cols: 80, rows: 24, inputIdleMs: 3600000, maxLifetimeMs: 28800000, onData() {} },
          bad,
        ),
      ).toThrow("E_BAD_REQUEST");
    rmSync(join(f.home, ".bashrc"));
    symlinkSync("/etc/profile", join(f.home, ".bashrc"));
    expect(() => assertTerminalFixture(f)).toThrow("E_BAD_REQUEST");
  });
  it("resize changes real kernel winsize; SIGWINCH redraw reaches the verified foreground group even at unchanged dimensions", async () => {
    const h = backend(fixture());
    await waitRc(h);
    await h.write("trap 'printf WINCH_RECEIVED\\\\n' WINCH\nprintf 'TRAP_ARMED\\n'\n");
    await until(() => h.output.includes("TRAP_ARMED\r\n"));
    await h.b.resize(0, 113, 42, true);
    await until(() => h.output.includes("WINCH_RECEIVED"));
    await h.write('printf "SIZE:%s\\n" "$(stty size)"\n', 1);
    await until(() => h.output.includes("SIZE:42 113"));
    const count = (h.output.match(/WINCH_RECEIVED/g) ?? []).length;
    await pause(550);
    await h.b.resize(1, 113, 42, true);
    await until(() => (h.output.match(/WINCH_RECEIVED/g) ?? []).length > count);
    h.b.close();
    expect((await h.b.done).outcome).toBe("reaped");
  }, 15000);
  it("Ctrl-D EOF exits the real interactive shell without stopping the agent", async () => {
    const h = backend(fixture());
    await waitRc(h);
    await h.b.input(0, Buffer.from([4]), "user");
    expect(await h.b.done).toMatchObject({ outcome: "reaped", exitCode: 0, ptyClosed: true, helperReaped: true });
    expect(process.pid).toBeGreaterThan(0);
  });
  it("helper subreaper adopts/waitpids ordinary double-fork descendants; all foreground/background pgids disappear", async () => {
    const f = fixture(),
      h = backend(f);
    await waitRc(h);
    const orphan = join(f.root, "orphan.py");
    writeFileSync(
      orphan,
      "import os,time\np=os.fork()\nif p: os._exit(0)\nos.setsid()\nprint('ORPHAN:'+str(os.getpid()),flush=True)\ntime.sleep(90)\n",
    );
    await h.write(`/usr/bin/python3 '${orphan}' &\nsleep 90 &\nprintf 'GROUPS_READY\\n'\nsleep 90\n`);
    await until(() => h.output.includes("ORPHAN:"));
    await until(() => new Set(h.b.managed.filter((i) => i.role !== "helper").map((i) => i.pgid)).size >= 3);
    const prior = [...h.b.managed];
    const shell = prior.find((i) => i.role === "shell")!;
    expect(prior.some((i) => i.sid !== shell.sid && i.role !== "helper")).toBe(true); // adopted setsid child
    h.b.close();
    const done = await h.b.done;
    expect(done.outcome).toBe("reaped");
    expect(done.waited).toContain(shell.pid);
    const adopted = prior.find((i) => i.sid !== shell.sid && i.role !== "helper")!;
    expect(done.waited).toContain(adopted.pid);
    expect(await terminalIdentitiesGone(done.identitiesChecked)).toBe(true);
  }, 15000);

  it("HUP/TERM-resistant job-control groups are actually KILLed and waitpid-reaped within the hard reap budget", async () => {
    const h = backend(fixture());
    await waitRc(h);
    await h.write("trap '' HUP TERM\nsleep 90 &\nsleep 90\n");
    await until(() => new Set(h.b.managed.filter((i) => i.role !== "helper").map((i) => i.pgid)).size >= 3);
    const start = Date.now();
    h.b.close();
    const result = await h.b.done;
    expect(result.outcome).toBe("reaped");
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - start).toBeGreaterThanOrEqual(2700);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(await terminalIdentitiesGone(result.identitiesChecked)).toBe(true);
  }, 15000);
  it("a full helper stdout pipe cannot block close/control or grow unbounded PTY staging", async () => {
    const h = backend(fixture());
    await waitRc(h);
    const stream = (h.b as unknown as { child: { stdout: { pause(): void; resume(): void } } }).child.stdout;
    await h.write("yes flood\n");
    stream.pause();
    await pause(1000);
    const helper = h.b.managed.find((i) => i.role === "helper")!;
    const status = readFileSync(`/proc/${helper.pid}/status`, "utf8");
    const memory = process.memoryUsage();
    console.info(
      "[terminal-probe-memory]",
      JSON.stringify({
        helperRssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
        helperPeakRssKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]),
        nodeTestWorkerRssBytes: memory.rss,
        nodeTestWorkerHeapBytes: memory.heapUsed,
        nodeTestWorkerExternalBytes: memory.external,
        nodeTestWorkerArrayBuffersBytes: memory.arrayBuffers,
      }),
    );
    const start = Date.now();
    h.b.close();
    await pause(200);
    stream.resume();
    const result = await h.b.done;
    expect(result.outcome).toBe("reaped");
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await terminalIdentitiesGone(result.identitiesChecked)).toBe(true);
  }, 10000);
  it("agent process death/pipe EOF triggers helper cleanup; an outer subreaper actually waits the helper", async () => {
    const f = fixture();
    const config = {
      op: "start",
      cwd: f.cwd,
      cols: 80,
      rows: 24,
      inputIdleMs: 3600000,
      maxLifetimeMs: 28800000,
      fixture: f,
    };
    // Supervisor, not the agent, is a subreaper solely to make the test's orphan helper waitable.
    const supervisor = String.raw`
import ctypes,os,sys,json,subprocess,time,signal
ctypes.CDLL(None).prctl(36,1,0,0,0)
x=json.loads(sys.stdin.read())
agent=r'''
import subprocess,sys,json,time,os
x=json.loads(sys.stdin.read())
p=subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-u','-c',x['helper']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
p.stdin.write((json.dumps(x['config'])+'\n').encode());p.stdin.flush()
managed=[]
while True:
 f=json.loads(p.stdout.readline())
 if 'managed' in f: managed=f['managed']
 if f['t']=='ready':
  print(json.dumps({'helper':p.pid,'managed':managed}),flush=True);break
while True: time.sleep(1)
'''
p=subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-u','-c',agent],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
p.stdin.write(json.dumps(x).encode());p.stdin.close()
row=json.loads(p.stdout.readline());os.kill(p.pid,signal.SIGKILL);p.wait(timeout=2)
end=time.monotonic()+8
waited=[]
while time.monotonic()<end:
 try:
  pid,status=os.waitpid(-1,os.WNOHANG)
  if pid: waited.append([pid,os.waitstatus_to_exitcode(status)])
  if pid==row['helper']: break
 except ChildProcessError: break
 time.sleep(.02)
print(json.dumps({'row':row,'waited':waited}),flush=True)
`;
    const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-u", "-c", supervisor], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      stdout += String(b);
    });
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    child.stdin.end(JSON.stringify({ helper: TERMINAL_PYTHON_HELPER, config }));
    const [code] = await once(child, "close");
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.waited).toContainEqual([result.row.helper, 0]);
    for (const i of result.row.managed) expect(await readTerminalIdentity(i.pid)).toBeUndefined();
  }, 15000);
});

async function ownerHarness(f: TerminalTestFixture) {
  const sent: Array<TermRes | TermEvent> = [],
    physical: TerminalBackend[] = [];
  const current = { localConnectionInstance: "connection", sessionId: "session", epoch: "epoch" };
  const owner = await createTerminalOwner({
    ...current,
    cwd: f.cwd,
    limits: { maxPerSession: 1, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
    allowed: () => true,
    current: () => current,
    send: (frame) => {
      expect(terminalFrameOk(frame)).toBe(true);
      sent.push(frame);
      return true;
    },
    backend: (options) => {
      const b = createTerminalTestBackend(options, f);
      physical.push(b);
      return b;
    },
  });
  owners.push(owner);
  const scope = { sessionId: "session", epoch: "epoch", ownerInstance: owner.ownerInstance };
  const request = (op: string, extra: object = {}) => {
    const frame = {
      t: "term_req",
      v: 1,
      rid: `request-${sent.length}`,
      ...scope,
      op,
      ...(["protocol_ready", "bind"].includes(op) ? {} : { channelId: "channel" }),
      ...extra,
    };
    expect(terminalFrameOk(frame)).toBe(true);
    expect(owner.receive(frame)).toBe(true);
    return frame as TermReq;
  };
  const offer = owner.offer(
    {
      t: "cmd",
      rid: "offer",
      id: "offer",
      deadlineMs: 3000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "req" },
      cmd: { op: "command", name: "webhub", args: "__terminal" },
    },
    { v: 1, action: "negotiate", requestNonce: "nonce" },
  )!;
  expect(physical).toHaveLength(0);
  expect(
    owner.receive({
      t: "term_req",
      v: 1,
      rid: "prepare",
      sessionId: "session",
      epoch: "epoch",
      op: "prepare_protocol",
      offerId: offer.offerId,
      hubNonce: "hub",
    }),
  ).toBe(true);
  const challenge = sent.at(-1) as Extract<TermRes, { op: "protocol_challenge" }>;
  const handshake = { offerId: offer.offerId, hubNonce: "hub", agentChallenge: challenge.agentChallenge };
  request("protocol_ready", handshake);
  const ready = sent.at(-1) as Extract<TermRes, { op: "protocol_ready"; mode: "interactive" }>;
  request("bind", { ...handshake, proposedChannelId: "channel", grant: ready.grant });
  expect(physical).toHaveLength(0);
  const open = (id = "one") =>
    request("open", {
      openId: id,
      termId: `t-${id}`,
      reservationId: `r-${id}`,
      ownerKey: "user",
      attachmentId: "attachment",
      writerLease: "lease",
      cols: 80,
      rows: 24,
      createTicket: {
        v: 1,
        bootId: "boot",
        ticketId: id,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        ownerBinding: { listener: "loopback", principal: "user", sidTag: "sid", agentKey: "agent", ...scope },
        payloadDigest: "a".repeat(64),
        mac: "b".repeat(64),
      },
    });
  return { owner, sent, physical, request, open };
}
describe("Q4 physical half / §5.5: close ACK ≠ reaped proof", () => {
  it.each(["pre-fork", "pre-exec"] as const)(
    "cancels a true helper at %s barrier; late future cannot create a second shell or release early",
    async (barrier) => {
      const f = fixture("bash", barrier === "pre-fork" ? { startDelayMs: 800 } : { execDelayMs: 800 });
      const h = await ownerHarness(f);
      h.open();
      expect(h.owner.physicalUsed).toBe(1);
      expect(h.physical).toHaveLength(1);
      await until(() => h.physical[0]!.managed.some((i) => i.role === (barrier === "pre-fork" ? "helper" : "shell")));
      const entry = h.owner.resourceEntries()[0]!;
      expect(entry.spawnState).toBe("pending");
      expect(h.owner.reapProof(entry.identity, evidence)).toBeUndefined();
      h.request("close", { termId: "t-one", reservationId: "r-one", closeId: "close", expectedRevision: 1 });
      expect(h.sent.at(-1)).toMatchObject({ op: "close", ok: true, state: "closing" });
      expect(h.owner.physicalUsed).toBe(1);
      expect(h.owner.reapProof(entry.identity, evidence)).toBeUndefined();
      for (const id of ["two", "three", "four"]) h.open(id);
      expect(h.physical).toHaveLength(1); // also inspect real live identities, not just mock spawn counts
      const identities = h.physical[0]!.managed;
      expect(identities.filter((i) => i.role === "helper")).toHaveLength(1);
      expect(identities.filter((i) => i.role === "shell").length).toBeLessThanOrEqual(1);
      const result = await h.physical[0]!.done;
      expect(result.outcome).toBe("reaped");
      await until(() => h.owner.physicalUsed === 0);
      const proof = h.owner.reapProof(entry.identity, evidence)!;
      expect(Value.Check(TerminalReapProofSchema, proof)).toBe(true);
      expect(proof).toMatchObject({
        ...evidence,
        identity: entry.identity,
        spawnSettled: true,
        helperReaped: true,
        ptyClosed: true,
        managedGroupsGone: true,
      });
      expect(await terminalIdentitiesGone(proof.identitiesChecked)).toBe(true);
      if (barrier === "pre-exec") expect(result.waited).toContain(identities.find((i) => i.role === "shell")!.pid);
      await pause(900);
      expect(h.owner.physicalUsed).toBe(0); // original late barrier cannot re-fork
    },
    15000,
  );
  it("true owner protocol detach/attach preserves the same shell; replay barrier, exact proof identities and multiple pgids", async () => {
    const h = await ownerHarness(fixture());
    h.open();
    await until(() => h.sent.some((f) => f.t === "term_event" && f.kind === "replay_begin"));
    const b = h.physical[0]!;
    const openResponse = h.sent.find((f) => f.t === "term_res" && f.op === "open" && f.ok)!;
    expect(openResponse).toMatchObject({ shellName: "bash", userLabel: "terminal-fixture" });
    expect(openResponse).toHaveProperty("cwd");
    expect(openResponse).toHaveProperty("hostLabel");
    h.request("list");
    for (const row of (h.sent.at(-1) as { rows: unknown[] }).rows)
      for (const key of ["shellName", "userLabel", "hostLabel", "cwd"]) expect(row).not.toHaveProperty(key);
    const writer = { termId: "t-one", attachmentId: "attachment", writerLease: "lease" };
    const writable = () => {
      const begin = h.sent.findLast((f) => f.t === "term_event" && f.kind === "replay_begin") as Extract<
        TermEvent,
        { kind: "replay_begin" }
      >;
      h.request("ack", {
        ...writer,
        ack: {
          phase: "replay_ready",
          attemptId: begin.attemptId,
          replayEpoch: begin.replayEpoch,
          renderedThrough: begin.N0,
        },
      });
      return (
        h.sent.findLast((f) => f.t === "term_event" && f.kind === "cutover") as Extract<TermEvent, { kind: "cutover" }>
      ).newLiveEpoch;
    };
    let epoch = writable();
    // Ready means exec handshake, not rc completion. Wait for rc output before input.
    await until(() =>
      h.sent.some(
        (f) =>
          f.t === "term_event" &&
          f.kind === "output" &&
          Buffer.from(f.bytesB64, "base64").toString().includes("RC_READY"),
      ),
    );
    const pid = b.managed.find((i) => i.role === "shell")!.pid;
    h.request("detach", writer);
    expect(h.owner.physicalUsed).toBe(1);
    h.request("attach", {
      termId: "t-one",
      attachId: "attach",
      attachmentId: "attachment",
      writerLease: "lease",
      cols: 100,
      rows: 40,
    });
    epoch = writable();
    expect(b.managed.find((i) => i.role === "shell")!.pid).toBe(pid);
    h.request("input", {
      ...writer,
      inputSeq: 0,
      inputKind: "user",
      streamEpoch: epoch,
      bytesB64: Buffer.from("sleep 90 &\nsleep 90\n").toString("base64"),
    });
    await until(() => new Set(b.managed.filter((i) => i.role !== "helper").map((i) => i.pgid)).size >= 3);
    const entry = h.owner.resourceEntries()[0]!;
    h.request("state", { target: { termId: "t-one" } });
    const fact = (h.sent.at(-1) as { fact: { revision: number } }).fact;
    h.request("close", { termId: "t-one", reservationId: "r-one", closeId: "close", expectedRevision: fact.revision });
    expect(h.owner.reapProof(entry.identity, evidence)).toBeUndefined();
    await b.done;
    await until(() => h.owner.physicalUsed === 0);
    const proof = h.owner.reapProof(entry.identity, evidence)!;
    expect(proof.identitiesChecked.find((i) => i.role === "shell")!.pid).toBe(pid);
    expect(
      new Set(proof.identitiesChecked.filter((i) => i.role !== "helper").map((i) => i.pgid)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(await terminalIdentitiesGone(proof.identitiesChecked)).toBe(true);
    expect(h.owner.reapProof({ ...entry.identity, reservationId: "wrong" }, evidence)).toBeUndefined();
  }, 15000);
  it("helper exit alone is NOT evidence; even after fallback kills groups the reservation stays poisoned", async () => {
    const h = await ownerHarness(fixture());
    h.open();
    await until(() => h.physical[0]?.managed.some((i) => i.role === "shell") === true);
    const b = h.physical[0]!;
    const entry = h.owner.resourceEntries()[0]!;
    const helper = b.managed.find((i) => i.role === "helper")!;
    process.kill(helper.pid, "SIGKILL");
    const result = await b.done;
    expect(result.outcome).toBe("reap_incomplete");
    expect(h.owner.physicalUsed).toBe(1);
    expect(h.owner.reapProof(entry.identity, evidence)).toBeUndefined();
    h.open("two");
    expect(h.physical).toHaveLength(1);
    // No false green due to leaked ordinary children: fallback is physical, poison is bookkeeping.
    await until(async () => {
      const shell = b.managed.find((i) => i.role === "shell")!;
      const current = await readTerminalIdentity(shell.pid);
      if (!current) return true;
      // Orphan zombie in a non-reaping container is still NOT a success proof.
      return readFileSync(`/proc/${shell.pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === true;
    });
    await h.owner.dispose();
    const global = globalThis as Record<symbol, unknown>;
    // Isolated test teardown only: this deliberately poisoned fixture never enables a later test.
    const store = global[Symbol.for("pi-subagent:web-hub:terminal-resource-fence-v1")] as
      Array<{ identity: { ownerInstance: string } }> | undefined;
    if (store)
      for (let i = store.length - 1; i >= 0; i--)
        if (store[i]!.identity.ownerInstance === h.owner.ownerInstance) store.splice(i, 1);
  }, 15000);
});
