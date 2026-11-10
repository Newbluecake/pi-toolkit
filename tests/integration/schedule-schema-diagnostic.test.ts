import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { SCHEDULE_SCHEMA_LIMITS } from "../../src/tools/schedule-schema-shape.js";

// All data is synthetic. No schedule import/registration, actual SDK/provider, session or ledger.
const CLI = "scripts/dev/schedule-schema-diagnostic.ts";
const observation = { schema: { type: "object", properties: { prompt: { type: "string" } } } };
function run(input: string | Buffer, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
}
function failure(input: string | Buffer, code: string, args: string[] = []) {
  const result = run(input, args);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe(JSON.stringify({ ok: false, error: code }) + "\n");
  expect(result.stderr).toBe("schedule-schema-diagnostic: failed\n");
}

describe("#83 stdin-only offline schema diagnostic CLI", () => {
  it("accepts explicit JSON and emits only the safe shape contract", () => {
    const result = run(
      JSON.stringify({
        observations: [observation, { ...observation, source: "transport", sourceEvidence: "transport-attested" }],
        compare: [0, 1],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      evidence: "declarations-only",
      scope: "shape-only-not-a-fix",
      comparison: "equivalent",
    });
    expect(output.observations).toHaveLength(2);
    expect(output.observations[0].strict).toBe("absent");
    expect(output.observations[1].sourceEvidence).toBe("transport-attested");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(SCHEDULE_SCHEMA_LIMITS.outputBytes);
  });

  it("reports required undeclared fields conservatively across additionalProperties variants", () => {
    const variants = [{}, { additionalProperties: true }, { additionalProperties: false }].map((extra) => ({
      schema: { type: "object", properties: { action: { type: "string" } }, required: ["action", "prompt"], ...extra },
    }));
    for (const left of variants) {
      for (const right of variants) {
        const result = run(JSON.stringify({ observations: [left, right], compare: [0, 1] }));
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const output = JSON.parse(result.stdout);
        expect(output.comparison).toBe("inconclusive");
        for (const shape of output.observations) {
          expect(shape.complete).toBe(false);
          expect(shape.fields.find((f: { field: string }) => f.field === "prompt")).toMatchObject({
            presence: "missing",
            required: "yes",
            type: "unknown",
            nullability: "unknown",
          });
        }
      }
    }
  });

  it.each([-1, 0, 1])("raw stdin byte budget %+d, including whitespace and multibyte UTF8", (delta) => {
    const base = JSON.stringify({ observations: [observation], ignored: "凭据" });
    const input = base + " ".repeat(SCHEDULE_SCHEMA_LIMITS.inputBytes + delta - Buffer.byteLength(base));
    expect(Buffer.byteLength(input)).toBe(SCHEDULE_SCHEMA_LIMITS.inputBytes + delta);
    if (delta > 0) failure(input, "E_INPUT_BYTES");
    else {
      const result = run(input);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
      expect(result.stderr).toBe("");
    }
  });

  it("reports parse/UTF8 failures with fixed stdout and stderr, never exception bodies", () => {
    for (const input of [
      "",
      '{"SENTINEL_PARSE_SECRET":',
      "SENTINEL_PARSE_SECRET",
      Buffer.from([0xff, 0xfe]),
      '{"observations":[]} trailing_SENTINEL',
    ])
      failure(input, "E_JSON");
  });

  it("rejects path/flag arguments and JSON string paths without reading them", () => {
    failure("", "E_ARGUMENTS", ["/SENTINEL_NEVER_READ/config.json"]);
    failure("", "E_ARGUMENTS", ["--file=/SENTINEL_NEVER_READ/session.json"]);
    failure(JSON.stringify("/SENTINEL_NEVER_READ/traffic.json"), "E_INPUT_SHAPE");
  });

  it("cannot leak schema secrets or authenticate reported provenance", () => {
    const secret = "SENTINEL_SECRET_凭据_\u001b";
    const forbidden = [
      "description",
      "prompt",
      "enum",
      "const",
      "headers",
      "url",
      "path",
      "credentials",
      "apiKey",
      "$ref",
    ];
    const payload = Object.fromEntries(forbidden.map((name) => [name, name === "enum" ? [secret] : secret]));
    const result = run(
      JSON.stringify({
        observations: [
          {
            ...payload,
            source: secret,
            sourceEvidence: secret,
            api: secret,
            apiEvidence: secret,
            strict: secret,
            schema: {
              ...payload,
              type: "object",
              properties: { prompt: { ...payload, type: "string" }, [secret]: payload },
              required: [secret],
            },
          },
        ],
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("SENTINEL");
    expect(result.stdout).not.toContain("凭据");
    const output = JSON.parse(result.stdout);
    expect(output.observations[0]).toMatchObject({
      source: "unknown",
      api: "unknown",
      sourceEvidence: "unknown",
      apiEvidence: "unknown",
      strict: "unknown",
      complete: false,
    });
    expect(output.evidence).toBe("declarations-only");
  });

  it("fails limits atomically instead of returning partial equivalent", () => {
    const input = { observations: Array.from({ length: 40 }, () => observation), compare: [0, 1] };
    failure(JSON.stringify(input), "E_OUTPUT_BYTES");
    failure(JSON.stringify({ observations: [observation], ignored: Array<null>(4096).fill(null) }), "E_NODES");
    let deep: unknown = null;
    for (let i = 0; i < 33; i++) deep = [deep];
    failure(JSON.stringify({ observations: [observation], ignored: deep }), "E_DEPTH");
  });

  it("has zero runtime filesystem/config/network/process access beyond explicit stdin/stdout", () => {
    // Build the exact CLI and its only local import into memory so the guard does not
    // conflate Node/tsx code loading with automatic diagnostic data reads. The child then
    // denies filesystem, sockets, DNS, fetch and process execution before running the CLI.
    const built = buildSync({ entryPoints: [CLI], bundle: true, write: false, platform: "node", format: "esm" })
      .outputFiles[0]!.text;
    const guard = `
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import net from 'node:net';
      import http from 'node:http';
      import https from 'node:https';
      import dns from 'node:dns';
      import dnsp from 'node:dns/promises';
      import tls from 'node:tls';
      import dgram from 'node:dgram';
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      let forbiddenCalls = 0;
      const deny = () => { forbiddenCalls++; throw new Error('forbidden IO'); };
      for (const key of ['readFile','readFileSync','open','openSync','stat','statSync','lstat','lstatSync','readdir','readdirSync','realpath','realpathSync','access','accessSync','existsSync','createReadStream','writeFile','writeFileSync']) fs[key] = deny;
      for (const key of ['readFile','open','stat','lstat','readdir','realpath','access','writeFile']) fsp[key] = deny;
      net.connect = net.createConnection = net.createServer = deny;
      net.Socket.prototype.connect = deny;
      http.request = http.get = http.createServer = deny;
      https.request = https.get = https.createServer = deny;
      dns.lookup = dns.resolve = dnsp.lookup = dnsp.resolve = deny;
      tls.connect = tls.createServer = dgram.createSocket = deny;
      for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[key] = deny;
      globalThis.fetch = deny;
      syncBuiltinESMExports();
      process.argv = ['node', 'synthetic-offline-cli'];
      process.on('exit', () => { if (forbiddenCalls !== 0) { process.stderr.write('forbidden IO observed'); process.exitCode = 91; } });
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", guard + built.replace(/^#![^\n]*\n/, "")],
      {
        input: JSON.stringify({ observations: [observation, observation], compare: [0, 1] }),
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          HOME: "/SENTINEL_NEVER_READ",
          PI_CODING_AGENT_DIR: "/SENTINEL_NEVER_READ",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, comparison: "equivalent" });
  });
});
