/** Test-only v2 producer: P1 production writers deliberately cannot upgrade v1. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyStateFile, type ScheduleTask, type ScheduleStateFile } from "../../../src/schedule/core/spec.js";
import { initOcc } from "../../../src/schedule/core/occurrence.js";
import type { SessionStore } from "../../../src/schedule/core/writer.js";
import { makeTask } from "./fixtures.js";
export function everyTask(
  anchorAt: number,
  everyMs = 5_400_000,
  form: "background" | "message" = "background",
): ScheduleTask {
  return makeTask({ when: { kind: "every", everyMs, anchorAt }, form });
}
export function seedEvery(
  store: SessionStore,
  tasks: ScheduleTask[],
  watermark: number,
  resumePending = false,
): ScheduleStateFile {
  const state = emptyStateFile(store.sessionId);
  state.v = 2;
  state.tasks = tasks;
  for (const task of tasks) {
    state.occ[task.id] = { ...initOcc(task, watermark), ...(resumePending ? { resumePending: true } : {}) };
  }
  mkdirSync(join(store.root.real, store.dirName), { mode: 0o700, recursive: true });
  writeFileSync(join(store.root.real, store.dirName, "state.json"), JSON.stringify(state), { mode: 0o600 });
  return state;
}
