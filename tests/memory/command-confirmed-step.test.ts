import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandConfirmKernel, COMMAND_REJECT_LABEL } from "../../src/memory/command-confirm.js";
import { runConfirmedStep } from "../../src/memory/command-confirmed-step.js";
import type { AskUserRemotePort, RemoteOutcome } from "../../src/ask-user/remote.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mem-step-"));
  const file = join(dir, "entry.md");
  writeFileSync(file, "before", { mode: 0o600 });
  let answer: ((outcome: RemoteOutcome) => boolean) | undefined;
  let affirm = "";
  const remote: AskUserRemotePort = {
    open(req) {
      affirm = req.questions[0]!.options[1]!.label;
      return {
        setOnRemote(fn) {
          answer = fn;
        },
        close() {},
      };
    },
  };
  const kernel = createCommandConfirmKernel({ channel: { kind: "web", remote }, isOwnerCurrent: () => true });
  const call = kernel.start("test write")!;
  const plan = { rawArgs: "test write", step: 0, manifest: "before -> after", presentation: "entry.md" };
  const send = (label: string) =>
    answer!({ kind: "answer", answers: { MEMCMD: label }, origin: "test", originKind: "lan" });
  const fingerprint = () => {
    const st = statSync(file);
    return { sha: createHash("sha256").update(readFileSync(file)).digest("hex"), mode: st.mode, mtime: st.mtimeMs };
  };
  return { dir, file, kernel, call, plan, send, affirm: () => affirm, fingerprint };
}

describe("confirmed step building block", () => {
  it("applies exactly once only after approval", async () => {
    const f = setup();
    try {
      let attempts = 0;
      const pending = runConfirmedStep({
        ...f,
        runLocked: async (_lease, commit) => {
          const apply = () => {
            attempts++;
            writeFileSync(f.file, "after");
            return "done";
          };
          const result = commit(() => readFileSync(f.file, "utf8") === "before", apply);
          expect(commit(() => true, apply)).toMatchObject({ ok: false });
          return result;
        },
      });
      expect(readFileSync(f.file, "utf8")).toBe("before");
      expect(f.send(f.affirm())).toBe(true);
      expect(f.send(f.affirm())).toBe(false);
      expect(await pending).toEqual({ ok: true, value: "done" });
      expect(attempts).toBe(1);
      expect(readFileSync(f.file, "utf8")).toBe("after");
    } finally {
      f.kernel.dispose();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("decline leaves hash, mode and mtime unchanged", async () => {
    const f = setup();
    try {
      const before = f.fingerprint();
      let entered = false;
      const pending = runConfirmedStep({
        ...f,
        runLocked: async () => {
          entered = true;
          throw Error("unexpected");
        },
      });
      f.send(COMMAND_REJECT_LABEL);
      expect(await pending).toMatchObject({ ok: false, failure: { code: "E_MEM_CONFIRM_DECLINED" } });
      expect(entered).toBe(false);
      expect(f.fingerprint()).toEqual(before);
    } finally {
      f.kernel.dispose();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("refuses changed plan and does not overwrite concurrent change", async () => {
    const f = setup();
    try {
      const pending = runConfirmedStep({
        ...f,
        runLocked: async (_lease, commit) =>
          commit(
            () => readFileSync(f.file, "utf8") === "before",
            () => writeFileSync(f.file, "after"),
          ),
      });
      writeFileSync(f.file, "changed elsewhere");
      const changed = f.fingerprint();
      f.send(f.affirm());
      expect(await pending).toMatchObject({ ok: false, failure: { code: "E_MEM_PLAN_CHANGED" } });
      expect(f.fingerprint()).toEqual(changed);
    } finally {
      f.kernel.dispose();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("rejects an async apply before it starts, even if types are bypassed", async () => {
    const f = setup();
    try {
      let started = false;
      const pending = runConfirmedStep<void>({
        ...f,
        runLocked: async (_lease, commit) => {
          if (false) {
            commit(
              () => true,
              // @ts-expect-error Async callbacks must not typecheck, even for void results.
              async () => {},
            );
          }
          return commit(() => true, (async () => {
            started = true;
            writeFileSync(f.file, "after");
          }) as unknown as () => void);
        },
      });
      const before = f.fingerprint();
      f.send(f.affirm());
      expect(await pending).toMatchObject({ ok: false, failure: { code: "E_MEM_CONFIRM_STALE" } });
      expect(started).toBe(false);
      expect(f.fingerprint()).toEqual(before);
    } finally {
      f.kernel.dispose();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("reports unknown rather than success when a synchronous callback returns a promise", async () => {
    const f = setup();
    try {
      const pending = runConfirmedStep<string>({
        ...f,
        runLocked: async (_lease, commit) =>
          commit(() => true, (() => Promise.resolve("late")) as unknown as () => string),
      });
      f.send(f.affirm());
      expect(await pending).toMatchObject({ ok: false, code: "E_MEM_EFFECT_UNKNOWN" });
    } finally {
      f.kernel.dispose();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("lifecycle cancellation prevents a delayed locked callback from writing", async () => {
    const f = setup();
    try {
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const before = f.fingerprint();
      const pending = runConfirmedStep({
        ...f,
        runLocked: async (_lease, commit) => {
          await waiting;
          return commit(
            () => true,
            () => writeFileSync(f.file, "after"),
          );
        },
      });
      f.send(f.affirm());
      await Promise.resolve();
      f.kernel.close(f.call);
      expect(await pending).toMatchObject({ ok: false, failure: { code: "E_MEM_CONFIRM_STALE" } });
      resume();
      await Promise.resolve();
      expect(f.fingerprint()).toEqual(before);
    } finally {
      f.kernel.dispose();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
