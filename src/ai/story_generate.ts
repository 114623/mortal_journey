import { composeStorySystemPreset } from "./story_preset";
import { genderLine, genderRule } from "./genderGuard";
import { getWorldPreset } from "../role_core/worldSettingsStore";
import { completeChatWithMessagesJson, type JsonChatRequestPayload, type ChatMessage } from "./openAiChatBridge";
import { Protagonist } from "../role_core/Protagonist";
import { factionStore } from "../role_core/factionStore";
import { buildChapterDirective } from "../role_core/chapterStore";
import { describeNextBreakthrough } from "../role_core/realmUtils";
import type { ProtagonistPlayInfo, NarrationPerson, EquippedSlotsState, GongfaSlotsState, InventoryStackItem } from "../role_core/types/playInfo";
import { formatWorldLocationDash } from "../role_core/types/worldLocation";

export interface StoryChatEntry {
  role: "user" | "assistant";
  content: string;
}

export interface StoryGenerateInput {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  protagonist: ProtagonistPlayInfo;
  chatHistory: StoryChatEntry[];
  /** 当前场景在场 NPC 快照文本（让剧情描写与场景 NPC 行为一致）。 */
  sceneNpcSnapshot?: string;
  /** 当前所在地点（让剧情 AI 感知场景）。 */
  currentWorldLocation?: string;
  /** 场景配额硬约束（秘境层数 / 擂台轮次 / 连续战斗波次触顶时注入）。 */
  sceneDirective?: string;
}

export interface StoryParsed {
  storyBody: string;
}

const DEFAULT_TEMPERATURE = 0.55;
const DEFAULT_MAX_TOKENS = 65535;

const MJ_STORY_BODY_OPEN = "<mj_story_body>";
const MJ_STORY_BODY_CLOSE = "</mj_story_body>";

export function extractStoryBody(raw: string): string {
  const s = raw == null ? "" : String(raw);
  let searchFrom = 0;
  const tOpen = s.indexOf("<thinking>");
  if (tOpen >= 0) {
    const tClose = s.indexOf("</thinking>", tOpen);
    if (tClose >= 0) {
      searchFrom = tClose + "</thinking>".length;
    }
  }
  const i = s.indexOf(MJ_STORY_BODY_OPEN, searchFrom);
  if (i < 0) return s.trim();
  const from = i + MJ_STORY_BODY_OPEN.length;
  const j = s.indexOf(MJ_STORY_BODY_CLOSE, from);
  if (j < 0) return s.slice(from).trim();
  return s.slice(from, j).trim();
}

function hasCompleteStoryBody(raw: string): boolean {
  const s = raw == null ? "" : String(raw);
  let searchFrom = 0;
  const tOpen = s.indexOf("<thinking>");
  if (tOpen >= 0) {
    const tClose = s.indexOf("</thinking>", tOpen);
    if (tClose >= 0) {
      searchFrom = tClose + "</thinking>".length;
    }
  }
  const i = s.indexOf(MJ_STORY_BODY_OPEN, searchFrom);
  if (i < 0) return false;
  return s.indexOf(MJ_STORY_BODY_CLOSE, i + MJ_STORY_BODY_OPEN.length) >= 0;
}

function narrationPersonLine(person: NarrationPerson): string {
  switch (person) {
    case "first":
      return "叙事人称：第一人称——以主角口吻，用「我」「我们」等叙述。";
    case "third":
      return "叙事人称：第三人称——以旁观视角写主角，用「他/她」或其姓名指代主角。";
    case "second":
    default:
      return "叙事人称：第二人称——面向玩家，将主角作为「你」「您」书写。";
  }
}

function formatEquipSlot(label: string, slot: EquippedSlotsState[number]): string {
  if (!slot) return `${label}：无`;
  return `${label}：${slot.name}（${slot.grade}）${slot.desc ? "—" + slot.desc : ""}`;
}

function formatEquippedSlots(slots: EquippedSlotsState): string {
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    lines.push(formatEquipSlot(`法宝${i + 1}`, slots[i]));
  }
  return lines.join("\n");
}

function formatGongfaSlots(slots: GongfaSlotsState): string {
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const g = slots[i];
    if (!g) continue;
    lines.push(`功法：${g.name}（${g.grade}）${g.desc ? "—" + g.desc : ""}`);
  }
  return lines.length > 0 ? lines.join("\n") : "无";
}

function formatInventoryItem(item: InventoryStackItem): string {
  if ("type" in item && item.type === "灵石") {
    return `${item.name}×${item.count}`;
  }
  const d = item as { name?: string; grade?: string; count?: number; desc?: string };
  const grade = d.grade ? `（${d.grade}）` : "";
  return `${d.name || "未知物品"}${grade}×${d.count || 1}`;
}

function formatInventorySlots(slots: Array<InventoryStackItem | null>): string {
  const items = slots.filter((s): s is InventoryStackItem => s !== null);
  if (items.length === 0) return "无";
  return items.map(formatInventoryItem).join("、");
}

function buildStoryUserContent(p: ProtagonistPlayInfo, sceneNpcSnapshot?: string, currentWorldLocation?: string): string {
  const origin = p.originStory?.trim() || "—";
  const birthPlace = p.birthPlace ? formatWorldLocationDash(p.birthPlace) : "—";

  const locationLine = currentWorldLocation
    ? `\n当前所在地点：${currentWorldLocation}`
    : "";
  const npcLine = sceneNpcSnapshot?.trim()
    ? `\n\n【当前场景在场NPC】\n${sceneNpcSnapshot.trim()}`
    : "";

  // 主角画像（玩家在人物档案里填写的性格/外貌/记忆）：以玩家设定约束叙事口吻与行为风格。
  const prof = p.profile;
  const profileLines: string[] = [];
  if (prof) {
    if (prof.personality.trim()) profileLines.push(`性格：${prof.personality.trim()}`);
    if (prof.appearance.trim()) profileLines.push(`外貌：${prof.appearance.trim()}`);
    if (prof.memory.trim()) profileLines.push(`记忆：${prof.memory.trim()}`);
  }
  const profileBlock = profileLines.length > 0
    ? `\n【主角画像 · 玩家设定，剧情须与之保持一致】\n${profileLines.join("\n")}\n`
    : "";

  // 势力素材：已登记势力的诉求与关系是事件的第一生长点，
  // 治「事件千篇一律」——让 AI 从已有势力的欲望里长事件，而不是每回合现编一个。
  const factionSnapshot = factionStore.formatFactionSnapshot();
  const factionBlock = factionSnapshot
    ? `\n【势力素材 · 已登记势力，涉及势力的事件优先从这里生长】\n${factionSnapshot}\n` +
      "要求：① 涉及势力的事件优先从上述势力的诉求与关系中长出；\n" +
      "② 新势力登场须在正文内有可观察的出现方式（拜访、传闻、他人相告、正面冲突），不得凭空出现；\n" +
      "③ 已知的势力名称、驻地、与主角关系不得与上述记录冲突。\n"
    : "";

  return [
    "【主角摘要 · 请据此与历史剧情继续生成后续剧情】",
    "",
    `姓名：${p.displayName}`,
    genderLine(p.gender),
    narrationPersonLine(p.narrationPerson),
    `境界：${Protagonist.formatRealm(p.realm)}${p.realmComplete ? "·圆满" : ""}`,
    `修为状态：${p.realmComplete ? describeNextBreakthrough(p.realm.major, p.realm.minor) : "修为未圆满"}`,
    `灵根：${Protagonist.formatLinggenElements(p.linggen)}`,
    `年龄：${p.age}`,
    `寿元：${p.shouyuan}`,
    `当前血量：${p.currentHp}/${p.maxHp}`,
    `当前法力：${p.currentMp}/${p.maxMp}`,
    locationLine,
    "",
    "【出身背景】",
    `出身地点：${birthPlace}`,
    origin,
    "",
    profileBlock,
    "【装备】",
    formatEquippedSlots(p.equippedSlots),
    "",
    "【功法】",
    formatGongfaSlots(p.gongfaSlots),
    "",
    "【储物袋】",
    formatInventorySlots(p.inventorySlots),
    factionBlock,
    npcLine,
    "",
  ].join("\n");
}

export function buildStoryRequestPayload(input: StoryGenerateInput): JsonChatRequestPayload {
  const messages: ChatMessage[] = [];

  const storyParts: string[] = [];
  let lastUserContent: string | undefined;
  for (const entry of input.chatHistory) {
    if (entry.role === "assistant") {
      storyParts.push(entry.content);
    } else {
      lastUserContent = entry.content;
    }
  }

  // 世界观 / 规则 / 预设 取玩家当前设定（可能在「世界设定」里改过）。
  const ws = getWorldPreset();
  const systemParts = [ws.preset, composeStorySystemPreset(ws)];
  if (storyParts.length > 0) {
    systemParts.push("【之前的剧情】\n" + storyParts.join("\n\n---\n\n"));
  }
  // 性别称呼硬约束放最后：最靠近生成位置，且显式声明优先于出身背景与历史剧情，
  // 防止「旧记忆里写成儿子 → 新一轮沿用」的污染循环。
  const genderHint = genderRule(input.protagonist.gender);
  if (genderHint) systemParts.push(genderHint);
  messages.push({ role: "system", content: systemParts.join("\n\n") });

  messages.push({
    role: "user",
    content: buildStoryUserContent(input.protagonist, input.sceneNpcSnapshot, input.currentWorldLocation),
  });

  // 场景配额硬约束：放在最后一条 user 消息里（最靠近生成位置，权重最高）。
  // 未触顶时 buildSceneDirective() 返回空串，这里不会多注入任何东西。
  const directive = input.sceneDirective?.trim() ?? "";
  if (directive) {
    messages.push({ role: "user", content: directive });
  }

  // 篇章指令：同样放在最后一条 user 消息（权重最高）。
  // 玩家没开篇章时 buildChapterDirective() 返回空串——做到「不开就永不打扰」。
  const chapterDirective = buildChapterDirective(ws.storyOutline).trim();
  if (chapterDirective) {
    messages.push({ role: "user", content: chapterDirective });
  }

  if (lastUserContent != null) {
    messages.push({ role: "user", content: `[格式提醒：请严格将思考过程包裹在<thinking>...</thinking>标签内，正文包裹在 <mj_story_body>...</mj_story_body> 标签内。]\n\n${lastUserContent}` });
  }

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

export async function generateStory(input: StoryGenerateInput): Promise<StoryParsed> {
  const payload = buildStoryRequestPayload(input);
  let raw = await completeChatWithMessagesJson(payload);
  if (!hasCompleteStoryBody(raw)) {
    raw = await completeChatWithMessagesJson(payload);
  }
  return { storyBody: extractStoryBody(raw) };
}
