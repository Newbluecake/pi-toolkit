/**
 * 会话标题模型生成（任务 #12，用户拍板）：会话没有名字时，用首条用户消息
 * 请一个便宜快模型生成 ≤20 字标题，经 `setSessionName` 落档——TUI resume
 * 列表和 web-hub 列表/详情读的都是 session name，因此自动受益。
 *
 * 本文件是纯核心（无 pi import）：sanitize/prompt 是纯函数，触发状态机
 * `createTitleTrigger` 只依赖注入端口（模型解析 + completion + 读写名字 +
 * sleep/timeout 信号），测试用假端口逐条钉触发矩阵。pi 侧装配在 index.ts。
 *
 * 触发时机：`before_agent_start`（首条用户消息已展开、agent 循环尚未开始）
 * ——标题生成与首轮回答并行，标题最早落地；handler 内只做同步门检，生成
 * 本体 fire-and-forget（goal/hook.ts R1 同款：await 会阻塞 pi 事件泵）。
 *
 * 不变量：
 * - 只生成一次：`attempted` 闩锁在同步段置位（JS 单线程内无竞态）；
 *   `session_start`（new/resume/fork/reload）重置闩锁——主进程不重激活扩展
 *   就能切会话，新会话理应重新获得命名机会。
 * - session 已有名字（用户 /name 过或已生成过）⇒ 跳过；生成成功写入后不再改。
 * - 写入前重读名字：生成期间用户 /name 了就以用户为准，我们的标题作废。
 * - 失败静默：网络/429/超时（每次尝试 10s 硬上限）最多 2 次尝试后放弃，
 *   不 retry 风暴、不抛出、不告警——标题是纯增值，绝不能打断主会话。
 * - 子会话（print 模式）不触发：装配在 src/index.ts 的 post-guard 区
 *   （HOST_KEY 之后，结构上仅主会话可达），wireTitle 仍防御性自查
 *   isChildSession（双保险，可测）。
 */

/** 首条用户消息喂给模型前的截断（前 2000 字符，码点安全）。 */
export const TITLE_INPUT_MAX_CHARS = 2_000;
/** sanitize 后的标题硬上限（规格 ≤60 字符，模型目标 ≤20 字）。 */
export const TITLE_MAX_CHARS = 60;
/** 单次 completion 的硬超时（规格 10s）。AbortSignal.timeout 内部不占事件循环。 */
export const TITLE_TIMEOUT_MS = 10_000;
/** 失败后最多重试到总共 2 次尝试（规格「最多 2 次」，无风暴）。 */
export const TITLE_MAX_ATTEMPTS = 2;
/** 两次尝试间的退避（429 场景给服务端一口气；测试注入假 sleep）。 */
export const TITLE_RETRY_DELAY_MS = 1_000;
/** completion maxTokens：标题本体 ≤60 字，余量给推理模型的 thinking token。 */
export const TITLE_MAX_TOKENS = 512;

/** strict `provider/id`（与 config/model-hint.ts 同形）。 */
export interface TitleModelRef {
  provider: string;
  id: string;
}

/**
 * 标题生成端口。`M` 是不透明的模型句柄（pi 侧是 pi-ai 的 `Model<Api>`），
 * 由装配层用 `ctx.modelRegistry` 实现；核心不 import pi。
 */
export interface TitlePorts<M> {
  /** 当前 session 名字；undefined = 未命名。 */
  getSessionName(): string | undefined;
  /** 写入 session 名字（pi 侧 appendSessionInfo 立即持久化）。 */
  setSessionName(name: string): void;
  /** strict ref → 模型句柄（ctx.modelRegistry.find）。 */
  findModel(ref: TitleModelRef): M | undefined;
  /** 当前会话模型（settings.model 解析失败时的回落）。 */
  currentModel(): M | undefined;
  /** 一次性 completion：成功 resolve 文本，任何失败 reject。 */
  complete(model: M, request: TitleCompletionRequest): Promise<string>;
  /** 可注入退避（默认真实 setTimeout；测试用假时钟）。 */
  sleep(ms: number): Promise<void>;
  /** 可注入超时信号（默认 AbortSignal.timeout）。 */
  timeoutSignal(ms: number): AbortSignal;
  /**
   * 当前会话身份（ctx.sessionManager.getSessionId()）：触发时快照、落笔前复验，
   * 生成在途用户 /new /resume 切了会话就作废晚到的标题（否则会写到新会话头上）。
   * 返回 undefined = 无身份可验（跳过该守卫）。
   */
  sessionKey(): string | undefined;
}

export interface TitleCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  maxTokens: number;
}

/** 触发器配置：标题模型 strict ref；undefined = 跟随会话模型（空串哨兵/解析失败）。 */
export interface TitleTriggerOptions {
  modelRef?: TitleModelRef;
}

/**
 * 标题 sanitize 纯函数（规格：去换行/首尾空白/截断 60 字符硬上限；输出
 * 契约：无标点无引号无换行）。
 *
 * 步骤（每步都可能把字符串洗成空串，空串 = 无效标题）：
 * 1. 有界 fixpoint（≤4 轮）：剥模型常见前缀标签（`标题：`/`Title:`）→
 *    空白折叠（含换行/制表变单个空格）→ 剥首尾包裹符（`“”‘’「」『』《》"'`
 *    + `` ` `` + `*_`）交替剥——指令服从再好的模型也会偶尔加标签，
 *    `**标题：x**` 这类双层包裹要剥到裸标题；
 * 2. 剥首尾标点尾巴（句读类：。．.，、！!？?；;：:…~～-—_）——标题在
 *    列表里以句读结尾很难看；内部标点保留（`don't`、`C++` 不被误伤）；
 * 3. 码点安全截断到 60 字符。
 */
export function sanitizeTitle(raw: string): string {
  let text = raw;
  // 1-3. 有界 fixpoint：前缀标签（`标题：`/`Title:`）→ 空白折叠（换行变空格，
  //    规格「无换行」）→ 首尾包裹符（`“”‘’「」『』《》"'` + ` + *_）交替剥，
  //    `**标题：x**` 这类双层包裹也能剥到裸标题（标签在包裹里/包裹在标签里都成立）。
  const wrap = /^[“”‘’「」『』《》"'`*_]+|[“”‘’「」『』《》"'`*_]+$/g;
  for (let round = 0; round < 4; round++) {
    let next = text.replace(/^\s*(?:标题|题目|title|subject)\s*[:：]\s*/i, "");
    next = next.replace(/\s+/g, " ").trim();
    next = next.replace(wrap, "").trim();
    if (next === text) break;
    text = next;
  }
  // 4. 首尾句读尾巴。
  text = text.replace(/^[。．.，、！!？?；;：:…~～\-—_]+|[。．.，、！!？?；;：:…~～\-—_]+$/g, "").trim();
  // 5. 码点安全硬截断。
  const chars = Array.from(text);
  if (chars.length > TITLE_MAX_CHARS) text = chars.slice(0, TITLE_MAX_CHARS).join("");
  return text.trim();
}

/**
 * 标题 prompt（纯函数）。system 钉输出契约（≤20 字、用户语言、无标点引号
 * 换行、无前缀标签、只输出标题本身）；user 是截断到前 2000 字符的首条
 * 用户消息（码点安全）。
 */
export function buildTitlePrompt(firstUserMessage: string): { systemPrompt: string; userPrompt: string } {
  const truncated = Array.from(firstUserMessage.trim()).slice(0, TITLE_INPUT_MAX_CHARS).join("");
  return {
    systemPrompt: [
      "You generate a short session title from the user's first message.",
      `Rules: at most 20 characters (CJK) or 6 words (English); same language as the message;`,
      "no punctuation, no quotes, no markdown, no line breaks, no prefix like Title:;",
      "plain text title only — nothing else.",
    ].join(" "),
    userPrompt: truncated,
  };
}

/** 触发状态机：before_agent_start 门检 + fire-and-forget 生成。 */
export interface TitleTrigger {
  /** before_agent_start handler 本体（同步门检，绝不 await 生成）。 */
  onBeforeAgentStart(prompt: string): void;
  /** session_start handler：重置一次性别子（新会话重新获得机会）。 */
  onSessionStart(): void;
}

export function createTitleTrigger<M>(ports: TitlePorts<M>, options: TitleTriggerOptions): TitleTrigger {
  let attempted = false;

  const generate = async (firstUserMessage: string, originKey: string | undefined): Promise<void> => {
    // 模型解析：配置的 strict ref → registry；找不到（异机没有该 provider）回落
    // 当前会话模型；连会话模型都没有（无凭据环境）就静默放弃。
    let model: M | undefined;
    try {
      model = (options.modelRef ? ports.findModel(options.modelRef) : undefined) ?? ports.currentModel();
    } catch {
      model = undefined; // 防御：registry 读失败按未解析处理
    }
    if (!model) return;

    const { systemPrompt, userPrompt } = buildTitlePrompt(firstUserMessage);
    for (let attempt = 1; attempt <= TITLE_MAX_ATTEMPTS; attempt++) {
      const moreAttempts = attempt < TITLE_MAX_ATTEMPTS;
      let raw: string;
      try {
        raw = await ports.complete(model, {
          systemPrompt,
          userPrompt,
          signal: ports.timeoutSignal(TITLE_TIMEOUT_MS),
          maxTokens: TITLE_MAX_TOKENS,
        });
      } catch {
        // 网络/429/超时/任何失败：静默，退避一次后进入下一次尝试或放弃。
        if (moreAttempts) await ports.sleep(TITLE_RETRY_DELAY_MS).catch(() => undefined);
        continue;
      }
      const title = sanitizeTitle(raw);
      if (!title) {
        // 洗成空串（模型只回了标签/空白）按失败计。
        if (moreAttempts) await ports.sleep(TITLE_RETRY_DELAY_MS).catch(() => undefined);
        continue;
      }
      // 写入前重读：生成期间用户 /name 了就以用户为准；生成在途切了会话
      // （/new /resume）就作废——否则晚到的标题会写到新会话头上。
      let current: string | undefined;
      try {
        current = ports.getSessionName();
      } catch {
        current = undefined;
      }
      if (current) return;
      let keyNow: string | undefined;
      let keyChecked = false;
      try {
        keyNow = ports.sessionKey();
        keyChecked = true;
      } catch {
        keyNow = undefined;
      }
      if (keyChecked && originKey !== undefined && keyNow !== originKey) return;
      try {
        ports.setSessionName(title);
      } catch {
        // 写名字失败（会话正在关闭等）：静默，不重试。
      }
      return;
    }
    // 两次尝试耗尽：静默放弃（规格：不 retry 风暴）。
  };

  return {
    onBeforeAgentStart(prompt: string): void {
      // 同步段完成全部门检 + 置闩：同事件二次触发（steer 等）无竞态。
      if (attempted) return;
      let named: string | undefined;
      try {
        named = ports.getSessionName();
      } catch {
        named = undefined;
      }
      if (named) return; // 用户 /name 过或已生成过
      const trimmed = prompt.trim();
      if (!trimmed) return; // 空首条（理论上不会，防御）
      attempted = true;
      let originKey: string | undefined;
      try {
        originKey = ports.sessionKey();
      } catch {
        originKey = undefined;
      }
      void generate(trimmed, originKey).catch(() => {
        // generate 自身已全捕获；这里只兜未预期路径，保持 fire-and-forget 永不 reject。
      });
    },
    onSessionStart(): void {
      attempted = false;
    },
  };
}
