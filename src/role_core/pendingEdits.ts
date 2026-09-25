/**
 * @fileoverview 待应用改动队列：回合进行中保存的编辑，等回合结束后才落地。
 *
 * 玩家在回合进行中（AI 正在写剧情/写状态）改角色画像或世界设定时，
 * 此刻直接写入会被本回合 AI 的输出覆盖，因此先存进队列；
 * `StoryChatPanel` 在一个回合收尾时调用 {@link flushPendingEdits} 统一应用，
 * 保证「玩家的改动压过本回合 AI 的输出」。
 *
 * 非回合期间保存则直接生效，不进队列。
 *
 * 队列随存档持久化——回合中途关掉网页也不会丢。
 */

import { computed, ref } from "vue";
import type { WorldSettingsText } from "../ai/worldSettings";
import type { Character } from "./Character";
import type { Npc } from "./Npc";
import { Protagonist, protagonist } from "./Protagonist";
import { npcStore } from "./npcStore";
import { setWorldSettings } from "./worldSettingsStore";
import { applyNpcGongfaMasteryByRealm, getRealmPrimaryStats } from "./realmUtils";
import { writeActiveSave } from "../save/gameSave";
import { gameLog } from "../log/gameLog";

/** 角色画像草稿（性格 / 外貌 / 记忆 + 归属）。 */
export interface ProfileDraft {
  personality: string;
  appearance: string;
  memory: string;
  /** ai=允许 AI 继续维护；manual=玩家锁定。 */
  source: "ai" | "manual";
}

/** 主角在待应用队列里的键（NPC 用其稳定 npcId）。 */
export const PROTAGONIST_PENDING_KEY = "__protagonist__";

/**
 * 角色基础信息草稿（名字 / 性别 / 年龄 / 寿元 / 境界 / 灵根 / 身份简介）。
 *
 * **主角与 NPC 共用**：两者的可编辑项一致，只有「身份简介」是 NPC 专属
 * （主角没有 identity 字段，草稿里恒为空串，保存时忽略）。
 */
export interface CharacterBasicsDraft {
  /** 目标角色的稳定 id（定位用，草稿本身不改它）。主角为 "protagonist"。 */
  npcId: string;
  displayName: string;
  gender: string;
  age: number;
  shouyuan: number;
  realmMajor: string;
  realmMinor: string;
  linggen: string[];
  /**
   * 身份称谓（仅 NPC）——角色卡与信息界面里「名字下面那行简介」的可编辑部分
   * （显示为「身份 · 境界」）。主角恒为空串。
   */
  identity: string;
}

/** 旧名兼容：本队列原本只有 NPC 在用，主角接入后改叫 {@link CharacterBasicsDraft}。 */
export type NpcBasicsDraft = CharacterBasicsDraft;

/** 待应用改动的存档形态（纯 JSON）。 */
export interface PendingEditsSerial {
  profiles?: Record<string, ProfileDraft>;
  npcBasics?: Record<string, CharacterBasicsDraft>;
  worldSettings?: WorldSettingsText;
}

const pendingProfiles = ref<Record<string, ProfileDraft>>({});
/** 基础信息队列（NPC 用 npcId 作键，主角用 {@link PROTAGONIST_PENDING_KEY}）。 */
const pendingNpcBasics = ref<Record<string, CharacterBasicsDraft>>({});
const pendingWorldSettings = ref<WorldSettingsText | null>(null);

/** 待应用改动总数（画像条数 + NPC 基础信息条数 + 世界设定 0/1）。 */
export const pendingEditCount = computed(
  () => pendingProfileCount.value + pendingNpcBasicsCount.value + (pendingWorldSettings.value ? 1 : 0),
);

/** 待应用的角色画像条数。 */
export const pendingProfileCount = computed(() => Object.keys(pendingProfiles.value).length);

/** 待应用的 NPC 基础信息条数。 */
export const pendingNpcBasicsCount = computed(() => Object.keys(pendingNpcBasics.value).length);

/** 是否有待应用的世界设定。 */
export const hasPendingWorldSettings = computed(() => pendingWorldSettings.value !== null);

export function hasPendingEdits(): boolean {
  return pendingEditCount.value > 0;
}

// ---------------------------------------------------------------------------
// 角色画像
// ---------------------------------------------------------------------------

/** 取某个角色的待应用画像草稿；没有则 null。 */
export function getPendingProfile(key: string): ProfileDraft | null {
  return pendingProfiles.value[key] ?? null;
}

/** 写入/覆盖某个角色的待应用画像草稿。 */
export function setPendingProfile(key: string, draft: ProfileDraft): void {
  pendingProfiles.value = { ...pendingProfiles.value, [key]: draft };
}

/** 丢弃某个角色的待应用画像草稿。 */
export function clearPendingProfile(key: string): void {
  if (!(key in pendingProfiles.value)) return;
  const next = { ...pendingProfiles.value };
  delete next[key];
  pendingProfiles.value = next;
}

/**
 * 计算角色在队列里的键。主角固定用 {@link PROTAGONIST_PENDING_KEY}，
 * NPC 用稳定 npcId（无 id 时退回 `名字#npc`）。
 */
export function pendingKeyOf(character: Character): string {
  if (!character) return "";
  const role = (character as unknown as { role?: string }).role;
  if (role === "protagonist") return PROTAGONIST_PENDING_KEY;
  return character.id || `${character.displayName}#npc`;
}

/** 把草稿写进角色实例（不落盘、不碰队列）。 */
export function applyProfileDraft(character: Character, draft: ProfileDraft): void {
  character.setProfilePersonality(draft.personality);
  character.setProfileAppearance(draft.appearance);
  character.setProfileMemory(draft.memory);
  character.setProfileSource(draft.source === "manual" ? "manual" : "ai");
}

/** 从角色实例读出一份草稿。 */
export function readProfileDraft(character: Character): ProfileDraft {
  return {
    personality: character.profile.personality,
    appearance: character.getProfileAppearance(),
    memory: character.profile.memory,
    source: character.profile.source,
  };
}

// ---------------------------------------------------------------------------
// 角色基础信息（名字 / 性别 / 年龄 / 寿元 / 境界 / 灵根 / 身份简介）
//
// 主角与 NPC 共用同一条队列与同一份草稿结构，见 {@link CharacterBasicsDraft}。
// ---------------------------------------------------------------------------

/** 取某个角色的待应用基础信息草稿；没有则 null。 */
export function getPendingNpcBasics(key: string): CharacterBasicsDraft | null {
  return pendingNpcBasics.value[key] ?? null;
}

/** 写入/覆盖某个角色的待应用基础信息草稿。 */
export function setPendingNpcBasics(key: string, draft: CharacterBasicsDraft): void {
  pendingNpcBasics.value = { ...pendingNpcBasics.value, [key]: { ...draft, linggen: [...draft.linggen] } };
}

/** 丢弃某个角色的待应用基础信息草稿。 */
export function clearPendingNpcBasics(key: string): void {
  if (!(key in pendingNpcBasics.value)) return;
  const next = { ...pendingNpcBasics.value };
  delete next[key];
  pendingNpcBasics.value = next;
}

/** 从角色实例（主角或 NPC）读出一份基础信息草稿。 */
export function readCharacterBasicsDraft(c: Character): CharacterBasicsDraft {
  return {
    npcId: c.id,
    displayName: c.displayName,
    gender: c.gender || "男",
    age: c.age ?? 0,
    shouyuan: c.shouyuan ?? 0,
    realmMajor: c.realm?.major ?? "练气",
    realmMinor: c.realm?.minor ?? "初期",
    linggen: [...(c.linggen ?? [])],
    identity: (c as Npc).identity ?? "",
  };
}

/** 旧名兼容，见 {@link readCharacterBasicsDraft}。 */
export const readNpcBasicsDraft = readCharacterBasicsDraft;

/** 是否为主角（基础信息里只有主角需要额外处理修为与满血）。 */
function isProtagonistCharacter(c: Character): boolean {
  return (c as unknown as { role?: string }).role === "protagonist";
}

/**
 * 把基础信息草稿写进角色实例（主角或 NPC，不落盘、不碰队列）。
 *
 * 两条分支的差异只在境界变动时：
 * - NPC：功法层数按新境界重算（NPC 的层数是「按境界修为总量反推」的快照）；
 * - 主角：主属性重设为境界表基准、修为归零并清掉圆满状态（修为阈值随境界变，
 *   留着旧值会出现「刚升境界就已圆满」这类错乱），气血回满。
 *
 * 改名只改 displayName，不动 store 的键（store 主键是 npcId，改名不影响索引）。
 * 主角不在 store 里，跳过。
 */
export function applyCharacterBasicsDraft(c: Character, draft: CharacterBasicsDraft): void {
  const isProto = isProtagonistCharacter(c);
  const realmChanged =
    c.realm?.major !== draft.realmMajor || c.realm?.minor !== draft.realmMinor;

  c.setDisplayName(draft.displayName);
  c.gender = draft.gender || "男";
  c.setAge(draft.age);
  c.setShouyuan(draft.shouyuan);
  c.setRealm(draft.realmMajor, draft.realmMinor);
  c.linggen = [...draft.linggen];
  if (!isProto) (c as Npc).identity = (draft.identity ?? "").trim();

  if (realmChanged) {
    if (isProto) {
      const p = c as Protagonist;
      const base = getRealmPrimaryStats(draft.realmMajor, draft.realmMinor);
      if (base) p.patchPrimaryStats(base);
      p.setXiuwei(0);
      p.realmComplete = false;
      p.breakthroughStatus = "idle";
      gameLog.info(
        `[PendingEdits] 主角境界改为 ${draft.realmMajor}${draft.realmMinor}，修为已归零、主属性按新境界重算。`,
      );
    } else {
      // 主属性是从境界表实时派生的（realmTableBaseOrStored），改境界即自动生效；
      // 但功法层数是「按境界修为总量反推」的快照，必须显式重算，否则会停在旧境界。
      applyNpcGongfaMasteryByRealm(c.gongfaSlots, draft.realmMajor, draft.realmMinor);
      gameLog.info(
        `[PendingEdits] ${c.displayName} 境界改为 ${draft.realmMajor}${draft.realmMinor}，功法层数已按新境界重算。`,
      );
    }
  }

  // 境界变动会改变境界属性表与 HP/MP 上限，必须重算。
  const { maxHp, maxMp } = c.computeMaxHpMp();
  c.setMaxHpMp(maxHp, maxMp);
  if (isProto) {
    // 主角改境界视同一次改命：气血法力回满，避免旧血量被新上限截断成残血。
    if (realmChanged) c.setCurrentHpMp(maxHp, maxMp);
    Protagonist.notifyChanged();
  } else {
    npcStore.setNpc(c as Npc);
  }
}

/** 旧名兼容，见 {@link applyCharacterBasicsDraft}。 */
export const applyNpcBasicsDraft = applyCharacterBasicsDraft;

// ---------------------------------------------------------------------------
// 世界设定
// ---------------------------------------------------------------------------

/** 取待应用的世界设定；没有则 null。 */
export function getPendingWorldSettings(): WorldSettingsText | null {
  return pendingWorldSettings.value;
}

/** 写入待应用的世界设定。 */
export function setPendingWorldSettings(ws: WorldSettingsText): void {
  pendingWorldSettings.value = { ...ws };
}

/** 丢弃待应用的世界设定。 */
export function clearPendingWorldSettings(): void {
  pendingWorldSettings.value = null;
}

// ---------------------------------------------------------------------------
// 应用 / 序列化
// ---------------------------------------------------------------------------

/** 按队列键找到对应角色实例（主角或 NPC）。 */
function resolveCharacter(key: string): Character | null {
  if (!key) return null;
  if (key === PROTAGONIST_PENDING_KEY) return protagonist.value;
  return npcStore.getNpcById(key) ?? null;
}

/**
 * 应用全部待应用改动，并清空队列。
 *
 * 必须在回合收尾（AI 状态已写完）之后调用，这样玩家改动才不会被 AI 输出覆盖。
 *
 * @returns 实际应用的改动条数。
 */
export function flushPendingEdits(): number {
  let applied = 0;

  // 先应用基础信息（改名不改键），之后再写画像，写入目标始终是同一个 id 键。
  for (const [key, draft] of Object.entries(pendingNpcBasics.value)) {
    const c = resolveCharacter(key);
    if (!c) {
      gameLog.warn(`[PendingEdits] 找不到角色 ${key}，丢弃其待应用基础信息。`);
      continue;
    }
    applyCharacterBasicsDraft(c, draft);
    applied++;
  }

  for (const [key, draft] of Object.entries(pendingProfiles.value)) {
    const c = resolveCharacter(key);
    if (!c) {
      gameLog.warn(`[PendingEdits] 找不到角色 ${key}，丢弃其待应用画像。`);
      continue;
    }
    applyProfileDraft(c, draft);
    // 触发响应式（NPC 在 Map 里，需回写 store；主角走 notifyChanged）。
    if (key === PROTAGONIST_PENDING_KEY) Protagonist.notifyChanged();
    else npcStore.setNpc(c as Npc);
    applied++;
  }

  if (pendingWorldSettings.value) {
    setWorldSettings(pendingWorldSettings.value);
    applied++;
  }

  if (applied > 0) {
    pendingProfiles.value = {};
    pendingNpcBasics.value = {};
    pendingWorldSettings.value = null;
    writeActiveSave();
    gameLog.info(`[PendingEdits] 回合结束，已应用 ${applied} 项待生效改动。`);
  }
  return applied;
}

/** 序列化队列（存进存档）。 */
export function serializePendingEdits(): PendingEditsSerial {
  const out: PendingEditsSerial = {};
  if (Object.keys(pendingProfiles.value).length > 0) {
    out.profiles = { ...pendingProfiles.value };
  }
  if (Object.keys(pendingNpcBasics.value).length > 0) {
    out.npcBasics = { ...pendingNpcBasics.value };
  }
  if (pendingWorldSettings.value) {
    out.worldSettings = { ...pendingWorldSettings.value };
  }
  return out;
}

/** 从存档恢复队列（脏数据自动丢弃）。 */
export function restorePendingEdits(raw: unknown): void {
  pendingProfiles.value = {};
  pendingNpcBasics.value = {};
  pendingWorldSettings.value = null;
  if (!raw || typeof raw !== "object") return;
  const o = raw as PendingEditsSerial;

  const profiles: Record<string, ProfileDraft> = {};
  const src = o.profiles;
  if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== "object") continue;
      const d = v as Partial<ProfileDraft>;
      profiles[k] = {
        personality: typeof d.personality === "string" ? d.personality : "",
        appearance: typeof d.appearance === "string" ? d.appearance : "",
        memory: typeof d.memory === "string" ? d.memory : "",
        source: d.source === "manual" ? "manual" : "ai",
      };
    }
  }
  pendingProfiles.value = profiles;

  const basics: Record<string, CharacterBasicsDraft> = {};
  const bsrc = o.npcBasics;
  if (bsrc && typeof bsrc === "object") {
    for (const [k, v] of Object.entries(bsrc)) {
      if (!v || typeof v !== "object") continue;
      const d = v as Partial<CharacterBasicsDraft>;
      if (typeof d.displayName !== "string") continue;
      basics[k] = {
        npcId: typeof d.npcId === "string" ? d.npcId : k,
        displayName: d.displayName,
        gender: typeof d.gender === "string" ? d.gender : "男",
        age: typeof d.age === "number" && Number.isFinite(d.age) ? Math.max(0, Math.floor(d.age)) : 0,
        shouyuan: typeof d.shouyuan === "number" && Number.isFinite(d.shouyuan) ? Math.max(0, Math.floor(d.shouyuan)) : 0,
        realmMajor: typeof d.realmMajor === "string" ? d.realmMajor : "练气",
        realmMinor: typeof d.realmMinor === "string" ? d.realmMinor : "初期",
        linggen: Array.isArray(d.linggen) ? d.linggen.map((x: unknown) => String(x)) : [],
        identity: typeof d.identity === "string" ? d.identity : "",
      };
    }
  }
  pendingNpcBasics.value = basics;

  if (o.worldSettings && typeof o.worldSettings === "object") {
    const w = o.worldSettings as Partial<WorldSettingsText>;
    if (typeof w.worldView === "string" && typeof w.rules === "string" && typeof w.preset === "string") {
      pendingWorldSettings.value = {
        worldView: w.worldView,
        rules: w.rules,
        preset: w.preset,
        storyOutline: typeof w.storyOutline === "string" ? w.storyOutline : "",
      };
    }
  }
}

/** 清空队列（开新人生 / 读档清场时调用）。 */
export function clearAllPendingEdits(): void {
  pendingProfiles.value = {};
  pendingNpcBasics.value = {};
  pendingWorldSettings.value = null;
}
