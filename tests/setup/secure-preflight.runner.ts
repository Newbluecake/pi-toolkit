/** File-level gate: skip/fail before ANY fixture, even when collection already self-skipped. */
import { updateTask, type Suite, type Task, type VitestRunner } from "@vitest/runner";
import { inject } from "vitest";
import { VitestTestRunner } from "vitest/runners";
import { renderExternalSkip, renderPreflightFailure, validateSecureEnv } from "../secure/preflight.js";

declare module "@vitest/runner" {
  interface TaskMeta {
    securePreflightSkip?: string;
  }
}

function hasFailure(task: Task): boolean {
  return (
    task.result?.state === "fail" ||
    !!task.result?.errors?.length ||
    (task.type === "suite" && task.tasks.some(hasFailure))
  );
}

/** Public task metadata is serialized by Vitest's JSON reporter (console text alone is insufficient). */
export function skipSecureTree(task: Task, reason: string, publish: (task: Task) => void): boolean {
  if (hasFailure(task)) return false;
  const walk = (t: Task): void => {
    t.mode = "skip";
    t.result = { ...t.result, state: "skip" };
    t.meta.securePreflightSkip = reason;
    publish(t);
    if (t.type === "suite") t.tasks.forEach(walk);
  };
  walk(task);
  return true;
}

export default class SecurePreflightRunner extends VitestTestRunner {
  override async onBeforeRunSuite(suite: Suite): Promise<void> {
    if ("filepath" in suite) {
      try {
        const verdict = validateSecureEnv(inject("secureEnv"));
        if (verdict.state === "dirty") throw new Error(renderPreflightFailure(verdict));
        if (verdict.state === "external-mounts") {
          const reason = renderExternalSkip(verdict);
          if (skipSecureTree(suite, reason, (task) => updateTask(task, this as VitestRunner))) {
            console.warn(`${reason} File: ${JSON.stringify(suite.filepath)}`);
          } else if (suite.result?.state !== "fail") {
            throw new Error("[secure-preflight] collection failure preserved; external mounts cannot mask it");
          }
        }
      } catch (error) {
        // runSuite checks result.fail BEFORE mode.skip and never runs hooks on this branch.
        // Do not force a skipped fixture to execute just to manufacture an exit code.
        const e = error instanceof Error ? error : new Error(String(error));
        suite.mode = "skip";
        suite.result = {
          ...suite.result,
          state: "fail",
          errors: [...(suite.result?.errors ?? []), { name: e.name, message: e.message, stack: e.stack ?? e.message }],
        };
      }
    }
    await super.onBeforeRunSuite(suite);
  }
}
