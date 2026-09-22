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
import { resolveItemTier, tierLabel, describeTierSuppression, describeElixirTierSuppression, applyElixirTierSuppression } from "../role_core/types/itemTier";
import type { GongfaSpecialEffect } from "../role_core/types/gongfa";
import { resolveGongfaEffectDisplay, resolveGongfaLayer10 } from "../role_core/types/gongfa";
import { gradeToTraitRarity, getGongfaMasteryProgress } from "./protagonistPanelDisplay";
import { getItemSellPrice } from "../role_core/types/gameConstants";
import { gongfaCombatMult, gongfaAttriMultOf, gongfaMaxLayerOf, clampGongfaMastery } from "../role_core/realmUtils";
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
  _system?: string,
  derivedStatsGetter?: () => DerivedStatValues,
  mastery?: number,
  cooldownReduce?: number,
  maxLayer: number = 10,
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
        // 战斗倍率按修炼进度比例插值，层号映射到 10 层基准曲线的连续位置。
        const masteryMult = mastery != null && mastery >= 1
          ? gongfaCombatMult(clampGongfaMastery(mastery, maxLayer), maxLayer)
          : 1.0;
        const layer10 = resolveGongfaLayer10(clampGongfaMastery(mastery ?? 1, maxLayer), maxLayer);
        return resolveGongfaEffectDisplay(fn, getStat, masteryMult, layer10, cooldownReduce ?? 0);
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
 * 追加法宝「属性加成」段落（原 modifiers 战斗修正展示）。
 *
 * @param out 段落数组（原地修改）。
 * @param fn 法宝 function；为空则不追加。
 */
function pushTreasureAttributeBonusSection(
  out: ProtagonistDetailSection[],
  fn: TreasureSpecialEffect | undefined,
): void {
  if (!fn) return;
  out.push({
    label: "属性加成",
    text: fn.modifiers
      .map(m => `${TREASURE_MODIFIER_NAMES[m.modifierType]}+${m.value}%`)
      .join("\n"),
  });
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
): void {
  if (!se) return;
  const lines: string[] = [];
  for (const c of se.conversions) lines.push(formatTreasureConversion(c));
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
): string | undefined {
  const b = gf.bonus as Record<string, number> | undefined;
  if (!b || typeof b !== "object") return undefined;
  const masteryMult = gongfaAttriMultOf(gf);
  const parts = Object.entries(b).map(([k, v]) => {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    const raw = typeof v === "number" ? v : 0;
    const val = Math.trunc(raw * masteryMult);
    const sign = val >= 0 ? "+" : "";
    let line = `${k} ${sign}${val}`;
    return line;
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
  pushTreasureAttributeBonusSection(sections, it.function);
  pushTreasureSpecialEffectSection(sections, it.specialEffect);

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
): ProtagonistDetailPayload {
  const sections: ProtagonistDetailSection[] = [];
  pushSec(sections, "简介", gf.desc);
  pushSec(sections, "品级", gf.grade);
  // 阶层：决定数值量级、跨阶压制与**层数上限**，是功法最核心的定位信息。
  {
    // 2026-09-21：原「已不入流 · 修炼不再增进修为」提示已随该机制一并移除，
    // 阶层现在只反映数值量级、跨阶压制与层数上限。
    pushSec(sections, "阶层", gf.tier ? tierLabel(gf.tier) : "未定");
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
  const bonus = formatZhBonusWithMastery(gf);
  if (bonus) pushSec(sections, "修炼加成", bonus);
  pushSpecialEffectSection(sections, gf.function, gf.grade, primaryStatGetter, statNameGetter, gf.system, derivedStatsGetter, mastery, cooldownReduce, maxLayer);
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
function formatElixirEffective(el: ElixirItemDefinition, realmMajor?: string): string {
  if (!realmMajor) return "";
  const tier = resolveItemTier(el.tier, el.grade);
  const actual = applyElixirTierSuppression(el.effects.value, tier, realmMajor);
  if (actual >= el.effects.value) return "";
  return `实际药力 ${actual}${el.effects.isPercent ? "%" : ""}`;
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
): ProtagonistDetailPayload {
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
        realmMajor ? { major: realmMajor, minor: "" } : null,
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
      pushSec(sections, "当前境界药力", formatElixirEffective(pill, realmMajor));
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


