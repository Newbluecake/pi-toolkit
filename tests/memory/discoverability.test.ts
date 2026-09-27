// optimize-plan §10 M: deterministic discoverability proxy for the frozen
// question set. This checks the actual tiered index text, not a hand-built
// metadata projection: migrated topic lines must carry a query keyword while
// the pre-migration fixture only needs to expose the original file name.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { renderTiered } from "../../src/memory/tiered.js";
import { materializeFixture } from "./helpers/fixture-dir.js";

const TOPICS = [
  { id: "Q4", before: "pitfalls.md", after: "concurrency.md", keyword: /并发|subagent/i },
  { id: "Q5", before: "cache-ttl.md", after: "cache-ttl.md", keyword: /cache-ttl/i },
  { id: "Q6", before: "cache-ttl.md", after: "cache-ttl.md", keyword: /cache-ttl/i },
  { id: "Q7", before: "quota.md", after: "quota.md", keyword: /quota/i },
  { id: "Q8", before: "live-acceptance-tmux.md", after: "live-acceptance-tmux.md", keyword: /tmux/i },
  { id: "Q9", before: "pitfalls.md", after: "runtime-pitfalls.md", keyword: /运行时|环境/i },
  { id: "Q10", before: "multi-agent-experiments.md", after: "multi-agent-experiments.md", keyword: /multi|agent/i },
] as const;

function renderFixture(name: string): string {
  const fx = materializeFixture(name);
  try {
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    return renderTiered({
      cwd: fx.cwd,
      profile: "full",
      access: "memory+read",
      coreBytes: DEFAULT_SETTINGS.memory.coreBytes,
      blockBytes: DEFAULT_SETTINGS.memory.blockBytes,
      indexMax: DEFAULT_SETTINGS.memory.indexMax,
    }).text;
  } finally {
    fx.cleanup();
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("M — memory topic discoverability proxy", () => {
  test("each frozen topic is named before migration and described after migration", () => {
    const before = renderFixture("current-5");
    const after = renderFixture("current-5-migrated");

    for (const topic of TOPICS) {
      expect(before, topic.id).toContain(topic.before);
      const line = after.split("\n").find((entry) => entry.startsWith(`- ${topic.after} `));
      expect(line, `${topic.id} index line`).toBeDefined();
      expect(line, `${topic.id} has a real description`).not.toContain("(no description)");
      expect(line, `${topic.id} description`).toMatch(topic.keyword);
    }
  });
});
