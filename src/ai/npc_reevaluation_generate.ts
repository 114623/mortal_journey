/**
 * NPC 核心层重评估：批量调用 AI 推进长期未见的 NPC 的境界/装备/功法。
 *
 * 触发时机：主角重新回到某地点，对该地点 dormant 且 `worldTimeYearsBetween(lastSeen, now)`
 * ≥ {@link NPC_REEVALUATION_THRESHOLD_YEARS} 的 NPC 批量重评估。一个地点的待评估 NPC
 * 打包一次请求，节省 token。
 */

import { NPC_REEVALUATION_SYSTEM_PRESET } from "./npc_reevaluation_preset";
import { extractTagContent, tryParseJsonArray } from "./parseAiItem";
import { completeChatWithMessagesJson, type JsonChatRequestPayload } from "./openAiChatBridge";
import {
  REALM_ORDER,
  SUB_STAGES,
} from "../role_core/types/playInfo";
import type { NpcNearbyEntry } from "./state_generate";
import type { WorldTime } from "../role_core/worldTime";
import { formatWorldTimeZhDisplay } from "../role_core/worldTime";
import type { Npc } from "../role_core/Npc";

const TAG_REEVAL_OPEN = "<mj_npc_reevaluation>";
const TAG_REEVAL_CLOSE = "</mj_npc_reevaluation>";

const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_MAX_TOKENS = 16384;

const VALID_MAJOR_SET = new Set<string>(REALM_ORDER as readonly string[]);
const VALID_MINOR_SET = new Set<string>(SUB_STAGES as readonly string[]);

function sanitizeRealm(realm: unknown): { major: string; minor: string } {
  if (!realm || typeof realm !== "object") return { major: "练气", minor: "初期" };
  const r = realm as { major?: unknown; minor?: unknown };
  const major = typeof r.major === "string" ? r.major.trim() : "";
  const minor = typeof r.minor === "string" ? r.minor.trim() : "";
  return {
    major: VALID_MAJOR_SET.has(major) ? major : "练气",
    minor: VALID_MINOR_SET.has(minor) ? minor : "初期",
  };
}

export interface NpcReevaluationApiConfig {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface NpcReevaluationInput extends NpcReevaluationApiConfig {
  yearsElapsed: number;
  currentWorldTime: WorldTime;
  protagonistRealm: { major: string; minor: string };
  /** 待评估的 NPC（通常是某地点长期未见的 dormant NPC）。 */
  npcs: Npc[];
}

function formatSlotBrief(slot: unknown): string {
  if (!slot || typeof slot !== "object") return "无";
  const o = slot as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "未命名";
  return name;
}

function formatNpcForReevaluation(npc: Npc, idx: number): string {
  const equipNames = npc.equippedSlots.filter(Boolean).map(formatSlotBrief).join("、") || "无";
  const gongfaNames = npc.gongfaSlots.filter(Boolean).map(formatSlotBrief).join("、") || "无";
  const invNames = npc.inventorySlots.filter(Boolean).map(formatSlotBrief).join("、") || "无";
  return [
    `${idx}. npcId:${npc.id} | ${npc.displayName} | ${npc.identity} | 种族:${npc.race} | ${npc.realm.major}${npc.realm.minor} | 灵根:${npc.linggen.join("") || "无"} | ${npc.age}岁 | 战力:${npc.powerTier} | 好感:${npc.favorability}`,
    `   旧外貌: ${npc.appearance || "无"}`,
    `   旧服装: ${npc.clothing || "无"}`,
    `   旧法宝: ${equipNames}`,
    `   旧功法: ${gongfaNames}`,
    `   旧储物: ${invNames}`,
  ].join("\n");
}

function buildReevaluationUserContent(input: NpcReevaluationInput): string {
  const years = Math.max(0, Math.round(input.yearsElapsed));
  const npcLines = input.npcs.map((n, i) => formatNpcForReevaluation(n, i + 1)).join("\n\n");
  return [
    "【经过年数】",
    `${years} 年`,
    "",
    "【当前世界时间】",
    formatWorldTimeZhDisplay(input.currentWorldTime),
    "",
    "【主角当前境界】（作为修仙世界演进速度参照）",
    `${input.protagonistRealm.major}${input.protagonistRealm.minor}`,
    "",
    "【待演进 NPC】",
    npcLines,
    "",
    "请根据上述年数与各 NPC 的资质/战力/际遇，合理推进他们的境界与装备。输出放入 <mj_npc_reevaluation> 标签。",
  ].join("\n");
}

/**
 * 解析 AI 返回的重评估结果为 NpcNearbyEntry[]。
 * 每个 entry 携带 npcId 与新的核心字段（realm/equippedSlots/gongfaSlots/inventorySlots），
 * 可直接喂给 {@link Npc.applyReevaluation} 整体替换核心层。
 */
export function parseNpcReevaluation(raw: string): NpcNearbyEntry[] {
  const text = extractTagContent(raw, TAG_REEVAL_OPEN, TAG_REEVAL_CLOSE);
  const trimmed = text.trim();
  if (!trimmed) return [];
  const arr = tryParseJsonArray(text) ?? [];
  const out: NpcNearbyEntry[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const npcId = typeof o.npcId === "string" ? o.npcId.trim() : "";
    const displayName = typeof o.displayName === "string" ? o.displayName.trim() : "";
    if (!npcId || !displayName) continue;
    const realm = sanitizeRealm(o.realm);
    out.push({
      npcId,
      displayName,
      identity: "",
      isDead: false,
      favorability: 0,
      race: (typeof o.race === "string" && ["修仙者", "人形妖兽", "妖兽"].includes(o.race)) ? o.race as "修仙者" | "人形妖兽" | "妖兽" : "修仙者",
      appearance: typeof o.appearance === "string" ? o.appearance : "",
      clothing: typeof o.clothing === "string" ? o.clothing : "",
      gender: "男",
      age: 0,
      linggen: [],
      realm,
      hpPercent: 100,
      mpPercent: 100,
      equippedSlots: Array.isArray(o.equippedSlots) ? o.equippedSlots : undefined,
      gongfaSlots: Array.isArray(o.gongfaSlots) ? o.gongfaSlots : undefined,
      inventorySlots: Array.isArray(o.inventorySlots) ? o.inventorySlots : undefined,
    });
  }
  return out;
}

export async function generateNpcReevaluation(input: NpcReevaluationInput): Promise<NpcNearbyEntry[]> {
  if (input.npcs.length === 0) return [];
  const messages = [
    { role: "system" as const, content: NPC_REEVALUATION_SYSTEM_PRESET },
    { role: "user" as const, content: buildReevaluationUserContent(input) },
  ];

  const payload: JsonChatRequestPayload = {
    apiUrl: input.apiUrl,
    apiKey: input.apiKey,
    model: input.model,
    messages,
    temperature: input.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
    requestTimeoutMs: input.requestTimeoutMs,
    signal: input.signal,
  };

  const raw = await completeChatWithMessagesJson(payload);
  return parseNpcReevaluation(raw);
}
