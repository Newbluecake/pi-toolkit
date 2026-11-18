/** Static inventory of schedule-store paths derived from directory descriptors. */
export const FDPATH_MANIFEST = [
  ["lock.ts", "readLockHolder", 1],
  ["lock.ts", "tryLock", 1],
  ["paths.ts", "fdPath", 1],
  ["paths.ts", "openDirAt", 1],
  ["paths.ts", "readFileAt", 1],
  ["paths.ts", "linuxLstatAt", 1],
  ["reader.ts", "listSessionDirs", 1],
  ["writer.ts", "atomicWriteAt", 4],
  ["writer.ts", "ensureStoreRoot", 1],
  ["writer.ts", "createSess", 1],
  ["writer.ts", "repair", 2],
  ["writer.ts", "reportInventory", 2],
  ["writer.ts", "sessionTemps", 2],
  ["writer.ts", "unlinkReports", 1],
  ["writer.ts", "gcSessionReports", 1],
  ["writer.ts", "writeReportLocked", 1],
  ["writer.ts", "recycleSessionDir", 4],
] as const;

export const CLOSE_MANIFEST = [
  "paths.ts:closeQuiet",
  "lock.ts:readLockHolder",
  "lock.ts:tryLock",
  "lock.ts:withDirLock",
  "writer.ts:atomicWriteAt",
] as const;

export const JUDGE_MANIFEST = [
  "note.ts:172",
  "note.ts:217",
  "digest.ts:222",
  "wire.ts:clock-judge",
  "service.ts:397",
  "service.ts:404",
] as const;

export const ABS_SYSCALL_MANIFEST = [
  "paths.ts:openDirPath",
  "paths.ts:openDirPathUnchecked",
  "paths.ts:resolveStoreRoot",
  "writer.ts:ensureStoreRoot",
  "lock.ts:tryLock",
] as const;
