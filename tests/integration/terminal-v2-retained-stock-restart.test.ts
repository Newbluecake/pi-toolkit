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
import { prepareStockRetained } from "./helpers/terminal-retained-stock-setup.js";
import { descendants, probeStockMain, stockProcess } from "./helpers/terminal-retained-stock-process.js";
const root = process.env.PI_TOOLKIT_STOCK_CONSUMERS;
const id = () => randomBytes(24).toString("base64url");
it.each([
  ["npm", 2],
  ["zip", 2],
] as const)(
  "stock %s L%i: actual consumer N1 close/N2 new PID/new login/session preserves retained debt",
  async (format, count) => {
    if (!root)
      throw new Error("PI_TOOLKIT_STOCK_CONSUMERS must name private unpacked npm/zip consumers; no checkout fallback");
    const f = await prepareStockRetained(join(root, format), count);
    console.log(`stock retained evidence: ${f.base}`);
    const ledger = () => JSON.parse(readFileSync(f.ledgerPath, "utf8"));
    const processes: Awaited<ReturnType<typeof stockProcess>>[] = [];
    const lifecycle: unknown[] = [],
      observations: any[] = [];
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
          cookieChangedOnly: true,
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
      probeStockMain(f); // Genuine red is a gate, not skipped/expected-failure green.
      const n1 = await stockProcess(f, "N1", count === 2);
      processes.push(n1);
      const first = await inspect(n1, count === 2);
      const closed1 = await n1.closeProof();
      lifecycle.push({ label: "N1", ...closed1 });
      expect(closed1).toEqual({ code: 0, signal: null, piGone: true, hubGone: true });
      assertLegacy();
      const n2 = await stockProcess(f, "N2");
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
      const n3 = await stockProcess(f, "N-return");
      processes.push(n3);
      expect(n3.hub.pid).not.toBe(n2.hub.pid);
      await inspect(n3, false);
      lifecycle.push({ label: "N-return", ...(await n3.closeProof()) });
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
            stockProcesses: processes.map((p) => p.evidence),
            realKernelReboot: false,
            oldOffBusinessService: "NOT RUN in this supplement; publication only (prior P7B covers service)",
            L1StockPtyCreateInputPrune:
              "NOT RUN: no authorized closed passwd UID/container; production ignores private HOME",
            backendFactoryCounter:
              "NOT instrumented; real E_LIMIT effect:none, no observed helper and zero ledger allocations",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } finally {
      for (const app of processes.reverse()) await app.stop();
    }
  },
  180000,
);
