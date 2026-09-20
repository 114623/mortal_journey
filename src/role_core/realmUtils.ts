/**
 * 境界相关功能函数：主属性查询、修为需求、寿元、叙事年龄等。
 * 类型和常量数据表定义在 `types/playInfo.ts`。
 */

import type { PrimaryStatKey } from "./types/playInfo";
import type { GongfaItemDefinition } from "./types/itemInfo";
import { gongfaMaxLayer, gongfaAttriCap } from "./types/itemTier";
import {
  TABLE,
  REALM_ORDER,
  SUB_STAGES,
  CULTIVATION_VALUES,
  SHOUYUAN_VALUES,
  MIN_NARRATIVE_AGE_BY_MAJOR,
  MAX_NARRATIVE_AGE_BY_MAJOR,
  GONGFA_MASTERY_THRESHOLDS,
  GONGFA_COMBAT_MULT_CAP,
  buildGongfaMasteryThresholds,
  realmStageIndex,
  type RealmPrimaryStatsRow,
  type RealmMajor,
  type GongfaSlotsState,
} from "./types/playInfo";

let _byKey: Record<string, RealmPrimaryStatsRow> | null = null;

function getByKey(): Record<string, RealmPrimaryStatsRow> {
  if (!_byKey) {
    _byKey = {};
    for (const row of TABLE) {
      _byKey[row.realm + "\u0001" + row.stage] = row;
    }
  }
  return _byKey;
}

function clonePrimaryStatsFromRow(row: RealmPrimaryStatsRow): Record<PrimaryStatKey, number> {
  return {
    physique: row.physique,
    spirit: row.spirit,
    strength: row.strength,
    perception: row.perception,
    guard: row.guard,
    resistance: row.resistance,
    agility: row.agility,
    insight: row.insight,
  };
}

export function getRealmPrimaryStats(realm: string, stage?: string | null): Record<PrimaryStatKey, number> | null {
  if (realm == null || realm === "" || stage == null || stage === "") return null;
  const row = getByKey()[realm + "\u0001" + stage];
  return row ? clonePrimaryStatsFromRow(row) : null;
}

export function getRow(realm: string, stage?: string | null): RealmPrimaryStatsRow | null {
  if (realm == null || realm === "" || stage == null || stage === "") return null;
  const r = getByKey()[realm + "\u0001" + stage];
  return r ? { ...r } : null;
}

export function hasRow(realm: string, stage?: string | null): boolean {
  return getRow(realm, stage) != null;
}

export function getTable(): readonly RealmPrimaryStatsRow[] {
  return TABLE;
}

export function getCultivationRequired(realm: string, stage?: string | null): number | null {
  if (realm == null || realm === "" || stage == null || stage === "") return null;
  const idx = realmStageIndex(realm, stage) - 1;
  if (idx < 0 || idx >= CULTIVATION_VALUES.length) return null;
  return CULTIVATION_VALUES[idx];
}

/**
 * 返回修为圆满后"下一阶"的具体描述，供 AI 输入串使用。
 * 小境界（初期/中期）圆满 → 需一次轻量触发事件即可突破至下一小境界；
 * 大境界（仅后期）圆满 → 需丹药/机缘并完成突破任务才能进入下一大境界。
 */
export function describeNextBreakthrough(major: string, minor: string): string {
  const minorIdx = (SUB_STAGES as readonly string[]).indexOf(minor);
  const majorIdx = (REALM_ORDER as readonly string[]).indexOf(major);
  if (minorIdx < 0 || majorIdx < 0) return "修为已圆满";
  if (minorIdx < SUB_STAGES.length - 1) {
    const nextMinor = SUB_STAGES[minorIdx + 1];
    return `修为已圆满，下一阶为${major}${nextMinor}（小境界，需一次轻量触发事件如顿悟/机缘/丹药辅助即可突破）`;
  }
  if (majorIdx < REALM_ORDER.length - 1) {
    const next = REALM_ORDER[majorIdx + 1];
    if (next === "练气") {
      return `修为已圆满，下一阶为${next}（大境界，需引气入体/机缘并完成突破任务）`;
    }
    return `修为已圆满，下一阶为${next}（大境界，需${next}丹/机缘并完成突破任务）`;
  }
  return `修为已圆满（已达${REALM_ORDER[REALM_ORDER.length - 1]}后期，无法再突破）`;
}

export function getShouyuanForRealm(realm: string, stage?: string | null): number | null {
  if (realm == null || realm === "" || stage == null || stage === "") return null;
  const idx = realmStageIndex(realm, stage) - 1;
  if (idx < 0 || idx >= SHOUYUAN_VALUES.length) return null;
  return SHOUYUAN_VALUES[idx];
}

export function getMinNarrativeAgeForMajor(major: string): number {
  let m = major != null ? String(major).trim() : "";
  if (m.endsWith("期")) m = m.slice(0, -1).trim();
  if (Object.prototype.hasOwnProperty.call(MIN_NARRATIVE_AGE_BY_MAJOR, m)) {
    return MIN_NARRATIVE_AGE_BY_MAJOR[m]!;
  }
  return MIN_NARRATIVE_AGE_BY_MAJOR.练气;
}

export function getMaxNarrativeAgeForMajor(major: string): number {
  let m = major != null ? String(major).trim() : "";
  if (m.endsWith("期")) m = m.slice(0, -1).trim();
  if (Object.prototype.hasOwnProperty.call(MAX_NARRATIVE_AGE_BY_MAJOR, m)) {
    return MAX_NARRATIVE_AGE_BY_MAJOR[m]!;
  }
  return MAX_NARRATIVE_AGE_BY_MAJOR.练气;
}

export interface CustomBirthSlice {
  background?: string;
  realmMajor?: string;
}

export interface FateChoiceSliceForAge {
  customBirth?: CustomBirthSlice;
  realm?: { major?: string };
}

export interface GameSliceForNarrativeAge {
  age?: number;
  realm?: { major?: string };
  fateChoice?: FateChoiceSliceForAge;
}

export function customBirthBackgroundImpliesAgeException(
  fc: FateChoiceSliceForAge | null | undefined,
): boolean {
  try {
    const cb = fc?.customBirth;
    if (!cb || typeof cb.background !== "string") return false;
    return /灌(?:\u9876|\u9802)|催熟|夺舍|透支/.test(cb.background);
  } catch {
    return false;
  }
}

export function resolveEffectiveMajorForNarrativeAge(
  fc: FateChoiceSliceForAge | null | undefined,
  G: GameSliceForNarrativeAge | null | undefined,
): string {
  const r = (G && G.realm) || (fc && fc.realm) || {};
  const majFromRealm = r.major != null ? String(r.major).trim() : "";
  const majFromCB =
    fc?.customBirth?.realmMajor != null ? String(fc.customBirth.realmMajor).trim() : "";

  function rank(mm: string): number {
    if (!mm) return -1;
    const idx = REALM_ORDER.indexOf(mm as RealmMajor);
    return idx >= 0 ? idx : -1;
  }
  const a = rank(majFromRealm);
  const b = rank(majFromCB);
  if (b > a && majFromCB) return majFromCB;
  if (majFromRealm) return majFromRealm;
  return majFromCB || "练气";
}

export function getProtagonistNarrativeAge(
  G: GameSliceForNarrativeAge | null | undefined,
  fc?: FateChoiceSliceForAge | null,
  options?: { defaultAge?: number },
): number {
  const g = G && typeof G === "object" ? G : {};
  const fc0 = fc != null ? fc : g.fateChoice;
  let defAge = 16;
  if (typeof options?.defaultAge === "number" && isFinite(options.defaultAge)) {
    defAge = Math.max(0, Math.floor(options.defaultAge));
  }
  const base =
    typeof g.age === "number" && isFinite(g.age) ? Math.max(0, Math.floor(g.age)) : defAge;
  if (customBirthBackgroundImpliesAgeException(fc0)) return base;
  const maj = resolveEffectiveMajorForNarrativeAge(fc0, g);
  const floor = getMinNarrativeAgeForMajor(maj);
  return Math.max(base, floor);
}

/** 取功法的层数上限（由阶层决定，见 `itemTier.gongfaMaxLayer`）。 */
export function gongfaMaxLayerOf(gongfa: GongfaItemDefinition | null | undefined): number {
  return gongfaMaxLayer(gongfa?.tier);
}

/**
 * 第 `masteryLevel` 层升到下一层所需的经验。
 *
 * 阈值表按该功法的**层数上限**生成（见 `buildGongfaMasteryThresholds`）；
 * 已达上限层返回 `Infinity`（不再累积经验）。
 */
export function getGongfaMasteryThreshold(masteryLevel: number, maxLayer = 10): number {
  const m = Math.max(1, Math.floor(maxLayer));
  if (masteryLevel < 1 || masteryLevel >= m) return Infinity;
  const table = buildGongfaMasteryThresholds(m);
  const v = table[masteryLevel - 1];
  return typeof v === "number" ? v : Infinity;
}

/**
 * 功法**主属性加成倍率**：按修炼进度比例在 [1, cap] 之间插值。
 *
 * `cap` 由功法阶层决定（凡人 2.5× ~ 化神 10×），满层即到顶。
 */
export function gongfaAttriMult(mastery: number, maxLayer: number, cap: number): number {
  const m = Math.max(1, Math.floor(maxLayer));
  if (m <= 1) return 1;
  const l = Math.max(1, Math.min(mastery, m));
  const t = (l - 1) / (m - 1);
  return 1 + t * (Math.max(1, cap) - 1);
}

/** 功法**战斗效果倍率**：按修炼进度比例在 [1, 2.35] 之间插值（曲线本就平缓，不随阶层放大）。 */
export function gongfaCombatMult(mastery: number, maxLayer: number): number {
  return gongfaAttriMult(mastery, maxLayer, GONGFA_COMBAT_MULT_CAP);
}

/** 直接按功法对象取主属性倍率（内部解析层数上限与阶层封顶）。 */
export function gongfaAttriMultOf(gongfa: GongfaItemDefinition | null | undefined): number {
  if (!gongfa) return 1;
  return gongfaAttriMult(gongfa.mastery ?? 1, gongfaMaxLayerOf(gongfa), gongfaAttriCap(gongfa.tier));
}

/** 直接按功法对象取战斗倍率。 */
export function gongfaCombatMultOf(gongfa: GongfaItemDefinition | null | undefined): number {
  if (!gongfa) return 1;
  return gongfaCombatMult(gongfa.mastery ?? 1, gongfaMaxLayerOf(gongfa));
}

/** 把层数夹到 [1, maxLayer]（老存档层数可能超过新上限）。 */
export function clampGongfaMastery(mastery: number, maxLayer: number): number {
  const m = Math.max(1, Math.floor(maxLayer));
  return Math.max(1, Math.min(Math.floor(mastery) || 1, m));
}

/**
 * 功法的**修炼总进度**（0~1），用于跨功法比较与继承。
 *
 * 层内经验按当前层阈值折算，满层为 1。
 */
export function gongfaProgressRatio(gongfa: GongfaItemDefinition | null | undefined): number {
  if (!gongfa) return 0;
  const m = gongfaMaxLayerOf(gongfa);
  if (m <= 1) return 1;
  const l = clampGongfaMastery(gongfa.mastery ?? 1, m);
  if (l >= m) return 1;
  const th = getGongfaMasteryThreshold(l, m);
  const frac = Number.isFinite(th) && th > 0 ? Math.min(1, (gongfa.masteryExp ?? 0) / th) : 0;
  return Math.min(1, ((l - 1) + frac) / (m - 1));
}

/**
 * 【机缘·续作继承】让后续篇功法沿用原功法的修炼进度。
 *
 * 场景：练气功法练到 5/5 层，机缘得到它的筑基篇——不必从第一层重练。
 * 因两门功法层数上限不同（练气 5 层 / 筑基 6 层），按**进度比例**映射而非直接抄层数：
 *
 * - 连续层位置 `pos = 进度 × (上限-1)`，起始层 = `floor(pos) + 1`；
 * - 层内经验按 `pos` 的小数部分等比写入，避免"刚好卡在新一层起点"的突变；
 * - **保留最后一层不继承**：续篇纵有旧根基，终归是新境界的新功夫，得留一层让玩家自己练满
 *   （源功法已圆满 → 续篇也只到「上限-1」层，不会一入手就满级）。
 *
 * @returns 继承后的层数与经验；源功法为空或进度为 0 时返回 null（表示无需继承）。
 */
export function inheritGongfaProgress(
  source: GongfaItemDefinition | null | undefined,
  target: GongfaItemDefinition,
): { mastery: number; masteryExp: number } | null {
  if (!source) return null;
  const ratio = gongfaProgressRatio(source);
  if (ratio <= 0) return null;
  const m = gongfaMaxLayerOf(target);
  if (m <= 1) return { mastery: 1, masteryExp: 0 };
  const pos = ratio * (m - 1);          // 连续层位置（0 ~ m-1）
  // 保留最后一层：续篇入手即满级会抹掉成长空间。
  const layer = Math.min(m - 1, Math.max(1, Math.floor(pos) + 1));
  const th = getGongfaMasteryThreshold(layer, m);
  const frac = pos - Math.floor(pos);   // 当前层内已完成的比例
  const exp = Number.isFinite(th) ? Math.round(th * frac) : 0;
  return { mastery: layer, masteryExp: Math.max(0, exp) };
}

export function addGongfaMasteryExp(
  gongfa: GongfaItemDefinition,
  expIncrease: number,
  maxLayer?: number,
): { leveledUp: boolean; newMastery: number } {
  const max = clampGongfaMastery(Number.MAX_SAFE_INTEGER, maxLayer ?? gongfaMaxLayerOf(gongfa));
  // 老存档层数可能超过新上限，先夹取再累加。
  let mastery = clampGongfaMastery(gongfa.mastery ?? 1, max);
  if (expIncrease <= 0) {
    gongfa.mastery = mastery;
    return { leveledUp: false, newMastery: mastery };
  }

  let exp = gongfa.masteryExp ?? 0;

  if (mastery >= max) {
    gongfa.mastery = max;
    gongfa.masteryExp = 0;
    return { leveledUp: false, newMastery: max };
  }

  exp += expIncrease;
  let leveledUp = false;

  while (mastery < max) {
    const threshold = getGongfaMasteryThreshold(mastery, max);
    if (!Number.isFinite(threshold) || exp < threshold) break;
    exp -= threshold;
    mastery++;
    leveledUp = true;
  }

  if (mastery >= max) {
    mastery = max;
    exp = 0;
  }

  gongfa.mastery = mastery;
  gongfa.masteryExp = exp;

  return { leveledUp, newMastery: mastery };
}

/**
 * 给定一门功法的熟练度预算，按 `GONGFA_MASTERY_THRESHOLDS` 阈值表反推它应处的
 * mastery 层数（1-10）与剩余 masteryExp。
 *
 * 用于 NPC 新建/重评估时，按境界修为总量均分给各功法，推算合理的功法层数，
 * 使 NPC 功法强度与其境界匹配（而非一律 1 层）。
 */
export function computeGongfaMasteryFromBudget(
  budget: number,
  maxLayer = 10,
): { mastery: number; masteryExp: number } {
  if (!Number.isFinite(budget) || budget <= 0) return { mastery: 1, masteryExp: 0 };
  const max = Math.max(1, Math.floor(maxLayer));
  let mastery = 1;
  let exp = Math.floor(budget);
  while (mastery < max) {
    const threshold = getGongfaMasteryThreshold(mastery, max);
    if (!Number.isFinite(threshold) || exp < threshold) break;
    exp -= threshold;
    mastery++;
  }
  if (mastery >= max) {
    mastery = max;
    exp = 0;
  }
  return { mastery, masteryExp: Math.max(0, exp) };
}

/**
 * 按 NPC 当前境界的修为总量，均分给所有非空功法，设置每门功法的 mastery 与
 * masteryExp，使 NPC 功法层数与其境界匹配。
 *
 * - 修为总量取自 `getCultivationRequired(realmMajor, realmMinor)`（该境界阶段的累计修为阈值）。
 * - 均分给 gongfaSlots 中所有非空功法（功法越多每门层数越低——精力分散）。
 * - 境界无效或无功法时直接返回，不做改动。
 */
export function applyNpcGongfaMasteryByRealm(
  gongfaSlots: GongfaSlotsState,
  realmMajor: string,
  realmMinor: string,
): void {
  const totalBudget = getCultivationRequired(realmMajor, realmMinor);
  if (totalBudget == null || totalBudget <= 0) return;
  const gongfas = gongfaSlots.filter((g): g is GongfaItemDefinition => g !== null);
  if (gongfas.length === 0) return;
  const perGongfa = totalBudget / gongfas.length;
  for (const gf of gongfas) {
    const { mastery, masteryExp } = computeGongfaMasteryFromBudget(perGongfa, gongfaMaxLayerOf(gf));
    gf.mastery = mastery;
    gf.masteryExp = masteryExp;
  }
}
