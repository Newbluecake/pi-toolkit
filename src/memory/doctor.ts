// §6.1 `runDoctor` — STUB (todo #22 P0-b's frozen-surface commit; real
// implementation lands in package P3, §14.1). `command.ts` never calls this
// module directly (it goes through `doctor-command.ts`); this file exists so
// P3 has a pre-agreed function name/shape and P1's tiered renderer (D09) has
// something to eventually import without a signature negotiation.

import type { DoctorFinding, MemoryMeta } from "./contracts.js";

export interface DoctorSnapshotFile {
  name: string;
  size: number;
  meta: MemoryMeta;
}

export interface DoctorSnapshot {
  cwd: string;
  files: readonly DoctorSnapshotFile[];
}

export interface DoctorSettings {
  coreBytes: number;
  blockBytes: number;
  topicWarnBytes: number;
  topicMaxBytes: number;
  staleDays: number;
}

/** Not implemented yet (P3). Pure function — never touches fs/pi itself. */
export function runDoctor(_snapshot: DoctorSnapshot, _settings: DoctorSettings): DoctorFinding[] {
  throw new Error("runDoctor: not implemented yet (todo #22 P3)");
}
