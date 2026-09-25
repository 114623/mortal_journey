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
 *   ② 使用时：跨境界威能衰减（法宝走 {@link treasureTierFactor}、功法走
 *      {@link gongfaTierFactor}）
 *
 * 丹药有独立系数（见 `elixirTierFactor`），材料待扩展。
 *
 * 【2026-09-25 v4 变更 · 功法数值改由「层号」锚定】
 * 核心模型：**同层同值，阶层只决定能修到第几层**。
 * 任何功法在第 L 层的主属性加成完全相同，与它是什么阶层、谁在用都无关
 * （见 `realmScale.gongfaLayerValue`）。于是——
 *   - **自然淘汰**：练气功法满层 L7 = +37.5 是固定绝对值，带到筑基（基准 250）
 *     相对缩水到 15%，带到化神约 1%，不需要任何压制系数；
 *   - **越阶无 spike**：筑基功法 L1 = 练气功法 L1 = +18.75，高阶功法的优势纯粹是
 *     「以后能修到更深的层」，而深度由统一经验曲线 + 境界修为预算兜住。
 * 故 {@link gongfaTierFactor} 现在只对**凡人 tier** 生效（凡俗之物不入修行：
 * 练气期剩 40%、筑基起归零），练气及以上一律返回 1。
 * 法宝（{@link treasureTierFactor}）与丹药**完全不受本次变更影响**，仍是
 * 低阶 0.65^Δ / 高阶 0.70^Δ。
 *
 * 【2026-09-21 变更】原「境界高于功法阶层 → 该功法已不入流、修炼不再产修为」的门槛
 * 已整体移除（isGongfaObsolete / describeGongfaCultivation 一并删除）。
 */

/* 只取类型，不取运行时值。
 *
 * 曾经这里写的是 `import { REALM_ORDER, type RealmMajor } from "./playInfo"`，
 * 于是形成了一条环：playInfo（再导出 realmUtils）→ realmUtils → itemTier → playInfo。
 * 环本身早就存在，但 realmUtils 原先只 *值引用* 无关模块时不致命；
 * 直到 realmUtils 开始引入 gongfaMaxLayer 后，加载顺序变成
 * playInfo 初始化中途去初始化 itemTier，而 itemTier 在顶层立刻读 REALM_ORDER，
 * 撞上暂时性死区（Cannot access 'REALM_ORDER' before initialization），整个 App 白屏。
 *
 * 正确方向是：itemTier 是被 Character / Npc / Protagonist / gameSave 等广泛引用的
 * 叶子模块，绝不能反向依赖 playInfo 这个枢纽。故此处改为本地常量 + 纯类型引用。 */
import type { RealmMajor } from "./playInfo";

// ═══════════════════════════════════════════════════════════════════════════
// 类型与顺序
// ═══════════════════════════════════════════════════════════════════════════

/** 物品阶层，直接复用修炼体系的大境界名。 */
export type ItemTier = RealmMajor;

/** 阶层由低到高，索引即 `tierIndex()`。必须与 playInfo 的 REALM_ORDER 完全一致。 */
export const TIER_ORDER = ["凡人", "练气", "筑基", "结丹", "元婴", "化神"] as const;

/* 编译期卫兵：一旦 REALM_ORDER 增删而此处没跟上，这一行会直接类型报错，
   避免两份境界列表悄悄走偏。（RealmMajor 是纯类型引用，不产生运行时依赖。） */
type _TierCoversAllRealms =
  Exclude<RealmMajor, (typeof TIER_ORDER)[number]> extends never ? true : never;
export const _tierCoversAllRealms: _TierCoversAllRealms = true;

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
 *
 * 【2026-09-24 调整】0.35 → **0.70**（玩家指定：「让高阶神装稍强于同阶」）。
 *
 * 判据：TIER_MULT 相邻档比值是 1.5~2.0，而原值 0.35 远小于 1/1.625，
 * 于是「筑基期拿到结丹神装」的实际数值只有同阶神装的 **56%**——越阶捡宝
 * 反而变弱，与直觉严重相悖（见 `treasureTierFactor` 的推导）。
 * 提到 0.70 后，越一阶 ≈ 同阶的 **105%~140%**，即「稍强于同阶」。
 *
 * ⚠️ 副作用（已知，暂未处理）：本系数对 Δ≥2 同样生效，而 TIER_MULT 的增长
 * 快于 0.7^Δ 的衰减，导致**越阶越多反而越强**（越两阶 113%~157%、
 * 越三阶 113%~178%、越五阶可达 202%）。若后续要堵「捡到化神神装直接毕业」，
 * 需给 Δ≥2 单独设一条更陡的衰减，而不是继续动这个数。
 */
export const TIER_SUPP_HIGH = 0.70;

/** 威能残留的下限，避免高阶差过大时变成完全无用（保留一丝叙事价值）。 */
export const TIER_SUPP_FLOOR = 0.05;

/**
 * 【凡人阶专项·重要】凡俗兵刃与武功**不入修行**，一旦使用者引气入体便迅速废掉。
 *
 * 普通阶层走 `TIER_SUPP_LOW ^ Δ`（练气用凡人阶 = 65%），对凡人物件太宽容了——
 * 一把铁刀练气期还能发挥三分威能，会让「换装」动机彻底消失。故凡人阶单列：
 *
 * - 使用者高 1 阶（练气）→ 40%
 * - 使用者高 2 阶及以上（筑基 / 结丹 / 元婴 / 化神）→ **完全失效（0）**
 *
 * 【2026-09-23 调整】高 1 阶由 10% 上调至 **40%**（用户指定）。
 * 原值过于严苛：主角刚引气入体时手里基本只有凡人物件，一刀砍到一成等于逼人在
 * 最缺装备的第一境界裸奔；留四成既保住「该换了」的压力，也不至于寸步难行。
 * 筑基起归零的规则不变——凡俗之物终究不入修行。
 *
 * 注意：这里刻意绕过 {@link TIER_SUPP_FLOOR}，否则永远归不了零。
 */
export const MORTAL_TIER_SUPP: Readonly<Record<number, number>> = {
  1: 0.4,
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
 * 保留 8% 概率越一阶（掉出比当前境界高一阶的宝物），制造惊喜与「埋伏笔」。
 *
 * 注：2026-09-24 起器灵封印放宽到 0.70，越一阶的实际数值已**略高于**同阶
 * （105%~140%），掉落惊喜感更强；代价是掉落的「伏笔」不再温和，
 * 若要收紧请调 {@link TIER_SUPP_HIGH}，不要动这里的 8%。
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
 * - 物品高于使用者：0.70 ^ Δ（器灵封印；2026-09-24 由 0.35 上调，见 {@link TIER_SUPP_HIGH}）
 * - **凡人阶物品**走 {@link mortalTierFactor}：高 1 阶（练气）剩 40%，高 2 阶起完全失效。
 *
 * 法宝与功法共用本曲线（法宝经 {@link treasureTierFactor}，曲线相同）。
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
 * 法宝专用的跨阶压制系数（0 ~ 1）。
 *
 * 2026-09-19 复原：取消「低阶法宝不削弱」的特殊规则，曲线与 {@link tierFactor}
 * 完全一致的双向压制——
 * - 物品低于使用者：0.65 ^ Δ（练气法宝被元婴修士使用 → 0.65³ ≈ 27%）
 * - 物品高于使用者：0.70 ^ Δ（器灵封印；2026-09-24 由 0.35 上调为「稍强于同阶」，
 *   代价是 Δ≥2 也会强于同阶，详见 {@link TIER_SUPP_HIGH}）
 * - 凡人阶物品：{@link mortalTierFactor}（练气期剩 40%，筑基起完全失效）
 */
export function treasureTierFactor(
  itemTier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): number {
  if (!itemTier || !userRealmMajor) return 1;
  const itemIdx = (TIER_ORDER as readonly string[]).indexOf(itemTier);
  const userIdx = (TIER_ORDER as readonly string[]).indexOf(userRealmMajor);
  if (itemIdx < 0 || userIdx < 0) return 1;
  const delta = userIdx - itemIdx;
  if (delta === 0) return 1;
  // 凡俗之物不入修行：保留更陡的凡人阶专属衰减，且允许归零。
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
// 功法专项 — 层数上限（按阶层）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 功法的**层数上限**（按阶层）。
 *
 * 【2026-09-25 v4 重排】练气 = 凡人 +4，之后**每阶层 +3**。
 * 层数只是**深度与里程碑**——数值全部由层号决定（见 `realmScale.gongfaLayerValue`），
 * 阶层唯一的作用是决定这功法能修到第几层。
 *
 * 配合全阶层统一的经验曲线（见 `gameConstants.buildGongfaMasteryThresholds`），
 * 每个境界的修为预算对应一个自然停驻点：练气预算 6,000 → 曲线 L6 累计 2,400、
 * L7 累计 6,400，故普通练气修士在任何功法上都停在 L6（上限 L7 的那层要突破后补）。
 *
 * 未指定阶层的功法（老存档）按 {@link DEFAULT_GONGFA_MAX_LAYER} 处理。
 */
export const GONGFA_MAX_LAYER_BY_TIER: Readonly<Record<ItemTier, number>> = {
  凡人: 3,
  练气: 7,
  筑基: 10,
  结丹: 13,
  元婴: 16,
  化神: 19,
};

/** 未指定阶层时的功法层数上限（= 旧版固定值，老存档兼容）。 */
export const DEFAULT_GONGFA_MAX_LAYER = 10;

/* 【2026-09-25 v4 删除】
 * 原 `GONGFA_ATTRI_CAP_BY_TIER` / `DEFAULT_GONGFA_ATTRI_CAP` / `gongfaAttriCap`
 * 已整体移除。它们承担的是「按阶层封顶满层倍率」（凡人 2.5× → 化神 10×）；
 * v4 起加成由**层号**唯一决定（`realmScale.gongfaLayerValue`），阶层不再参与数值，
 * 这套上限就没有意义了——留着只会让人误以为数值还跟阶层有关。
 */

/** 取功法的层数上限；阶层缺失或非法时回退 {@link DEFAULT_GONGFA_MAX_LAYER}。 */
export function gongfaMaxLayer(tier: string | null | undefined): number {
  if (!tier) return DEFAULT_GONGFA_MAX_LAYER;
  return GONGFA_MAX_LAYER_BY_TIER[tier as ItemTier] ?? DEFAULT_GONGFA_MAX_LAYER;
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
 * 生成法宝阶层的 UI 提示文案（含跨阶压制说明）。
 *
 * 规则与 {@link treasureTierFactor} 一致：双向压制（低阶 0.65^Δ / 高阶 0.70^Δ 器灵封印 /
 * 凡人阶专属衰减）。
 *
 * @returns 同阶时返回 `「练气阶 · 威能全开」`；否则返回压制百分比与原因。
 */
export function describeTierSuppression(
  itemTier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): string {
  if (!isItemTier(itemTier)) return "";
  const f = treasureTierFactor(itemTier, userRealmMajor);
  const pct = Math.round(f * 100);
  if (f >= 1) return `${tierLabel(itemTier)} · 威能全开`;
  if (f <= 0) return `${tierLabel(itemTier)} · 凡俗之物（完全失效）`;
  if (itemTier === "凡人") {
    return `${tierLabel(itemTier)} · 威能 ${pct}%（凡俗之物）`;
  }
  const userIdx = (TIER_ORDER as readonly string[]).indexOf(userRealmMajor ?? "");
  const itemIdx = (TIER_ORDER as readonly string[]).indexOf(itemTier);
  if (userIdx >= 0 && itemIdx >= 0 && itemIdx < userIdx) {
    return `${tierLabel(itemTier)} · 威能 ${pct}%（跨阶压制，法宝已跟不上当前境界）`;
  }
  return `${tierLabel(itemTier)} · 威能 ${pct}%（当前境界无法发挥法宝实力）`;
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
 *
 * 注：**运行时缺 tier 已属异常**。正常流程下功法一入袋/一装备就会被
 * {@link ensureGongfaTier} 就地补阶层；老存档则由 {@link backfillGongfaTiers}
 * 在读档时补齐。保留此处的宽松语义纯粹作为防御，避免漏网数据被误削。
 */
export function resolveGongfaTier(
  tier: string | null | undefined,
): ItemTier | undefined {
  return isItemTier(tier) ? tier : undefined;
}

/**
 * 老存档迁移：把超过**新层数上限**的修炼层数夹回上限。
 *
 * 层数上限改为按阶层决定（凡人3 ~ 化神10）后，一个练气阶功法若存着旧的
 * `mastery: 10` 就会越界（显示为「第10/5层」）。读档时夹一次即可：
 * 夹到满层时清空层内经验（与满层语义一致）。
 *
 * 只操作纯 JSON 存档数据，不依赖类实例，须在 `loadFromJson` / `restoreNpcs` 之前调用。
 *
 * @returns 被夹取的功法条数。
 */
export function clampGongfaMasteryInHolder(
  holder: {
    realm?: { major?: string | null } | null;
    gongfaSlots?: unknown;
    inventorySlots?: unknown;
  } | null | undefined,
): number {
  if (!holder || typeof holder !== "object") return 0;
  let count = 0;
  const visit = (rec: Record<string, unknown>): void => {
    if (rec.itemType !== "功法") return;
    const max = gongfaMaxLayer(rec.tier as string | null | undefined);
    const raw = typeof rec.mastery === "number" && Number.isFinite(rec.mastery) ? rec.mastery : 1;
    if (raw <= max) return;
    rec.mastery = max;
    rec.masteryExp = 0;
    count++;
  };
  if (Array.isArray(holder.gongfaSlots)) {
    for (const g of holder.gongfaSlots) {
      if (g && typeof g === "object") visit(g as Record<string, unknown>);
    }
  }
  if (Array.isArray(holder.inventorySlots)) {
    for (const it of holder.inventorySlots) {
      if (it && typeof it === "object") visit(it as Record<string, unknown>);
    }
  }
  return count;
}

/**
 * 功法缺 `tier` 时的兜底阶层：**与持有者同阶**（持有者境界非法时按练气）。
 *
 * 语义与老存档迁移 {@link backfillGongfaTiers} 完全一致：补完后压制系数为 1、
 * 也不算「不入流」，即**补写瞬间数值不变**；此后主角突破，该功法就按正常规则
 * 开始衰减乃至不入流——这正是兜底的目的，而不是让它永久免疫压制。
 */
export function fallbackGongfaTier(
  realmMajor: string | null | undefined,
): ItemTier {
  return isItemTier(realmMajor) ? (realmMajor as ItemTier) : "练气";
}

/**
 * 就地补齐一条功法记录的阶层（缺则写回，已有则不动）。
 *
 * 这是「AI / 命运抉择 / 天道编辑 漏填 tier」的**统一兜底点**：在功法进入
 * 角色的那一刻按持有者当前境界固化阶层，之后所有下游（跨阶压制、修为门槛、
 * 面板展示、战斗注入）都拿到确定的 tier，不会再有「无阶层 = 永久免疫压制」
 * 的漏子。
 *
 * 只认 `itemType === "功法"` 的记录，其余物品一律不动。
 *
 * @returns 是否发生了补写（便于调用方统计/记日志）。
 */
export function ensureGongfaTier(
  item: unknown,
  realmMajor: string | null | undefined,
): boolean {
  if (!item || typeof item !== "object") return false;
  const rec = item as Record<string, unknown>;
  if (rec.itemType !== "功法") return false;
  if (isItemTier(rec.tier)) return false;
  rec.tier = fallbackGongfaTier(realmMajor);
  return true;
}

/**
 * 批量版 {@link ensureGongfaTier}：就地补齐一整条功法栏（跳过空槽）。
 *
 * 用于「整体赋值 gongfaSlots」的路径——它们绕过了 `setGongfaSlot` 收口点。
 *
 * @returns 补写的条数。
 */
export function ensureGongfaTierList(
  slots: readonly unknown[] | null | undefined,
  realmMajor: string | null | undefined,
): number {
  if (!Array.isArray(slots)) return 0;
  let count = 0;
  for (const s of slots) {
    if (ensureGongfaTier(s, realmMajor)) count++;
  }
  return count;
}

/**
 * 功法的跨阶系数。
 *
 * 【2026-09-25 v4 语义变更】功法不再有「威力折损系数」：
 * 数值由**层号**唯一决定（同层同值，见 `realmScale.gongfaLayerValue`），
 * 阶层只决定能修到第几层。绝对值固定 + 境界基准上涨 = 自然淘汰，无需额外压制，
 * 故**仅凡人 tier 保留衰减**（凡俗之物不入修行：练气期剩 40%、筑基起归零），
 * 练气及以上一律返回 1。
 *
 * 高阶功法在低境界手里同样不削——它的 L1 与低阶功法的 L1 数值完全相同，
 * 优势只是「以后能修到更深的层」，深度由统一经验曲线 + 境界修为预算兜住。
 *
 * @param tier 功法阶层。
 * @param userRealmMajor 使用者当前大境界。
 * @returns 系数；未指定阶层或非凡人 tier 时恒为 1。
 */
export function gongfaTierFactor(
  tier: string | null | undefined,
  userRealmMajor: string | null | undefined,
): number {
  const t = resolveGongfaTier(tier);
  if (!t) return 1;
  if (t !== "凡人") return 1;
  return tierFactor(t, userRealmMajor);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 存档迁移 — 老存档功法补阶层
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 老存档迁移：给缺 `tier` 的功法**就地**补上「与持有者同阶」。
 *
 * 背景见 {@link resolveGongfaTier}：阶层系统上线前的存档里功法全部没有 tier，
 * 旧策略是「缺 tier = 不受压制、不显示阶层」，代价是玩家永远看不到阶层生效。
 * 现改为读档时补「与持有者同阶」——同阶压制系数为 1、也不算「不入流」，
 * 补完后**数值与行为完全不变**，但阶层从此显形；此后境界提升即按正常规则压制。
 *
 * 遍历持有者的功法槽与储物袋，返回补写的条数。只操作纯 JSON 存档数据，
 * 不依赖类实例，须在 `Protagonist.loadFromJson` / `npcStore.restoreNpcs` 之前调用。
 */
export function backfillGongfaTiers(
  holder: {
    realm?: { major?: string | null } | null;
    gongfaSlots?: unknown;
    inventorySlots?: unknown;
  } | null | undefined,
): number {
  if (!holder || typeof holder !== "object") return 0;
  const major = holder.realm?.major;
  if (!isItemTier(major)) return 0;
  const fallback = fallbackGongfaTier(major);
  let count = 0;
  if (Array.isArray(holder.gongfaSlots)) {
    for (const g of holder.gongfaSlots) {
      if (!g || typeof g !== "object") continue;
      const rec = g as Record<string, unknown>;
      if (!isItemTier(rec.tier)) {
        rec.tier = fallback;
        count++;
      }
    }
  }
  if (Array.isArray(holder.inventorySlots)) {
    for (const it of holder.inventorySlots) {
      if (!it || typeof it !== "object") continue;
      const rec = it as Record<string, unknown>;
      if (rec.itemType !== "功法") continue;
      if (!isItemTier(rec.tier)) {
        rec.tier = fallback;
        count++;
      }
    }
  }
  return count;
}
