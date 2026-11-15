/** Hub unit seam: production authority file/proc verifier and service; dedicated
 * wire peer is deterministic, NOT a PTY/receipt/HTTP integration substitute. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  createLocalAuthority,
  localProcess,
  processNamespaces,
  localRecordPath,
  writePhysicalReceipt,
  verifyLocalReceipt,
} from "../../../../src/web-hub/protocol/terminal-local.js";
import type { TerminalSession } from "../../../../src/web-hub/protocol/terminal-session.js";
import {
  terminalFrameOk,
  TERMINAL_JOURNAL_FILE,
  type TerminalHubConfig,
  type TerminalHttpRequests,
  type TerminalResourceEntry,
  type TerminalLocalReference,
} from "../../../../src/web-hub/protocol/terminal.js";
import type { HubFrame } from "../../../../src/web-hub/protocol/messages.js";
import type { TerminalAgentLink } from "../../../../src/web-hub/hub/agent-server.js";
import { createTerminalLocalAuthority } from "../../../../src/web-hub/hub/terminal/local-authority.js";
import { createTerminalService } from "../../../../src/web-hub/hub/terminal/service.js";
import {
  TerminalResourceFence,
  createLocalTerminalProofVerifier,
  inventoryDigest,
} from "../../../../src/web-hub/hub/terminal/resource-fence.js";
import { createTerminalResourceJournal } from "../../../../src/web-hub/hub/terminal/resource-fence-journal.js";
import type { LiveTerminalBinding } from "../../../../src/web-hub/hub/terminal/sse-binding.js";
import type { AuthIdentity } from "../../../../src/web-hub/hub/auth-identity.js";
import { tmpDirs } from "../helpers.js";
const tmp = tmpDirs();
const disposes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
  tmp.cleanup();
});
const machine: TerminalHubConfig = {
  maxPerSession: 4,
  maxPerPrincipal: 3,
  maxTotal: 5,
  inputIdleMs: 600000,
  maxLifetimeMs: 3600000,
};
async function harness() {
  const state = tmp.make("wh-admit-");
  chmodSync(state, 0o700);
  const meta = { agentKey: "agent", linkGen: 1, sessionId: "session", epoch: "epoch" };
  const ownerInstance = "owner";
  const authority = await createLocalAuthority(
    state,
    {
      agentNonce: "nonce",
      sessionId: meta.sessionId,
      epoch: meta.epoch,
      ownerInstance,
      process: localProcess(process.pid),
      namespaces: processNamespaces(process.pid),
      domain: "plain",
      main: true,
      active: true,
    },
    () => true,
  );
  disposes.push(() => authority.revoke());
  let live = true;
  let claim: TerminalSession | undefined = {
    v: 1,
    enabled: true,
    sessionId: meta.sessionId,
    epoch: meta.epoch,
    limits: { ...machine, maxTotal: 32, maxPerPrincipal: 8, maxPerSession: 3, inputIdleMs: 300000 },
  };
  let version = 1;
  let readyLimits = { ...machine, maxTotal: 1, maxPerPrincipal: 1, maxPerSession: 2, maxLifetimeMs: 1800000 };
  let beforeBind: (() => void) | undefined;
  const sent: HubFrame[] = [];
  const fork = vi.fn(); // mock-peer fork boundary; no real PTY is created in this unit harness
  let resourceOnly = false;
  let inventoryEvidence: { entry: TerminalResourceEntry; receipt: TerminalLocalReference } | undefined;
  let afterResponse: ((frame: HubFrame) => void) | undefined;
  let hold: { matches(frame: HubFrame): boolean; reached(): void; release?: () => void } | undefined;
  let local: ReturnType<typeof createTerminalLocalAuthority>;
  let service: ReturnType<typeof createTerminalService>;
  const deliver = (r: unknown) => {
    if (!local.consumes(meta, r)) service.ingress.consumeAgentFrame(meta, r);
  };
  const respond = (frame: HubFrame, responses: unknown[]) => {
    const dispatch = () => {
      for (const response of responses) {
        if ((response as { t?: string }).t === "term_res")
          expect(terminalFrameOk(response), JSON.stringify(response)).toBe(true);
        deliver(response);
      }
      afterResponse?.(frame); // deliberately AFTER ingress.resolve, BEFORE the await continuation
    };
    if (hold?.matches(frame)) {
      const pending = hold;
      hold = undefined;
      pending.release = dispatch;
      pending.reached();
    } else dispatch();
  };
  const send = (frame: HubFrame) => {
    sent.push(frame);
    queueMicrotask(() => {
      if (frame.t === "cmd") {
        resourceOnly = frame.cmd.op === "command" && (frame.cmd.args ?? "").includes("resource_inventory");
        respond(frame, [
          {
            t: "cmd_result",
            rid: frame.rid,
            id: frame.id,
            ok: true,
            data: {
              op: "command",
              kind: "builtin",
              completion: "sync",
              history: "none",
              terminal: { v: 1, outcome: "handshake-required", offerId: "offer" },
            },
          },
        ]);
        return;
      }
      if (frame.t !== "term_req") return;
      const base = {
        t: "term_res",
        v: 1,
        rid: frame.rid,
        sessionId: meta.sessionId,
        epoch: meta.epoch,
        ownerInstance,
        ok: true,
      };
      let response: unknown;
      if (frame.op === "prepare_protocol")
        response = {
          ...base,
          op: "protocol_challenge",
          offerId: frame.offerId,
          hubNonce: frame.hubNonce,
          agentChallenge: "challenge",
          authorityAvailable: true,
        };
      else if (frame.op === "authority") response = { ...base, op: "authority", authority: authority.reference };
      else if (frame.op === "protocol_ready")
        response = {
          ...base,
          op: "protocol_ready",
          offerId: frame.offerId,
          hubNonce: frame.hubNonce,
          agentChallenge: frame.agentChallenge,
          ...(resourceOnly
            ? { mode: "resource-only", channelId: "resource-channel" }
            : {
                mode: "interactive",
                grant: "grant",
                expiresAt: 50000,
                backend: "linux-pty-v1",
                limits: readyLimits,
              }),
        };
      else if (frame.op === "bind") {
        beforeBind?.();
        response = { ...base, op: "bind", channelId: frame.proposedChannelId, bound: true };
      } else if (frame.op === "open") {
        fork();
        response = {
          ...base,
          op: "open",
          channelId: frame.channelId,
          termId: frame.termId,
          reservationId: frame.reservationId,
          attachmentId: frame.attachmentId,
          writerLease: frame.writerLease,
          revision: 1,
          state: "live",
          nextInputSeq: 0,
          baseOffset: 0,
          nextOffset: 0,
          deadlines: { inputIdleAt: 999999, lifetimeAt: 999999, parentExpiresAt: 999999 },
          replayMode: "cold",
        };
      } else if (frame.op === "inventory") {
        const { hubBootId, challengeId, linkGen } = frame.challenge;
        const scope = { hubBootId, challengeId, linkGen, inventoryId: "inventory", revision: 1 };
        const entries = inventoryEvidence ? [inventoryEvidence.entry] : [];
        const digest = inventoryDigest(entries);
        const proofs = inventoryEvidence
          ? [
              {
                ...scope,
                identity: inventoryEvidence.entry.identity,
                agentProcessIdentity: inventoryEvidence.entry.agentProcessIdentity,
                proofId: "proof",
                receipt: inventoryEvidence.receipt,
                spawnSettled: true,
                ptyClosed: true,
                helperReaped: true,
                managedGroupsGone: true,
                identitiesChecked: [],
                outcome: "reaped",
              },
            ]
          : [];
        const page = (data: object) => ({
          ...base,
          op: "inventory",
          channelId: frame.channelId,
          page: { ...scope, ...data },
        });
        respond(frame, [
          page({
            phase: "begin",
            sender: {
              agentSessionId: meta.sessionId,
              epoch: meta.epoch,
              ownerInstance,
              processIdentity: localProcess(process.pid),
            },
            totalCount: entries.length,
            chunkCount: entries.length ? 1 : 0,
            digest,
          }),
          ...(entries.length ? [page({ phase: "chunk", chunkIndex: 0, entries, proofs })] : []),
          page({
            phase: "end",
            chunkCount: entries.length ? 1 : 0,
            totalCount: entries.length,
            digest,
            complete: true,
          }),
        ]);
        return;
      } else return;
      respond(frame, [response]);
    });
    return true;
  };
  const link = (): TerminalAgentLink | undefined =>
    live
      ? {
          meta: { ...meta },
          agentId: { pid: process.pid, nonce: "nonce" },
          kind: "tui",
          pendingBytes: 0,
          send,
          ...(claim === undefined ? {} : { terminalSession: structuredClone(claim) }),
          authorizationVersion: version,
        }
      : undefined;
  local = createTerminalLocalAuthority({ store: authority.store, link, now: () => 1000 });
  disposes.push(() => local.dispose());
  const fence = new TerminalResourceFence({
    now: () => 1000,
    journal: createTerminalResourceJournal({ stateDir: authority.store.root, now: () => 1000 }),
    verifyProof: createLocalTerminalProofVerifier({
      receipt: (proof, entry) => verifyLocalReceipt(authority.store, proof, entry),
    }),
  });
  await fence.initialize(new AbortController().signal);
  service = createTerminalService({
    config: machine,
    now: () => 1000,
    target: local.target,
    resolveTarget: local.ensure,
    resourceCurrent: local.resourceCurrent,
    resourceFence: fence,
    send: (_meta, f) => send(f),
    pendingBytes: () => 0,
    privacy: { denied: () => false, onChange: () => () => {} },
    audit: () => {},
  });
  disposes.push(() => service.dispose());
  const identity: AuthIdentity = {
    listener: "loopback",
    principal: "principal",
    sidTag: "sid",
    parentExpiresAt: 10000000,
  };
  service.auth.loginComplete(identity, 0, service.auth.revision);
  // Explicit binding seam only: loginComplete/proof is real above, HTTP/SSE is separate gate.
  const binding: LiveTerminalBinding = {
    identity,
    active: true,
    metadata: {
      ...identity,
      fenceRevision: 0,
      authEpoch: 0,
      clientId: "client",
      connectionInstance: "connection",
      connectionToken: "token",
      live: true,
    },
    activate() {},
    onRevoke: () => () => {},
    send: () => true,
    revoke() {},
  };
  const base = {
    agentKey: meta.agentKey,
    expect: { sessionId: meta.sessionId, epoch: meta.epoch },
    clientId: "client",
    connectionInstance: "connection",
    connectionToken: "token",
    tabId: "tab",
  };
  const request = <K extends keyof TerminalHttpRequests>(op: K, body: TerminalHttpRequests[K]) =>
    service.request(op, body, identity, binding, new AbortController().signal);
  const prepare = () => request("prepare", { ...base, cols: 80, rows: 24 });
  return {
    local,
    authority,
    fence,
    fork,
    collect() {
      const target = local.target(meta.agentKey);
      if (!target) throw new Error("fixture target unavailable");
      return service.collect(identity, binding, target, new AbortController().signal);
    },
    afterResponse(fn: (frame: HubFrame) => void) {
      afterResponse = fn;
    },
    holdResponse(op: "offer" | "authority" | "inventory") {
      let reached!: () => void;
      const pending = {
        matches: (frame: HubFrame) => (op === "offer" ? frame.t === "cmd" : frame.t === "term_req" && frame.op === op),
        reached: () => reached(),
        release: undefined as (() => void) | undefined,
      };
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      hold = pending;
      return {
        arrived,
        release() {
          if (!pending.release) throw new Error("response has not arrived");
          pending.release();
        },
      };
    },
    async publishReapedReceipt(entry: TerminalResourceEntry) {
      const receipt = await writePhysicalReceipt(
        {
          store: authority.store,
          ownerRecordId: authority.recordId,
          identity: entry.identity,
          agentProcessIdentity: entry.agentProcessIdentity,
        },
        {
          outcome: "reaped",
          spawnSettled: true,
          ptyClosed: true,
          helperReaped: true,
          managedGroupsGone: true,
          identitiesChecked: [],
          waited: [],
        },
      );
      inventoryEvidence = { entry: { ...structuredClone(entry), spawnState: "settled", state: "closing" }, receipt };
      return receipt;
    },
    meta,
    service,
    binding,
    sent,
    base,
    request,
    prepare,
    setClaim(next: TerminalSession | undefined) {
      claim = next;
      version++;
      service.ingress.onIngressFailure?.(meta);
    },
    getClaim: () => structuredClone(claim!),
    setLive(value: boolean) {
      live = value;
    },
    setReady(value: TerminalHubConfig) {
      readyLimits = value;
    },
    beforeBind(fn: () => void) {
      beforeBind = fn;
    },
  };
}
describe("current declaration is admission, NOT local/physical proof", () => {
  it("old/no-claim agent is never actively probed; valid declaration still must pass real file/proc authority", async () => {
    const h = await harness();
    h.setClaim(undefined);
    await expect(h.prepare()).rejects.toMatchObject({ code: "E_UNSUPPORTED" });
    expect(h.sent).toEqual([]);
    h.setClaim({ v: 1, enabled: true, sessionId: "session", epoch: "epoch", limits: machine });
    expect((await h.prepare()).ok).toBe(true);
    expect(h.local.target("agent")).toMatchObject({ allowed: true, processIdentity: localProcess(process.pid) });
    writeFileSync(localRecordPath(h.authority.store, "authority", h.authority.recordId), "{}");
    expect(h.local.target("agent")).toBeUndefined();
    await expect(h.prepare()).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
  });
  it("session three-way min, global ONLY machine P even when ready/claim disagree", async () => {
    const h = await harness();
    const prepared = await h.prepare();
    const opened = await h.request("open", {
      ...h.base,
      cols: 80,
      rows: 24,
      openId: prepared.openId,
      createTicket: prepared.createTicket,
    });
    expect(opened.deadlines).toMatchObject({ inputIdleAt: 301000, lifetimeAt: 1801000 });
    expect(h.service.limits.physicalUsed).toBe(1);
    // ready.maxPerPrincipal=1 MUST NOT shrink machine P=3.
    h.service.limits.reserve("other-agent", "other-session", "loopback:principal", {
      ...machine,
      maxPerPrincipal: 1,
      maxTotal: 1,
    });
    expect(h.service.limits.physicalUsed).toBe(2);
  });
  it("withdraw→redeclare invalidates old tickets/scopes, without revoking shared SSE or freeing physical quota", async () => {
    const h = await harness();
    const first = await h.prepare();
    const nextClaim = h.getClaim();
    h.setClaim(undefined);
    expect(h.local.target("agent")?.allowed).toBe(false); // physical authority retained
    await expect(h.prepare()).rejects.toMatchObject({ code: "E_UNSUPPORTED" });
    h.setClaim(nextClaim);
    await expect(
      h.request("open", { ...h.base, cols: 80, rows: 24, openId: first.openId, createTicket: first.createTicket }),
    ).rejects.toMatchObject({ code: "E_STALE_CREATION" });
    expect(h.sent.filter((f) => f.t === "term_req" && f.op === "open")).toHaveLength(0);
    expect(h.binding.active).toBe(true);
    expect((await h.prepare()).ok).toBe(true);
  });
  it("withdraw during awaited bind denies before ticket/fork; link/session changes do not reuse authority", async () => {
    const h = await harness();
    h.beforeBind(() => h.setClaim(undefined));
    await expect(h.prepare()).rejects.toMatchObject({ code: "E_SESSION_CHANGED" });
    expect(h.service.tickets.size()).toBe(0);
    expect(h.service.limits.physicalUsed).toBe(0);
    h.setLive(false);
    expect(h.local.target("agent")).toBeUndefined();
    h.setLive(true);
    h.meta.epoch = "new-epoch";
    expect(h.local.target("agent")).toBeUndefined();
  });
});

it("withdraw keeps the occupied physical slot and original authority; it never releases on logical close", async () => {
  const h = await harness();
  const prepared = await h.prepare();
  await h.request("open", {
    ...h.base,
    cols: 80,
    rows: 24,
    openId: prepared.openId,
    createTicket: prepared.createTicket,
  });
  expect(h.service.limits.physicalUsed).toBe(1);
  h.setClaim(undefined);
  expect(h.local.target("agent")).toMatchObject({ allowed: false, ownerInstance: "owner" });
  expect(h.service.limits.physicalUsed).toBe(1);
  expect(h.service.unresolvedResources()).toHaveLength(1);
  expect(h.sent.some((f) => f.t === "term_req" && f.op === "close")).toBe(true);
  await expect(h.prepare()).rejects.toMatchObject({ code: "E_UNSUPPORTED" });
  expect(h.binding.active).toBe(true); // target loss is NOT a new login/SSE/fence lifecycle
});

it("authority unlink revokes interactive admission but an original exact resource flight still checks real producer identity", async () => {
  const h = await harness();
  await h.prepare();
  expect(h.local.resourceCurrent(h.meta)).toBe(true);
  h.authority.revoke();
  expect(h.local.target("agent")).toBeUndefined();
  expect(h.local.resourceCurrent(h.meta)).toBe(true);
  await expect(h.prepare()).rejects.toMatchObject({ code: "E_UNAVAILABLE" });
  h.setLive(false);
  expect(h.local.resourceCurrent(h.meta)).toBe(false);
});

describe("resource discovery cannot cross a declaration withdrawal continuation", () => {
  it.each(["offer", "prepare_protocol", "protocol_ready"] as const)(
    "withdraw AFTER resolved %s reply: no new negotiation/challenge/inventory",
    async (window) => {
      const h = await harness();
      await h.local.ensure("agent", new AbortController().signal);
      const begin = vi.spyOn(h.fence, "begin");
      let withdrawnAt = -1;
      h.afterResponse((frame) => {
        if (withdrawnAt >= 0) return;
        if (window === "offer" ? frame.t === "cmd" : frame.t === "term_req" && frame.op === window) {
          withdrawnAt = h.sent.length;
          h.setClaim(undefined);
        }
      });
      await h.collect();
      expect(withdrawnAt).toBeGreaterThan(0);
      expect(begin).not.toHaveBeenCalled();
      expect(
        h.sent
          .slice(withdrawnAt)
          .filter(
            (frame) => frame.t === "term_req" && ["prepare_protocol", "protocol_ready", "inventory"].includes(frame.op),
          ),
      ).toEqual([]);
      expect(h.fork).not.toHaveBeenCalled();
    },
  );

  it("an established exact challenge still resolves a real receipt and durable CAS after withdrawal", async () => {
    const h = await harness();
    const prepared = await h.prepare();
    await h.request("open", {
      ...h.base,
      cols: 80,
      rows: 24,
      openId: prepared.openId,
      createTicket: prepared.createTicket,
    });
    const entry = h.fence.records().resources[0]!.entry;
    // The unit peer never forked OS children: its settled physical set is genuinely
    // empty. This still uses a real owned receipt, production /proc verifier and
    // durable journal, not verifyProof=true or a close ACK as a release substitute.
    await h.publishReapedReceipt(entry);
    const hold = h.holdResponse("inventory");
    const collecting = h.collect();
    await hold.arrived;
    const inventory = h.sent.filter((f) => f.t === "term_req" && f.op === "inventory");
    expect(inventory).toHaveLength(1);
    const before = h.fence.records().revision;
    expect(h.service.limits.physicalUsed).toBe(1);
    h.setClaim(undefined);
    h.authority.revoke();
    expect(h.local.target("agent")).toBeUndefined();
    expect(h.local.resourceCurrent(h.meta)).toBe(true);
    expect(h.service.limits.physicalUsed).toBe(1); // withdrawal/close is NOT release
    hold.release();
    await collecting;
    expect(h.fence.records().revision).toBeGreaterThanOrEqual(before + 2);
    expect(h.fence.records().resources).toEqual([]);
    expect(h.service.limits.physicalUsed).toBe(0);
    const onDisk = JSON.parse(readFileSync(`${h.authority.store.root}/${TERMINAL_JOURNAL_FILE}`, "utf8"));
    expect(onDisk.resources).toEqual([]);
    const acks = h.sent.filter((frame) => frame.t === "term_req" && frame.op === "resolved_ack");
    expect(acks).toHaveLength(1);
    if (acks[0]?.t !== "term_req" || acks[0].op !== "resolved_ack") throw new Error("exact ACK missing");
    expect(acks[0].resolved.identities).toEqual([entry.identity]);
    if (inventory[0]?.t !== "term_req" || inventory[0].op !== "inventory") throw new Error("inventory missing");
    expect(acks[0].resolved.challengeId).toBe(inventory[0].challenge.challengeId);
    expect(h.sent.filter((frame) => frame.t === "term_req" && frame.op === "inventory")).toHaveLength(1);
  });
});

describe("real authority discovery captures declaration generation, not merely valid identity", () => {
  for (const window of ["offer", "authority"] as const)
    it.each(["version-only", "valid-limit-and-version"] as const)(
      `${window} response held: %s invalidates the old discovery`,
      async (change) => {
        const h = await harness();
        const held = h.holdResponse(window);
        const preparing = h.prepare();
        const rejected = expect(preparing).rejects.toMatchObject({ code: "E_SESSION_CHANGED" });
        await held.arrived;
        const meta = { ...h.meta };
        const claim = h.getClaim();
        const next = structuredClone(claim);
        if (change === "valid-limit-and-version") next.limits.maxPerSession = 2;
        const before = h.sent.length;
        h.setClaim(next); // session/epoch/link unchanged; declaration is STILL valid
        expect(h.meta).toEqual(meta);
        held.release();
        await rejected;
        expect(
          h.sent
            .slice(before)
            .filter((frame) => frame.t === "term_req" && ["protocol_ready", "bind", "open"].includes(frame.op)),
        ).toEqual([]);
        expect(h.fork).not.toHaveBeenCalled();
        expect(h.service.tickets.size()).toBe(0);
        expect(h.local.target("agent")).toBeUndefined();
        const discoveries = () =>
          h.sent.filter(
            (frame) =>
              frame.t === "cmd" && frame.cmd.op === "command" && (frame.cmd.args ?? "").includes("resource_inventory"),
          );
        expect(discoveries()).toHaveLength(1);
        expect((await h.prepare()).ok).toBe(true);
        expect(discoveries()).toHaveLength(2); // genuinely fresh offer/proof chain
        expect(h.local.target("agent")).toMatchObject({ allowed: true, limits: next.limits });
        expect(h.fork).not.toHaveBeenCalled();
      },
    );
});
