import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createScopedMemoryDoctor } from "../../../src/memory/scopes/doctor.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";
import { createHubMemoryProvider } from "../../../src/memory/scopes/hub-store.js";
import { createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import type { ScopedSurfaceDeps } from "../../../src/memory/scopes/tool.js";
it("projects actual namespace inert and dropped diagnostics only; no repairs or content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p4b-doctor-"));
  try {
    const owner = { incarnation: {}, sid: "session1", sessionEpoch: 1, branchGen: 0 };
    let reads = 0,
      capability: ReturnType<ScopedSurfaceDeps["capability"]> = "ok";
    const session = createSessionMemoryStore({
      currentOwner: () => owner,
      isLocked: () => false,
      getBranch: () => {
        reads++;
        return [
          {
            type: "custom",
            customType: "subagent:memory-session",
            id: "bad",
            data: { v: 1, sid: "session1", op: "snap", items: "SECRET INVALID BODY" },
          },
        ];
      },
      getSessionId: () => owner.sid,
      getSessionFile: () => undefined,
      appendCustomEntry: () => {
        throw Error("doctor must not append");
      },
      now: () => "2026-11-07T00:00:00.000Z",
      poisonRegistry: createSessionPoisonRegistry(),
    });
    const hub = createHubMemoryProvider({
      capability: () => "ok",
      registry: createMemoryOpCapRegistry(),
      owner: () => owner,
      slot: () => ({ effectiveStateDir: dir, uid: process.getuid?.() ?? 0 }),
      trustedCommand: () => true,
      commandSource: () => ({ project: "abc123", label: "current", sid8: "session1" }),
    });
    expect(
      await hub.management.command({
        storageScope: "hub",
        op: "create",
        authority: "user",
        topic: "general",
        text: "private body",
      }),
    ).toMatchObject({ ok: true });
    const namespace = join(dir, "hub-memory", "namespace.json");
    writeFileSync(namespace, "corrupt");
    const deps: ScopedSurfaceDeps = {
      enabled: { session: true, hub: true },
      child: false,
      capability: () => capability,
      currentOwner: () => owner,
      session,
      hub,
      signal: () => new AbortController().signal,
    };
    const doctor = createScopedMemoryDoctor(deps);
    const result = doctor.inspect();
    expect(result.map((i) => i.code)).toEqual(["H01", "H05"]);
    expect(result[1]).toMatchObject({ entryId: "bad" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("private body");
    expect(readFileSync(namespace, "utf8")).toBe("corrupt");
    const before = reads;
    for (const c of ["disabled", "secure", "locked", "unknown"] as const) {
      capability = c;
      expect(doctor.inspect()).toEqual([]);
    }
    expect(reads).toBe(before);
    capability = "ok";
    expect(createScopedMemoryDoctor({ ...deps, enabled: { session: false, hub: false } }).inspect()).toEqual([]);
    expect(reads).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
