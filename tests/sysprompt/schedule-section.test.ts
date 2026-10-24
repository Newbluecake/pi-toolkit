import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleSection, renderSchedulesSection, SCHEDULES_TITLE } from "../../src/sysprompt/schedule-section.js";
import { SKIP } from "../../src/prompt-sections/stable-section.js";
import { createTask } from "../../src/schedule/agent/ops.js";
import { sessionDirName } from "../../src/schedule/core/paths.js";
import { foldSections } from "../../src/prompt-sections/fold.js";
import { a3Env, basicRaw, type A3Env } from "../schedule/agent/a3-helpers.js";
import { SID } from "../schedule/core/fixtures.js";

let env: A3Env;
afterEach(() => env?.cleanup());
const input = {} as never;

describe("pi_schedules section", () => {
  it("is session-scoped, and empty (byte-neutral in the fold) while there are no tasks", () => {
    env = a3Env();
    const reg = scheduleSection({ agent: () => env.agent });
    expect(reg.sessionScoped).toBe(true);
    expect(reg.provider(input)).toBe("");
    expect(foldSections("BASE", [reg.provider(input) as string])).toBe("BASE");
  });

  it("lists DEFINITIONS only: no next-run time, no run state; pending marker present until approved", async () => {
    env = a3Env();
    const reg = scheduleSection({ agent: () => env.agent });
    await createTask(env.ports, basicRaw(), { by: "agent", via: "tool" });
    await createTask(env.ports, basicRaw({ name: "mine", form: "message" }), { by: "user", via: "tui" });
    const text = reg.provider(input) as string;
    expect(text.startsWith(SCHEDULES_TITLE)).toBe(true);
    expect(text).toMatch(
      /- s_[a-z2-7]{8} "daily" · cron "0 8 \* \* \*" Asia\/Shanghai · background · feishu · pending/,
    );
    expect(text).toMatch(/- s_[a-z2-7]{8} "mine" · cron "0 8 \* \* \*" Asia\/Shanghai · message$/m);
    expect(text).not.toMatch(/next|running|fired|missed|paused/i);
    // the text does not depend on time passing
    env.fake.advance(5 * 3_600_000);
    expect(reg.provider(input)).toBe(text);
  });

  it("caches by ledger stat: an unchanged ledger is not re-read, a changed one is", async () => {
    env = a3Env();
    const reg = scheduleSection({ agent: () => env.agent });
    await createTask(env.ports, basicRaw(), { by: "agent", via: "tool" });
    const first = reg.provider(input);
    let reads = 0;
    const real = env.agent.readState.bind(env.agent);
    env.agent.readState = () => (reads++, real());
    expect(reg.provider(input)).toBe(first);
    expect(reads).toBe(0);
    await createTask(env.ports, basicRaw({ name: "second" }), { by: "agent", via: "tool" });
    expect(reg.provider(input)).not.toBe(first);
    expect(reads).toBe(1);
  });

  it("an unreadable ledger ⇒ SKIP (keep the frozen snapshot); no agent ⇒ SKIP; non-owning modes ⇒ empty", async () => {
    env = a3Env();
    const reg = scheduleSection({ agent: () => env.agent });
    await createTask(env.ports, basicRaw(), { by: "agent", via: "tool" });
    writeFileSync(join(env.dir, sessionDirName(SID), "state.json"), "{not json");
    expect(reg.provider(input)).toBe(SKIP);
    expect(scheduleSection({ agent: () => undefined }).provider(input)).toBe(SKIP);
    const eph = a3Env({}, "ephemeral");
    expect(scheduleSection({ agent: () => eph.agent }).provider(input)).toBe("");
    eph.cleanup();
  });

  it("renders from a state object deterministically", () => {
    env = a3Env();
    expect(renderSchedulesSection({ tasks: [] } as never)).toBe("");
  });
});
