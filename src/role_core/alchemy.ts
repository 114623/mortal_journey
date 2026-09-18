/**
 * @fileoverview 炼丹系统：纯逻辑（无副作用、不触碰库存）。
 *
 * 规则：
 *   - 投入 3 份「材料」，每份材料为其品阶投 1/3 权重，加权随机出丹药品阶。
 *     例：3 份下品 → 100% 下品；2 份下品 + 1 份中品 → 约 66.7% 下品 / 33.3% 中品。
 *   - **三份材料的阶层必须一致**：某阶层的材料只能炼出本阶层的物品。
 *     阶层冲突时 `craftElixirDef` 返回 `null`（调用方应拒绝开炉，不扣材料）。
 *   - 丹药效果类型按 {@link ELIXIR_EFFECT_WEIGHTS} 随机（恢复类高权重）。
 *   - 效果数值由 {@link ELIXIR_GRADE_EFFECT_TABLE} 按品阶查表，再按材料阶层缩放。
 *   - 丹药名称/简介查 {@link ELIXIR_NAME_TABLE}（72 条独立命名）。
 *   - 100% 出丹，无失败。
 */

import type { ItemGrade } from "./types/itemInfo";
import type { ElixirItemDefinition, ElixirEffectType } from "./types/elixir";
import type { ItemTier } from "./types/itemTier";
import { resolveItemTier, tierLabel } from "./types/itemTier";
import {
  rollElixirEffectType,
  rollElixirValue,
  isElixirPercent,
  parseElixirEffectType,
} from "./types/elixir";

/** 品阶固定枚举（与 ItemGrade 一致，但保证顺序用于遍历）。 */
export const ALCHEMY_GRADES: readonly ItemGrade[] = [
  "下品", "中品", "上品", "极品", "仙品", "神品",
];

/**
 * 加权随机出丹药品阶：每个材料为其品阶投 1/3 权重。
 *
 * @param grades 三份材料的品阶数组（长度任意，但炼丹调用方固定传 3）。
 * @returns 加权随机得到的品阶；输入为空时回退为「下品」。
 */
export function rollAlchemyGrade(grades: readonly ItemGrade[]): ItemGrade {
  if (grades.length === 0) return "下品";
  const weight: Record<ItemGrade, number> = {
    下品: 0, 中品: 0, 上品: 0, 极品: 0, 仙品: 0, 神品: 0,
  };
  for (const g of grades) {
    if (g in weight) weight[g] += 1;
  }
  const total = grades.length;
  let roll = Math.random() * total;
  for (const g of ALCHEMY_GRADES) {
    roll -= weight[g];
    if (roll <= 0) return g;
  }
  return "下品";
}

/**
 * 计算品阶分布概率（百分比，保留 1 位小数）。用于 UI 预览。
 */
export function computeAlchemyGradeOdds(grades: readonly ItemGrade[]): { grade: ItemGrade; percent: number }[] {
  if (grades.length === 0) return [];
  const weight: Record<ItemGrade, number> = {
    下品: 0, 中品: 0, 上品: 0, 极品: 0, 仙品: 0, 神品: 0,
  };
  for (const g of grades) {
    if (g in weight) weight[g] += 1;
  }
  const total = grades.length;
  return ALCHEMY_GRADES
    .filter((g) => weight[g] > 0)
    .map((g) => ({ grade: g, percent: Math.round((weight[g] / total) * 1000) / 10 }));
}

/**
 * 默认丹药命名表：12 效果 × 6 品阶 = 72 条独立命名 + 简介。
 */
export const ELIXIR_NAME_TABLE: Readonly<Record<ElixirEffectType, Readonly<Record<ItemGrade, { name: string; desc: string }>>>> = {
  "恢复血量": {
    下品: { name: "回血丹",   desc: "寻常草药炼制的低阶丹药，服之可缓慢回复少许气血。" },
    中品: { name: "止血丹",   desc: "能迅速止住外伤出血、稳固气血的中阶丹药。" },
    上品: { name: "续命丹",   desc: "吊命续息的珍丹，可使重伤垂危之人重获生机。" },
    极品: { name: "小还丹",   desc: "固本培元的名丹，服后大补气血、复原伤势。" },
    仙品: { name: "九转还丹", desc: "经九转炼成的仙丹，起死回生、瞬回满血。" },
    神品: { name: "太乙神丹", desc: "太乙真君所传神丹，可令枯骨生肉、生死人肉白骨。" },
  },
  "恢复法力": {
    下品: { name: "凝气散",   desc: "散剂初阶丹方，能稍聚天地灵气补充法力。" },
    中品: { name: "回灵丹",   desc: "回转灵力所用，可较快恢复损耗的法力。" },
    上品: { name: "聚灵丹",   desc: "上品灵丹，聚四方灵气入体，大幅补益法力。" },
    极品: { name: "凝元丹",   desc: "凝结天地元气所成，服之令法力充盈。" },
    仙品: { name: "玄灵仙丹", desc: "仙人所赐玄妙仙丹，须臾之间法力如潮。" },
    神品: { name: "混元神丹", desc: "蕴含混元之力的神丹，法力绵绵不绝、用之不竭。" },
  },
  "提升修为": {
    下品: { name: "辟谷丹",   desc: "助人清心辟谷的低阶丹药，略增修为。" },
    中品: { name: "筑基丹",   desc: "筑基修士常用，可助凝练真元、增益修为。" },
    上品: { name: "凝煞丹",   desc: "凝炼天地煞气所成，能显著增进修为。" },
    极品: { name: "结金丹",   desc: "助力凝结金丹的珍药，修为大涨。" },
    仙品: { name: "元婴丹",   desc: "蕴养元婴的仙丹，服之一粒抵数十年苦修。" },
    神品: { name: "造化神丹", desc: "夺天地造化的神丹，一步登天、修为暴涨。" },
  },
  "提升寿元": {
    下品: { name: "延寿丹",   desc: "以草药炼制的延年丹药，可延寿数载。" },
    中品: { name: "益寿丹",   desc: "益寿延年的中阶丹药，固本培元、添寿一纪。" },
    上品: { name: "驻颜丹",   desc: "驻颜不老的上品丹药，常服可延寿百年。" },
    极品: { name: "长生丹",   desc: "长生久视的极品丹药，服之寿元大增。" },
    仙品: { name: "松鹤仙丹", desc: "仙家秘传的益寿仙丹，松鹤延年、寿逾千载。" },
    神品: { name: "与天同寿丹", desc: "与天地同寿的神丹，寿元无穷、近乎不死。" },
  },
  "提升体魄": {
    下品: { name: "锻体丹",   desc: "锻体强身的低阶丹药，略增体魄。" },
    中品: { name: "强骨丹",   desc: "强筋健骨的中阶丹药，体魄更胜从前。" },
    上品: { name: "玉骨丹",   desc: "玉骨冰肌的上品丹药，脱胎换骨。" },
    极品: { name: "龙象丹",   desc: "蕴含龙象之力的极品丹药，体魄霸悍。" },
    仙品: { name: "玄武仙丹", desc: "玄武之灵淬炼的仙丹，体若神兽。" },
    神品: { name: "盘古神丹", desc: "盘古血脉所凝神丹，肉身成圣。" },
  },
  "提升灵力": {
    下品: { name: "凝神丹",   desc: "凝神静气的低阶丹药，略增灵力。" },
    中品: { name: "通灵丹",   desc: "通达灵台的中阶丹药，灵力渐丰。" },
    上品: { name: "蕴灵丹",   desc: "蕴养灵根的上品丹药，灵力大增。" },
    极品: { name: "天灵丹",   desc: "天地灵气所凝极品丹，灵力浑厚。" },
    仙品: { name: "太清仙丹", desc: "太清境所赐仙丹，灵力通玄。" },
    神品: { name: "元始神丹", desc: "元始天尊所炼神丹，灵力无穷。" },
  },
  "提升劲力": {
    下品: { name: "力量丹",   desc: "增添气力的低阶丹药，劲力略涨。" },
    中品: { name: "千斤丹",   desc: "一丹千斤力的中阶丹药，膂力惊人。" },
    上品: { name: "巨力丹",   desc: "增长巨力的上品丹药，力能扛鼎。" },
    极品: { name: "霸王丹",   desc: "霸王之力所凝极品丹药，劲力绝伦。" },
    仙品: { name: "力魄仙丹", desc: "凝聚力魄的仙丹，举手投足皆有千钧。" },
    神品: { name: "擎天神丹", desc: "力能擎天的神丹，一拳可碎山岳。" },
  },
  "提升护体": {
    下品: { name: "护身丹",   desc: "护身御邪的低阶丹药，略增护体。" },
    中品: { name: "铁皮丹",   desc: "皮如铁石的中阶丹药，刀枪难入。" },
    上品: { name: "金钟丹",   desc: "金钟护体的上品丹药，护体真气绵密。" },
    极品: { name: "不坏丹",   desc: "金刚不坏的极品丹药，万法难伤。" },
    仙品: { name: "金刚仙丹", desc: "金刚之身的仙丹，护体无双。" },
    神品: { name: "不灭神丹", desc: "肉身不灭的神丹，万劫不坏。" },
  },
  "提升灵御": {
    下品: { name: "御灵丹",   desc: "御散灵力的低阶丹药，略增灵御。" },
    中品: { name: "辟邪丹",   desc: "辟除邪祟的中阶丹药，灵御渐固。" },
    上品: { name: "驱魔丹",   desc: "驱魔辟邪的上品丹药，灵御大成。" },
    极品: { name: "净体丹",   desc: "净体驱邪的极品丹药，万邪不侵。" },
    仙品: { name: "菩提仙丹", desc: "菩提净体的仙丹，灵御通明。" },
    神品: { name: "万法不侵丹", desc: "万法不侵的神丹，诸邪辟易。" },
  },
  "提升神识": {
    下品: { name: "清心丹",   desc: "清心明目的低阶丹药，略增神识。" },
    中品: { name: "明目丹",   desc: "明目开光的中阶丹药，神识更广。" },
    上品: { name: "慧根丹",   desc: "开启慧根的上品丹药，神识大增。" },
    极品: { name: "天眼丹",   desc: "开天眼的极品丹药，洞察秋毫。" },
    仙品: { name: "神照仙丹", desc: "神照千里的仙丹，神识无远弗届。" },
    神品: { name: "洞明神丹", desc: "洞明万物的神丹，神识遍及四海。" },
  },
  "提升身法": {
    下品: { name: "轻身丹",   desc: "轻身如燕的低阶丹药，略增身法。" },
    中品: { name: "疾风丹",   desc: "疾如风的中阶丹药，身法矫健。" },
    上品: { name: "御风丹",   desc: "御风而行的上品丹药，身若惊鸿。" },
    极品: { name: "缩地丹",   desc: "缩地成寸的极品丹药，瞬息千里。" },
    仙品: { name: "踏云仙丹", desc: "踏云而行的仙丹，身法通神。" },
    神品: { name: "瞬移神丹", desc: "瞬移千里的神丹，来去无踪。" },
  },
  "提升悟性": {
    下品: { name: "开窍丹",   desc: "开启灵窍的低阶丹药，略增悟性。" },
    中品: { name: "顿悟丹",   desc: "助人顿悟的中阶丹药，悟性渐开。" },
    上品: { name: "悟道丹",   desc: "感悟大道的上品丹药，悟性大增。" },
    极品: { name: "明心丹",   desc: "明心见性的极品丹药，悟性超凡。" },
    仙品: { name: "菩提悟道丹", desc: "菩提树下悟道的仙丹，一念通明。" },
    神品: { name: "天道神丹", desc: "契合天道的神丹，悟性逆天。" },
  },
};

export interface AlchemyMaterialInput {
  grade: ItemGrade;
  /** 材料阶层；旧存档缺失时按品阶回退。 */
  tier?: ItemTier;
}

/** 材料阶层校验结果。 */
export interface AlchemyTierCheck {
  /** 三份材料阶层是否统一（唯一决定能否开炉的条件）。 */
  ok: boolean;
  /** 统一后的阶层（ok 为 false 时为 null）。 */
  tier: ItemTier | null;
  /** 冲突时的可读原因（UI 直接展示）。 */
  reason: string;
}

/**
 * 校验三份材料的阶层是否一致。
 *
 * 规则：某阶层的材料只能炼出本阶层的物品 —— 不同阶层的材料无法同炉，
 * 否则「练气期囤的低阶材料 + 元婴期一份高阶材料」就能白嫖高阶丹药。
 *
 * 缺失 `tier` 的旧存档按 `resolveItemTier` 依品阶回退后再比较。
 *
 * @param materials 材料输入（炼丹固定 3 份）。
 */
export function checkAlchemyTier(materials: readonly AlchemyMaterialInput[]): AlchemyTierCheck {
  if (materials.length === 0) {
    return { ok: false, tier: null, reason: "未投入材料" };
  }
  let tier: ItemTier | null = null;
  for (const m of materials) {
    const t = resolveItemTier(m.tier, m.grade);
    if (tier === null) {
      tier = t;
    } else if (tier !== t) {
      return {
        ok: false,
        tier: null,
        reason: `材料阶层不一（${tierLabel(tier)}与${tierLabel(t)}），药性相冲，无法同炉`,
      };
    }
  }
  return { ok: true, tier, reason: "" };
}

// ═══════════════════════════════════════════════════════════════════════════
// 丹药「名实相符」解析
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 丹药名 → {效果类型, 品阶} 反查索引（由 {@link ELIXIR_NAME_TABLE} 生成）。
 *
 * 用于修复「AI 起名疗伤丹，系统却随机成恢复法力」这类名实不符：
 * 命中命名表时，效果类型与品阶都由名字锁定。
 */
const NAME_TO_ELIXIR: ReadonlyMap<string, { effectType: ElixirEffectType; grade: ItemGrade }> = (() => {
  const m = new Map<string, { effectType: ElixirEffectType; grade: ItemGrade }>();
  for (const [effectType, byGrade] of Object.entries(ELIXIR_NAME_TABLE)) {
    for (const [grade, entry] of Object.entries(byGrade)) {
      m.set(entry.name, { effectType: effectType as ElixirEffectType, grade: grade as ItemGrade });
    }
  }
  return m;
})();

/**
 * 名称/简介关键词 → 效果类型。
 *
 * **顺序敏感**：更具体的词必须排在前面。
 * 例如「灵力」「法力」要先于「劲力」匹配，否则「凝神丹」会被误判成提升劲力。
 */
const ELIXIR_KEYWORD_RULES: readonly (readonly [RegExp, ElixirEffectType])[] = [
  [/血|伤|疗|创|续命|还魂|气血|生机|肉白骨/, "恢复血量"],
  [/法力|灵力|回灵|聚灵|凝气|灵气|法海|灵海/, "恢复法力"],
  [/修为|培元|凝元|结丹|元婴|化神|道行|功力/, "提升修为"],
  [/寿|延年|长生|驻颜|松鹤/, "提升寿元"],
  [/体魄|锻体|强骨|筋骨|肉身|体修|龙象|玉骨/, "提升体魄"],
  [/神识|清心|明目|慧根|天眼|神照|洞明|识海/, "提升神识"],
  [/身法|轻身|疾风|御风|缩地|踏云|瞬移|遁/, "提升身法"],
  [/悟性|开窍|顿悟|悟道|明心|菩提/, "提升悟性"],
  [/护体|护身|金钟|不坏|金刚|不灭|防御/, "提升护体"],
  [/灵御|辟邪|驱魔|净体|万法不侵|御灵/, "提升灵御"],
  [/劲力|力量|巨力|千斤|力魄|擎天|膂力|神力/, "提升劲力"],
];

/** 按关键词规则从文本推断丹药效果类型；无命中返回 null。 */
function inferElixirEffect(text: string): ElixirEffectType | null {
  if (!text) return null;
  for (const [re, effectType] of ELIXIR_KEYWORD_RULES) {
    if (re.test(text)) return effectType;
  }
  return null;
}

export interface ResolvedElixir {
  name: string;
  desc: string;
  effectType: ElixirEffectType;
  grade: ItemGrade;
}

/**
 * 解析 AI 给出的丹药，保证**名称、效果类型、品阶三者自洽**。
 *
 * 判定优先级（越靠前越可信）：
 *   0. AI 显式给出合法品阶（`pinnedGrade`）→ 名称与品阶一并尊重，效果类型按名称推断
 *   1. 名称精确命中 {@link ELIXIR_NAME_TABLE} → 锁定效果类型**与品阶**（如「回血丹」必为下品恢复血量）
 *   2. 名称关键词推断效果类型（如「疗伤丹」→ 恢复血量），品阶用随机值
 *   3. 简介关键词推断效果类型（AI 常把功效写进 intro）
 *   4. AI 显式给的 effectType
 *   5. 随机
 *
 * 只有走到 4/5 且名字没有语义指向时，才会把名字替换为命名表里的标准名。
 *
 * @param aiName AI 给出的丹药名。
 * @param aiDesc AI 给出的简介。
 * @param aiEffectTypeRaw AI 给出的 effectType（可能非法）。
 * @param rolledGrade 按境界随机出的品阶（作为回退值）。
 * @param pinnedGrade AI 显式指定且合法的品阶；存在时优先级最高。
 */
export function resolveElixirFromAi(
  aiName: string,
  aiDesc: string,
  aiEffectTypeRaw: unknown,
  rolledGrade: ItemGrade,
  pinnedGrade?: ItemGrade | null,
): ResolvedElixir {
  const name = (aiName ?? "").trim();
  const desc = (aiDesc ?? "").trim();

  // 0. AI 明确指定品阶：完全尊重，效果类型仍由名称/简介推断，保证名实相符。
  //    典型场景「花十灵石买的疗伤丹」→ 下品 + 恢复血量，而不是摇成神品回法力丹。
  if (pinnedGrade) {
    const exact = NAME_TO_ELIXIR.get(name);
    const effectType =
      exact?.effectType ??
      inferElixirEffect(name) ??
      inferElixirEffect(desc) ??
      (typeof aiEffectTypeRaw === "string" && aiEffectTypeRaw.trim()
        ? parseElixirEffectType(aiEffectTypeRaw)
        : rollElixirEffectType());
    return { name: name || "未命名丹药", desc, effectType, grade: pinnedGrade };
  }

  // 1. 命名表精确命中：效果与品阶一并锁定
  const exact = NAME_TO_ELIXIR.get(name);
  if (exact) {
    const entry = ELIXIR_NAME_TABLE[exact.effectType][exact.grade];
    return {
      name,
      desc: desc || entry.desc,
      effectType: exact.effectType,
      grade: exact.grade,
    };
  }

  // 2~3. 关键词推断（名称优先于简介）
  const inferred = inferElixirEffect(name) ?? inferElixirEffect(desc);
  if (inferred) {
    return { name: name || "未命名丹药", desc, effectType: inferred, grade: rolledGrade };
  }

  // 4~5. 采用 AI 的 effectType 或随机；名字换成命名表标准名，避免名实不符
  const effectType: ElixirEffectType =
    typeof aiEffectTypeRaw === "string" && aiEffectTypeRaw.trim()
      ? parseElixirEffectType(aiEffectTypeRaw)
      : rollElixirEffectType();
  const entry = ELIXIR_NAME_TABLE[effectType][rolledGrade];
  return {
    name: name && name !== "未命名物品" ? name : entry.name,
    desc: desc || entry.desc,
    effectType,
    grade: rolledGrade,
  };
}

/**
 * 炼丹核心：根据 3 份材料产出丹药定义（不写入库存）。
 *
 * 流程：checkAlchemyTier → rollAlchemyGrade → rollElixirEffectType → 查名表
 *       → rollElixirValue（按材料阶层缩放）→ 组装（丹药继承材料阶层）。
 *
 * @param materials 材料输入（调用方应保证长度为 3）。
 * @returns 完整的丹药物品定义（count = 1）；材料阶层冲突时返回 `null`。
 */
export function craftElixirDef(materials: readonly AlchemyMaterialInput[]): ElixirItemDefinition | null {
  const tierCheck = checkAlchemyTier(materials);
  if (!tierCheck.ok || !tierCheck.tier) return null;
  const tier = tierCheck.tier;

  const grades = materials.map((m) => m.grade);
  const grade = rollAlchemyGrade(grades);
  const effectType: ElixirEffectType = rollElixirEffectType();
  const value = rollElixirValue(effectType, grade, tier);
  const isPercent = isElixirPercent(effectType, grade);
  const entry = ELIXIR_NAME_TABLE[effectType][grade];

  return {
    itemType: "丹药",
    name: entry.name,
    desc: entry.desc,
    grade,
    count: 1,
    effectType,
    effects: { value, isPercent },
    tier,
  };
}
