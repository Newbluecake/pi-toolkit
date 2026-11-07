/**
 * R1 · agreement (plan R1 step 10; arch §4.8): shape collection (bash → allShapes, bash_job →
 * action, others → tool name), digest verification, the four verdicts.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { collectToolShapes, judgeAgreement, type BranchEntryLike } from "../../../src/reflex/core/agreement.js";
import { normalizeInput } from "../../../src/reflex/core/normalize.js";
import { requestDigest } from "../../../src/reflex/core/digest.js";

const JOBS = BUILTIN_SCRIPTS[0]!;
const GIT = BUILTIN_SCRIPTS[3]!;
const QUOTA = BUILTIN_SCRIPTS[2]!;

function digestOf(text: string): string {
  return requestDigest(normalizeInput(text).norm);
}

const QUESTION = "后台还有几个 job";

function branch(...entries: BranchEntryLike[]): BranchEntryLike[] {
  return entries;
}

describe("collectToolShapes", () => {
  it("finds the LAST user message backwards and collects shapes after it", () => {
    const digest = digestOf(QUESTION);
    const entries = branch(
      { role: "user", text: "更早的问题" },
      { role: "assistant", toolCalls: [{ name: "bash", arguments: { command: "git log" } }] },
      { role: "user", text: QUESTION },
      { role: "assistant", text: "看一下" },
      { role: "assistant", toolCalls: [{ name: "bash_job", arguments: { action: "list" } }] },
    );
    expect(collectToolShapes(entries, digest)).toEqual({ status: "ok", shapes: ["bash_job:list"] });
  });

  it("bash ⇒ allShapes(command) (program [subcommand], deduped, never arguments)", () => {
    const digest = digestOf("工作区干净吗");
    const entries = branch(
      { role: "user", text: "工作区干净吗" },
      { role: "assistant", toolCalls: [{ name: "bash", arguments: { command: "git status && git diff --stat" } }] },
    );
    expect(collectToolShapes(entries, digest)).toEqual({ status: "ok", shapes: ["git status", "git diff"] });
  });

  it("bash without a command string falls back to the tool name; other tools use their name", () => {
    const digest = digestOf("工作区干净吗");
    const entries = branch(
      { role: "user", text: "工作区干净吗" },
      {
        role: "assistant",
        toolCalls: [
          { name: "bash", arguments: {} },
          { name: "get_run_result", arguments: { runId: "r1" } },
        ],
      },
    );
    expect(collectToolShapes(entries, digest)).toEqual({ status: "ok", shapes: ["bash", "get_run_result"] });
  });

  it("digest mismatch ⇒ digest-mismatch (tools belong to another run)", () => {
    const entries = branch(
      { role: "user", text: "别的问题" },
      { role: "assistant", toolCalls: [{ name: "bash_job", arguments: { action: "list" } }] },
    );
    expect(collectToolShapes(entries, digestOf(QUESTION))).toEqual({ status: "digest-mismatch" });
  });

  it("no user message at all ⇒ no-user", () => {
    expect(collectToolShapes([{ role: "assistant", toolCalls: [{ name: "bash" }] }], "x")).toEqual({
      status: "no-user",
    });
    expect(collectToolShapes([], "x")).toEqual({ status: "no-user" });
  });

  it("the raw question is normalized before digesting (NFKC/case/punctuation)", () => {
    const entries = branch(
      { role: "user", text: "  Ｇｉｔ Ｓｔａｔｕｓ！ " },
      { role: "assistant", toolCalls: [{ name: "bash", arguments: { command: "git status" } }] },
    );
    expect(collectToolShapes(entries, digestOf("git status"))).toEqual({ status: "ok", shapes: ["git status"] });
  });
});

describe("judgeAgreement (arch §4.8)", () => {
  it("agree: a declared tool shape and no edit/write", () => {
    expect(judgeAgreement(JOBS, ["bash_job:list"])).toBe("agree");
    expect(judgeAgreement(JOBS, ["read", "bash_job:status"])).toBe("agree");
    expect(judgeAgreement(GIT, ["git status"])).toBe("agree");
    expect(judgeAgreement(GIT, ["git diff"])).toBe("agree");
  });

  it("no-tool: the model answered (or could not) with zero tool calls", () => {
    expect(judgeAgreement(JOBS, [])).toBe("no-tool");
    expect(judgeAgreement(QUOTA, [])).toBe("no-tool"); // quota has no declared tools at all
  });

  it("diverge: shapes that are neither declared nor empty", () => {
    expect(judgeAgreement(JOBS, ["bash", "ls"])).toBe("diverge");
    expect(judgeAgreement(QUOTA, ["bash"])).toBe("diverge"); // no declared shapes ⇒ any tool diverges
  });

  it("edit/write can never agree, even alongside an agreeing shape", () => {
    expect(judgeAgreement(JOBS, ["bash_job:list", "edit"])).toBe("diverge");
    expect(judgeAgreement(JOBS, ["bash_job:list", "write"])).toBe("diverge");
    expect(judgeAgreement(GIT, ["git status", "write"])).toBe("diverge");
  });

  it("end-to-end: branch → shapes → verdict for a shadow run of git.status", () => {
    const question = "工作区干净吗";
    const entries = branch(
      { role: "user", text: question },
      { role: "assistant", toolCalls: [{ name: "bash", arguments: { command: "git status --porcelain" } }] },
    );
    const collected = collectToolShapes(entries, digestOf(question));
    expect(collected.status).toBe("ok");
    expect(judgeAgreement(GIT, collected.status === "ok" ? collected.shapes : [])).toBe("agree");
  });
});
