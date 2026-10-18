import { randomUUID, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { apiFailure, failureInfo, missingScopes, ProbeError, transportFailure } from "./errors.ts";
import { renderQr } from "./qr.ts";
import { accountsBase, allowedUrl, apiBase, readCredentials, writePrivate } from "./safety.ts";
import { boundedBody, inferTimeUnit, isMessage, message, Probe, sender, Unknown } from "./runtime.ts";
import type { Connection, EventRecord, StepId, Status } from "./runtime.ts";

async function sub<T>(p: Probe, name: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (p.signal.aborted) throw error;
    const unknown = error instanceof Unknown;
    p.record(name, {
      status: unknown ? "unknown" : "fail",
      ...(unknown ? { reason: error.message } : failureInfo(error)),
    });
    if (!unknown) p.report.steps[p.current].status = "fail";
    else if (p.report.steps[p.current].status !== "fail") p.report.steps[p.current].status = "unknown";
    return undefined;
  }
}
async function approve(p: Probe, text: string): Promise<boolean> {
  const run = (await p.ask(text + " [回车继续 / s 跳过]")).toLowerCase() !== "s";
  if (!run) {
    if (p.report.steps[p.current].status !== "fail") p.report.steps[p.current].status = "unknown";
    p.record("subcheck-skipped", { status: "skipped" });
  }
  return run;
}
function owner(p: Probe, e: EventRecord): boolean {
  const c = p.needCredentials();
  return isMessage(e) && sender(e) === c.ownerOpenId && p.consistent(e);
}
async function receiveOwner(
  p: Probe,
  c: Connection,
  text: string,
  predicate = (_e: EventRecord) => true,
): Promise<EventRecord | undefined> {
  if (!(await approve(p, "准备好后回车，然后" + text))) return undefined;
  const after = Date.now();
  console.log(`${text}（等待 ${p.timeoutMs / 1000} 秒；消息内容不会写入报告）`);
  return c.next((e) => owner(p, e) && predicate(e), p.timeoutMs, after);
}
async function oneConnection<T>(p: Probe, fn: (c: Connection) => Promise<T>): Promise<T> {
  const c = await p.connect(p.current + "-A");
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}
function postMessage(p: Probe, chatId: string, type: string, content: unknown): Promise<any> {
  return p.api("/open-apis/im/v1/messages?receive_id_type=chat_id", "POST", {
    receive_id: chatId,
    msg_type: type,
    content: JSON.stringify(content),
    uuid: randomUUID(),
  });
}
export async function P1(p: Probe, reuse: boolean): Promise<void> {
  if (reuse) {
    p.credentials = await readCredentials(p.credentialDir);
    p.secrets.push(p.credentials.appSecret);
    p.record("credentials-reused", { brand: p.credentials.brand, ownerOpenId: p.credentials.ownerOpenId });
    return;
  }
  // Never silently overwrite an existing or unsafe credential file.
  let exists = false;
  try {
    await lstat(join(p.credentialDir, "credentials.json"));
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (exists) {
    await readCredentials(p.credentialDir);
    if ((await p.ask("已有凭据。保留请用 --reuse；重新注册并替换请输入 REPLACE（旧机器人不会被删除）")) !== "REPLACE")
      throw new Unknown("replacement-declined");
  }
  const brandAnswer = await p.ask("P1：选择飞书品牌：回车=中国飞书，输入 lark=国际版；s=跳过");
  if (brandAnswer === "s") throw new Unknown("user-skipped");
  let brand: "feishu" | "lark" = brandAnswer === "lark" ? "lark" : "feishu";
  const registration = (form: Record<string, string>, ms = 8000) =>
    p.request(
      accountsBase(brand) + "/oauth/v1/app/registration",
      "accounts",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      },
      64 * 1024,
      ms,
    );
  const begin = await registration({
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const b = begin.body;
  if (
    begin.status !== 200 ||
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    typeof b.device_code !== "string" ||
    !b.device_code ||
    typeof b.verification_uri_complete !== "string"
  ) {
    p.record("registration-begin-rejected", { status: begin.status, error: b?.error });
    throw begin.status >= 400
      ? new ProbeError(`http-${begin.status}`)
      : new ProbeError("protocol", "registration-begin-fields");
  }
  const deviceCode = b.device_code;
  p.secrets.push(deviceCode);
  const qr = allowedUrl(b.verification_uri_complete, "display");
  // A registration URL must not smuggle a polling credential into terminal output.
  if (
    [...qr.searchParams.keys()].some((k) => /device.?code|secret|token/i.test(k)) ||
    qr.toString().includes(deviceCode)
  )
    throw new ProbeError("protocol", "unsafe-qr-url");
  qr.searchParams.set("from", "sdk");
  qr.searchParams.set("tp", "sdk");
  qr.searchParams.set("source", "pi-toolkit");
  qr.searchParams.set("name", "pi@" + hostname());
  console.log(
    "现在打开飞书 App 扫描二维码，确认创建 PersonalAgent 应用。请勿分享此一次性链接：\n" +
      renderQr(qr.toString()) +
      "\n" +
      qr.toString(),
  );
  let interval = Math.max(1, Math.min(60, Number(b.interval) || 5));
  const expires = Date.now() + Math.max(1, Math.min(600, Number(b.expires_in ?? b.expire_in) || 600)) * 1000;
  p.record("registration-begin", { status: begin.status, interval, expires_in: (expires - Date.now()) / 1000, brand });
  let delay = interval * 1000;
  let transientFailures = 0;
  while (Date.now() < expires) {
    if (delay > 0) await p.wait(Math.min(delay, expires - Date.now()));
    if (Date.now() >= expires) break;
    let poll: { status: number; body: any };
    try {
      poll = await registration(
        { action: "poll", device_code: deviceCode },
        Math.max(1, Math.min(8000, expires - Date.now())),
      );
    } catch (error) {
      if (p.signal.aborted) throw error;
      if (!(error instanceof ProbeError) || !error.retryable || ++transientFailures > 4) throw error;
      delay = Math.max(interval * 1000, Math.min(8000, 1000 * 2 ** (transientFailures - 1)));
      p.record("registration-retry", { ...failureInfo(error), attempt: transientFailures, backoffMs: delay });
      continue;
    }
    transientFailures = 0;
    delay = interval * 1000;
    const r = poll.body;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new ProbeError("protocol", "registration-poll-body");
    // The device endpoint uses HTTP 400 for normal OAuth pending/slow_down.
    // Error/credential fields drive the state machine; status alone is not fatal.
    if (typeof r.client_secret === "string") p.secrets.push(r.client_secret);
    const success =
      typeof r.client_id === "string" && typeof r.client_secret === "string" && r.client_id && r.client_secret;
    // Brand switch first (multica registration.go): `{user_info:{tenant_brand:"lark"}}` arrives with
    // neither error nor credentials — same device code, other accounts domain, re-poll immediately.
    const tenantBrand = r.user_info?.tenant_brand;
    if (!success && (tenantBrand === "lark" || tenantBrand === "feishu") && tenantBrand !== brand) {
      brand = tenantBrand;
      p.record("registration-brand-switch", { brand });
      delay = 0;
      continue;
    }
    // Missing/empty `error` without credentials (incl. an empty `{}` body during the authorize
    // redirect window, per multica) means "keep polling", like authorization_pending.
    const noError = r.error === undefined || r.error === null || r.error === "";
    const pending =
      r.error === "authorization_pending" ||
      r.error === "slow_down" ||
      (noError && r.client_id === undefined && r.client_secret === undefined);
    if (!pending && !success) {
      p.record("registration-poll-rejected", { status: poll.status });
      if (r.error === "expired_token") throw new Unknown("registration-expired");
      if (r.error === "access_denied") throw new ProbeError("credential", "registration-access-denied");
      throw poll.status >= 400
        ? new ProbeError(`http-${poll.status}`)
        : new ProbeError("protocol", "registration-poll-fields");
    }
    if (r.error && !pending) throw new ProbeError("protocol", "registration-contradictory-fields");
    p.record("registration-poll", { status: poll.status, phase: pending ? r.error || "pending" : "credentials" });
    if (r.error === "slow_down") {
      interval = Math.min(600, interval + 5);
      delay = interval * 1000;
    }
    if (r.client_id && r.client_secret) {
      if (p.signal.aborted || Date.now() >= expires) throw new Unknown("registration-expired-or-cancelled");
      if (
        !/^cli_[\w-]+$/.test(r.client_id) ||
        typeof r.client_secret !== "string" ||
        r.client_secret.length > 512 ||
        !/^ou_[\w-]+$/.test(r.user_info?.open_id ?? "")
      )
        throw new ProbeError("credential", "registration-fields");
      const credentials = {
        v: 1 as const,
        brand,
        appId: r.client_id as string,
        appSecret: r.client_secret as string,
        ownerOpenId: r.user_info.open_id as string,
        createdAt: new Date().toISOString(),
        gen: randomUUID(),
      };
      await writePrivate("credentials.json", credentials, p.credentialDir, p.signal);
      p.credentials = credentials;
      p.record("registration-success", { brand, ownerOpenId: credentials.ownerOpenId });
      console.log("凭据已安全保存（0600），不会打印。后续运行使用 --reuse。");
      return;
    }
  }
  throw new Unknown("registration-expired");
}
export async function P2(p: Probe): Promise<void> {
  await oneConnection(p, async (c) => {
    const deadline = Date.now() + Math.min(p.timeoutMs, 30_000);
    while (!c.pongs.length && !c.closed && Date.now() < deadline) await p.wait(100);
    p.fact("V1", "pass", { connected: true, brand: p.needCredentials().brand });
    p.fact("V6", c.pongs.length ? "pass" : "unknown", {
      pingSent: c.pingCount,
      pongReceived: c.pongs.length,
      ClientConfig: c.config,
    });
    if (!c.pongs.length) p.report.steps.P2.status = "unknown";
  });
}
export async function P3(p: Probe): Promise<void> {
  const defaultAnswer = await p.ask(
    "P3：注册后是否从未修改开发者控制台的事件订阅/权限？y=默认配置 / n=已改过 / 回车=不确定",
  );
  p.record("operator-configuration", {
    defaultConfiguration: defaultAnswer === "y" ? true : defaultAnswer === "n" ? false : null,
  });
  await oneConnection(p, async (c) => {
    const e = await receiveOwner(p, c, "现在给机器人发一条私聊消息", (e) => message(e).chat_type === "p2p");
    if (!e) {
      p.fact("V2a", "unknown", { received: false, windowMs: p.timeoutMs });
      throw new Unknown("no-owner-message");
    }
    const m = message(e),
      unit = inferTimeUnit(m.create_time, e.at);
    p.fact("V2a", "pass", {
      received: true,
      defaultConfiguration: defaultAnswer === "y" ? true : defaultAnswer === "n" ? false : null,
      schema: e.envelope.schema,
      header: e.envelope.header,
      sender: e.envelope.event.sender,
      message: m,
    });
    p.fact("V10", unit === "unknown" ? "unknown" : "pass", {
      create_time: Number(m.create_time),
      receivedAtMs: e.at,
      unit,
    });
    console.log(
      "已发送 ACK {code:200}。请观察飞书侧是否正常。无重投只能证明观察窗口内未重投，不能证明服务端接受 ACK。",
    );
    const after = e.at + 1;
    const duplicate = await c.next(
      (x) => x.envelope?.header?.event_id === e.envelope?.header?.event_id,
      Math.min(10_000, p.timeoutMs),
      after,
    );
    p.fact("V6", "pass", {
      ackSent: e.ackSent,
      ackPayload: { code: 200 },
      payload_encoding: e.frame.payloadEncoding ?? "",
      duplicateWithinWindow: !!duplicate,
      ackAcceptanceProven: false,
    });
    if (unit === "unknown") p.report.steps.P3.status = "unknown";
  });
}
export async function P4(p: Probe): Promise<void> {
  if (
    !(await approve(
      p,
      "P4：将故意不 ACK 一条私聊，再断开并新建连接；可能出现重复消息。建议用 --steps P4 --reuse --timeout 300（或更长）观察重投。请确保没有生产机器人在使用此应用。",
    ))
  )
    throw new Unknown("user-skipped");
  const first = await p.connect("P4-noACK");
  first.ack = false;
  let initial: EventRecord | undefined;
  try {
    initial = await receiveOwner(
      p,
      first,
      "现在给机器人发一条用于重投测试的私聊消息",
      (e) => message(e).chat_type === "p2p",
    );
  } finally {
    first.close();
  }
  if (initial) {
    const original = initial;
    await oneConnection(p, async (c) => {
      const connectedAt = Date.now();
      console.log(`已使用全新 endpoint 建立新连接；现在不要重发消息，等待 ${p.timeoutMs / 1000} 秒观察服务端重投。`);
      const duplicate = await c.next(
        (e) =>
          e.envelope?.header?.event_id === original.envelope?.header?.event_id ||
          message(e).message_id === message(original).message_id,
        p.timeoutMs,
        original.at,
      );
      p.fact("V7", duplicate ? "pass" : "unknown", {
        phase: "redelivery",
        initialAck: original.ackSent,
        newConnection: true,
        received: !!duplicate,
        delayMs: duplicate ? duplicate.at - original.at : null,
        windowMs: p.timeoutMs,
        horizonProven: false,
        event_id: original.envelope?.header?.event_id,
      });
    });
  } else p.fact("V7", "unknown", { phase: "redelivery", reason: "no-initial-message" });
  await sub(p, "two-connections", async () => {
    if (!(await approve(p, "双连接测试：将同时打开 A/B。回车后，请连续发 5 条不同的私聊消息，不要关闭任一连接。")))
      return;
    const a = await p.connect("P4-A"),
      b = await p.connect("P4-B").catch((e) => {
        a.close();
        throw e;
      });
    const deliveries: { connection: string; message_id: string; at: number }[] = [];
    const collect = (e: EventRecord) => {
      if (owner(p, e) && deliveries.length < 100)
        deliveries.push({ connection: e.connection, message_id: message(e).message_id, at: e.at });
    };
    a.listeners.add(collect);
    b.listeners.add(collect);
    console.log(`A/B 均已连接。现在开始发 5 条私聊消息，收集 ${p.timeoutMs / 1000} 秒。`);
    try {
      await p.wait(p.timeoutMs);
    } finally {
      a.listeners.delete(collect);
      b.listeners.delete(collect);
      a.close();
      b.close();
    }
    p.fact("V7", deliveries.length ? "pass" : "unknown", {
      phase: "two-connections",
      deliveries,
      windowMs: p.timeoutMs,
      sampleCount: deliveries.length,
      randomDistributionProven: false,
    });
  });
  if (!initial) throw new Unknown("redelivery-incomplete");
}
function card(nonce: string, multi: boolean, updated = false): unknown {
  return {
    schema: "2.0",
    config: multi ? { update_multi: true } : {},
    header: { title: { tag: "plain_text", content: "pi-toolkit 租户探针" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: updated ? "PATCH 已更新" : "请点击按钮验证 card.action.trigger。此操作不会控制 pi。",
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "探针测试" },
          type: "primary",
          behaviors: [{ type: "callback", value: { n: nonce } }],
        },
      ],
    },
  };
}
export async function P5(p: Probe): Promise<void> {
  const defaultAnswer = await p.ask(
    "P5：首次卡片测试前，是否从未修改控制台回调/权限？y=默认配置 / n=已改过 / 回车=不确定",
  );
  await oneConnection(p, async (c) => {
    const e = await receiveOwner(
      p,
      c,
      "现在给机器人发一条私聊消息，以确定测试卡片的目标会话",
      (e) => message(e).chat_type === "p2p",
    );
    if (!e) throw new Unknown("no-card-target");
    const chat = message(e).chat_id;
    for (const multi of [false, true])
      await sub(p, "card-" + multi, async () => {
        const nonce = randomBytes(16).toString("base64url"),
          start = Date.now();
        const sent = await postMessage(p, chat, "interactive", card(nonce, multi));
        console.log(
          `已发送 schema-2.0 卡片（update_multi=${multi}）。现在点击刚收到的卡片按钮；等待 ${p.timeoutMs / 1000} 秒。`,
        );
        const callback = await c.next(
          (x) =>
            x.envelope?.header?.event_type === "card.action.trigger" && x.envelope?.event?.action?.value?.n === nonce,
          p.timeoutMs,
          start,
        );
        const callbackConsistent = (value: EventRecord | undefined): boolean =>
          !!value &&
          p.consistent(value) &&
          value.envelope?.event?.operator?.open_id === p.needCredentials().ownerOpenId &&
          value.envelope?.event?.context?.open_chat_id === chat &&
          value.envelope?.event?.context?.open_message_id === sent.message_id;
        const consistent = callbackConsistent(callback);
        p.fact("V2b", callback ? (consistent ? "pass" : "fail") : "unknown", {
          received: !!callback,
          defaultConfiguration: defaultAnswer === "y" ? true : defaultAnswer === "n" ? false : null,
          consistent,
          update_multi: multi,
          ackSent: callback?.ackSent ?? false,
          ackPayload: callback ? { code: 200 } : null,
          envelope: callback?.envelope,
        });
        if (!callback) {
          const changed = await p.ask(
            "未收到回调。请检查飞书开发者控制台：事件与回调→回调配置→card.action.trigger。若现在修改：1=添加此回调，2=发布应用版本/权限，3=其他；回车=未改，s=跳过 PATCH。不要在此输入任何凭据。",
          );
          const consoleSwitch =
            changed === "1"
              ? "card.action.trigger"
              : changed === "2"
                ? "publish-version-scopes"
                : changed === "3"
                  ? "other"
                  : "none";
          p.record("callback-console-switch", { changed: ["1", "2", "3"].includes(changed), consoleSwitch });
          if (changed === "s") {
            p.report.steps.P5.status = "unknown";
            return;
          }
          if (["1", "2", "3"].includes(changed)) {
            const retryStart = Date.now();
            console.log(`现在再次点击同一张卡片的按钮（等待 ${p.timeoutMs / 1000} 秒）。`);
            const retried = await c.next(
              (x) =>
                x.envelope?.header?.event_type === "card.action.trigger" &&
                x.envelope?.event?.action?.value?.n === nonce,
              p.timeoutMs,
              retryStart,
            );
            p.fact("V2b", retried ? (callbackConsistent(retried) ? "pass" : "fail") : "unknown", {
              phase: "after-console-change",
              consistent: callbackConsistent(retried),
              consoleSwitch,
              defaultCallbacks: false,
              received: !!retried,
              ackSent: retried?.ackSent ?? false,
              envelope: retried?.envelope,
            });
          }
        }
        try {
          const patched = await p.api("/open-apis/im/v1/messages/" + encodeURIComponent(sent.message_id), "PATCH", {
            content: JSON.stringify(card(nonce, multi, true)),
          });
          p.fact("V5", "pass", { update_multi: multi, patched: true, response: patched });
        } catch (error) {
          p.fact("V5", "fail", { update_multi: multi, patched: false });
          throw error;
        }
      });
  });
  if (
    p.report.steps.P5.status !== "fail" &&
    (p.report.facts.V2b!.status === "unknown" || p.report.facts.V5!.status === "unknown")
  )
    p.report.steps.P5.status = "unknown";
}
export async function P6(p: Probe): Promise<void> {
  await oneConnection(p, async (c) => {
    const e = await receiveOwner(
      p,
      c,
      "现在给机器人发一条新的私聊消息，用于 Typing 表情和附件测试",
      (e) => message(e).chat_type === "p2p",
    );
    if (!e) throw new Unknown("no-file-target");
    const m = message(e);
    await sub(p, "typing", async () => {
      let added: any;
      try {
        added = await p.api(`/open-apis/im/v1/messages/${encodeURIComponent(m.message_id)}/reactions`, "POST", {
          reaction_type: { emoji_type: "Typing" },
        });
      } catch (err) {
        p.fact("V9", "fail", { emoji_type: "Typing", added: false });
        p.fact("V3", "fail", { phase: "reaction-add", ...failureInfo(err) });
        throw err;
      }
      p.fact("V9", "pass", { emoji_type: "Typing", added: true });
      try {
        try {
          await p.wait(2000);
        } finally {
          // No cleanup network after cancellation. A test reaction may remain in Feishu.
          if (!p.signal.aborted)
            await p.api(
              `/open-apis/im/v1/messages/${encodeURIComponent(m.message_id)}/reactions/${encodeURIComponent(added.reaction_id)}`,
              "DELETE",
            );
        }
        p.fact("V3", "pass", { phase: "reactions", added: true, removed: true });
      } catch (err) {
        if (!p.signal.aborted)
          p.fact("V3", "fail", { phase: "reaction-remove", added: true, removed: false, ...failureInfo(err) });
        throw err;
      }
    });
    // Generated, non-sensitive fixtures; no local user's files are read or sent.
    await sub(p, "image-upload-send", async () => {
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4z8DwnxLMMGrAqAGjBgwXAwAwxP4QHCfkAAAAAABJRU5ErkJggg==",
        "base64",
      );
      const form = new FormData();
      form.set("image_type", "message");
      form.set("image", new Blob([bytes], { type: "image/png" }), "probe.png");
      try {
        const uploaded = await p.api("/open-apis/im/v1/images", "POST", form);
        await postMessage(p, m.chat_id, "image", { image_key: uploaded.image_key });
        p.fact("V3", "pass", { phase: "image-upload-send", bytes: bytes.length });
      } catch (err) {
        p.fact("V3", "fail", { phase: "image-upload-send", ...failureInfo(err) });
        throw err;
      }
    });
    await sub(p, "file-upload-send", async () => {
      const form = new FormData();
      form.set("file_type", "stream");
      form.set("file_name", "pi-toolkit-probe.txt");
      form.set("file", new Blob(["pi-toolkit Feishu probe\n"], { type: "text/plain" }), "pi-toolkit-probe.txt");
      try {
        const uploaded = await p.api("/open-apis/im/v1/files", "POST", form);
        await postMessage(p, m.chat_id, "file", { file_key: uploaded.file_key });
        p.fact("V3", "pass", { phase: "file-upload-send" });
      } catch (err) {
        p.fact("V3", "fail", { phase: "file-upload-send", ...failureInfo(err) });
        throw err;
      }
    });
    for (const type of ["image", "file"])
      await sub(p, "download-" + type, async () => {
        const inbound = await receiveOwner(
          p,
          c,
          `现在给机器人发送一个不含敏感内容的${type === "image" ? "图片（作为图片发送）" : "小文件（小于 8 MiB）"}`,
          (e) => message(e).message_type === type,
        );
        if (!inbound) {
          p.fact("V3", "unknown", { phase: "download-" + type, received: false });
          return;
        }
        const im = message(inbound),
          content = JSON.parse(im.content),
          key = content[type + "_key"];
        if (typeof key !== "string") throw new Unknown("resource-key-missing");
        const token = await p.accessToken(),
          ac = new AbortController();
        const abort = () => ac.abort();
        p.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 8000);
        timer.unref();
        try {
          const url = allowedUrl(
            apiBase(p.needCredentials().brand) +
              `/open-apis/im/v1/messages/${encodeURIComponent(im.message_id)}/resources/${encodeURIComponent(key)}?type=${type}`,
            "api",
          );
          p.markLive();
          const response = await fetch(url, {
            headers: { Authorization: "Bearer " + token },
            signal: ac.signal,
            redirect: "error",
          });
          const data = await boundedBody(response, 8 * 1024 * 1024);
          let errorCode: number | undefined;
          if (!response.ok || response.headers.get("content-type")?.includes("application/json")) {
            try {
              const body = JSON.parse(new TextDecoder().decode(data));
              if (typeof body?.code === "number" && body.code !== 0 && typeof body.msg === "string") {
                errorCode = body.code;
                p.record("resource-api-error", {
                  phase: "download-" + type,
                  code: errorCode,
                  scopes: missingScopes(body.msg, p.secrets),
                });
              }
            } catch {
              /* A non-JSON error page is recorded by HTTP status only. */
            }
          }
          p.fact("V3", response.ok && errorCode === undefined ? "pass" : "fail", {
            phase: "download-" + type,
            status: response.status,
            code: errorCode,
            bytes: data.length,
          });
          if (!response.ok || errorCode !== undefined) throw apiFailure(response.status, { code: errorCode });
        } catch (err) {
          const error = transportFailure(err, p.signal.aborted, ac.signal.aborted);
          p.fact("V3", "fail", { phase: "download-" + type, ...failureInfo(error) });
          throw error;
        } finally {
          clearTimeout(timer);
          p.signal.removeEventListener("abort", abort);
        }
      });
  });
}
export async function P7(p: Probe): Promise<void> {
  await oneConnection(p, async (c) => {
    await sub(p, "plain-group", async () => {
      const e = await receiveOwner(
        p,
        c,
        "在飞书普通群中添加机器人，然后 @机器人 发送一条消息（不是已有话题的回复）",
        (e) => message(e).chat_type === "group" && !message(e).thread_id,
      );
      if (!e) {
        p.fact("V4", "unknown", { phase: "plain-group", received: false });
        p.fact("V8", "unknown", { received: false });
        return;
      }
      const m = message(e);
      p.fact("V4", "pass", { phase: "plain-group", received: true, mentions: m.mentions });
      p.fact("V3", m.mentions?.length ? "pass" : "unknown", { phase: "group-at", mentions: m.mentions });
      let reply: any;
      try {
        reply = await p.api(`/open-apis/im/v1/messages/${encodeURIComponent(m.message_id)}/reply`, "POST", {
          msg_type: "text",
          content: JSON.stringify({ text: "pi-toolkit 探针：reply_in_thread 测试" }),
          reply_in_thread: true,
          uuid: randomUUID(),
        });
      } catch (error) {
        // Only a failed reply API call means reply_in_thread does not work; a later prompt
        // timeout (user answered the follow-up late) must not be recorded as a V8 failure.
        p.fact("V8", "fail", { reply_in_thread: false });
        throw error;
      }
      {
        // A late answer (prompt-timeout / no follow event) only weakens the evidence; it never
        // turns a successful reply_in_thread into a failure. Ctrl-C still propagates.
        const tolerate = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
          try {
            return await f();
          } catch (error) {
            if (error instanceof Unknown) return undefined;
            throw error;
          }
        };
        const follow = await tolerate(() =>
          receiveOwner(
            p,
            c,
            "打开刚创建的话题，在其中 @机器人 回复一条消息",
            (e) =>
              message(e).chat_type === "group" &&
              message(e).chat_id === m.chat_id &&
              (message(e).root_id === m.message_id ||
                message(e).parent_id === reply?.message_id ||
                (!!reply?.thread_id && message(e).thread_id === reply.thread_id)),
          ),
        );
        const threadId = reply?.thread_id || (follow && message(follow).thread_id);
        const visible = await tolerate(() => p.ask("飞书客户端是否新建了话题？y=是 / n=否 / 回车=不确定"));
        const followInThread = !!follow && !!reply?.thread_id && message(follow).thread_id === reply.thread_id;
        p.fact("V8", threadId && (visible === "y" || followInThread) ? "pass" : "unknown", {
          reply,
          responseThreadId: reply?.thread_id,
          thread_id: threadId ?? null,
          topicCreatedObserved: visible === "y",
          followInThread,
          followMessage: follow ? message(follow) : null,
        });
      }
    });
    await sub(p, "topic-group", async () => {
      const e = await receiveOwner(
        p,
        c,
        "在飞书新建/打开话题群并添加机器人，在话题中 @机器人 发一条消息",
        (e) => message(e).chat_type === "group",
      );
      p.fact("V4", e ? "pass" : "unknown", {
        phase: "topic-group",
        received: !!e,
        thread_id: e ? message(e).thread_id : null,
        message: e ? message(e) : null,
      });
    });
  });
}
export async function P8(p: Probe): Promise<void> {
  await sub(p, "bad-credentials", async () => {
    if (
      !(await approve(
        p,
        "P8：只在内存中用错误 secret 调用 bootstrap 和 token API 各一次（不会覆盖磁盘凭据）。可能留下飞书认证失败审计。",
      ))
    )
      return;
    const c = p.needCredentials(),
      secret = "probe-invalid-" + randomBytes(16).toString("hex");
    p.secrets.push(secret);
    const bootstrap = await p.bootstrap(secret);
    const token = await p.request(apiBase(c.brand) + "/open-apis/auth/v3/tenant_access_token/internal", "api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: c.appId, app_secret: secret }),
    });
    p.record("bad-token-result", { status: token.status, code: token.body.code });
    const rejected =
      bootstrap.body.code !== undefined &&
      bootstrap.body.code !== 0 &&
      token.body.code !== undefined &&
      token.body.code !== 0;
    p.fact("V11", rejected ? "pass" : "unknown", {
      bootstrap: { status: bootstrap.status, code: bootstrap.body.code },
      authApi: { status: token.status, code: token.body.code },
      rejected,
    });
  });
  await sub(p, "second-user", async () =>
    oneConnection(p, async (c) => {
      if (
        !(await approve(
          p,
          "请找第二位非应用创建者（不要更改应用可见范围），请其在飞书搜索并打开此机器人。准备好后回车。",
        ))
      )
        return;
      if (!p.tenantKey) {
        const baseline = await receiveOwner(
          p,
          c,
          "先由应用创建者给机器人发一条私聊消息，以固定租户基线",
          (e) => message(e).chat_type === "p2p",
        );
        if (!baseline) throw new Unknown("owner-tenant-baseline-missing");
      }
      const visible = await p.ask("第二位用户能搜索/打开应用吗？y=能 / n=不能 / 回车=不确定");
      const after = Date.now();
      console.log(`现在让第二位用户给机器人发一条私聊消息（不是群消息），等待 ${p.timeoutMs / 1000} 秒。`);
      const e = await c.next(
        (x) =>
          isMessage(x) &&
          message(x).chat_type === "p2p" &&
          !!sender(x) &&
          sender(x) !== p.needCredentials().ownerOpenId &&
          p.consistent(x),
        p.timeoutMs,
        after,
      );
      p.fact("V12", e ? "pass" : "unknown", {
        visible: visible === "y" ? true : visible === "n" ? false : null,
        received: !!e,
        senderOpenId: e ? sender(e) : null,
        windowMs: p.timeoutMs,
      });
    }),
  );
}
export const handlers: Record<Exclude<StepId, "P1">, (p: Probe) => Promise<void>> = { P2, P3, P4, P5, P6, P7, P8 };
export function stepStatus(p: Probe, id: StepId): Status {
  const facts = Object.values(p.report.facts)
    .flatMap((f) => f.observations)
    .filter((o: any) => o.step === id) as { status: Status }[];
  if (p.report.steps[id].status === "fail" || facts.some((f) => f.status === "fail")) return "fail";
  if (p.report.steps[id].status === "unknown" || facts.some((f) => f.status === "unknown")) return "unknown";
  return "pass";
}
