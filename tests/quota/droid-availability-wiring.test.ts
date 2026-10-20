import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { buildDroidStack, makeBinary, type DroidStack } from "../integration/helpers/external-droid.js";

let live: DroidStack | undefined;
let root: string | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("real stack late-binds quota 401/success to the same external prompt/admission availability, without disabling polling", async () => {
  root = mkdtempSync(join(tmpdir(), "quota-availability-"));
  const binary = makeBinary(root, []);
  vi.stubEnv("FACTORY_API_KEY", "test-only-factory-secret");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let status = 200;
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify(
          status === 200
            ? { limits: { standard: { monthly: { usedPercent: 0 } }, core: { monthly: { usedPercent: 0 } } } }
            : { error: "credentials rejected" },
        ),
        { status },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const h = buildDroidStack({ binary, quota: { providers: "droid" } });
  live = h;
  await h.stack.quota!.whenIdle();
  await vi.waitFor(() => expect(h.stack.external?.advertised().length).toBeGreaterThan(0));
  expect(h.stack.external!.unavailableReason("droid")).toBeUndefined();
  status = 401;
  now += DEFAULT_SETTINGS.quota.refreshMs + 1;
  h.stack.quota!.refreshIfStale();
  await h.stack.quota!.whenIdle();
  const reason = h.stack.external!.unavailableReason("droid");
  expect(reason).toContain("Factory HTTP 401");
  expect(reason).not.toContain("test-only-factory-secret");
  expect(h.stack.external!.advertised()).toEqual([]);
  const before = h.stack.spawn.snapshots();
  expect(
    await h.stack.spawn.spawn({
      type: "worker",
      prompt: "not dispatched",
      isolation: "worktree",
      modelOverride: { provider: "droid", id: "gpt-6-luna" },
    }),
  ).toEqual({ error: { kind: "config", retryable: false, message: reason } });
  expect(h.stack.spawn.snapshots()).toEqual(before);
  // A later successful billing response recovers even though provider admission is blocked.
  status = 200;
  now += DEFAULT_SETTINGS.quota.refreshMs + 1;
  h.stack.quota!.refreshIfStale();
  await h.stack.quota!.whenIdle();
  expect(fetch).toHaveBeenCalledTimes(3); // one shared request per refresh, NOT one per pool
  expect(h.stack.external!.unavailableReason("droid")).toBeUndefined();
  expect(h.stack.external!.advertised().length).toBeGreaterThan(0);

  // Opposite direction: valid billing credentials do not prove that the CLI's OAuth login survived.
  h.stack.external!.observeAvailability!("droid", { source: "run", authError: "No access token" });
  const cliReason = h.stack.external!.unavailableReason("droid");
  now += DEFAULT_SETTINGS.quota.refreshMs + 1;
  h.stack.quota!.refreshIfStale();
  await h.stack.quota!.whenIdle();
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(h.stack.external!.unavailableReason("droid")).toBe(cliReason);
  expect(h.stack.external!.advertised()).toEqual([]);
});
