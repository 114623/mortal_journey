/**
 * @fileoverview 命运抉择：仅表单状态、灵根/词条随机与 JSON 结果构造（不计算角色属性）。
 */

import { computed, ref } from "vue";
import type { TraitRarity, TraitSample } from "./traits";
import { traitSamples } from "./traits";
import type { BirthDefinition, DifficultyLevel, TraitRarityWeightRow } from "./types";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { formatWorldLocationDash } from "../role_core/types/worldLocation";
import {
  CREATION_BIRTHS,
  CREATION_GENDERS,
  CUSTOM_REALM_MAJORS,
  CUSTOM_REALM_MINORS,
  DIFFICULTY_OPTIONS,
  LINGGEN_TYPE_PREFIXES,
  rollRandomLinggenName,
  START_REALM_MAJOR,
  START_REALM_STAGE,
  TRAIT_RARITY_WEIGHTS,
} from "./types";
import type { CustomBirthPayload, FateChoiceResult, NarrationPerson } from "./types";
import "./fateChoice.css";

// ---------------------------------------------------------------------------
// 公共类型与工具函数
// ---------------------------------------------------------------------------

export interface TraitOption extends TraitSample {
  /** 是否锁定（逆天改命时保留）。仅 UI/内部状态，不进入最终结果。 */
  locked?: boolean;
}

/**
 * 从出生定义中取出地点名称（展示用）。
 *
 * @param {BirthDefinition|undefined} bd 出生配置；缺省时视为无地点。
 * @return {string} 去首尾空白后的地点名；无则为 `""`。
 */
function resolveBirthLocationFromDef(bd: BirthDefinition | undefined): WorldLocation | null {
  if (!bd) return null;
  return bd.location;
}

/**
 * 从出生定义中取出地点/背景描述文案。
 *
 * @param {BirthDefinition|undefined} bd 出生配置；缺省时视为无描述。
 * @return {string} 去首尾空白后的描述；无则为 `""`。
 */
function resolveBirthLocationDescFromDef(bd: BirthDefinition | undefined): string {
  if (!bd) return "";
  return String(bd.desc ?? "").trim();
}

/**
 * 从自定义境界文案中解析大境界与小阶段（按出现优先级匹配）。
 *
 * @param {string} text 用户或配置中的境界描述字符串。
 * @return {{major: string, minor: string|null}|null} 解析到的大/小境界；无法识别大境界时为 `null`。
 */
export function parseRealmFromCustomText(text: string): { major: string; minor: string | null } | null {
  const s = String(text || "").trim();
  if (!s) return null;
  let major = "";
  for (let mi = 0; mi < CUSTOM_REALM_MAJORS.length; mi++) {
    const m = CUSTOM_REALM_MAJORS[mi]!;
    if (m === "凡人") continue; // 「凡人」常见于普通文案，最后兜底匹配，避免抢先误判
    if (s.includes(m)) {
      major = m;
      break;
    }
  }
  if (!major && s.includes("凡人")) major = "凡人";
  if (!major) return null;
  let minor = "";
  for (let si = 0; si < CUSTOM_REALM_MINORS.length; si++) {
    if (s.includes(CUSTOM_REALM_MINORS[si]!)) {
      minor = CUSTOM_REALM_MINORS[si]!;
      break;
    }
  }
  return { major, minor };
}

/**
 * 从完整灵根文案中取出五行元素部分（去掉首段类型词）。
 *
 * @param {string|null|undefined} roll 完整灵根文案，例如 `天灵根 木`、`真灵根 金, 水`；空则视为无内容。
 * @return {string} 元素串，例如 `木`、`金, 水`；仅类型无元素或无法解析时为 `""`。
 */
export function linggenElementsFromRoll(roll: string | null | undefined): string {
  const s = String(roll ?? "").trim();
  if (!s) return "";
  const spaceIdx = s.indexOf(" ");
  if (spaceIdx === -1) {
    return LINGGEN_TYPE_PREFIXES.has(s) ? "" : s;
  }
  const first = s.slice(0, spaceIdx).trim();
  const rest = s.slice(spaceIdx + 1).trim();
  if (rest) return rest;
  return LINGGEN_TYPE_PREFIXES.has(first) ? "" : s;
}

/**
 * 将灵根元素段按逗号拆成数组（去空白、去空项）。
 *
 * @param {string|null|undefined} roll 完整灵根文案，例如 `真灵根 金, 火`。
 * @return {string[]} 元素名数组，例如 `["金", "火"]`；无元素时为 `[]`。
 */
export function linggenElementsArrayFromRoll(roll: string | null | undefined): string[] {
  const part = linggenElementsFromRoll(roll);
  if (!part) return [];
  return part
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// ---------------------------------------------------------------------------
// 词条随机内部工具
// ---------------------------------------------------------------------------

function rollTraitRarityFromWeights(rows: readonly TraitRarityWeightRow[]): TraitRarity {
  if (!rows.length) return "平庸";
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const w = rows[i]!.weight;
    sum += typeof w === "number" && isFinite(w) && w > 0 ? w : 0;
  }
  if (sum <= 0) return rows[0]!.rarity || "平庸";
  const r = Math.random() * sum;
  let acc = 0;
  for (let j = 0; j < rows.length; j++) {
    const wj = rows[j]!.weight;
    const nw = typeof wj === "number" && isFinite(wj) && wj > 0 ? wj : 0;
    if (nw <= 0) continue;
    acc += nw;
    if (r < acc) return rows[j]!.rarity || "平庸";
  }
  return rows[rows.length - 1]!.rarity || "平庸";
}

function cloneTraitForOption(t: TraitSample): TraitOption {
  return { name: t.name, rarity: t.rarity, desc: t.desc, effect: t.effect };
}

function pickRandomTraits(pool: readonly TraitSample[], excludeNames: string[], count: number): TraitOption[] {
  let bag = pool.filter((t) => t && t.name && excludeNames.indexOf(t.name) === -1);
  const out: TraitOption[] = [];
  for (let i = 0; i < count && bag.length; i++) {
    const rarity = rollTraitRarityFromWeights(TRAIT_RARITY_WEIGHTS);
    const candidates = bag.filter((x) => x.rarity === rarity);
    const pickFrom = candidates.length ? candidates : bag;
    const idx = Math.floor(Math.random() * pickFrom.length);
    const pickedName = pickFrom[idx]!.name;
    bag = bag.filter((x) => !x || x.name !== pickedName);
    out.push(cloneTraitForOption(pickFrom[idx]!));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 出身内部工具
// ---------------------------------------------------------------------------

function buildOrderedBirthKeys(): string[] {
  const out = Object.keys(CREATION_BIRTHS).filter((k) => k !== "自定义");
  out.push("自定义");
  return out;
}

function makePresetCustomBirth(birthKey: string): CustomBirthPayload | null {
  const bd = CREATION_BIRTHS[birthKey];
  if (!bd) return null;
  const loc = bd.location;
  const bg = resolveBirthLocationDescFromDef(bd) || "";
  const locStr = formatWorldLocationDash(loc) || birthKey;
  return {
    tag: locStr,
    name: locStr,
    location: loc,
    realmMajor: START_REALM_MAJOR,
    realmMinor: START_REALM_STAGE,
    realmText: START_REALM_MAJOR + START_REALM_STAGE,
    background: bg,
    presetBirthKey: birthKey,
  };
}

// ===========================================================================
// useFateChoice：按 UI 选择顺序组织
// ===========================================================================

/**
 * 命运抉择表单与随机逻辑。
 * 内部状态按 UI 选择顺序排列：姓名 → 叙事人称 → 性别 → 出身 → 词条 → 灵根 → 提交。
 */
export function useFateChoice() {
  // ── 0. 难度 ──────────────────────────────────────────────────────────────
  const selectedDifficulty = ref<DifficultyLevel>("简单");

  // ── 1. 姓名 ──────────────────────────────────────────────────────────────
  const playerName = ref("无限");

  // ── 2. 叙事人称 ──────────────────────────────────────────────────────────
  const narrationPerson = ref<NarrationPerson>("first");

  // ── 3. 性别 ──────────────────────────────────────────────────────────────
  const selectedGender = ref<string>(CREATION_GENDERS[0]!);

  // ── 4. 出身 ──────────────────────────────────────────────────────────────
  const birthKeysOrdered = buildOrderedBirthKeys();
  const DEFAULT_BIRTH_KEY = birthKeysOrdered[0] ?? "自定义";
  const selectedBirth = ref(DEFAULT_BIRTH_KEY);
  const customBirth = ref<CustomBirthPayload | null>(null);
  const birthLocation = ref<WorldLocation | null>(null);

  /** 非「自定义」时，用当前选中的预设出生同步 `customBirth` 与 `birthLocation`。 */
  function syncCustomBirthForCurrentSelection(): void {
    if (selectedBirth.value === "自定义") return;
    const bd = CREATION_BIRTHS[selectedBirth.value];
    if (!bd) return;
    customBirth.value = makePresetCustomBirth(selectedBirth.value);
    birthLocation.value = resolveBirthLocationFromDef(bd);
  }

  /** 选择预设出生（忽略名为 `自定义` 的调用）。 */
  function selectBirth(name: string): void {
    if (name === "自定义") return;
    selectedBirth.value = name;
    syncCustomBirthForCurrentSelection();
  }

  function applyCustomBirth(payload: CustomBirthPayload): void {
    selectedBirth.value = "自定义";
    birthLocation.value = payload.location;
    customBirth.value = payload;
  }

  /** 根据当前出生载荷解析有效起始大/小境界。 */
  function getEffectiveStartRealm(): { major: string; minor: string | null } {
    const cb = customBirth.value;
    if (cb) {
      if (cb.realmMajor && (CUSTOM_REALM_MAJORS as readonly string[]).includes(cb.realmMajor)) {
        const mn =
          cb.realmMinor && (CUSTOM_REALM_MINORS as readonly string[]).includes(cb.realmMinor)
            ? cb.realmMinor
            : START_REALM_STAGE;
        return { major: cb.realmMajor, minor: mn };
      }
      if (cb.realmText) {
        const p = parseRealmFromCustomText(cb.realmText);
        if (p && p.major) return { major: p.major, minor: p.minor };
      }
    }
    return { major: START_REALM_MAJOR, minor: START_REALM_STAGE };
  }

  function resolveStartBirthLocation(): WorldLocation {
    if (birthLocation.value != null) {
      return birthLocation.value;
    }
    const bd = CREATION_BIRTHS[selectedBirth.value];
    if (bd) {
      const loc = resolveBirthLocationFromDef(bd);
      if (loc) return loc;
    }
    return { region: "", country: "", area: "", detail: "" };
  }

  /** 解析出身故事/背景。 */
  function resolveOriginStory(): string {
    const cb = customBirth.value;
    if (cb != null && String(cb.background || "").trim() !== "") {
      return String(cb.background).trim();
    }
    return "";
  }

  // ── 5. 天赋词条 ──────────────────────────────────────────────────────────
  const currentTraitOptions = ref<TraitOption[]>([]);

  /** 切换某条候选天赋的锁定状态（逆天改命时锁定者不会被替换）。 */
  function toggleTraitLock(index: number): void {
    const t = currentTraitOptions.value[index];
    if (!t) return;
    t.locked = !t.locked;
  }

  /** 随机刷新天赋：锁定的原位保留，仅重摇未锁定的槽位。 */
  function randomizeTraits(): void {
    const current = currentTraitOptions.value;
    const lockedNames = current.filter((t) => t.locked).map((t) => t.name);
    if (lockedNames.length >= 5) return;
    const fresh = pickRandomTraits(traitSamples, lockedNames, 5 - lockedNames.length);
    let fi = 0;
    currentTraitOptions.value = current.map((t) => {
      if (t.locked) return { ...t };
      const replacement = fresh[fi] ?? t;
      fi += 1;
      return { ...replacement };
    });
  }

  // ── 6. 灵根 ──────────────────────────────────────────────────────────────
  const selectedLinggen = ref<string | null>(null);

  /** 随机 roll 一条灵根文案。 */
  function applyRandomLinggen(): void {
    selectedLinggen.value = rollRandomLinggenName();
  }

  // ── 7. 状态与提交 ────────────────────────────────────────────────────────
  const statusMessage = ref("");

  const isReady = computed(
    () =>
      !!selectedBirth.value &&
      !!selectedGender.value &&
      !!selectedLinggen.value &&
      (currentTraitOptions.value?.length ?? 0) > 0,
  );

  /** 根据当前表单状态组装提交用的 {@link FateChoiceResult}。 */
  function buildPayload(): FateChoiceResult {
    const er = getEffectiveStartRealm();
    const np: NarrationPerson =
      narrationPerson.value === "first" || narrationPerson.value === "third"
        ? narrationPerson.value
        : "second";
    return {
      basics: {
        playerName: String(playerName.value || "").trim() || "无限",
        narrationPerson: np,
        gender: selectedGender.value,
        realmMajor: er.major,
        realmMinor: er.minor == null ? null : er.minor,
        birthPlace: resolveStartBirthLocation(),
        originStory: resolveOriginStory(),
        linggen: linggenElementsArrayFromRoll(selectedLinggen.value),
        difficulty: selectedDifficulty.value,
      },
      traits: (currentTraitOptions.value || []).map((t) => ({
        name: t.name,
        rarity: t.rarity,
        desc: t.desc,
        effect: t.effect,
      })),
    };
  }

  // ── 生命周期：重置与初始化 ────────────────────────────────────────────────

  /** 将表单恢复为默认值。 */
  function reset(): void {
    selectedDifficulty.value = "简单";
    playerName.value = "无限";
    narrationPerson.value = "first";
    selectedGender.value = CREATION_GENDERS[0]!;
    selectedBirth.value = DEFAULT_BIRTH_KEY;
    customBirth.value = null;
    birthLocation.value = null;
    currentTraitOptions.value = [];
    selectedLinggen.value = null;
    statusMessage.value = "";
    syncCustomBirthForCurrentSelection();
  }

  /** 若尚无灵根或词条，则各执行一次随机。 */
  function prepareInitialRolls(): void {
    if (!selectedLinggen.value) applyRandomLinggen();
    if (!currentTraitOptions.value.length) {
      currentTraitOptions.value = pickRandomTraits(traitSamples, [], 5);
    }
  }

  return {
    CREATION_BIRTHS,
    CREATION_GENDERS,
    CUSTOM_REALM_MAJORS,
    CUSTOM_REALM_MINORS,
    DIFFICULTY_OPTIONS,
    birthKeysOrdered,
    selectedDifficulty,
    playerName,
    narrationPerson,
    selectedGender,
    selectedBirth,
    customBirth,
    selectBirth,
    applyCustomBirth,
    currentTraitOptions,
    randomizeTraits,
    toggleTraitLock,
    selectedLinggen,
    applyRandomLinggen,
    statusMessage,
    isReady,
    buildPayload,
    reset,
    prepareInitialRolls,
    resolveBirthLocationDescFromDef,
  };
}
