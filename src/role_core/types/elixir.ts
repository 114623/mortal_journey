import {
  ELIXIR_GRADE_EFFECT_TABLE,
  ELIXIR_EFFECT_WEIGHTS,
  ELIXIR_PERCENT_GRADE_THRESHOLD,
  GRADE_INDEX,
  getLinggenElementBonus,
} from "./gameConstants";
import type { InventoryStackItem } from "./itemInfo";
import type { ItemTier } from "./itemTier";
import { scaleElixirByTier } from "./itemTier";

export type ElixirEffectType =
  | "恢复血量" | "恢复法力"
  | "提升修为" | "提升寿元"
  | "提升体魄" | "提升灵力" | "提升劲力" | "提升护体" | "提升灵御" | "提升神识"
  | "提升身法" | "提升悟性";

export const VALID_ELIXIR_EFFECT_TYPES: readonly ElixirEffectType[] = [
  "恢复血量", "恢复法力",
  "提升修为", "提升寿元",
  "提升体魄", "提升灵力", "提升劲力", "提升护体", "提升灵御", "提升神识",
  "提升身法", "提升悟性",
];

export interface ElixirEffects {
  value: number;
  isPercent: boolean;
  /** 已被木灵根烘焙加成，防重复；旧存档无此字段视为未烘焙。 */
  linggenBoosted?: boolean;
}

/**
 * 按品阶查表取丹药数值，再按阶层缩放。
 *
 * @param effectType 效果类型。
 * @param grade 品阶。
 * @param tier 阶层；为空则不缩放（兼容旧存档 / 未接入阶层的调用方）。
 */
export function rollElixirValue(effectType: ElixirEffectType, grade: string, tier?: ItemTier | null): number {
  const arr = ELIXIR_GRADE_EFFECT_TABLE[effectType];
  if (!arr) return 1;
  const gradeIdx = GRADE_INDEX[grade] ?? 0;
  const base = arr[Math.min(gradeIdx, arr.length - 1)];
  return scaleElixirByTier(base, tier, isElixirPercent(effectType, grade));
}

export function isElixirPercent(effectType: ElixirEffectType, grade: string): boolean {
  if (effectType !== "恢复血量" && effectType !== "恢复法力" && effectType !== "提升修为") return false;
  const gradeIdx = GRADE_INDEX[grade] ?? 0;
  return gradeIdx >= ELIXIR_PERCENT_GRADE_THRESHOLD;
}

export function parseElixirEffectType(raw: unknown): ElixirEffectType {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if ((VALID_ELIXIR_EFFECT_TYPES as readonly string[]).includes(trimmed)) {
      return trimmed as ElixirEffectType;
    }
  }
  return rollElixirEffectType();
}

/** 按 ELIXIR_EFFECT_WEIGHTS 权重随机选取丹药效果类型。 */
export function rollElixirEffectType(): ElixirEffectType {
  const entries = (Object.entries(ELIXIR_EFFECT_WEIGHTS) as [string, number][])
    .filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return "恢复血量";
  let roll = Math.random() * total;
  for (const [name, w] of entries) {
    roll -= w;
    if (roll <= 0) return name as ElixirEffectType;
  }
  return "恢复血量";
}

const ELIXIR_EFFECT_TO_STAT_KEY: Readonly<Record<string, string>> = {
  "提升体魄": "physique",
  "提升灵力": "spirit",
  "提升劲力": "strength",
  "提升神识": "perception",
  "提升护体": "guard",
  "提升灵御": "resistance",
  "提升身法": "agility",
  "提升悟性": "insight",
};

export function elixirEffectToStatKey(effectType: ElixirEffectType): string | null {
  return ELIXIR_EFFECT_TO_STAT_KEY[effectType] ?? null;
}

export interface ElixirItemDefinition {
  itemType: "丹药";
  name: string;
  desc: string;
  grade: import("./itemInfo").ItemGrade;
  count: number;
  effectType: ElixirEffectType;
  effects: ElixirEffects;
  /**
   * 丹药阶层，默认由获取时的境界决定（炼丹时继承自材料阶层）。
   * 旧存档缺失时按品阶回退（见 `resolveItemTier`）。
   */
  tier?: ItemTier;
}

/**
 * 木灵根契合：丹药获取时烘焙。若角色有木灵根且丹药尚未被烘焙过，
 * 按当前大境界加成提升 effects.value 并打 linggenBoosted 标记。
 * 直接修改传入的 item（原地烘焙）。
 */
export function applyLinggenElixirBoost(
  item: InventoryStackItem,
  linggen: readonly string[],
  realmMajor: string,
): void {
  if (!("itemType" in item) || item.itemType !== "丹药") return;
  const elixir = item as ElixirItemDefinition;
  if (!elixir.effects) return;
  if (elixir.effects.linggenBoosted) return;
  if (!linggen.includes("木")) return;
  const bonus = getLinggenElementBonus(realmMajor, "木");
  if (bonus <= 0) return;
  elixir.effects.value = Math.round(elixir.effects.value * (1 + bonus / 100));
  elixir.effects.linggenBoosted = true;
}
