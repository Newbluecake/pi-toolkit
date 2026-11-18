/** Real subprocess SIGKILL/atomic-ledger windows. No PTY in THIS suite: tests disk
 * reserve/prune crash visibility, not physical proof or power-cut durability. */
import { afterEach, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTerminalAllocationLedgerV2 } from "../../src/web-hub/hub/terminal/v2/ledger.js";
import { HubTerminalServiceV2 } from "../../src/web-hub/hub/terminal/v2/service.js";
import {
  createInitialTerminalLedgerV2,
  type TerminalMarkerV2,
  type AllocationV2,
} from "../../src/web-hub/protocol/terminal-v2.js";
const roots: string[] = [],
  children: ChildProcess[] = [];
const scope = { agentKey: "a", sessionId: "s", epoch: "e" };
const auth = {
  listener: "lan" as const,
  principal: "u1",
  sidTag: "a".repeat(43),
  parentExpiresAt: Date.now() + 120000,
};
const row: AllocationV2 = {
  allocationId: "a".repeat(24),
  termId: "t".repeat(24),
  hubInstance: "o".repeat(24),
  kernelBootId: "11111111-1111-4111-8111-111111111111",
  scope,
  quotaSessionKey: "s",
  principalKey: "lan:u1",
  creatorSidTag: auth.sidTag,
};
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("v2 allocation ledger real SIGKILL windows", () => {
  it.each([
    ["reserve", "before-rename", 0],
    ["reserve", "after-rename", 1],
    ["prune", "before-rename", 1],
    ["prune", "after-rename", 0],
  ] as const)(
    "%s at %s preserves visible allocation count %i",
    async (op, phase, count) => {
      const root = await mkdtemp(join(tmpdir(), "v2-crash-"));
      roots.push(root);
      await chmod(root, 0o700);
      await mkdir(join(root, "terminal-v2"), { mode: 0o700 });
      const marker: TerminalMarkerV2 = {
        v: 2,
        storeId: "s".repeat(24),
        initialization: "fresh",
        checkpointId: "c".repeat(24),
      };
      const initial = { ...createInitialTerminalLedgerV2(marker), allocations: op === "prune" ? [row] : [] };
      const path = join(root, "terminal-v2/ledger.json");
      await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
      await writeFile(join(root, "terminal-v2/marker.json"), JSON.stringify(marker), { mode: 0o600 });
      await writeFile(join(root, ".terminal-initialized-v2"), JSON.stringify(marker), { mode: 0o600 });
      const script = join(root, "writer.mjs");
      const module = pathToFileURL(
        fileURLToPath(new URL("../../src/web-hub/hub/terminal/v2/ledger.ts", import.meta.url)),
      ).href;
      await writeFile(
        script,
        `import {createTerminalAllocationLedgerV2} from ${JSON.stringify(module)};
const ledger=createTerminalAllocationLedgerV2({stateDir:${JSON.stringify(root)},current:()=>true,stage:async stage=>{
 if(stage===${JSON.stringify(phase)}){process.stdout.write('BARRIER\\n');await new Promise(()=>{setInterval(()=>{},1000);});}
}});
const signal=new AbortController().signal;
const loaded=await ledger.load(signal);if(loaded.kind!=='loaded')process.exit(2);
await ledger.commit(0,{...loaded.ledger,revision:1,allocations:${JSON.stringify(op === "reserve" ? [row] : [])}},signal);
process.exit(3);
`,
        { mode: 0o600 },
      );
      const child = spawn(
        process.execPath,
        ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)), script],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
      );
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error("crash barrier deadline")), 5000);
        child.stdout!.on("data", (b) => {
          text += b.toString();
          if (text.includes("BARRIER\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("writer exited before barrier"));
        });
      });
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
      expect(JSON.parse(await readFile(path, "utf8")).allocations).toHaveLength(count);
      const ledger = createTerminalAllocationLedgerV2({ stateDir: root, current: () => true });
      let forks = 0;
      const limits = { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
      const service = new HubTerminalServiceV2({
        ledger,
        hubInstance: "n".repeat(24),
        revision: () => 0,
        check: () => limits,
        context: {
          resolve: async () => {
            throw new Error("no context on list");
          },
          current: () => false,
        },
        backend: () => {
          forks++;
          throw new Error("no spawn");
        },
      });
      const signal = new AbortController().signal;
      expect(await service.initialize(signal)).toBe(true);
      const list = await service.list(auth, scope, signal);
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.rows).toEqual([]);
        expect(list.unknownResources).toHaveLength(count);
        expect(list.quota.session).toEqual({ used: count, unknown: count, limit: 2 });
      }
      expect(forks).toBe(0);
      expect((await service.dispose()).unresolved).toBe(count);
    },
    15000,
  );
});
