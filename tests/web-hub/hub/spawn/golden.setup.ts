/**
 * Observe real HTTP bytes + whitelisted audit lines in the existing route suites, without
 * changing their assertions or collaborators. Capture was made BEFORE the F5 source edit.
 * Regeneration is deliberately refused once that exact source is no longer present.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ClientRequest } from "node:http";
import { afterEach, beforeEach, expect, vi } from "vitest";

const observed = vi.hoisted(() => ({ responses: [] as unknown[], audits: [] as string[] }));
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  return {
    ...http,
    request: (...args: unknown[]): ClientRequest => {
      const req = Reflect.apply(http.request, undefined, args) as ClientRequest;
      if (
        req.path.startsWith("/api/headless") &&
        (!expect.getState().testPath?.includes("tests/integration/") ||
          (req.method === "POST" && req.path === "/api/headless"))
      ) {
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            observed.responses.push({
              method: req.method,
              path: req.path,
              status: res.statusCode,
              // Date is transport-generated wall time, not a route response contract.
              headers: { ...res.headers, ...(res.headers.date === undefined ? {} : { date: "<DATE>" }) },
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      }
      return req;
    },
  };
});
vi.mock("../../../../src/web-hub/hub/audit.js", async (importOriginal) => {
  const audit = await importOriginal<typeof import("../../../../src/web-hub/hub/audit.js")>();
  return {
    ...audit,
    auditSpawn: (log: Parameters<typeof audit.auditSpawn>[0], record: Parameters<typeof audit.auditSpawn>[1]) => {
      audit.auditSpawn(
        {
          info(msg, data) {
            if (
              !expect.getState().testPath?.includes("tests/integration/") ||
              (record.endpoint === "spawn" && (record.phase === "request" || record.phase === "reject"))
            )
              observed.audits.push(JSON.stringify({ msg, data }));
            log.info(msg, data);
          },
        },
        record,
      );
    },
  };
});

const FIXTURE = resolve("tests/fixtures/feishu-spawn-http-golden.json");
const BASELINE_SHA = "fb1356235573ce6531623e828c545e72f5600bcfb58fbe2e6ea3df3e739317a9";
const capture = process.env.F5_CAPTURE_GOLDEN === "1";

beforeEach(() => {
  observed.responses = [];
  observed.audits = [];
});
afterEach(() => {
  const key = `${relative(process.cwd(), expect.getState().testPath ?? "")} :: ${expect.getState().currentTestName}`;
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  // An existing audit-only scenario must still fail if a refactor removes its last audit.
  if (observed.responses.length === 0 && observed.audits.length === 0 && golden[key] === undefined) return;
  // Normalize only generated ids. Keep raw body serialization (including key order), all
  // headers (including Content-Length), audit serialization/order, and repeated-id identity.
  const ids = new Map<string, string>();
  function normalized(value: unknown): string {
    return JSON.stringify(value)
      .replace(/\/tmp\/(pwh-mkdir|pi-toolkit-home)-[A-Za-z0-9]{6}/g, "/tmp/$1-XXXXXX")
      .replace(/\\?"(?:spawnId|reqId|id)\\?":\\?"([A-Za-z0-9_-]{16,}|[a-f0-9-]{36})\\?"/g, (all, id: string) => {
        if (id.startsWith("reqid-") || id.startsWith("sp-") || id.startsWith("request")) return all;
        let name = ids.get(id);
        if (name === undefined) {
          name = `<ID${ids.size + 1}>`;
          ids.set(id, name);
        }
        return all.replace(id, name);
      });
  }
  const actual = { responses: normalized(observed.responses), audits: normalized(observed.audits) };
  if (capture) {
    expect(createHash("sha256").update(readFileSync("src/web-hub/hub/spawn/routes.ts")).digest("hex")).toBe(
      BASELINE_SHA,
    );
    golden[key] = actual;
    writeFileSync(FIXTURE, `${JSON.stringify(golden, null, 2)}\n`);
  } else {
    expect(actual, key).toEqual(golden[key]);
  }
});
