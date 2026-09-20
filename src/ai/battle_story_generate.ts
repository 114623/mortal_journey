/**
 * @fileoverview 战后「战斗描写」生成链路。
 *
 * 战斗结束回到主界面时，用结构化战况（BattleResult）驱动一次专门的剧情生成：
 * 让 AI 把这场仗**描写出来**，而不是由程序直接把"胜 / 败"塞进剧情流。
 *
 * 结构与 `cultivation_story_generate.ts` 一致（system + 一条 user 消息），
 * 但 system 换成 {@link BATTLE_STORY_SYSTEM_PRESET}，正文标签为 `<mj_battle_body>`。
 */

import { BATTLE_STORY_SYSTEM_PRESET } from "./battle_story_preset";
import { formatMainline } from "./story_preset";
import { genderLine } from "./genderGuard";
import { getWorldPreset } from "../role_core/worldSettingsStore";
import {
  completeChatWithMessagesJson,
  type JsonChatRequestPayload,
  type ChatMessage,
} from "./openAiChatBridge";
import type { ProtagonistPlayInfo } from "../role_core/types/playInfo";
import type { StoryChatEntry } from "./story_generate";
import type { BattleResult } from "../battle_engine/types";

export interface BattleStoryInput {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** 程序给出的结构化战况。 */
  battleResult: BattleResult;
  /** 玩家在战后选择的处置（点选的快捷建议或自己写的一句话）。 */
  playerChoice?: string;
  protagonist: ProtagonistPlayInfo;
  npcSnapshot?: string;
  chatHistory: StoryChatEntry[];
}

export interface BattleStoryParsed {
  storyBody: string;
}

const DEFAULT_TEMPERATURE = 0.65;
const DEFAULT_MAX_TOKENS = 65535;

const MJ_BATTLE_BODY_OPEN = "<mj_battle_body>";
const MJ_BATTLE_BODY_CLOSE = "</mj_battle_body>";

function extractBattleBody(raw: string): string {
  const s = raw == null ? "" : String(raw);
  let searchFrom = 0;
  const tOpen = s.indexOf("<thinking>");
  if (tOpen >= 0) {
    const tClose = s.indexOf("</thinking>", tOpen);
    if (tClose >= 0) searchFrom = tClose + "</thinking>".length;
  }
  const i = s.indexOf(MJ_BATTLE_BODY_OPEN, searchFrom);
  if (i < 0) return s.trim();
  const from = i + MJ_BATTLE_BODY_OPEN.length;
  const j = s.indexOf(MJ_BATTLE_BODY_CLOSE, from);
  if (j < 0) return s.slice(from).trim();
  return s.slice(from, j).trim();
}

/** 战斗性质的人工可读描述（同时告诉 AI 伤亡语义）。 */
function lethalityText(r: BattleResult): string {
  return r.lethality === "spar"
    ? "切磋：双方点到为止，本场不会有人身亡"
    : "死斗：生死相搏，血量归零者七成留得性命、三成真死";
}

function outcomeText(r: BattleResult): string {
  if (r.outcome === "victory") return "敌方全部倒下，主角一方占据上风";
  if (r.outcome === "defeat") return "主角一方全部倒下，敌方占据上风";
  return "主角主动脱身遁走，未分胜负";
}

/**
 * 把战况整理成给 AI 的事实清单。
 *
 * 刻意**不写**"胜/败"二字——只陈述谁还站着、谁倒下，由 AI 在描写中呈现结果。
 */
function buildBattleUserContent(input: BattleStoryInput): string {
  const r = input.battleResult;
  const p = input.protagonist;

  const lines: string[] = [];
  lines.push("【战况纪要】");
  lines.push(`战斗性质：${lethalityText(r)}`);
  lines.push(`起因：${r.triggerReason || "—"}`);
  lines.push(`交手回合：${r.actionCount} 回合`);
  lines.push(`我方参战：${r.allyNames.join("、") || "—"}`);
  lines.push(`敌方参战：${r.enemyNames.join("、") || "—"}`);
  lines.push(`战况：${outcomeText(r)}`);
  lines.push(
    `主角战后状态：血量 ${r.protagonistHpPercent}%，法力 ${r.protagonistMpPercent}%（${
      r.protagonistDied ? "气息断绝，已身亡" : "尚有一口气在"
    }）`,
  );

  const killed = r.enemiesKilled.filter(Boolean);
  if (killed.length > 0) {
    lines.push(`确已身亡：${killed.join("、")}`);
  }
  const downed = (r.enemiesDowned ?? []).filter(Boolean);
  if (downed.length > 0) {
    lines.push(`倒地待处置（生死未定，如何收场由玩家的处置决定）：${downed.join("、")}`);
  }

  if (r.elixirsUsed.length > 0) {
    lines.push(
      `战斗中消耗丹药：${r.elixirsUsed.map((e) => `${e.name}×${e.count}`).join("、")}`,
    );
  }
  if (r.loot.length > 0) {
    lines.push(
      `缴获：${r.loot.map((l) => `自${l.enemyName}处得${l.itemKind}「${l.itemName}」`).join("；")}`,
    );
  }

  lines.push("");
  lines.push("【主角】");
  lines.push(`姓名：${p.displayName}`);
  lines.push(genderLine(p.gender));
  lines.push(`境界：${p.realm.major}${p.realm.minor}`);
  lines.push(
    `当前血量：${p.currentHp}/${p.maxHp}，法力：${p.currentMp}/${p.maxMp}`,
  );

  const npcSection = input.npcSnapshot?.trim()
    ? `\n【周围人物】\n${input.npcSnapshot.trim()}\n`
    : "";

  const choiceSection = input.playerChoice?.trim()
    ? [
        "",
        "【玩家的战后处置】",
        input.playerChoice.trim(),
        "（这是玩家在战斗结束后的表态，务必在收场描写中体现：要杀就写到断气，要饶就写到对方退走，" +
          "要财物就写到搜刮。不得违背这一处置。）",
      ].join("\n")
    : "";

  return [
    ...lines,
    npcSection,
    choiceSection,
    "",
    "请根据以上战况纪要，写出这场战斗的过程描写：谁先出手、如何攻防、伤势如何、如何收场。" +
      "不要写“战斗结束，主角获胜”这类结论句，让结果从描写中自然呈现。" +
      (input.playerChoice?.trim()
        ? ""
        : "倒地者的生死不要在本段定死，留给玩家接下来的处置。"),
  ].join("\n");
}

export function buildBattleStoryRequestPayload(input: BattleStoryInput): JsonChatRequestPayload {
  const messages: ChatMessage[] = [];

  const storyParts: string[] = [];
  for (const entry of input.chatHistory) {
    if (entry.role === "assistant") storyParts.push(entry.content);
  }

  const systemParts = [getWorldPreset().preset, BATTLE_STORY_SYSTEM_PRESET];
  const outline = formatMainline(getWorldPreset());
  if (outline) systemParts.push(outline);
  if (storyParts.length > 0) {
    systemParts.push("【之前的剧情】\n" + storyParts.join("\n\n---\n\n"));
  }
  messages.push({ role: "system", content: systemParts.join("\n\n") });

  messages.push({
    role: "user",
    content: `[格式提醒：请严格将思考过程包裹在<thinking>...</thinking>标签内，正文包裹在 <mj_battle_body>...</mj_battle_body> 标签内。]\n\n${buildBattleUserContent(input)}`,
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

export async function generateBattleStory(input: BattleStoryInput): Promise<BattleStoryParsed> {
  const raw = await completeChatWithMessagesJson(buildBattleStoryRequestPayload(input));
  return { storyBody: extractBattleBody(raw) };
}
