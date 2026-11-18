/** Actual fixed O7239/N artifacts, real SDK/UDS/auth and ordinary channel. UI checks
 * execute their exact measured pure capability code, NOT a browser/GPU claim.
 * Ledger/partial corruption cases below are explicit owned fault fixtures, never
 * JSON drain authority; actual original live O/N bridge must still refuse them.
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TERMINAL_V2_ERROR_STATUS } from "../../src/web-hub/protocol/terminal-v2.js";
import { ControlledDeployment } from "../../scripts/web-hub/terminal-v2-maintenance/deployment.js";
import { buildMeasuredRuntime } from "../../scripts/web-hub/terminal-v2-maintenance/build.js";
import { createOwnedFixture } from "../../scripts/web-hub/terminal-v2-maintenance/fixture.js";
import { LiveRuntime } from "../../scripts/web-hub/terminal-v2-maintenance/live.js";
import { privateLogin, privatePost, privateSse } from "../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
const parent = () => {
  const dir = mkdtempSync(join(tmpdir(), "t51-mix-"));
  chmodSync(dir, 0o700);
  return dir;
};
for (const hubKind of ["old", "new"] as const)
  it(`actual ${hubKind} hub × opposite actual SDK agent: ordinary channel works, both UI versions/terminal refuse, zero PTY`, async () => {
    const d = await ControlledDeployment.create(parent()),
      old = await buildMeasuredRuntime(d.scope.directory, "old");
    let runtime: LiveRuntime | undefined;
    try {
      if (hubKind === "new") await d.fresh();
      const fixture = createOwnedFixture(d.scope),
        hubBuild = hubKind === "old" ? old : d.newBuild,
        agentBuild = hubKind === "old" ? d.newBuild : old;
      runtime = await LiveRuntime.start(hubBuild, d.scope, fixture, agentBuild);
      const target = await runtime.target(),
        uiAgent = { session: target.session, card: { epoch: target.epoch }, status: target.status };
      expect(await (await old.load()).uiEnabled(runtime.hub.info, uiAgent)).toBe(false);
      expect(await (await d.newBuild.load()).uiEnabled(runtime.hub.info, uiAgent)).toBe(false);
      const cookie = await privateLogin(runtime.hub.httpPort, runtime.hub.paths.tokenFile),
        stream = await privateSse(runtime.hub.httpPort, cookie);
      try {
        const hello = await stream.wait((event) => event.event === "hello");
        await stream.wait((event) => event.event === "agents");
        expect(
          (
            await privatePost(
              runtime.hub.httpPort,
              "/api/subscribe",
              { clientId: hello.data.clientId, agentKey: target.agentKey },
              cookie,
            )
          ).status,
        ).toBe(202);
        if (hubKind === "old") {
          const connection = await stream.wait((event) => event.event === "terminal_connection");
          const response = await privatePost(
            runtime.hub.httpPort,
            "/api/terminal/prepare",
            {
              agentKey: target.agentKey,
              expect: { sessionId: target.session.sessionId, epoch: target.epoch },
              clientId: hello.data.clientId,
              connectionInstance: connection.data.connectionInstance,
              connectionToken: connection.data.connectionToken,
              cols: 80,
              rows: 24,
            },
            cookie,
          );
          expect(response.status).toBe(409);
          expect(response.body.code).toBe("E_UNSUPPORTED");
        } else {
          const response = await privatePost(
            runtime.hub.httpPort,
            "/api/terminal/v2/list",
            { scope: { agentKey: target.agentKey, sessionId: target.session.sessionId, epoch: target.epoch } },
            cookie,
          );
          expect(response.status, JSON.stringify(response.body)).toBe(TERMINAL_V2_ERROR_STATUS.E_UNSUPPORTED);
          expect(response.body.code).toBe("E_UNSUPPORTED");
          expect((await privatePost(runtime.hub.httpPort, "/api/terminal/open", {}, cookie)).status).toBe(404);
        }
        const facts = await runtime.facts();
        expect(facts.worker.owner?.rows ?? []).toEqual([]);
        expect(hubKind === "old" ? facts.fence.journal.resources : facts.service.ledger.allocations).toEqual([]);
        if (hubKind === "new") {
          expect(facts.backends).toEqual([]);
          expect(facts.service.contextFlights).toBe(0);
        }
      } finally {
        stream.close();
      }
    } finally {
      if (runtime) {
        await runtime.stop();
        await runtime.release();
      }
      old.close();
      await d.close();
    }
  }, 60000);
it("actual true-off hub and SDK omit all candidates/services and preserve prepared resource bytes", async () => {
  const d = await ControlledDeployment.create(parent());
  let runtime: LiveRuntime | undefined;
  try {
    await d.fresh();
    const ledger = join(d.scope.state.path, "terminal-v2/ledger.json"),
      before = readFileSync(ledger);
    writeFileSync(
      join(d.scope.home, ".pi/agent/pi-toolkit.json"),
      JSON.stringify({ webHub: { terminal: { enabled: false } } }),
      { mode: 0o600 },
    );
    runtime = await LiveRuntime.start(d.newBuild, d.scope, createOwnedFixture(d.scope), d.newBuild, "ordinary");
    expect(runtime.hub.info.caps).not.toContain("terminal.tabs.v2");
    const target = await runtime.target();
    expect(target.status.terminalSessionV2).toBeUndefined();
    expect((await runtime.facts()).service).toBeUndefined();
    expect((await runtime.facts()).worker.ownerFactoryRuns).toBe(0);
    const cookie = await privateLogin(runtime.hub.httpPort, runtime.hub.paths.tokenFile);
    expect((await privatePost(runtime.hub.httpPort, "/api/terminal/v2/list", {}, cookie)).status).toBe(404);
    await runtime.stop();
    expect(readFileSync(ledger)).toEqual(before);
  } finally {
    if (runtime) {
      await runtime.stop();
      await runtime.release();
    }
    await d.close();
  }
}, 60000);
it("real checkpoint then unreadable v1: N actual startup/input/proof/prune succeeds, rollback refuses without repair", async () => {
  const d = await ControlledDeployment.create(parent());
  try {
    const prepared = await d.prepareCheckpoint(),
      old = join(d.scope.state.path, "terminal-v1");
    const evidenceBefore = readdirSync(d.scope.evidence.path);
    chmodSync(old, 0o000); // deliberate owned filesystem fault, NOT a physical-drain assertion
    const { newDrain } = await d.useAndDrainNew();
    expect(newDrain.evidence).toMatchObject({ allocations: 0, backend: 0, pendingSpawn: 0, dispose: "clean" });
    expect(newDrain.facts.service.physicalPrunes).toBe(1);
    await expect(d.inspectRollback()).rejects.toThrow();
    expect(readdirSync(d.scope.evidence.path)).toEqual(evidenceBefore);
    expect(readFileSync(join(d.scope.state.path, ".terminal-initialized-v2"), "utf8")).toContain(
      prepared.checkpoint.checkpointId,
    );
  } finally {
    await d.close();
  } // retain unreadable v1/old original evidence, no chmod healing
}, 60000);
it("actual stopped N proof cannot authorize a reintroduced real allocation row or repair external ledger corruption", async () => {
  const d = await ControlledDeployment.create(parent());
  try {
    await d.prepareCheckpoint();
    const { n, newDrain } = await d.useAndDrainNew();
    expect(n.reservedLedger.allocations).toHaveLength(1);
    const ledger = join(d.scope.state.path, "terminal-v2/ledger.json"),
      beforeNames = readdirSync(d.scope.evidence.path);
    const fault = JSON.stringify({ ...n.reservedLedger, revision: newDrain.facts.service.ledger.revision + 1 });
    writeFileSync(ledger, fault, { mode: 0o600 }); // owned fault fixture from a REAL prior reservation, not invented authority
    await expect(d.inspectRollback()).rejects.toMatchObject({ code: "same-v2-ledger-readback-unproven" });
    expect(readFileSync(ledger, "utf8")).toBe(fault);
    expect(readdirSync(d.scope.evidence.path)).toEqual(beforeNames);
    expect(() => d.scope.beginPublisher("old")).toThrow(/deployment-floor/);
  } finally {
    await d.close();
  }
}, 60000);
it("actual fresh constructor does not heal a partial v2 layout or delete its original bytes", async () => {
  const d = await ControlledDeployment.create(parent());
  try {
    const partial = d.scope.state.mkdir("terminal-v2"),
      file = partial.create("marker.json", Buffer.from('{"partial":true}'));
    partial.close();
    await expect(d.fresh()).rejects.toThrow();
    expect(readFileSync(join(d.scope.state.path, "terminal-v2/marker.json"))).toEqual(file.bytes);
    expect(readdirSync(d.scope.evidence.path)).toEqual([]);
    expect(readdirSync(join(d.scope.state.path, "terminal-v2"))).toEqual(["marker.json"]);
  } finally {
    await d.close();
  }
}, 60000);
