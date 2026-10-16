// End-to-end regression (2026-10-16 user report): a core.md + 9 topic files
// dir with a ~16 kB pitfalls.md under DEFAULT settings — the exact shape the
// user saw. Pins the whole chain with the REAL renderer: renderTiered L1
// (name-only tail) ⇒ doctor D09 at severity info with the name-only count
// (no longer a warn contradicting D04's "split it" advice), D04 still warn,
// and the default `/mem tidy` snapshot carrying the oversized file as a
// target whose prompt demands the split by name.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { collectDoctorFindings, type RenderTieredPort } from "../../src/memory/doctor-command.js";
import { renderTiered } from "../../src/memory/tiered.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { snapshotMemoryDir } from "../../src/memory/tidy/snapshot.js";
import { buildTidyPrompt } from "../../src/memory/tidy/prompt.js";

it("user shape: D04 stays warn, D09-L1 reports info with the name-only count, tidy prompt demands the split", () => {
  const root = mkdtempSync(join(tmpdir(), "d04-e2e-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const memDir = memoryDirFor(cwd, { memoryRoot: root });
  mkdirSync(memDir, { recursive: true });
  try {
    vi.stubEnv("ARMORY_MEMORY_ROOT", root); // renderTiered resolves its own dir via the env hook
    // core big enough that only ~3 index lines fit the 2400B block (the user's L1)
    writeFileSync(
      join(memDir, "core.md"),
      `---\nsource: agent\ndescription: core rules\n---\n# Core\n${"rule line that repeats to eat the core budget\n".repeat(30)}`,
    );
    // ~15.7 kB (over topicWarnBytes 8192, under topicMaxBytes 16384)
    const lines = Array.from(
      { length: 340 },
      (_, i) => `pitfall rule ${String(i).padStart(3, "0")} — re-check the caller first`,
    );
    writeFileSync(
      join(memDir, "pitfalls.md"),
      `---\nsource: agent\ndescription: pitfalls\nread_when: risky edits\n---\n# Pitfalls\n\n${lines.join("\n")}\n`,
    );
    for (const n of [
      "cache-ttl",
      "live-acceptance-tmux",
      "multi-agent-experiments",
      "quota",
      "topic-switch",
      "webhub-restore-resume",
      "webhub-ui",
      "also",
      "extra-a",
    ]) {
      writeFileSync(
        join(memDir, `${n}.md`),
        `---\nsource: agent\ndescription: ${n} — ${"d".repeat(120)}\nread_when: ${n} work; ${"r".repeat(60)}\n---\n# ${n}\nnote\n`,
      );
    }

    const settings = DEFAULT_SETTINGS.memory;
    const renderPort: RenderTieredPort = (input) => renderTiered(input);
    const findings = collectDoctorFindings(cwd, { memoryRoot: root }, settings, renderPort, () =>
      new Date("2026-10-16T00:00:00Z").getTime(),
    );

    const d04 = findings.find((f) => f.id === "D04");
    expect(d04?.severity).toBe("warn");
    expect(d04?.file).toBe("pitfalls.md");
    expect(d04?.fix).toContain("/mem tidy");

    const d09 = findings.find((f) => f.id === "D09");
    expect(d09?.severity).toBe("info"); // was "warn" — the reported noise
    expect(d09?.message).toMatch(/L1 \(\d+ topic\(s\) listed by name only/);

    // default tidy selection includes the oversized file, and the prompt
    // names it under the split rule (plain /mem tidy path, command.ts's
    // oversized computation mirrored here).
    const snap = snapshotMemoryDir(cwd, { paths: { memoryRoot: root, ccProjectsRoot: root } });
    const oversized = snap.files
      .filter((f) => !f.isPrimaryCore && f.size > settings.topicWarnBytes)
      .map((f) => ({ name: f.name, bytes: f.size }));
    expect(oversized).toEqual([{ name: "pitfalls.md", bytes: expect.any(Number) }]);
    const prompt = buildTidyPrompt({
      cwd,
      files: snap.files.map((f) => ({
        name: f.name,
        body: f.body,
        isPrimaryCore: f.isPrimaryCore,
        handWritten: f.handWritten,
      })),
      migrationMode: false,
      coreBytes: settings.coreBytes,
      topicMaxBytes: settings.topicMaxBytes,
      topicWarnBytes: settings.topicWarnBytes,
      oversized,
    });
    expect(prompt).toContain("8192-byte warn threshold (doctor D04)");
    expect(prompt).toMatch(/Over the warn threshold now: pitfalls\.md \(\d+B\)/);
    expect(prompt).toContain("### pitfalls.md");
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
