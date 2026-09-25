/**
 * 境界相关功能函数：主属性查询、修为需求、寿元、叙事年龄等。
 * 类型和常量数据表定义在 `types/playInfo.ts`。
 */

import type { PrimaryStatKey } from "./types/playInfo";
import type { GongfaItemDefinition } from "./types/itemInfo";
import { gongfaMaxLayer, GONGFA_MAX_LAYER_BY_TIER } from "./types/itemTier";
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
 * 是否拥有灵根。
 *
 * 无灵根者感应不到天地灵气，无法引气入体 —— 修为可以积攒，但境界被硬锁在凡人后期，
 * 永远进不了练气。见 `isMortalToQiRefiningStep`。
 *
 * @param linggen 灵根元素数组（可为空 / 缺省）。
 */
export function hasLinggen(linggen?: readonly string[] | null): boolean {
  return Array.isArray(linggen) && linggen.length > 0;
}

/**
 * 判断当前境界是否为「凡人后期」——即下一步就要跨出凡人、踏入练气。
 *
 * 这一步是硬锁点：无灵根者到此为止，修为可以满，境界不许动。
 *
 * @param major 当前大境界。
 * @param minor 当前小境界。
 */
export function isMortalToQiRefiningStep(major: string, minor: string): boolean {
  return major === "凡人" && minor === SUB_STAGES[SUB_STAGES.length - 1];
}

/**
 * 无灵根 + 凡人后期 = 硬锁：修为可以积满，境界永远停在凡人后期，进不了练气。
 *
 * 这是「无灵根不得突破出凡人」这条规则的唯一判定入口，主角与 NPC 共用。
 */
export function isMortalPeakLocked(major: string, minor: string, linggen?: readonly string[] | null): boolean {
  return isMortalToQiRefiningStep(major, minor) && !hasLinggen(linggen);
}

/**
 * 返回修为圆满后"下一阶"的具体描述，供 AI 输入串使用。
 * 小境界（初期/中期）圆满 → 需一次轻量触发事件即可突破至下一小境界；
 * 大境界（仅后期）圆满 → 需丹药/机缘并完成突破任务才能进入下一大境界。
 *
 * @param linggen 灵根元素数组；无灵根时，凡人后期会返回"止步凡人"的死锁说明。
 */
export function describeNextBreakthrough(major: string, minor: string, linggen?: readonly string[] | null): string {
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
      if (!hasLinggen(linggen)) {
        return "修为已满、但此人无灵根，感应不到天地灵气，无法引气入体，终其一生止步凡人后期（绝不可输出 realmBreakthrough）";
      }
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

/* 【2026-09-25 v4 删除】
 * 原 `gongfaAttriMult` / `gongfaCombatMult` / `gongfaAttriMultOf` / `gongfaCombatMultOf`
 * （按整数层在 [1, cap] 之间插值）已整体移除。
 *
 * v4 起：
 *   - 主属性加成由**连续层号**直接查 `realmScale.gongfaLayerValue`（同层同值），
 *     不再需要「倍率 × 词条」这套间接表达；
 *   - 战斗倍率同样按连续层号算：`1 + (contLayer-1)/18 × (GONGFA_COMBAT_MULT_CAP-1)`，
 *     见 {@link gongfaCombatMultAt}。
 * 保留整数层插值会让「层内经验不立刻反映到面板」的旧问题一直存在。
 */

/**
 * 功法的**连续层号**（1 ~ 上限，带小数）。
 *
 * 【2026-09-25 v4】所有按层号取值的量（属性加成、战斗倍率、目录取样位置、
 * 蓝耗百分比）一律用它，效果是**每一颗灵石都立刻反映在面板上**，
 * 层数退化成纯里程碑（UI 仍显示「第 N 层 + 经验条」）。
 *
 * @param gongfa 功法；为空返回 1。
 * @returns 连续层号；满层时恰为上限。
 */
export function gongfaContLayer(gongfa: GongfaItemDefinition | null | undefined): number {
  if (!gongfa) return 1;
  const cap = gongfaMaxLayerOf(gongfa);
  if (cap <= 1) return 1;
  const ratio = gongfaProgressRatio(gongfa);
  return 1 + Math.max(0, Math.min(1, ratio)) * (cap - 1);
}

/**
 * 战斗倍率（按**连续层号**）：`1 + (L-1)/18 × (cap-1)`。
 *
 * 18 = 化神上限 19 - 1，即整条层号轴的跨度。故化神满层 L19 = 2.35（与旧满层一致），
 * 练气满层 L7 = 1.45 —— **低阶技能在高境界天然弱一截，深度差即压制替代品**，
 * 不再需要跨阶威力系数。
 */
export function gongfaCombatMultAt(contLayer: number): number {
  const L = Math.max(1, Math.min(GONGFA_MAX_LAYER_BY_TIER.化神, contLayer));
  return 1 + ((L - 1) / (GONGFA_MAX_LAYER_BY_TIER.化神 - 1)) * (GONGFA_COMBAT_MULT_CAP - 1);
}

/**
 * 目录取样位置：连续层号 → 10 层基准曲线的位置（1~10）。
 *
 * 化神满层 L19 → 10（目录区间右端点）、练气满层 L7 → 4。
 * `atLayer` / `atLayerFloat` 本就支持小数层号，无需额外实现。
 */
export function gongfaLayer10At(contLayer: number): number {
  const cap = GONGFA_MAX_LAYER_BY_TIER.化神;
  const L = Math.max(1, Math.min(cap, contLayer));
  return 1 + ((L - 1) / (cap - 1)) * 9;
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
 * 场景：练气功法练到 7/7 层，机缘得到它的筑基篇——不必从第一层重练。
 *
 * 【2026-09-25 v4】由「进度比例映射」改为**复制 + 夹取**：
 *
 * - 全阶层统一经验曲线（见 `gameConstants.GONGFA_MASTERY_CURVE`）下，
 *   **第 N 层永远收同样的经验**，投入与曲线位置一一对应，故源功法的
 *   层数与层内经验可以直接抄过去，零损耗零虚增；
 * - 旧的比例映射把「练气 5/5」按百分比搬到「筑基 10 层」上，落点会被凸曲线的
 *   形状放大——同样的投入凭空换到更深的层，等于送经验；
 * - **保留最后一层不继承**：续篇纵有旧根基，终归是新境界的新功夫，
 *   得留一层让玩家自己练满（源满层 → 续篇到「上限-1」层，不会一入手就满级）。
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
  const srcLayer = clampGongfaMastery(source.mastery ?? 1, gongfaMaxLayerOf(source));
  const srcExp = Math.max(0, Math.floor(source.masteryExp ?? 0));
  // 保留最后一层：续篇入手即满级会抹掉成长空间。
  const layer = Math.min(m - 1, Math.max(1, srcLayer));
  const th = getGongfaMasteryThreshold(layer, m);
  // 层内经验同样夹到本层阈值之内（源功法未超阈值时原样复制，不做任何换算）。
  const exp = Number.isFinite(th) ? Math.min(srcExp, Math.max(0, th - 1)) : srcExp;
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
