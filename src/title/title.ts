/**
 * 会话标题模型生成 v2（任务 #12 + v2 随任务动态刷新，用户拍板，r1 评审裁定覆盖
 * 全部冲突口径）：
 *
 * 1. 首标：会话未命名时，`before_agent_start`（首条用户消息已展开、agent 循环
 *    尚未开始）立即用一个便宜模型生成 ≤20 字标题并 `setSessionName` 落档——
 *    标题生成与首轮回答并行，标题最早落地。
 * 2. 刷新：`agent_settled`（run 完全收尾、无 retry/压缩/续跑待决）按里程碑
 *    （新增用户输入数 / 累计运行时长）把标题刷新到当前任务焦点，但只刷新
 *    "自己写的"标题——用户 /name 过的标题永久不再动。
 *
 * 本文件是纯核心（无 pi import）：sanitize/prompt 是纯函数，触发状态机
 * `createTitleTrigger` 只依赖注入端口（模型解析 + completion + 读写名字/
 * 记录 + sleep/timeout/时钟信号），测试用假端口逐条钉触发矩阵。pi 侧装配
 * 在 index.ts（文本提取、所有权记录读写都是端口实现，核心只做决策）。
 *
 * 状态模型（r1 唯一口径，全部收敛为「内存计数 + 会话级自有记录」，删去
 * branch 重建与持久基线——标题是纯增值功能，一切异常都向「少刷新/停止
 * 刷新」的安全方向退化，不追求跨 reload 精确）：
 * - 内存（闭包内，per-wiring）：`inputsSinceGen`（自上次生成后的
 *   before_agent_start 次数）、`inputSeq`（单调递增，每次 before_agent_start
 *   +1，不随 session_start 清零——纯粹用于过期结果检测）、`busyMs`（累计运行
 *   时长）、`runStartedAt`、`lastRunOk`、`epoch`（session_start/session_shutdown
 *   各 +1）、`inFlight`（AbortController|undefined，单实例互斥）。
 * - 所有权与额度是会话级（`getSessionName()` 遍历全部 fileEntries 的口径一致）：
 *   每次成功写名后追加一条自有记录（端口 `recordOwnTitle`）；当前名字与最近一条
 *   有效自有记录的名字一致 ⇒ 自己写的，可刷新；否则（用户 /name、v1 遗留标题、
 *   无记录）⇒ 用户所有，永久停止自动更新。刷新额度 = 有效记录条数 − 1（首标
 *   那条不算）达到 `maxRefreshes` 即停。
 * - 输入/摘要是当前 branch（`readUserInputs`/`readAssistantExcerpt` 端口，
 *   由装配层在触发时同步提取成结构化快照，核心本身不做任何 pi 读取）。
 *
 * 不变量：
 * - 子会话（print 模式）不触发：装配在 `src/index.ts` 的 post-guard 区
 *   （HOST_KEY 之后，结构上仅主会话可达），`wireTitle` 仍防御性自查
 *   `isChildSession`（双保险，可测）。
 * - 在途互斥：同一时刻最多一个生成在途；在途时新的触发（首标或刷新）直接
 *   跳过，不发第二个请求。
 * - 过期结果隔离：触发时把 `{ epoch, inputSeq, sessionKey, nameAtTrigger }`
 *   快照传入本次生成；写入前全部复验，任一项不符 ⇒ 结果作废（stale，丢弃，
 *   不清零计数——留给下一次里程碑重新判断）。
 * - 失败静默：每次尝试 10s 硬超时，最多 2 次尝试（间隔 1s 退避）后放弃，
 *   不 retry 风暴、不抛出、不告警。
 * - 生成结束（成功写入 / sanitize 后与当前名字相同 / 两次尝试耗尽 / 无可用
 *   模型 / 写名字失败）统一清零 `inputsSinceGen`/`busyMs`（基线前移）；只有
 *   "过期结果" 本身不清零——交给下一个里程碑重新判断。
 * - `agent_end` 之后 `lastRunOk` 反映本轮是否正常收尾（非 aborted/error、
 *   无 errorMessage）；aborted/error 的 run 收尾后不触发刷新。
 */

/** 单次 completion 的硬超时（规格 10s）。AbortSignal.timeout 内部不占事件循环。 */
export const TITLE_TIMEOUT_MS = 10_000;
/** 失败后最多重试到总共 2 次尝试（规格「最多 2 次」，无风暴）。 */
export const TITLE_MAX_ATTEMPTS = 2;
/** 两次尝试间的退避（429 场景给服务端一口气；测试注入假 sleep）。 */
export const TITLE_RETRY_DELAY_MS = 1_000;
/** completion maxTokens：标题本体 ≤60 字，余量给推理模型的 thinking token。 */
export const TITLE_MAX_TOKENS = 512;
/** sanitize 后的标题硬上限（规格 ≤60 字符，模型目标 ≤20 字）。 */
export const TITLE_MAX_CHARS = 60;
/** prompt 里旧标题锚点的预算（规格 ≤60 码点；与 TITLE_MAX_CHARS 同值但是独立概念——
 * 旧标题本应已经 ≤60，这里是防御性二次截断，不是同一套校验）。 */
export const TITLE_PREVIOUS_MAX_CHARS = 60;
/** prompt 里取最近几条用户输入（规格「最近 5 条」）。 */
export const TITLE_RECENT_INPUT_MAX_COUNT = 5;
/** 每条用户输入喂给模型前的截断（规格「每条 ≤400」，码点安全）。 */
export const TITLE_RECENT_INPUT_ITEM_MAX_CHARS = 400;
/** 全部用户输入合计的预算（规格「合计 ≤2000」，从最新往旧装，装不下即停）。 */
export const TITLE_RECENT_INPUT_TOTAL_MAX_CHARS = 2_000;
/** assistant 摘录的预算（规格 ≤600 码点）。 */
export const TITLE_ASSISTANT_EXCERPT_MAX_CHARS = 600;

/** 码点安全截断（不会把一个代理对切一半）。 */
function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** strict `provider/id`（与 config/model-hint.ts 同形）。 */
export interface TitleModelRef {
  provider: string;
  id: string;
}

/**
 * 标题生成端口（会话级、与触发批次无关，可以共享）。`M` 是不透明的模型句柄
 * （pi 侧是 pi-ai 的 `Model<Api>`）。核心不 import pi。
 *
 * 注意：模型解析/completion/会话身份读取**不在这里**——它们在异步重试循环里
 * 会被多次调用，若共享一个「最近一次 handler 收到的 ctx」会在重试跨越多个
 * pi 事件时悄悄漂移到别的会话（过期 ctx 的 bug 来源）。它们改为按次绑定的
 * `TitleGenerationDeps`（见下），由触发时的 handler 就地构造、随 `onBeforeAgentStart`/
 * `onAgentSettled` 的参数传入，核心全程只用这一份快照，不碰任何共享可变引用。
 */
export interface TitlePorts {
  /** 当前 session 名字；undefined = 未命名。 */
  getSessionName(): string | undefined;
  /** 写入 session 名字（pi 侧 appendSessionInfo 立即持久化）。 */
  setSessionName(name: string): void;
  /** 可注入退避（默认真实 setTimeout；测试用假时钟）。 */
  sleep(ms: number): Promise<void>;
  /** 可注入超时信号（默认 AbortSignal.timeout）。 */
  timeoutSignal(ms: number): AbortSignal;
  /** 注入时钟（墙钟毫秒）：busyMs 累加用它，测试可控。 */
  now(): number;
  /**
   * 当前 branch 里全部用户输入文本，chronological ascending（旧→新），已
   * 过滤空白/纯图片消息；码点未截断（核心的 buildTitlePrompt 自己按预算截断）。
   * 由触发 handler 在同步段读出（不跨 await，不存在过期风险），核心只消费
   * 传入的纯数据，不会在异步段再调用。
   */
  readUserInputs(): string[];
  /**
   * 当前 branch 里最后一条 assistant 回复的文本摘录；该回复 aborted/error/
   * 无文本块时返回 undefined（不回退去找更早的回复）。同上，只在触发 handler
   * 的同步段被调用一次。
   */
  readAssistantExcerpt(): string | undefined;
  /** 会话级（全部 fileEntries）最近一条有效自有标题记录的名字 + 有效记录总数。 */
  titleRecords(): { latestName?: string | undefined; count: number };
  /** 写一条自有标题记录（pi 侧 appendEntry("subagent:title", {v:1,name,at})）。 */
  recordOwnTitle(name: string): void;
}

export interface TitleCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  maxTokens: number;
}

/**
 * 按次绑定的生成依赖——由装配层在 `before_agent_start`/`agent_settled` 的
 * handler 内，就地用**当次收到的 `ctx`** 构造（闭包捕获那一次的 `ctx`，不是
 * 共享的 `ctxRef`），随 `onBeforeAgentStart`/`onAgentSettled` 的参数传入核心。
 * 异步重试循环全程只通过这份快照访问 completion/模型/会话身份，不会因为
 * 期间又来了新的 pi 事件（新会话、/reload）而漂移到别的 ctx 上。
 */
export interface TitleGenerationDeps<M> {
  /** strict ref → 模型句柄（ctx.modelRegistry.find，绑定触发时的 ctx）。 */
  findModel(ref: TitleModelRef): M | undefined;
  /** 当前会话模型（settings.model 解析失败时的回落，绑定触发时的 ctx）。 */
  currentModel(): M | undefined;
  /** 一次性 completion：成功 resolve 文本，任何失败 reject（绑定触发时的 ctx）。 */
  complete(model: M, request: TitleCompletionRequest): Promise<string>;
  /**
   * 当前会话身份（ctx.sessionManager.getSessionId()，绑定触发时的 ctx）：
   * 落笔前复验，生成在途用户 /new /resume 切了会话就作废晚到的标题（否则会
   * 写到新会话头上）。返回 undefined = 无身份可验（跳过该守卫）。
   */
  sessionKey(): string | undefined;
}

/** 触发器配置：标题模型 strict ref（undefined = 跟随会话模型）+ 刷新里程碑/额度。 */
export interface TitleTriggerOptions {
  modelRef?: TitleModelRef;
  /** 自上次生成以来新增用户输入数达到此值即可刷新；0 = 关闭此条件。 */
  refreshEveryInputs: number;
  /** 新增用户输入 ≥1 且累计运行时长达到此分钟数即可刷新；0 = 关闭此条件。 */
  refreshAfterMinutes: number;
  /** 每会话刷新上限（不含首标）；0 = 只首标不刷新。 */
  maxRefreshes: number;
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

/** `buildTitlePrompt` 的输入：旧标题锚点（可选）+ 用户输入（未截断，chronological ascending）+ assistant 摘录（可选）。 */
export interface TitlePromptInput {
  /** 当前名字，作为「稳定优先」的锚点；首标场景 undefined。 */
  previousTitle?: string | undefined;
  /** 全部可用用户输入文本，chronological ascending；函数内部只取最近 5 条并按预算截断。 */
  userInputs: string[];
  /** 最近一条 assistant 回复摘录；无则省略整段。 */
  assistantExcerpt?: string | undefined;
}

/**
 * 标题 prompt（纯函数）。system 钉输出契约（≤20 字、用户语言、无标点引号
 * 换行、无前缀标签、只输出标题本身；有旧标题时额外要求"仍贴合就原样输出，
 * 只有任务焦点明显变化才换"——v2 稳定性要求）。user 是旧标题锚点 + 最近
 * 5 条用户输入（每条 ≤400 码点、合计 ≤2000 码点，从最新往旧装，装不下即停）
 * + assistant 摘录（≤600 码点）拼成的结构化文本。
 */
export function buildTitlePrompt(input: TitlePromptInput): { systemPrompt: string; userPrompt: string } {
  const previousRaw = input.previousTitle?.trim();
  const previousTitle = previousRaw ? truncateCodePoints(previousRaw, TITLE_PREVIOUS_MAX_CHARS) : undefined;
  const excerptRaw = input.assistantExcerpt?.trim();
  const assistantExcerpt = excerptRaw ? truncateCodePoints(excerptRaw, TITLE_ASSISTANT_EXCERPT_MAX_CHARS) : undefined;

  // 最近 5 条（已过滤空白）；合计预算从最新往旧装，装不下即停（整条跳过，不切半条）。
  const recent = input.userInputs
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(-TITLE_RECENT_INPUT_MAX_COUNT);
  const picked: string[] = [];
  let total = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = truncateCodePoints(recent[i]!, TITLE_RECENT_INPUT_ITEM_MAX_CHARS);
    const len = Array.from(item).length;
    if (total + len > TITLE_RECENT_INPUT_TOTAL_MAX_CHARS) break;
    picked.unshift(item);
    total += len;
  }

  const sections: string[] = [];
  if (previousTitle) sections.push(`Current title: ${previousTitle}`);
  if (picked.length > 0) {
    sections.push(`Recent user messages (oldest to newest):\n${picked.map((t) => `- ${t}`).join("\n")}`);
  }
  if (assistantExcerpt) sections.push(`Latest assistant reply (excerpt): ${assistantExcerpt}`);

  const stabilityRule = previousTitle
    ? " If the current title still fits the conversation, output it unchanged; only change it when the task focus has clearly shifted."
    : "";

  return {
    systemPrompt: [
      "You generate or refresh a short session title from the conversation so far.",
      "Rules: at most 20 characters (CJK) or 6 words (English); same language as the messages;",
      "no punctuation, no quotes, no markdown, no line breaks, no prefix like Title:;",
      "plain text title only — nothing else." + stabilityRule,
    ].join(" "),
    userPrompt: sections.join("\n\n"),
  };
}

/** 触发状态机：before_agent_start/agent_end/agent_settled 门检 + fire-and-forget 生成。 */
export interface TitleTrigger<M> {
  /**
   * before_agent_start handler 本体（同步门检 + 计数，绝不 await 生成）。`deps` 是
   * 装配层在本次 handler 内就地绑定当次 ctx 构造的依赖（绝不是共享的 ctxRef）。
   */
  onBeforeAgentStart(prompt: string, deps: TitleGenerationDeps<M>): void;
  /** agent_end handler：记录本轮是否正常收尾（非 aborted/error、无 errorMessage）。 */
  onAgentEnd(ok: boolean): void;
  /**
   * agent_settled handler：累加运行时长 + 刷新门检（同步门检，生成 fire-and-forget）。
   * `deps` 同上，绑定本次 agent_settled handler 收到的 ctx。
   */
  onAgentSettled(deps: TitleGenerationDeps<M>): void;
  /** session_start handler：绝在途生成，内存状态清零（inputsSinceGen/busyMs/inFlight），epoch+1。 */
  onSessionStart(): void;
  /** session_shutdown handler：abort 在途生成，epoch+1。 */
  onSessionShutdown(): void;
}

interface GenerateContext<M> {
  epochAtTrigger: number;
  inputSeqAtTrigger: number;
  sessionKeyAtTrigger: string | undefined;
  /** 首标场景 undefined；刷新场景 = 触发时的当前名字（同时也是 prompt 的旧标题锚点）。 */
  nameAtTrigger: string | undefined;
  userInputs: string[];
  assistantExcerpt?: string | undefined;
  /** 本次触发绑定的生成依赖（findModel/currentModel/complete/sessionKey）。 */
  deps: TitleGenerationDeps<M>;
}

export function createTitleTrigger<M>(ports: TitlePorts, options: TitleTriggerOptions): TitleTrigger<M> {
  let epoch = 0;
  let inputSeq = 0;
  let inputsSinceGen = 0;
  let busyMs = 0;
  let runStartedAt: number | undefined;
  let lastRunOk = true;
  let inFlight: AbortController | undefined;

  const resetBaseline = (): void => {
    inputsSinceGen = 0;
    busyMs = 0;
  };

  const generate = async (gen: GenerateContext<M>): Promise<void> => {
    const controller = new AbortController();
    inFlight = controller;
    let discarded = false;
    try {
      // 模型解析：配置的 strict ref → registry（绑定触发时的 ctx）；找不到（异机
      // 没有该 provider）回落当前会话模型；连会话模型都没有（无凭据环境）就静默
      // 放弃（按失败处理，基线前移）。
      let model: M | undefined;
      try {
        model = (options.modelRef ? gen.deps.findModel(options.modelRef) : undefined) ?? gen.deps.currentModel();
      } catch {
        model = undefined;
      }
      if (!model) return;

      const { systemPrompt, userPrompt } = buildTitlePrompt({
        previousTitle: gen.nameAtTrigger,
        userInputs: gen.userInputs,
        assistantExcerpt: gen.assistantExcerpt,
      });

      for (let attempt = 1; attempt <= TITLE_MAX_ATTEMPTS; attempt++) {
        const moreAttempts = attempt < TITLE_MAX_ATTEMPTS;
        let raw: string;
        try {
          const signal = AbortSignal.any([controller.signal, ports.timeoutSignal(TITLE_TIMEOUT_MS)]);
          raw = await gen.deps.complete(model, { systemPrompt, userPrompt, signal, maxTokens: TITLE_MAX_TOKENS });
        } catch {
          // 网络/429/超时/abort：静默，退避一次后进入下一次尝试或放弃。
          if (moreAttempts) await ports.sleep(TITLE_RETRY_DELAY_MS).catch(() => undefined);
          continue;
        }
        const title = sanitizeTitle(raw);
        if (!title) {
          // 洗成空串（模型只回了标签/空白）按失败计。
          if (moreAttempts) await ports.sleep(TITLE_RETRY_DELAY_MS).catch(() => undefined);
          continue;
        }

        // 写入前全部复验（过期结果隔离）：epoch/inputSeq 是内部计数器直接比较；
        // sessionKey/当前名字要重新读一次（sessionKey 走本次触发绑定的 deps，
        // 不是共享 ctxRef）。任一项不符 ⇒ 结果作废（stale，不清零计数，留给
        // 下一个里程碑）。
        if (epoch !== gen.epochAtTrigger || inputSeq !== gen.inputSeqAtTrigger) {
          discarded = true;
          return;
        }
        let keyNow: string | undefined;
        try {
          keyNow = gen.deps.sessionKey();
        } catch {
          keyNow = gen.sessionKeyAtTrigger; // 读失败：无法验证，按 v1 同款宽容放行
        }
        if (keyNow !== gen.sessionKeyAtTrigger) {
          discarded = true;
          return;
        }
        let currentName: string | undefined;
        try {
          currentName = ports.getSessionName();
        } catch {
          discarded = true; // 读失败：安全方向——当作所有权已变，丢弃
          return;
        }
        if (currentName !== gen.nameAtTrigger) {
          discarded = true;
          return;
        }

        if (currentName === title) {
          // sanitize 后与当前名字相同：视为一次成功刷新（基线前移），不写不记，
          // 防止下一轮立刻再触发。
          return;
        }

        // 写入顺序：setSessionName 严格先于 recordOwnTitle（r1 所有权判定依赖
        // 该次序——appendEntry 失败时名字已经改了，下次判定会因为记录缺失按
        // 用户所有处理，这正是期望的安全退化，顺序颠倒就不成立）。
        try {
          ports.setSessionName(title);
        } catch {
          // 写名字失败（会话正在关闭等）：静默，按失败处理（基线前移，不重试）。
          return;
        }
        try {
          ports.recordOwnTitle(title);
        } catch {
          // appendEntry 失败：静默；名字已经改了但记录没跟上——下次所有权判定
          // 会因为"当前名字 !== 最近记录名字"按用户所有处理（安全方向，不做恢复协议）。
        }
        return;
      }
      // 两次尝试耗尽：静默放弃（按失败处理，基线前移）。
    } finally {
      if (inFlight === controller) inFlight = undefined;
      if (!discarded) resetBaseline();
    }
  };

  return {
    onBeforeAgentStart(prompt: string, deps: TitleGenerationDeps<M>): void {
      // 所有 before_agent_start 都计数（r1 #7 裁定：/goal 续轮、compaction/
      // switch_context 恢复、web 投递的 prompt 都代表会话在推进任务）。
      inputSeq++;
      inputsSinceGen++;
      runStartedAt = ports.now();

      if (inFlight) return; // 在途互斥：跳过，不发第二个请求
      let named: string | undefined;
      try {
        named = ports.getSessionName();
      } catch {
        named = undefined;
      }
      if (named) return; // 已有名字（用户 /name 过或已生成过）——首标场景不适用
      const trimmed = prompt.trim();
      if (!trimmed) return; // 空首条（理论上不会，防御）

      const epochAtTrigger = epoch;
      const inputSeqAtTrigger = inputSeq; // 本次 +1 之后的值
      let sessionKeyAtTrigger: string | undefined;
      try {
        sessionKeyAtTrigger = deps.sessionKey();
      } catch {
        sessionKeyAtTrigger = undefined;
      }
      // 首标输入 = branch 里既有用户消息 + 本次 prompt（它尚未进入 branch）——
      // 覆盖 reload/resume 后首标，而不是只看这一条消息。
      let existing: string[];
      try {
        existing = ports.readUserInputs();
      } catch {
        existing = [];
      }
      void generate({
        epochAtTrigger,
        inputSeqAtTrigger,
        sessionKeyAtTrigger,
        nameAtTrigger: undefined,
        userInputs: [...existing, trimmed],
        deps,
      }).catch(() => {
        // generate 自身已全捕获；这里只兜未预期路径，保持 fire-and-forget 永不 reject。
      });
    },

    onAgentEnd(ok: boolean): void {
      lastRunOk = ok;
    },

    onAgentSettled(deps: TitleGenerationDeps<M>): void {
      if (runStartedAt !== undefined) {
        busyMs += ports.now() - runStartedAt;
        runStartedAt = undefined;
      }

      if (inFlight) return; // 在途互斥
      if (!lastRunOk) return; // aborted/error 的 run 不触发刷新

      const byCount = options.refreshEveryInputs > 0 && inputsSinceGen >= options.refreshEveryInputs;
      const byTime =
        inputsSinceGen >= 1 && options.refreshAfterMinutes > 0 && busyMs >= options.refreshAfterMinutes * 60_000;
      if (!byCount && !byTime) return; // 新输入 0 时不会触发（两个条件都要求 inputsSinceGen>=1）

      let currentName: string | undefined;
      try {
        currentName = ports.getSessionName();
      } catch {
        currentName = undefined;
      }
      if (!currentName) return; // 首标尚未完成（理论上少见），交给下一次 before_agent_start

      let records: { latestName?: string | undefined; count: number };
      try {
        records = ports.titleRecords();
      } catch {
        records = { count: 0 };
      }
      if (records.latestName === undefined || records.latestName !== currentName) return; // 用户所有，永久不刷新
      if (records.count - 1 >= options.maxRefreshes) return; // 刷新额度耗尽

      const epochAtTrigger = epoch;
      const inputSeqAtTrigger = inputSeq;
      let sessionKeyAtTrigger: string | undefined;
      try {
        sessionKeyAtTrigger = deps.sessionKey();
      } catch {
        sessionKeyAtTrigger = undefined;
      }
      let userInputs: string[];
      try {
        userInputs = ports.readUserInputs();
      } catch {
        userInputs = [];
      }
      let assistantExcerpt: string | undefined;
      try {
        assistantExcerpt = ports.readAssistantExcerpt();
      } catch {
        assistantExcerpt = undefined;
      }
      void generate({
        epochAtTrigger,
        inputSeqAtTrigger,
        sessionKeyAtTrigger,
        nameAtTrigger: currentName,
        userInputs,
        assistantExcerpt,
        deps,
      }).catch(() => {
        // 同上：保持 fire-and-forget 永不 reject。
      });
    },

    onSessionStart(): void {
      // r1 唯一口径：不从 branch 重建计数，纯内存清零；inputSeq 单调递增永不重置
      // （只用于过期结果检测，不参与里程碑数学）。必须先 abort 在途生成（与
      // session_shutdown 同款），再清空引用——session_start 可能在没有先收到
      // session_shutdown 的进程内重建栈时发生（例如测试/某些装配序），若不 abort
      // 旧请求会和新会话的新生成并存（虽然 epoch 已变会让旧结果作废，但网络
      // 请求本身仍在耗资源，且必须保证新会话能立刻开始新生成而不与旧请求共存）。
      if (inFlight) {
        try {
          inFlight.abort();
        } catch {
          // ignore
        }
      }
      epoch++;
      inputsSinceGen = 0;
      busyMs = 0;
      inFlight = undefined;
    },

    onSessionShutdown(): void {
      if (inFlight) {
        try {
          inFlight.abort();
        } catch {
          // ignore
        }
      }
      epoch++;
    },
  };
}
