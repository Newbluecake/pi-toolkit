/** #65 S1: real Chromium → HTTP → production commands/task/store/ledger → SSE/query → Vue DOM.
 * Isolated SDK sessions only. No synthetic results, no native command dispatch, no live model.
 * Exit 2 means offline browser unavailable, NEVER a pass. Production injection is a separate gate.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { loadPlaywright } from "./lib/playwright.js";
import { createMemoryWebHost } from "../../tests/integration/memory-web-command-harness.js";

async function main() {
  const run = { runId: randomUUID(), startedAt: new Date().toISOString() };
  console.log(JSON.stringify({ event: "s1_run_start", ...run }));
  const pw = await loadPlaywright();
  if (!pw.ok) {
    console.error(`S1 UNAVAILABLE: ${pw.reason}`);
    process.exitCode = 2;
    return;
  }
  const browser = await pw.chromium.launch({ headless: true });
  const root = resolve(".");
  const dir = mkdtempSync(join(tmpdir(), "memory-s1-browser-"));
  const results: unknown[] = [];
  let host = await createMemoryWebHost("buffered");
  let off: (() => void) | undefined;
  let abortRelease: (() => void) | undefined;
  let abortBarrier: Promise<void> | undefined;
  let abortArrived = false;
  let ackBarrier: Promise<void> | undefined;
  let ackRelease: (() => void) | undefined;
  const clients = new Set<import("node:http").ServerResponse>();
  const connect = () => {
    off?.();
    off = host.listen((event, data) => {
      for (const res of clients) res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
    });
  };
  connect();
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `
import { createApp, h, shallowRef } from 'vue';
import AskUserForm from '/@fs${root}/src/web-hub/ui/src/components/dialog/AskUserForm.vue';
import MemoryCommandFixture from '/@fs${root}/tests/web-hub/ui/fixtures/MemoryCommandFixture.vue';
import {createMemoryCommandFixture} from '/@fs${root}/tests/web-hub/ui/fixtures/memory-command.ts';
import {setLangOverride} from '/@fs${root}/src/web-hub/ui/src/composables/useI18n.ts';
import '/@fs${root}/src/web-hub/ui/src/styles/tokens.css';
import '/@fs${root}/src/web-hub/ui/src/styles/base.css';
import '/@fs${root}/src/web-hub/ui/src/styles/control.css';
import '/@fs${root}/src/web-hub/ui/src/styles/dock.css';
setLangOverride('zh', null);
const owner=await (await fetch('/s1/owner')).json();
const fixture=createMemoryCommandFixture({owner, history:new URLSearchParams(location.search).get('history')==='1',
  command:async req=>(await fetch('/s1/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req)})).json()});
const source=new EventSource('/s1/events');
const dialogs=shallowRef([]);
source.onmessage=e=>{const m=JSON.parse(e.data);fixture.emit(m.event,m.data);if(m.event==='dialogs')dialogs.value=m.data.open;};
window.memoryFixture=fixture;
window.s1Source=source;
createApp({render:()=>h('main',[h(MemoryCommandFixture,{fixture}),...dialogs.value.map(d=>h(AskUserForm,{key:d.dialogId,dialog:d,onAnswer:answers=>fetch('/s1/dialog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dialogId:d.dialogId,epoch:owner.epoch,answers})})}))])}).mount('#app');
`,
  );
  const server = await createServer({
    configFile: false,
    root,
    plugins: [
      vue(),
      {
        name: "s1-real-sdk-http",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const path = req.url?.split("?")[0];
            if (path === "/s1") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  "/s1",
                  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><div id="app"></div><script type="module" src="/@fs${entry}"></script></body></html>`,
                ),
              );
            } else if (path === "/s1/owner") {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(host.owner));
            } else if (path === "/s1/events") {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              res.write(": connected\n\n");
              clients.add(res);
              req.on("close", () => clients.delete(res));
            } else if (path === "/s1/dialog") {
              let body = "";
              for await (const chunk of req) body += chunk;
              const answer = JSON.parse(body);
              const result = host.dialog.answer(
                answer.dialogId,
                answer.answers,
                { listener: "loopback", ip: "127.0.0.1", reqId: "browser-remote-answer" },
                "browser-approval",
                answer.epoch,
              );
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } else if (path === "/s1/command") {
              try {
                let body = "";
                for await (const chunk of req) {
                  body += chunk;
                  if (body.length > 32768) throw Error("request too large");
                }
                const command = JSON.parse(body);
                if (command.op === "abort" && abortBarrier) {
                  abortArrived = true;
                  await abortBarrier;
                }
                const result = await host.request(command);
                if (command.op === "abort" && ackBarrier) await ackBarrier;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(result));
              } catch (error) {
                res.statusCode = 500;
                res.end(String(error));
              }
            } else next();
          });
        },
      },
    ],
    resolve: {
      alias: {
        "@logic": `${root}/src/web-hub/ui/src/logic`,
        "@protocol": `${root}/src/web-hub/protocol`,
        vue: `${root}/node_modules/vue/dist/vue.esm-bundler.js`,
      },
    },
    define: {
      __PWH_UI_BUILD__: JSON.stringify({
        version: "s1-probe",
        proto: { major: 1 },
        commit: "isolated",
        builtAt: "2026-11-08T00:00:00Z",
      }),
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, dir] } },
  });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/s1`;
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw Error(`timeout: ${label}`);
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 10);
        timer.unref();
      });
    }
  };
  try {
    for (const history of [false, true])
      for (const scenario of ["waiting", "queued", "late-abort", "observed-abort", "unknown", "deadline"] as const) {
        host.dispose();
        host = await createMemoryWebHost("buffered");
        connect();
        abortBarrier = undefined;
        abortRelease = undefined;
        abortArrived = false;
        if (scenario === "queued") host.holdCommit();
        if (scenario === "late-abort")
          abortBarrier = new Promise<void>((r) => {
            abortRelease = r;
          });
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page: any = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e: unknown) => errors.push(String(e)));
        page.on("console", (m: any) => {
          if (m.type() === "error") errors.push(m.text());
        });
        page.on("requestfailed", (r: any) => errors.push(r.url() + ":" + r.failure()?.errorText));
        await page.goto(`${url}?history=${history ? 1 : 0}`, { waitUntil: "networkidle" });
        try {
          await page.locator("textarea").fill(`/mem session add S1 ${scenario} exact body`, { timeout: 10000 });
        } catch (error) {
          console.error({
            errors,
            dom: await page.locator("body").innerText(),
            fixture: await page.evaluate(() => ({
              exists: !!(globalThis as any).memoryFixture,
              owner: (globalThis as any).memoryFixture?.card,
              keys: [...((globalThis as any).memoryFixture?.hub.state.value.agents.keys() ?? [])],
            })),
          });
          throw error;
        }
        await page.locator("textarea").press("Enter");
        const stop = page.getByRole("button", { name: "停止本会话（尝试撤销记忆写入）", exact: true });
        await stop.waitFor({ state: "visible" });
        assert.equal(await stop.isEnabled(), true);
        assert.equal(host.ctx.isIdle(), true);
        await until(() => host.dialog.frame().open.length === 1, "actual remote confirmation");
        const approve = async () => {
          await page.getByRole("radio", { name: /确认执行/ }).check();
          await page.locator("[data-submit]").click();
        };
        // Use the independently observed server dispatch, NOT the DOM, to select the ledger row.
        const id = host.trace.find((entry) => entry.event === "dispatch")?.id;
        assert.equal(typeof id, "string");
        if (typeof id !== "string") throw Error("missing real command dispatch id");
        const captureCommandIdentity = async (phase: "running" | "rejected" | "completed" | "unknown") => {
          const row = host.ledger.get(id);
          assert.ok(row, `${scenario}/${phase}: real ledger row must exist`);
          assert.equal(row.op, "command");
          const card = page.locator(".memory-command[data-cmd-id]");
          assert.equal(await card.count(), 1);
          // Re-read BOTH attributes at this phase; never reuse the initial DOM sample.
          const domCmdId = await card.getAttribute("data-cmd-id");
          const domPhase = await card.getAttribute("data-memory-phase");
          assert.equal(domPhase, phase);
          assert.equal(domCmdId, row.id, `${scenario}/${phase}: DOM command id != real ledger id`);
          assert.equal(row.id, id);
          assert.equal(row.state, phase === "running" ? "running" : phase === "completed" ? "ok" : "failed");
          return {
            phase,
            domPhase,
            domCmdId,
            ledgerCmdId: row.id,
            ledgerState: row.state,
            capturedAt: new Date().toISOString(),
          };
        };
        const commandIdentity = [await captureCommandIdentity("running")];
        assert.equal(host.ledger.query(id)?.state, "running");
        const runningDom = await page.locator("body").innerText();
        assert.match(runningDom, /会话级停止/);
        assert.match(runningDom, /已完成写入不能撤回/);
        const prefix = `/tmp/65-pkg4-s1-${scenario}-${history ? "history-on" : "history-off"}`;
        await page.screenshot({ path: `${prefix}-running.png`, fullPage: true });
        if (scenario === "queued") {
          await approve();
          await until(() => host.trace.some((e) => e.event === "commit-enqueued"), "commit barrier");
          assert.equal(await stop.isEnabled(), true);
          await stop.click();
          await until(() => host.trace.some((e) => e.event === "cancel-observed"), "server cancel linearized");
          host.releaseCommit();
        } else if (scenario === "late-abort") {
          await stop.dblclick();
          await until(() => abortArrived, "abort arrived at delayed transport boundary");
          assert.equal(await stop.isEnabled(), false);
          assert.equal(
            host.trace.some((e) => e.event === "handleAbort-enter"),
            false,
          );
          await approve();
          await until(
            () => host.evidence().appendCount === 1 && host.ledger.query(id)?.state === "ok",
            "SDK completed before abort handling",
          );
          abortRelease!();
          await until(() => host.trace.some((e) => e.event === "handleAbort-enter"), "late abort handled");
        } else if (scenario === "observed-abort") {
          host.onObserved(() => {
            void host.request({ id: `observed-${id}`, op: "abort" });
          });
          await approve();
        } else if (scenario === "unknown") {
          host.onAppend(() => {
            void host.request({ id: `reentrant-${id}`, op: "abort" });
          });
          await approve();
        } else if (scenario === "deadline") {
          host.advance(29 * 60000 - 1);
          assert.equal(host.ledger.query(id)?.state, "running");
          host.advance(1);
        } else await stop.click();
        const expected = ["late-abort", "observed-abort"].includes(scenario)
          ? "completed"
          : scenario === "unknown"
            ? "unknown"
            : "rejected";
        await page.waitForFunction(
          (phase: string) =>
            (globalThis as any).document.querySelector(".memory-command")?.getAttribute("data-memory-phase") === phase,
          expected,
        );
        commandIdentity.push(await captureCommandIdentity(expected));
        const dom = await page.locator("body").innerText();
        const evidence = host.evidence();
        const ledger = host.ledger.query(id);
        assert.equal(ledger?.state, expected === "completed" ? "ok" : "failed");
        if (expected === "completed") {
          assert.equal(evidence.appendCount, 1);
          assert.equal(evidence.plannedHash, evidence.observedHash);
          assert.equal(evidence.poisoned, false);
          assert.equal(await page.locator("[data-memory-id]").innerText(), (ledger?.result as any).data.memoryWrite.id);
          assert.equal((ledger?.result as any).data.memoryWrite.id, "n1");
          assert.equal((ledger?.result as any).data.memoryWrite.rev, evidence.fold.items[0]?.rev);
          assert.equal((ledger?.result as any).data.memoryWrite.persistence, "appended");
          assert.match(dom, /无法撤回/);
          assert.match(dom, /首次 conversation flush/);
        } else if (expected === "unknown") {
          assert.equal(evidence.appendCount, 1);
          assert.match(dom, /未知/);
          assert.doesNotMatch(dom, /写入已完成/);
          assert.equal(ledger?.result?.ok, false);
          assert.equal((ledger?.result as any).effect, "unknown");
        } else {
          assert.equal(evidence.appendCount, 0);
          assert.match(dom, /本步未执行/);
          assert.equal((ledger?.result as any).retryable, false);
          assert.equal((ledger?.result as any).effect, "none");
        }
        assert.equal(await stop.count(), 0);
        assert.equal(evidence.nativeCalls, 0);
        assert.equal(evidence.modelCalls, 0);
        const events = evidence.trace.map((e) => e.event);
        assert.equal(events.filter((e) => e === "release").length, 1);
        assert.equal(events.filter((e) => e === "cmd_late").length, 1);
        if (["waiting", "queued", "observed-abort", "unknown", "deadline"].includes(scenario)) {
          assert.ok(events.indexOf("cancel-observed") >= 0);
          assert.ok(events.indexOf("cancel-observed") < events.indexOf("release"));
        }
        assert.deepEqual(errors, []);
        const requests = await page.evaluate(() => (globalThis as any).memoryFixture.calls);
        assert.equal(requests.filter((r: any) => r.op === "command" && !r.queryOnly).length, 1);
        assert.ok(requests.some((r: any) => r.queryOnly && r.id === id));
        await page.screenshot({ path: `${prefix}-${expected}.png`, fullPage: true });
        writeFileSync(`${prefix}-dom.txt`, dom);
        const result = {
          ...run,
          caseName: `${history ? "history-on" : "history-off"}/${scenario}`,
          capturedAt: new Date().toISOString(),
          history,
          scenario,
          phase: expected,
          id,
          commandIdentity,
          ledger,
          evidence,
          requests,
          dom,
          screenshot: `${prefix}-${expected}.png`,
          runningScreenshot: `${prefix}-running.png`,
          errors,
        };
        results.push(result);
        console.log(JSON.stringify(result));
        await context.close();
      }

    // Lifecycle/UI identity matrix, still backed by the same real HTTP + SDK host.
    for (const history of [false, true])
      for (const scenario of [
        "dismiss",
        "permission",
        "session",
        "epoch",
        "replace",
        "offline",
        "busy",
        "refresh",
      ] as const) {
        host.dispose();
        host = await createMemoryWebHost("buffered");
        connect();
        abortBarrier = undefined;
        ackBarrier = undefined;
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page: any = await context.newPage();
        await page.goto(`${url}?history=${history ? 1 : 0}`, { waitUntil: "networkidle" });
        await page.locator("textarea").fill(`/mem session add identity ${scenario}`);
        await page.locator("textarea").press("Enter");
        const stop = page.locator(".memory-stop");
        await stop.waitFor({ state: "visible" });
        await until(() => host.dialog.frame().open.length === 1, "identity actual confirmation");
        const id = await page.locator(".memory-command").getAttribute("data-cmd-id");
        const approve = async () => {
          await page.getByRole("radio", { name: /确认执行/ }).check();
          await page.locator("[data-submit]").click();
        };
        let oldEvidence: unknown;
        if (scenario === "dismiss") {
          await page.locator(".memory-dismiss").click();
          assert.equal(host.ledger.query(id)?.state, "running");
          assert.equal(
            host.trace.some((e) => e.event === "handleAbort-enter"),
            false,
          );
          assert.equal(await stop.isEnabled(), true);
          await approve();
          await until(() => host.ledger.query(id)?.state === "ok", "hidden write completes normally");
          await page.waitForFunction(() => !(globalThis as any).document.querySelector(".memory-command"));
          assert.equal(host.evidence().appendCount, 1);
        } else if (scenario === "busy") {
          host.holdModel();
          const turn = host.session.prompt("offline model starts after memory confirmation opened");
          try {
            await until(() => !host.ctx.isIdle(), "actual SDK model busy");
            host.publish("status", {
              agentKey: host.owner.agentKey,
              status: { busy: !host.ctx.isIdle(), pending: host.ctx.hasPendingMessages() },
            });
            await page.waitForFunction(() => !(globalThis as any).document.querySelector(".memory-stop"));
            assert.match(await page.locator(".memory-command").innerText(), /会话级停止/);
            assert.match(await page.locator(".memory-command").innerText(), /同时中止当前模型任务/);
            await host.request({ id: `busy-abort-${id}`, op: "abort", expect: { sessionId: host.owner.sessionId } });
          } finally {
            host.releaseModel();
            await turn.catch(() => {});
          }
          await until(() => host.ledger.query(id)?.state === "failed", "busy cancel settles memory");
          assert.equal(host.evidence().appendCount, 0);
        } else if (scenario === "refresh") {
          const before = host.trace.filter((e) => e.event === "dispatch").length;
          await page.reload({ waitUntil: "networkidle" });
          assert.equal(await page.locator(".memory-command").count(), 0);
          assert.equal(host.ledger.query(id)?.state, "running");
          assert.equal(host.trace.filter((e) => e.event === "dispatch").length, before);
          assert.equal(
            host.trace.some((e) => e.event === "handleAbort-enter"),
            false,
          );
          assert.equal(host.evidence().appendCount, 0);
        } else if (scenario === "permission") {
          const card = await page.evaluate(() => {
            (globalThis as any).permissionStop = (globalThis as any).document.querySelector(".memory-stop");
            return (globalThis as any).memoryFixture.card;
          });
          host.setControl(false);
          host.publish("agent_up", { ...card, control: false });
          await page.waitForFunction(
            () =>
              !(globalThis as any).document.querySelector(".memory-stop") ||
              (globalThis as any).document.querySelector(".memory-stop")?.disabled === true,
          );
          await page.evaluate(() => (globalThis as any).permissionStop.click());
          assert.equal(
            host.trace.some((e) => e.event === "handleAbort-enter"),
            false,
          );
          host.setControl(true);
          host.publish("agent_up", card);
          host.publish("status", { agentKey: card.agentKey, status: card.status });
          await page.waitForFunction(
            () => (globalThis as any).document.querySelector(".memory-stop")?.disabled === false,
          );
          await stop.click();
          await page.waitForFunction(
            () =>
              (globalThis as any).document.querySelector(".memory-command")?.getAttribute("data-memory-phase") ===
              "rejected",
          );
          assert.equal(host.evidence().appendCount, 0);
        } else if (scenario === "replace") {
          ackBarrier = new Promise<void>((r) => {
            ackRelease = r;
          });
          await stop.click();
          await until(() => host.ledger.query(id)?.state === "failed", "old operation stopped before delayed ACK");
          await page.waitForFunction(
            () =>
              (globalThis as any).document.querySelector(".memory-command")?.getAttribute("data-memory-phase") ===
              "rejected",
          );
          await page.locator("textarea").fill("/mem session add replacement operation B");
          await page.locator("textarea").press("Enter");
          await until(() => host.dialog.frame().open.length === 1, "new operation confirmation");
          const nextId = await page.locator(".memory-command").getAttribute("data-cmd-id");
          assert.notEqual(nextId, id);
          await approve();
          await page.waitForFunction(
            () =>
              (globalThis as any).document.querySelector(".memory-command")?.getAttribute("data-memory-phase") ===
              "completed",
          );
          ackRelease!();
          ackBarrier = undefined;
          await page.waitForLoadState("networkidle");
          assert.equal(await page.locator(".memory-command").getAttribute("data-cmd-id"), nextId);
          assert.equal(
            await page.locator("[data-memory-id]").innerText(),
            (host.ledger.query(nextId)?.result as any).data.memoryWrite.id,
          );
          assert.equal(host.evidence().appendCount, 1);
        } else if (scenario === "offline") {
          await page.route("**/s1/command", (route: any) => route.abort("internetdisconnected"));
          await stop.click();
          await page.waitForFunction(() => (globalThis as any).memoryFixture.calls.some((r: any) => r.op === "abort"));
          assert.equal(
            host.trace.some((e) => e.event === "handleAbort-enter"),
            false,
          );
          // Query the original id while offline: failure must stay unknown, never none/success.
          await page.evaluate(() => {
            const f = (globalThis as any).memoryFixture;
            const r = f.calls.find((x: any) => x.op === "command");
            f.hub.control.requestMemoryQuery(
              f.hub.state.value.agents
                .get(f.card.agentKey)
                .pendingCtl.find((x: any) => x.cmdId === r.id || x.id === r.id).memoryUiKey,
            );
          });
          await page.waitForFunction(
            () =>
              (globalThis as any).document.querySelector(".memory-command")?.getAttribute("data-memory-phase") ===
              "unknown",
          );
          assert.equal(host.ledger.query(id)?.state, "running");
          await page.unroute("**/s1/command");
          const calls = await page.evaluate(() => (globalThis as any).memoryFixture.calls);
          assert.equal(calls.filter((r: any) => r.op === "abort" && !r.queryOnly).length, 1);
          assert.equal(calls.filter((r: any) => r.op === "command" && !r.queryOnly).length, 1);
          await approve();
          await until(() => host.ledger.query(id)?.state === "ok", "server completion after network recovery");
          await page.waitForFunction(
            () =>
              (globalThis as any).document.querySelector(".memory-command")?.getAttribute("data-memory-phase") ===
              "completed",
          );
          assert.equal(host.evidence().appendCount, 1);
        } else {
          // A real SDK session/activation replacement supplies the new identity; no fabricated ctx.
          const old = host;
          const card = await page.evaluate(() => {
            (globalThis as any).oldMemoryStop = (globalThis as any).document.querySelector(".memory-stop");
            return (globalThis as any).memoryFixture.card;
          });
          old.dispose();
          oldEvidence = old.evidence();
          host = await createMemoryWebHost("buffered");
          connect();
          if (scenario === "session")
            host.publish("session", {
              agentKey: card.agentKey,
              session: { ...card.session, sessionId: host.owner.sessionId },
            });
          else host.publish("agent_up", { ...card, epoch: host.owner.epoch });
          await page.waitForFunction(() => !(globalThis as any).document.querySelector(".memory-stop"));
          await page.evaluate(() => (globalThis as any).oldMemoryStop.click());
          await page.waitForLoadState("networkidle");
          assert.equal(
            host.trace.some((e) => e.event === "handleAbort-enter"),
            false,
          );
          assert.equal((oldEvidence as any).appendCount, 0);
          assert.equal(host.evidence().appendCount, 0);
        }
        const dom = await page.locator("body").innerText();
        const path = `/tmp/65-pkg4-s1-${scenario}-history-${history ? "on" : "off"}`;
        await page.screenshot({ path: `${path}.png`, fullPage: true });
        writeFileSync(`${path}-dom.txt`, dom);
        const requests = await page.evaluate(() => (globalThis as any).memoryFixture.calls);
        const result = {
          ...run,
          caseName: `${history ? "history-on" : "history-off"}/${scenario}`,
          capturedAt: new Date().toISOString(),
          history,
          scenario,
          id,
          dom,
          screenshot: `${path}.png`,
          requests,
          evidence: host.evidence(),
          oldEvidence,
        };
        results.push(result);
        console.log(JSON.stringify(result));
        await context.close();
      }
    // Coverage gate: all four states must have freshly captured exact command identity evidence.
    const commandIdComparisons = results.flatMap((result) => {
      const row = result as {
        history: boolean;
        scenario: string;
        caseName: string;
        commandIdentity?: {
          phase: "running" | "rejected" | "completed" | "unknown";
          domPhase: string;
          domCmdId: string;
          ledgerCmdId: string;
          ledgerState: string;
          capturedAt: string;
        }[];
      };
      return (row.commandIdentity ?? []).map((sample) => ({
        ...run,
        caseName: row.caseName,
        history: row.history,
        scenario: row.scenario,
        ...sample,
      }));
    });
    assert.deepEqual([...new Set(commandIdComparisons.map((row) => row.phase))].sort(), [
      "completed",
      "rejected",
      "running",
      "unknown",
    ]);
    writeFileSync("/tmp/65-pkg4-s1-command-ids.json", JSON.stringify(commandIdComparisons, null, 2));
    console.log(JSON.stringify({ ...run, assertion: "four-state exact DOM/ledger command ids", commandIdComparisons }));
    writeFileSync("/tmp/65-pkg4-s1-evidence.json", JSON.stringify(results, null, 2));
    console.log(
      JSON.stringify({
        event: "s1_run_complete",
        ...run,
        finishedAt: new Date().toISOString(),
        caseCount: results.length,
        commandIdentityCount: commandIdComparisons.length,
        groups: results.map((result) => (result as { caseName: string }).caseName),
      }),
    );
    console.log(
      `S1 PASS: ${results.length} real-browser/SDK scenarios; commands/cancel/ledger/DOM and identity/scope/hide coverage.`,
    );
  } finally {
    abortRelease?.();
    ackRelease?.();
    host.releaseCommit();
    off?.();
    for (const client of clients) client.end();
    await browser.close();
    await server.close();
    host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
