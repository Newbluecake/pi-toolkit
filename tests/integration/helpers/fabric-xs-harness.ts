import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function bounded<T>(p: Promise<T>, label: string, ms = 12_000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const end = Date.now() + 12_000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise<void>((r) => {
      const timer = setTimeout(r, 30);
      timer.unref();
    });
  } while (Date.now() < end);
  throw new Error(`timeout: ${label}`);
}
export interface Peer {
  child: ChildProcess;
  rpc<T = any>(op: string, extra?: Record<string, unknown>): Promise<T>;
  event(name: string): Promise<any>;
  kill(): Promise<void>;
}
export class XsHarness {
  readonly home = mkdtempSync(join(tmpdir(), "xw-"));
  readonly peers: Peer[] = [];
  private seq = 0;
  async boot(
    role: "hub" | "agent",
    name: string = role,
    sessionFile?: string,
    xsEnabled = true,
    autoJoin = false,
  ): Promise<Peer> {
    const cwd = join(this.home, "project");
    mkdirSync(cwd, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("tests/integration/helpers/fabric-xs-process.ts"), role],
      {
        cwd: resolve("."),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          HOME: this.home,
          XDG_RUNTIME_DIR: "",
          PI_CODING_AGENT_DIR: join(this.home, `agent-${name}-${++this.seq}`),
          XW_NAME: name,
          XW_AUTO_JOIN: autoJoin ? "1" : "0",
          XW_XS_OFF: xsEnabled ? "0" : "1",
          ...(sessionFile ? { XW_SESSION_FILE: sessionFile } : {}),
        },
      },
    );
    let stderr = "";
    child.stderr!.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-12_000);
    });
    const exited = new Promise<void>((r) => child.once("close", () => r()));
    const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
    const events = new Map<string, Array<(value: any) => void>>();
    let ready!: () => void;
    let failReady!: (e: Error) => void;
    const started = new Promise<void>((r, j) => {
      ready = r;
      failReady = j;
    });
    child.on("message", (m: any) => {
      if (m.ready) ready();
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p?.reject(new Error(m.error)) : p?.resolve(m.value);
      }
      if (m.event) for (const f of events.get(m.event)?.splice(0) ?? []) f(m);
    });
    child.on("close", (code) => {
      const error = new Error(`${role} exit ${code}: ${stderr}`);
      failReady(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    });
    let rid = 0;
    const peer: Peer = {
      child,
      rpc: (op, extra = {}) => {
        const id = ++rid;
        return bounded(
          new Promise<any>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.send({ ...extra, id, op });
          }),
          `${role}:${op}`,
        ).finally(() => pending.delete(id));
      },
      event: (name) =>
        bounded(
          new Promise((r) => {
            events.set(name, [...(events.get(name) ?? []), r]);
          }),
          `${role}:${name}`,
        ),
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(exited, `${role} exit`);
      },
    };
    this.peers.push(peer);
    await bounded(started, `${role} ready`);
    if (role === "agent")
      await until(
        () => peer.rpc("inspect"),
        (s) => s.conn?.state === "live",
        "socket live",
      );
    return peer;
  }
  async close(): Promise<void> {
    await Promise.all(this.peers.map((p) => p.kill()));
    rmSync(this.home, { recursive: true, force: true });
  }
}
export const list = (peer: Peer) => peer.rpc("tool", { name: "list_sessions" });
export const send = (peer: Peer, to: string, text: string, wake?: boolean) =>
  peer.rpc("tool", {
    name: "message_session",
    params: { to, text, ...(wake === undefined ? {} : { wake }) },
  });
export async function joinedPair(h: XsHarness): Promise<{ hub: Peer; a: Peer; b: Peer; aid: string; bid: string }> {
  const hub = await h.boot("hub");
  const [a, b] = await Promise.all([h.boot("agent", "alpha"), h.boot("agent", "beta")]);
  await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
  const aid = (await a.rpc("inspect")).sessionId,
    bid = (await b.rpc("inspect")).sessionId;
  await until(
    () => list(a),
    (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
    "membership publish",
  );
  return { hub, a, b, aid, bid };
}
