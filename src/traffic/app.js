/**
 * pi traffic record — Web 查看页 Vue 3 应用（内联加载，无构建步骤）。
 * 全局 Vue 由 page.ts 内联的 vue.global.prod.js（带 compiler 的 global build）提供。
 * 铁律：不使用 v-html；所有用户数据走 {{ }} / 属性绑定，默认转义。
 *
 * 本文件是普通脚本（非模块），顶层只依赖浏览器全局与 Vue；
 * 为便于测试注入，window/document/localStorage/fetch/EventSource 等
 * 均通过形参传入（见文件末尾 IIFE）。
 */
(function (window, document, localStorage, fetch, EventSource, setInterval, clearInterval, Vue) {
  "use strict";

  var createApp = Vue.createApp;
  var ref = Vue.ref;
  var reactive = Vue.reactive;
  var computed = Vue.computed;
  var watch = Vue.watch;
  var onMounted = Vue.onMounted;
  var onUnmounted = Vue.onUnmounted;

  // ---------- 通用工具 ----------

  // token 从当前 URL 读取，透传到所有 API / SSE / 导出链接（局域网访问必须，本机可省）
  var TOKEN = new URLSearchParams(window.location.search).get("token") || "";
  function api(p) {
    if (!TOKEN) return p;
    return p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  }
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
    } catch (e) {
      return iso || "";
    }
  }
  function fmtSize(n) {
    if (n == null) return "-";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }
  /** 尝试 JSON pretty，失败回退原文 */
  function prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return text;
    }
  }
  function jsonStr(v) {
    return JSON.stringify(v, null, 2);
  }
  /** SSE 原文（含 data:/event: 行）不做 JSON pretty */
  function looksLikeSse(text) {
    return /(^|\n)\s*(data|event|id|retry):/.test(text);
  }
  function statusClass(st) {
    if (st == null) return "st pending";
    return "st " + (st >= 200 && st < 300 ? "ok" : "err");
  }
  function statusText(st) {
    return st == null ? "…" : String(st);
  }

  // ---------- 改写规则辅助 ----------

  // header 展示脱敏：与后端 src/redact.ts 的 redactHeaderMap 等价的内联实现（保持零构建，不 import TS 模块）
  var SECRET_HEADER_KEYS =
    /^(x-api-key|authorization|proxy-authorization|api-key|x-goog-api-key|openai-api-key|x-goog-iam-authorization-token|cookie|set-cookie|x-amz-security-token)$/i;
  function redactHeaderMap(h) {
    var out = {};
    if (!h || typeof h !== "object") return out;
    for (var k in h) out[k] = SECRET_HEADER_KEYS.test(k) ? "«REDACTED»" : h[k];
    return out;
  }
  var RULE_METHODS = ["", "GET", "POST", "PUT", "PATCH", "DELETE"];
  /** 运行时正则校验：非法表达式的规则行标红（服务端写入时已校验，此处兜底手改 DB / 旧行） */
  function ruleBadRegex(r) {
    if (!r || !r.url_pattern) return false;
    try {
      new RegExp(r.url_pattern);
      return false;
    } catch (e) {
      return true;
    }
  }
  function matchSummary(r) {
    var parts = [];
    parts.push(r.url_pattern ? "/" + r.url_pattern + "/" : "任意 URL");
    parts.push(r.method || "任意方法");
    if (r.model) parts.push("model⊇" + r.model);
    return parts.join(" · ");
  }
  function jqSummary(r) {
    var parts = [];
    if (r.body_jq) parts.push("body: " + r.body_jq);
    if (r.headers_jq) parts.push("headers: " + r.headers_jq);
    return parts.join(" · ") || "（无 jq 表达式）";
  }

  // ---------- 主题（跟随系统 / 浅色 / 深色，选择存 localStorage）----------

  var THEMES = ["auto", "light", "dark"];
  var THEME_ICON = { auto: "◑", light: "☀", dark: "☽" };
  var THEME_NAME = { auto: "跟随系统", light: "浅色", dark: "深色" };
  var themeMode = ref(localStorage.getItem("recordTheme") || "auto");
  if (THEMES.indexOf(themeMode.value) < 0) themeMode.value = "auto";
  function applyTheme(mode) {
    var effective = mode;
    if (mode === "auto") {
      effective = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", effective);
  }
  function cycleTheme() {
    themeMode.value = THEMES[(THEMES.indexOf(themeMode.value) + 1) % THEMES.length];
    localStorage.setItem("recordTheme", themeMode.value);
  }
  watch(themeMode, function (m) {
    applyTheme(m);
  });
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
        if (themeMode.value === "auto") applyTheme("auto");
      });
    } catch (e) {}
  }

  // ---------- 详情子 tab（跨记录、跨面板记忆） ----------

  var detailTab = ref("out");

  // ---------- 流式数据 per-id 缓存（四态状态机 + in-flight 复用 + 失败可重试） ----------

  var streamCache = new Map(); // id -> reactive({state, rows, raw, error, promise})
  function streamState(id) {
    var s = streamCache.get(id);
    if (!s) {
      s = reactive({ state: "idle", rows: null, raw: "", error: "", promise: null });
      streamCache.set(id, s);
    }
    return s;
  }
  function loadStream(id) {
    var s = streamState(id);
    if (s.state === "loading" && s.promise) return s.promise;
    if (s.state === "done") return Promise.resolve(s);
    s.state = "loading";
    s.error = "";
    s.promise = fetch(api("/api/stream/" + id))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var rows = Array.isArray(data) ? data : data.rows || [];
        s.rows = rows;
        s.raw = rows
          .map(function (c) {
            return c.data;
          })
          .join("");
        s.state = "done";
        return s;
      })
      .catch(function (e) {
        s.state = "error";
        s.error = String((e && e.message) || e);
        s.promise = null; // 失败允许重试
      });
    return s.promise;
  }

  // ---------- 组件 ----------

  var AppHeader = {
    props: ["recording", "sseText", "sseOk", "activeTab", "themeMode", "correlationMode"],
    emits: ["tab", "theme"],
    data: function () {
      return {
        tabs: [
          { key: "live", label: "实时" },
          { key: "history", label: "历史" },
          { key: "export", label: "导出" },
          { key: "rules", label: "改写" },
        ],
      };
    },
    computed: {
      themeIcon: function () {
        return THEME_ICON[this.themeMode] || "◑";
      },
      themeTitle: function () {
        return "主题: " + (THEME_NAME[this.themeMode] || "跟随系统") + "（点击切换）";
      },
    },
    template:
      "<header>" +
      '<span class="logo">⏺ pi traffic record</span>' +
      '<span class="badge" :class="recording ? \'on\' : \'off\'">{{ recording ? "● 录制中" : "已停止" }}</span>' +
      "<span class=\"badge\" :class=\"sseOk === null ? '' : (sseOk ? 'on' : 'err')\">{{ sseText }}</span>" +
      // v3：闸门生效时显示。correlationMode 来自 /api/state（挂载时取一次），
      // 而 recording 由 SSE state 事件实时更新 —— 两者相与，/record off 后立刻熄灭，
      // 不依赖 rewrite 块的刷新。
      '<span v-if="recording && correlationMode === \'exact\'" class="badge gate" title="改写规则已启用：provider 请求经串行化闸门按序发送">串行化中</span>' +
      "<nav>" +
      '<button v-for="t in tabs" :key="t.key" class="tab" :class="{ active: activeTab === t.key }" @click="$emit(\'tab\', t.key)">{{ t.label }}</button>' +
      '<button id="themeBtn" :title="themeTitle" @click="$emit(\'theme\')">{{ themeIcon }}</button>' +
      "</nav>" +
      "</header>",
  };

  var FlowList = {
    props: ["rows", "selectedId", "emptyText"],
    emits: ["select"],
    methods: {
      fmtTime: fmtTime,
      fmtSize: fmtSize,
      statusClass: statusClass,
      statusText: statusText,
    },
    template:
      '<div class="list">' +
      '<div v-if="!rows.length" class="empty" style="white-space: pre-line">{{ emptyText }}</div>' +
      '<div v-for="d in rows" :key="d.id" class="flow" :class="{ sel: d.id === selectedId }" :data-id="d.id" :title="d.session_id || \'\'" @click="$emit(\'select\', d.id)">' +
      '<span class="fid">#{{ d.id }}</span>' +
      "<span v-if=\"d.origin === 'replay'\" class=\"rp-tag\" :title=\"'重放于 #' + (d.replay_of || '?')\">⟳</span>" +
      '<span class="ftime">{{ fmtTime(d.ts) }}</span>' +
      '<span class="fmodel">{{ d.model || "?" }}</span>' +
      '<span :class="statusClass(d.status)">{{ statusText(d.status) }}</span>' +
      '<span v-if="d.rewrite_status === \'applied\'" class="rw-tag" title="请求已被改写">✎</span>' +
      '<span v-else-if="d.rewrite_status === \'blocked\'" class="rw-tag blocked" title="请求被改写规则阻断">⛔</span>' +
      '<span class="fsize">{{ fmtSize(d.size) }}</span>' +
      "</div>" +
      "</div>",
  };

  var Resizer = {
    template: '<div class="resizer" title="拖动调整宽度（双击复原）" @mousedown="onDown" @dblclick="onReset"></div>',
    methods: {
      onDown: function (ev) {
        ev.preventDefault();
        var startX = ev.clientX;
        var startW = this.$el.previousElementSibling.getBoundingClientRect().width;
        this.$el.classList.add("dragging");
        document.body.classList.add("resizing");
        var self = this;
        function onMove(e) {
          var w = Math.max(140, Math.min(window.innerWidth - 220, startW + (e.clientX - startX)));
          document.documentElement.style.setProperty("--list-w", w + "px");
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          self.$el.classList.remove("dragging");
          document.body.classList.remove("resizing");
          var cur = parseInt(document.documentElement.style.getPropertyValue("--list-w"), 10);
          if (cur) localStorage.setItem("recordListW", String(cur));
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      },
      onReset: function () {
        document.documentElement.style.setProperty("--list-w", "304px");
        localStorage.setItem("recordListW", "304");
      },
    },
  };

  var MetaCard = {
    props: ["d"],
    methods: { statusClass: statusClass, statusText: statusText },
    computed: {
      // v3（V2/V7）：线级编码与字节数；identity 或无数据不显示
      encodingLine: function () {
        var d = this.d || {};
        var enc = d.payload_encoding;
        if (!enc || enc === "identity") return "";
        var bytes = d.payload_bytes;
        return "发送编码：" + enc + (bytes != null ? "（" + bytes + " B）" : "");
      },
    },
    template:
      '<div class="meta">' +
      '<div><b class="hl">#{{ d.id }}</b>' +
      '<span v-if="d.origin === \'replay\'" class="rp-tag"> ⟳ 重放于 #{{ d.replay_of || "?" }}</span>' +
      " · turn {{ d.turn }} · {{ d.ts }}</div>" +
      '<div>model: <b>{{ d.model || "?" }}</b> · provider: {{ d.provider || "?" }} · status: ' +
      '<span :class="statusClass(d.status)">{{ statusText(d.status) }}</span>' +
      '<template v-if="d.rewrite_status === \'applied\'"> · <span class="rw-badge">✎ 已改写</span></template>' +
      '<template v-else-if="d.rewrite_status === \'blocked\'"> · <span class="rw-badge blocked">⛔ 已阻断</span></template>' +
      '<template v-if="d.method"> · {{ d.method }}</template></div>' +
      '<div v-if="encodingLine" class="dim">{{ encodingLine }}</div>' +
      '<div class="dim">session: {{ d.session_id }}<template v-if="d.url"><br>url: {{ d.url }}</template></div>' +
      "</div>",
  };

  var AssistantMsg = {
    props: ["m"],
    methods: { jsonStr: jsonStr },
    computed: {
      blocks: function () {
        return (this.m && this.m.content) || [];
      },
      isEmpty: function () {
        return !this.m || (!this.m.usage && !this.m.stopReason && this.blocks.length === 0);
      },
    },
    template:
      "<div>" +
      '<div v-if="!m" class="empty">无配对响应（请求可能失败或响应尚未到达）</div>' +
      "<template v-else>" +
      '<div v-if="isEmpty" class="empty">（空消息）</div>' +
      "<template v-else>" +
      '<div v-if="m.usage" class="usage">tokens — input: {{ m.usage.input || 0 }} · output: {{ m.usage.output || 0 }}' +
      '<template v-if="m.usage.cacheRead"> · cacheRead: {{ m.usage.cacheRead }}</template>' +
      '<template v-if="m.usage.cacheWrite"> · cacheWrite: {{ m.usage.cacheWrite }}</template>' +
      '<template v-if="m.usage.cost && m.usage.cost.total != null"> · cost: ${{ m.usage.cost.total.toFixed(4) }}</template>' +
      "</div>" +
      '<div v-if="m.stopReason" class="stopreason">stopReason: {{ m.stopReason }}' +
      '<template v-if="m.errorMessage"> · <span class="emsg">{{ m.errorMessage }}</span></template></div>' +
      '<template v-for="(c, i) in blocks" :key="i">' +
      '<div v-if="c.type === \'text\'" class="msg-text">{{ c.text }}</div>' +
      '<details v-else-if="c.type === \'thinking\'" class="thinking"><summary>💭 thinking（点击展开）</summary><pre>{{ c.thinking || "" }}</pre></details>' +
      '<div v-else-if="c.type === \'toolCall\'" class="toolcall">🔧 <b>{{ c.name }}</b><pre>{{ jsonStr(c.arguments) }}</pre></div>' +
      "</template>" +
      "</template>" +
      "</template>" +
      "</div>",
  };

  var OutputPanel = {
    components: { AssistantMsg: AssistantMsg },
    props: ["d"],
    methods: { jsonStr: jsonStr },
    computed: {
      isReplay: function () {
        return this.d.origin === "replay";
      },
      replayText: function () {
        var b = this.d.replay_body;
        if (b == null) return null;
        if (looksLikeSse(b)) return b; // SSE 原文不 parse
        return prettyJson(b);
      },
    },
    template:
      "<div>" +
      '<template v-if="isReplay">' +
      '<div class="replay-warn">⟳ 重放记录：响应无配对 assistant 消息，以下为捕获到的响应体原文</div>' +
      '<pre v-if="replayText != null">{{ replayText }}</pre>' +
      '<div v-else class="empty">未捕获到响应体（响应尚未到达或抓取失败，稍后可到「流式」子页查看）</div>' +
      "</template>" +
      "<template v-else>" +
      '<assistant-msg :m="d.response"></assistant-msg>' +
      '<details v-if="d.response" class="raw"><summary>原始消息 JSON</summary><pre>{{ jsonStr(d.response) }}</pre></details>' +
      "</template>" +
      "</div>",
  };

  var InputPanel = {
    props: ["d"],
    computed: {
      text: function () {
        return jsonStr(this.d.payload);
      },
    },
    template: "<pre>{{ text }}</pre>",
  };

  var StreamPanel = {
    props: ["d"],
    computed: {
      st: function () {
        return streamState(this.d.id);
      },
      single: function () {
        return this.st.rows && this.st.rows.length === 1;
      },
      singleText: function () {
        return prettyJson(this.st.raw);
      },
    },
    mounted: function () {
      if (this.d.stream) loadStream(this.d.id);
    },
    methods: {
      fmtSize: fmtSize,
      retry: function () {
        loadStream(this.d.id);
      },
    },
    template:
      "<div>" +
      '<div v-if="!d.stream" class="empty">未捕获到流式数据（非流式响应 / 录制未开启 / websocket 传输）</div>' +
      "<template v-else>" +
      '<div class="usage">chunks: {{ d.stream.chunks }} · {{ fmtSize(d.stream.bytes) }} · 首 chunk +{{ d.stream.ttfbMs }}ms · 流式总时长 {{ d.stream.durationMs }}ms</div>' +
      "<div v-if=\"st.state === 'loading' || st.state === 'idle'\" class=\"empty\">加载中…</div>" +
      '<div v-else-if="st.state === \'error\'" class="empty">加载失败: {{ st.error }} <button class="btn" @click="retry">重试</button></div>' +
      "<template v-else>" +
      // 单 chunk：直接展示全文（JSON pretty 尝试），不渲染 chunk 列表与拼接 details
      '<pre v-if="single">{{ singleText }}</pre>' +
      "<template v-else>" +
      '<div class="chunks">' +
      '<div v-for="c in st.rows" :key="c.seq" class="chunk">' +
      '<span class="cseq">#{{ c.seq }}</span>' +
      '<span class="cms">+{{ c.elapsed_ms }}ms</span>' +
      '<span class="cdata">{{ c.data }}</span>' +
      "</div>" +
      "</div>" +
      '<details class="raw"><summary>拼接后的原始响应体（{{ fmtSize(st.raw.length) }}）</summary><pre>{{ st.raw }}</pre></details>' +
      "</template>" +
      "</template>" +
      "</template>" +
      "</div>",
  };

  var HeadersPanel = {
    props: ["d"],
    methods: { jsonStr: jsonStr },
    template:
      "<div>" +
      // V7 命名对齐：这是「发送头」而非完整线级 header（host / content-length 由传输层重算）
      '<h4>发送请求头<span class="dim">（不含由传输层重算的 host / content-length）</span>' +
      '<template v-if="d.request_headers"> · 含凭证，注意分享风险</template></h4>' +
      '<pre v-if="d.request_headers">{{ jsonStr(d.request_headers) }}</pre>' +
      '<div v-else class="empty">未记录</div>' +
      "<h4>响应 Header</h4>" +
      '<pre v-if="d.response_headers">{{ jsonStr(d.response_headers) }}</pre>' +
      '<div v-else class="empty">未记录</div>' +
      "</div>",
  };

  /** 重放子页：吸顶操作条 + 左编辑（Payload/Headers 二级 tab）+ 右结果四态 */
  var ReplayPanel = {
    props: ["d"],
    emits: ["open-request", "replayed"],
    data: function () {
      return {
        url: this.d.url || "",
        method: this.d.method || "POST",
        headersText: jsonStr(this.d.request_headers || {}),
        payloadText: jsonStr(this.d.payload),
        leftTab: "payload",
        sending: false,
        headersError: "",
        payloadError: "",
        result: null, // {kind:'ok', id, status, headers, body} | {kind:'error', error, id}
        streamRows: [], // 流式重放：轮询累积的 chunk
        streamDone: false,
        streamTick: 0, // 接收中已耗时（秒）
        streamNote: "", // 轮询超时等异常提示
      };
    },
    computed: {
      headersCount: function () {
        try {
          return String(Object.keys(JSON.parse(this.headersText)).length);
        } catch (e) {
          return "!";
        }
      },
      badgeText: function () {
        if (this.sending) return "发送中…";
        if (!this.result) return "未发送";
        if (this.result.kind === "error") return "失败";
        return "HTTP " + this.result.status;
      },
      badgeClass: function () {
        if (this.sending || !this.result) return "rp-badge";
        if (this.result.kind === "error") return "rp-badge bad";
        return "rp-badge " + (this.result.status >= 200 && this.result.status < 300 ? "ok" : "bad");
      },
      bodyText: function () {
        if (!this.result || this.result.body == null) return "";
        var ct = "";
        var h = this.result.headers || {};
        for (var k in h) {
          if (k.toLowerCase() === "content-type") ct = String(h[k]).toLowerCase();
        }
        if (ct.indexOf("event-stream") >= 0 || ct.indexOf("ndjson") >= 0) return this.result.body;
        return prettyJson(this.result.body);
      },
      streamStatusText: function () {
        if (this.streamDone) {
          var last = this.streamRows[this.streamRows.length - 1];
          return (
            "录制完成 · " + this.streamRows.length + " chunk" + (last ? " · 总时长 " + last.elapsed_ms + "ms" : "")
          );
        }
        if (this.streamNote) return this.streamNote;
        return "流式接收中… " + this.streamRows.length + " chunk · " + this.streamTick + "s";
      },
    },
    methods: {
      stopStreamWatch: function () {
        if (this.streamTimer) {
          clearInterval(this.streamTimer);
          this.streamTimer = null;
        }
      },
      // 流式重放：轮询 /api/stream/:id 累积 chunk，done 或超时（180s 安全上限）后停止
      startStreamWatch: function (id) {
        var self = this;
        this.stopStreamWatch();
        this.streamRows = [];
        this.streamDone = false;
        this.streamTick = 0;
        this.streamNote = "";
        var startedAt = Date.now();
        function poll() {
          self.streamTick = Math.round((Date.now() - startedAt) / 1000);
          if (self.streamTick > 180) {
            self.stopStreamWatch();
            self.streamNote =
              "等待超时 · " + self.streamRows.length + " chunk（可稍后到 #" + id + " 的「流式」子页查看）";
            return;
          }
          fetch(api("/api/stream/" + id))
            .then(function (r) {
              return r.json();
            })
            .then(function (data) {
              self.streamRows = Array.isArray(data) ? data : data.rows || [];
              self.$nextTick(function () {
                var b = self.$refs.streamBox;
                if (b) b.scrollTop = b.scrollHeight;
              });
              if (data.done) {
                self.stopStreamWatch();
                self.streamDone = true;
              }
            })
            .catch(function () {});
        }
        poll();
        this.streamTimer = setInterval(poll, 500);
      },
      reset: function () {
        this.stopStreamWatch();
        this.url = this.d.url || "";
        this.method = this.d.method || "POST";
        this.headersText = jsonStr(this.d.request_headers || {});
        this.payloadText = jsonStr(this.d.payload);
        this.sending = false;
        this.headersError = "";
        this.payloadError = "";
        this.result = null;
        this.streamRows = [];
        this.streamDone = false;
        this.streamTick = 0;
        this.streamNote = "";
      },
      send: function () {
        if (this.sending) return;
        // 重发入口即停止上一轮流式轮询（新结果为非流式/失败时旧 timer 不得继续写 streamRows）
        this.stopStreamWatch();
        this.streamRows = [];
        this.streamDone = false;
        this.streamTick = 0;
        this.streamNote = "";
        this.headersError = "";
        this.payloadError = "";
        var headers, payload;
        try {
          headers = JSON.parse(this.headersText);
        } catch (e) {
          this.headersError = "Headers JSON 解析失败: " + e.message;
        }
        try {
          payload = JSON.parse(this.payloadText);
        } catch (e) {
          this.payloadError = "Payload JSON 解析失败: " + e.message;
        }
        if (this.headersError || this.payloadError) return;
        var self = this;
        this.sending = true;
        fetch(api("/api/replay"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request_id: this.d.id,
            url: this.url,
            method: this.method,
            headers: headers,
            payload: payload,
          }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (out) {
            self.sending = false;
            if (out.error) {
              self.result = { kind: "error", error: out.error, id: out.id };
            } else {
              self.result = { kind: "ok", id: out.id, status: out.status, headers: out.headers || {}, body: out.body };
              // 流式成功（无 body）：右栏实时滚动 chunk
              if (out.body == null && out.id) self.startStreamWatch(out.id);
            }
            self.$emit("replayed");
          })
          .catch(function (e) {
            self.sending = false;
            self.result = { kind: "error", error: "请求失败: " + String((e && e.message) || e) };
          });
      },
    },
    beforeUnmount: function () {
      this.stopStreamWatch();
    },
    template:
      '<div class="rp-wrap" @keydown.ctrl.enter="send" @keydown.meta.enter="send">' +
      '<div class="replay-warn">⚠ 重放会用记录中的凭证向真实 provider 发请求，产生真实 token 消耗与费用</div>' +
      '<div class="rp-bar">' +
      '<input class="rp-method" type="text" v-model="method" title="Method">' +
      '<input class="rp-url" type="text" v-model="url" title="URL">' +
      '<button class="btn" :disabled="sending" @click="send">{{ sending ? "发送中…" : "▶ 发送" }}</button>' +
      '<button class="btn" :disabled="sending" @click="reset">重置</button>' +
      '<span :class="badgeClass">{{ badgeText }}</span>' +
      "</div>" +
      '<div class="rp-cols">' +
      '<div class="rp-left">' +
      '<div class="rp-tabs">' +
      '<button class="rp-tab" :class="{ active: leftTab === \'payload\' }" @click="leftTab = \'payload\'">Payload</button>' +
      '<button class="rp-tab" :class="{ active: leftTab === \'headers\' }" @click="leftTab = \'headers\'">Headers ({{ headersCount }})</button>' +
      "</div>" +
      '<textarea v-show="leftTab === \'payload\'" class="rp-editor" v-model="payloadText" spellcheck="false"></textarea>' +
      '<textarea v-show="leftTab === \'headers\'" class="rp-editor" v-model="headersText" spellcheck="false"></textarea>' +
      '<div v-if="leftTab === \'payload\' && payloadError" class="rp-err">{{ payloadError }}</div>' +
      '<div v-if="leftTab === \'headers\' && headersError" class="rp-err">{{ headersError }}</div>' +
      "</div>" +
      '<div class="rp-right">' +
      '<div v-if="!result" class="empty">编辑左侧内容后点击 ▶ 发送（或 Ctrl/⌘ + Enter）\n应答将显示在这里</div>' +
      "<template v-else-if=\"result.kind === 'ok'\">" +
      '<div class="rp-result-head">已重放 → 新记录 <b>#{{ result.id }}</b> · HTTP {{ result.status }}' +
      ' <button class="btn" @click="$emit(\'open-request\', result.id)">查看新记录</button></div>' +
      '<pre v-if="result.body != null">{{ bodyText }}</pre>' +
      "<template v-else>" +
      '<div class="usage">{{ streamStatusText }}</div>' +
      '<div class="chunks" ref="streamBox">' +
      '<div v-for="c in streamRows" :key="c.seq" class="chunk"><span class="cseq">#{{ c.seq }}</span><span class="cms">+{{ c.elapsed_ms }}ms</span><span class="cdata">{{ c.data }}</span></div>' +
      '<div v-if="!streamRows.length" class="empty">等待首个 chunk…</div>' +
      "</div>" +
      "</template>" +
      "</template>" +
      '<div v-else class="rp-err-block">失败: {{ result.error }}<template v-if="result.id">（已记录为 #{{ result.id }}）</template></div>' +
      "</div>" +
      "</div>" +
      "</div>",
  };

  /** 改写子页：命中规则 + 错误块 + 原始/改写后双栏对比（header 展示经 redactHeaderMap 脱敏副本） */
  var RewritePanel = {
    props: ["d"],
    computed: {
      ruleNames: function () {
        return Array.isArray(this.d.rule_names) ? this.d.rule_names : [];
      },
      rwError: function () {
        var e = this.d.rewrite_error;
        return e && typeof e === "object" ? e : null;
      },
      origPayloadText: function () {
        return jsonStr(this.d.orig_payload);
      },
      newPayloadText: function () {
        return jsonStr(this.d.payload);
      },
      origHeadersText: function () {
        return jsonStr(redactHeaderMap(this.d.orig_request_headers || {}));
      },
      newHeadersText: function () {
        return jsonStr(redactHeaderMap(this.d.request_headers || {}));
      },
    },
    template:
      "<div>" +
      '<div v-if="ruleNames.length" class="rw-rules">命中规则: <span v-for="(n, i) in ruleNames" :key="i" class="rw-chip">{{ n }}</span></div>' +
      '<div v-if="rwError" class="rw-err">' +
      "<div><b>{{ rwError.kind }}</b>" +
      '<template v-if="rwError.phase"> · phase: {{ rwError.phase }}</template>' +
      '<template v-if="rwError.rule_name"> · 规则: {{ rwError.rule_name }}</template></div>' +
      '<div v-if="rwError.message">{{ rwError.message }}</div>' +
      '<pre v-if="rwError.detail">{{ rwError.detail }}</pre>' +
      "</div>" +
      "<h4>Payload 对比（左：原始 → 右：改写后）</h4>" +
      '<div class="rw-cols">' +
      '<div class="rw-col"><h5>原始 payload</h5><pre>{{ origPayloadText }}</pre></div>' +
      '<div class="rw-col"><h5>改写后 payload</h5><pre>{{ newPayloadText }}</pre></div>' +
      "</div>" +
      '<h4>发送请求头对比<span class="dim">（不含由传输层重算的 host / content-length；展示值已脱敏）</span></h4>' +
      '<div class="rw-cols">' +
      '<div class="rw-col"><h5>原始 header</h5><pre>{{ origHeadersText }}</pre></div>' +
      '<div class="rw-col"><h5>改写后 header</h5><pre>{{ newHeadersText }}</pre></div>' +
      "</div>" +
      "</div>",
  };

  var DetailPane = {
    components: {
      MetaCard: MetaCard,
      OutputPanel: OutputPanel,
      InputPanel: InputPanel,
      StreamPanel: StreamPanel,
      HeadersPanel: HeadersPanel,
      ReplayPanel: ReplayPanel,
      RewritePanel: RewritePanel,
    },
    props: ["data", "loading", "error", "emptyText"],
    emits: ["open-request", "replayed"],
    data: function () {
      return { tab: detailTab, shown: {} }; // tab 为模块级共享 ref：跨记录/跨面板记忆
    },
    computed: {
      dataId: function () {
        return this.data ? this.data.id : null;
      },
      dtabs: function () {
        var d = this.data || {};
        var reqH = d.request_headers ? Object.keys(d.request_headers).length : 0;
        var resH = d.response_headers ? Object.keys(d.response_headers).length : 0;
        var tabs = [
          { key: "out", label: "输出", badge: d.response ? null : "无" },
          { key: "in", label: "输入", badge: fmtSize(JSON.stringify(d.payload).length) },
          { key: "stream", label: "流式", badge: d.stream ? d.stream.chunks + " chunk" : "无" },
          { key: "headers", label: "Header", badge: reqH + "/" + resH },
          { key: "replay", label: "重放", badge: d.url ? null : "不可" },
        ];
        // 第 6 个子 tab：仅在被改写 / 被阻断的记录上出现（I4）
        if (d.rewrite_status === "applied") tabs.push({ key: "rewrite", label: "改写", badge: "✎ 已改写" });
        else if (d.rewrite_status === "blocked") tabs.push({ key: "rewrite", label: "改写", badge: "⛔ 已阻断" });
        return tabs;
      },
    },
    watch: {
      dataId: function () {
        // 切换记录：重置已激活面板集合，并按记忆 tab 立即激活
        this.shown = {};
        this.activate(this.tab);
      },
      tab: function (t) {
        this.activate(t);
      },
    },
    mounted: function () {
      this.activate(this.tab);
    },
    methods: {
      setTab: function (t) {
        this.tab = t;
      },
      activate: function (t) {
        if (!this.data) return;
        if (!this.shown[t]) {
          var next = {};
          for (var k in this.shown) next[k] = this.shown[k];
          next[t] = true;
          this.shown = next;
        }
        if (t === "stream" && this.data.stream) loadStream(this.data.id);
      },
    },
    template:
      "<div>" +
      '<div v-if="loading" class="empty">加载中…</div>' +
      '<div v-else-if="error" class="empty">加载失败: {{ error }}</div>' +
      '<div v-else-if="!data" class="empty">{{ emptyText }}</div>' +
      "<template v-else>" +
      '<meta-card :d="data"></meta-card>' +
      '<div class="dtabs">' +
      '<button v-for="t in dtabs" :key="t.key" class="dtab" :class="{ active: tab === t.key }" @click="setTab(t.key)">{{ t.label }}<span v-if="t.badge" class="dbadge">{{ t.badge }}</span></button>' +
      "</div>" +
      '<div class="dpanel" :class="{ active: tab === \'out\' }" v-show="tab === \'out\'"><output-panel v-if="shown.out" :d="data"></output-panel></div>' +
      '<div class="dpanel" :class="{ active: tab === \'in\' }" v-show="tab === \'in\'"><input-panel v-if="shown.in" :d="data"></input-panel></div>' +
      '<div class="dpanel" :class="{ active: tab === \'stream\' }" v-show="tab === \'stream\'"><stream-panel v-if="shown.stream" :d="data"></stream-panel></div>' +
      '<div class="dpanel" :class="{ active: tab === \'headers\' }" v-show="tab === \'headers\'"><headers-panel v-if="shown.headers" :d="data"></headers-panel></div>' +
      '<div class="dpanel" :class="{ active: tab === \'replay\' }" v-show="tab === \'replay\'">' +
      '<replay-panel v-if="shown.replay && data.url" :key="data.id" :d="data" @open-request="$emit(\'open-request\', $event)" @replayed="$emit(\'replayed\')"></replay-panel>' +
      '<div v-else-if="shown.replay" class="empty">该记录未保存请求 URL（旧版录制），无法重放</div>' +
      "</div>" +
      '<div class="dpanel" :class="{ active: tab === \'rewrite\' }" v-show="tab === \'rewrite\'"><rewrite-panel v-if="shown.rewrite && (data.rewrite_status === \'applied\' || data.rewrite_status === \'blocked\')" :d="data"></rewrite-panel></div>' +
      "</template>" +
      "</div>",
  };

  var LivePage = {
    components: { FlowList: FlowList, Resizer: Resizer, DetailPane: DetailPane },
    props: ["options", "sid", "rows", "inited", "selectedId", "detail", "detailLoading", "detailError"],
    emits: ["update:sid", "select", "open-request", "replayed"],
    computed: {
      emptyText: function () {
        if (!this.inited) return "等待流量…\n在 pi 中执行 /record on 开始录制";
        return "该会话暂无请求记录";
      },
    },
    template:
      "<section>" +
      '<div class="toolbar">' +
      "<select :value=\"sid || ''\" @change=\"$emit('update:sid', $event.target.value)\">" +
      '<option v-for="o in options" :key="o.value === \'\' ? \'__all\' : o.value" :value="o.value">{{ o.label }}</option>' +
      "</select>" +
      '<span class="hint">按会话分区 · SSE 实时 + 每 3 秒轮询</span>' +
      "</div>" +
      '<div class="split" style="height: calc(100% - 45px);">' +
      '<flow-list :rows="rows" :selected-id="selectedId" :empty-text="emptyText" @select="$emit(\'select\', $event)"></flow-list>' +
      "<resizer></resizer>" +
      '<detail-pane class="detail" :data="detail" :loading="detailLoading" :error="detailError" empty-text="点击左侧请求查看完整输入 / 输出" @open-request="$emit(\'open-request\', $event)" @replayed="$emit(\'replayed\')"></detail-pane>' +
      "</div>" +
      "</section>",
  };

  var HistoryPage = {
    components: { FlowList: FlowList, Resizer: Resizer, DetailPane: DetailPane },
    props: ["options", "sid", "rows", "rowsLoading", "selectedId", "detail", "detailLoading", "detailError"],
    emits: ["update:sid", "reload", "select", "open-request", "replayed"],
    computed: {
      emptyText: function () {
        if (!this.sid) return "选择一个会话";
        if (this.rowsLoading) return "加载中…";
        return "该会话没有请求记录";
      },
    },
    template:
      "<section>" +
      '<div class="toolbar">' +
      '<select :value="sid" @change="$emit(\'update:sid\', $event.target.value)">' +
      '<option v-for="o in options" :key="o.value === \'\' ? \'__none\' : o.value" :value="o.value">{{ o.label }}</option>' +
      "</select>" +
      '<button class="btn" @click="$emit(\'reload\')">刷新</button>' +
      "</div>" +
      '<div class="split" style="height: calc(100% - 45px);">' +
      '<flow-list :rows="rows" :selected-id="selectedId" :empty-text="emptyText" @select="$emit(\'select\', $event)"></flow-list>' +
      "<resizer></resizer>" +
      '<detail-pane class="detail" :data="detail" :loading="detailLoading" :error="detailError" empty-text="点击左侧请求查看完整输入 / 输出" @open-request="$emit(\'open-request\', $event)" @replayed="$emit(\'replayed\')"></detail-pane>' +
      "</div>" +
      "</section>",
  };

  var ExportPage = {
    props: ["options", "sid", "info", "href"],
    emits: ["update:sid"],
    template:
      "<section>" +
      '<div class="toolbar">' +
      '<select :value="sid" @change="$emit(\'update:sid\', $event.target.value)">' +
      '<option v-for="o in options" :key="o.value === \'\' ? \'__none\' : o.value" :value="o.value">{{ o.label }}</option>' +
      "</select>" +
      "</div>" +
      '<div id="exportBody">' +
      '<div id="exportInfo" :class="{ empty: !info }">' +
      '<template v-if="info">会话 <b>{{ info.id }}</b><br>' +
      '模型: {{ info.model || "?" }} · 请求: {{ info.req_count }} · 消息: {{ info.msg_count }}<br>' +
      '<span class="hint">导出格式：每行一个 JSON，含 request（完整 payload）与 response（配对 assistant 消息，按顺序配对）</span></template>' +
      "<template v-else>选择一个会话以导出配对数据集</template>" +
      "</div>" +
      '<a v-if="sid" id="exportBtn" class="btn" :href="href">⬇ 导出配对 JSONL（request ↔ response）</a>' +
      "</div>" +
      "</section>",
  };

  /** 改写主 tab：规则表格 + 新建/编辑表单 + jq 引擎卡片（数据由 root 加载，mutation 后 emit reload） */
  var RulesPage = {
    props: ["rules", "settings", "stateRewrite", "loading", "recording"],
    emits: ["reload"],
    data: function () {
      return {
        methods: RULE_METHODS,
        editing: false,
        form: null,
        formError: "",
        settingsForm: {
          jq_path: "",
          timeout_ms: 2000,
          serialize_handoff_ms: 10000,
          serialize_retry_grace_ms: 30000,
          serialize_max_hold_ms: 120000,
          serialize_queue_wait_ms: 60000,
        },
        settingsMsg: "",
      };
    },
    watch: {
      settings: {
        immediate: true,
        handler: function (s) {
          if (!s) return;
          this.settingsForm = {
            jq_path: s.jq_path || "",
            timeout_ms: s.timeout_ms == null ? 2000 : s.timeout_ms,
            serialize_handoff_ms: s.serialize_handoff_ms == null ? 10000 : s.serialize_handoff_ms,
            serialize_retry_grace_ms: s.serialize_retry_grace_ms == null ? 30000 : s.serialize_retry_grace_ms,
            serialize_max_hold_ms: s.serialize_max_hold_ms == null ? 120000 : s.serialize_max_hold_ms,
            serialize_queue_wait_ms: s.serialize_queue_wait_ms == null ? 60000 : s.serialize_queue_wait_ms,
          };
        },
      },
    },
    computed: {
      // v3：关联模式（§1.8）—— settings 为主，/api/state 的 rewrite 兜底
      correlationText: function () {
        var s = this.settings || {};
        var mode = s.correlation_mode || (this.stateRewrite && this.stateRewrite.correlation_mode);
        if (mode === "inactive") return "未生效（录制已关闭）";
        return mode === "exact" ? "精确（串行化生效）" : "尽力而为";
      },
      // 录制关闭导致引擎停机。recording 用 prop（SSE 实时），
      // 规则数用 settings/stateRewrite 快照；prop 缺省时按 true 处理，避免旧 payload 误报停用。
      inactiveByRecording: function () {
        if (this.recording !== false) return false;
        var s = this.settings || {};
        var rules = s.enabled_rules;
        if (rules == null && this.stateRewrite) rules = this.stateRewrite.enabled_rules;
        return (rules || 0) > 0;
      },
      // gate 计数（队列深度 / holder / 交接超时 / 旁路 / 上限）
      gate: function () {
        var s = this.settings || {};
        return s.gate || (this.stateRewrite && this.stateRewrite.gate) || null;
      },
      // V12：Codex WS 绕过检测（/api/state rewrite.codex_ws_warning，settings 兜底）
      codexWsWarning: function () {
        var s = this.settings || {};
        return !!(s.codex_ws_warning || (this.stateRewrite && this.stateRewrite.codex_ws_warning));
      },
    },
    methods: {
      matchSummary: matchSummary,
      jqSummary: jqSummary,
      ruleBad: ruleBadRegex,
      formBadRegex: function () {
        return ruleBadRegex(this.form);
      },
      startCreate: function () {
        this.formError = "";
        this.form = {
          id: null,
          name: "",
          enabled: false,
          priority: 100,
          url_pattern: "",
          method: "",
          model: "",
          body_jq: "",
          headers_jq: "",
        };
        this.editing = true;
      },
      startEdit: function (r) {
        this.formError = "";
        this.form = {
          id: r.id,
          name: r.name,
          enabled: !!r.enabled,
          priority: r.priority,
          url_pattern: r.url_pattern || "",
          method: r.method || "",
          model: r.model || "",
          body_jq: r.body_jq || "",
          headers_jq: r.headers_jq || "",
        };
        this.editing = true;
      },
      cancelEdit: function () {
        this.editing = false;
        this.form = null;
        this.formError = "";
      },
      rulePayload: function (f) {
        return {
          name: String(f.name || "").trim(),
          enabled: f.enabled ? 1 : 0,
          priority: Number(f.priority) || 0,
          url_pattern: f.url_pattern || null,
          method: f.method || null,
          model: f.model || null,
          body_jq: f.body_jq || null,
          headers_jq: f.headers_jq || null,
        };
      },
      save: function () {
        var f = this.form;
        if (!f) return;
        this.formError = "";
        if (!String(f.name || "").trim()) {
          this.formError = "name 不能为空";
          return;
        }
        if (f.url_pattern) {
          try {
            new RegExp(f.url_pattern);
          } catch (e) {
            this.formError = "url_pattern 正则无法编译: " + e.message;
            return;
          }
        }
        var self = this;
        fetch(api(f.id == null ? "/api/rewrite/rules" : "/api/rewrite/rules/" + f.id), {
          method: f.id == null ? "POST" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.rulePayload(f)),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (out) {
            if (out && out.error) {
              self.formError = "保存失败: " + out.error;
              return;
            }
            self.editing = false;
            self.form = null;
            self.$emit("reload");
          })
          .catch(function (e) {
            self.formError = "保存失败: " + String((e && e.message) || e);
          });
      },
      remove: function (r) {
        if (!window.confirm("删除规则「" + r.name + "」？")) return;
        var self = this;
        fetch(api("/api/rewrite/rules/" + r.id), { method: "DELETE" })
          .then(function () {
            self.$emit("reload");
          })
          .catch(function () {});
      },
      /** enabled 复选框：点击即全量 PUT（服务端契约 PUT 为全量更新） */
      toggle: function (r) {
        var self = this;
        fetch(api("/api/rewrite/rules/" + r.id), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: r.name,
            enabled: r.enabled ? 0 : 1,
            priority: r.priority,
            url_pattern: r.url_pattern,
            method: r.method,
            model: r.model,
            body_jq: r.body_jq,
            headers_jq: r.headers_jq,
          }),
        })
          .then(function () {
            self.$emit("reload");
          })
          .catch(function () {});
      },
      saveSettings: function () {
        var self = this;
        this.settingsMsg = "";
        fetch(api("/api/rewrite/settings"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jq_path: this.settingsForm.jq_path,
            timeout_ms: Number(this.settingsForm.timeout_ms) || 2000,
            serialize_handoff_ms: Number(this.settingsForm.serialize_handoff_ms) || 10000,
            serialize_retry_grace_ms: Number(this.settingsForm.serialize_retry_grace_ms) || 30000,
            serialize_max_hold_ms: Number(this.settingsForm.serialize_max_hold_ms) || 120000,
            serialize_queue_wait_ms: Number(this.settingsForm.serialize_queue_wait_ms) || 60000,
          }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (out) {
            self.settingsMsg = out && out.error ? "保存失败: " + out.error : "已保存";
            self.$emit("reload");
          })
          .catch(function (e) {
            self.settingsMsg = "保存失败: " + String((e && e.message) || e);
          });
      },
    },
    template:
      "<section>" +
      '<div class="toolbar">' +
      '<button class="btn" @click="startCreate">+ 新建规则</button>' +
      '<button class="btn" @click="$emit(\'reload\')">刷新</button>' +
      '<span class="hint">命中规则按 priority 从小到大依次叠加 · 改写经本机 jq 子进程执行（jq ≥ 1.6）</span>' +
      "</div>" +
      '<div class="rw-body">' +
      '<div class="rw-card">' +
      "<h3>jq 引擎</h3>" +
      '<template v-if="settings">' +
      '<div class="rw-row"><label>jq 路径（留空 = 从 PATH 查找）</label><input type="text" v-model="settingsForm.jq_path" placeholder="jq"></div>' +
      '<div class="rw-row"><label>超时（毫秒，100–60000）</label><input type="text" v-model="settingsForm.timeout_ms"></div>' +
      // v3：串行化闸门参数收进折叠「高级」区（§3.9 范围由服务端校验，越界 400）
      '<details class="rw-adv"><summary>高级（串行化闸门参数，毫秒）</summary>' +
      '<div class="rw-row"><label>交接超时 serialize_handoff_ms（1000–60000）：hook 拿锁后无 fetch 的看门狗</label><input type="text" v-model="settingsForm.serialize_handoff_ms"></div>' +
      '<div class="rw-row"><label>重试宽限 serialize_retry_grace_ms（1000–120000）：可重试状态后保留槽位等待 retry</label><input type="text" v-model="settingsForm.serialize_retry_grace_ms"></div>' +
      '<div class="rw-row"><label>持有上限 serialize_max_hold_ms（5000–600000）：槽位绝对持有上限</label><input type="text" v-model="settingsForm.serialize_max_hold_ms"></div>' +
      '<div class="rw-row"><label>等待上限 serialize_queue_wait_ms（1000–300000）：排队超时后旁路放行（归属降级）</label><input type="text" v-model="settingsForm.serialize_queue_wait_ms"></div>' +
      "</details>" +
      '<div class="rw-engine">版本: {{ settings.jq_version || "未知" }} · <span :class="settings.jq_available ? \'rw-ok\' : \'rw-bad\'">{{ settings.jq_available ? "可用" : "不可用" }}</span> · 关联模式: {{ correlationText }}</div>' +
      '<div v-if="gate" class="rw-engine">串行化闸门: 队列 {{ gate.queueDepth != null ? gate.queueDepth : 0 }} · 持有 {{ gate.holderId != null ? "#" + gate.holderId : "无" }} · 交接超时 {{ gate.gateNoFetch != null ? gate.gateNoFetch : 0 }} · 旁路 {{ gate.gateBypassed != null ? gate.gateBypassed : 0 }} · 上限 {{ gate.gateTimeouts != null ? gate.gateTimeouts : 0 }}</div>' +
      '<div v-if="settings.db_error" class="rw-err">数据库错误（改写引擎已停用，请求放行）: {{ settings.db_error }}</div>' +
      // 录制关闭 = 改写引擎整体停机（含重放）。有启用规则却不生效时必须说明，否则用户会以为规则在工作。
      '<div v-if="inactiveByRecording" class="rw-err">录制已关闭：改写引擎不介入，provider 请求与重放均原样放行。在 pi 中执行 /record on 启用改写。</div>' +
      '<div v-if="codexWsWarning" class="rw-err">Codex WebSocket 传输绕过改写，请将 transport 设为 sse</div>' +
      '<div class="rw-actions"><button class="btn" @click="saveSettings">保存引擎配置</button><span class="hint">{{ settingsMsg }}</span></div>' +
      "</template>" +
      '<div v-else class="empty">加载中…</div>' +
      "</div>" +
      '<div class="rw-card">' +
      "<h3>规则（{{ rules.length }}）</h3>" +
      '<table class="rw-table">' +
      "<thead><tr><th>启用</th><th>priority</th><th>名称</th><th>匹配条件</th><th>jq</th><th>操作</th></tr></thead>" +
      "<tbody>" +
      '<tr v-for="r in rules" :key="r.id" :class="{ bad: ruleBad(r) }">' +
      '<td><input type="checkbox" :checked="!!r.enabled" @change="toggle(r)"></td>' +
      "<td>{{ r.priority }}</td>" +
      '<td class="rw-name">{{ r.name }}</td>' +
      '<td class="rw-sum">{{ matchSummary(r) }}<span v-if="ruleBad(r)" class="rw-bad">（表达式非法，运行时已跳过）</span></td>' +
      '<td class="rw-sum">{{ jqSummary(r) }}</td>' +
      '<td class="rw-ops"><button class="btn" @click="startEdit(r)">编辑</button><button class="btn" @click="remove(r)">删除</button></td>' +
      "</tr>" +
      '<tr v-if="!rules.length"><td colspan="6" class="empty">{{ loading ? "加载中…" : "暂无规则，点击「+ 新建规则」创建" }}</td></tr>' +
      "</tbody></table>" +
      "</div>" +
      '<div v-if="editing" class="rw-card">' +
      "<h3>{{ form.id == null ? '新建规则' : '编辑规则 #' + form.id }}</h3>" +
      '<div class="rw-row"><label>名称（必填）</label><input type="text" v-model="form.name"></div>' +
      '<div class="rw-row"><label>priority（整数，小的先执行）</label><input type="text" v-model="form.priority"></div>' +
      '<div class="rw-row"><label>url_pattern（JS 正则，留空 = 匹配全部）</label><input type="text" v-model="form.url_pattern" :class="{ bad: formBadRegex() }" placeholder="例: /v1/messages$"></div>' +
      '<div class="rw-row"><label>method（留空 = 全部）</label><select v-model="form.method"><option v-for="m in methods" :key="m || \'__any\'" :value="m">{{ m || "（全部）" }}</option></select></div>' +
      '<div class="rw-row"><label>model（子串匹配，留空 = 全部）</label><input type="text" v-model="form.model" placeholder="例: claude"></div>' +
      '<div class="rw-row"><label>body_jq（jq 表达式，留空 = 不改请求体）</label><textarea v-model="form.body_jq" spellcheck="false" placeholder="例: .temperature = 0"></textarea><span class="hint">只填 jq 表达式本身，不要包 shell 外壳。写 <code>.temperature = 0</code>，不要写 <code>jq \'.temperature = 0\'</code>（单引号在 jq 语言里非法，保存时会被拒绝）。</span></div>' +
      '<div class="rw-row"><label>headers_jq（jq 表达式，留空 = 不改 header）</label><textarea v-model="form.headers_jq" spellcheck="false" placeholder="例: .[\"x-trace\"] = \"1\""></textarea><span class="hint">header 已归一化为小写键的 JSON 对象；同样只填表达式本身。</span></div>' +
      '<div class="rw-row"><label><input type="checkbox" v-model="form.enabled"> 启用</label></div>' +
      '<div v-if="formError" class="rw-err">{{ formError }}</div>' +
      '<div class="rw-actions"><button class="btn" @click="save">保存</button><button class="btn" @click="cancelEdit">取消</button></div>' +
      "</div>" +
      "</div>" +
      "</section>",
  };

  // ---------- 根组件：状态集中 ----------

  var App = {
    components: {
      AppHeader: AppHeader,
      LivePage: LivePage,
      HistoryPage: HistoryPage,
      ExportPage: ExportPage,
      RulesPage: RulesPage,
    },
    setup: function () {
      var activeTab = ref("live");
      var recording = ref(false);
      var sseText = ref("连接中…");
      var sseOk = ref(null);
      var currentSid = ref("");
      var sessions = ref([]);

      // live：sid 初始为 null（未初始化），首次 loadSessions 后默认落到当前会话
      var liveSid = ref(null);
      var liveRows = ref([]);
      var liveInited = ref(false);
      var liveSelectedId = ref(null);
      var liveDetail = ref(null);
      var liveDetailLoading = ref(false);
      var liveDetailError = ref("");

      var historySid = ref("");
      var historyRows = ref([]);
      var historyRowsLoading = ref(false);
      var historySelectedId = ref(null);
      var historyDetail = ref(null);
      var historyDetailLoading = ref(false);
      var historyDetailError = ref("");

      var exportSid = ref("");
      var exportInfo = ref(null);

      // 改写页与全局 toast
      var rules = ref([]);
      var rulesLoading = ref(false);
      var rewriteSettings = ref(null);
      // v3：/api/state 的 rewrite 块（correlation_mode / gate / codex_ws_warning 等），DB 故障时可能缺失
      var rewriteInfo = ref(null);
      var toasts = ref([]); // {id, kind:'error'|'warn', text}
      var toastSeq = 0;
      function pushToast(kind, text) {
        toastSeq += 1;
        var id = toastSeq;
        toasts.value = toasts.value.concat([{ id: id, kind: kind, text: text }]);
        setTimeout(function () {
          toasts.value = toasts.value.filter(function (t) {
            return t.id !== id;
          });
        }, 5000);
      }

      var liveSig = null; // 列表内容签名，避免无谓重渲染
      var liveGen = 0; // in-flight 代次：旧响应不得覆盖新列表
      var historyGen = 0;
      var historyLoadedSid = null; // 上次成功加载的会话：切会话时清空旧列表进入加载态
      var detailGens = { live: 0, history: 0 }; // 详情拉取代次：防快速点击时晚响应覆盖

      // ---- 会话选择器选项 ----
      function sessionLabel(s) {
        return (
          (s.started_at || "").replace("T", " ").slice(0, 19) +
          " · " +
          (s.model || "?") +
          " · " +
          s.req_count +
          " 请求 / " +
          s.msg_count +
          " 消息 · " +
          s.id.slice(0, 8)
        );
      }
      var liveOptions = computed(function () {
        var opts = [{ value: "", label: "全部会话" }].concat(
          sessions.value.map(function (s) {
            return { value: s.id, label: sessionLabel(s) + (s.id === currentSid.value ? " ← 当前" : "") };
          }),
        );
        // 当前会话暂无记录时的临时选项
        if (
          currentSid.value &&
          !sessions.value.some(function (s) {
            return s.id === currentSid.value;
          })
        ) {
          opts.push({ value: currentSid.value, label: "当前会话（暂无记录）· " + currentSid.value.slice(0, 8) });
        }
        return opts;
      });
      var sessionOptions = computed(function () {
        return [{ value: "", label: "选择会话（" + sessions.value.length + " 个）" }].concat(
          sessions.value.map(function (s) {
            return { value: s.id, label: sessionLabel(s) };
          }),
        );
      });

      // 选择器保留规则：实时页保留旧选择、失效回退当前会话；历史/导出仅尝试恢复，失效置空
      watch([sessions, currentSid], function () {
        var valid = liveOptions.value.some(function (o) {
          return o.value === liveSid.value;
        });
        if (liveSid.value === null || !valid) liveSid.value = currentSid.value || "";
        var sids = sessions.value.map(function (s) {
          return s.id;
        });
        if (historySid.value && sids.indexOf(historySid.value) < 0) historySid.value = "";
        if (exportSid.value && sids.indexOf(exportSid.value) < 0) exportSid.value = "";
      });

      // ---- 数据加载 ----
      function loadState() {
        return fetch(api("/api/state"))
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            recording.value = !!d.recording;
            currentSid.value = d.sessionId || "";
            rewriteInfo.value = d.rewrite || null;
          })
          .catch(function () {});
      }
      function loadSessions() {
        return fetch(api("/api/sessions"))
          .then(function (r) {
            return r.json();
          })
          .then(function (rows) {
            sessions.value = rows;
          })
          .catch(function () {});
      }
      function refreshLive(force) {
        var sid = liveSid.value || "";
        var url = sid
          ? api("/api/requests?session_id=" + encodeURIComponent(sid) + "&limit=300")
          : api("/api/requests?limit=300");
        var gen = ++liveGen;
        fetch(url)
          .then(function (r) {
            return r.json();
          })
          .then(function (rows) {
            if (gen !== liveGen) return;
            var sig = rows
              .map(function (x) {
                return x.id + ":" + (x.status == null ? "p" : x.status);
              })
              .join(",");
            if (!force && sig === liveSig) return;
            liveSig = sig;
            liveRows.value = rows;
            liveInited.value = true;
            if (
              liveSelectedId.value != null &&
              !rows.some(function (r) {
                return r.id === liveSelectedId.value;
              })
            ) {
              liveSelectedId.value = null;
              liveDetail.value = null;
            }
          })
          .catch(function () {});
      }
      function loadHistoryFlows() {
        var sid = historySid.value;
        var gen = ++historyGen; // 无论分支先递增代次：旧响应不得落库
        if (!sid) {
          historyRows.value = [];
          historyRowsLoading.value = false;
          historyLoadedSid = null;
          historySelectedId.value = null;
          historyDetail.value = null;
          return;
        }
        if (sid !== historyLoadedSid) {
          // 切换会话：清空旧列表/选中态，显示「加载中…」（同会话刷新则保留，避免闪烁）
          historyRows.value = [];
          historySelectedId.value = null;
          historyDetail.value = null;
        }
        historyRowsLoading.value = true;
        fetch(api("/api/requests?session_id=" + encodeURIComponent(sid) + "&limit=500"))
          .then(function (r) {
            return r.json();
          })
          .then(function (rows) {
            if (gen !== historyGen) return;
            historyLoadedSid = sid;
            historyRows.value = rows;
            historyRowsLoading.value = false;
            if (
              historySelectedId.value != null &&
              !rows.some(function (r) {
                return r.id === historySelectedId.value;
              })
            ) {
              historySelectedId.value = null;
              historyDetail.value = null;
            }
          })
          .catch(function () {
            if (gen === historyGen) historyRowsLoading.value = false;
          });
      }
      function loadDetail(kind, id) {
        var gen = ++detailGens[kind];
        var detailRef = kind === "live" ? liveDetail : historyDetail;
        var loadingRef = kind === "live" ? liveDetailLoading : historyDetailLoading;
        var errorRef = kind === "live" ? liveDetailError : historyDetailError;
        detailRef.value = null;
        errorRef.value = "";
        loadingRef.value = true;
        fetch(api("/api/requests/" + id))
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            if (gen !== detailGens[kind]) return;
            detailRef.value = d;
            loadingRef.value = false;
          })
          .catch(function (e) {
            if (gen !== detailGens[kind]) return;
            errorRef.value = String((e && e.message) || e);
            loadingRef.value = false;
          });
      }
      function selectFlow(kind, id) {
        (kind === "live" ? liveSelectedId : historySelectedId).value = id;
        loadDetail(kind, id);
      }
      // 「查看新记录」：选中新行 + 拉详情 + 刷新列表让新行出现
      function openRequest(kind, id) {
        selectFlow(kind, id);
        if (kind === "live") refreshLive(true);
        else loadHistoryFlows();
      }

      watch(liveSid, function () {
        liveSig = null; // 分区切换后签名基线失效
        refreshLive(true);
      });
      watch(historySid, function () {
        loadHistoryFlows();
      });
      watch(exportSid, function (sid) {
        if (!sid) {
          exportInfo.value = null;
          return;
        }
        fetch(api("/api/sessions"))
          .then(function (r) {
            return r.json();
          })
          .then(function (rows) {
            if (exportSid.value !== sid) return;
            exportInfo.value =
              rows.find(function (x) {
                return x.id === sid;
              }) || null;
          })
          .catch(function () {});
      });
      // ---- 改写规则 / 引擎设置（tab 激活或 SSE rewrite_rules 时加载） ----
      function loadRules() {
        rulesLoading.value = true;
        return fetch(api("/api/rewrite/rules"))
          .then(function (r) {
            return r.json();
          })
          .then(function (rows) {
            rules.value = Array.isArray(rows) ? rows : [];
            rulesLoading.value = false;
          })
          .catch(function () {
            rulesLoading.value = false;
          });
      }
      function loadSettings() {
        return fetch(api("/api/rewrite/settings"))
          .then(function (r) {
            return r.json();
          })
          .then(function (s) {
            rewriteSettings.value = s;
          })
          .catch(function () {});
      }
      function reloadRewrite() {
        loadRules();
        loadSettings();
      }
      watch(activeTab, function (t) {
        if (t === "rules") reloadRewrite();
      });

      var exportHref = computed(function () {
        return exportSid.value ? api("/api/export?session_id=" + encodeURIComponent(exportSid.value)) : "#";
      });

      // ---- SSE ----
      var es = null;
      function connectSse() {
        es = new EventSource(api("/api/events"));
        es.onopen = function () {
          sseText.value = "SSE 已连接";
          sseOk.value = true;
        };
        es.onerror = function () {
          sseText.value = "SSE 重连中…";
          sseOk.value = false;
        };
        es.onmessage = function (ev) {
          var d;
          try {
            d = JSON.parse(ev.data);
          } catch (e) {
            return;
          }
          if (d.type === "state") {
            recording.value = !!d.recording;
            if (d.rewrite) rewriteInfo.value = d.rewrite;
            // 会话切换（/clear、/new、/resume、fork）：若正在看当前会话，自动跟随
            if (d.sessionId && d.sessionId !== currentSid.value) {
              var wasFollowing = liveSid.value === currentSid.value;
              currentSid.value = d.sessionId;
              loadSessions().then(function () {
                if (wasFollowing) {
                  liveSid.value = currentSid.value;
                  refreshLive(true);
                }
              });
            }
          } else if (d.type === "request" || d.type === "response") {
            var sid = liveSid.value || "";
            if (!sid || d.session_id === sid) refreshLive(false);
          } else if (d.type === "rewrite_rules") {
            reloadRewrite();
          } else if (
            d.type === "rewrite_error" ||
            d.type === "rewrite_warn" ||
            d.type === "gate_warn" ||
            d.type === "record_warn"
          ) {
            // 只渲染服务端给的安全字段（kind/rule_name/reason/message），绝不渲染原始 stderr
            var parts = [];
            if (d.rule_name) parts.push("规则「" + d.rule_name + "」");
            if (d.kind) parts.push(d.kind);
            if (d.reason) parts.push(String(d.reason));
            if (d.message) parts.push(d.message);
            pushToast(d.type === "rewrite_error" ? "error" : "warn", parts.join(" · ") || d.type);
          }
          // type === 'stream'：不刷新列表（现状语义）
        };
      }

      // ---- 生命周期：SSE 与轮询集中在 root，隐藏页面不重复订阅 ----
      var pollTimer = null;
      var sessionTimer = null;
      onMounted(function () {
        applyTheme(themeMode.value);
        var savedListW = parseInt(localStorage.getItem("recordListW") || "", 10);
        if (savedListW >= 140) document.documentElement.style.setProperty("--list-w", savedListW + "px");
        loadState()
          .then(loadSessions)
          .then(function () {
            refreshLive(true);
          });
        connectSse();
        pollTimer = setInterval(function () {
          refreshLive(false);
        }, 3000); // 轮询兜底：覆盖其他进程写入的会话
        sessionTimer = setInterval(loadSessions, 15000); // 新会话自动出现在选择器中
      });
      onUnmounted(function () {
        if (es) es.close();
        if (pollTimer !== null) clearInterval(pollTimer);
        if (sessionTimer !== null) clearInterval(sessionTimer);
      });

      return {
        activeTab: activeTab,
        recording: recording,
        sseText: sseText,
        sseOk: sseOk,
        themeMode: themeMode,
        cycleTheme: cycleTheme,
        liveOptions: liveOptions,
        sessionOptions: sessionOptions,
        liveSid: liveSid,
        liveRows: liveRows,
        liveInited: liveInited,
        liveSelectedId: liveSelectedId,
        liveDetail: liveDetail,
        liveDetailLoading: liveDetailLoading,
        liveDetailError: liveDetailError,
        historySid: historySid,
        historyRows: historyRows,
        historyRowsLoading: historyRowsLoading,
        historySelectedId: historySelectedId,
        historyDetail: historyDetail,
        historyDetailLoading: historyDetailLoading,
        historyDetailError: historyDetailError,
        exportSid: exportSid,
        exportInfo: exportInfo,
        exportHref: exportHref,
        rules: rules,
        rulesLoading: rulesLoading,
        rewriteSettings: rewriteSettings,
        rewriteInfo: rewriteInfo,
        toasts: toasts,
        reloadRewrite: reloadRewrite,
        refreshLive: refreshLive,
        loadSessions: loadSessions,
        loadHistoryFlows: loadHistoryFlows,
        selectFlow: selectFlow,
        openRequest: openRequest,
      };
    },
    template:
      '<app-header :recording="recording" :sse-text="sseText" :sse-ok="sseOk" :active-tab="activeTab" :theme-mode="themeMode" :correlation-mode="rewriteInfo && rewriteInfo.correlation_mode" @tab="activeTab = $event" @theme="cycleTheme"></app-header>' +
      "<main>" +
      '<live-page v-show="activeTab === \'live\'" id="pane-live" class="pane" :class="{ active: activeTab === \'live\' }" :options="liveOptions" :sid="liveSid" :rows="liveRows" :inited="liveInited" :selected-id="liveSelectedId" :detail="liveDetail" :detail-loading="liveDetailLoading" :detail-error="liveDetailError" @update:sid="liveSid = $event" @select="selectFlow(\'live\', $event)" @open-request="openRequest(\'live\', $event)" @replayed="refreshLive(true)"></live-page>' +
      '<history-page v-show="activeTab === \'history\'" id="pane-history" class="pane" :class="{ active: activeTab === \'history\' }" :options="sessionOptions" :sid="historySid" :rows="historyRows" :rows-loading="historyRowsLoading" :selected-id="historySelectedId" :detail="historyDetail" :detail-loading="historyDetailLoading" :detail-error="historyDetailError" @update:sid="historySid = $event" @reload="loadSessions(); loadHistoryFlows()" @select="selectFlow(\'history\', $event)" @open-request="openRequest(\'history\', $event)" @replayed="loadHistoryFlows()"></history-page>' +
      '<export-page v-show="activeTab === \'export\'" id="pane-export" class="pane" :class="{ active: activeTab === \'export\' }" :options="sessionOptions" :sid="exportSid" :info="exportInfo" :href="exportHref" @update:sid="exportSid = $event"></export-page>' +
      '<rules-page v-show="activeTab === \'rules\'" id="pane-rules" class="pane" :class="{ active: activeTab === \'rules\' }" :rules="rules" :settings="rewriteSettings" :state-rewrite="rewriteInfo" :loading="rulesLoading" :recording="recording" @reload="reloadRewrite"></rules-page>' +
      "</main>" +
      // 全局 toast（rewrite_error / rewrite_warn / gate_warn / record_warn）：任何 tab 可见，5s 自动消隐
      '<div class="toasts">' +
      '<div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>' +
      "</div>",
  };

  createApp(App).mount("#app");
})(
  typeof window !== "undefined" ? window : undefined,
  typeof document !== "undefined" ? document : undefined,
  typeof localStorage !== "undefined" ? localStorage : undefined,
  typeof fetch !== "undefined" ? fetch : undefined,
  typeof EventSource !== "undefined" ? EventSource : undefined,
  typeof setInterval !== "undefined" ? setInterval : undefined,
  typeof clearInterval !== "undefined" ? clearInterval : undefined,
  typeof Vue !== "undefined" ? Vue : undefined,
);
