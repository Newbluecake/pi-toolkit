import type { ReflexPortDeps } from "../../../src/reflex/ports/index.js";
import type { PortEnv } from "../../../src/reflex/core/types.js";
import type { GitRunResult } from "../../../src/git/run.js";

export const oid = "a".repeat(40);
export const head = `# branch.oid ${oid}\0# branch.head dev\0`;
export const tracked = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${oid} ${oid} ${path}\0`;
export const gitResult = (patch: Partial<GitRunResult> = {}): GitRunResult => ({
  code: 0,
  stdout: head,
  stderr: "",
  stdoutCapped: false,
  ...patch,
});
export const deps = (patch: Partial<ReflexPortDeps> = {}): ReflexPortDeps => ({
  bashJobs: () => undefined,
  fleet: () => undefined,
  quota: () => undefined,
  git: async () => gitResult(),
  ...patch,
});
export const env = (patch: Partial<PortEnv> = {}): PortEnv => ({
  cwd: "/tmp/reflex",
  now: 65000,
  budgetMs: 1200,
  signal: new AbortController().signal,
  ...patch,
});
