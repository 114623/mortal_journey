/**
 * @fileoverview 绝对加成的**境界缩放**（RealmScale）+ 功法**层号锚定**数值曲线。
 *
 * 本文件现在管两条独立的线：
 *
 * ## 1. 功法主属性 —— 层号锚定（2026-09-25 v4 核心）
 *
 * {@link gongfaLayerValue}：**同层同值，阶层只决定能修到第几层**。
 * 任何功法在第 L 层的加成完全相同，与阶层、与使用者境界都无关。
 * 这一条同时解决了三个老问题：
 *   - 老版本「绝对值 ÷ 随境界涨 790 倍的基准」→ 加成占比从 860% 崩到 4.4%；
 *   - 低阶功法需要压制系数才能自然淘汰 → 现在绝对值固定、境界基准上涨，自动淘汰；
 *   - 越阶得宝产生数值 spike → 现在 L1 都一样，高阶功法只送「未来的深度」。
 *
 * ## 2. 丹药定值效果 + 技能绝对点数 —— 境界缩放
 *
 * - {@link elixirRealmScale}：丹药定值型效果，受 {@link REALM_SCALE_FROM_MAJOR} 门槛管辖。
 * - ~~{@link gongfaSkillRealmScale}~~：**已无调用方**（2026-09-25 晚）。
 *   技能侧的绝对点数改走 {@link gongfaBvValue}（层号锚定、同层同值），
 *   因为按施法者境界缩放会废掉自然淘汰——练气功法带到化神会被算成化神量级。
 *
 * 两者公式同构：`系数 = 基准 × TARGET / 典型值`，使占比在各境界保持恒定。
 *
 * ## 与跨阶压制的关系
 *
 * 功法 v4 起**不再有跨阶威力系数**（`itemTier.gongfaTierFactor` 仅凡人生效）；
 * 法宝（`treasureTierFactor`）与丹药（`elixirTierFactor`）的压制完全不受影响。
 *
 * ## 兼容性
 *
 * 只改**计算时**，不改存档数据。`collectPrimaryBonuses` 每次实时派生，
 * 故老存档立即生效，无需迁移。
 */

import type { PrimaryStatKey } from "./types/playInfo";
import {
  REALM_PRIMARY_STATS_TABLE,
  GONGFA_GRADE_ATTRI_TABLE,
  ELIXIR_GRADE_EFFECT_TABLE,
} from "./types/gameConstants";
import { tierIndex, isItemTier, TIER_MULT, GONGFA_MAX_LAYER_BY_TIER } from "./types/itemTier";
import {
  getRealmPrimaryStats,
  getCultivationRequired,
  getShouyuanForRealm,
} from "./realmUtils";

// ═══════════════════════════════════════════════════════════════════════════
// 调参旋钮
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 境界缩放的**启用起点**：低于此大境界的角色一律返回 1（不缩放）。
 *
 * 【2026-09-25 v4】本门槛**只服务丹药**（`elixirRealmScale`）。
 * 功法线（`gongfaRealmScale`）已随 v4 重构删除，改由层号直接查
 * {@link gongfaLayerValue}，不再需要「境界门槛」这一层判断。
 *
 * 冻结凡人~筑基是刻意的：这三段 `REALM_PRIMARY_STATS_TABLE` 基数太小
 * （护体 1、体魄 2、灵力 1），任何整数加成都会造成上百个百分点的跳动，
 * 精确控制在那里没有意义。
 *
 * 【试过下调到「练气」，已回退】练气中期基准灵力只有 10，占比 6% 即 +0.6，
 * 一颗丹药的效果会被压到保底值。低境界基准绝对值太小，比例归一在那里没有意义。
 */
export const REALM_SCALE_FROM_MAJOR = "结丹";

/**
 * 丹药目标占比：**单颗**「同阶 · 神品」定值型效果占该境界对应基准的比例。
 *
 * 刻意比功法低一个量级：丹药是消耗品、可堆叠服用，
 * 给到与功法同量级会让「嗑药」压过「修功」。0.06 表示约 8 颗才抵一门神品功法。
 */
export const ELIXIR_REALM_SCALE_TARGET = 0.06;

/**
 * 功法**技能数值**（`baseValue` / `summonDamage` / `tickValue` 这类绝对点数）的缩放基准：
 * 取境界表最后一行的血量，即**化神后期**。
 *
 * 为什么是化神后期——反过来推的：目录里神品「天魔噬魂」满层在化神后期约打掉同阶
 * 六成血，看着就是设计意图；同一条数值放到练气中期却是一万九千倍血量。
 * 也就是说**目录数值是按高境界写的**，低境界等比缩小才对得上。
 */
function skillScaleRefHp(): number {
  const last = REALM_PRIMARY_STATS_TABLE[REALM_PRIMARY_STATS_TABLE.length - 1];
  return last?.hp ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部查表
// ═══════════════════════════════════════════════════════════════════════════

/** 中文主属性名 → 英文 key（与 `playInfo.PRIMARY_STAT_KEY_TO_ZH` 互为逆）。 */
const ZH_TO_PRIMARY: Readonly<Record<string, PrimaryStatKey>> = {
  体魄: "physique",
  灵力: "spirit",
  劲力: "strength",
  神识: "perception",
  护体: "guard",
  灵御: "resistance",
  身法: "agility",
  悟性: "insight",
};

/** 丹药效果名 → 主属性 key；血/法/修为/寿元不在其中，走 {@link elixirScaleBase} 的分支。 */
const ELIXIR_STAT_CN_TO_KEY: Readonly<Record<string, PrimaryStatKey>> = {
  "提升体魄": "physique",
  "提升灵力": "spirit",
  "提升劲力": "strength",
  "提升神识": "perception",
  "提升护体": "guard",
  "提升灵御": "resistance",
  "提升身法": "agility",
  "提升悟性": "insight",
};

/** 大境界顺序；只用于索引 `REALM_PRIMARY_STATS_TABLE`，刻意不引 `playInfo`（避免环）。 */
const MAJORS = ["凡人", "练气", "筑基", "结丹", "元婴", "化神"] as const;
const MINORS = ["初期", "中期", "后期"] as const;

/** 境界原表行索引；非法组合返回 -1。 */
function rowIndex(realmMajor: string, realmMinor: string): number {
  const mi = MAJORS.indexOf(realmMajor as (typeof MAJORS)[number]);
  const si = MINORS.indexOf(realmMinor as (typeof MINORS)[number]);
  if (mi < 0 || si < 0) return -1;
  return mi * 3 + si;
}

/**
 * 判断某大境界是否参与境界缩放。
 *
 * 用 `itemTier.tierIndex` 而非 `playInfo.REALM_ORDER`——后者会让本文件反向依赖
 * 枢纽模块，有环风险（见 itemTier.ts 头部的 TDZ 事故记录）。
 */
export function realmScaleEnabled(realmMajor: string | null | undefined): boolean {
  if (!realmMajor) return false;
  const i = tierIndex(realmMajor);
  if (i <= 0) return false;
  return i >= tierIndex(REALM_SCALE_FROM_MAJOR);
}

/**
 * 取功法某词条在**极品**档的中值（(lo+hi)/2）；查不到返回 0。
 *
 * 【2026-09-25 v4】极品是 v4 数值模型的**锚定口径**（`gongfaLayerValue` 的
 * 锚点即「roll = 极品中值时」的加成），故品阶换算一律以它为分母：
 * 下品 33% / 中品 59% / 上品 81% / 极品 100% / 仙品 115% / 神品 130%。
 */
export function gongfaTypicalValue(bonusZh: string): number {
  const row = GONGFA_GRADE_ATTRI_TABLE[bonusZh];
  if (!row || row.length === 0) return 0;
  // row = [下, 中, 上, 极, 仙, 神]；索引 3 是极品。
  const top = row[3] ?? row[row.length - 1];
  const [lo, hi] = top;
  return (lo + hi) / 2;
}

/**
 * **顶档为百分比型**的丹药效果。
 *
 * `ELIXIR_GRADE_EFFECT_TABLE` 里有几行是语义混合的：前三档（下/中/上品）给定值，
 * 后三档（极/仙/神品）给百分比。例如「提升修为」= [200, 1000, 5000, 10, 20, 30]，
 * 前三个是修为点、后三个是百分比。这些行若照神品值（30）当定值典型值，
 * 算出来的系数会错上百倍，故单列下行后退到最后一个定值档（上品）。
 */
const ELIXIR_TOP_IS_PERCENT: Readonly<Record<string, true>> = {
  恢复血量: true,
  恢复法力: true,
  提升修为: true,
};

/**
 * 取丹药某效果的**定值型**典型值。
 *
 * 混合语义的行（见 {@link ELIXIR_TOP_IS_PERCENT}）取上品，其余取神品。
 *
 * @returns 典型值；查不到返回 0。
 */
function elixirTypicalValue(effectType: string): number {
  const row = ELIXIR_GRADE_EFFECT_TABLE[effectType];
  if (!row || row.length === 0) return 0;
  // row = [下, 中, 上, 极, 仙, 神]；索引 2 是上品、5 是神品。
  return ELIXIR_TOP_IS_PERCENT[effectType] ? row[2] : row[row.length - 1];
}

/** 取境界原表的 hp / mp（`getRealmPrimaryStats` 只返回 8 个主属性，血法需另取）。 */
function realmRowResource(
  realmMajor: string,
  realmMinor: string,
  field: "hp" | "mp",
): number {
  const idx = rowIndex(realmMajor, realmMinor);
  if (idx < 0 || idx >= REALM_PRIMARY_STATS_TABLE.length) return 0;
  return REALM_PRIMARY_STATS_TABLE[idx][field] ?? 0;
}

/**
 * 丹药各类效果的「基准量」，即该效果占比的参照物。
 *
 * 主属性读境界属性表；恢复血/法读境界表的 hp/mp；
 * 修为读突破到该阶段所需值；寿元读该阶段寿元上限。
 *
 * @returns 基准值；无法确定时返回 0（调用方据此回退为不缩放）。
 */
function elixirScaleBase(
  effectType: string,
  realmMajor: string,
  realmMinor: string,
): number {
  const statKey = ELIXIR_STAT_CN_TO_KEY[effectType];
  if (statKey) {
    return getRealmPrimaryStats(realmMajor, realmMinor)?.[statKey] ?? 0;
  }
  switch (effectType) {
    case "恢复血量":
      return realmRowResource(realmMajor, realmMinor, "hp");
    case "恢复法力":
      return realmRowResource(realmMajor, realmMinor, "mp");
    case "提升修为":
      return getCultivationRequired(realmMajor, realmMinor) ?? 0;
    case "提升寿元":
      return getShouyuanForRealm(realmMajor, realmMinor) ?? 0;
    default:
      return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外 API
// ═══════════════════════════════════════════════════════════════════════════

/* 【2026-09-25 v4 删除】
 * 原 `gongfaRealmScale`（功法词条的境界缩放）已移除。
 * v4 起加成由**连续层号**唯一决定，见 {@link gongfaLayerValue}。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 功法主属性：层号 → 加成值（v4 核心）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 层号锚点：**（层号, 占该阶层后期基准的比例）**。
 *
 * 层号从 `GONGFA_MAX_LAYER_BY_TIER` 取，不手抄数字——改层数表时锚点自动跟随。
 * 「X 后基准」= `getRealmPrimaryStats(tier, "后期")[该属性]`，**按属性分别取值**
 * （不能只做一条劲力曲线，否则化神满层体魄会变成基准的 407%）。
 */
const LAYER_ANCHORS: readonly { layer: number; tier: keyof typeof GONGFA_MAX_LAYER_BY_TIER; pct: number }[] = [
  { layer: 1, tier: "练气", pct: 0.25 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.练气, tier: "练气", pct: 0.5 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.筑基, tier: "筑基", pct: 0.5 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.结丹, tier: "结丹", pct: 0.5 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.元婴, tier: "元婴", pct: 0.5 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.化神, tier: "化神", pct: 0.5 },
];

/**
 * 功法在第 `contLayer` 层的**主属性加成**（极品中值口径）。
 *
 * ## 这是 v4 的核心：**同层同值，阶层只决定能修到第几层**
 *
 * 任何功法在第 L 层的加成完全相同，与它的阶层、与使用者的境界都无关。
 * 于是两条旧机制自然退场：
 *   - **自然淘汰**：练气满层 L7 = +37.5 是固定绝对值，带到筑基（基准 250）
 *     相对缩水到 15%、带到化神约 1%，不需要压制系数；
 *   - **越阶无 spike**：筑基功法 L1 = 练气功法 L1 = +18.75，高阶功法的优势
 *     纯粹是「以后能修到更深的层」。
 *
 * ## 品阶怎么体现
 * 本函数返回的是**极品中值口径**，调用方按 roll 比例缩放：
 * `实得 = (词条 roll ÷ 极品中值) × gongfaLayerValue(...)`，
 * 即 下品 33% / 中品 59% / 上品 81% / **极品 100%** / 仙品 115% / 神品 130%。
 *
 * ## 插值
 * 相邻锚点间**几何插值**（每层等比增长）：L1→L7 段每层 ×1.122（带内温和），
 * L7→L10 段每层 ×1.49、之后各段 ×1.36 左右（跨阶陡峭，承载境界跃迁）。
 *
 * @param statZh 中文主属性名（体魄 / 灵力 / …）。
 * @param contLayer 连续层号（见 `realmUtils.gongfaContLayer`）；<1 按 L1、>19 按 L19。
 * @returns 该层的加成值（极品中值口径）；无法确定时返回 0。
 */
export function gongfaLayerValue(statZh: string, contLayer: number): number {
  const key = ZH_TO_PRIMARY[statZh];
  if (!key) return 0;
  const vals = LAYER_ANCHORS.map(a => (getRealmPrimaryStats(a.tier, "后期")?.[key] ?? 0) * a.pct);
  const L = LAYER_ANCHORS.map(a => a.layer);
  const c = Number.isFinite(contLayer) ? contLayer : 1;
  if (c <= L[0]) return vals[0];
  const last = L.length - 1;
  if (c >= L[last]) return vals[last];
  for (let i = 0; i < last; i++) {
    if (c <= L[i + 1]) {
      const span = L[i + 1] - L[i];
      const t = span > 0 ? (c - L[i]) / span : 0;
      const lo = vals[i];
      const hi = vals[i + 1];
      if (!(lo > 0) || !(hi > 0)) return hi || lo;
      // 几何插值：两端等比，避免线性插值在低段出现「加 1 层只多 0.3 点」的观感。
      return lo * Math.pow(hi / lo, t);
    }
  }
  return vals[last];
}

// ═══════════════════════════════════════════════════════════════════════════
// 功法技能/效果的【绝对点数】：层号 → 点数
//
//     与主属性（{@link gongfaLayerValue}）**同一套做法**：锚点只看层号，
//     不看使用者境界、不看功法阶层 —— 同层同值，自然淘汰得以保留。
//
//     为什么需要单独一条曲线：目录里的 `baseValue` 是按高境界量级写死的绝对点数
//     （极品 250~1500、神品 500~2500），旧口径 × `gongfaSkillRealmScale`
//     （练气中期只有 0.0091）会把它打到 6 点、等于归零 —— 于是练气期把功法练满，
//     技能伤害仍低于普攻（实测极品 L7 42 点 vs 普攻 50）。
//
//     校准：L1 = 练气后期血 7%（入门略弱、留成长感），其余统一 11.4%。
//     结果各境界「自己功法的满层」都落在占血 23%~41%（spec 目标 20%~45%），
//     且低阶功法练满带到化神只剩 0.7× 普攻（自然淘汰成立）。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 技能绝对点数的层号锚点：**（层号, 占该阶层后期血量的比例）**。
 *
 * 层号从 `GONGFA_MAX_LAYER_BY_TIER` 取、血量从 `REALM_PRIMARY_STATS_TABLE` 取，
 * **不手抄数字** —— 改层数表或境界表时曲线自动跟随。
 */
const BV_LAYER_ANCHORS: readonly { layer: number; tier: keyof typeof GONGFA_MAX_LAYER_BY_TIER; pct: number }[] = [
  { layer: 1, tier: "练气", pct: 0.07 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.练气, tier: "练气", pct: 0.114 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.筑基, tier: "筑基", pct: 0.114 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.结丹, tier: "结丹", pct: 0.114 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.元婴, tier: "元婴", pct: 0.114 },
  { layer: GONGFA_MAX_LAYER_BY_TIER.化神, tier: "化神", pct: 0.114 },
];

/**
 * 功法技能/效果在第 `contLayer` 层的**绝对点数**（`baseValue` / `summonDamage` /
 * 定值 `tickValue` 这类"点数"字段的取值）。
 *
 * ## 与主属性的分工
 * 技能数值 = 本函数给的**固定底盘** + `scalingRatio × 使用者实时属性`（后者随角色成长）。
 * 于是"同层同值"与"堆属性有反馈"两者兼得：
 *   - 底盘只认层号 → 同层同值、自然淘汰（练气功法练满带到化神只有 0.7× 普攻）；
 *   - 属性项认使用者 → 神识/灵力对法修重新有效。
 *
 * ## 不要再乘 `gongfaSkillRealmScale`
 * 那是「按施法者境界缩放」，会破坏同层同值并废掉自然淘汰（用户明确否决过）：
 * 练气功法带到化神会被算成化神量级，永远淘汰不掉。
 *
 * ## 不要再乘战斗倍率 `masteryMult`
 * 本曲线本身已含层号成长（L1 35 → L19 3,762），再乘会双重成长。
 * 战斗倍率只作用于 `scalingRatio × 属性` 那一项。
 *
 * @param contLayer 连续层号（见 `realmUtils.gongfaContLayer`）；<1 按 L1、>19 按 L19。
 * @returns 该层的绝对点数；无法确定时返回 0。
 */
export function gongfaBvValue(contLayer: number): number {
  const vals = BV_LAYER_ANCHORS.map(a => realmRowResource(a.tier, "后期", "hp") * a.pct);
  const L = BV_LAYER_ANCHORS.map(a => a.layer);
  const c = Number.isFinite(contLayer) ? contLayer : 1;
  if (c <= L[0]) return vals[0];
  const last = L.length - 1;
  if (c >= L[last]) return vals[last];
  for (let i = 0; i < last; i++) {
    if (c <= L[i + 1]) {
      const span = L[i + 1] - L[i];
      const t = span > 0 ? (c - L[i]) / span : 0;
      const lo = vals[i];
      const hi = vals[i + 1];
      if (!(lo > 0) || !(hi > 0)) return hi || lo;
      return lo * Math.pow(hi / lo, t); // 几何插值，与 gongfaLayerValue 一致
    }
  }
  return vals[last];
}

/**
 * 丹药**定值型**效果的境界缩放系数（服用时乘在最外层）。
 *
 * 百分比型（`isPercent`）务必跳过：它本身就是比例，天然水涨船高，再乘会重复加成。
 *
 * @param effectType 丹药效果中文名（提升劲力 / 恢复血量 / …）。
 * @param realmMajor 服用者当前大境界。
 * @param realmMinor 服用者当前小境界。
 * @returns 缩放系数；未启用或无法确定时返回 1。
 */
export function elixirRealmScale(
  effectType: string,
  realmMajor: string | null | undefined,
  realmMinor: string | null | undefined,
): number {
  if (!realmMajor) return 1;
  if (!realmScaleEnabled(realmMajor)) return 1;
  const minor = realmMinor || MINORS[0];
  const base = elixirScaleBase(effectType, realmMajor, minor);
  const typical = elixirTypicalValue(effectType);
  // 生成时已按 scaleElixirByTier 乘过 TIER_MULT[tier]。这里先扣掉「同阶」那一层，
  // 剩下的交给分子（境界基准）决定，占比才真正与境界无关。
  const mult = isItemTier(realmMajor) ? TIER_MULT[realmMajor] : 1;
  if (!(base > 0) || !(typical > 0) || !(mult > 0)) return 1;
  return (base * ELIXIR_REALM_SCALE_TARGET) / (typical * mult);
}

/**
 * 功法**技能绝对数值**的境界缩放系数（施法者境界血量 / 化神后期血量）。
 *
 * ## 它与 {@link gongfaRealmScale} 是同一个问题的两面
 *
 * 【2026-09-25 v4】技能侧**保留使用者口径**（用户拍板「像最开始那样」）：
 * `scalingRatio ×` 用**施法者实时属性**，`baseValue` 等绝对点数用本系数
 * （施法者境界血量 / 化神后期血量）。曾考虑改锚功法 tier 基准，
 * 但那会让神识/灵力对法修失效——属性堆了不影响技能，手感是错的。
 *
 * 低阶技能在高境界的劣势由**层号深度**承担（`gongfaCombatMultAt`：
 * 练气满层 1.45 vs 化神满层 2.35），不再需要别的系数。
 *
 * ## 不受 {@link REALM_SCALE_FROM_MAJOR} 门槛限制
 *
 * 丹药缩放刻意冻结前期（凡人~筑基基数太小，整数粒度不够），但技能**必须**连凡人一起缩放：
 * 练气满层一击 7807 点、而练气角色只有 300~404 血，这个量级错配在凡人期一样致命。
 * 基准取化神后期，低境界自然收敛到极小的系数，不需要额外门槛。
 *
 * @deprecated 【2026-09-25 晚】技能侧的绝对点数已改走 {@link gongfaBvValue}
 * （层号锚定、同层同值），本函数**已无调用方**，仅为存档/外部引用保留。
 * 不要在新代码里用它给技能数值做境界缩放——那会破坏同层同值并废掉自然淘汰。
 *
 * @param realmMajor 施法者当前大境界。
 * @param realmMinor 施法者当前小境界；缺失时退到「初期」。
 * @returns 缩放系数；无法确定时返回 1（保持旧行为）。
 */
export function gongfaSkillRealmScale(
  realmMajor: string | null | undefined,
  realmMinor: string | null | undefined,
): number {
  if (!realmMajor) return 1;
  const minor = realmMinor || MINORS[0];
  const hp = realmRowResource(realmMajor, minor, "hp");
  const ref = skillScaleRefHp();
  if (!(hp > 0) || !(ref > 0)) return 1;
  return hp / ref;
}

/**
 * 把一批已乘过缩放的**浮点**加成收敛成整数。
 *
 * 刻意「先累加、最后取整」：逐条各自 trunc 时，多件小幅加成的截断误差会累积
 * （实测凡人护体 3 条能差到 300% vs 200%），且低数值会被单独截断成 0 而彻底消失。
 * 这里统一取整并保底 1，避免「装了却等于没装」。
 *
 * @param acc 中文词条名 → 浮点累加值。
 * @returns 中文词条名 → 整数加成（至少 1）。
 */
export function finalizeZhBonus(
  acc: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [zh, sum] of Object.entries(acc)) {
    if (typeof sum !== "number" || !Number.isFinite(sum) || sum <= 0) continue;
    out[zh] = Math.max(1, Math.trunc(sum));
  }
  return out;
}
