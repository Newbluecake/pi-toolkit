import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoadActivation } from "../../../../src/sysload/activation.ts";
import { IoLedger, withIoLease } from "../../../../src/sysload/io-ledger.ts";
import { scanTop } from "../../../../src/sysload/top.ts";
import { parseLoadSettings } from "../../../../src/sysload/settings.ts";

const mode = process.argv[2] ?? "activation";
const fifo = join(tmpdir(), `pi-toolkit-sysload-${process.pid}.fifo`);
execFileSync("mkfifo", [fifo]);

// Keep the loop busy from the very start (before any mode branch): the top-mode branch ends in
// a deliberately-stuck top-level `await`, and an EMPTY loop + pending TLA makes Node print its
// "Detected unsettled top-level await" warning to stderr ~1ms after the verdict line — which
// races into the harness's merged stdout+stderr and used to break the last-line JSON.parse.
setInterval(() => {}, 1_000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stuck = () => new Promise(() => {});

try {
  if (mode === "top") {
    const ledger = new IoLedger({ active: new Map(), capacity: 2 });
    const openProc = async () => ({ read: stuck, close: async () => undefined });
    const first = scanTop(ledger, { deadlineMs: 100, openProc, now: () => 0 });
    await wait(10);
    const second = await scanTop(ledger, { deadlineMs: 100, openProc, now: () => 0 });
    console.log(
      JSON.stringify({ verdict: second.partial && second.byCpu.length === 0 ? "pass" : "fail", active: ledger.size }),
    );
    await first;
  } else {
    const files = {
      "/proc/stat": "cpu 10 0 10 80 0 0 0 0 0 0\ncpu0 10 0 10 80 0 0 0 0 0 0\n",
      "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 500 kB\n",
      "/proc/loadavg": "1 2 3 1/10 42\n",
      "/proc/pressure/cpu": "some avg10=2.5 avg60=1 avg300=0 total=1\n",
    };
    const io = {
      readFileSync: (path) => files[path] ?? "",
      statfs: async () => fs.open(fifo, "r"),
    };
    const activation = createLoadActivation({
      settings: parseLoadSettings({ enabled: true, sampleIntervalMs: 2_000 }),
      io,
      mono: () => performance.now(),
      wall: () => Date.now(),
      scanTop: (ledger, options) =>
        scanTop(ledger, {
          ...options,
          deadlineMs: 100,
          openProc: async () => ({ read: stuck, close: async () => undefined }),
        }),
    });
    activation.start({ home: "/", cwd: "/" });
    activation.port().refreshTop();
    await wait(100);
    const started = Date.now();
    const unrelated = await fs.readFile("/etc/hosts", "utf8");
    const elapsedMs = Date.now() - started;
    activation.stop();
    await wait(150);
    console.log(
      JSON.stringify({
        verdict: unrelated.length > 0 && elapsedMs < 200 ? "pass" : "fail",
        active: new IoLedger().size,
        elapsedMs,
        lateDiscarded: activation.port().verdict().level === "unknown",
      }),
    );
  }
} finally {
  try {
    execFileSync("rm", ["-f", fifo]);
  } catch {}
}
await new Promise(() => {});
