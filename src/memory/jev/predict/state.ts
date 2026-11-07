// 状态约束 S：发版进行中（plan.md v3.2 §3.4）。pi-free；无模块级可变状态。
//
// 判定：bashJobs 中存在 status=running，且其 shape（§6.1 口径，本地计算）
// 匹配 `*release*.sh`、`npm publish` 或 `gh release`。不是"下一步要发版"的
// 动作判断，不进入 tag 投票，也不受否定/只读/取消修饰影响（§4.2）。

import { allShapes } from "./shape.js";
import type { PredictInput, StateConstraint } from "./contracts.js";

const RELEASE_SCRIPT_RE = /^[\w.-]*release[\w.-]*\.sh$/i;

function isReleaseShape(shape: string): boolean {
  return RELEASE_SCRIPT_RE.test(shape) || shape === "npm publish" || shape === "gh release";
}

/** 当前的发版进行中状态（至多 1 条，§3.4）。 */
export function detectStateConstraints(bashJobs: PredictInput["bashJobs"]): readonly StateConstraint[] {
  for (const job of bashJobs) {
    if (job.status !== "running") continue;
    for (const shape of allShapes(job.command)) {
      if (isReleaseShape(shape)) return [{ kind: "release-in-progress", evidence: shape }];
    }
  }
  return [];
}
