/** Unified v4 public surface. No production registration or host ownership here. */
export { createMemoryToolV4, type MemoryToolV4Deps } from "./tool.js";
export { MemoryToolParamsV4, memoryV4Surface, measureMemorySurface } from "./surface.js";
export { normalizeMemoryV4 } from "./normalize.js";
export { projectError, PROJECT_ERROR_MESSAGES } from "./errors.js";
export { appendV4Replacement, type V4Registration } from "./replacement.js";
export type * from "./types.js";
