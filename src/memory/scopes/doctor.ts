/** Read-only projections only: no disk, repair, authority minting or provider construction. */
import { scopedReadGate, type ScopedSurfaceDeps } from "./tool.js";
export interface ScopedDoctorFinding {
  readonly code: "H01" | "H05";
  readonly scope: "hub" | "session";
  readonly reason: string;
  readonly entryId?: string;
}
export function createScopedMemoryDoctor(deps: ScopedSurfaceDeps) {
  return {
    inspect(): readonly ScopedDoctorFinding[] {
      const findings: ScopedDoctorFinding[] = [];
      if (!scopedReadGate(deps, "hub")) {
        const view = deps.hub!.management.status();
        if (view.state === "inert")
          findings.push({ code: "H01", scope: "hub", reason: view.reason ?? "namespace inert" });
      }
      if (!scopedReadGate(deps, "session")) {
        for (const dropped of deps.session!.view().dropped)
          findings.push({ code: "H05", scope: "session", entryId: dropped.entryId, reason: dropped.reason });
      }
      return findings;
    },
  };
}
