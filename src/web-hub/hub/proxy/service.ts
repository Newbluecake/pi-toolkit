/** Hub-owned proxy lifecycle (§3.4). Construct only after the frontend has its ACTUAL ports. */
import { lookup } from "node:dns/promises";
import * as fs from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type {
  AuthIdentity,
  HostSnapshot,
  HubProxyConfig,
  HubLog,
  ProxyService,
  ProxyOpenFailure,
  ProxyOpenOutcome,
} from "../ports.js";
import {
  PROXY_BIND_HOST_LAN,
  PROXY_BIND_HOST_LOOPBACK,
  PROXY_CLOSE_DEADLINE_MS,
  PROXY_LISTEN_TIMEOUT_MS,
  PROXY_INSTANCE_IDLE_MS,
  PROXY_SWEEP_INTERVAL_MS,
  PROXY_PER_PRINCIPAL_MAX,
  PROXY_REASON_RESPONSE,
  buildProxyEnterUrl,
  proxyOriginOf,
  type ProxyDenyReason,
} from "../../protocol/proxy.js";
import {
  createProxyDnsGate,
  resolveProxyTarget,
  systemProxyTimer,
  type ProxyDnsGate,
  type ProxyTimerPort,
  type PinnedProxyTarget,
} from "./dns-gate.js";
import { createProxyPortsMap, type ProxyPortsMap } from "./ports-map.js";
import { createProxySessionStore } from "./sessions.js";
import { createProxyAudit, type ProxyAudit } from "./audit.js";
import { canonicalAddr, parseProxyTarget, proxyTargetKey } from "./target.js";
import { createProxyListener, type ProxyListener } from "./listener.js";
import { createProxyAdmission, type ProxyTraffic } from "./forward.js";

export interface ProxyServiceDeps {
  readonly config: HubProxyConfig;
  readonly stateDir: string;
  readonly hubPort: number;
  readonly lanPort?: number;
  /** Q2: presence of the hub's LAN config, not a user-controlled separate proxy switch. */
  readonly lan: boolean;
  lanHostSnapshot(): HostSnapshot | undefined;
  readonly log: Pick<HubLog, "info">;
  readonly now?: () => number;
  readonly timer?: ProxyTimerPort;
  /** Internal test ports, never set from environment/configuration. */
  readonly portsMap?: ProxyPortsMap;
  readonly dns?: ProxyDnsGate;
  readonly audit?: ProxyAudit;
  readonly localAddresses?: () => readonly string[];
  readonly listen?: (server: Server, port: number, host: string) => Promise<void>;
}
interface Instance {
  logicalKey: string;
  grants: number;
  id: string;
  pinned: PinnedProxyTarget;
  principal: string;
  origin: string;
  port: number;
  createdAt: number;
  lastRequestAt: number;
  listener: ProxyListener;
  traffic: ProxyTraffic;
  closing: boolean;
}
interface Creation {
  abandoned: boolean;
  timeout: boolean;
  abandon(): void;
}
function deny(reason: ProxyDenyReason): ProxyOpenFailure {
  // The frozen table has correlated status/error pairs; keep those pairs together at runtime.
  return { ok: false, ...PROXY_REASON_RESPONSE[reason], reason } as ProxyOpenFailure;
}
const unavailable = (reason: "closing" | "listen-timeout" | "revocation-gap"): ProxyOpenFailure => ({
  ok: false,
  status: 503,
  error: "E_PROXY_UNAVAILABLE",
  reason,
  ...(reason === "revocation-gap" ? { retryable: true } : {}),
});
function listenServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = (err: Error) => {
      server.off("listening", ready);
      reject(err);
    };
    const ready = () => {
      server.off("error", error);
      resolve();
    };
    server.once("error", error);
    server.once("listening", ready);
    server.listen(port, host);
    server.unref();
  });
}
/** Async startup loads the permanent map under X1a's bounded load. A broken map stays inspectable. */
export async function createProxyService(deps: ProxyServiceDeps): Promise<ProxyService> {
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? systemProxyTimer;
  const ports =
    deps.portsMap ?? createProxyPortsMap({ stateDir: deps.stateDir, range: deps.config.portRange, fs, now, timer });
  const dnsSource = deps.dns ?? createProxyDnsGate({ lookup, timer });
  const dns: ProxyDnsGate = {
    get inflight() {
      return dnsSource.inflight;
    },
    async resolve(host) {
      try {
        return await dnsSource.resolve(host);
      } catch {
        return { ok: false, reason: "dns-failed" };
      }
    },
  };
  const audit = deps.audit ?? createProxyAudit(deps.log, now);
  const sessionCounts = new Map<string, ProxyTraffic>();
  const sessionTraffic = (session: import("./sessions.js").ProxySession): ProxyTraffic => {
    let counts = sessionCounts.get(session.sidHash);
    if (!counts) {
      counts = { reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 };
      sessionCounts.set(session.sidHash, counts);
    }
    return counts;
  };
  const sessions = createProxySessionStore({
    now,
    onEnd(session, end) {
      audit.end({ instanceId: session.instanceId, end, ...sessionTraffic(session) });
      sessionCounts.delete(session.sidHash);
    },
  });
  const admission = createProxyAdmission(timer);
  const wsBudget = { active: 0 };
  const instances = new Map<string, Instance>();
  const pending = new Map<string, Promise<Instance | ProxyOpenFailure>>();
  // Includes every caller awaiting the shared creation, not just its capacity owner.
  const openers = new Map<string, number>();
  const creations = new Set<Creation>();
  const reservations = new Map<string, number>();
  const closingInstances = new Set<Promise<void>>();
  let reserved = 0;
  let closing = false;
  let disposed: Promise<void> | undefined;
  let cancelSweep = () => {};
  let sweepArmed = false;
  const boundedClose = (listener: ProxyListener): Promise<void> =>
    new Promise((resolve) => {
      const cancel = timer.after(PROXY_CLOSE_DEADLINE_MS, resolve);
      void listener
        .close()
        .catch(() => {})
        .finally(() => {
          cancel();
          resolve();
        });
    });
  const stopInstance = (inst: Instance, end: "idle" | "close") => {
    if (inst.closing) return Promise.resolve();
    inst.closing = true;
    instances.delete(inst.pinned.key);
    sessions.revoke({ sel: { instanceId: inst.id }, reason: "close" });
    audit.end({ instanceId: inst.id, end, ...inst.traffic });
    audit.forget(inst.id);
    audit.forget(inst.logicalKey);
    if (instances.size === 0) {
      cancelSweep();
      sweepArmed = false;
    }
    const p = boundedClose(inst.listener);
    closingInstances.add(p);
    void p.finally(() => closingInstances.delete(p));
    return p;
  };
  const armSweep = () => {
    if (closing || sweepArmed || instances.size === 0) return;
    sweepArmed = true;
    cancelSweep = timer.after(PROXY_SWEEP_INTERVAL_MS, () => {
      sweepArmed = false;
      sessions.sweep();
      for (const inst of instances.values())
        if (inst.listener.sockets.size === 0 && now() - inst.lastRequestAt >= PROXY_INSTANCE_IDLE_MS)
          void stopInstance(inst, "idle");
      armSweep();
    });
  };
  const create = async (
    pinned: PinnedProxyTarget,
    identity: AuthIdentity,
    browserHost: string,
    logicalKey: string,
  ): Promise<Instance | ProxyOpenFailure> => {
    const creation: Creation = {
      abandoned: false,
      timeout: false,
      abandon() {
        creation.abandoned = true;
      },
    };
    creations.add(creation);
    const id = randomBytes(16).toString("base64url");
    const traffic: ProxyTraffic = { reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 };
    let lastRequestAt = now();
    let candidate: ProxyListener | undefined;
    try {
      const bound = await ports.bind(pinned.key, async (port) => {
        if (closing || creation.abandoned) throw new Error("proxy closing");
        const listener = createProxyListener({
          port,
          hubPort: deps.hubPort,
          ...(deps.lanPort === undefined ? {} : { lanPort: deps.lanPort }),
          lan: deps.lan,
          lanHostSnapshot: deps.lanHostSnapshot,
          instanceId: id,
          pinned,
          sessions,
          sessionTraffic,
          admission,
          traffic,
          now,
          timer,
          budget: wsBudget,
          onRequest() {
            lastRequestAt = now();
            const inst = instances.get(pinned.key);
            if (inst) inst.lastRequestAt = lastRequestAt;
          },
        });
        candidate = listener;
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const abandon = () => {
            creation.abandoned = true;
            void boundedClose(listener);
            if (!done) {
              done = true;
              cancel();
              reject(new Error("proxy listen abandoned"));
            }
          };
          creation.abandon = abandon;
          const cancel = timer.after(PROXY_LISTEN_TIMEOUT_MS, () => {
            creation.timeout = true;
            abandon();
          });
          Promise.resolve()
            .then(() =>
              (deps.listen ?? listenServer)(
                listener.server,
                port,
                deps.lan ? PROXY_BIND_HOST_LAN : PROXY_BIND_HOST_LOOPBACK,
              ),
            )
            .then(
              () => {
                listener.server.unref();
                if (creation.abandoned || closing || done) {
                  // close() may already have run before listen really happened. Always close the
                  // physical late server again, not just its previously-resolved close promise.
                  listener.server.close();
                  listener.server.closeAllConnections();
                  void boundedClose(listener);
                  if (!done) {
                    done = true;
                    cancel();
                    reject(new Error("proxy late listen"));
                  }
                  return;
                }
                done = true;
                cancel();
                resolve();
              },
              (err) => {
                void boundedClose(listener);
                if (!done) {
                  done = true;
                  cancel();
                  reject(err);
                }
              },
            );
        });
        return { value: listener, close: () => boundedClose(listener) };
      });
      if (closing || creation.abandoned) {
        if (candidate) await boundedClose(candidate);
        return unavailable(creation.timeout ? "listen-timeout" : "closing");
      }
      if (!bound.ok) return deny(bound.reason);
      const inst: Instance = {
        logicalKey,
        grants: 0,
        id,
        pinned,
        principal: identity.principal,
        origin: proxyOriginOf(browserHost, bound.port),
        port: bound.port,
        createdAt: now(),
        lastRequestAt,
        listener: bound.value,
        traffic,
        closing: false,
      };
      return inst;
    } catch {
      if (candidate) await boundedClose(candidate);
      return creation.timeout ? unavailable("listen-timeout") : closing ? unavailable("closing") : deny("port-busy");
    } finally {
      creations.delete(creation);
    }
  };
  await ports.load();
  return {
    currentSeq: () => sessions.currentSeq(),
    revokedSince: (seq0, id) => sessions.revokedSince(seq0, id),
    async open(identity, target, browserHost, seq0): Promise<ProxyOpenOutcome> {
      let inst: Instance | undefined;
      const parsed = parseProxyTarget(target);
      // Stable even before an instance exists; paths/queries must not defeat denial throttling.
      // This key is throttle state only and is never emitted as an audit field.
      // X1a also fences literals during parse and returns only a reason on denial. Recover
      // an authority for throttling ONLY (never admission); URL credentials/path/query are
      // discarded, and the same canonical IP function folds mapped-v6 aliases together.
      const deniedAuthority = () => {
        try {
          const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(target) ? target : `http://${target}`);
          return `denied|${canonicalAddr(u.hostname)?.key ?? u.hostname.toLowerCase()}|${u.port || "80"}`;
        } catch {
          return "invalid-target";
        }
      };
      const denialKey = !parsed.ok
        ? deniedAuthority()
        : parsed.target.address === undefined
          ? `dns|${parsed.target.hostHeader}`
          : proxyTargetKey(parsed.target.address, parsed.target);
      const failure = (fail: ProxyOpenFailure): ProxyOpenFailure => {
        audit.open({ ok: false, reason: fail.reason, identity }, denialKey);
        return fail;
      };
      if (closing) return failure(unavailable("closing"));
      if (ports.status() !== "ok") return failure(deny("ports-store"));
      if (!parsed.ok) return failure(deny(parsed.reason));
      // Main-session ruling: literal aliases and unresolved canonical hostname authorities
      // share a logical key BEFORE any await, so reopens consume no new reservation.
      const logicalKey = denialKey;
      openers.set(logicalKey, (openers.get(logicalKey) ?? 0) + 1);
      inst = [...instances.values()].find((i) => i.logicalKey === logicalKey && !i.closing);
      try {
        if (!inst) {
          let promise = pending.get(logicalKey);
          if (!promise) {
            if (
              instances.size + reserved >= deps.config.maxProxies ||
              [...instances.values()].filter((i) => i.principal === identity.principal).length +
                (reservations.get(identity.principal) ?? 0) >=
                PROXY_PER_PRINCIPAL_MAX
            ) {
              return failure({ ok: false, status: 409, error: "E_LIMIT", reason: "proxies" });
            }
            // Synchronous admission, before DNS/listen. No rejected path creates a map binding.
            reserved++;
            reservations.set(identity.principal, (reservations.get(identity.principal) ?? 0) + 1);
            promise = Promise.resolve().then(async (): Promise<Instance | ProxyOpenFailure> => {
              try {
                const result = await resolveProxyTarget(target, dns, {
                  hubPort: deps.hubPort,
                  ...(deps.lanPort === undefined ? {} : { lanPort: deps.lanPort }),
                  proxyRange: deps.config.portRange,
                  localAddresses: (
                    deps.localAddresses ??
                    (() => Object.values(networkInterfaces()).flatMap((a) => a?.map((i) => i.address) ?? []))
                  )(),
                });
                if (!result.ok) return deny(result.reason);
                if (closing) return unavailable("closing");
                const created = await create(result.pinned, identity, browserHost, logicalKey);
                if (!("ok" in created)) {
                  if (closing) {
                    await boundedClose(created.listener);
                    return unavailable("closing");
                  }
                  instances.set(created.pinned.key, created);
                  armSweep();
                }
                return created;
              } catch {
                return unavailable("closing");
              } finally {
                reserved--;
                const n = (reservations.get(identity.principal) ?? 1) - 1;
                if (n === 0) reservations.delete(identity.principal);
                else reservations.set(identity.principal, n);
                pending.delete(logicalKey);
              }
            });
            pending.set(logicalKey, promise);
          }
          const made = await promise;
          if ("ok" in made) return failure(made);
          inst = made;
        }
        if (closing || inst.closing) return failure(unavailable("closing"));
        const origin = proxyOriginOf(browserHost, inst.port);
        const code = sessions.mintCode(seq0, identity, {
          instanceId: inst.id,
          origin,
          nextPath: parsed.target.nextPath,
        });
        if (!code.ok) {
          if (inst.grants === 0 && inst.listener.sockets.size === 0 && openers.get(logicalKey) === 1)
            await stopInstance(inst, "close");
          if ("kind" in code) return failure({ ...unavailable("closing"), retryable: true } as ProxyOpenFailure);
          return failure(code);
        }
        inst.grants++;
        audit.open(
          {
            ok: true,
            identity,
            cls: inst.pinned.cls,
            targetIp: inst.pinned.pinnedIp,
            targetPort: inst.pinned.target.port,
            host: browserHost,
            port: inst.port,
          },
          inst.id,
        );
        return {
          ok: true,
          result: {
            instanceId: inst.id,
            origin,
            enterUrl: buildProxyEnterUrl(origin, code.code),
            target: { host: inst.pinned.target.host, port: inst.pinned.target.port, cls: inst.pinned.cls },
          },
        };
      } catch {
        return failure({ ...unavailable("closing"), retryable: true } as ProxyOpenFailure);
      } finally {
        const left = (openers.get(logicalKey) ?? 1) - 1;
        if (left === 0) openers.delete(logicalKey);
        else openers.set(logicalKey, left);
      }
    },
    list(identity) {
      return {
        items: [...instances.values()].map((i) => ({
          instanceId: i.id,
          target: { host: i.pinned.target.host, port: i.pinned.target.port, cls: i.pinned.cls },
          origin: i.origin,
          createdAt: i.createdAt,
          mine: i.principal === identity.principal,
        })),
        policy: { maxProxies: deps.config.maxProxies, portRange: [...deps.config.portRange], lan: deps.lan },
      };
    },
    async stop(id, identity) {
      const inst = [...instances.values()].find((i) => i.id === id);
      if (!inst || (identity.listener !== "loopback" && inst.principal !== identity.principal))
        return { ok: false, code: "E_NOT_FOUND" };
      await stopInstance(inst, "close");
      return { ok: true };
    },
    revoke: (ev) => sessions.revoke(ev),
    activeConnections: () => [...instances.values()].reduce((n, i) => n + i.listener.sockets.size, 0),
    status: () => ({ instances: instances.size, reserved, portsStore: ports.status() === "ok" ? "ok" : "broken" }),
    dispose() {
      if (disposed) return disposed;
      closing = true;
      cancelSweep();
      sweepArmed = false;
      for (const creation of creations) creation.abandon();
      sessions.revoke({ sel: "all", reason: "close" });
      for (const inst of [...instances.values()]) void stopInstance(inst, "close");
      disposed = Promise.all([...closingInstances]).then(() => {});
      return disposed;
    },
  };
}
