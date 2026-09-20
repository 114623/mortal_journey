import { composeStateSystemPreset } from "./state_preset";
import { formatMainline } from "./story_preset";
import { getWorldPreset } from "../role_core/worldSettingsStore";
import { extractTagContent, tryParseJsonArray } from "./parseAiItem";
import {
  completeChatWithMessagesJson,
  type JsonChatRequestPayload,
} from "./openAiChatBridge";
import {
  REALM_ORDER,
  SUB_STAGES,
  PROFILE_FIELD_MAX_LENGTH,
  MEMORY_MAX_LENGTH,
  type ProtagonistPlayInfo,
  type EquippedSlotsState,
  type GongfaSlotsState,
  type InventoryStackItem,
  type WorldLocation,
  type NpcRace,
} from "../role_core/types/playInfo";
import { type WorldTime, type TimeDelta, formatWorldTimeZhDisplay } from "../role_core/worldTime";
import { describeNextBreakthrough, gongfaMaxLayerOf } from "../role_core/realmUtils";
import { formatWorldLocationDash, parseWorldLocationFromDash } from "../role_core/types/worldLocation";
import type { SceneReport } from "../role_core/sceneBudgetStore";
import type { FactionChange } from "../role_core/factionStore";
import { factionStore } from "../role_core/factionStore";
import { buildChapterDirective } from "../role_core/chapterStore";
import type { NpcCoreChangeEvent } from "../role_core/npcCoreChange";
import {
  checkNpcConsistency,
  type NpcConsistencyResult,
} from "./npcConsistency";
import { resolveGongfaTier, isGongfaObsolete } from "../role_core/types/itemTier";
import { genderLine, genderRule } from "./genderGuard";

export interface StateGenerateInput {
  apiUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  storyBody: string;
  protagonist: ProtagonistPlayInfo;
  currentWorldLocation?: WorldLocation | null;
  currentWorldTime?: WorldTime;
  npcSnapshot?: string;
  /**
   * 最近 3 轮已出现的推进轴（扁平列表，仅用于轮换提示）。
   * 见 state_preset「推进选项生成协议 · 跨回合轮换」。
   */
  recentBranchAxes?: string[];
  /**
   * 上一轮给出的推进选项正文（无论玩家是否选用）。
   * 用于"防复读"：本轮选项不得与上轮的核心对象大面积重复——玩家没选的就是拒绝了。
   */
  recentOptionTexts?: string[];
  /** 场景配额硬约束（秘境层数 / 擂台轮次 / 连续战斗波次触顶时注入）。 */
  sceneDirective?: string;
}

export interface HpMpState {
  hpPercent: number;
  mpPercent: number;
}

export interface BreakthroughState {
  realmBreakthrough?: boolean;
  breakthroughQuestStart?: boolean;
  breakthroughFailed?: boolean;
}

export interface UserStateChange {
  xiuweiIncrease?: number;
  gongfaMasteryChanges?: Array<{
    gongfaName: string;
    masteryExpIncrease: number;
  }>;
}

export interface SpiritStoneChange {
  op: "add" | "remove";
  count: number;
}

export interface ItemAddEntry {
  type: string;
  name: string;
  intro: string;
  grade: string;
  count: number;
  system?: unknown;
  role?: unknown;
  function?: unknown;
  bonus?: unknown;
}

export interface ItemRemoveEntry {
  name: string;
  count: number;
}

export interface NpcNearbyEntry {
  npcId?: string;
  displayName: string;
  identity: string;
  isDead: boolean;
  favorability: number;
  race: NpcRace;
  appearance: string;
  clothing: string;
  gender: string;
  age: number;
  linggen: string[];
  realm: { major: string; minor: string };
  hpPercent: number;
  mpPercent: number;
  /** 当前所在地点（状态 AI 显式输出；用于维护 NPC 位置，判定在场/迁移）。 */
  currentLocation?: WorldLocation;
  /**
   * AI 生成 / 更新的画像提示词。
   * - personality：性格（新 NPC 必填；既有 NPC 性格发生实质转变时可更新）。
   * - memory：记忆（每回合可追加更新，记录该 NPC 记住的关键经历与对主角的印象）。
   * - appearance：外貌（可选；NPC 外貌以核心字段 appearance 为准）。
   * 玩家已在人物档案里手动锁定该 NPC 时，前端会忽略此字段。
   */
  profile?: {
    personality?: string;
    memory?: string;
    appearance?: string;
  };
  equippedSlots?: unknown[];
  gongfaSlots?: unknown[];
  inventorySlots?: unknown[];
  [key: string]: unknown;
}

export interface BattleCombatant {
  displayName: string;
  roleHint: string;
}

/** 战斗性质：**死斗**（会出人命）或**切磋**（点到为止，不会死人）。 */
export type BattleLethality = "kill" | "spar";

export interface BattleTriggerEntry {
  shouldEnterBattle: boolean;
  triggerKind: "active" | "passive";
  triggerReason: string;
  allies: BattleCombatant[];
  enemies: BattleCombatant[];
  isTestBattle?: boolean;
  /**
   * 战斗性质：kill=死斗（血量归零者 70% 存活、30% 真死），spar=切磋（血量归零不死）。
   * 缺省按 kill 处理（保持旧行为）。
   */
  lethality?: BattleLethality;
}

/**
 * 单条「推进选项」——对齐《Mortal 推进选项生成协议》。
 *
 * 元信息（类型 / 距离 / 主动方 / 推进轴）由 AI 一并输出。前端只展示正文；
 * 元信息用于生成端的多样性约束（距离分档防"集体扑同一个悬念"）与跨回合轮换。
 * `hook` / `intensity` 为旧协议字段，保留成可选以兼容旧存档与模型偶发的旧格式输出。
 */
export interface BranchOption {
  /** 类型：当下行动 / 叙事推力 / 更具体类型。 */
  type: string;
  /** 距离：贴身 / 邻近 / 旁支 / 远离 —— 选项与正文尾部的贴近程度。 */
  distance: string;
  /** 推进轴：浪漫/艳遇、危机/压力、机缘/异常 等。 */
  axis: string;
  /** 主动方：B1 / NPC 名 / 势力 / 世界。 */
  actor: string;
  /** 玩家可见的选项正文。 */
  text: string;
  /** @deprecated 旧协议字段（承接：钩子/另起），仅读档兼容。 */
  hook?: string;
  /** @deprecated 旧协议字段（强度：稳/中/强），仅读档兼容。 */
  intensity?: string;
}

/** 本回合的推进选项列表（1~10 条，默认 4 条）。 */
export type ActionSuggestions = BranchOption[];

export interface StateParsed {
  worldLocation: WorldLocation | null;
  hpMp: HpMpState | null;
  userState: UserStateChange | null;
  timeAdvance: TimeDelta | null;
  breakthrough: BreakthroughState | null;
  spiritStoneChanges: SpiritStoneChange[];
  itemAdds: ItemAddEntry[];
  itemRemoves: ItemRemoveEntry[];
  nearbyNpcs: NpcNearbyEntry[];
  npcCoreChanges: NpcCoreChangeEvent[];
  /** 本回合 AI 声明的势力变更事件（add / update）。 */
  factionChanges: FactionChange[];
  battleTrigger: BattleTriggerEntry | null;
  storySnapshot: string;
  actionOptions: ActionSuggestions | null;
  /** 本回合 AI 报告的场景进度（秘境层 / 擂台轮）；null = 未报告。 */
  sceneReport: SceneReport | null;
  /** NPC 与剧情正文的一致性校验结果（未传 storyBody 时为 null）。 */
  npcConsistency: NpcConsistencyResult | null;
}

const DEFAULT_TEMPERATURE = 0.55;
const DEFAULT_MAX_TOKENS = 16384;

const MJ_WORLD_BODY_OPEN = "<mj_world_body>";
const MJ_WORLD_BODY_CLOSE = "</mj_world_body>";
const TAG_USER_STATE_OPEN = "<USER_STATE_TAG>";
const TAG_USER_STATE_CLOSE = "</USER_STATE_TAG>";
const TAG_SPIRIT_STONE_OPEN = "<SPIRIT_STONE_TAG>";
const TAG_SPIRIT_STONE_CLOSE = "</SPIRIT_STONE_TAG>";
const TAG_ITEM_ADD_OPEN = "<ITEM_ADD_TAG>";
const TAG_ITEM_ADD_CLOSE = "</ITEM_ADD_TAG>";
const TAG_ITEM_REMOVE_OPEN = "<ITEM_REMOVE_TAG>";
const TAG_ITEM_REMOVE_CLOSE = "</ITEM_REMOVE_TAG>";
const TAG_NPC_NEARBY_OPEN = "<NPC_NEARBY_TAG>";
const TAG_NPC_NEARBY_CLOSE = "</NPC_NEARBY_TAG>";
const TAG_NPC_CORE_CHANGE_OPEN = "<MJ_NPC_CORE_CHANGE_TAG>";
const TAG_NPC_CORE_CHANGE_CLOSE = "</MJ_NPC_CORE_CHANGE_TAG>";
const TAG_FACTION_OPEN = "<MJ_FACTION_TAG>";
const TAG_FACTION_CLOSE = "</MJ_FACTION_TAG>";
const TAG_BATTLE_TRIGGER_OPEN = "<BATTLE_TRIGGER_TAG>";
const TAG_BATTLE_TRIGGER_CLOSE = "</BATTLE_TRIGGER_TAG>";
const TAG_STORY_SNAPSHOT_OPEN = "<mj_story_snapshot>";
const TAG_STORY_SNAPSHOT_CLOSE = "</mj_story_snapshot>";
const TAG_ACTION_OPTIONS_OPEN = "<MJ_ACTION_OPTIONS_TAG>";
const TAG_ACTION_OPTIONS_CLOSE = "</MJ_ACTION_OPTIONS_TAG>";
const TAG_SCENE_OPEN = "<MJ_SCENE_TAG>";
const TAG_SCENE_CLOSE = "</MJ_SCENE_TAG>";
const TAG_HP_MP_OPEN = "<MJ_HP_MP_TAG>";
const TAG_HP_MP_CLOSE = "</MJ_HP_MP_TAG>";
const TAG_TIME_OPEN = "<MJ_TIME_TAG>";
const TAG_TIME_CLOSE = "</MJ_TIME_TAG>";
const TAG_BREAKTHROUGH_OPEN = "<MJ_BREAKTHROUGH_TAG>";
const TAG_BREAKTHROUGH_CLOSE = "</MJ_BREAKTHROUGH_TAG>";

function extractWorldBody(raw: string): WorldLocation | null {
  const s = raw == null ? "" : String(raw);
  const i = s.indexOf(MJ_WORLD_BODY_OPEN);
  if (i < 0) return null;
  const from = i + MJ_WORLD_BODY_OPEN.length;
  const j = s.indexOf(MJ_WORLD_BODY_CLOSE, from);
  const text = j < 0 ? s.slice(from).trim() : s.slice(from, j).trim();
  return parseWorldLocationFromDash(text);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const VALID_MAJOR_SET = new Set<string>(REALM_ORDER as readonly string[]);
const VALID_MINOR_SET = new Set<string>(SUB_STAGES as readonly string[]);

const VALID_RACE_SET = new Set<string>(["修仙者", "人形妖兽", "妖兽"]);

function sanitizeRace(raw: unknown): NpcRace {
  if (typeof raw === "string" && VALID_RACE_SET.has(raw)) return raw as NpcRace;
  return "修仙者";
}

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

/**
 * 解析 NPC 的 currentLocation 字段。兼容两种 AI 输出形式：
 * - 对象：{ region, country, area, detail }（推荐）
 * - 字符串：四级 dash（如 "天南-越国-黄枫谷-外门"）
 *
 * 解析失败返回 undefined，由上游用主角当前地点兜底。
 */
function sanitizeNpcCurrentLocation(raw: unknown): WorldLocation | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return parseWorldLocationFromDash(trimmed) ?? undefined;
  }
  if (typeof raw === "object") {
    const cl = raw as { region?: unknown; country?: unknown; area?: unknown; detail?: unknown };
    const region = typeof cl.region === "string" ? cl.region.trim() : "";
    if (!region) return undefined;
    return {
      region,
      country: typeof cl.country === "string" ? cl.country.trim() : "",
      area: typeof cl.area === "string" ? cl.area.trim() : "",
      detail: typeof cl.detail === "string" ? cl.detail.trim() : "",
    };
  }
  return undefined;
}

function parseNearbyNpcs(raw: string): NpcNearbyEntry[] {
  const text = extractTagContent(raw, TAG_NPC_NEARBY_OPEN, TAG_NPC_NEARBY_CLOSE);
  const arr = tryParseJsonArray(text) ?? [];
  return arr
    .map((e: unknown): NpcNearbyEntry | null => {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      const displayName = String(o.displayName || "").trim();
      if (!displayName) return null;
      const realm = sanitizeRealm(o.realm);
      const linggenRaw = o.linggen;
      const linggen = Array.isArray(linggenRaw)
        ? linggenRaw.map((x: unknown) => String(x).trim()).filter(Boolean)
        : typeof linggenRaw === "string"
          ? linggenRaw.split("").filter((c: string) => "金木水火土".includes(c))
          : [];
      // 画像提示词（性格 / 记忆 / 外貌）：只取非空字符串，长度截断避免提示词膨胀。
      const rawProfile = o.profile && typeof o.profile === "object"
        ? (o.profile as Record<string, unknown>)
        : null;
      const pickProfileText = (v: unknown, max: number): string | undefined => {
        if (typeof v !== "string") return undefined;
        const t = v.trim();
        return t ? t.slice(0, max) : undefined;
      };
      const profile = rawProfile
        ? {
            // 记忆刻意不设 500 字上限：它由「超 1000 字压缩到 700 字」控制体积，
            // 这里若截断就永远到不了压缩阈值。
            personality: pickProfileText(rawProfile.personality, PROFILE_FIELD_MAX_LENGTH),
            memory: pickProfileText(rawProfile.memory, MEMORY_MAX_LENGTH),
            appearance: pickProfileText(rawProfile.appearance, PROFILE_FIELD_MAX_LENGTH),
          }
        : undefined;

      const npcIdRaw = typeof o.npcId === "string" ? o.npcId.trim() : "";
      return {
        npcId: npcIdRaw || undefined,
        displayName,
        identity: String(o.identity || ""),
        isDead: o.isDead === true,
        favorability: typeof o.favorability === "number" ? o.favorability : 0,
        race: sanitizeRace(o.race),
        appearance: String(o.appearance || ""),
        clothing: String(o.clothing || ""),
        gender: String(o.gender || "男"),
        age: typeof o.age === "number" ? o.age : 0,
        linggen,
        realm,
        hpPercent: typeof o.hpPercent === "number" ? Math.max(0, Math.min(100, Math.round(o.hpPercent))) : 100,
        mpPercent: typeof o.mpPercent === "number" ? Math.max(0, Math.min(100, Math.round(o.mpPercent))) : 100,
        currentLocation: sanitizeNpcCurrentLocation(o.currentLocation),
        ...(profile ? { profile } : {}),
        equippedSlots: Array.isArray(o.equippedSlots) ? o.equippedSlots : undefined,
        gongfaSlots: Array.isArray(o.gongfaSlots) ? o.gongfaSlots : undefined,
        inventorySlots: Array.isArray(o.inventorySlots) ? o.inventorySlots : undefined,
      };
    })
    .filter((e): e is NpcNearbyEntry => e !== null);
}

const VALID_CORE_SLOTS = new Set<string>(["equipped", "gongfa", "inventory"]);

/**
 * 解析 `<MJ_NPC_CORE_CHANGE_TAG>` —— AI 声明的 NPC 核心层变更事件。
 *
 * 这是「严格事件驱动」策略的入口：核心字段（境界/法宝/功法/储物袋/生死）默认冻结，
 * 只有在此标签里显式声明的事件才会被精确应用。AI 不应在 nearbyNpcs 里直接修改
 * 这些字段。
 *
 * 支持的 event 类型：
 *  - realm_breakthrough  境界突破（含小境界推进）
 *  - equipment_acquired  获得法宝/功法/储物物品
 *  - equipment_lost      失去法宝/功法/储物物品
 *  - combat_damage       战斗伤害/治疗（增量）
 *  - death               死亡
 */
function parseNpcCoreChanges(raw: string): NpcCoreChangeEvent[] {
  const text = extractTagContent(raw, TAG_NPC_CORE_CHANGE_OPEN, TAG_NPC_CORE_CHANGE_CLOSE);
  const trimmed = text.trim();
  if (!trimmed) return [];
  const arr = tryParseJsonArray(text) ?? [];
  const out: NpcCoreChangeEvent[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const npcId = typeof o.npcId === "string" ? o.npcId.trim() : "";
    if (!npcId) continue;
    const event = typeof o.event === "string" ? o.event.trim() : "";
    switch (event) {
      case "realm_breakthrough": {
        const newRealm = sanitizeRealm(o.newRealm);
        out.push({ kind: "realm_breakthrough", npcId, newRealm });
        break;
      }
      case "equipment_acquired": {
        const slot = typeof o.slot === "string" && VALID_CORE_SLOTS.has(o.slot) ? o.slot as "equipped" | "gongfa" | "inventory" : "inventory";
        if (o.data != null) {
          out.push({ kind: "equipment_acquired", npcId, slot, data: o.data });
        }
        break;
      }
      case "equipment_lost": {
        const slot = typeof o.slot === "string" && VALID_CORE_SLOTS.has(o.slot) ? o.slot as "equipped" | "gongfa" | "inventory" : "inventory";
        const slotIndex = typeof o.slotIndex === "number" ? Math.floor(o.slotIndex) : undefined;
        const itemName = typeof o.itemName === "string" ? o.itemName.trim() : undefined;
        const count = typeof o.count === "number" ? Math.max(1, Math.floor(o.count)) : undefined;
        out.push({ kind: "equipment_lost", npcId, slot, slotIndex, itemName, count });
        break;
      }
      case "combat_damage": {
        const hpDelta = typeof o.hpDelta === "number" ? Math.round(o.hpDelta) : undefined;
        const mpDelta = typeof o.mpDelta === "number" ? Math.round(o.mpDelta) : undefined;
        if (hpDelta !== undefined || mpDelta !== undefined) {
          out.push({ kind: "combat_damage", npcId, hpDelta, mpDelta });
        }
        break;
      }
      case "death": {
        out.push({ kind: "death", npcId });
        break;
      }
      default:
        // 未知事件类型忽略
        break;
    }
  }
  return out;
}

/**
 * 解析 `<MJ_FACTION_TAG>` —— AI 声明的势力变更事件（add / update）。
 *
 * 与 NPC 核心变更同属「变更事件式」标签：绝大多数回合为空数组。
 * 逐元素跳过脏数据，不抛异常；`op` 非 add/update 一律丢弃。
 */
function parseFactionChanges(raw: string): FactionChange[] {
  const text = extractTagContent(raw, TAG_FACTION_OPEN, TAG_FACTION_CLOSE);
  if (!text.trim()) return [];
  const arr = tryParseJsonArray(text) ?? [];
  const out: FactionChange[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) continue;
    const op = o.op === "update" ? "update" : o.op === "add" ? "add" : null;
    if (!op) continue;
    const entry: FactionChange = { op, name };
    if (typeof o.type === "string" && o.type.trim()) entry.type = o.type.trim();
    if (typeof o.locationText === "string") entry.locationText = o.locationText.trim();
    if (typeof o.demands === "string") entry.demands = o.demands.trim();
    if (typeof o.relation === "string") entry.relation = o.relation.trim();
    if (typeof o.desc === "string") entry.desc = o.desc.trim();
    if (o.power && typeof o.power === "object") {
      const p = o.power as Record<string, unknown>;
      const power: Partial<FactionChange["power"]> = {};
      for (const key of ["yuanying", "jiedan", "zhuji"] as const) {
        if (typeof p[key] === "number" && Number.isFinite(p[key])) power[key] = p[key] as number;
      }
      if (Object.keys(power).length > 0) entry.power = power;
    }
    out.push(entry);
  }
  return out;
}

function parseCombatantList(arr: unknown[]): BattleCombatant[] {
  return arr
    .map((e: unknown): BattleCombatant | null => {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      const displayName = String(o.displayName || "").trim();
      if (!displayName) return null;
      return { displayName, roleHint: String(o.roleHint || "") };
    })
    .filter((e): e is BattleCombatant => e !== null);
}

function parseBattleTrigger(raw: string): BattleTriggerEntry | null {  const text = extractTagContent(raw, TAG_BATTLE_TRIGGER_OPEN, TAG_BATTLE_TRIGGER_CLOSE);
  if (!text.trim()) return null;
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.shouldEnterBattle !== true) return null;
  const triggerKind = o.triggerKind === "active" ? "active" as const : "passive" as const;
  const triggerReason = String(o.triggerReason || "").trim();
  const allies = Array.isArray(o.allies) ? parseCombatantList(o.allies) : [];
  const enemies = Array.isArray(o.enemies) ? parseCombatantList(o.enemies) : [];
  if (allies.length === 0 || enemies.length === 0) return null;
  // 战斗性质：仅 "spar" 视为切磋，其余（含缺省）一律死斗。
  const lethality: BattleLethality = o.lethality === "spar" ? "spar" : "kill";
  return { shouldEnterBattle: true, triggerKind, triggerReason, allies, enemies, lethality };
}

/** 协议条目：`（类型:… | 距离:… | 主动方:… | 推进轴:…）[正文]`。 */
const BRANCH_ITEM_RE = /（([^（）]*)）\s*\[([\s\S]*?)\]/g;

/** 中文键 → 字段名的映射（同时容忍旧式英文键与旧协议字段，便于兼容历史输出）。 */
const BRANCH_KEY_MAP: Record<string, keyof BranchOption> = {
  "类型": "type",
  "距离": "distance",
  "推进轴": "axis",
  "轴": "axis",
  "主动方": "actor",
  // 旧协议字段：读到就归档，不再用于约束。
  "承接": "hook",
  "强度": "intensity",
  "type": "type",
  "distance": "distance",
  "hook": "hook",
  "axis": "axis",
  "actor": "actor",
  "intensity": "intensity",
};

/** 解析元信息串：`类型:当下行动 | 距离:邻近 | …`（分隔符为 |，键值分隔符为 : 或 ：）。 */
function parseBranchMeta(meta: string): Partial<BranchOption> {
  const out: Partial<BranchOption> = {};
  for (const seg of meta.split("|")) {
    const m = seg.trim().match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!m) continue;
    const field = BRANCH_KEY_MAP[m[1].trim()];
    if (field) out[field] = m[2].trim();
  }
  return out;
}

/** 补齐元信息缺省值，保证前端渲染不会拿到空标签。 */
function finalizeBranch(item: Partial<BranchOption>): BranchOption | null {
  const text = (item.text ?? "").trim();
  if (!text) return null;
  return {
    type: item.type?.trim() || "当下行动",
    distance: item.distance?.trim() || "邻近",
    axis: item.axis?.trim() || "未分类",
    actor: item.actor?.trim() || "B1",
    text,
    ...(item.hook ? { hook: item.hook.trim() } : {}),
    ...(item.intensity ? { intensity: item.intensity.trim() } : {}),
  };
}

/** 兼容旧格式：{aggressive, moderate, cautious, veryCautious} 四条纯文本。 */
function coerceLegacyOptions(o: Record<string, unknown>): BranchOption[] {
  const keys = ["aggressive", "moderate", "cautious", "veryCautious"] as const;
  const legacyAxis: Record<string, string> = {
    aggressive: "危机/压力",
    moderate: "安顿/差事",
    cautious: "关系试探",
    veryCautious: "安顿/差事",
  };
  const out: BranchOption[] = [];
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== "string" || !v.trim()) continue;
    out.push({
      type: "当下行动",
      distance: k === "aggressive" ? "贴身" : "邻近",
      axis: legacyAxis[k],
      actor: "B1",
      text: v.trim(),
    });
  }
  return out;
}

/**
 * 解析 `<MJ_ACTION_OPTIONS_TAG>` —— 状态 AI 每回合输出的推进选项。
 *
 * 主格式是协议文本：每行一条 `（元信息）[正文]`；
 * 同时容忍 JSON 数组与旧的四倾向对象（模型偶发偏移时不至于整轮丢弃）。
 * 标签缺失 / 解析失败 / 无有效条目 → 返回 null（前端隐藏按钮区）。
 */
export function parseActionOptions(raw: string): ActionSuggestions | null {
  const text = extractTagContent(raw, TAG_ACTION_OPTIONS_OPEN, TAG_ACTION_OPTIONS_CLOSE);
  if (!text.trim()) return null;

  const items: BranchOption[] = [];
  BRANCH_ITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRANCH_ITEM_RE.exec(text)) !== null) {
    const item = finalizeBranch({ ...parseBranchMeta(m[1]), text: m[2] });
    if (item) items.push(item);
    if (items.length >= 10) break;
  }

  if (items.length === 0) {
    const obj = safeJsonParse(text);
    if (Array.isArray(obj)) {
      for (const e of obj) {
        if (!e || typeof e !== "object") continue;
        const o = e as Record<string, unknown>;
        const item = finalizeBranch({
          type: typeof o["类型"] === "string" ? o["类型"] : typeof o.type === "string" ? o.type : "",
          distance: typeof o["距离"] === "string" ? o["距离"] : typeof o.distance === "string" ? o.distance : "",
          axis: typeof o["推进轴"] === "string" ? o["推进轴"] : typeof o.axis === "string" ? o.axis : "",
          actor: typeof o["主动方"] === "string" ? o["主动方"] : typeof o.actor === "string" ? o.actor : "",
          text: typeof o["正文"] === "string" ? o["正文"] : typeof o.text === "string" ? o.text : "",
        });
        if (item) items.push(item);
        if (items.length >= 10) break;
      }
    } else if (obj && typeof obj === "object") {
      items.push(...coerceLegacyOptions(obj as Record<string, unknown>));
    }
  }

  return items.length > 0 ? items : null;
}

/**
 * 归一化存档里的推进选项：兼容旧存档的四倾向对象结构。
 *
 * 旧存档恢复时若直接当数组渲染会得到 undefined 按钮，故统一在此收口。
 */
export function normalizeActionSuggestions(data: unknown): ActionSuggestions | null {
  if (!data) return null;
  if (Array.isArray(data)) {
    const items: BranchOption[] = [];
    for (const e of data) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      const item = finalizeBranch({
        type: typeof o.type === "string" ? o.type : "",
        distance: typeof o.distance === "string" ? o.distance : "",
        axis: typeof o.axis === "string" ? o.axis : "",
        actor: typeof o.actor === "string" ? o.actor : "",
        text: typeof o.text === "string" ? o.text : "",
      });
      if (item) items.push(item);
    }
    return items.length > 0 ? items : null;
  }
  if (typeof data === "object") return coerceLegacyOptions(data as Record<string, unknown>).length > 0
    ? coerceLegacyOptions(data as Record<string, unknown>)
    : null;
  return null;
}

/**
 * 场景进度报告（秘境层 / 擂台轮），见 state_preset「场景进度规则」。
 *
 * 由状态 AI 输出，程序据此维护波次配额并在触顶时注入收束指令。
 * 类型定义收在 sceneBudgetStore（配额与进度同源），此处转出给调用方。
 */
export type { SceneReport } from "../role_core/sceneBudgetStore";

/**
 * 解析 `<MJ_SCENE_TAG>` —— 状态 AI 报告的场景进度。
 *
 * 容错：标签缺失 / 解析失败 / kind 非法 → 返回 null（不改动程序侧进度）。
 */
export function parseSceneReport(raw: string): SceneReport | null {
  const text = extractTagContent(raw, TAG_SCENE_OPEN, TAG_SCENE_CLOSE);
  if (!text.trim()) return null;
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const rawKind = String(o.kind || "").trim();
  const kind = rawKind === "秘境" || rawKind === "擂台" ? rawKind : "无";
  const num = (v: unknown, dflt: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : dflt;
  };
  return {
    kind,
    name: String(o.name || "").trim(),
    stage: Math.max(0, num(o.stage, 0)),
    total: Math.max(0, num(o.total, 0)),
    ended: o.ended === true,
  };
}

function parseHpMp(raw: string): HpMpState | null {
  const text = extractTagContent(raw, TAG_HP_MP_OPEN, TAG_HP_MP_CLOSE);
  if (!text.trim()) return null;
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const hasHp = typeof o.hpPercent === "number";
  const hasMp = typeof o.mpPercent === "number";
  if (!hasHp && !hasMp) return null;
  return {
    hpPercent: hasHp ? Math.max(0, Math.min(100, Math.round(o.hpPercent as number))) : 100,
    mpPercent: hasMp ? Math.max(0, Math.min(100, Math.round(o.mpPercent as number))) : 100,
  };
}

function parseTimeAdvance(raw: string): TimeDelta | null {
  const text = extractTagContent(raw, TAG_TIME_OPEN, TAG_TIME_CLOSE);
  if (!text.trim()) return null;
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const rawTime = o.timeAdvance ?? o;
  if (!rawTime || typeof rawTime !== "object") return null;
  const td = rawTime as Record<string, unknown>;
  const years = typeof td.years === "number" ? Math.max(0, Math.floor(td.years)) : undefined;
  const months = typeof td.months === "number" ? Math.max(0, Math.floor(td.months)) : undefined;
  const days = typeof td.days === "number" ? Math.max(0, Math.floor(td.days)) : undefined;
  const hour = typeof td.hour === "number" ? Math.max(0, Math.floor(td.hour)) : undefined;
  if (years || months || days || hour !== undefined) {
    return { years, months, days, hour };
  }
  return null;
}

function parseBreakthrough(raw: string): BreakthroughState | null {
  const text = extractTagContent(raw, TAG_BREAKTHROUGH_OPEN, TAG_BREAKTHROUGH_CLOSE);
  if (!text.trim()) return null;
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const realmBreakthrough = o.realmBreakthrough === true ? true : undefined;
  const breakthroughQuestStart = o.breakthroughQuestStart === true ? true : undefined;
  const breakthroughFailed = o.breakthroughFailed === true ? true : undefined;
  if (!realmBreakthrough && !breakthroughQuestStart && !breakthroughFailed) return null;
  return { realmBreakthrough, breakthroughQuestStart, breakthroughFailed };
}

function parseUserState(raw: string): UserStateChange | null {
  const userStateText = extractTagContent(raw, TAG_USER_STATE_OPEN, TAG_USER_STATE_CLOSE);
  if (!userStateText.trim()) return null;
  const obj = safeJsonParse(userStateText);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const xiuweiIncrease = typeof o.xiuweiIncrease === "number" ? Math.max(0, Math.floor(o.xiuweiIncrease)) : undefined;
  const rawMastery = o.gongfaMasteryChanges;
  let gongfaMasteryChanges: Array<{ gongfaName: string; masteryExpIncrease: number }> | undefined;
  if (Array.isArray(rawMastery)) {
    const parsed = rawMastery
      .map((e: unknown) => {
        if (!e || typeof e !== "object") return null;
        const m = e as Record<string, unknown>;
        const gongfaName = String(m.gongfaName || "").trim();
        const val = typeof m.masteryExpIncrease === "number" ? m.masteryExpIncrease
          : typeof m.masteryIncrease === "number" ? m.masteryIncrease
          : 0;
        const masteryExpIncrease = Math.max(1, Math.floor(val));
        return gongfaName ? { gongfaName, masteryExpIncrease } : null;
      })
      .filter((e): e is { gongfaName: string; masteryExpIncrease: number } => e !== null);
    if (parsed.length > 0) gongfaMasteryChanges = parsed;
  }
  if (!xiuweiIncrease && !gongfaMasteryChanges) return null;
  const result: UserStateChange = {};
  if (xiuweiIncrease) result.xiuweiIncrease = xiuweiIncrease;
  if (gongfaMasteryChanges) result.gongfaMasteryChanges = gongfaMasteryChanges;
  return result;
}

/**
 * 解析状态 AI 的完整输出。
 *
 * @param raw                  AI 原始输出
 * @param storyBody            本轮剧情正文（可选）。
 * @param inputProtagonistName 主角名（可选）。
 * 传入 storyBody 后会以正文为事实来源校验 NPC 的境界/数量一致性，
 * 并把与正文冲突的境界自动纠正回正文原词。见 {@link checkNpcConsistency}。
 */
export function parseStateAiResponse(
  raw: string,
  storyBody?: string,
  inputProtagonistName?: string,
): StateParsed {
  const worldLocation = extractWorldBody(raw);

  const hpMp = parseHpMp(raw);
  const userState = parseUserState(raw);
  const timeAdvance = parseTimeAdvance(raw);
  const breakthrough = parseBreakthrough(raw);

  const spiritStoneText = extractTagContent(raw, TAG_SPIRIT_STONE_OPEN, TAG_SPIRIT_STONE_CLOSE);
  const itemAddText = extractTagContent(raw, TAG_ITEM_ADD_OPEN, TAG_ITEM_ADD_CLOSE);
  const itemRemoveText = extractTagContent(raw, TAG_ITEM_REMOVE_OPEN, TAG_ITEM_REMOVE_CLOSE);

  const stoneArr = tryParseJsonArray(spiritStoneText) ?? [];
  const spiritStoneChanges: SpiritStoneChange[] = stoneArr
    .map((e: unknown) => {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      const op = String(o.op || "").trim();
      if (op !== "add" && op !== "remove") return null;
      const count = typeof o.count === "number" ? Math.max(1, Math.floor(o.count)) : 1;
      return { op, count } as SpiritStoneChange;
    })
    .filter((c): c is SpiritStoneChange => c !== null);

  const addArr = tryParseJsonArray(itemAddText) ?? [];
  const itemAdds: ItemAddEntry[] = addArr
    .map((e: unknown) => {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      const type = String(o.type || "").trim();
      const name = String(o.name || "").trim();
      const intro = String(o.intro || "").trim();
      const grade = String(o.grade || "下品").trim();
      const count = typeof o.count === "number" ? Math.max(1, Math.floor(o.count)) : 1;
      if (!name) return null;
      return {
        type, name, intro, grade, count,
        ...(o.system != null ? { system: o.system } : {}),
        ...(o.role != null ? { role: o.role } : {}),
        ...(o.function != null ? { function: o.function } : {}),
        ...(o.bonus != null ? { bonus: o.bonus } : {}),
      } as ItemAddEntry;
    })
    .filter((e): e is ItemAddEntry => e !== null);

  const removeArr = tryParseJsonArray(itemRemoveText) ?? [];
  const itemRemoves: ItemRemoveEntry[] = removeArr
    .map((e: unknown) => {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      const name = String(o.name || "").trim();
      const count = typeof o.count === "number" ? Math.max(1, Math.floor(o.count)) : 1;
      if (!name) return null;
      return { name, count } as ItemRemoveEntry;
    })
    .filter((e): e is ItemRemoveEntry => e !== null);

  const nearbyNpcs = parseNearbyNpcs(raw);

  // 以剧情正文为事实来源，纠正与正文冲突的 NPC 境界（数量/名字问题只告警）。
  const npcConsistency = storyBody
    ? checkNpcConsistency(storyBody, nearbyNpcs, inputProtagonistName)
    : null;

  const npcCoreChanges = parseNpcCoreChanges(raw);

  const battleTrigger = parseBattleTrigger(raw);

  const storySnapshot = extractTagContent(raw, TAG_STORY_SNAPSHOT_OPEN, TAG_STORY_SNAPSHOT_CLOSE);

  const actionOptions = parseActionOptions(raw);
  const sceneReport = parseSceneReport(raw);
  const factionChanges = parseFactionChanges(raw);

  return {
    worldLocation,
    hpMp,
    userState,
    timeAdvance,
    breakthrough,
    spiritStoneChanges,
    itemAdds,
    itemRemoves,
    nearbyNpcs,
    npcCoreChanges,
    factionChanges,
    battleTrigger,
    storySnapshot,
    actionOptions,
    sceneReport,
    npcConsistency,
  };
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

function formatGongfaSlots(slots: GongfaSlotsState, realmMajor?: string): string {
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const g = slots[i];
    if (!g) continue;
    const mastery = g.mastery ?? 1;
    const exp = g.masteryExp ?? 0;
    const maxLayer = gongfaMaxLayerOf(g);
    const expStr = mastery < maxLayer ? `，进度${exp}` : "";
    // 阶层面直接暴露给状态 AI：功法阶层低于主角境界时修炼不产修为（见 state_preset 3.5）。
    const gTier = resolveGongfaTier(g.tier);
    const tierStr = gTier ? `${gTier}阶·` : "";
    const obsoleteStr = gTier && isGongfaObsolete(gTier, realmMajor)
      ? "【已不入流·修炼不产修为】"
      : "";
    lines.push(`功法：${g.name}（${tierStr}${g.grade}，第${mastery}层/${maxLayer}层${expStr}）${obsoleteStr}${g.desc ? "—" + g.desc : ""}`);
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

function buildStateUserContent(input: StateGenerateInput): string {
  const p = input.protagonist;

  const npcSection = input.npcSnapshot?.trim()
    ? `\n【当前场景NPC】\n${input.npcSnapshot.trim()}\n`
    : "";

  const locationHint = input.currentWorldLocation
    ? `\n主角当前所在地点（本轮剧情发生前·出发点）：${formatWorldLocationDash(input.currentWorldLocation)}`
    : "";

  const timeHint = input.currentWorldTime
    ? `\n当前世界时间：${formatWorldTimeZhDisplay(input.currentWorldTime)}`
    : "";

  // 推进轴轮换：把最近 3 轮用过的轴告诉 AI，避免连续多轮只在同一类轴里打转。
  const axes = input.recentBranchAxes?.filter(a => a && a.trim()) ?? [];
  const axesHint = axes.length > 0
    ? `\n【推进轴轮换】最近3轮已出现的推进轴：${Array.from(new Set(axes.map(a => a.trim()))).join("、")}。本轮优先补齐其中缺失的核心轴（浪漫/艳遇、危机/压力、机缘/异常），不要连续三轮只在同类轴里打转。`
    : "";

  // 上轮选项回传：玩家没选的就是拒绝了，不要把同样的东西再端上来。
  const prevOpts = (input.recentOptionTexts ?? [])
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .slice(0, 4);
  const prevOptsHint = prevOpts.length > 0
    ? `\n【上轮选项】上一轮给出的选项正文如下（无论玩家是否选用）：\n${prevOpts.map(t => `- ${t}`).join("\n")}\n本轮 4 条中至多 1 条与上述选项的核心对象相同；玩家未选中的方向视为已拒绝，不要重复端上来。`
    : "";


  // 势力档案：供状态 AI 建选项与判定势力变更时参照（与剧情 AI 注入的是同一份）。
  const factionSnapshot = factionStore.formatFactionSnapshot();
  const factionSection = factionSnapshot
    ? `\n【已登记势力】\n${factionSnapshot}\n（名称与关系以此为准；仅在诉求/关系实质变化或战力曝光时才在 <MJ_FACTION_TAG> 中声明变更）\n`
    : "";

  // 篇章指令：无篇章时返回空串，不注入（零打扰）。主线作为篇章的上位方向一并带进去。
  const chapterDirective = buildChapterDirective(getWorldPreset().storyOutline).trim();

  return [
    "【剧情正文】",
    input.storyBody,
    "",
    "【主角当前状态】",
    `姓名：${p.displayName}`,
    genderLine(p.gender),
    `境界：${p.realm.major}${p.realm.minor}${p.realmComplete ? "·圆满" : ""}`,
    `修为状态：${p.realmComplete ? "修为已圆满" : "修为未圆满"}`,
    `突破状态：${p.realmComplete ? (p.breakthroughStatus === "in_quest" ? "突破任务进行中" : describeNextBreakthrough(p.realm.major, p.realm.minor)) : "修为未圆满"}`,
    `当前血量：${p.currentHp}/${p.maxHp}`,
    `当前法力：${p.currentMp}/${p.maxMp}`,
    `灵根：${(p as { linggen?: string[] }).linggen?.join("") || "无"}`,
    locationHint,
    timeHint,
    "",
    "【装备】",
    formatEquippedSlots(p.equippedSlots),
    "",
    "【功法】",
    formatGongfaSlots(p.gongfaSlots, p.realm.major),
    "",
    "【储物袋】",
    formatInventorySlots(p.inventorySlots),
    factionSection,
    npcSection,
    axesHint,
    prevOptsHint,
    // 篇章指令：无篇章时返回空串，不注入（零打扰）。主线作为篇章的上位方向一并带进去。
    chapterDirective ? `\n\n${chapterDirective}` : "",
    // 场景配额硬约束：触顶时强制收束秘境/擂台，避免无限刷波。
    input.sceneDirective?.trim() ? `\n\n${input.sceneDirective.trim()}` : "",
  ].join("\n");
}

export async function generateState(input: StateGenerateInput): Promise<StateParsed> {
  // 世界观取玩家当前设定（可能在「世界设定」里改过），与剧情 AI 共用同一份。
  const worldPreset = getWorldPreset();
  const systemParts = [composeStateSystemPreset(worldPreset.worldView)];
  // 主线（长期方向）也要喂给状态 AI：状态 AI 决定世界与 NPC 的长期演化，
  // 只给世界观的话，「谁得势、哪条线索延续、什么机缘出现」会与玩家设定的长期方向脱节。
  const mainline = formatMainline(worldPreset);
  if (mainline) systemParts.push(mainline);
  // 性别称呼硬约束：状态 AI 负责写 NPC 记忆，缺这条会把主角记成相反性别，
  // 而 NPC 记忆又会被每一轮剧情生成读回，形成自我强化的串味循环。
  const genderHint = genderRule(input.protagonist?.gender);
  if (genderHint) systemParts.push(genderHint);

  const messages = [
    { role: "system" as const, content: systemParts.join("\n\n") },
    { role: "user" as const, content: buildStateUserContent(input) },
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
  return parseStateAiResponse(raw, input.storyBody, input.protagonist.displayName);
}
