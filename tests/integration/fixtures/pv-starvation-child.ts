import { createClientAllowGuard } from "../../../src/web-hub/hub/client-allow.js";
/**
 * web-hub HTML preview plan v2 §8 T-I1 — the `/pv` libuv-starvation child (P3).
 *
 * Runs as a REAL child process under `UV_THREADPOOL_SIZE=4` (pi's bundled jiti executes this
 * TypeScript directly; the pool size must be fixed before libuv boots). It stands up a REAL
 * `createHttpFrontend` (loopback + LAN listeners) whose `createPreviewRoutes({ html })` carries
 * the two never-settling PV fs seams of §2.5:
 *
 *  - `wedge.js` is a REAL FIFO whose `open` has `O_NONBLOCK` stripped by the seam ⇒ a genuinely
 *    blocking threadpool op (a FIFO read-open with no writer never returns). The PV gate's 2s
 *    per-op race gives up (⇒ the request answers 503), but the slot stays held — a zombie — so
 *    exactly ONE libuv thread is wedged by `/pv` forever.
 *  - `closecall.js` is a regular file whose handle `close` never settles (the seam fires the
 *    REAL close — no fd leak — and returns a never-resolving promise) ⇒ the gate's priority
 *    close lane holds the second PV slot forever without touching the threadpool.
 *
 * With both `PV_IO_SLOTS` saturated, the suite proves T-I1's guarantee: `/pv` itself degrades
 * to bounded 503s while `GET /api/preview`, a full upload begin→chunk→commit POST and a LAN
 * login (REAL async `crypto.scrypt` through `hub/kdf.ts`, N=16384) all complete within their
 * normal budgets.
 *
 * Same process-model note as `history-starvation-child.ts` (measured on Node 22): a pending
 * blocking threadpool open BLOCKS `process.exit` — this child can never exit on its own once
 * wedged, by design. The FINAL VERDICT rides stdout as the last JSON line; the parent SIGKILLs
 * after reading it.
 *
 * Phase 3 (record-only) wedges two further threadpool threads DIRECTLY (outside the hub) to
 * document the honest boundary: at that point 3 of 4 pool threads are stuck and pv's own
 * 2-slot budget is the only reason the hub survived phase 2 — nothing is asserted there.
 */
import { spawnSync } from "node:child_process";
import { scrypt, scryptSync } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open as fspOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createKdf } from "../../../src/web-hub/hub/kdf.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { defaultPreviewFs } from "../../../src/web-hub/hub/preview/fs.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import type { PreviewHandle } from "../../../src/web-hub/hub/preview/admit.js";
import type { FrontendDeps } from "../../../src/web-hub/hub/ports.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { createUploadHttpMetrics } from "../../../src/web-hub/hub/audit.js";
import { createUploadStore } from "../../../src/web-hub/hub/uploads.js";
import { fakeLanStore } from "../../web-hub/contract/fakes.js";
import { lanPostJson } from "../../web-hub/http/lan-helpers.js";
import { fakeDeps, login, makeAgent, postJson, rawRequest, type RawResponse } from "../../web-hub/http/helpers.js";
import { freePort } from "../../helpers/free-port.js";
import { PV_CAP_RE, PREVIEW_HTML_CAP_PATH } from "../../../src/web-hub/protocol/preview-html.js";

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0o4000;
const AGENT = "a4242-nonce12";
const SESSION = "sess123";
const LAN_USER = "pvstarve";
const LAN_PW = "correct-horse-battery";

const report: Record<string, unknown> = {};

function emit(verdict: "pass" | "fail", error?: string): void {
  report["verdict"] = verdict;
  if (error !== undefined) report["error"] = error;
  try {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    /* pipe gone — nothing left to do */
  }
}

async function timedGet(label: string, get: () => Promise<RawResponse>, maxMs: number): Promise<RawResponse> {
  const t0 = Date.now();
  const outcome = await Promise.race([
    get().then(
      (r) => r,
      () => ({ status: -1, headers: {}, body: "" }) as RawResponse,
    ),
    new Promise<RawResponse>((r) =>
      setTimeout(() => r({ status: -2, headers: {}, body: "timeout" as string }), maxMs).unref(),
    ),
  ]);
  report[label] = { status: outcome.status, ms: Date.now() - t0 };
  return outcome;
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pwh-pvstarve-"));
  const cwd = join(home, "cwd");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "preview.txt"), "pv-starvation liveness probe\n");
  const site = join(home, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "index.html"), "<!doctype html><title>pv</title><p>ok</p>\n");
  writeFileSync(join(site, "style.css"), "body{color:#333}\n");
  writeFileSync(join(site, "app.js"), "console.log('app');\n");
  writeFileSync(join(site, "closecall.js"), "console.log('closecall');\n");
  const fifoAbs = join(site, "wedge.js");
  if (existsSync(fifoAbs)) rmSync(fifoAbs);
  const mk = spawnSync("mkfifo", [fifoAbs]);
  if (mk.status !== 0) {
    emit("fail", `mkfifo failed: ${String(mk.stderr)}`);
    return;
  }

  const deps = fakeDeps(home);
  const now = (): number => Date.now();
  deps.now = now;
  deps.agents.set(
    AGENT,
    makeAgent(AGENT, {
      control: true,
      upload: true,
      uploadLan: true,
      session: { sessionId: SESSION, cwd, reason: "test", leafId: null, mode: "tui" },
    }),
  );

  // the /pv never-settling seams (§2.5): a blocking FIFO open + a never-settling close
  const real = defaultPreviewFs();
  let closeStarted = 0;
  const routes = createPreviewRoutes({
    mode: "on",
    denyCtx: denyCtxOf(home, join(home, ".pi", "agent")),
    uploadsRoot: join(home, "uploads"),
    registry: deps.registry,
    log: deps.log,
    now,
    html: {
      fs: {
        open: async (p: string, flags: number) => {
          if (p.endsWith("/wedge.js")) return real.open(p, flags & ~O_NONBLOCK);
          const fh = await real.open(p, flags);
          if (!p.endsWith("/closecall.js")) return fh;
          const neverSettling: PreviewHandle = {
            get fd() {
              return fh.fd;
            },
            stat: () => fh.stat(),
            read: (buf: Buffer, off: number, len: number, pos: number) => fh.read(buf, off, len, pos),
            close: () => {
              closeStarted += 1;
              void fh.close().catch(() => undefined); // the REAL close fires — no fd leak
              return new Promise<void>(() => undefined); // …but the gate never sees it settle
            },
          };
          return neverSettling;
        },
      },
    },
  });
  (deps as FrontendDeps).preview = routes;

  // a REAL upload store (begin → chunk → commit exercises real fs writes)
  const uploadsRoot = join(home, "uploads");
  const store = createUploadStore({ root: uploadsRoot, now, log: deps.log });
  (deps as FrontendDeps).uploads = store;
  (deps as FrontendDeps).uploadMetrics = createUploadHttpMetrics();

  // a REAL LAN stack with the REAL async-scrypt KdfPort (`hub/kdf.ts`, N=16384 seeded row)
  const lanStore = fakeLanStore();
  const salt = Buffer.alloc(16, 7);
  lanStore.seedUser({
    id: 1,
    username: LAN_USER,
    kdf: "scrypt",
    n: 16384,
    r: 8,
    p: 1,
    salt,
    hash: scryptSync(LAN_PW, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 + 1024 * 1024 }),
    epoch: 1,
    createdAt: now(),
    updatedAt: now(),
  });
  const limiter = createLoginLimiter({ now });
  const lanPort = await freePort();
  (deps as FrontendDeps).lan = {
    clientAllow: createClientAllowGuard({}),
    cfg: { port: lanPort, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    store: lanStore,
    kdf: createKdf(),
    limiter,
    admission: createKdfAdmission({ now, isTightened: limiter.isTightened }),
    hosts: createHostsPort(),
    scope: createScope({ log: deps.log, now }),
    onStatus: () => undefined,
  };

  const fe = createHttpFrontend(deps as FrontendDeps);
  const loopPort = (await fe.listen()).port;
  if (fe.lan === undefined) {
    emit("fail", "fe.lan missing");
    return;
  }
  const lanSt = await fe.lan.start();
  if (lanSt.state !== "on") {
    emit("fail", `LAN failed: ${JSON.stringify(lanSt)}`);
    return;
  }
  await store.recover();
  const cookie = await login(loopPort, deps.paths.tokenFile);

  // ---- mint (must precede the wedges: the pin itself rides the PV gate) -------------------
  const q = `agentKey=${AGENT}&sessionId=${SESSION}`;
  const mint = await postJson(
    loopPort,
    `${PREVIEW_HTML_CAP_PATH}?${q}`,
    { path: join(site, "index.html") },
    { Cookie: cookie },
  );
  if (mint.status !== 200) {
    emit("fail", `mint failed: ${mint.status} ${mint.body}`);
    return;
  }
  const cap = (JSON.parse(mint.body) as { url: string }).url.split("/")[2] ?? "";
  if (!PV_CAP_RE.test(cap)) {
    emit("fail", `bad cap in mint body`);
    return;
  }
  const pv = (rel: string): string => `/pv/${cap}/${rel}`;

  // phase 0 sanity — /pv serves normally pre-wedge
  const s0 = await timedGet("pvSanity", () => rawRequest(loopPort, { path: pv("style.css"), timeoutMs: 5_000 }), 5_000);
  if (s0.status !== 200) {
    emit("fail", `pv sanity GET was ${s0.status}`);
    return;
  }

  // ---- phase 1: saturate both PV_IO_SLOTS with never-settling ops -------------------------
  // wedge.js: blocking FIFO open ⇒ threadpool zombie + PV slot (request 503s at the 2s op race)
  const w1 = await timedGet(
    "fifoWedge",
    () => rawRequest(loopPort, { path: pv("wedge.js"), timeoutMs: 12_000 }),
    12_000,
  );
  if (w1.status !== 503) {
    emit("fail", `wedge GET answered ${w1.status} (expected 503 within the op-race deadline)`);
    return;
  }
  if (((report["fifoWedge"] as { ms: number }).ms ?? 0) > 7_000) {
    emit(
      "fail",
      `wedge GET took ${String((report["fifoWedge"] as { ms: number }).ms)}ms — beyond the 2s race + margin`,
    );
    return;
  }
  // closecall.js: the stream drains fine (200), then the never-settling close holds slot 2
  const c1 = await timedGet(
    "closeWedge",
    () => rawRequest(loopPort, { path: pv("closecall.js"), timeoutMs: 8_000 }),
    8_000,
  );
  if (c1.status !== 200) {
    emit("fail", `closecall GET was ${c1.status}`);
    return;
  }
  const closeDeadline = Date.now() + 5_000;
  while (closeStarted === 0 && Date.now() < closeDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (closeStarted === 0) {
    emit("fail", "the never-settling close never started — slot 2 not held");
    return;
  }
  report["closeStarted"] = closeStarted;
  // both slots zombie ⇒ every further /pv request degrades to a bounded 503 (busy at its admit
  // deadline), never a hang
  const d1 = await timedGet(
    "pvDegraded",
    () => rawRequest(loopPort, { path: pv("app.js"), timeoutMs: 12_000 }),
    12_000,
  );
  if (d1.status !== 503) {
    emit("fail", `degraded /pv GET answered ${d1.status} (expected 503 busy within PV_ADMIT_TOTAL_MS)`);
    return;
  }
  if (((report["pvDegraded"] as { ms: number }).ms ?? 0) > 7_000) {
    emit(
      "fail",
      `degraded /pv GET took ${String((report["pvDegraded"] as { ms: number }).ms)}ms — beyond the 4s admit deadline + margin`,
    );
    return;
  }

  // ---- phase 2: T-I1 liveness — the hub keeps serving while /pv is wedged ------------------
  const pv2 = await timedGet(
    "previewRead",
    () =>
      rawRequest(loopPort, {
        path: `/api/preview?${q}&path=${encodeURIComponent(join(cwd, "preview.txt"))}`,
        headers: { "X-PWH": "1", Cookie: cookie },
        timeoutMs: 5_000,
      }),
    5_000,
  );
  if (pv2.status !== 200 || ((report["previewRead"] as { ms: number }).ms ?? 0) > 2_000) {
    emit("fail", `ordinary /api/preview degraded: ${JSON.stringify(report["previewRead"])}`);
    return;
  }
  const t0 = Date.now();
  const id = `pvstarve${Math.random().toString(36).slice(2, 8)}`;
  const loopOrigin = `http://127.0.0.1:${loopPort}`;
  const begin = await postJson(
    loopPort,
    "/api/upload/begin",
    { agentKey: AGENT, id, name: "probe.bin", size: 65_536 },
    { Cookie: cookie, Origin: loopOrigin },
  );
  report["uploadBegin"] = { status: begin.status, ms: Date.now() - t0 };
  if (begin.status !== 200) {
    emit("fail", `upload begin failed: ${begin.status} ${begin.body}`);
    return;
  }
  const chunkBytes = (JSON.parse(begin.body) as { chunkBytes: number }).chunkBytes;
  const part = Buffer.alloc(Math.min(chunkBytes, 65_536), 7);
  const t1 = Date.now();
  const chunk = await new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: loopPort,
        method: "POST",
        path: `/api/upload/chunk?id=${id}&offset=0`,
        headers: {
          Host: `127.0.0.1:${loopPort}`,
          "Content-Type": "application/octet-stream",
          "X-PWH": "1",
          Cookie: cookie,
          Origin: loopOrigin,
          "Content-Length": String(part.length),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(12_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.write(part);
    req.end();
  });
  report["uploadChunk"] = { status: chunk.status, ms: Date.now() - t1 };
  if (chunk.status !== 200) {
    emit("fail", `upload chunk failed: ${chunk.status} ${chunk.body}`);
    return;
  }
  const t2 = Date.now();
  const commit = await postJson(loopPort, "/api/upload/commit", { id }, { Cookie: cookie, Origin: loopOrigin });
  report["uploadCommit"] = { status: commit.status, ms: Date.now() - t2 };
  if (commit.status !== 200 || ((report["uploadCommit"] as { ms: number }).ms ?? 0) > 3_000) {
    emit("fail", `upload commit degraded: ${JSON.stringify(report["uploadCommit"])}`);
    return;
  }
  const t3 = Date.now();
  const lanLogin = await lanPostJson(lanSt.port, "/api/login", { username: LAN_USER, password: LAN_PW });
  report["lanLogin"] = { status: lanLogin.status, ms: Date.now() - t3 };
  if (lanLogin.status !== 200 || ((report["lanLogin"] as { ms: number }).ms ?? 0) > 5_000) {
    emit("fail", `LAN login (real async scrypt) degraded: ${JSON.stringify(report["lanLogin"])}`);
    return;
  }

  // ---- phase 3 (record-only): 2 further DIRECT pool wedges — the honest boundary -----------
  // Outside the hub: 3 of 4 threads now stuck (1 via pv's own budget + 2 direct). Only pv's
  // 2-slot cap kept the hub alive above; nothing more is guaranteed here, so nothing asserted.
  void fspOpen(fifoAbs, fsConstants.O_RDONLY).catch(() => undefined);
  void fspOpen(fifoAbs, fsConstants.O_RDONLY).catch(() => undefined);
  const t4 = Date.now();
  await new Promise<void>((resolve) => {
    scrypt("pw", "salt", 16_384, () => resolve());
  });
  report["scryptWithPoolWedged"] = { ms: Date.now() - t4 };
  emit("pass");
}

void main().catch((err: unknown) => emit("fail", String(err)));
