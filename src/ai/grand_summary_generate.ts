import { GRAND_SUMMARY_SYSTEM_PRESET } from "./grand_summary_preset";
import { extractTagContent } from "./parseAiItem";
import {
  completeChatWithMessagesJson,
  type JsonChatRequestPayload,
  type ChatMessage,
} from "./openAiChatBridge";

export interface GrandSummaryGenerateInput {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** 既有剧情总纲（可能为空串，表示首次总结）。 */
  oldGrandSummary: string;
  /** 待总结的一批逐轮快照（按时间顺序排列）。 */
  snapshots: string[];
}

export interface GrandSummaryParsed {
  grandSummary: string;
}

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 4096;

const GRAND_SUMMARY_OPEN = "<mj_story_grand_summary>";
const GRAND_SUMMARY_CLOSE = "</mj_story_grand_summary>";

export function extractGrandSummary(raw: string): string {
  return extractTagContent(raw == null ? "" : String(raw), GRAND_SUMMARY_OPEN, GRAND_SUMMARY_CLOSE);
}

function buildGrandSummaryUserContent(input: GrandSummaryGenerateInput): string {
  const oldPart = input.oldGrandSummary.trim()
    ? `【既有剧情总纲】\n${input.oldGrandSummary.trim()}\n`
    : "【既有剧情总纲】\n（无，本次为首次总结）\n";

  const snapshots = input.snapshots.filter((s) => s && s.trim());
  const snapPart = snapshots.length > 0
    ? "【待总结的逐轮剧情快照（按时间顺序）】\n" + snapshots.map((s, i) => `${i + 1}. ${s.trim()}`).join("\n")
    : "【待总结的逐轮剧情快照】\n（无）";

  return [
    oldPart,
    "",
    snapPart,
    "",
    "请把上述既有总纲与这批快照融合，重新压缩为一段约 1000 字的连贯剧情总纲，仅输出在 <mj_story_grand_summary> 标签内。",
  ].join("\n");
}

function buildGrandSummaryRequestPayload(input: GrandSummaryGenerateInput): JsonChatRequestPayload {
  const messages: ChatMessage[] = [
    { role: "system", content: GRAND_SUMMARY_SYSTEM_PRESET },
    { role: "user", content: buildGrandSummaryUserContent(input) },
  ];

  return {
    apiUrl: input.apiUrl,
    apiKey: input.apiKey,
    model: input.model,
    messages,
    temperature: input.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
    requestTimeoutMs: input.requestTimeoutMs,
    signal: input.signal,
  };
}

export async function generateGrandSummary(input: GrandSummaryGenerateInput): Promise<GrandSummaryParsed> {
  const payload = buildGrandSummaryRequestPayload(input);
  const raw = await completeChatWithMessagesJson(payload);
  const grandSummary = extractGrandSummary(raw);
  return { grandSummary };
}
