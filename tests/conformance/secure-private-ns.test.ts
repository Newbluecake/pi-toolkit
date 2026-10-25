/**
 * `pi-secure run --private` conformance (private-plan r3 §6.3, NC1–NC12 + NC2b/NC2c): runs
 * `scripts/dev/secure-ns-probe.sh` in FULL mode — the production launcher against a throw-away
 * vault (temp HOME, TEST-ONLY fake password through script(1)), raw unshare/gocryptfs experiments,
 * and NC10's real pi in C5 isolation (temp HOME without packages, minimal env, no credentials,
 * PI_OFFLINE ⇒ "No API key", zero model requests) — and asserts its `CHECK <id> …` lines.
 *
 * Self-gating: skipped when FUSE / unprivileged user namespaces / the tools / the pi devDependency
 * are missing (the probe's own `SKIP all` line is honoured too). Serialized with every other
 * real-mount suite through the gocryptfs test lock. Re-run (`npm run test:conformance`) before any
 * pi peer, gocryptfs, util-linux, kernel or Node upgrade.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "../secure/gocryptfs-test-lock.js";
import { realSkipReason, which } from "../secure/private-real-harness.js";

const REPO = join(import.meta.dirname, "..", "..");
const PROBE = join(REPO, "scripts", "dev", "secure-ns-probe.sh");
const IDS = ["NC1", "NC2", "NC2b", "NC2c", "NC3", "NC4", "NC5", "NC6", "NC7", "NC8", "NC9", "NC10", "NC11", "NC12"];
const SKIP =
  realSkipReason() ||
  (which("nsenter") && which("timeout") ? "" : "missing nsenter/timeout") ||
  (readdirSync(join(REPO, "node_modules", "@earendil-works")).includes("pi-coding-agent")
    ? ""
    : "pi devDependency missing");

type Check = { status: string; detail: string };

describe.skipIf(SKIP !== "")(
  `secure-private-ns conformance (probe, full mode)${SKIP ? ` (skipped: ${SKIP})` : ""}`,
  () => {
    let release: (() => void) | undefined;
    let out = "";
    let code: number | null = null;
    const checks = new Map<string, Check>();
    let skippedAll = false;

    beforeAll(async () => {
      release = await acquireGocryptfsTestLock();
      // (a foreign global gocryptfs mount makes the probe print `SKIP all` — honoured below)
      ({ code, out } = await new Promise<{ code: number | null; out: string }>((res) => {
        const c = spawn("sh", [PROBE], {
          env: { ...process.env, TMPDIR: tmpdir() },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        c.stdout.on("data", (b: Buffer) => (text += b.toString()));
        c.stderr.on("data", (b: Buffer) => (text += b.toString()));
        c.on("close", (rc) => res({ code: rc, out: text }));
      }));
      skippedAll = /^SKIP all /m.test(out);
      for (const m of out.matchAll(/^CHECK (\S+) (PASS|FAIL|KNOWN) (.*)$/gm))
        checks.set(m[1]!, { status: m[2]!, detail: m[3]! });
    }, 600_000);
    afterAll(() => release?.());

    it("the probe ran to the end without FAIL and left nothing behind", (ctx) => {
      if (skippedAll) ctx.skip();
      expect(code, out).toBe(0);
      expect(out).toMatch(/^SUMMARY pass=\d+ fail=0 known=1 skip=0$/m);
      // review N4 #2: an unrelated look-alike process (temp path in argv + cwd, no token) survives cleanup
      expect(out).toMatch(/^SELFTEST cleanup-decoy PASS /m);
      expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain("/secure-ns-probe.");
      expect(readdirSync(tmpdir()).filter((n) => /^secure-ns-probe\.[A-Za-z0-9]{6}$/.test(n))).toEqual([]);
    });

    for (const id of IDS) {
      it(`${id}`, (ctx) => {
        if (skippedAll) ctx.skip();
        const c = checks.get(id);
        expect(c, `no CHECK line for ${id}\n${out}`).toBeDefined();
        // NC9 is a documented residual (same uid reaches the plaintext); everything else must PASS
        expect(c!.status, c!.detail).toBe(id === "NC9" ? "KNOWN" : "PASS");
      });
    }

    it("NC10 stayed offline: no model request was possible (no credentials, PI_OFFLINE)", (ctx) => {
      if (skippedAll) ctx.skip();
      expect(checks.get("NC10")?.detail).toMatch(/"No API key" \(zero model requests\)/);
    });
  },
);
