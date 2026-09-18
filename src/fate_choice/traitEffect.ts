/**
 * @fileoverview 天赋具体效果：类型 + 纯数据解析器 + 命名池 + 展示文案。
 *
 * 解析器只 import `role_core` 的类型与 roll 函数，**不 import `Protagonist` 类**，
 * 故 `Protagonist.fromFateChoice` 反向调用本模块不会产生循环依赖。
 *
 * 设计要点：
 *   - 天赋稀有度 → 物品品阶一一映射（见 `traits.ts` 的 `TRAIT_RARITY_TO_GRADE`），
 *     每条天赋的 `effect` 已直接写明 `grade`，解析器无需再查稀有度。
 *   - 法宝/功法/丹药均复用现有 roll 函数与命名表，与 AI 掉落行为一致。
 *   - 仙品/神品法宝取命名法宝（`rollTreasureSpecialEffect`）；下品~极品取通用命名池。
 */

import type {
  ItemGrade,
  InventoryStackItem,
  TreasureItemDefinition,
  GongfaItemDefinition,
  ElixirItemDefinition,
  MaterialItemDefinition,
} from "../role_core/types/itemInfo";
import type { PrimaryStatKey } from "../role_core/types/playInfo";
import { PRIMARY_STAT_KEY_TO_ZH } from "../role_core/types/playInfo";
import type { ElixirEffectType } from "../role_core/types/elixir";
import { rollElixirValue, isElixirPercent } from "../role_core/types/elixir";
import type { GongfaSystem, GongfaSpecialEffect } from "../role_core/types/gongfa";
import { rollGongfaFunction } from "../role_core/types/gongfa";
import { rollTreasureFunction, rollTreasureSpecialEffect } from "../role_core/types/treasure";
import { rollItemTier } from "../role_core/types/itemTier";
import { GONGFA_GRADE_ATTRI_TABLE, rollGradeAttriValue } from "../role_core/types/gameConstants";
import { ELIXIR_NAME_TABLE } from "../role_core/alchemy";

// ---------------------------------------------------------------------------
// 效果类型（判别联合）
// ---------------------------------------------------------------------------

export type TraitEffect =
  | { kind: "spiritStones"; count: number }
  | { kind: "materials"; grade: ItemGrade; count: number }
  | { kind: "elixir"; grade: ItemGrade; count: number; effectType: ElixirEffectType }
  | { kind: "statBonus"; stats: Partial<Record<PrimaryStatKey, number>> }
  | { kind: "treasure"; grade: ItemGrade }
  | { kind: "gongfa"; system: GongfaSystem; grade: ItemGrade };

/** 解析后的聚合结果：调用方据此写入主角。 */
export interface ResolvedTraitEffect {
  /** 进储物袋的法宝/功法/丹药/材料。 */
  items: InventoryStackItem[];
  /** 直接加到主属性上的加成。 */
  statBonus: Partial<Record<PrimaryStatKey, number>>;
  /** 灵石数量。 */
  spiritStones: number;
}

// ---------------------------------------------------------------------------
// 命名池
// ---------------------------------------------------------------------------

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 材料命名池（按品阶；目前材料只由 AI 命名，此表为天赋授予专用）。 */
const MATERIAL_NAME_TABLE: Readonly<Record<ItemGrade, readonly { name: string; desc: string }[]>> = {
  下品: [
    { name: "百年灵芝", desc: "生于深山的低阶灵草，蕴含稀薄灵气，炼丹常用辅料。" },
    { name: "铁木枝", desc: "铁木所生枝条，坚韧如铁，是炼制低阶丹药的常用材料。" },
    { name: "赤炎草", desc: "生于向阳坡地的灵草，性温，入药可温养经脉。" },
  ],
  中品: [
    { name: "千年灵芝", desc: "吸纳百年灵气的中阶灵药，药性醇厚，炼丹价值颇高。" },
    { name: "寒铁精", desc: "万载寒铁凝炼的精华，寒气逼人，是上佳的炼丹辅材。" },
    { name: "紫叶兰", desc: "叶脉泛紫的珍稀灵兰，入药可助凝练真元。" },
  ],
  上品: [
    { name: "万年灵芝", desc: "历经万载岁月的珍稀灵芝，灵气氤氲，炼丹名材。" },
    { name: "玄铁精", desc: "上古玄铁凝炼的精华，坚逾金玉，炼丹炼器皆宜。" },
    { name: "九叶兰", desc: "一株九叶的稀世灵兰，叶含灵光，入药功效非凡。" },
  ],
  极品: [
    { name: "天地灵果", desc: "吸纳天地灵气而结的灵果，服之可通灵窍，炼丹极品。" },
    { name: "太乙精金", desc: "蕴含太乙之气的精金，光彩夺目，万金难求。" },
    { name: "九转灵芝", desc: "经九转而成的极品灵芝，灵气凝实，炼丹圣物。" },
  ],
  仙品: [
    { name: "仙界灵根", desc: "自仙界坠落的灵根碎片，仙气流转，非凡间之物。" },
    { name: "混元金精", desc: "混元之气凝炼的金精，光辉灿烂，仙家炼丹至宝。" },
    { name: "造化灵芝", desc: "夺天地造化而生的仙品灵芝，一株可抵凡间百草。" },
  ],
  神品: [
    { name: "神界天材", desc: "源自神界的稀世天材，神韵流转，近乎不朽。" },
    { name: "混沌神金", desc: "混沌初开时凝炼的神金，万劫不坏，举世罕见。" },
    { name: "造化神根", desc: "造化之神遗留的灵根，神光内蕴，炼丹可夺天工。" },
  ],
};

/**
 * 通用法宝命名池（仅下品~极品使用）。
 * 仙品/神品法宝直接采用 `rollTreasureSpecialEffect` 返回的命名法宝。
 */
const GENERIC_TREASURE_NAME_TABLE: Readonly<Record<ItemGrade, readonly { name: string; desc: string }[]>> = {
  下品: [
    { name: "玄铁剑", desc: "以玄铁粗炼而成的低阶法器，锋刃尚可，聊胜于无。" },
    { name: "灵纹甲", desc: "刻有粗浅灵纹的护身甲胄，可挡寻常刀剑。" },
    { name: "青木环", desc: "青木所制的法环，灵气微弱，初学者常用。" },
  ],
  中品: [
    { name: "寒霜剑", desc: "寒霜之气凝于剑身，挥动间寒意逼人。" },
    { name: "金丝甲", desc: "以金丝灵线织就的软甲，轻便而坚韧。" },
    { name: "聚灵环", desc: "可汇聚灵气的中阶法环，辅助修行颇有奇效。" },
  ],
  上品: [
    { name: "紫电剑", desc: "剑身紫电缠绕，出鞘时电光乍现，威能不俗。" },
    { name: "玄龟甲", desc: "取玄龟背甲炼制的上品护甲，坚逾金石。" },
    { name: "纳灵环", desc: "能纳藏灵气的上品法环，攻守兼备。" },
  ],
  极品: [
    { name: "天星剑", desc: "以陨星之铁炼就的极品法剑，剑光如星河倾泻。" },
    { name: "龙鳞甲", desc: "真龙遗鳞拼合而成的极品宝甲，万法难伤。" },
    { name: "乾坤环", desc: "暗合乾坤之理的极品法环，灵韵深远。" },
  ],
  仙品: [
    { name: "仙品法宝", desc: "仙家遗落人间的法宝，仙韵流转。" },
  ],
  神品: [
    { name: "神品法宝", desc: "神界流传的至宝，神光万丈。" },
  ],
};

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

/** 从功法品阶属性表的主属性键中随机取一个（用于功法被动加成）。 */
function pickRandomBonusName(): string {
  const keys = Object.keys(GONGFA_GRADE_ATTRI_TABLE);
  return keys[Math.floor(Math.random() * keys.length)];
}

/** 根据功法战斗效果的 scalingStat 决定属性加成；效果无属性加成时回退随机。 */
function pickGongfaBonusName(fn: GongfaSpecialEffect): string {
  for (const e of fn.battleEffects) {
    if ("scalingStat" in e && e.scalingStat) {
      return PRIMARY_STAT_KEY_TO_ZH[e.scalingStat];
    }
  }
  return pickRandomBonusName();
}

/**
 * 将一条 {@link TraitEffect} 解析为可写入主角的聚合结果。
 *
 * 涉及随机 roll（法宝词条、功法效果、丹药数值、命名）均在此时一次性结算，
 * 调用方（`Protagonist.fromFateChoice`）通常只在开局调用一次。
 *
 * @param effect 天赋效果。
 * @returns 聚合结果（items / statBonus / spiritStones）。
 */
export function resolveTraitEffect(effect: TraitEffect, realmMajor?: string): ResolvedTraitEffect {
  const empty: ResolvedTraitEffect = { items: [], statBonus: {}, spiritStones: 0 };

  switch (effect.kind) {
    case "spiritStones":
      return { ...empty, spiritStones: Math.max(0, Math.floor(effect.count)) };

    case "materials": {
      const count = Math.max(1, Math.floor(effect.count));
      const entry = pickRandom(MATERIAL_NAME_TABLE[effect.grade] ?? MATERIAL_NAME_TABLE.下品);
      const item: MaterialItemDefinition = {
        itemType: "材料",
        name: entry.name,
        desc: entry.desc,
        grade: effect.grade,
        count,
        tier: rollItemTier(realmMajor),
      };
      return { ...empty, items: [item] };
    }

    case "elixir": {
      const count = Math.max(1, Math.floor(effect.count));
      const entry = ELIXIR_NAME_TABLE[effect.effectType]?.[effect.grade];
      const tier = rollItemTier(realmMajor);
      const value = rollElixirValue(effect.effectType, effect.grade, tier);
      const isPercent = isElixirPercent(effect.effectType, effect.grade);
      const item: ElixirItemDefinition = {
        itemType: "丹药",
        name: entry?.name ?? "未命名丹药",
        desc: entry?.desc ?? "",
        grade: effect.grade,
        count,
        effectType: effect.effectType,
        effects: { value, isPercent },
        tier,
      };
      return { ...empty, items: [item] };
    }

    case "statBonus":
      return { ...empty, statBonus: { ...effect.stats } };

    case "treasure": {
      const grade = effect.grade;
      const tier = rollItemTier(realmMajor);
      const fn = rollTreasureFunction(grade, tier);
      const se = rollTreasureSpecialEffect(grade);
      // 仙品 / 神品：取命名法宝的 name/intro；其余品阶用通用命名池。
      const nameDesc = se != null
        ? { name: se.name, desc: se.intro }
        : pickRandom(GENERIC_TREASURE_NAME_TABLE[grade] ?? GENERIC_TREASURE_NAME_TABLE.下品);
      const item: TreasureItemDefinition = {
        itemType: "法宝",
        name: nameDesc.name,
        desc: nameDesc.desc,
        grade,
        tier,
        count: 1,
        function: fn,
        ...(se != null ? { specialEffect: se } : {}),
      };
      return { ...empty, items: [item] };
    }

    case "gongfa": {
      const grade = effect.grade;
      const fn = rollGongfaFunction(effect.system, grade);
      // 根据战斗效果的 scalingStat 决定属性加成；效果无属性加成时回退随机。
      const bonusName = pickGongfaBonusName(fn);
      const bonus = { [bonusName]: rollGradeAttriValue(bonusName, grade, GONGFA_GRADE_ATTRI_TABLE) };
      const item: GongfaItemDefinition = {
        itemType: "功法",
        name: fn.name,
        desc: fn.intro,
        grade,
        count: 1,
        bonus,
        system: effect.system,
        mastery: 1,
        function: fn,
      };
      return { ...empty, items: [item] };
    }
  }
}

// ---------------------------------------------------------------------------
// 展示文案（供 TraitDetailModal 等UI使用）
// ---------------------------------------------------------------------------

/**
 * 生成天赋效果的中文展示文案（说明类别与量级，不含随机 roll 结果）。
 *
 * @param effect 天赋效果；为空时返回空串。
 * @returns 展示文案。
 */
export function describeTraitEffect(effect: TraitEffect | undefined | null): string {
  if (!effect) return "";
  switch (effect.kind) {
    case "spiritStones":
      return `开局获得 ${effect.count} 灵石`;
    case "materials":
      return `开局获得 ${effect.grade}材料 ×${effect.count}`;
    case "elixir": {
      const name = ELIXIR_NAME_TABLE[effect.effectType]?.[effect.grade]?.name ?? effect.effectType;
      return `开局获得 ${effect.grade}丹药「${name}」×${effect.count}`;
    }
    case "statBonus": {
      const parts = Object.entries(effect.stats).map(
        ([k, v]) => `${PRIMARY_STAT_KEY_TO_ZH[k as PrimaryStatKey] ?? k}+${v}`,
      );
      return `主属性加成：${parts.join("、")}`;
    }
    case "treasure": {
      const named = effect.grade === "仙品" || effect.grade === "神品";
      return `开局获得一把${effect.grade}法宝`;
    }
    case "gongfa":
      return `开局获得一本${effect.system}·${effect.grade}功法`;
  }
}
