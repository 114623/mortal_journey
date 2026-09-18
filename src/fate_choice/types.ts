/**
 * 命运抉择：类型定义 + 开局静态配置（出身、性别、灵根随机、词条稀有度权重）。
 * 与 `mortal_journey/js/data/mjCreationConfig.js` 等对齐。
 */

import type { TraitRarity } from "./traits";
import type { TraitEffect } from "./traitEffect";
import type { WorldLocation } from "../role_core/types/worldLocation";

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

/** 叙事人称（第几人称）。 */
export type NarrationPerson = "first" | "second" | "third";

/** 难度等级。 */
export type DifficultyLevel = "简单" | "正常" | "困难";

/** 难度选项（UI 展示用）。 */
export interface DifficultyOption {
  key: DifficultyLevel;
  title: string;
  desc: string;
}

/** 难度选项列表。 */
export const DIFFICULTY_OPTIONS: readonly DifficultyOption[] = [
  { key: "简单", title: "简单", desc: "休闲模式。主角和同伴都不会真正死亡，也没有寿命压力，可以慢慢修炼、安心探索。" },
  { key: "正常", title: "正常", desc: "标准体验。寿命有限，要赶在寿元耗尽前突破境界；主角和同伴都可能战死，一步走错就可能万劫不复。" },
  { key: "困难", title: "困难", desc: "硬核挑战。在正常的基础上，你遇到的修士都远比常人强大，步步凶险，适合追求挑战的玩家。" },
] as const;

/** 出身定义：`location` 为四級地点，`desc` 为简介（卡片与开局摘要）。 */
export interface BirthDefinition {
  location: WorldLocation;
  desc: string;
}

/** 轮盘上一格天赋（共五条）。 */
export interface FateChoiceTrait {
  name: string;
  rarity: string;
  desc: string;
  /** 具体效果；开局时由 `Protagonist.fromFateChoice` 结算。 */
  effect?: TraitEffect;
}

/**
 * 自定义出身表单提交结构（仅 UI / 内部状态用，不直接作为最终结果字段）。
 */
export interface CustomBirthPayload {
  tag: string;
  name: string;
  location: WorldLocation;
  realmMajor: string;
  realmMinor: string | null;
  realmText: string;
  background: string;
  presetBirthKey?: string;
}

// ---------------------------------------------------------------------------
// 结果接口
// ---------------------------------------------------------------------------

/**
 * 基础信息：姓名、人称、境界、出生地、出身叙述、灵根元素等。
 */
export interface FateChoiceBasics {
  /** 姓名 */
  playerName: string;
  /** 第几人称（叙事视角） */
  narrationPerson: NarrationPerson;
  /** 性别 */
  gender: string;
  /** 大境界 */
  realmMajor: string;
  /** 小境界（初期 / 中期 / 后期）；与所有大境界一致 */
  realmMinor: string | null;
  /** 出生地（四级地点） */
  birthPlace: WorldLocation;
  /**
   * 出身信息：预设出身时为卡片说明与地点描述等合并文案；自定义出身时为填写的背景长文。
   */
  originStory: string;
  /**
   * 灵根五行元素列表。
   */
  linggen: string[];
  /** 难度等级。 */
  difficulty: DifficultyLevel;
}

/**
 * 命运抉择完成后的唯一结果类型：`basics` + 五个 `traits`。
 */
export interface FateChoiceResult {
  basics: FateChoiceBasics;
  traits: FateChoiceTrait[];
}

// ---------------------------------------------------------------------------
// 境界与灵根常量
// ---------------------------------------------------------------------------

/** 默认起始大境界。 */
export const START_REALM_MAJOR = "练气";

/** 默认起始小阶段。 */
export const START_REALM_STAGE = "初期";

/** 自定义出身可选大境界列表。 */
export const CUSTOM_REALM_MAJORS = ["凡人", "练气", "筑基", "结丹", "元婴", "化神"] as const;

/** 自定义出身可选小阶段列表。 */
export const CUSTOM_REALM_MINORS = ["初期", "中期", "后期"] as const;

/** 灵根类型前缀，用于从 `rollRandomLinggenName()` 结果中剥掉前缀只保留元素。 */
export const LINGGEN_TYPE_PREFIXES: ReadonlySet<string> = new Set(["天灵根", "真灵根", "伪灵根", "无灵根"]);

export const LINGGEN_ELEMENT_POOL: readonly string[] = ["金", "木", "水", "火", "土"];

/**
 * 灵根元素效果对照表。
 *
 * | 元素 | 效果         |
 * | ---- | ------------ |
 * | 金   | 提升暴击伤害 |
 * | 木   | 提升丹药效果 |
 * | 水   | 提升技能冷却速度 |
 * | 火   | 提升恢复效果 |
 * | 土   | 提高护盾效果 |
 */
export const LINGGEN_ELEMENT_EFFECTS: Readonly<Record<string, string>> = {
  金: "提升暴击伤害",
  木: "提升丹药效果",
  水: "提升功法冷却速度",
  火: "提升恢复效果",
  土: "提升护盾效果",
};


// ---------------------------------------------------------------------------
// 出身配置
// ---------------------------------------------------------------------------

export const CREATION_GENDERS = ["男性", "女性"] as const;

export const CREATION_BIRTHS: Readonly<Record<string, BirthDefinition>> = {
  黄枫谷弟子: {
    location: { region: "天南", country: "越国", area: "黄枫谷", detail: "外门" },
    desc: "出身于越国七大宗门之一的黄枫谷外门，以剑修传承闻名，门规严谨。",
  },
  乱星海散修: {
    location: { region: "乱星海", country: "魁星岛", area: "天都街", detail: "街道" },
    desc: "出身在乱星海，资源多被大小宗门与星宫势力把持。你无依无靠，灵石、丹药、功法皆需自行挣取，或冒险猎妖，或接取散修任务，稍有不慎便是身死道消。",
  }
};

// ---------------------------------------------------------------------------
// 词条稀有度权重
// ---------------------------------------------------------------------------

/** 词条随机时「先抽稀有度」所用的权重行。 */
export interface TraitRarityWeightRow {
  rarity: TraitRarity;
  weight: number;
}

/** 命运抉择随机词条：各稀有度权重（与主工程分布意图一致）。 */
export const TRAIT_RARITY_WEIGHTS: readonly TraitRarityWeightRow[] = [
  { rarity: "平庸", weight: 40 },
  { rarity: "普通", weight: 25 },
  { rarity: "稀有", weight: 15 },
  { rarity: "史诗", weight: 10 },
  { rarity: "传说", weight: 6 },
  { rarity: "神迹", weight: 4 },
];

// ---------------------------------------------------------------------------
// 灵根随机函数
// ---------------------------------------------------------------------------

/**
 * 与主工程 `rollRandomLinggenName` 相同分布：天灵根 / 真灵根 / 伪灵根 + 元素组合。
 */
export function rollRandomLinggenName(): string {
  const pool = [...LINGGEN_ELEMENT_POOL];
  const r = Math.random() * 100;
  let count: number;
  let type: string;
  if (r < 20) {
    count = 1;
    type = "天灵根";
  } else if (r < 40) {
    count = 2;
    type = "真灵根";
  } else if (r < 60) {
    count = 3;
    type = "真灵根";
  } else {
    count = 4;
    type = "伪灵根";
  }
  const bag = pool.slice();
  const elements: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * bag.length);
    elements.push(bag.splice(idx, 1)[0]!);
  }
  return type + " " + elements.join(", ");
}
