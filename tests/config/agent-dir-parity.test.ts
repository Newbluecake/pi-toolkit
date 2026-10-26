import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAgentDir } from "../../src/core/agent-dir.js";
import { resolveAgentDir as protocolResolve } from "../../src/web-hub/protocol/agent-dir.js";

const helperPath = new URL("../../src/secure/bin/helper.mjs", import.meta.url).href;
const helper = await import(helperPath);
const home = "/tmp/pi-agent-parity-home";
const H = join(home, ".pi", "agent");
const defaults = { dir: H, home: H, source: "default" };
const custom = (dir: string) => ({ dir, home: H, source: "env" });

// T-AD1: one inline contract table drives ALL three independently implemented resolvers.
const cases = [
  { label: "unset", raw: undefined, expected: defaults },
  { label: "empty", raw: "", expected: defaults },
  { label: "whitespace", raw: " ", expected: { ...defaults, ignored: { raw: " ", reason: "relative" } } },
  { label: "tilde", raw: "~", expected: custom(home) },
  { label: "tilde child", raw: "~/x", expected: custom(join(home, "x")) },
  { label: "absolute", raw: "/tmp/agent", expected: custom("/tmp/agent") },
  { label: "trailing slash", raw: "/tmp/agent/", expected: custom("/tmp/agent") },
  { label: "lexical normalization", raw: "/tmp/a/../agent", expected: custom("/tmp/agent") },
  { label: "default absolute", raw: H, expected: defaults },
  { label: "default tilde", raw: "~/.pi/agent", expected: defaults },
  { label: "default slash", raw: `${H}/`, expected: defaults },
  { label: "file URL", raw: "file:///x", expected: custom("/x") },
  { label: "encoded URL", raw: pathToFileURL("/tmp/agent space").href, expected: custom("/tmp/agent space") },
  { label: "relative", raw: "rel", expected: { ...defaults, ignored: { raw: "rel", reason: "relative" } } },
  {
    label: "no trim",
    raw: " /tmp/agent",
    expected: { ...defaults, ignored: { raw: " /tmp/agent", reason: "relative" } },
  },
  { label: "absolute with trailing space", raw: "/tmp/agent ", expected: custom("/tmp/agent ") },
  {
    label: "invalid URL",
    raw: "file://%",
    expected: { ...defaults, ignored: { raw: "file://%", reason: "relative" } },
  },
];

describe("T-AD1 agentDir mirrors", () => {
  it.each(cases)("$label", ({ raw, expected }) => {
    const env = raw === undefined ? {} : { PI_CODING_AGENT_DIR: raw };
    expect(resolveAgentDir(env, home)).toEqual(expected);
    expect(protocolResolve(env, home)).toEqual(expected);
    expect(helper.resolveAgentDir(env, home)).toEqual(expected);
  });
});
