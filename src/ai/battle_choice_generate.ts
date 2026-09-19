/**
 * @fileoverview 战后「处置选项」生成链路。
 *
 * 战斗结束后**不再直接判定死亡/输出结果**：先让 AI 依战况给出四个不同倾向的处置建议
 * （补刀 / 索取财物 / 制服逼问 / 饶命放走），玩家点选或自己写一句，再据此生成战后剧情。
 *
 * 生成失败（无标签 / 解析失败 / 字段缺失）时返回 null，调用方直接跳过等待、照常输出。
 *
 * 复用状态 AI 的 `<MJ_ACTION_OPTIONS_TAG>` 契约与 {@link parseActionOptions}，
 * 这样四个字段与界面上的快捷选项完全同构，无需另写一套 UI。
 */

import { getWorldPreset } from "../role_core/worldSettingsStore";
import {
  completeChatWithMessagesJson,
  type JsonChatRequestPayload,
  type ChatMessage,
} from "./openAiChatBridge";
import { parseActionOptions, type ActionSuggestions } from "./state_generate";
import type { BattleResult } from "../battle_engine/types";
import type { ProtagonistPlayInfo } from "../role_core/types/playInfo";
import type { StoryChatEntry } from "./story_generate";

export interface BattleChoiceInput {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  battleResult: BattleResult;
  protagonist: ProtagonistPlayInfo;
  chatHistory: StoryChatEntry[];
}

const BATTLE_CHOICE_SYSTEM_PRESET = `
[任务]
一场修仙战斗刚刚结束，你负责为玩家构思**四个不同倾向的处置建议**，供他一键选择（也可自行改写）。

[战况] 由程序以结构化给出；你只需输出四个倾向的处置建议，不写剧情、不写结果。

[四个倾向]
- aggressive（狠绝）：赶尽杀绝、补刀灭口、以绝后患。
- moderate（务实）：索取财物/法宝/功法后放人、逼问情报、收作俘虏。
- cautious（稳妥）：先制服封脉、搜身缴械、留作筹码或交给宗门处置。
- veryCautious（留手）：饶对方一命让其滚、立刻脱身离开、不欲结死仇。

[写作要求]
1. 每条 15~30 字，简体中文，以"我"为主语，写成一句具体可执行的处置（如"我搜刮他身上财物后放他一条生路"）。
2. 必须贴合本场战况：我方胜才能处置对方；若我方战败或撤退，四条应改为"如何脱身/保命/留后手"。
3. 四条倾向要有明显差异，不得雷同；符合修仙世界逻辑与主角境界。
4. 禁止空话（如"谨慎行事""继续观察"）。
5. 输出格式：<MJ_ACTION_OPTIONS_TAG>{"aggressive":"…","moderate":"…","cautious":"…","veryCautious":"…"}</MJ_ACTION_OPTIONS_TAG>
   只输出这一个标签，不要其它内容。
`;

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;

function buildChoiceUserContent(input: BattleChoiceInput): string {
  const r = input.battleResult;
  const p = input.protagonist;
  const lines: string[] = [];
  lines.push("【战况】");
  lines.push(`战斗性质：${r.lethality === "spar" ? "切磋（点到为止）" : "死斗（生死相搏）"}`);
  lines.push(`起因：${r.triggerReason || "—"}`);
  lines.push(`结果：${r.outcome === "victory" ? "我方胜，敌方倒地" : r.outcome === "defeat" ? "我方败，主角一方倒地" : "主动脱身，未分胜负"}`);
  lines.push(`我方：${r.allyNames.join("、") || "—"}`);
  lines.push(`敌方：${r.enemyNames.join("、") || "—"}`);
  if (r.enemiesDowned && r.enemiesDowned.length > 0) {
    lines.push(`倒地待处置（生死未定）：${r.enemiesDowned.join("、")}`);
  }
  lines.push(`主角战后：血量 ${r.protagonistHpPercent}%，法力 ${r.protagonistMpPercent}%`);
  lines.push("");
  lines.push(`主角：${p.displayName}（${p.realm.major}${p.realm.minor}）`);
  return lines.join("\n");
}

export function buildBattleChoiceRequestPayload(input: BattleChoiceInput): JsonChatRequestPayload {
  const messages: ChatMessage[] = [];

  const storyParts: string[] = [];
  for (const entry of input.chatHistory) {
    if (entry.role === "assistant") storyParts.push(entry.content);
  }

  const systemParts = [getWorldPreset().preset, BATTLE_CHOICE_SYSTEM_PRESET];
  if (storyParts.length > 0) {
    // 只取最近一段，控制体量
    systemParts.push("【最近的剧情】\n" + storyParts.slice(-1).join("\n"));
  }
  messages.push({ role: "system", content: systemParts.join("\n\n") });

  messages.push({
    role: "user",
    content: `请根据以下战况，输出四个倾向的战后处置建议：\n\n${buildChoiceUserContent(input)}`,
  });

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

/** 生成战后处置建议；失败返回 null（调用方应跳过等待、直接输出）。 */
export async function generateBattleChoices(
  input: BattleChoiceInput,
): Promise<ActionSuggestions | null> {
  try {
    const raw = await completeChatWithMessagesJson(buildBattleChoiceRequestPayload(input));
    return parseActionOptions(raw);
  } catch (e) {
    // 失败不应阻塞战后剧情生成：返回 null 由调用方直接输出。
    return null;
  }
}
