/** Actual activate(), not schedule mode/wire mocks. Only transport/launcher IO is injected. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import * as webHub from "../../src/web-hub/agent/index.js";
import { loadSettingsFromFile, readSettingsNoMigrate } from "../../src/config/settings.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { emptyStateFile } from "../../src/schedule/core/spec.js";
import { freezeDomain, makeFakeVault } from "../secure/helpers.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals as resetHub } from "../web-hub/agent/helpers.js";
import {
  BASELINE,
  emit,
  fakeCtx,
  fakePi,
  resetGlobals,
  sandbox,
  SID,
  systemPromptFor,
} from "./helpers/schedule-activate.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetHub();
  resetGlobals();
  resetSecureDomainForTests();
  vi.useRealTimers();
});

describe("schedule P1 secure registration hard gate", () => {
  it.each(["secure", "locked"] as const)(
    "%s × absent/true × empty/v1: zero tools/commands/prompt/status/caps/config/migration",
    async (kind) => {
      for (const explicit of [false, true])
        for (const preexisting of [false, true]) {
          const sb = sandbox("schedule-secure-activate-");
          const v = makeFakeVault();
          resetGlobals();
          resetHub();
          const raw = {
            ...BASELINE,
            fast: { enabled: false },
            webHub: { enabled: true, autoStart: true, cmdHistory: false },
            ...(explicit ? { schedule: { enabled: true } } : {}),
          };
          sb.writeSettings(raw);
          const verdict = freezeDomain(v, kind === "locked" ? { mountinfo: v.unmounted } : {});
          expect(verdict.domain.kind).toBe(kind);
          for (const effective of [loadSettingsFromFile(sb.settingsPath), readSettingsNoMigrate(sb.settingsPath)])
            expect(effective.schedule.enabled).toBe(false);
          const root = join(sb.home, ".pi", "agent", "schedules"),
            session = join(root, SID),
            file = join(session, "state.json");
          const original = Buffer.from(JSON.stringify({ ...emptyStateFile(SID), rev: 17 }) + "\n");
          if (preexisting) {
            mkdirSync(session, { recursive: true, mode: 0o700 });
            writeFileSync(file, original, { mode: 0o600 });
          }
          const net = fakeNet();
          const spawnEnvs: NodeJS.ProcessEnv[] = [];
          const originalWire = webHub.wireWebHub;
          const nodeLoader = join(sb.home, "jiti.mjs");
          writeFileSync(nodeLoader, "");
          const wire = vi.spyOn(webHub, "wireWebHub").mockImplementation((pi, deps) =>
            originalWire(pi, {
              ...deps,
              settings: { ...deps.settings, autoStart: true, nodeLoader },
              paths: { ...pathsIn(sb.home), stoppedFile: join(sb.home, "stopped") },
              env: { HOME: sb.home },
              argv1: "/nonexistent/pi",
              netConnect: net.netConnect,
              buildInfo: async () => ({ pluginVersion: "0.0.0-secure-test", buildId: "secure-test" }),
              spawnImpl: ((_e: string, _a: string[], opts: { env: NodeJS.ProcessEnv }) => {
                spawnEnvs.push(opts.env);
                return { on: () => undefined, unref: () => undefined } as never;
              }) as never,
            }),
          );
          const h = fakePi();
          const c = fakeCtx(sb.home);
          try {
            vi.useFakeTimers();
            activate(h.pi);
            expect(h.tools.has("schedule")).toBe(false);
            expect(h.commands.has("schedule")).toBe(false);
            expect(wire).toHaveBeenCalledTimes(1);
            expect(wire.mock.calls[0]![1].schedule).toBeUndefined();
            await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
            const prompt = await systemPromptFor(h, c.ctx);
            expect(prompt).not.toContain("pi_schedules");
            expect(prompt).not.toMatch(/定时任务|schedule tool/);
            await vi.advanceTimersByTimeAsync(50);
            expect(net.sockets).toHaveLength(1);
            net.sockets[0]!.fail("ENOENT");
            for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
            expect(spawnEnvs).toHaveLength(1);
            const config = JSON.parse(String(spawnEnvs[0]!.PI_WEBHUB_CONFIG)) as Record<string, unknown>;
            expect(Object.hasOwn(config, "schedule")).toBe(false);
            const socket = net.sockets[1]!;
            socket.emit("connect");
            socket.hub(ackFrame("secure-test", 4242, ["sched.v1", "sched.interval.v1"]));
            await vi.advanceTimersByTimeAsync(50);
            const hello = socket.frames().find((f) => f.t === "hello");
            expect(hello).toBeDefined();
            expect((hello!.caps as string[]).filter((cap) => cap.startsWith("sched."))).toEqual([]);
            await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, c.ctx);
            expect(c.statuses.filter(([key]) => key.includes("sched"))).toEqual([]);
            if (preexisting) {
              expect(readFileSync(file)).toEqual(original);
              expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ v: 1, rev: 17 });
              expect(readdirSync(session)).toEqual(["state.json"]);
              expect(readdirSync(root)).toEqual([SID]);
            } else expect(existsSync(root)).toBe(false);
            expect(existsSync(join(v.state, "schedules"))).toBe(false);
            await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx);
          } finally {
            wire.mockRestore();
            resetHub();
            resetGlobals();
            resetSecureDomainForTests();
            vi.useRealTimers();
            sb.cleanup();
            v.cleanup();
          }
        }
    },
  );
});
