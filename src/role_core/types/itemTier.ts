/**
 * @fileoverview 物品「阶层」系统（ItemTier）。
 *
 * 阶层与品阶（ItemGrade）正交：
 *   - 品阶（下品 → 神品）决定词条的**数量**与基础档位；
 *   - 阶层（凡人 → 化神）决定词条的**数值量级**与跨境界使用时的**威能残留**。
 *
 * 设计目标：防止「练气期捡到一件强力法宝，一路用到元婴期仍不过时」。
 * 实现方式是双层闭环：
 *   ① 生成时：数值 = 基础值 × TIER_MULT[tier]（高阶层物品的初始数值本来就更高）
 *   ② 使用时：效果 × tierFactor(tier, 使用者境界)（跨境界自动衰减，逼迫换装）
 *
 * 当前法宝与功法已接入；丹药有独立系数（见 `elixirTierFactor`），材料待扩展。
 *
 * 功法额外有一条**修为门槛**：使用者境界高于功法阶层时，修炼该功法不再产出修为，
 * 见 {@link isGongfaObsolete}。
 */

import { REALM_ORDER, type RealmMajor } from "./playInfo";

// ═══════════════════════════════════════════════════════════════════════════
// 类型与顺序
// ═══════════════════════════════════════════════════════════════════════════

/** 物品阶层，直接复用修炼体系的大境界名。 */
export type ItemTier = RealmMajor;

/** 阶层由低到高，索引即 `tierIndex()`。 */
export const TIER_ORDER: readonly ItemTier[] = REALM_ORDER as readonly ItemTier[];

// ═══════════════════════════════════════════════════════════════════════════
// ① 生成时 — 阶层数值倍率
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 阶层的数值倍率。跨度（12×）刻意大于品阶跨度（约 5×），
 * 否则「元婴阶·下品」永远打不过「练气阶·神品」，玩家不会有换装动机。
 *
 * 想临时关闭阶层定档，把全部值改成 1 即可（压制仍生效）。
 */
export const TIER_MULT: Readonly<Record<ItemTier, number>> = {
  凡人: 0.25,
  练气: 0.5,
  筑基: 0.8,
  结丹: 1.3,
  元婴: 2.0,
  化神: 3.0,
};

// ═══════════════════════════════════════════════════════════════════════════
// ② 使用时 — 跨阶压制
// ═══════════════════════════════════════════════════════════════════════════

/** 物品阶层**低于**使用者境界时，每差一个大境界保留的威能比例。 */
export const TIER_SUPP_LOW = 0.65;

/**
 * 物品阶层**高于**使用者境界时（器灵未解封），每差一个大境界保留的威能比例。
 * 比 TIER_SUPP_LOW 更狠：越级捡到重宝也应只是「埋下伏笔」，而非立刻起飞。
 */
export const TIER_SUPP_HIGH = 0.35;

/** 威能残留的下限，避免高阶差过大时变成完全无用（保留一丝叙事价值）。 */
export const TIER_SUPP_FLOOR = 0.05;

/**
 * 【凡人阶专项·重要】凡俗兵刃与武功**不入修行**，一旦使用者引气入体便迅速废掉。
 *
 * 普通阶层走 `TIER_SUPP_LOW ^ Δ`（练气用凡人阶 = 65%），对凡人物件太宽容了——
 * 一把铁刀练气期还能发挥三分威能，会让「换装」动机彻底消失。故凡人阶单列：
 *
 * - 使用者高 1 阶（练气）→ 仅剩 10%
 * - 使用者高 2 阶及以上（筑基 / 结丹 / 元婴 / 化神）→ **完全失效（0）**
 *
 * 注意：这里刻意绕过 {@link TIER_SUPP_FLOOR}，否则永远归不了零。
 */
export const MORTAL_TIER_SUPP: Readonly<Record<number, number>> = {
  1: 0.1,
};

/** 凡人阶物品在「高 2 阶及以上」时彻底失效。 */
export const MORTAL_TIER_DEAD_AT = 2;

/**
 * 凡人阶物品的跨阶压制系数（0 ~ 1）。
 *
 * @param delta 使用者境界序号 − 物品阶层序号（正数表示使用者境界更高）。
 */
export function mortalTierFactor(delta: number): number {
  if (delta <= 0) return 1;
  if (delta >= MORTAL_TIER_DEAD_AT) return 0;
  return MORTAL_TIER_SUPP[delta] ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// ②-b 使用时 — 丹药专项压制
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 丹药：**低于**使用者境界时，每差一个大境界保留的药效比例。
 *
 * 丹药是消耗品而非战力资产，压制力度刻意比法宝（0.65）狠得多——
 * 否则「练气期囤一袋丹，元婴期一次嗑完」会直接架空后期的资源循环。
 */
export const ELIXIR_TIER_SUPP_LOW = 0.2;

/**
 * 丹药：**高于**使用者境界时，每差一个大境界保留的药效比例（虚不受补）。
 * 与法宝的器灵封印同源，防止低阶修士捡到高阶丹药立刻起飞。
 */
export const ELIXIR_TIER_SUPP_HIGH = 0.35;

/** 丹药药效残留下限比例。 */
export const ELIXIR_TIER_SUPP_FLOOR = 0.05;

/** 丹药生成时是否按阶层缩放**定值型**数值；置 false 则只做服用时压制。 */
export const ELIXIR_TIER_SCALE = true;

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

export function isItemTier(v: unknown): v is ItemTier {
  return typeof v === "string" && (TIER_ORDER as readonly string[]).includes(v);
}

/** 阶层 → 序号（凡人 = 0）。非法值回退为 0。 */
export function tierIndex(tier: string | null | undefined): number {
  if (!tier) return 0;
  const i = (TIER_ORDER as readonly string[]).indexOf(tier);
  return i < 0 ? 0 : i;
}

/**
 * 掉落 / 生成时确定物品阶层：默认等于当前大境界。
 *
 * 保留 8% 概率越一阶（掉出比当前境界高一阶的宝物），制造惊喜与「埋伏笔」；
 * 但越阶物品会被 `tierFactor` 的器灵封印压住，不会立刻破坏平衡。
 *
 * @param realmMajor 获取者当前大境界。
 */
export function rollItemTier(realmMajor: string | null | undefined): ItemTier {
  const base = tierIndex(realmMajor);
  const bonus = Math.random() < 0.08 ? 1 : 0;
  const idx = Math.min(base + bonus, TIER_ORDER.length - 1);
  return TIER_ORDER[idx];
}

/**
 * 跨阶压制系数（0 ~ 1）。
 *
 * - 同阶：1（完全发挥）
 * - 物品低于使用者：0.65 ^ Δ（练气法宝被元婴修士使用 → 0.65³ ≈ 27%）
 * - 物品高于使用者：0.35 ^ Δ（器灵封印）
 * - **凡人阶物品**走 {@link mortalTierFactor}：高 1 阶仅剩 10%，高 2 阶起完全失效。
 *
 * @param itemTier 物品阶层。
 * @param userRealmMajor 使用者当前大境界。
 */
export function tierFactor(
  itemTier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): number {
  if (!itemTier || !userRealmMajor) return 1;
  const itemIdx = (TIER_ORDER as readonly string[]).indexOf(itemTier);
  const userIdx = (TIER_ORDER as readonly string[]).indexOf(userRealmMajor);
  if (itemIdx < 0 || userIdx < 0) return 1;
  const delta = userIdx - itemIdx;
  if (delta === 0) return 1;
  // 凡俗之物不入修行：单列一套更陡的衰减曲线，且允许归零。
  if (itemTier === "凡人" && delta > 0) return mortalTierFactor(delta);
  const base = delta > 0 ? TIER_SUPP_LOW : TIER_SUPP_HIGH;
  return Math.max(TIER_SUPP_FLOOR, Math.pow(base, Math.abs(delta)));
}

/**
 * 生成时按阶层缩放数值（至少为 1，避免出现 0 词条）。
 *
 * @param value 基础数值。
 * @param tier 阶层；为空表示不缩放（兼容旧存档 / 未接入阶层的调用方）。
 * @param cap 缩放后的上限（概率型 / 穿透型词条必须设置，否则高阶层会溢出，
 *            例如神品暴击 [15,25] × 化神 3.0 = 75%，必爆会毁掉战斗节奏）。
 */
export function scaleByTier(value: number, tier?: ItemTier | null, cap?: number): number {
  if (!tier) return Math.round(value);
  const mult = TIER_MULT[tier];
  const scaled = mult == null ? Math.round(value) : Math.round(value * mult);
  const withCap = cap != null ? Math.min(scaled, cap) : scaled;
  return Math.max(1, withCap);
}

/**
 * 丹药专用的跨阶压制系数（0 ~ 1）。规则同 {@link tierFactor}，但使用丹药系数。
 *
 * @param itemTier 丹药阶层。
 * @param userRealmMajor 服用者当前大境界。
 */
export function elixirTierFactor(
  itemTier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): number {
  if (!itemTier || !userRealmMajor) return 1;
  const itemIdx = (TIER_ORDER as readonly string[]).indexOf(itemTier);
  const userIdx = (TIER_ORDER as readonly string[]).indexOf(userRealmMajor);
  if (itemIdx < 0 || userIdx < 0) return 1;
  const delta = userIdx - itemIdx;
  if (delta === 0) return 1;
  const base = delta > 0 ? ELIXIR_TIER_SUPP_LOW : ELIXIR_TIER_SUPP_HIGH;
  return Math.max(ELIXIR_TIER_SUPP_FLOOR, Math.pow(base, Math.abs(delta)));
}

/**
 * 生成时按阶层缩放丹药数值。
 *
 * **百分比型（恢复 / 修为）不缩放**：它本身就是比例，天然随境界水涨船高，
 * 再乘阶层只会被 100% 削平（结丹阶以上的神品回血丹全变成 100%，反而失去阶层区分度）。
 * 阶层对它的意义只体现在服用时的压制上。
 *
 * **定值型（属性 / 寿元 / 低阶恢复）缩放**：否则元婴期吃「+30 劲力」和练气期毫无区别，
 * 后期丹药会退化成废丹。
 *
 * @param value 品阶表查得的基础数值。
 * @param tier 阶层；为空或关闭 {@link ELIXIR_TIER_SCALE} 时不缩放。
 * @param isPercent 是否为百分比型效果。
 */
export function scaleElixirByTier(
  value: number,
  tier?: ItemTier | null,
  isPercent = false,
): number {
  if (isPercent) return Math.round(value);
  if (!ELIXIR_TIER_SCALE || !tier) return Math.round(value);
  const mult = TIER_MULT[tier];
  const scaled = mult == null ? Math.round(value) : Math.round(value * mult);
  return Math.max(1, scaled);
}

/**
 * 按阶层压制后的**实际生效**丹药数值（服用时调用）。
 *
 * @param value 丹药标称数值。
 * @param tier 丹药阶层。
 * @param userRealmMajor 服用者当前大境界。
 */
export function applyElixirTierSuppression(
  value: number,
  tier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): number {
  const f = elixirTierFactor(tier, userRealmMajor);
  if (f >= 1) return value;
  return Math.max(1, Math.round(value * f));
}

/**
 * 生成丹药的阶层 UI 提示文案（含跨阶压制说明）。
 *
 * @returns 同阶时返回 `「筑基阶 · 药力全开」`；低阶丹药返回衰减百分比，高阶丹药返回虚不受补提示。
 */
export function describeElixirTierSuppression(
  itemTier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): string {
  if (!isItemTier(itemTier)) return "";
  const f = elixirTierFactor(itemTier, userRealmMajor);
  const pct = Math.round(f * 100);
  if (f >= 1) return `${tierLabel(itemTier)} · 药力全开`;
  const itemIdx = tierIndex(itemTier);
  const userIdx = tierIndex(userRealmMajor);
  if (userIdx > itemIdx) {
    return `${tierLabel(itemTier)} · 药力 ${pct}%（药力寡淡，境界高出 ${userIdx - itemIdx} 阶）`;
  }
  return `${tierLabel(itemTier)} · 药力 ${pct}%（虚不受补，需${itemTier}之境）`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 旧存档兼容
// ═══════════════════════════════════════════════════════════════════════════

const GRADE_TO_TIER: Readonly<Record<string, ItemTier>> = {
  "下品": "练气",
  "中品": "练气",
  "上品": "筑基",
  "极品": "结丹",
  "仙品": "元婴",
  "神品": "化神",
};

/** 品阶 → 阶层的回退映射（旧存档无 tier 字段时使用）。 */
export function inferTierFromGrade(grade: string | null | undefined): ItemTier {
  return GRADE_TO_TIER[grade ?? ""] ?? "练气";
}

/**
 * 解析物品的实际阶层：优先用显式 `tier`，缺失时按品阶回退。
 * 旧存档物品因此不会被判为「无阶层」而免疫压制。
 */
export function resolveItemTier(
  tier: string | null | undefined,
  grade?: string | null,
): ItemTier {
  if (isItemTier(tier)) return tier;
  return inferTierFromGrade(grade);
}

// ═══════════════════════════════════════════════════════════════════════════
// 展示
// ═══════════════════════════════════════════════════════════════════════════

/** 阶层展示名，如 `练气阶`。 */
export function tierLabel(tier: string | null | undefined): string {
  return isItemTier(tier) ? `${tier}阶` : "";
}

/**
 * 生成阶层的 UI 提示文案（含跨阶压制说明）。
 *
 * @returns 同阶时返回 `「练气阶 · 威能全开」`；否则返回压制百分比与原因。
 */
export function describeTierSuppression(
  itemTier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): string {
  if (!isItemTier(itemTier)) return "";
  const f = tierFactor(itemTier, userRealmMajor);
  const pct = Math.round(f * 100);
  if (f >= 1) return `${tierLabel(itemTier)} · 威能全开`;
  if (f <= 0) return `${tierLabel(itemTier)} · 完全失效（凡俗之物不入修行）`;
  const itemIdx = tierIndex(itemTier);
  const userIdx = tierIndex(userRealmMajor);
  if (userIdx > itemIdx) {
    return `${tierLabel(itemTier)} · 威能 ${pct}%（器灵不契，境界高出 ${userIdx - itemIdx} 阶）`;
  }
  return `${tierLabel(itemTier)} · 威能 ${pct}%（器灵封印，需${itemTier}之境）`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 功法专项 — 阶层与修为门槛
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 解析功法的实际阶层。
 *
 * 与 {@link resolveItemTier} 不同：功法**不按品阶回退**。
 * 原因是阶层系统是后加的，老存档里的功法全都没有 `tier` 字段，若按品阶
 * 回退（下品→练气），一个元婴期老角色的入门功法会立刻被压到两三成，
 * 属于无预警的削号。故缺 tier 一律视为「不受压制」（返回 undefined）。
 * 玩家可在「天道编辑」里给功法显式指定阶层，指定后即参与压制。
 */
export function resolveGongfaTier(
  tier: string | null | undefined,
): ItemTier | undefined {
  return isItemTier(tier) ? tier : undefined;
}

/** 功法的跨阶压制系数；未指定阶层时恒为 1。 */
export function gongfaTierFactor(
  tier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): number {
  const t = resolveGongfaTier(tier);
  if (!t) return 1;
  return tierFactor(t, userRealmMajor);
}

/**
 * 该功法对当前境界而言是否已「不入流」——即使用者境界**高于**功法阶层。
 *
 * 判定为真的功法：修炼它不再产出任何修为（但熟练度与属性加成仍按
 * {@link gongfaTierFactor} 正常计算）。这是「换功法」的核心动机。
 *
 * 注：NPC 不走这条规则——NPC 没有独立的修炼结算，见 `Protagonist.applyStateChanges`。
 *
 * @param tier 功法阶层；为空表示未指定阶层，永不过时。
 * @param userRealmMajor 使用者当前大境界。
 */
export function isGongfaObsolete(
  tier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): boolean {
  const t = resolveGongfaTier(tier);
  if (!t) return false;
  if (!userRealmMajor) return false;
  const itemIdx = tierIndex(t);
  const userIdx = tierIndex(userRealmMajor);
  if (itemIdx < 0 || userIdx < 0) return false;
  return userIdx > itemIdx;
}

/** 功法修为门槛的 UI 文案；未过时时返回空串。 */
export function describeGongfaCultivation(
  tier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): string {
  if (!isGongfaObsolete(tier, userRealmMajor)) return "";
  const t = resolveGongfaTier(tier) as ItemTier;
  return `${tierLabel(t)} · 已不入流，修炼不再增进修为（需${userRealmMajor}阶功法）`;
}
