// Ported behavior tests for src/session-nav/skill-titles.ts — fakes are
// inline (no cross-package helpers). Covers stripSkillEnvelope (full
// envelope / References-without-closing-tag / non-skill) and
// cleanSkillTitles (title rewrite, renamed sessions, allMessagesText
// envelope scrubbing).

import { describe, expect, test } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { cleanSkillTitles, stripSkillEnvelope } from "../../src/session-nav/skill-titles.js";

function fakeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    path: "/tmp/session-nav-fake.jsonl",
    id: "fake",
    cwd: "/tmp",
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "hello",
    allMessagesText: "hello",
    ...overrides,
  };
}

describe("stripSkillEnvelope", () => {
  test("parses a full <skill …>…</skill> envelope and keeps the trailing input", () => {
    const text = '<skill name="dev-flow" version="3">整篇 SKILL.md 正文\n第二行</skill>帮我做这个任务';
    expect(stripSkillEnvelope(text)).toEqual({ name: "dev-flow", rest: "帮我做这个任务" });
  });

  test("handles the References form without a closing tag", () => {
    const text = '<skill name="dev-flow">\nReferences are relative to /home/u/.agents/skills/dev-flow.\n';
    expect(stripSkillEnvelope(text)).toEqual({ name: "dev-flow", rest: "" });
  });

  test("returns null for non-skill text", () => {
    expect(stripSkillEnvelope("just a normal message")).toBeNull();
    expect(stripSkillEnvelope('<other name="x">body</other>')).toBeNull();
  });
});

describe("cleanSkillTitles", () => {
  test("rewrites a skill-envelope title to `[name] rest`", async () => {
    const session = fakeSession({
      firstMessage: '<skill name="dev-flow">正文</skill>真实输入',
      allMessagesText: '<skill name="dev-flow">正文</skill>真实输入',
    });
    const [cleaned] = await cleanSkillTitles([session]);
    expect(cleaned?.firstMessage).toBe("[dev-flow] 真实输入");
  });

  test("renamed sessions keep their title but still get scrubbed search text", async () => {
    const session = fakeSession({
      name: "my session",
      firstMessage: '<skill name="dev-flow">正文</skill>真实输入',
      allMessagesText: '<skill name="dev-flow">正文</skill>真实输入',
    });
    const [cleaned] = await cleanSkillTitles([session]);
    expect(cleaned?.firstMessage).toBe('<skill name="dev-flow">正文</skill>真实输入');
    expect(cleaned?.allMessagesText).toBe("[dev-flow]真实输入");
  });

  test("replaces the full envelope with `[name]` in allMessagesText", async () => {
    const session = fakeSession({
      firstMessage: "普通标题",
      allMessagesText: '前置 <skill name="web">技能正文</skill> 后置',
    });
    const [cleaned] = await cleanSkillTitles([session]);
    expect(cleaned?.allMessagesText).toBe("前置 [web] 后置");
    expect(cleaned?.firstMessage).toBe("普通标题");
  });

  test("leaves sessions without envelopes untouched (same object)", async () => {
    const session = fakeSession({ firstMessage: "plain", allMessagesText: "plain text" });
    const [cleaned] = await cleanSkillTitles([session]);
    expect(cleaned).toBe(session);
  });
});
