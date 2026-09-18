/**
 * @fileoverview 凡人阶层专属图鉴：十件凡人兵器 + 十门凡人武功。
 *
 * 定位：**不入修行的凡俗之物**。铁匠铺打得出来、武馆里教得会，凡人拿着能救命，
 * 但一旦引气入体（练气）就只剩一成威能，到了筑基更是彻底废掉——
 * 这正是「凡人期随便用，入门即换装」的设计落点。
 *
 * 衰减速算见 `itemTier.mortalTierFactor`：
 *   - 使用者为凡人（同阶）  → 100%
 *   - 使用者为练气（高1阶） → 10%
 *   - 使用者为筑基及以上    → 0%（完全失效）
 *
 * 数值口径（与常规物品不同，务必注意）：
 * 凡人阶**不走 `TIER_MULT` 缩放**。凡人倍率是 0.25，若按常规流程缩放，
 * 所有词条都会被压到 1% 而无法区分强弱。故此处直接写定最终数值，
 * 强弱差异靠词条本身表达。天道编辑里点「同步重算数值」会把它们重新按
 * 凡人倍率缩放（全部塌成 1%），属预期行为，改完手工调回即可。
 */

import type { ItemGrade } from "./itemInfo";
import type { TreasureItemDefinition, TreasureModifier } from "./treasure";
import { TREASURE_MODIFIER_NAMES } from "./treasure";
import type { GongfaItemDefinition, GongfaSystem, GongfaRole } from "./gongfa";
import { rollGongfaFunction } from "./gongfa";

/** 凡人阶固定阶层常量。 */
export const MORTAL_TIER = "凡人" as const;

// ═══════════════════════════════════════════════════════════════════════════
// 一、凡人兵器（法宝 · 凡人阶）
// ═══════════════════════════════════════════════════════════════════════════

interface MortalWeaponTemplate {
  name: string;
  desc: string;
  grade: ItemGrade;
  modifiers: readonly TreasureModifier[];
}

const MORTAL_WEAPON_TEMPLATES: readonly MortalWeaponTemplate[] = [
  {
    name: "镔铁砍刀",
    desc: "猎户常备的厚背砍刀，刀口崩了三处，劈柴断骨却格外称手。",
    grade: "下品",
    modifiers: [
      { modifierType: "physDamageDealt", value: 4 },
      { modifierType: "damageDealt", value: 2 },
    ],
  },
  {
    name: "桑木猎弓",
    desc: "老桑木弯成的猎弓，弓弦是揉熟的牛筋，射得远却拉不满百步。",
    grade: "下品",
    modifiers: [
      { modifierType: "physDamageDealt", value: 3 },
      { modifierType: "critRate", value: 3 },
    ],
  },
  {
    name: "熟铜齐眉棍",
    desc: "一根熟铜棍，立起来正好齐眉，舞开了密不透风，是走镖的看家家伙。",
    grade: "下品",
    modifiers: [
      { modifierType: "damageTaken", value: 2 },
      { modifierType: "physDamageDealt", value: 2 },
    ],
  },
  {
    name: "百炼精钢剑",
    desc: "寻常铁匠反复折叠锻打的长剑，剑身泛青，斩得开牛皮，斩不开灵器。",
    grade: "中品",
    modifiers: [
      { modifierType: "physDamageDealt", value: 5 },
      { modifierType: "physDefensePenetration", value: 3 },
    ],
  },
  {
    name: "柳叶飞刀",
    desc: "十二把薄如柳叶的小刀，藏在袖中，出手极快，却也只够放倒几个泼皮。",
    grade: "下品",
    modifiers: [
      { modifierType: "speed", value: 4 },
      { modifierType: "critRate", value: 2 },
    ],
  },
  {
    name: "生铁包边盾",
    desc: "木板外包一层生铁的圆盾，沉得很，挡得住刀斧，挡不住术法。",
    grade: "下品",
    modifiers: [
      { modifierType: "damageTaken", value: 3 },
      { modifierType: "physDamageTaken", value: 3 },
    ],
  },
  {
    name: "三股猎叉",
    desc: "猎虎用的三股钢叉，叉尖带倒钩，扎进去便拔不出来。",
    grade: "中品",
    modifiers: [
      { modifierType: "physDamageDealt", value: 4 },
      { modifierType: "lifesteal", value: 2 },
    ],
  },
  {
    name: "牛筋软鞭",
    desc: "牛筋编就的九节软鞭，抽在身上留不下伤，却能缠得人动弹不得。",
    grade: "下品",
    modifiers: [
      { modifierType: "speed", value: 3 },
      { modifierType: "dodgeRate", value: 3 },
    ],
  },
  {
    name: "开山短斧",
    desc: "砍柴人用的短柄斧，斧刃厚钝，靠的是劈下来的那股蛮劲。",
    grade: "中品",
    modifiers: [
      { modifierType: "physDamageDealt", value: 5 },
      { modifierType: "critDmg", value: 6 },
    ],
  },
  {
    name: "镔铁双尺",
    desc: "一对镔铁短尺，本是衙门捕快锁人的家伙，使熟了也能点穴卸骨。",
    grade: "下品",
    modifiers: [
      { modifierType: "defensePenetration", value: 3 },
      { modifierType: "dodgeRate", value: 2 },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 二、凡人武功（功法 · 凡人阶）
// ═══════════════════════════════════════════════════════════════════════════

interface MortalMartialArtTemplate {
  name: string;
  desc: string;
  grade: ItemGrade;
  /** 主属性加成（中文名 → 数值）。 */
  bonus: Record<string, number>;
  system: GongfaSystem;
  role: GongfaRole;
}

const MORTAL_MARTIAL_ART_TEMPLATES: readonly MortalMartialArtTemplate[] = [
  {
    name: "铁牛耕桩功",
    desc: "乡间武师传下的蹲桩法子，日日扎马步，扎得双腿如生根，只是与引气入体毫无干系。",
    grade: "下品",
    bonus: { 体魄: 3 },
    system: "体修",
    role: "辅助",
  },
  {
    name: "劈山掌法",
    desc: "走镖汉子们练的硬掌，掌缘磨出厚茧，拍下去能断砖，却拍不散一丝灵气。",
    grade: "下品",
    bonus: { 劲力: 3 },
    system: "体修",
    role: "攻击",
  },
  {
    name: "游龙步法",
    desc: "江湖卖艺人的身法，绕桩穿花、进退如蛇，用来躲拳脚尚可，躲不得飞剑。",
    grade: "下品",
    bonus: { 身法: 2 },
    system: "通用",
    role: "辅助",
  },
  {
    name: "听风辨位术",
    desc: "夜间行路练出的耳力，闭着眼也能听出暗处有几个人，却听不出灵力波动。",
    grade: "下品",
    bonus: { 神识: 2 },
    system: "通用",
    role: "辅助",
  },
  {
    name: "吐纳养气功",
    desc: "老道人教村夫的吐纳法，只养得一口浊气，讲不上什么灵机造化。",
    grade: "下品",
    bonus: { 灵力: 3 },
    system: "通用",
    role: "辅助",
  },
  {
    name: "金钟罩体功",
    desc: "江湖把式，以木棍日日排打周身，皮糙肉厚，挨得起拳脚，挨不起法器。",
    grade: "中品",
    bonus: { 护体: 3 },
    system: "体修",
    role: "辅助",
  },
  {
    name: "灵台澄心术",
    desc: "静坐数息的粗浅法子，能教人心思清明，终究不是观照灵台的功夫。",
    grade: "下品",
    bonus: { 悟性: 2 },
    system: "通用",
    role: "辅助",
  },
  {
    name: "御风卸力诀",
    desc: "卸力的巧劲，顺着来势一带便化开大半，偏生化不开半分灵压。",
    grade: "下品",
    bonus: { 灵御: 2 },
    system: "通用",
    role: "辅助",
  },
  {
    name: "缠丝擒拿法",
    desc: "捕快锁人的手法，讲究以柔缠刚，扣住关节便挣不脱——对修士却无处可扣。",
    grade: "中品",
    bonus: { 劲力: 3 },
    system: "体修",
    role: "攻击",
  },
  {
    name: "崩山斧法",
    desc: "樵夫砍柴悟出的三斧，一劈二撩三崩，势大力沉，只是斧下再无山可崩。",
    grade: "中品",
    bonus: { 劲力: 4 },
    system: "体修",
    role: "攻击",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 三、工厂
// ═══════════════════════════════════════════════════════════════════════════

/** 凡人兵器模板名列表（只读）。 */
export const MORTAL_WEAPON_NAMES: readonly string[] =
  MORTAL_WEAPON_TEMPLATES.map((t) => t.name);

/** 凡人武功模板名列表（只读）。 */
export const MORTAL_MARTIAL_ART_NAMES: readonly string[] =
  MORTAL_MARTIAL_ART_TEMPLATES.map((t) => t.name);

/**
 * 随机取一件凡人兵器。
 *
 * @param grade 覆盖品阶；缺省用模板自带品阶。
 * @param name 指定名称；缺省随机。用于让 AI 点名的兵器落到图鉴上。
 */
export function rollMortalWeapon(
  grade?: ItemGrade,
  name?: string,
): TreasureItemDefinition {
  const tpl = pickTemplate(MORTAL_WEAPON_TEMPLATES, name);
  const g = grade ?? tpl.grade;
  const modifiers: TreasureModifier[] = tpl.modifiers.map((m) => ({ ...m }));
  return {
    itemType: "法宝",
    name: tpl.name,
    desc: tpl.desc,
    grade: g,
    tier: MORTAL_TIER,
    count: 1,
    function: {
      name: modifiers.map((m) => `${TREASURE_MODIFIER_NAMES[m.modifierType]}+${m.value}%`).join(" "),
      modifiers,
    },
  };
}

/**
 * 随机取一门凡人武功。
 *
 * @param grade 覆盖品阶；缺省用模板自带品阶。
 * @param name 指定名称；缺省随机。
 */
export function rollMortalMartialArt(
  grade?: ItemGrade,
  name?: string,
): GongfaItemDefinition {
  const tpl = pickTemplate(MORTAL_MARTIAL_ART_TEMPLATES, name);
  const g = grade ?? tpl.grade;
  return {
    itemType: "功法",
    name: tpl.name,
    desc: tpl.desc,
    grade: g,
    tier: MORTAL_TIER,
    count: 1,
    bonus: { ...tpl.bonus },
    system: tpl.system,
    role: tpl.role,
    mastery: 1,
    masteryExp: 0,
    function: rollGongfaFunction(tpl.system, g, tpl.role),
  };
}

/**
 * 判断一个物品名是否属于凡人图鉴（用于保底：AI 给了凡人阶物品却没给名字时，
 * 也能落回图鉴，避免出现「未命名法宝」）。
 */
export function isMortalWeaponName(name: string): boolean {
  return MORTAL_WEAPON_NAMES.includes(name);
}

export function isMortalMartialArtName(name: string): boolean {
  return MORTAL_MARTIAL_ART_NAMES.includes(name);
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════════════════════════════════════════

function pickTemplate<T extends { name: string }>(pool: readonly T[], name?: string): T {
  if (name) {
    const hit = pool.find((t) => t.name === name);
    if (hit) return hit;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}
