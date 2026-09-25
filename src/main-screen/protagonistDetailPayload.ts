/**
 * @fileoverview 主角左栏详情弹窗内容，与 mortal_journey 中 `openItemDetailModal` /
 * `openTraitDetailModal` 的信息结构对齐。
 */

import type {
  CategorizedItemDefinition,
  ElixirItemDefinition,
  GongfaItemDefinition,
  InventoryStackItem,
  MaterialItemDefinition,
  MiscItemDefinition,
  SpiritStoneInventoryStack,
  TreasureItemDefinition,
} from "../role_core/types/itemInfo";
import type { CultivationRealm, EquipSlotKey, PrimaryStatKey, TraitEntry } from "../role_core/types/playInfo";
import { PRIMARY_STAT_KEY_TO_ZH } from "../role_core/types/playInfo";
import type { TreasureSpecialEffect, TreasureConversion, TreasureConversionEffect } from "../role_core/types/treasure";
import { TREASURE_MODIFIER_NAMES } from "../role_core/types/treasure";
import {
  resolveItemTier,
  tierLabel,
  describeTierSuppression,
  describeElixirTierSuppression,
  applyElixirTierSuppression,
  gongfaTierFactor,
  treasureTierFactor,
} from "../role_core/types/itemTier";
import {
  elixirRealmScale,
  gongfaBvValue,
  gongfaLayerValue,
  gongfaTypicalValue,
} from "../role_core/realmScale";
import type { GongfaSpecialEffect, GongfaSystem } from "../role_core/types/gongfa";
import {
  resolveGongfaEffectDisplay,
  gradeSkillSrMult,
  gongfaMpPct,
  gongfaMpCost,
} from "../role_core/types/gongfa";
import { gradeToTraitRarity, getGongfaMasteryProgress } from "./protagonistPanelDisplay";
import { getItemSellPrice } from "../role_core/types/gameConstants";
import {
  gongfaCombatMultAt,
  gongfaContLayer,
  gongfaLayer10At,
  gongfaMaxLayerOf,
  clampGongfaMastery,
} from "../role_core/realmUtils";
import { protagonist } from "../role_core/Protagonist";
import type { ItemGrade } from "../role_core/types/itemInfo";
import { describeTraitEffect } from "../fate_choice/traitEffect";

export interface DerivedStatValues {
  physique: number;
  spirit: number;
  strength: number;
  perception: number;
  guard: number;
  resistance: number;
  agility: number;
  insight: number;
}

type ItemSpecialEffect = TreasureSpecialEffect | GongfaSpecialEffect;

function pushSpecialEffectSection(
  out: ProtagonistDetailSection[],
  fn: ItemSpecialEffect | undefined,
  _grade: string,
  _primaryStatGetter?: () => number,
  _statNameGetter?: () => string,
  system?: string,
  derivedStatsGetter?: () => DerivedStatValues,
  mastery?: number,
  cooldownReduce?: number,
  maxLayer: number = 10,
  bvValue: number = 0,
  contLayer: number = 1,
  gradeMult: number = 1,
  mpText: string = "",
): void {
  if (!fn) return;
  out.push({
    label: "特殊效果",
    get text() {
      if ("battleEffects" in fn) {
        const ds = derivedStatsGetter ? derivedStatsGetter() : undefined;
        const getStat = (key: PrimaryStatKey) => {
          if (!ds) return 0;
          return (ds as unknown as Record<string, number>)[key] ?? 0;
        };
        // 【2026-09-25 v4】战斗倍率与目录取样都走**连续层号**，口径与 battleInit 一致：
        // 层内经验立刻反映在面板数字上，层数退化为里程碑。
        const masteryMult = gongfaCombatMultAt(contLayer);
        const layer10 = gongfaLayer10At(contLayer);
        return resolveGongfaEffectDisplay(
          fn, getStat, masteryMult, layer10, cooldownReduce ?? 0, bvValue, gradeMult, mpText,
          system as GongfaSystem | undefined,
        );
      }
      if ("modifiers" in fn) {
        const tFn = fn as TreasureSpecialEffect;
        return tFn.modifiers
          .map(m => `${TREASURE_MODIFIER_NAMES[m.modifierType]}+${m.value}%`)
          .join("\n");
      }
      return "";
    },
  });
}

/**
 * 将单条法宝转换格式化为可读文案。
 *
 * - bonus：`dest +ratio%×source`
 * - transfer：`将ratio%source转为dest`
 *
 * @param c 单条转换。
 * @returns 中文展示文案。
 */
function formatTreasureConversion(c: TreasureConversion): string {
  if (c.target === "stat") {
    const from = PRIMARY_STAT_KEY_TO_ZH[c.from];
    const to = PRIMARY_STAT_KEY_TO_ZH[c.to];
    return c.mode === "transfer"
      ? `将${c.ratio}%${from}转为${to}`
      : `${to} +${c.ratio}%×${from}`;
  }
  if (c.target === "mpToHp") {
    return c.mode === "transfer"
      ? `将${c.ratio}%法力上限转为血量上限`
      : `血量上限 +${c.ratio}%×法力上限`;
  }
  return c.mode === "transfer"
    ? `将${c.ratio}%血量上限转为法力上限`
    : `法力上限 +${c.ratio}%×血量上限`;
}

/**
 * 追加法宝「属性加成」段落（百分比词条的战斗修正）。
 *
 * 被跨阶压制时会在每条后面补一个「实装 N%」——`modifiers` 里存的是**标称值**，
 * 实际注入战斗引擎的是乘过 `treasureTierFactor` 之后的值（见
 * `battleInit.extractTreasurePassiveEffects`），不标出来会让玩家高估手里的装备。
 *
 * @param out 段落数组（原地修改）。
 * @param fn 法宝 function；为空则不追加。
 * @param tier 法宝阶层。
 * @param realmMajor 查看者当前大境界；缺省则不展示实装值。
 */
function pushTreasureAttributeBonusSection(
  out: ProtagonistDetailSection[],
  fn: TreasureSpecialEffect | undefined,
  tier?: string | null,
  realmMajor?: string | null,
): void {
  if (!fn) return;
  const f = realmMajor ? treasureTierFactor(tier, realmMajor) : 1;
  const suppressed = f > 0 && f < 1;
  out.push({
    label: "属性加成",
    text: fn.modifiers
      .map((m) => {
        const base = `${TREASURE_MODIFIER_NAMES[m.modifierType]}+${m.value}%`;
        if (!suppressed) return base;
        return `${base}（实装 +${formatPct(m.value * f)}%）`;
      })
      .join("\n"),
  });
}

/** 百分比取值格式化：保留 1 位小数并去掉多余的 0（与战斗引擎的取整口径一致）。 */
function formatPct(v: number): string {
  const r = Math.round(v * 10) / 10;
  return String(r);
}

/**
 * 追加法宝「特殊效果」段落（仙品/神品的转换型效果）。
 *
 * @param out 段落数组（原地修改）。
 * @param se 法宝 specialEffect；为空则不追加。
 */
function pushTreasureSpecialEffectSection(
  out: ProtagonistDetailSection[],
  se: TreasureConversionEffect | undefined,
  tier?: string | null,
  realmMajor?: string | null,
): void {
  if (!se) return;
  const f = realmMajor ? treasureTierFactor(tier, realmMajor) : 1;
  const suppressed = f > 0 && f < 1;
  const lines: string[] = [];
  for (const c of se.conversions) {
    const base = formatTreasureConversion(c);
    if (!base) continue;
    // 转换比率同样受跨阶压制（`Character.collectEquippedConversions` 里先乘再应用）。
    lines.push(suppressed ? `${base}（实装 ${formatPct(c.ratio * f)}%）` : base);
  }
  out.push({ label: "特殊效果", text: lines.filter(Boolean).join("\n") });
}

/**
 * 详情弹窗底部按钮所触发的动作；由 `protagonistManager.applyProtagonistDetailAction` 执行。
 */
export type ProtagonistDetailAction =
  | { id: "unequipWear"; equipSlot: EquipSlotKey }
  | { id: "unequipGongfa"; gongfaIndex: number }
  | { id: "equipWearFromBag"; inventoryIndex: number }
  | { id: "equipGongfaFromBag"; inventoryIndex: number }
  | { id: "consumeElixir"; inventoryIndex: number }
  | { id: "cultivateGongfa"; gongfaIndex: number }
  | { id: "sellFromBag"; inventoryIndex: number; count: number };

/**
 * 详情弹窗底部的一个操作按钮。
 */
export interface ProtagonistDetailActionButton {
  /** 按钮文案。 */
  label: string;
  /** 点击后执行的动作。 */
  action: ProtagonistDetailAction;
  /** 是否为主按钮样式。 */
  primary?: boolean;
}

/**
 * 详情弹窗中的一段键值说明。
 */
export interface ProtagonistDetailSection {
  /** 段落标题（如「简介」「品级」）。 */
  label: string;
  /** 段落正文。 */
  text: string;
  /** 可选进度条数据（如功法熟练度进度）。 */
  progress?: { current: number; max: number; percent: number; isMax: boolean };
  /** 功法熟练度：层数文本（左对齐）。 */
  masteryLayer?: string;
  /** 功法熟练度：进度文本（右对齐）。 */
  masteryProgress?: string;
}

/**
 * 传给详情弹窗的完整展示数据。
 */
export interface ProtagonistDetailPayload {
  title: string;
  subtitle: string;
  sections: ProtagonistDetailSection[];
  dataRarity?: string;
  actions?: ProtagonistDetailActionButton[];
  /** 以两列网格布局展示 sections */
  gridSections?: boolean;
  /** 售卖信息：存在时弹窗显示「售卖」按钮（仅储物袋非灵石物品）。 */
  sell?: {
    inventoryIndex: number;
    /** 单件售卖价（灵石），仅用于展示；实际入账由领域层重算。 */
    unitPrice: number;
    /** 该格可售卖的最大数量。 */
    maxCount: number;
    itemName: string;
  };
}

/**
 * 装备类详情所对应的来源：当前已穿戴槽位，或储物袋中的格子索引。
 */
export type WearableDetailSource =
  | { type: "equipped"; equipSlot: EquipSlotKey }
  | { type: "bag"; inventoryIndex: number };

/**
 * 功法详情所对应的来源：功法栏下标，或储物袋中的格子索引。
 */
export type GongfaDetailSource = { type: "bar"; gongfaIndex: number } | { type: "bag"; inventoryIndex: number };

/**
 * 若文本非空则构造一个详情段落，否则返回 `null`。
 *
 * @param label - 段落标题。
 * @param text - 原始文本、数字或空值。
 * @returns 有效段落对象，或内容为空时返回 `null`。
 */
function sec(label: string, text: string | number | undefined | null): ProtagonistDetailSection | null {
  if (text == null) return null;
  const t = typeof text === "string" ? text.trim() : String(text);
  if (t === "") return null;
  return { label, text: t };
}

/**
 * 将非空段落追加到数组中（内部复用 `sec`）。
 *
 * @param out - 目标段落数组（会被原地修改）。
 * @param label - 段落标题。
 * @param text - 原始文本、数字或空值。
 */
function pushSec(out: ProtagonistDetailSection[], label: string, text: string | number | undefined | null): void {
  const s = sec(label, text);
  if (s) out.push(s);
}

/**
 * 将属性加成对象格式化为中文分号分隔的展示字符串。
 *
 * @param b - 键为属性名、值为加成的记录；无效时返回 `undefined`。
 * @returns 格式化后的文案，无有效项时返回 `undefined`。
 */
function formatZhBonusWithMastery(
  gf: GongfaItemDefinition,
  realmMajor?: string | null,
  realmMinor?: string | null,
): string | undefined {
  const b = gf.bonus as Record<string, number> | undefined;
  if (!b || typeof b !== "object") return undefined;
  // 口径必须与 `Character.collectPrimaryBonuses` **逐字一致**（v4 层号锚定）：
  // 连续层号 → gongfaLayerValue，品阶由 roll ÷ 极品中值体现。
  const contLayer = gongfaContLayer(gf);
  const tierF = gongfaTierFactor(gf.tier, realmMajor);
  // v4 下仅凡人 tier 会被压制（练气及以上恒 1），故标注自然只在凡人武功上出现。
  const suppressed = tierF > 0 && tierF < 1;
  const isMortal = gf.tier === "凡人";
  const parts = Object.entries(b).map(([zh, v]) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const add = isMortal
      ? v * 2.0
      : (v / Math.max(1, gongfaTypicalValue(zh))) * gongfaLayerValue(zh, contLayer);
    const val = Math.max(1, Math.trunc(add * tierF));
    return suppressed
      ? `${zh} +${val}（跨阶压制 ${Math.round(tierF * 100)}%）`
      : `${zh} +${val}`;
  }).filter(Boolean) as string[];
  return parts.length ? parts.join("；") : undefined;
}

/**
 * 将倍率对象格式化为「键 × 值」的中文分号分隔字符串。
 *
 * @param m - 键为维度名、值为倍率的记录；无效时返回 `undefined`。
 * @returns 格式化后的文案，无有效项时返回 `undefined`。
 */
function formatMagnification(m: Record<string, number> | undefined): string | undefined {
  if (!m || typeof m !== "object") return undefined;
  const parts = Object.entries(m).map(([k, v]) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return `${k} ×${v}`;
  }).filter(Boolean) as string[];
  return parts.length ? parts.join("；") : undefined;
}

/**
 * 将物品的 `function`（SpecialEffect）格式化为多行中文展示文本。
 *
 * 输出示例（无灵根契合）：
 * ```
 * 触发条件：主动行为触发
 * 效果：恢复血量 +200（恢复）
 * 持续回合：3
 * 消耗：消耗法力 20
 * ```
 *
 * 输出示例（灵根契合）：
 * ```
 * 触发条件：主动行为触发
 * 效果：恢复血量 +200（恢复）(灵根加成 +60)
 * 持续回合：3
 * 消耗：消耗法力 20
 * ```
 */
/**
 * 根据天赋条目构建详情弹窗数据。
 *
 * @param t - 天赋条目；字符串视为仅名称的简项，对象则包含名称、稀有度与描述等。
 * @returns 弹窗载荷；`t` 为 `null`/`undefined` 时返回 `null`。
 */
export function buildTraitDetailPayload(t: TraitEntry): ProtagonistDetailPayload | null {
  if (t == null) return null;
  if (typeof t === "string") {
    return {
      title: t,
      subtitle: "天赋",
      sections: [{ label: "说明", text: t }],
    };
  }
  const sections: ProtagonistDetailSection[] = [];
  pushSec(sections, "简述", t.desc);
  const effectDesc = describeTraitEffect(t.effect);
  if (effectDesc) pushSec(sections, "效果", effectDesc);
  const sub = t.rarity?.trim() ? `品质：${t.rarity.trim()}` : "天赋";
  return {
    title: t.name || "—",
    subtitle: sub,
    sections: sections.length ? sections : [{ label: "说明", text: "暂无描述。" }],
    dataRarity: t.rarity?.trim() || undefined,
  };
}

/**
 * 根据法宝定义生成副标题。
 *
 * @param it 法宝定义。
 * @returns 固定返回「法宝」。
 */
function wearableSubtitle(it: TreasureItemDefinition): string {
  const t = tierLabel(it.tier);
  return t ? `法宝 · ${t}` : "法宝";
}

/**
 * 构建法宝的详情弹窗数据，并按来源附加「卸下」或「装备」操作。
 *
 * @param it 法宝物品定义。
 * @param source 可选来源：已装备槽位或储物袋索引；省略则无底部操作。
 * @param realm 可选境界（用于计算境界加成显示）。
 * @returns 完整的 `ProtagonistDetailPayload`。
 */
export function buildWearableDetailPayload(
  it: TreasureItemDefinition,
  source?: WearableDetailSource,
  realm?: CultivationRealm | null,
): ProtagonistDetailPayload {
  const sections: ProtagonistDetailSection[] = [];
  pushSec(sections, "简介", it.desc);
  pushSec(sections, "品级", it.grade);
  const tier = resolveItemTier(it.tier, it.grade);
  pushSec(sections, "阶层", describeTierSuppression(tier, realm?.major));
  pushTreasureAttributeBonusSection(sections, it.function, tier, realm?.major);
  pushTreasureSpecialEffectSection(sections, it.specialEffect, tier, realm?.major);

  const actions: ProtagonistDetailActionButton[] = [];
  if (source?.type === "equipped") {
    actions.push({
      label: "卸下",
      primary: true,
      action: { id: "unequipWear", equipSlot: source.equipSlot },
    });
  } else if (source?.type === "bag") {
    actions.push({
      label: "装备",
      primary: true,
      action: { id: "equipWearFromBag", inventoryIndex: source.inventoryIndex },
    });
  }

  return {
    title: it.name,
    subtitle: wearableSubtitle(it),
    sections: sections.length ? sections : [{ label: "说明", text: "暂无信息。" }],
    dataRarity: gradeToTraitRarity(it.grade),
    actions: actions.length ? actions : undefined,
  };
}

/**
 * 功法详情副标题（固定为「功法」）。
 *
 * @param gf - 功法物品定义；与 `wearableSubtitle` 对称保留参数，便于日后按类型扩展文案。
 * @returns 副标题字符串。
 */
function gongfaSubtitle(gf: GongfaItemDefinition): string {
  return `功法`;
}

/**
 * 构建功法物品的详情弹窗数据，并按来源附加「卸下」或「装备」操作。
 *
 * @param gf - 功法定义；攻击类会额外展示法力消耗与伤害倍率。
 * @param source - 可选来源：功法栏下标或储物袋索引；省略则无底部操作。
 * @returns 完整的 `ProtagonistDetailPayload`。
 */
export function buildGongfaDetailPayload(
  gf: GongfaItemDefinition,
  source?: GongfaDetailSource,
  _playerLinggen?: readonly string[] | null,
  primaryStatGetter?: () => number,
  statNameGetter?: () => string,
  derivedStatsGetter?: () => DerivedStatValues,
  cooldownReduce: number = 0,
  realm?: CultivationRealm | null,
): ProtagonistDetailPayload {
  const sections: ProtagonistDetailSection[] = [];
  pushSec(sections, "简介", gf.desc);
  pushSec(sections, "品级", gf.grade);
  // 【2026-09-25 v4】阶层对功法**只决定能修到第几层**，不再有威力折损系数，
  // 故这里不再借用法宝那套「威能 xx%」的措辞（机制上不存在，说了是误导）。
  // 凡人 tier 是唯一例外（凡俗之物不入修行：练气期 40%、筑基起 0），保留压制提示。
  {
    const maxL = gongfaMaxLayerOf(gf);
    let tierText = gf.tier ? `${tierLabel(gf.tier)} · 至多${maxL}层` : "未定";
    const tierF = gf.tier ? gongfaTierFactor(gf.tier, realm?.major) : 1;
    if (tierF > 0 && tierF < 1) {
      tierText += `（凡俗之物·威能 ${Math.round(tierF * 100)}%）`;
    }
    pushSec(sections, "阶层", tierText);
  }
  const maxLayer = gongfaMaxLayerOf(gf);
  {
    const mp = getGongfaMasteryProgress(gf);
    const layerText = `${mp.mastery}/${mp.maxLayer}层`;
    const section: ProtagonistDetailSection = {
      label: "修炼进度",
      text: mp.isMax ? `第${layerText}（已圆满）` : `第${layerText}`,
    };
    if (mp.isMax) {
      section.text = `第${layerText}（已圆满）`;
    } else {
      section.masteryLayer = `第${layerText}`;
      section.masteryProgress = `${mp.exp}/${mp.threshold}`;
      section.progress = { current: mp.exp, max: mp.threshold, percent: mp.percent, isMax: false };
    }
    sections.push(section);
  }
  const mastery = gf.mastery ?? 1;
  const bonus = formatZhBonusWithMastery(gf, realm?.major, realm?.minor);
  if (bonus) pushSec(sections, "修炼加成", bonus);
  // 【2026-09-25】技能侧（与 battleInit 逐字一致）：
  // 绝对点数的底盘走**层号曲线**（同层同值，不看使用者境界）；
  // 属性项用施法者实时面板 × 品阶系数（堆属性有反馈）。
  const bvValue = gongfaBvValue(gongfaContLayer(gf));
  const contLayer = gongfaContLayer(gf);
  const gradeMult = gradeSkillSrMult(gf.grade);
  // 蓝耗按「占自身最大法力百分比」现算（目录 mpCost 已下线）。
  const mpPct = gongfaMpPct(gf.grade, contLayer);
  const mpNow = gongfaMpCost(protagonist.value?.maxMp ?? 0, mpPct);
  const mpText = mpNow > 0 ? `法力消耗：${mpNow}（${mpPct.toFixed(0)}% 最大法力）` : "";
  pushSpecialEffectSection(
    sections, gf.function, gf.grade, primaryStatGetter, statNameGetter, gf.system,
    derivedStatsGetter, mastery, cooldownReduce, maxLayer,
    bvValue, contLayer, gradeMult, mpText,
  );
  if (gf.inheritFrom) pushSec(sections, "承继", `承「${gf.inheritFrom}」之根基`);

  const actions: ProtagonistDetailActionButton[] = [];
  if (source?.type === "bar") {
    if (mastery < maxLayer) {
      actions.push({
        label: "修炼",
        primary: true,
        action: { id: "cultivateGongfa", gongfaIndex: source.gongfaIndex },
      });
    }
    actions.push({
      label: "卸下",
      primary: mastery >= maxLayer,
      action: { id: "unequipGongfa", gongfaIndex: source.gongfaIndex },
    });
  } else if (source?.type === "bag") {
    actions.push({
      label: "装备",
      primary: true,
      action: { id: "equipGongfaFromBag", inventoryIndex: source.inventoryIndex },
    });
  }

  return {
    title: gf.name,
    subtitle: gongfaSubtitle(gf),
    sections: sections.length ? sections : [{ label: "说明", text: "暂无信息。" }],
    dataRarity: gradeToTraitRarity(gf.grade),
    actions: actions.length ? actions : undefined,
  };
}

/**
 * 将丹药的恢复类效果格式化为简短中文（生命 / 法力）。
 *
 * @param el - 丹药定义，读取 `effects.recover`。
 * @returns 可读药效字符串；无有效恢复效果时返回 `undefined`。
 */
function formatElixirEffect(el: ElixirItemDefinition): string {
  const { effectType, effects } = el;
  const suffix = effects.isPercent ? "%" : "";
  const label = effectType.startsWith("提升") ? `永久${effectType}` : effectType;
  return `${label} ${effects.value}${suffix}`;
}

/**
 * 丹药在当前境界下的**实际生效**药效文案（跨阶衰减后）。
 *
 * @param el 丹药定义。
 * @param realmMajor 查看者当前大境界；为空表示不计算衰减。
 * @returns 已衰减时返回 `「实际药力 6」`，同阶时返回空串（避免冗余）。
 */
function formatElixirEffective(
  el: ElixirItemDefinition,
  realmMajor?: string,
  realmMinor?: string,
): string {
  if (!realmMajor) return "";
  const tier = resolveItemTier(el.tier, el.grade);
  const suppressed = applyElixirTierSuppression(el.effects.value, tier, realmMajor);
  const suffix = el.effects.isPercent ? "%" : "";
  // 定值型还要乘境界缩放，否则化神期吃「+30 劲力」等于没吃。百分比型跳过。
  const actual = el.effects.isPercent
    ? suppressed
    : Math.max(1, Math.round(suppressed * elixirRealmScale(el.effectType, realmMajor, realmMinor)));
  const parts: string[] = [];
  if (suppressed < el.effects.value) {
    parts.push(`跨阶衰减后 ${suppressed}${suffix}`);
  }
  if (actual !== suppressed) {
    parts.push(`实得 ${actual}${suffix}`);
  }
  if (!parts.length) return "";
  // 口径必须与 `Protagonist.consumeElixir` 一致：先衰减、再境界缩放。
  return parts.join(" · ");
}

/**
 * 根据储物袋单格堆叠数据构建详情弹窗：灵石、装备、功法、丹药、材料、杂物或兜底未知物品。
 *
 * @param cell - 灵石堆叠或带 `itemType` 的物品堆叠。
 * @param bagIndex - 储物袋中的格子索引；传入时装备 / 功法会带上「装备」动作，省略则仅展示信息。
 * @param linggen - 主角灵根数组；灵石修炼提示与折算依赖灵根种数。
 * @returns 对应类型的 `ProtagonistDetailPayload`。
 */
export function buildInventoryStackDetailPayload(
  cell: InventoryStackItem,
  bagIndex?: number,
  linggen?: string[],
  primaryStatGetterForGongfa?: (gf: GongfaItemDefinition) => number,
  statNameGetterForGongfa?: (gf: GongfaItemDefinition) => string,
  derivedStatsGetterForGongfa?: (gf: GongfaItemDefinition) => DerivedStatValues,
  cooldownReduce: number = 0,
  realmMajor?: string,
  realmMinor?: string,
): ProtagonistDetailPayload {
  const realmForItem = realmMajor ? { major: realmMajor, minor: realmMinor ?? "" } : null;
  if (!("itemType" in cell)) {
    const st = cell as SpiritStoneInventoryStack;
    const sections: ProtagonistDetailSection[] = [];
    pushSec(sections, "简介", st.desc);
    pushSec(sections, "持有数量", st.count);
    return {
      title: st.name,
      subtitle: `灵石`,
      sections: sections.length ? sections : [{ label: "说明", text: "—" }],
    };
  }

  const it = cell;
  let payload: ProtagonistDetailPayload;
  switch (it.itemType) {
    case "法宝":
      payload = buildWearableDetailPayload(
        it,
        bagIndex != null ? { type: "bag", inventoryIndex: bagIndex } : undefined,
        realmForItem,
      );
      break;
    case "功法": {
      const gf = it as GongfaItemDefinition;
      const gfg = primaryStatGetterForGongfa
        ? () => primaryStatGetterForGongfa(gf)
        : undefined;
      const sng = statNameGetterForGongfa
        ? () => statNameGetterForGongfa(gf)
        : undefined;
      const dsg = derivedStatsGetterForGongfa
        ? () => derivedStatsGetterForGongfa(gf)
        : undefined;
      payload = buildGongfaDetailPayload(
        it,
        bagIndex != null ? { type: "bag", inventoryIndex: bagIndex } : undefined,
        linggen,
        gfg,
        sng,
        dsg,
        cooldownReduce,
        realmForItem,
      );
      break;
    }
    case "丹药": {
      const pill = it as ElixirItemDefinition;
      const pillTier = resolveItemTier(pill.tier, pill.grade);
      const sections: ProtagonistDetailSection[] = [];
      pushSec(sections, "简介", pill.desc);
      pushSec(sections, "品级", pill.grade);
      pushSec(sections, "阶层", describeElixirTierSuppression(pillTier, realmMajor));
      pushSec(sections, "药效", formatElixirEffect(pill));
      pushSec(sections, "当前境界药力", formatElixirEffective(pill, realmMajor, realmMinor));
      pushSec(sections, "数量", pill.count);
      const actions: ProtagonistDetailActionButton[] = [];
      if (bagIndex != null && pill.count > 0) {
        actions.push({ label: "服用", action: { id: "consumeElixir", inventoryIndex: bagIndex }, primary: true });
      }
      payload = {
        title: pill.name,
        subtitle: `丹药`,
        sections,
        dataRarity: gradeToTraitRarity(pill.grade),
        actions: actions.length > 0 ? actions : undefined,
      };
      break;
    }
    case "材料": {
      const m = it as MaterialItemDefinition;
      const matTier = resolveItemTier(m.tier, m.grade);
      const sections: ProtagonistDetailSection[] = [];
      pushSec(sections, "简介", m.desc);
      pushSec(sections, "品级", m.grade);
      pushSec(sections, "阶层", `${tierLabel(matTier)} · 可炼制${tierLabel(matTier)}丹药`);
      pushSec(sections, "数量", m.count);
      payload = {
        title: m.name,
        subtitle: `材料`,
        sections,
        dataRarity: gradeToTraitRarity(m.grade),
      };
      break;
    }
    case "杂物": {
      const misc = it as MiscItemDefinition;
      const sections: ProtagonistDetailSection[] = [];
      pushSec(sections, "简介", misc.desc);
      pushSec(sections, "品级", misc.grade);
      pushSec(sections, "数量", misc.count);
      payload = {
        title: misc.name,
        subtitle: `杂物`,
        sections,
        dataRarity: gradeToTraitRarity(misc.grade),
      };
      break;
    }
    default: {
      const u = it as { name?: string; desc?: string; grade?: string; count?: number };
      payload = {
        title: u.name ?? "—",
        subtitle: "物品",
        sections: [{ label: "说明", text: u.desc ?? "—" }],
        dataRarity: u.grade ? gradeToTraitRarity(u.grade) : undefined,
      };
    }
  }

  // 储物袋内任意带品阶的非灵石物品均可售卖（UI 展示用单价；实际入账由领域层重算）
  if (bagIndex != null && realmMajor != null && it.grade && it.count > 0) {
    payload.sell = {
      inventoryIndex: bagIndex,
      unitPrice: getItemSellPrice(realmMajor, it.grade),
      maxCount: it.count,
      itemName: it.name,
    };
  }
  return payload;
}


