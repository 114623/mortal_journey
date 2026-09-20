/**
 * @fileoverview 势力探查：玩家手动触发的独立 AI 链路。
 *
 * 与「NPC 重评估」同构（preset + generate + 标签解析），但**不随每回合自动跑**——
 * 探查是低频动作，只在玩家点按钮时消耗一次请求。
 *
 * 失败语义：解析不出来就返回 `null`，由 UI 显示错误提示条，**不写 store**。
 * 宁可这一轮空手而归，也不把半截脏数据灌进势力档案。
 */

import { FACTION_PROBE_SYSTEM_PRESET } from "./faction_preset";
import { extractTagContent, tryParseJsonArray } from "./parseAiItem";
import { completeChatWithMessagesJson, type JsonChatRequestPayload } from "./openAiChatBridge";
import type { Faction, FactionPower } from "../role_core/factionStore";
import { normalizeFactionPower } from "../role_core/factionStore";

const TAG_PROBE_OPEN = "<mj_faction_probe>";
const TAG_PROBE_CLOSE = "</mj_faction_probe>";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 8192;

/** 合法的势力类型（越界回退「其他」）。 */
const VALID_TYPES = [
  "宗门",
  "世家",
  "商会",
  "散修联盟",
  "魔道",
  "王朝",
  "坊市",
  "其他",
] as const;

/** 合法的与主角关系（越界回退「无交集」）。 */
const VALID_RELATIONS = ["无交集", "友好", "敌对", "隶属", "竞争", "敌视"] as const;

export interface FactionProbeApiConfig {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface FactionProbeInput extends FactionProbeApiConfig {
  /** 主角当前所在地文本（四级路径，可为空）。 */
  currentLocationText: string;
  /** 世界观文本（含世俗王朝硬约束）。 */
  worldView: string;
  /** 主角境界（如「练气中期」）。 */
  protagonistRealm: string;
  /** 已登记势力的快照文本（防重复），可为空。 */
  knownFactions: string;
  /** 附近人物快照（供境界对齐），可为空。 */
  npcSnapshot: string;
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof v === "string" ? v.trim() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function sanitizePower(raw: unknown): FactionPower {
  if (!raw || typeof raw !== "object") return normalizeFactionPower(null);
  const o = raw as Record<string, unknown>;
  return normalizeFactionPower({
    yuanying: typeof o.yuanying === "number" ? o.yuanying : 0,
    jiedan: typeof o.jiedan === "number" ? o.jiedan : 0,
    zhuji: typeof o.zhuji === "number" ? o.zhuji : 0,
  });
}

function buildProbeUserContent(input: FactionProbeInput): string {
  return [
    "【主角当前所在地】",
    input.currentLocationText.trim() || "（未知）",
    "",
    "【世界观·硬约束】",
    input.worldView.trim() || "（未填写）",
    "",
    "【主角当前境界】",
    input.protagonistRealm.trim() || "练气初期",
    "",
    input.knownFactions.trim() ? "【已登记势力·不要重复输出】\n" + input.knownFactions.trim() : "【已登记势力】\n（尚无）",
    "",
    input.npcSnapshot.trim() ? "【附近人物】\n" + input.npcSnapshot.trim() : "【附近人物】\n（无）",
    "",
    "请探查该地附近主角能得知的修仙势力，输出放入 <mj_faction_probe> 标签。",
  ].join("\n");
}

/**
 * 解析探查结果为势力数组。
 *
 * 逐元素 `continue` 跳过脏数据（与项目其它解析层一致），
 * 标签缺失或 JSON 无法解析时返回 `null`——与「解析成功但确实是空数组」区分开。
 */
export function parseFactionProbe(raw: string): Faction[] | null {
  const text = extractTagContent(raw, TAG_PROBE_OPEN, TAG_PROBE_CLOSE);
  if (!text.trim()) return null;
  const arr = tryParseJsonArray(text);
  if (!arr) return null;
  const out: Faction[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const name = oneLine(o.name);
    if (!name) continue;
    out.push({
      name,
      type: pickEnum(o.type, VALID_TYPES, "其他"),
      locationText: oneLine(o.locationText),
      power: sanitizePower(o.power),
      demands: oneLine(o.demands) || "不明",
      relation: pickEnum(o.relation, VALID_RELATIONS, "无交集"),
      desc: oneLine(o.desc),
    });
  }
  return out;
}

/**
 * 探查附近势力。
 *
 * @returns 解析出的势力数组；标签缺失 / JSON 损坏返回 `null`（调用方据此提示失败）。
 */
export async function generateFactionProbe(input: FactionProbeInput): Promise<Faction[] | null> {
  const messages = [
    { role: "system" as const, content: FACTION_PROBE_SYSTEM_PRESET },
    { role: "user" as const, content: buildProbeUserContent(input) },
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
  return parseFactionProbe(raw);
}
