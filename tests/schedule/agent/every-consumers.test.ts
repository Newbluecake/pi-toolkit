import { afterEach, describe, expect, it } from "vitest";
import { backgroundHeader, commitBackgroundReport } from "../../../src/schedule/agent/report-file.js";
import { wakeContent, renderReport } from "../../../src/schedule/agent/message.js";
import { catchUpText, localTime, runLine, whenText } from "../../../src/schedule/agent/view.js";
import { reconcileEvery } from "../../../src/schedule/core/interval.js";
import { readReportFile } from "../../../src/schedule/core/reader.js";
import { everyTask, seedEvery } from "../core/every-fixtures.js";
import { env, holder, readOk, type Env } from "../core/fixtures.js";
const A = Date.parse("2026-11-09T10:07:23Z"),
  D = 5_400_000;
let e: Env | undefined;
afterEach(() => e?.cleanup());
describe("every consumers use the durable catch-up window", () => {
  it.each(["background", "message"] as const)(
    "%s prompt/report/history contains N + interval + recovery and explicitly executes once",
    async (form) => {
      e = env(A + 5 * 3_600_000);
      const store = e.store();
      const task = everyTask(A, D, form);
      seedEvery(store, [task], A);
      const claimed = await reconcileEvery(store, {
        taskId: task.id,
        holder: holder(),
        openedAt: e.clock.t,
        deadlineMono: performance.now() + 10_000,
        gate: () => undefined,
      });
      if (claimed.kind !== "fired") throw Error(claimed.kind);
      const run = claimed.run;
      const text = catchUpText(run);
      expect(text).toContain("合并 3 次到期，本次只执行一次");
      for (const instant of [A, A + 3 * D, e.clock.t]) expect(text).toContain(new Date(instant).toISOString());
      expect(backgroundHeader(task, run)).toContain(text);
      expect(wakeContent(run, task)).toContain(text);
      expect(renderReport(task, run, "result").toString()).toContain(text);
      expect(runLine(run, task.when)).toContain("catch-up ×3");
      expect(runLine(run, task.when)).toContain(text);
      expect(localTime(task.when, A + 3 * D)).toBe("2026-11-09 14:37:23 UTC");
      expect(whenText(task.when)).toContain("every 5400s");
      expect(whenText(task.when)).toContain("2026-11-09T10:07:23.000Z");
      if (form === "background") {
        const result = await commitBackgroundReport({
          store,
          task,
          run,
          holder: holder(),
          isDisposed: () => false,
          result: { state: "completed", text: "result" },
          now: e.clock.t,
        });
        expect(result.kind).toBe("committed");
        const saved = readOk(store).runs[0]!;
        expect(saved.catchUp).toEqual(run.catchUp);
        expect(readOk(store).v).toBe(2);
        expect(saved.reportFile).toBe(`reports/${task.id}-20261109-1437.md`);
        const report = readReportFile(store.root, store.dirName, saved.reportFile!);
        if (report.kind !== "ok") throw Error(report.kind);
        expect(report.text).toContain(text);
      }
    },
  );
});
