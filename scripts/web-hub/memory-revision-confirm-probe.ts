/** I1 production revision loop in an isolated real browser + SDK/HTTP/SSE.
 * No real Hub/user data/provider/auth. Exit 2 is unavailable, NEVER PASS.
 * Optional PI_TOOLKIT_I1_PLAYWRIGHT_ENTRY / PI_TOOLKIT_I1_BROWSER_EXECUTABLE
 * select ALREADY PRESENT offline assets; no install/download/config mutation. */
import assert from "node:assert/strict";
import fs, { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { loadPlaywright } from "./lib/playwright.js";
import { createRevisionWebHost } from "../../tests/integration/memory-revision-web-harness.js";
import { parseMemoryCommandFacts } from "../../src/web-hub/protocol/memory-command-facts.js";

async function main() {
  const previousOffline = process.env.npm_config_offline;
  process.env.npm_config_offline = "true";
  let browser: any;
  let lastPage: any;
  try {
    const entry = process.env.PI_TOOLKIT_I1_PLAYWRIGHT_ENTRY;
    const executablePath = process.env.PI_TOOLKIT_I1_BROWSER_EXECUTABLE;
    if (entry || executablePath) {
      if (!entry || !executablePath || !existsSync(entry) || !existsSync(executablePath))
        throw Error("offline assets missing");
      const pw = await import(pathToFileURL(entry).href);
      browser = await (pw.chromium ?? pw.default.chromium).launch({
        headless: true,
        executablePath,
        args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
      });
    } else {
      const pw = await loadPlaywright();
      if (!pw.ok || pw.source !== "offline") throw Error(pw.ok ? "online loader disallowed" : pw.reason);
      browser = await pw.chromium.launch({ headless: true });
    }
  } catch (error) {
    console.error(`I1 BROWSER UNAVAILABLE: ${String(error)}`);
    process.exitCode = 2;
    return;
  } finally {
    if (previousOffline === undefined) delete process.env.npm_config_offline;
    else process.env.npm_config_offline = previousOffline;
  }
  const root = resolve("."),
    temp = mkdtempSync(join(tmpdir(), "memory-i1-browser-"));
  const entry = join(temp, "entry.ts");
  let host: Awaited<ReturnType<typeof createRevisionWebHost>> | undefined;
  let mode: "ctl-first" | "late-first" | "silent" = "ctl-first";
  let dropAck = false,
    savedCtl: unknown,
    off: (() => void) | undefined;
  let queryHold: Promise<void> | undefined, releaseQuery: (() => void) | undefined;
  const clients = new Set<import("node:http").ServerResponse>();
  const send = (event: string, data: unknown) => {
    for (const res of clients) res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
  };
  const connect = () => {
    off?.();
    savedCtl = undefined;
    off = host!.listen((event, data: any) => {
      const terminal =
        event === "ctl" &&
        data.items.some((row: any) => ["failed", "late_failed", "ok", "late_ok"].includes(row.state));
      if (mode === "silent" && (terminal || event === "cmd_late")) return;
      if (mode === "late-first" && terminal) {
        savedCtl = data;
        return;
      }
      send(event, data);
      if (event === "cmd_late") {
        send(event, data); // actual duplicate frame, never a second execution
        if (savedCtl) {
          send("ctl", savedCtl);
          send("ctl", savedCtl);
          savedCtl = undefined;
        }
      }
    });
  };
  writeFileSync(
    entry,
    `
import {createApp,h,shallowRef} from 'vue';
import AskUserForm from '/@fs${root}/src/web-hub/ui/src/components/dialog/AskUserForm.vue';
import MemoryCommandFixture from '/@fs${root}/tests/web-hub/ui/fixtures/MemoryCommandFixture.vue';
import {createMemoryCommandFixture} from '/@fs${root}/tests/web-hub/ui/fixtures/memory-command.ts';
import {setLangOverride} from '/@fs${root}/src/web-hub/ui/src/composables/useI18n.ts';
import '/@fs${root}/src/web-hub/ui/src/styles/tokens.css';
import '/@fs${root}/src/web-hub/ui/src/styles/base.css';
import '/@fs${root}/src/web-hub/ui/src/styles/control.css';
import '/@fs${root}/src/web-hub/ui/src/styles/dock.css';
setLangOverride('zh',null);
const owner=await(await fetch('/i1/owner')).json();
const fixture=createMemoryCommandFixture({owner,history:new URLSearchParams(location.search).get('history')==='1',command:async req=>(await fetch('/i1/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req)})).json()});
const dialogs=shallowRef([]),source=new EventSource('/i1/events');
source.onmessage=e=>{const m=JSON.parse(e.data);fixture.emit(m.event,m.data);if(m.event==='dialogs')dialogs.value=m.data.open;};
window.memoryFixture=fixture;
createApp({render:()=>h('main',[h(MemoryCommandFixture,{fixture}),...dialogs.value.map(d=>h(AskUserForm,{key:d.dialogId,dialog:d,onAnswer:answers=>fetch('/i1/dialog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dialogId:d.dialogId,epoch:owner.epoch,answers})})}))])}).mount('#app');
`,
  );
  const server = await createServer({
    configFile: false,
    root,
    plugins: [
      vue(),
      {
        name: "i1-isolated-http-sse",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const path = req.url?.split("?")[0];
            if (path === "/i1") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  "/i1",
                  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><div id="app"></div><script type="module" src="/@fs${entry}"></script></body></html>`,
                ),
              );
            } else if (path === "/i1/owner") {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(host!.owner));
            } else if (path === "/i1/events") {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              res.write(": owned local stream\n\n");
              clients.add(res);
              req.on("close", () => clients.delete(res));
            } else if (path === "/i1/command" || path === "/i1/dialog") {
              try {
                let body = "";
                for await (const chunk of req) {
                  body += chunk;
                  if (Buffer.byteLength(body) > 32768) throw Error("bounded request");
                }
                const data = JSON.parse(body);
                const result =
                  path === "/i1/dialog"
                    ? host!.dialog.answer(
                        data.dialogId,
                        data.answers,
                        { listener: "loopback", ip: "127.0.0.1", reqId: "i1-local-browser" },
                        "i1-browser-answer",
                        data.epoch,
                      )
                    : await host!.request(data);
                if (path === "/i1/command" && data.queryOnly && queryHold) await queryHold;
                if (path === "/i1/command" && dropAck && !data.queryOnly) {
                  res.destroy();
                  return;
                }
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
        version: "i1-probe",
        proto: { major: 1 },
        commit: "isolated",
        builtAt: "2026-11-10T00:00:00Z",
      }),
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } },
  });
  await server.listen();
  const port = (server.httpServer!.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/i1`;
  const results: unknown[] = [];
  const originalRename = fs.renameSync;
  const restoreRename = () => {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  };
  const until = async (test: () => boolean, label: string) => {
    const deadline = Date.now() + 10000;
    while (!test() && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 10));
    assert(test(), `timed out: ${label}`);
  };
  try {
    for (const history of [false, true])
      for (const order of ["ctl-first", "late-first"] as const)
        for (const wantedEffect of ["partial", "unknown"] as const) {
          restoreRename();
          await host?.dispose();
          host = await createRevisionWebHost({ history, recordFailure: history });
          mode = order;
          dropAck = false;
          connect();
          const rows = await host.seed(),
            before = rows.map((row) => host!.raw(row.revision!.targetId));
          const executionWait = history && order === "late-first" && wantedEffect === "partial";
          if (executionWait) host.holdCompletion();
          if (wantedEffect === "unknown") {
            const ownedTargets = new Set(rows.map((row) => join(host!.dir, "blocks", `${row.revision!.targetId}.md`)));
            let attempts = 0;
            fs.renameSync = (from, to) => {
              originalRename(from, to);
              if (ownedTargets.has(String(to)) && ++attempts === 2) throw Error("owned post-rename opaque I/O failure");
            };
            syncBuiltinESMExports();
          }
          if (history) {
            assert.equal(host.recordFaultProbe(), false);
            assert(host.evidence().recordAttempts > 0);
          }
          const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
          const page: any = await context.newPage();
          lastPage = page;
          const errors: string[] = [];
          page.on("pageerror", (e: unknown) => errors.push(String(e)));
          // Block any browser network outside this owned HTTP endpoint.
          await page.route("**/*", (route: any) =>
            new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort(),
          );
          await page.goto(`${url}?history=${Number(history)}`);
          const identities: unknown[] = [];
          const capture = async (phase: string) => {
            const card = page.locator(".memory-command");
            await card.waitFor();
            const id = await card.getAttribute("data-cmd-id");
            await until(() => host!.ledger.get(id) !== undefined, "DOM id admitted into actual ledger");
            const row = host!.ledger.get(id)!;
            assert(row, "DOM id must identify an actual ledger row");
            const domPhase = await card.getAttribute("data-memory-phase");
            assert.equal(domPhase, phase);
            assert.equal(id, row.id);
            const sample = { phase, domPhase, domCmdId: id, ledgerCmdId: row.id, ledgerState: row.state };
            identities.push(sample);
            return id;
          };
          const sendCommand = async (bytes?: number[]) => {
            await page.evaluate((bytes: number[] | undefined) => {
              const crypto = globalThis.crypto,
                original = crypto.getRandomValues.bind(crypto);
              crypto.getRandomValues = ((a: Uint8Array) => {
                crypto.getRandomValues = original;
                if (bytes) a.set(bytes);
                else original(a);
                (globalThis as any).i1Bytes = [...a];
                return a;
              }) as typeof crypto.getRandomValues;
            }, bytes);
            await page.locator("textarea").fill("/mem review");
            await page.locator("textarea").press("Enter");
          };
          await sendCommand();
          const id = await capture("running");
          const bytes = await page.evaluate(() => (globalThis as any).i1Bytes);
          let confirms = 0,
            actualWaitMs = 0;
          const answered = new Set<string>();
          const flowDeadline = Date.now() + 120_000;
          while (host.ledger.query(id)?.state === "running" && Date.now() < flowDeadline) {
            await until(
              () =>
                host!.ledger.query(id)?.state !== "running" ||
                !!host!.dialog.frame().open[0] ||
                (executionWait && host!.completionObserved()),
              "flow dialog or terminal",
            );
            if (executionWait && host.completionObserved()) {
              const began = performance.now();
              await new Promise<void>((r) => setTimeout(r, 31_050));
              actualWaitMs = performance.now() - began;
              assert(actualWaitMs > 30_000);
              await capture("running");
              host.releaseCompletion();
              await until(() => host!.ledger.query(id)?.state !== "running", "observed completion released");
              break;
            }
            const d = host.dialog.frame().open[0];
            if (!d) break;
            if (answered.has(d.dialogId)) {
              await new Promise<void>((r) => setTimeout(r, 5));
              continue;
            }
            answered.add(d.dialogId);
            const q = d.questions[0]!,
              labels = q.options.map((o) => o.label);
            const isConfirm = q.header === "MEMCMD";
            let value = labels.includes("apply") ? "apply" : labels.includes("continue") ? "continue" : "next";
            if (isConfirm) {
              confirms++;
              if (!history && order === "ctl-first" && wantedEffect === "partial" && confirms === 1) {
                const began = performance.now();
                await new Promise<void>((r) => setTimeout(r, 31_050));
                actualWaitMs = performance.now() - began;
                assert(actualWaitMs > 30_000);
                await capture("running");
              }
              value = q.options[confirms === 2 && wantedEffect === "partial" ? 0 : 1]!.label;
            }
            await page.getByRole("radio", { name: value, exact: true }).check();
            await page.locator("[data-submit]").click();
          }
          await page
            .locator(`.memory-flow-facts[data-memory-flow-effect="${wantedEffect}"]`)
            .waitFor({ timeout: 10000 });
          await capture(wantedEffect);
          assert.equal(confirms, 2);
          assert.equal(
            rows.filter((row, i) => !host!.raw(row.revision!.targetId).equals(before[i]!)).length,
            wantedEffect === "partial" ? 1 : 2,
          );
          const stored = host.ledger.query(id)!.result!;
          assert(!stored.ok && stored.message);
          const facts = parseMemoryCommandFacts(stored.message, id);
          assert.equal(facts.kind, "facts");
          if (facts.kind !== "facts") throw Error("real facts unavailable");
          assert.equal(facts.facts.effect, wantedEffect);
          const snapshot = async () => page.locator(".memory-flow-facts").innerText();
          const lateDom = await snapshot();
          assert.match(lateDom, wantedEffect === "partial" ? /部分成功/ : /效果不确定/);
          assert.match(lateDom, /completed/);
          assert(facts.facts.rows[1]?.code && lateDom.includes(facts.facts.rows[1].code));
          assert(!(await page.locator(".memory-command").innerText()).includes("[pi-memory-result:v1]"));
          const starts = host.evidence().starts;
          // Same exact real partial sample, DIRECT duplicate result on a fresh production UI.
          mode = "silent";
          await page.goto(`${url}?history=${Number(history)}`);
          await sendCommand(bytes);
          await page.locator(`.memory-flow-facts[data-memory-flow-effect="${wantedEffect}"]`).waitFor();
          await capture(wantedEffect);
          const directDom = await snapshot();
          assert.equal(directDom, lateDom);
          // Lose only the duplicate HTTP ACK; manual queryOnly recovers the original
          // real ledger body. No response stub and no new cmdId/effect/confirmation.
          dropAck = true;
          queryHold = new Promise<void>((resolve) => {
            releaseQuery = resolve;
          });
          await page.goto(`${url}?history=${Number(history)}`);
          await sendCommand(bytes);
          await page.locator('.memory-command[data-memory-phase="unknown"]').waitFor();
          await capture("unknown");
          dropAck = false;
          // Production's one bounded automatic query may start immediately on
          // network loss. Hold only its real response long enough to observe
          // unknown, then release the genuine original ledger body.
          releaseQuery?.();
          queryHold = undefined;
          releaseQuery = undefined;
          await page.locator(`.memory-flow-facts[data-memory-flow-effect="${wantedEffect}"]`).waitFor();
          await capture(wantedEffect);
          const queryDom = await snapshot();
          assert.equal(queryDom, lateDom);
          assert.equal(host.evidence().starts, starts);
          assert.equal(host.evidence().native, 0);
          assert.equal(host.evidence().sent, 0);
          assert.equal(host.dialog.frame().open.length, 0);
          assert.deepEqual(errors, []);
          const prefix = `/tmp/pi-toolkit-i1-${history ? "history-on" : "history-off"}-${order}-${wantedEffect}`;
          await page.screenshot({ path: `${prefix}.png`, fullPage: true });
          writeFileSync(`${prefix}.html`, await page.content());
          results.push({
            history,
            order,
            wantedEffect,
            executionWait,
            actualWaitMs,
            cmdId: id,
            identities,
            directDom,
            lateDom,
            queryDom,
            ledger: host.ledger.query(id),
            evidence: host.evidence(),
          });
          await context.close();
        }
    // Actual SDK owner/tree/reload boundaries: history is view/keep only,
    // with real confirmation and review CAS but no LIVE reconstruction/model/E.
    for (const boundary of ["tree", "reload", "newSession"] as const) {
      restoreRename();
      await host?.dispose();
      host = await createRevisionWebHost({ history: true });
      mode = "ctl-first";
      dropAck = false;
      connect();
      const rows = await host.seed(),
        before = rows.map((row) => host!.raw(row.revision!.targetId));
      const old = await host[boundary]();
      assert(old?.signal.aborted);
      assert.notEqual(host.scopes!.current(), old);
      const generations = host.lab.calls.filter((call) => call.kind === "generation").length;
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
      const page: any = await context.newPage();
      lastPage = page;
      await page.goto(`${url}?history=1`);
      await page.locator("textarea").fill("/mem review");
      await page.locator("textarea").press("Enter");
      await page.locator(".memory-command").waitFor();
      const id = await page.locator(".memory-command").getAttribute("data-cmd-id");
      await until(() => !!host!.ledger.get(id), "history real ledger admission");
      assert.equal(host.ledger.get(id)!.id, id);
      const answered = new Set<string>();
      let viewed = false,
        confirms = 0,
        menus = 0;
      const historyDeadline = Date.now() + 30_000;
      while (host.ledger.query(id)?.state === "running" && Date.now() < historyDeadline) {
        await until(
          () => host!.ledger.query(id)?.state !== "running" || !!host!.dialog.frame().open[0],
          "history menu or terminal",
        );
        const d = host.dialog.frame().open[0];
        if (!d) break;
        if (answered.has(d.dialogId)) {
          await new Promise<void>((r) => setTimeout(r, 5));
          continue;
        }
        answered.add(d.dialogId);
        const q = d.questions[0]!,
          labels = q.options.map((o) => o.label);
        let value: string;
        if (q.header === "MEMCMD") {
          confirms++;
          value = q.options[1]!.label;
        } else if (labels.includes("keep")) {
          menus++;
          assert(!labels.includes("apply"));
          assert(q.question.includes("history (view/keep only)"));
          assert.equal(await page.getByRole("radio", { name: "apply", exact: true }).count(), 0);
          value = viewed ? "keep" : "view";
          viewed = true;
        } else value = labels.includes("continue") ? "continue" : "next";
        await page.getByRole("radio", { name: value, exact: true }).check();
        await page.locator("[data-submit]").click();
      }
      await page.locator('.memory-command[data-memory-phase="completed"]').waitFor();
      assert.equal(await page.locator(".memory-command").getAttribute("data-cmd-id"), host.ledger.get(id)!.id);
      assert.equal(menus, 3);
      assert.equal(confirms, 2);
      assert(rows.every((row, i) => host!.raw(row.revision!.targetId).equals(before[i]!)));
      assert.equal(host.lab.calls.filter((call) => call.kind === "generation").length, generations);
      results.push({
        boundary,
        cmdId: id,
        phase: "completed",
        ledgerCmdId: host.ledger.get(id)!.id,
        ledger: host.ledger.query(id),
        dom: await page.locator(".memory-flow-facts").innerText(),
        evidence: host.evidence(),
      });
      await context.close();
    }
    for (const scenario of ["cancel-late-approve", "29min"] as const) {
      await host?.dispose();
      host = await createRevisionWebHost();
      mode = "ctl-first";
      dropAck = false;
      connect();
      const rows = await host.seed(),
        before = rows.map((row) => host!.raw(row.revision!.targetId));
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
      const page: any = await context.newPage();
      lastPage = page;
      await page.goto(url);
      await page.locator("textarea").fill("/mem review");
      await page.locator("textarea").press("Enter");
      await page.locator(".memory-command").waitFor();
      const id = await page.locator(".memory-command").getAttribute("data-cmd-id");
      await until(() => !!host!.ledger.get(id), "cancel/deadline actual admission");
      assert.equal(host.ledger.get(id)!.id, id);
      assert.equal(await page.locator(".memory-command").getAttribute("data-memory-phase"), "running");
      const answered = new Set<string>();
      let confirms = 0,
        late: ReturnType<typeof host.dialog.frame>["open"][number] | undefined;
      const confirmationDeadline = Date.now() + 30_000;
      while (!late && Date.now() < confirmationDeadline) {
        await until(() => !!host!.dialog.frame().open[0], "actual pending confirmation");
        const d = host.dialog.frame().open[0]!;
        if (answered.has(d.dialogId)) {
          await new Promise<void>((r) => setTimeout(r, 5));
          continue;
        }
        const q = d.questions[0]!,
          labels = q.options.map((o) => o.label);
        if (q.header === "MEMCMD") {
          confirms++;
          if (scenario === "29min" || confirms === 2) {
            late = d;
            break;
          }
        }
        answered.add(d.dialogId);
        const value =
          q.header === "MEMCMD"
            ? q.options[1]!.label
            : labels.includes("apply")
              ? "apply"
              : labels.includes("continue")
                ? "continue"
                : "next";
        await page.getByRole("radio", { name: value, exact: true }).check();
        await page.locator("[data-submit]").click();
      }
      assert(late, "actual pending confirmation must arrive within bounded fixture budget");
      if (scenario === "29min") host.advance(29 * 60000);
      else await page.locator(".memory-stop").click();
      const phase = scenario === "29min" ? "rejected" : "partial";
      await page.locator(`.memory-command[data-memory-phase="${phase}"]`).waitFor();
      assert.equal(await page.locator(".memory-command").getAttribute("data-cmd-id"), host.ledger.get(id)!.id);
      const answer = host.dialog.answer(
        late!.dialogId,
        [{ selected: [late!.questions[0]!.options[1]!.label], other: null }],
        { listener: "loopback", ip: "127.0.0.1", reqId: "owned-late-answer" },
        "late-answer",
        host.owner.epoch,
      );
      assert.equal(answer.ok, false);
      assert.equal(
        rows.filter((row, i) => !host!.raw(row.revision!.targetId).equals(before[i]!)).length,
        scenario === "29min" ? 0 : 1,
      );
      results.push({
        scenario,
        cmdId: id,
        phase,
        ledgerCmdId: host.ledger.get(id)!.id,
        ledger: host.ledger.query(id),
        evidence: host.evidence(),
      });
      await context.close();
    }
    writeFileSync("/tmp/pi-toolkit-i1-browser-results.json", JSON.stringify(results, null, 2));
    console.log(
      JSON.stringify({
        verdict: "PASS",
        scenarios: results.length,
        actual30sBrowserGate: true,
        report: "/tmp/pi-toolkit-i1-browser-results.json",
        limits: "isolated SDK/HTTP/SSE/component proof; NOT production Hub/auth/provider certification",
      }),
    );
  } catch (error) {
    if (lastPage) {
      writeFileSync("/tmp/pi-toolkit-i1-browser-failure.html", await lastPage.content());
      console.error(
        JSON.stringify({
          dom: await lastPage.locator("body").innerText(),
          fixture: await lastPage.evaluate(() => ({
            calls: (globalThis as any).memoryFixture?.calls,
            pending: (globalThis as any).memoryFixture?.view.agent.value.pendingCtl,
          })),
        }),
      );
      await lastPage.screenshot({ path: "/tmp/pi-toolkit-i1-browser-failure.png", fullPage: true });
    }
    throw error;
  } finally {
    releaseQuery?.();
    restoreRename();
    off?.();
    for (const client of clients) client.end();
    await host?.dispose();
    await server.close();
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
