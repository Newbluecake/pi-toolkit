import { describe, expect, it } from "vitest";
import { identityArgv } from "../../../src/web-hub/hub/hub.js";
import { looksLikeHubArgv } from "../../../src/web-hub/agent/proc-identity.js";

const NODE = "/usr/bin/node";
const JITI = "/x/jiti/lib/jiti-cli.mjs";
const MAIN = "/repo/src/web-hub/hub/main.ts";

describe("identityArgv (hub.json argv = kernel cmdline, not process.argv)", () => {
  it("records /proc/self/cmdline so the restart fallback's argv-shape check passes under jiti-cli", () => {
    // jiti-cli splices itself out of process.argv; /proc still shows all three items.
    const rewrittenProcessArgv = [NODE, MAIN];
    expect(looksLikeHubArgv(rewrittenProcessArgv)).toBe(false);
    const argv = identityArgv(`${NODE}\0${JITI}\0${MAIN}\0`, rewrittenProcessArgv);
    expect(argv).toEqual([NODE, JITI, MAIN]);
    expect(looksLikeHubArgv(argv)).toBe(true);
  });
  it("falls back to process.argv when cmdline is unreadable or empty", () => {
    expect(identityArgv(undefined, [NODE, MAIN])).toEqual([NODE, MAIN]);
    expect(identityArgv("", [NODE, MAIN])).toEqual([NODE, MAIN]);
  });
});
