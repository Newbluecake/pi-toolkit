/** Validate before collection. Execution policy belongs to the secure-only runner, not hooks. */
import { inject } from "vitest";
import { validateSecureEnv } from "../secure/preflight.js";

validateSecureEnv(inject("secureEnv"));
