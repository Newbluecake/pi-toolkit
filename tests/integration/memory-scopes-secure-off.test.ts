import { mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { tmpdir } from "node:os";
import { initSecureDomain, resetSecureDomainForTests } from "../../src/secure/domain.js";
import { resetGlobals, BASELINE } from "./helpers/schedule-activate.js";
import { fakeModel, fakeModelRuntime, textTurn } from "../conformance/topic-switch-runtime-harness.js";
afterEach(() => {
  resetGlobals();
  resetSecureDomainForTests();
  vi.unstubAllEnvs();
});
describe("scopes flags cannot activate in actual SDK secure/locked root", () => {
  it.each([false, true])(
    "frozen domain locked=%s, no scoped registration/poison/Hub path side effects",
    async (locked) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "memory39-secure-off-")));
      const mnt = join(home, "mnt"),
        work = join(mnt, "work"),
        cipher = join(home, "vault", "cipher");
      mkdirSync(work, { recursive: true });
      mkdirSync(cipher, { recursive: true });
      mkdirSync(join(mnt, "state"), { recursive: true });
      const settingsPath = join(home, "secure-settings.json");
      writeFileSync(settingsPath, JSON.stringify({ secure: { vaults: { owned: { dir: join(home, "vault"), mnt } } } }));
      const base = "22 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw\n";
      const vault = {
        home,
        work,
        cleanup: () => rmSync(home, { recursive: true, force: true }),
        mounted: base + `40 25 0:40 / ${mnt} rw,nosuid,nodev - fuse.gocryptfs ${cipher} rw\n`,
        unmounted: base,
      };
      resetGlobals();
      vi.stubEnv("HOME", vault.home);
      vi.stubEnv("PI_CODING_AGENT_DIR", join(vault.home, "isolated-agent"));
      vi.stubEnv("PI_OFFLINE", "1");
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "pi-toolkit.json"),
        JSON.stringify({
          ...BASELINE,
          fast: { enabled: false },
          title: { enabled: false },
          quota: { enabled: false },
          load: { enabled: false },
          memory: { enabled: true, scopes: { session: true, hub: true }, jev: { enabled: false } },
        }),
      );
      resetSecureDomainForTests();
      const domain = initSecureDomain({
        cwd: work,
        home,
        settingsPath,
        env: {},
        readMountinfo: () => (locked ? vault.unmounted : vault.mounted),
      });
      expect(domain.kind).toBe(locked ? "locked" : "secure");
      const poison = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi-subagent:memory-session-poison"));
      const model = fakeModel(),
        runtime = fakeModelRuntime(model, [textTurn("must not call")]);
      const settingsManager = SettingsManager.create(vault.work, agentDir);
      const loader = new DefaultResourceLoader({
        cwd: vault.work,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
        extensionFactories: [activate],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: vault.work,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(vault.work),
        model: model as never,
        modelRuntime: runtime as never,
      });
      try {
        expect(session.getAllTools().some((tool) => tool.name === "scoped_memory")).toBe(false);
        expect(Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi-subagent:memory-session-poison"))).toEqual(
          poison,
        );
        expect(runtime.callCount()).toBe(0);
        // SDK construction/activate only: frozen fake mount is not represented as a real mounted filesystem.
        expect(session.extensionRunner.getToolDefinition("memory")).toBeDefined();
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        vault.cleanup();
      }
    },
  );
});
