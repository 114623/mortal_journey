/**
 * @fileoverview OpenAI 兼容的非流式 Chat Completions 客户端，与 `mortal_journey/silly_tarven/bridge.js` 行为对齐。
 *
 * 供启动页「测试连接」与后续游戏逻辑复用。
 */

import { gameLog } from "../log/gameLog";
import { getAiRequestTimeoutMs } from "../role_core/aiTimeoutStore";

/**
 * 非流式请求的整段超时**兜底**（毫秒），含连接与读取完整 JSON 正文。
 *
 * 【2026-09-25】这个值现在只是最后一道防线：真实生效的是玩家在「设置」里调的
 * `aiTimeoutStore`（默认 420s）。保留导出的目的是 —— 一旦 store 读不到
 * （隐私模式、异常环境），链路上还有个不至于无限等待的上限。
 * 数字与 store 默认值保持一致，别各写各的。
 */
export const DEFAULT_NON_STREAM_TIMEOUT_MS = 420000;

/** OpenAI 兼容的聊天消息条目（`role` + `content`）。 */
export interface ChatMessage {
  role: string;
  content: string;
}

/** 单条消息在请求体中的 UTF-16 字符统计（用于调试体量日志）。 */
interface MessageCharStat {
  role: string;
  chars: number;
}

/**
 * 统计 `messages` 数组中各条 `content` 的字符数（UTF-16 长度，与 `String#length` 一致）。
 *
 * @param messages 上游 `messages` 字段；非数组时视为空。
 * @return 总字符数与每条消息的 `{ role, chars }` 列表。
 */
function countMessagePayloadChars(messages: unknown): {
  totalChars: number;
  perMessage: MessageCharStat[];
} {
  const perMessage: MessageCharStat[] = [];
  let totalChars = 0;
  if (!Array.isArray(messages)) {
    return { totalChars: 0, perMessage };
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    const role = m && m.role != null ? String(m.role) : "";
    const content = m && m.content != null ? String(m.content) : "";
    const chars = content.length;
    totalChars += chars;
    perMessage.push({ role, chars });
  }
  return { totalChars, perMessage };
}

/**
 * 按「约 2 token / 字」粗估中文正文的 token 上限，便于对照上下文窗口（非官方分词，仅日志参考）。
 *
 * @param charCount UTF-16 字符数。
 * @return 向上取整后的粗估 token 上限。
 */
function estimateChineseTokensMaxByChars(charCount: number): number {
  return Math.ceil(Math.max(0, charCount) * 2);
}

/**
 * 将待发请求的关键字段写入 `gameLog`（不含 API Key），并输出体量粗估。
 *
 * @param requestBody 即将 `JSON.stringify` 的请求体对象。
 */
function logAiOutbound(requestBody: Record<string, unknown>): void {
  try {
    const snap = {
      model: requestBody.model,
      messages: requestBody.messages,
      temperature: requestBody.temperature,
      max_tokens: requestBody.max_tokens,
    };
    gameLog.info("[AI →] " + JSON.stringify(snap));

    const { totalChars } = countMessagePayloadChars(requestBody.messages);
    const tokensMax = estimateChineseTokensMaxByChars(totalChars);
    gameLog.info("[AI → 体量] " + totalChars + " 字，粗估最多 " + tokensMax + " tokens");
  } catch {
    gameLog.info("[AI →] (无法序列化请求体)");
  }
}

/**
 * 将模型返回的正文写入 `gameLog`，空串时记为占位说明。
 *
 * @param text 解析得到的助手正文。
 */
function logAiInbound(text: string): void {
  const body = text === "" ? "(空正文)" : text;
  gameLog.info("[AI ←] " + body);
  if (text !== "") {
    const n = text.length;
    const tokensMax = estimateChineseTokensMaxByChars(n);
    gameLog.info("[AI ← 体量] " + n + " 字，粗估最多 " + tokensMax + " tokens");
  }
}

/**
 * 将请求失败信息写入 `gameLog`。
 *
 * @param err 任意抛错或拒绝原因。
 */
function logAiFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  gameLog.error("[AI 失败] " + msg);
}

/**
 * 解析 JSON 字符串；解析失败时返回给定回退值，不抛异常。
 *
 * @template T 期望的解析结果类型（调用方负责与实际 JSON 一致）。
 * @param raw 原始 JSON 文本。
 * @param fallback 解析失败时返回的值。
 * @return `JSON.parse` 的结果，或 `fallback`。
 */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 规范化 OpenAI 兼容的 API 根 URL：去尾部斜杠，若无 `/vN` 后缀则补 `/v1`。
 *
 * @param url 用户配置的 API 根或完整路径前缀。
 * @return 规范化后的根 URL；空输入返回空字符串。
 */
export function normalizeBaseUrl(url: string): string {
  let clean = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!clean) return "";
  if (!/\/v\d+$/i.test(clean)) clean += "/v1";
  return clean;
}

/**
 * 从非流式 `chat/completions` 响应 JSON 中提取助手正文。
 *
 * 与 `bridge.js` 中 `extractOpenAiNonStreamMessageText` 的路径一致：`choices[0].message.content`、
 * 以及旧式 `choices[0].text`。
 *
 * @param data 解析后的响应体；非法或非对象时视为无正文。
 * @return 拼接后的助手文本；可能为空字符串。
 */
/**
 * 输出被 `max_tokens` 截断时抛出的错误（见 {@link assertNotTruncated}）。
 *
 * 带 `name` 是为了让调用方能可靠识别——截断**必须重试**，而"模型漏写标签"这类
 * 内容问题重试的收益不同，两者不该混为一谈。
 */
export class AiOutputTruncatedError extends Error {
  override readonly name = "AiOutputTruncatedError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * 上游返回非 2xx 时抛出，带 `status` 以便区分「可重试」（429/5xx）与「重试无意义」（401/403）。
 *
 * 之前所有 HTTP 错误都是裸 `Error`，传输层没法判断该不该重试——
 * 于是一条 429 限流就直接报废整回合。带 status 之后重试逻辑才有依据。
 */
export class AiHttpError extends Error {
  override readonly name = "AiHttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 整段请求在预算时间内未完成时抛出。
 *
 * 与 HTTP 错误分开，是为了让重试逻辑能单独识别「渠道慢/挂死」这一类——
 * 它和 5xx 一样属于「再试一次大概率能成」的范畴。
 */
export class AiTimeoutError extends Error {
  override readonly name = "AiTimeoutError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * 该错误是否属于「传输层抖动，值得一试再试」。
 *
 * 判据刻意收窄：只认 429（限流）、500/502/503/504（网关侧故障）、
 * 超时、以及 fetch 直接抛出的网络错误（断网 / DNS / CORS 之类，通常带不上 status）。
 * **明确不重试**的：
 * - `AiOutputTruncatedError` —— 那是"输出太长"的内容问题，交给 `callStateAI` 带
 *   "精简输出"指令重试；在这里重试只会再拿到一次同样的截断，还浪费一轮等待。
 * - 401/403 —— 密钥/权限问题，重试一万次也一样。
 * - 用户主动 abort —— 玩家取消了，不该继续发。
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof AiTimeoutError) return true;
  if (err instanceof AiHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof AiOutputTruncatedError) return false;
  // 浏览器 fetch 的网络错误是 TypeError（"Failed to fetch" 等），没有 status 可查。
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("network error")) return true;
  }
  return false;
}

/**
 * 响应是否因 `max_tokens` 用尽而被截断。
 *
 * 【2026-09-25】补上这个判断是因为线上出现过一类**静默失败**：
 * 状态 AI 要输出十五段标签，末尾的「推进选项 / 快照」恰好排在最容易被砍掉的位置；
 * `max_tokens` 一耗尽，上游返回 `finish_reason:"length"`，而旧实现只取
 * `choices[0].message.content` 就交差——拿到的是一段**残缺文本**，
 * 解析时末尾标签自然不存在，于是玩家看到"剧情出来了但没有选项"，
 * 控制台只有一句「模型漏写」的 warn。实测一份存档 33 轮里 7 轮中招（21%），
 * 且失败轮的输入正文明显更长（均值 795 字 vs 成功轮 583 字）——正是截断的特征。
 */
export function isTruncatedResponse(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as { choices?: Array<{ finish_reason?: unknown }> };
  const ch0 = d.choices && d.choices[0];
  if (!ch0 || typeof ch0 !== "object") return false;
  return ch0.finish_reason === "length";
}

export function extractOpenAiNonStreamMessageText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as {
    choices?: Array<{
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };
  const ch0 = d.choices && d.choices[0];
  if (!ch0 || typeof ch0 !== "object") return "";
  const parts: string[] = [];
  const msg = ch0.message && typeof ch0.message === "object" ? ch0.message : null;
  if (msg) {
    const c = msg.content;
    if (c != null && String(c) !== "") parts.push(String(c));
  }
  const legacy = ch0.text;
  if (legacy != null && String(legacy) !== "") parts.push(String(legacy));
  return parts.join("");
}

/** `postChatCompletionsNonStream` 的可选行为：整段超时与用户 `AbortSignal`。 */
export interface PostChatCompletionsNonStreamOptions {
  /** 整段请求预算（毫秒）；未设或无效时使用 `DEFAULT_NON_STREAM_TIMEOUT_MS`。 */
  requestTimeoutMs?: number;
  /** 传递给 `fetch` 的中断信号。 */
  signal?: AbortSignal;
}

/**
 * 向给定 `chat/completions` URL 发送非流式 POST：负责 HTTP、整段超时、以及将响应正文解析为 JSON。
 *
 * 请求体中的 `stream` 会被强制为 `false`。超时与 HTTP 非 2xx 均会抛错，由调用方捕获。
 *
 * @param chatCompletionsUrl 完整 URL，例如 `https://api.example.com/v1/chat/completions`。
 * @param headers 请求头；会与 `Content-Type: application/json` 合并。
 * @param requestBody OpenAI 兼容 JSON对象；须含 `model` 与 `messages` 等上游所需字段。
 * @param options 可选超时与 `signal`。
 * @return 解析后的响应 JSON（结构取决于上游）；正文损坏时可能为 `null`。
 * @throws {Error} 当 URL 或 `requestBody` 无效、HTTP 错误、或整段超时未完成时。
 */
export async function postChatCompletionsNonStream(
  chatCompletionsUrl: string,
  headers: Record<string, string>,
  requestBody: Record<string, unknown>,
  options?: PostChatCompletionsNonStreamOptions,
): Promise<unknown> {
  const opt = options ?? {};
  if (!chatCompletionsUrl || typeof requestBody !== "object" || !requestBody) {
    throw new Error("postChatCompletionsNonStream: 需要有效的 chatCompletionsUrl 与 requestBody");
  }

  const body = Object.assign({}, requestBody, { stream: false });
  const mergedHeaders = Object.assign({ "Content-Type": "application/json" }, headers || {});

  // 玩家在「设置」里调的超时优先；store 不可用时退回硬编码兜底。
  let budgetMs =
    typeof opt.requestTimeoutMs === "number" && opt.requestTimeoutMs > 0
      ? opt.requestTimeoutMs
      : getAiRequestTimeoutMs();
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) budgetMs = DEFAULT_NON_STREAM_TIMEOUT_MS;

  const timeoutErr = (): Error =>
    new AiTimeoutError(
      `非流式在 ${Math.round(budgetMs / 1000)}s 内未完成（含连接与整段 JSON）。常见于模型生成很慢、中转排队、或单次 messages 极大。可在「设置」里调大 AI 请求超时。`,
    );

  const userSignal = opt.signal;

  // 超时必须真的把 fetch 掐掉：只 reject 不 abort，请求还在后台跑，
  // 连接占着、上游算力照烧，重试一次就多一条僵尸请求。
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const racePromise = Promise.race([
    (async () => {
      const res = await fetch(chatCompletionsUrl, {
        method: "POST",
        headers: mergedHeaders,
        body: JSON.stringify(body),
        signal: mergeSignals(ctrl, userSignal),
      });
      if (!res.ok) {
        const lastError = await res.text();
        const hint =
          res.status === 401 || res.status === 403
            ? "\n\n提示：这通常是「API Key 无权限访问该模型 / Key 填错或为空」或「模型名与网关不匹配」导致。请到「API设置」检查 API URL / Key / 模型名称是否与网关支持一致。"
            : "";
        throw new AiHttpError(res.status, `上游模型请求失败 (${res.status}): ${lastError || "unknown error"}${hint}`);
      }
      const text = await res.text();
      return safeJsonParse(text, null);
    })(),
    new Promise<never>((_, rej) => {
      // 计时器句柄留着是为了 race 落定后清掉——否则每个请求都留一个
      // 最长 7 分钟的悬挂 timer，长会话下会攒出一批无谓的定时器。
      timer = setTimeout(() => {
        ctrl.abort();
        rej(timeoutErr());
      }, budgetMs);
    }),
  ]);

  return racePromise.finally(() => {
    if (timer !== null) clearTimeout(timer);
  }) as Promise<unknown>;
}

/**
 * 把内部超时用的 controller 与调用方传入的 signal 合并出一个给 fetch 用的 signal。
 *
 * `AbortSignal.any` 不是所有目标环境都有（本项目 TS lib 里就没有），所以手写转发：
 * 用户一 abort 就把内部 controller 也掐掉，这样超时计时器那条路和外部取消走同一出口。
 */
function mergeSignals(ctrl: AbortController, user?: AbortSignal): AbortSignal {
  if (!user) return ctrl.signal;
  if (user.aborted) {
    ctrl.abort();
    return ctrl.signal;
  }
  user.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl.signal;
}

/**
 * 通过 JSON 对象或 JSON 字符串描述一次非流式对话请求，行为与 `JsonChatRequestPayload` 一致。
 *
 * `signal` 无法从纯 JSON 字符串反序列化，仅对象形式可传。
 */
export interface JsonChatRequestPayload {
  apiUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 解析 JSON 字符串或直接使用对象，发起非流式对话并返回助手正文（含 `gameLog` 中的 [AI →] / [AI ←]）。
 *
 * @param jsonMessages JSON 字符串或可解析为 `JsonChatRequestPayload` 的对象。
 * @return 助手回复正文，可能为空字符串。
 * @throws {Error} 当负载非法、`messages` 非数组、或底层请求失败时。
 */
export async function completeChatWithMessagesJson(
  jsonMessages: string | JsonChatRequestPayload,
): Promise<string> {
  const o =
    typeof jsonMessages === "string" ? safeJsonParse<JsonChatRequestPayload | null>(jsonMessages, null) : jsonMessages;
  if (!o || typeof o !== "object") {
    throw new Error("completeChatWithMessagesJson: 需要合法 JSON 字符串或对象");
  }
  if (!Array.isArray(o.messages)) {
    throw new Error("completeChatWithMessagesJson: messages 须为数组");
  }
  gameLog.debug("[completeChatWithMessagesJson] 解析完成，即将请求（详见 [AI →] / [AI ←]）");
  return callChatCompletionNonStream({
    apiUrl: o.apiUrl,
    apiKey: o.apiKey,
    model: o.model,
    messages: o.messages,
    temperature: o.temperature,
    max_tokens: o.max_tokens,
    requestTimeoutMs: o.requestTimeoutMs,
    signal: o.signal,
  });
}

/**
 * 调用非流式 `/chat/completions` 的参数：网关 URL、可选 Key、模型与消息列表等。
 *
 * 未指定时，`temperature` 默认 `0.7`，`max_tokens` 默认 `8`（与桥接层历史行为一致）。
 */
export interface CallChatCompletionNonStreamParams {
  apiUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 对 OpenAI 兼容网关执行一次非流式 `chat/completions` 调用，并返回助手正文。
 *
 * 自动规范化 `apiUrl`、附加 `Authorization`（有 Key 时）、写入往返调试日志；失败时记录并原样重新抛出。
 *
 * @param params URL、模型、消息与可选超时等。
 * @return 从响应中解析的助手文本，可能为空。
 * @throws {Error} 当缺少 URL/模型、HTTP 错误、超时、或解析失败时。
 */
/** 单次调用的**总**发送次数（1 次首发 + 最多 2 次重试）。 */
const TRANSPORT_MAX_ATTEMPTS = 3;
/** 退避基数：第 n 次重试前等 `base * 2^(n-1)`，再加 0~1000ms 抖动打散并发。 */
const TRANSPORT_BACKOFF_BASE_MS = 2000;
const TRANSPORT_BACKOFF_JITTER_MS = 1000;

/**
 * 带退避重试地发一次非流式请求。
 *
 * 【2026-09-25】之前传输层抖动（429 限流 / 网关 502 / 中转排队超时 / 断网）
 * 一律直接报废整回合——玩家看到的就是"剧情没出来"或"状态没更新"，
 * 而这类错误里相当一部分**再发一次就成了**。
 *
 * 计费约束：用户按次计费，这里不是"多打一次"，而是"失败的那次本来就要重来，
 * 由程序自动重来省掉玩家手动重开"。成功时不产生任何额外调用。
 *
 * @param params 与 {@link callChatCompletionNonStream} 同源，取 url/headers/body/超时/signal。
 * @return 解析后的响应 JSON。
 * @throws 最后一次的错误；不可重试的错误首次即抛出。
 */
async function postChatCompletionsWithRetry(
  chatCompletionsUrl: string,
  headers: Record<string, string>,
  requestBody: Record<string, unknown>,
  requestTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= TRANSPORT_MAX_ATTEMPTS; attempt++) {
    try {
      return await postChatCompletionsNonStream(chatCompletionsUrl, headers, requestBody, {
        requestTimeoutMs,
        signal,
      });
    } catch (e) {
      lastErr = e;
      // 用户主动取消 —— 立刻放弃，等待和重试都不该发生。
      if (signal?.aborted) throw e;
      const canRetry = isRetryableTransportError(e) && attempt < TRANSPORT_MAX_ATTEMPTS;
      if (!canRetry) throw e;

      const waitMs =
        TRANSPORT_BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * TRANSPORT_BACKOFF_JITTER_MS);
      const reason = e instanceof AiHttpError ? `HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
      gameLog.warn(`[AI] 第 ${attempt}/${TRANSPORT_MAX_ATTEMPTS} 次请求失败（${reason}），${(waitMs / 1000).toFixed(1)}s 后重试…`);
      await sleepWithAbort(waitMs, signal);
    }
  }
  throw lastErr ?? new Error("postChatCompletionsWithRetry: 未知失败");
}

/** 等待指定毫秒；期间若用户取消则立即抛错，不白等。 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("玩家取消了本次请求"));
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function callChatCompletionNonStream(params: CallChatCompletionNonStreamParams): Promise<string> {
  const apiUrl = String(params.apiUrl || "").trim();
  const apiKey = params.apiKey != null ? String(params.apiKey).trim() : "";
  const model = String(params.model || "").trim();
  if (!apiUrl || !model) {
    throw new Error("桥接预设未配置 API URL 或模型：请在「API设置」中填写 URL 与模型。");
  }

  const baseUrl = normalizeBaseUrl(apiUrl);
  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const requestBody: Record<string, unknown> = {
    model,
    messages: params.messages,
    temperature: typeof params.temperature === "number" ? params.temperature : 0.7,
    max_tokens: typeof params.max_tokens === "number" ? params.max_tokens : 8,
  };

  logAiOutbound(requestBody);
  try {
    const data = await postChatCompletionsWithRetry(
      url,
      headers,
      requestBody,
      params.requestTimeoutMs,
      params.signal,
    );

    const out = extractOpenAiNonStreamMessageText(data);
    if (!out && data && typeof data === "object") {
      console.warn(
        "[OpenAI Bridge] 非流式响应中未解析到 choices[0].message.content / text，请对照上游 JSON。",
      );
    }
    logAiInbound(out);
    // 截断必须让调用方知道：拿到一段被砍掉尾巴的文本再去做标签解析，
    // 结果一定是"末尾几段凭空消失"，表现为莫名的静默失败。
    if (isTruncatedResponse(data)) {
      const used = (data as { usage?: { completion_tokens?: unknown } }).usage?.completion_tokens;
      const usedStr = typeof used === "number" ? `（已用 ${used} tokens）` : "";
      const msg =
        `模型输出被 max_tokens 截断${usedStr}：本条回复不完整，末尾内容已丢失。` +
        `请提高该模型的输出上限（或换用输出更长的模型/渠道）后重试。`;
      gameLog.error("[OpenAI Bridge] " + msg);
      throw new AiOutputTruncatedError(msg);
    }
    return out;
  } catch (e) {
    logAiFailure(e);
    throw e;
  }
}
