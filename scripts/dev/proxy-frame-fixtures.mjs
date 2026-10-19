#!/usr/bin/env node
/**
 * Browser-acceptance fixtures for the web-hub proxy link preview (docs/dev/web-hub-proxy/link-preview-plan.md §6 LP4,
 * acceptance.md §18). Plain Node >= 22, zero dependencies, no persistence. Nothing here is a product feature.
 *
 *   node scripts/dev/proxy-frame-fixtures.mjs [--port 8998] [--foreign-port 8999] [--host 127.0.0.1 | --lan]
 *
 * Two HTTP servers:
 *  - UPSTREAM (--port): the app you point the hub proxy at. Routes: /plain /xfo /fa /probe /bust /popup /cookie /form /ws.
 *  - FOREIGN  (--foreign-port): a same-site-but-other-origin page that frames whatever URL you hand it: /frame?src=<url>.
 * Binds loopback only unless you pass --host <addr> or the explicit --lan (0.0.0.0). Stop with Ctrl-C.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: "8998" },
    "foreign-port": { type: "string", default: "8999" },
    host: { type: "string" },
    lan: { type: "boolean", default: false },
  },
  strict: true,
});
if (opt.lan && opt.host) fail("--lan and --host are mutually exclusive");
const HOST = opt.lan ? "0.0.0.0" : (opt.host ?? "127.0.0.1");
const PORT = parsePort(opt.port, "--port");
const FOREIGN_PORT = parsePort(opt["foreign-port"], "--foreign-port");
if (PORT === FOREIGN_PORT) fail("--port and --foreign-port must differ");

function fail(msg) {
  console.error(`proxy-frame-fixtures: ${msg}`);
  process.exit(2);
}
function parsePort(v, flag) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`${flag} must be 1-65535 (got ${v})`);
  return n;
}

// ---------- tiny helpers ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** JSON for an inline <script>: `<` escaped so a value can never close the tag. */
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}
function page(title, body, script = "") {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px}pre{background:#f4f4f4;padding:8px;white-space:pre-wrap}
code{background:#eee;padding:0 3px}.ok{color:#070}.bad{color:#a00}</style>
<h2>${esc(title)}</h2>${body}${script ? `<script>${script}</script>` : ""}`;
}
/** Result-line helper shared by the inline scripts. */
const OUT_JS = `const out=document.getElementById("out");function say(k,v){const d=document.createElement("div");d.textContent=k+": "+v;out.append(d)}`;
const OUT_EL = `<pre id="out"></pre>`;

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(/;\s*/)
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
      }),
  );
}
function readBody(req, max = 16 * 1024) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      if (b.length < max) b += c;
    });
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(b));
  });
}

// ---------- upstream routes ----------
let formCount = 0;

const routes = {
  "/": () =>
    page(
      "proxy fixtures: upstream",
      `<ul>${["plain", "xfo", "fa", "probe?hub=http://H:P", "bust", "popup", "cookie", "form", "ws"].map((r) => `<li><a href="/${esc(r)}">/${esc(r)}</a></li>`).join("")}</ul>`,
    ),
  "/plain": () => page("plain", `<p id="marker">plain page: frameable, no framing headers.</p>`),
  "/probe": (url) => {
    const hub = url.searchParams.get("hub") ?? "";
    let origin = "";
    try {
      const u = new URL(hub);
      if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
    } catch {
      /* fall through to the usage message */
    }
    if (!origin) return page("probe", `<p class="bad">pass the hub origin: <code>/probe?hub=http://H:P</code></p>`);
    const script = `${OUT_JS}const HUB=${js(origin)};
say("frame", "origin="+location.origin+" top===self: "+(top===self));
const note=(k,p)=>p.then(r=>say(k,"readable status "+r.status),e=>say(k,"blocked/unreadable ("+(e&&e.name||e)+") - read the real status code in Network"));
note("fetch /api/version (credentialed)", fetch(HUB+"/api/version",{credentials:"include"}));
note("fetch /api/proxy (credentialed)", fetch(HUB+"/api/proxy",{credentials:"include"}));
const f=document.createElement("form");f.method="POST";f.action=HUB+"/api/proxy/open";f.target="probe_sink";
const i=document.createElement("input");i.name="x";i.value="1";f.append(i);document.body.append(f);f.submit();
say("form POST /api/proxy/open","submitted (outcome not observable here; expect 403 E_CSRF in Network)");
try{const es=new EventSource(HUB+"/api/events",{withCredentials:true});
es.onopen=()=>{say("EventSource /api/events","OPENED (unexpected)");es.close()};
es.onerror=()=>{say("EventSource /api/events","error/blocked");es.close()}}catch(e){say("EventSource /api/events","threw "+e)}
const img=new Image();img.onload=()=>say("img /api/events","loaded (unexpected)");img.onerror=()=>say("img /api/events","error (expected: not an image / not sent)");img.src=HUB+"/api/events";`;
    return page(
      "probe",
      `<p>Hub origin: <code>${esc(origin)}</code>. Compare with acceptance.md §8 A-group.</p>${OUT_EL}<iframe name="probe_sink" hidden></iframe>`,
      script,
    );
  },
  "/bust": () =>
    page(
      "bust",
      `<p>Tries <code>top.location=</code>. The hub tab must NOT move.</p>${OUT_EL}`,
      `${OUT_JS}say("top===self",top===self);
try{top.location="about:blank#busted";say("top.location=","no exception (hub tab must still be unmoved - check it)")}catch(e){say("top.location=","blocked: "+(e&&e.name||e))}`,
    ),
  "/popup": () =>
    page(
      "popup",
      `<button id="b">window.open</button>${OUT_EL}
<p>Expected: an UNSANDBOXED tab opens (allow-popups-to-escape-sandbox). The sandbox is not a malicious-app sandbox.</p>`,
      `${OUT_JS}document.getElementById("b").onclick=()=>{const w=window.open("/plain","_blank");say("window.open",w?"returned a window":"null (popup blocked)")}`,
    ),
  "/form": () =>
    page(
      "form",
      `<form method="POST" action="/form"><input name="msg" value="hello"><button>POST</button></form>
<p>posts so far: <b id="n">${formCount}</b></p>`,
    ),
  "/ws": () =>
    page(
      "ws echo",
      `${OUT_EL}`,
      `${OUT_JS}const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws");
ws.onopen=()=>{say("open","yes");ws.send("hello-"+Date.now())};
ws.onmessage=(e)=>say("echo",e.data);ws.onerror=()=>say("error","websocket error");ws.onclose=(e)=>say("close","code "+e.code);`,
    ),
};

function upstreamHandler(req, res) {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  const p = url.pathname;
  if (p === "/xfo") return send(res, 200, page("xfo", "<p>X-Frame-Options: DENY</p>"), { "x-frame-options": "DENY" });
  if (p === "/fa")
    return send(res, 200, page("fa", "<p>CSP frame-ancestors 'none'</p>"), {
      "content-security-policy": "frame-ancestors 'none'",
    });
  if (p === "/cookie") {
    const had = parseCookies(req.headers.cookie).fx_cookie;
    const headers = {};
    if (url.searchParams.has("reset")) headers["set-cookie"] = "fx_cookie=; Path=/; Max-Age=0";
    else if (!had) headers["set-cookie"] = `fx_cookie=${randomBytes(4).toString("hex")}; Path=/; SameSite=Lax`;
    const value = url.searchParams.has("reset") ? "(reset)" : (had ?? "(none yet - set now, reload to see it)");
    return send(
      res,
      200,
      page(
        "cookie",
        `<p>cookie seen by upstream: <b id="v">${esc(value)}</b></p><p>document.cookie: <b id="dc"></b></p>`,
        `document.getElementById("dc").textContent=document.cookie`,
      ),
      headers,
    );
  }
  if (p === "/form" && req.method === "POST") {
    return readBody(req).then((body) => {
      formCount++;
      const sfs = req.headers["sec-fetch-site"] ?? "(absent)";
      send(
        res,
        200,
        page(
          "form result",
          `<p class="ok">POST round-trip ok #${formCount}</p><pre>${esc(body)}</pre><p>Sec-Fetch-Site: ${esc(sfs)}  Origin: ${esc(req.headers.origin ?? "(absent)")}</p>`,
        ),
      );
    });
  }
  const route = routes[p];
  if (route && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, route(url));
  send(res, 404, page("not found", `<p>${esc(p)}</p>`));
}

// ---------- minimal RFC 6455 echo (text/ping/close, unfragmented frames only) ----------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsSockets = new Set();

function wsFrame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
}

function upgradeHandler(req, socket) {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/ws" || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  wsSockets.add(socket);
  socket.on("close", () => wsSockets.delete(socket));
  socket.on("error", () => socket.destroy());
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > 1 << 20) return void socket.destroy();
      const masked = (buf[1] & 0x80) !== 0;
      if (!masked) return void socket.destroy(); // RFC 6455: client frames MUST be masked
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (opcode === 1 || opcode === 2) socket.write(wsFrame(opcode, data));
      else if (opcode === 9) socket.write(wsFrame(10, data));
      else if (opcode === 8) return void socket.end(wsFrame(8, data.subarray(0, 2)));
    }
  });
}

// ---------- foreign (same-site, other-origin) framing server ----------
function foreignHandler(req, res) {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  if (url.pathname !== "/frame") {
    return send(res, 200, page("proxy fixtures: foreign", `<p>Use <code>/frame?src=&lt;url&gt;</code>.</p>`));
  }
  let src = "";
  try {
    const u = new URL(url.searchParams.get("src") ?? "");
    if (u.protocol === "http:" || u.protocol === "https:") src = u.href;
  } catch {
    /* handled below */
  }
  if (!src) return send(res, 400, page("frame", `<p class="bad">src must be an absolute http(s) URL</p>`));
  const script = `${OUT_JS}const t0=Date.now(),fr=document.getElementById("fr");
say("framed page origin",location.origin);
fr.addEventListener("load",()=>say("iframe load event","fired after "+(Date.now()-t0)+" ms (fires for refusals too - judge by what the frame shows)"));
setTimeout(()=>say("note","a refused frame shows a blank/error page; record rendered / refused / 401"),3000);`;
  send(
    res,
    200,
    page(
      "foreign frame",
      `<p>Framing: <code>${esc(src)}</code></p>${OUT_EL}<iframe id="fr" src="${esc(src)}" style="width:100%;height:320px;border:2px solid #888"></iframe>`,
      script,
    ),
  );
}

// ---------- boot ----------
const upstream = createServer(upstreamHandler);
upstream.on("upgrade", upgradeHandler);
const foreign = createServer(foreignHandler);

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
}

try {
  await listen(upstream, PORT);
  await listen(foreign, FOREIGN_PORT);
} catch (e) {
  fail(`cannot listen on ${HOST}: ${e.message}`);
}

const shown = HOST === "0.0.0.0" ? "<LAN-IP>" : HOST;
console.log(`upstream (point the proxy here): http://${shown}:${PORT}/`);
for (const r of ["plain", "xfo", "fa", "bust", "popup", "cookie", "form", "ws"])
  console.log(`  http://${shown}:${PORT}/${r}`);
console.log(`  http://${shown}:${PORT}/probe?hub=http://<hub-host>:<hub-port>`);
console.log(`foreign framing page:            http://${shown}:${FOREIGN_PORT}/frame?src=<url-to-frame>`);
if (HOST === "0.0.0.0") console.log("WARNING: --lan binds 0.0.0.0; stop these fixtures when done.");
console.log("Ctrl-C to stop.");

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  for (const s of wsSockets) s.destroy();
  upstream.close();
  foreign.close();
  upstream.closeAllConnections();
  foreign.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
});
