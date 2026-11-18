/** Dedicated P7B consumer OS-process restart gate. Explicit unpacked package
 * required; never falls back to importing this checkout's N service. Safe no-fork
 * subset: stock production PTY uses the system passwd home, not private HOME.
 * L1 create/input/prune is NOT claimed here without a closed test-UID profile. */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  privateLogin,
  privatePost,
  privateSse,
  observeUntil,
} from "../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
import { prepareStockRetained, reopenStockRetained } from "./helpers/terminal-retained-stock-setup.js";
import {
  descendants,
  probeBareStockMainCounterexample,
  stockProcess,
} from "./helpers/terminal-retained-stock-process.js";
const root = process.env.PI_TOOLKIT_STOCK_CONSUMERS;
const phase = process.env.PI_TOOLKIT_STOCK_PHASE ?? "restart";
if (!["restart", "rollback"].includes(phase)) throw new Error("unknown stock phase");
const id = () => randomBytes(24).toString("base64url");
it.each([
  ["npm", 2],
  ["zip", 2],
] as const)(
  `stock %s L%i: sealed consumer ${phase} phase preserves retained debt`,
  async (format, count) => {
    if (!root)
      throw new Error("PI_TOOLKIT_STOCK_CONSUMERS must name private unpacked npm/zip consumers; no checkout fallback");
    const checkpointPath = join(root, `${format}-stock-checkpoint.json`);
    const saved = phase === "rollback" ? JSON.parse(readFileSync(checkpointPath, "utf8")) : undefined;
    const f = saved ? reopenStockRetained(saved.base) : await prepareStockRetained(join(root, format), count);
    expect(f.profile.newPackageRoot).toBe(join(root, format));
    console.log(`stock retained ${phase} evidence: ${f.base}`);
    const ledger = () => JSON.parse(readFileSync(f.ledgerPath, "utf8"));
    const processes: Awaited<ReturnType<typeof stockProcess>>[] = [];
    const lifecycle: unknown[] = saved?.lifecycle ?? [],
      observations: any[] = saved?.observations ?? [];
    const priorProcesses: any[] = saved?.stockProcesses ?? [];
    const cleanups: Array<() => Promise<void>> = [];
    const start = (label: string, sameSession = false) =>
      stockProcess(f, label, sameSession, (stop) => cleanups.push(stop));
    let bareCounterexample = saved?.bareCounterexample;
    const assertLegacy = () => {
      expect(ledger().legacyObligations).toEqual(f.retained);
      expect(ledger().allocations).toEqual([]);
      expect(readFileSync(f.originalJournalPath)).toEqual(f.originalJournal);
      expect(readFileSync(f.paths.tokenFile)).toEqual(f.token);
      for (const row of ledger().legacyObligations) {
        expect(row.sourceManifestSha256).toBe(f.init.sourceManifestSha256);
        expect(row.legacyIdentity).toEqual(
          f.retained.find((r: any) => r.obligationId === row.obligationId).legacyIdentity,
        );
      }
    };
    const inspect = async (app: Awaited<ReturnType<typeof stockProcess>>, sameSession: boolean) => {
      const port = app.hub.port,
        cookie = await privateLogin(port, f.paths.tokenFile),
        stream = await privateSse(port, cookie);
      try {
        expect((await stream.wait((e) => e.event === "hello")).data.clientId).toBeTruthy();
        const target = await observeUntil<any>(async () => {
          const snapshot = await privateSse(port, cookie);
          try {
            const agents = await snapshot.wait((e) => e.event === "agents");
            return agents.data.agents.find(
              (a: any) => a.session?.sessionId === app.state.sessionId && a.status?.terminalSessionV2,
            );
          } finally {
            snapshot.close();
          }
        }, Boolean);
        expect(target.pid).toBe(app.evidence.pi!.pid);
        const scope = { agentKey: target.agentKey, sessionId: target.session.sessionId, epoch: target.epoch };
        const list = await privatePost(port, "/api/terminal/v2/list", { scope }, cookie);
        expect(list.status).toBe(200);
        expect(list.body.ok).toBe(true);
        const sessionUsed = sameSession ? 1 : 0;
        expect(list.body.quota.principal).toMatchObject({ used: count, unknown: count });
        expect(list.body.quota.session.used).toBe(sessionUsed);
        expect(list.body.quota.total).toMatchObject({ used: count, unknown: count });
        expect(list.body.unknownResources).toHaveLength(sessionUsed);
        let denial: unknown,
          samples = 0;
        const helperPids = new Set<number>();
        const sample = () => {
          samples++;
          for (const p of descendants(app.hub.pid)) {
            if (p && p.argv.some((a) => /(?:^|\/)python3?(?:\.[0-9]+)?$/.test(a))) helperPids.add(p.pid);
          }
        };
        sample();
        if (count === 2) {
          // Genuine stock admission, no test backend or quota substitute. Process
          // sampling is supplemental; it is NOT an exact factory invocation counter.
          const timer = setInterval(sample, 5);
          timer.unref();
          try {
            const denied = await privatePost(
              port,
              "/api/terminal/v2/create",
              {
                scope,
                hubInstance: list.body.hubInstance,
                requestId: id(),
                mode: "ensure-empty",
                cols: 80,
                rows: 24,
              },
              cookie,
            );
            expect(denied.body.code).toBe("E_LIMIT");
            expect(denied.body.effect).toBe("none");
            denial = denied;
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 250);
              t.unref();
            });
          } finally {
            clearInterval(timer);
            sample();
          }
        }
        expect([...helperPids]).toEqual([]);
        assertLegacy();
        const result = {
          label: app.evidence.label,
          scope,
          quota: list.body.quota,
          unknownResources: list.body.unknownResources,
          sameOriginalSession: sameSession,
          ...(denial ? { denial } : {}),
          backendObservation: {
            factoryInstrumented: false,
            samples,
            observedPythonHelperPids: [...helperPids],
            ledgerAllocations: ledger().allocations.length,
          },
          legacy: ledger().legacyObligations,
        };
        observations.push(result);
        return { cookie, scope };
      } finally {
        stream.close();
      }
    };
    try {
      assertLegacy();
      if (phase === "restart") {
        bareCounterexample = probeBareStockMainCounterexample(f);
        const n1 = await start("N1", count === 2);
        processes.push(n1);
        const first = await inspect(n1, count === 2);
        const closed1 = await n1.closeProof();
        lifecycle.push({ label: "N1", ...closed1 });
        expect(closed1).toEqual({ code: 0, signal: null, piGone: true, hubGone: true });
        assertLegacy();
        const n2 = await start("N2");
        processes.push(n2);
        expect(n2.evidence.pi!.pid).not.toBe(n1.evidence.pi!.pid);
        expect(n2.hub.pid).not.toBe(n1.hub.pid);
        expect(n2.state.sessionId).not.toBe(n1.state.sessionId);
        const second = await inspect(n2, false);
        expect(second.cookie).not.toBe(first.cookie);
        expect(second.scope.sessionId).not.toBe(first.scope.sessionId);
        const closed2 = await n2.closeProof();
        lifecycle.push({ label: "N2", ...closed2 });
        expect(closed2).toEqual({ code: 0, signal: null, piGone: true, hubGone: true });
        assertLegacy();
        writeFileSync(
          checkpointPath,
          JSON.stringify(
            {
              v: 1,
              phase: "stock-N2-complete",
              base: f.base,
              consumer: f.profile.newPackageRoot,
              lifecycle,
              observations,
              stockProcesses: processes.map((p) => p.evidence),
              bareCounterexample,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        return;
      }
      expect(saved.phase).toBe("stock-N2-complete");
      expect(f.run("resume", ["--operation", f.init.operationId])).toMatchObject({
        phase: "publication-complete",
        mode: "new",
        legacyObligations: count,
      });
      const rollback = f.run("rollback-inspect");
      expect(rollback).toMatchObject({ oldTerminalOnAllowed: false, legacyObligations: count });
      expect(f.run("publish-old-off", ["--expect-operation", f.init.operationId], false)).toMatchObject({
        phase: "publication-complete",
        mode: "old-off",
      });
      assertLegacy();
      expect(f.run("publish-new", ["--expect-operation", f.init.operationId], false)).toMatchObject({
        phase: "publication-complete",
        mode: "new",
        sequence: 3,
      });
      const n3 = await start("N-return");
      processes.push(n3);
      expect(n3.hub.pid).not.toBe(priorProcesses[1].hub.pid);
      expect(n3.evidence.pi!.pid).not.toBe(priorProcesses[1].pi.pid);
      await inspect(n3, false);
      const closed3 = await n3.closeProof();
      expect(closed3).toEqual({ code: 0, signal: null, piGone: true, hubGone: true });
      lifecycle.push({ label: "N-return", ...closed3 });
      assertLegacy();
      writeFileSync(
        join(f.base, "stock-restart-result.json"),
        JSON.stringify(
          {
            v: 1,
            format,
            legacyCount: count,
            operationId: f.init.operationId,
            sourceManifestSha256: f.init.sourceManifestSha256,
            consumer: f.profile.newPackageRoot,
            uid: process.getuid!(),
            lifecycle,
            observations,
            beforeLegacy: f.retained,
            afterLegacy: ledger().legacyObligations,
            rollback,
            stockProcesses: [...priorProcesses, ...processes.map((p) => p.evidence)],
            bareCounterexample,
            independentVitestPhases: true,
            realKernelReboot: false,
            oldOffBusinessService: "NOT RUN in this supplement; publication only (prior P7B covers service)",
            L1StockPtyCreateInputPrune:
              "NOT RUN: no authorized closed passwd UID/container; production ignores private HOME",
            backendFactoryCounter: processes.some((p) => p.evidence.passiveCoverage)
              ? "Passive V8 coverage: original createTerminalBackend execution count 0 for observed processes; no test factory/wrapper"
              : "No observer: real E_LIMIT effect:none, no observed helper and zero ledger allocations; no exact invocation counter",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } finally {
      for (const stop of cleanups.reverse()) await stop();
    }
  },
  180000,
);
