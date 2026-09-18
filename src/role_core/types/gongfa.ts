import type { ItemBonusMap, ItemGrade } from "./itemInfo";
import type { PrimaryStatKey } from "./playInfo";
import { PRIMARY_STAT_KEY_TO_ZH } from "./playInfo";
import type { ItemTier } from "./itemTier";

export type GongfaScalingStat = PrimaryStatKey;

// ═══════════════════════════════════════════════════════════════════════════
// 功法体系
// ═══════════════════════════════════════════════════════════════════════════

export const GONGFA_SYSTEM_KEYS = [
  "通用",
  "剑修",
  "体修",
  "法修",
  "毒修",
  "药修",
  "魔修",
] as const;
export type GongfaSystem = (typeof GONGFA_SYSTEM_KEYS)[number];

// ═══════════════════════════════════════════════════════════════════════════
// 层级数值系统
// 目录中写 [第1层, 第10层]，运行时线性插值生成 10 层
// ═══════════════════════════════════════════════════════════════════════════

export type LayerEndpoints = readonly [number, number];
export type LayerValue = number | LayerEndpoints;

export function expandTo10(endpoints: LayerEndpoints): readonly number[] {
  const [a, b] = endpoints;
  const result: number[] = [];
  for (let i = 0; i < 10; i++) {
    result.push(Math.round(a + (b - a) * i / 9));
  }
  return result;
}

export function atLayer(val: LayerValue, layer: number): number {
  if (typeof val === "number") return val;
  const arr = val.length === 2 ? expandTo10(val) : val;
  const idx = Math.max(0, Math.min(layer - 1, arr.length - 1));
  return arr[idx];
}

function expandTo10Float(endpoints: LayerEndpoints): readonly number[] {
  const [a, b] = endpoints;
  const result: number[] = [];
  for (let i = 0; i < 10; i++) {
    result.push(a + (b - a) * i / 9);
  }
  return result;
}

export function atLayerFloat(val: LayerValue, layer: number): number {
  if (typeof val === "number") return val;
  const arr = val.length === 2 ? expandTo10Float(val) : val;
  const idx = Math.max(0, Math.min(layer - 1, arr.length - 1));
  return arr[idx];
}

// ═══════════════════════════════════════════════════════════════════════════
// 功法战斗效果 — 与 battle_engine SkillEffect 一一对应
// 数值字段支持 [第1层, 第10层] 插值
//
// type 字段中文含义速查：
//   dealDamage        造成物理/法术伤害          value = baseValue + scalingRatio×scalingStat
//   dealDamageExecute 斩杀伤害（目标血量≤threshold% 时伤害+bonusPercent%）
//   dealDamagePierce  造成真实伤害（无视防御）
//   heal              恢复生命
//   lifesteal         造成伤害并吸取 damagePercent% 生命
//   applyModifier     施加修正（增减伤/暴击/速度等），持续 duration 回合，最多叠 maxStacks 层；targetSelf=true 作用于自身
//   applyCc           施加控制（freeze冰冻/stun眩晕/fear恐惧/confusion混乱/silence沉默/taunt嘲讽）
//   applyStatus       施加持续状态（poison中毒/burn灼烧/bleed流血/hpRegen生命恢复/mpDrain法力流失）
//   shield            开局获得护盾
//   counter           受击时反击
//   reflect           反弹 percent% 受到的伤害
//   damageShare       分摊 percent% 队友受到的伤害
//   deathWard         免死护盾：致命伤害时保留 1 点生命
//   extraAction       chance 概率获得额外行动
//   gaugeManipulate   操纵行动条（value>0 增加 / value<0 减少）
//   stealth           隐匿 duration 回合
//   cleanse           净化自身所有控制与持续伤害效果
//   dispel            驱散目标所有增益效果
//   revive            复活目标并恢复 hpPercent% 生命
//   summon            召唤物，按 trigger 触发，每回合造成 summonDamage 伤害
//                      可选 scalingRatio/scalingStat：召唤伤害附加属性加成（不走 mastery 倍率）
//                      可选 countPerCast：每次施放召唤数量（按层级插值，默认1）
//   dealDamageBySummon 基于召唤物数量造成伤害，总伤害 = 单次伤害 × summonName 的当前 stacks
//   consumePoisonDamage 引爆目标身上所有中毒层数，一次性结算剩余全部伤害（真实伤害），并移除中毒
//   sacrificeHp       消耗自身 maxHp 的 percent% 生命（保留1点HP），通常配合增伤或大伤害使用
// ═══════════════════════════════════════════════════════════════════════════

export type GongfaBattleEffect =
  | { type: "dealDamage"; damageType: "physical" | "magical"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat }
  | { type: "dealDamageExecute"; damageType: "physical" | "magical"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat; threshold: number; bonusPercent: number }
  | { type: "dealDamagePierce"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat }
  | { type: "heal"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat }
  | { type: "lifesteal"; damageType: "physical" | "magical"; damagePercent: LayerValue }
  | { type: "applyModifier"; modifierType: string; value: LayerValue; duration: number; maxStacks: number; targetSelf?: boolean }
  | { type: "applyCc"; ccType: string; chance: LayerValue; duration: number }
  | { type: "applyStatus"; statusType: string; tickValue: LayerValue; isPercent: boolean; duration: number; maxStacks: number }
  | { type: "shield"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat }
  | { type: "counter"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat; duration: number }
  | { type: "reflect"; percent: LayerValue; duration: number }
  | { type: "damageShare"; percent: LayerValue; duration: number }
  | { type: "deathWard"; duration: number }
  | { type: "extraAction"; chance: number }
  | { type: "gaugeManipulate"; value: number }
  | { type: "stealth"; duration: number }
  | { type: "cleanse" }
  | { type: "dispel" }
  | { type: "revive"; hpPercent: number }
  | { type: "summon"; name: string; trigger: string; summonDamage: LayerValue; duration: number;
       scalingRatio?: LayerValue; scalingStat?: GongfaScalingStat; countPerCast?: LayerValue }
  | { type: "dealDamageBySummon"; damageType: "physical" | "magical"; baseValue: LayerValue; scalingRatio: LayerValue; scalingStat: GongfaScalingStat; summonName: string }
  | { type: "consumePoisonDamage" }
  | { type: "sacrificeHp"; percent: LayerValue }
  ;

// ═══════════════════════════════════════════════════════════════════════════
// 特殊效果
// ═══════════════════════════════════════════════════════════════════════════

export type GongfaEffectType = "主动" | "被动";

export type GongfaRole = "攻击" | "辅助";

export interface GongfaSpecialEffect {
  name: string;
  intro: string;
  battleEffects: readonly GongfaBattleEffect[];
  type: GongfaEffectType;
  mpCost: LayerValue;
  cooldown: number;
  isAoE?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 描述解析
// ═══════════════════════════════════════════════════════════════════════════

function bakeValue(
  eff: GongfaBattleEffect,
  getStat: (key: PrimaryStatKey) => number,
  masteryMult: number,
  layer: number,
): number | undefined {
  if ("baseValue" in eff && "scalingRatio" in eff && "scalingStat" in eff) {
    const bv = atLayer(eff.baseValue as LayerValue, layer);
    const sr = atLayerFloat(eff.scalingRatio as LayerValue, layer);
    const stat = getStat(eff.scalingStat);
    return Math.round((bv + sr * stat) * masteryMult);
  }
  return undefined;
}

const MODIFIER_LABELS: Record<string, string> = {
  damageDealt: "攻击伤害",
  physDamageDealt: "物理伤害",
  magDamageDealt: "法术伤害",
  damageTaken: "受到伤害",
  healReceived: "受到治疗",
  hpRecover: "生命恢复",
  mpRecover: "法力恢复",
  speed: "速度",
  critRate: "暴击率",
  critDmg: "暴击伤害",
  dodgeRate: "闪避率",
  lifesteal: "吸血",
  defensePenetration: "穿透",
  physDamageTaken: "物理减伤",
  magDamageTaken: "法术减伤",
  physDefensePenetration: "破甲",
  magDefensePenetration: "破法",
  normalAttackHpRatio: "血量附加",
  normalAttackDefRatio: "护体附加",
  normalAttackResRatio: "灵御附加",
  healOverflowToShield: "溢出转盾",
};

const STATUS_LABELS: Record<string, string> = {
  poison: "中毒",
  burn: "灼烧",
  bleed: "流血",
  hpRegen: "生命恢复",
  mpDrain: "法力流失",
};

const CC_LABELS: Record<string, string> = {
  freeze: "冰冻",
  stun: "眩晕",
  fear: "恐惧",
  confusion: "混乱",
  silence: "沉默",
  taunt: "嘲讽",
};

const DMG_TYPE_LABELS: Record<string, string> = {
  physical: "物理",
  magical: "法术",
};

function formatScaledValue(
  eff: GongfaBattleEffect,
  v: number | undefined,
  layer: number,
  showFormula: boolean = true,
): string {
  if (v == null) return "0";
  if (!showFormula) return String(v);
  if (!("baseValue" in eff) || !("scalingRatio" in eff) || !("scalingStat" in eff)) return String(v);
  const sr = atLayerFloat(eff.scalingRatio as LayerValue, layer);
  if (sr === 0) return String(v);
  const bv = atLayer(eff.baseValue as LayerValue, layer);
  const ss = (eff as { scalingStat: GongfaScalingStat }).scalingStat;
  const statLabel = PRIMARY_STAT_KEY_TO_ZH[ss] ?? ss;
  return `${v}（${bv} + ${Number(sr.toFixed(2))}×${statLabel}）`;
}

export function resolveGongfaBattleEffectDesc(
  eff: GongfaBattleEffect,
  getStat: (key: PrimaryStatKey) => number,
  masteryMult: number,
  layer: number,
  showFormula: boolean = true,
  selfByDefault: boolean = false,
  isAoE: boolean = false,
): string {
  const v = bakeValue(eff, getStat, masteryMult, layer);
  const sv = formatScaledValue(eff, v, layer, showFormula);
  const durLabel = (duration: number) =>
    selfByDefault ? "" : (duration >= 99 ? "（永久）" : `，持续${duration}回合`);

  switch (eff.type) {
    case "dealDamage": {
      const dt = DMG_TYPE_LABELS[eff.damageType] ?? "物理";
      return `造成${sv}点${isAoE ? "群体" : ""}${dt}伤害`;
    }
    case "dealDamageExecute": {
      const dt = DMG_TYPE_LABELS[eff.damageType] ?? "物理";
      return `造成${sv}点${isAoE ? "群体" : ""}${dt}伤害（目标低于${Math.round(eff.threshold * 100)}%血量时伤害+${eff.bonusPercent}%）`;
    }
    case "dealDamagePierce":
      return `造成${sv}点${isAoE ? "群体" : ""}真实伤害（无视防御）`;
    case "dealDamageBySummon": {
      const dt = DMG_TYPE_LABELS[eff.damageType] ?? "物理";
      return `基于「${eff.summonName}」数量造成${isAoE ? "群体" : ""}${dt}伤害，每柄${sv}点`;
    }
    case "consumePoisonDamage":
      return `引爆目标身上所有中毒层数，立即结算剩余全部真实伤害并移除中毒`;
    case "sacrificeHp": {
      const pct = atLayer(eff.percent, layer);
      return `消耗自身${pct}%最大生命`;
    }
    case "heal":
      return `${isAoE ? "群体" : ""}恢复${sv}点生命`;
    case "lifesteal": {
      const dt = DMG_TYPE_LABELS[eff.damageType] ?? "物理";
      const atkLabel = eff.damageType === "magical"
        ? PRIMARY_STAT_KEY_TO_ZH.perception
        : PRIMARY_STAT_KEY_TO_ZH.strength;
      const pct = atLayer(eff.damagePercent, layer);
      return `${isAoE ? "群体" : ""}造成${atkLabel}${pct}%的${dt}伤害，并恢复等量生命`;
    }
    case "applyModifier": {
      const label = MODIFIER_LABELS[eff.modifierType] ?? eff.modifierType;
      const val = atLayer(eff.value, layer);
      const sign = val > 0 ? "+" : "";
      const dur = durLabel(eff.duration);
      const stack = eff.maxStacks > 1 ? `（最多叠${eff.maxStacks}层）` : "";
      const target = isAoE
        ? (eff.targetSelf ? "全体我方" : "全体敌方")
        : ((eff.targetSelf || selfByDefault) ? "自身" : "目标");
      return `${target}${label}${sign}${val}%${dur}${stack}`;
    }
    case "applyCc": {
      const label = CC_LABELS[eff.ccType] ?? eff.ccType;
      const pct = atLayerFloat(eff.chance, layer);
      return `${isAoE ? "群体" : ""}${label}（${Math.round(pct * 100)}%概率），持续${eff.duration}回合`;
    }
    case "applyStatus": {
      const label = STATUS_LABELS[eff.statusType] ?? eff.statusType;
      const tick = atLayer(eff.tickValue, layer);
      const tickStr = eff.isPercent ? `最大生命${tick}%` : `${tick}点`;
      const stack = eff.maxStacks > 1 ? `（最多叠${eff.maxStacks}层）` : "";
      return `${isAoE ? "群体" : ""}每回合造成${tickStr}${label}伤害，持续${eff.duration}回合${stack}`;
    }
    case "shield":
      if (isAoE) return `群体获得${sv}点护盾`;
      return selfByDefault ? `开局获得${sv}点护盾` : `获得${sv}点护盾`;
    case "counter": {
      const dur = durLabel(eff.duration);
      return `受击时反击${sv}点伤害${dur}`;
    }
    case "reflect": {
      const pct = atLayer(eff.percent, layer);
      const dur = durLabel(eff.duration);
      return `反弹${pct}%受到的伤害${dur}`;
    }
    case "damageShare": {
      const pct = atLayer(eff.percent, layer);
      const dur = durLabel(eff.duration);
      return `分摊${pct}%队友受到的伤害${dur}`;
    }
    case "deathWard": {
      const dur = durLabel(eff.duration);
      return `免死护盾：致命伤害时保留1点生命${dur}`;
    }
    case "extraAction":
      return `${Math.round(eff.chance * 100)}%概率获得额外行动`;
    case "gaugeManipulate":
      return eff.value > 0 ? `行动条增加${eff.value}` : `行动条减少${Math.abs(eff.value)}`;
    case "stealth":
      return `隐匿${eff.duration}回合`;
    case "cleanse":
      return "净化自身所有控制与持续伤害效果";
    case "dispel":
      return isAoE ? "群体驱散目标所有增益效果" : "驱散目标所有增益效果";
    case "revive":
      return `复活并恢复${eff.hpPercent}%生命`;
    case "summon": {
      const baseDmg = atLayer(eff.summonDamage, layer);
      let dmgText: string;
      if (eff.scalingRatio != null && eff.scalingStat) {
        const sr = atLayerFloat(eff.scalingRatio, layer);
        const stat = getStat(eff.scalingStat);
        const totalDmg = Math.round(baseDmg + sr * stat);
        const statLabel = PRIMARY_STAT_KEY_TO_ZH[eff.scalingStat] ?? eff.scalingStat;
        dmgText = showFormula && sr !== 0
          ? `${totalDmg}（${baseDmg} + ${Number(sr.toFixed(2))}×${statLabel}）`
          : String(totalDmg);
      } else {
        dmgText = String(baseDmg);
      }
      const count = eff.countPerCast != null ? atLayer(eff.countPerCast, layer) : 1;
      const countText = count > 1 ? `${count}柄` : "";
      const durLabel = eff.duration >= 99 ? "（永久）" : `，持续${eff.duration}回合`;
      return `召唤${countText}${eff.name}，每回合造成${dmgText}点伤害${durLabel}`;
    }
  }
}

export function resolveGongfaEffectDisplay(
  fn: GongfaSpecialEffect,
  getStat: (key: PrimaryStatKey) => number,
  masteryMult: number,
  layer: number,
  cooldownReduce: number = 0,
): string {
  const parts = fn.battleEffects
    .map(e => resolveGongfaBattleEffectDesc(e, getStat, masteryMult, layer, true, fn.type === "被动", fn.isAoE === true))
    .join("；");
  const lines = [parts];
  const mp = atLayer(fn.mpCost, layer);
  if (mp > 0) lines.push(`法力消耗：${mp}`);
  if (fn.type === "主动") {
    const cd = Math.max(0, (fn.cooldown ?? 0) - cooldownReduce);
    lines.push(`冷却：${cd}回合`);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// 效果目录（按体系 × 品阶，每品阶3主动 + 1被动）
// 数值字段写 [第1层, 第10层]
// ═══════════════════════════════════════════════════════════════════════════

const GRADE_ORDER: readonly ItemGrade[] = ["下品", "中品", "上品", "极品", "仙品", "神品"];

export const GONGFA_EFFECT_CATALOG: Readonly<Record<GongfaSystem, Readonly<Record<ItemGrade, readonly GongfaSpecialEffect[]>>>> = {

  "通用": {
    "下品": [
      { name: "烈元术", intro: "上古力修一脉流传的入门杀伐之术，运转时掌心凝聚赤红元气", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [30, 500], scalingRatio: [0.5, 2.0], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "凝灵术", intro: "散修中广为流传的御气法门，可将丹田灵气凝作光弹激射而出", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [30, 500], scalingRatio: [0.5, 2.0], scalingStat: "perception" }
        ], type: "主动"
      },
      { name: "刺穿术", intro: "散修中流传的破防杀招，一击贯穿、无视防御", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "dealDamagePierce", baseValue: [20, 300], scalingRatio: [0.3, 1.2], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "定身术", intro: "散修中常见的禁制法门，中招者如陷泥沼、身不由己", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "applyCc", ccType: "stun", chance: [0.25, 0.45], duration: 1 }
        ], type: "主动"
      },
      { name: "净化术", intro: "据传源自上古净宗，施术时清辉洒落、涤荡邪秽", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "cleanse" }
        ], type: "主动"
      },
      { name: "铁壁诀", intro: "据传得自上古力修遗刻，行功时周身浮起一层淡金气罩", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "damageTaken", value: [-5, -20], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
      { name: "轻灵诀", intro: "散修身法残卷流传，运转时身轻如燕、踏风而行", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "dodgeRate", value: [3, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "裂元术", intro: "力修深修而来的杀伐之术，出招时元气炸裂如雷", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [80, 700], scalingRatio: [0.7, 2.6], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "灵爆术", intro: "御气修士深修秘术，灵气聚至极点后轰然炸开", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [80, 700], scalingRatio: [0.7, 2.6], scalingStat: "perception" }
        ], type: "主动"
      },
      { name: "斩杀术", intro: "散修杀手传承的杀伐之术，专寻破绽、一击毙命", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamageExecute", damageType: "physical", baseValue: [100, 700], scalingRatio: [0.7, 2.6], scalingStat: "strength", threshold: 0.5, bonusPercent: 50 }
        ], type: "主动"
      },
      { name: "灼烧术", intro: "南疆火修残卷所载，掌心凝聚赤焰、灼骨燃魂", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [50, 420], scalingRatio: [0.3, 1.3], scalingStat: "perception" },
          { type: "applyStatus", statusType: "burn", tickValue: [25, 260], isPercent: false, duration: 3, maxStacks: 3 }
        ], type: "主动"
      },
      { name: "封印术", intro: "据传承自上古封修，施术时万法皆寂、法术难施", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "applyCc", ccType: "silence", chance: [0.40, 0.60], duration: 2 }
        ], type: "主动"
      },
      { name: "破甲诀", intro: "上古力修遗刻所载，行功时拳劲凝于一点、无坚不摧", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "defensePenetration", value: [5, 15], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
      { name: "金刚功", intro: "据传源自上古佛修，修炼时周身浮起金灿佛光、不坏不灭", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "deathWard", duration: 99 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "斩魂术", intro: "上古力修至高杀伐秘术，出招时元气凝作一道灿白月牙", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [150, 1000], scalingRatio: [0.9, 3.2], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "爆元术", intro: "御气修士深修而来的秘术，灵元沛然爆发如江河决堤", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [150, 1000], scalingRatio: [0.9, 3.2], scalingStat: "perception" }
        ], type: "主动"
      },
      { name: "驱散术", intro: "据传得自上古净宗真传，施术时清风拂过、万法皆散", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "dispel" }
        ], type: "主动"
      },
      { name: "隐袭术", intro: "散修刺客秘传的身法门，身形没入虚空后一击穿心", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "stealth", duration: 2 },
          { type: "dealDamagePierce", baseValue: [100, 700], scalingRatio: [0.5, 1.8], scalingStat: "agility" }
        ], type: "主动"
      },
      { name: "嘲讽术", intro: "散修中常见的挑衅法门，激怒敌人使其只攻自己", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "applyCc", ccType: "taunt", chance: [0.50, 0.80], duration: 2 }
        ], type: "主动"
      },
      { name: "反击诀", intro: "上古力修遗刻所载，受击时劲气反震、以牙还牙", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "counter", baseValue: [120, 960], scalingRatio: [0.3, 1.5], scalingStat: "physique", duration: 99 }
        ], type: "被动"
      },
      { name: "神速诀", intro: "传闻承自上古风修，运转时身形如电、快逾鬼魅", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "extraAction", chance: 0.10 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "破象术", intro: "上古力修至高杀伐秘术，出招时元气化作漫天拳影", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [250, 1500], scalingRatio: [1.1, 3.8], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "万象术", intro: "太古术修传承的御气秘术，灵元化作万象轰然而出", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [250, 1500], scalingRatio: [1.1, 3.8], scalingStat: "perception" }
        ], type: "主动"
      },
      { name: "混乱术", intro: "魔道术修秘传禁制，扰乱敌心神、令其敌我不分", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "applyCc", ccType: "confusion", chance: [0.40, 0.60], duration: 2 }
        ], type: "主动"
      },
      { name: "碎元斩", intro: "上古力修至高杀伐秘术，一击碎元、无视万象防御", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "dealDamagePierce", baseValue: [120, 830], scalingRatio: [0.6, 2.2], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "噬灵术", intro: "魔道修士秘传夺气法门，黑丝缠绕、蚕食方法力", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "applyStatus", statusType: "mpDrain", tickValue: [50, 300], isPercent: false, duration: 3, maxStacks: 3 }
        ], type: "主动"
      },
      { name: "反震功", intro: "据传承自上古反震力修，受击时劲气反弹、以彼之道", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "reflect", percent: [10, 30], duration: 99 }
        ], type: "被动"
      },
      { name: "碎甲诀", intro: "上古力修遗刻所载，行功时拳劲凝破、无甲不碎", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "physDefensePenetration", value: [7, 16], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "归宗武诀", intro: "传闻承自上古万法宗主，出招时万象归一、势如天倾", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [380, 2000], scalingRatio: [1.3, 4.4], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "归宗法诀", intro: "上古万法宗真传御气秘术，灵元沛然、万法同源", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [380, 2000], scalingRatio: [1.3, 4.4], scalingStat: "perception" }
        ], type: "主动"
      },
      { name: "天诛术", intro: "传闻承自上古天罚修士，专寻破绽、天诛一击", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamageExecute", damageType: "physical", baseValue: [200, 1300], scalingRatio: [1.0, 3.2], scalingStat: "strength", threshold: 0.5, bonusPercent: 50 }
        ], type: "主动"
      },
      { name: "缚灵阵", intro: "上古封修仙家秘传，符文锁链缠绕、缚灵封法", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "applyCc", ccType: "taunt", chance: [0.50, 0.70], duration: 2 },
          { type: "applyCc", ccType: "silence", chance: [0.40, 0.60], duration: 2 }
        ], type: "主动"
      },
      { name: "还魂术", intro: "传闻为上古药修不传之秘，掌心青光一闪、可夺造化之机", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "revive", hpPercent: 50 }
        ], type: "主动"
      },
      { name: "舍生诀", intro: "传闻为上古义修所创，运转时与同道气血相连、生死与共", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "damageShare", percent: [30, 45], duration: 99 }
        ], type: "被动"
      },
      { name: "雷霆诀", intro: "传闻承自上古雷修，行功时周身雷韵流转、攻势如雷", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "physDamageDealt", value: [10, 20], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "归一武诀", intro: "据传承自太古第一位力修，出招时万道拳意归一、碎裂虚空", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [500, 2500], scalingRatio: [1.5, 5.0], scalingStat: "strength" }
        ], type: "主动"
      },
      { name: "归一法诀", intro: "太古法祖真传御气秘术，灵元化作万道、轰然归一", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [500, 2500], scalingRatio: [1.5, 5.0], scalingStat: "perception" }
        ], type: "主动"
      },
      { name: "灭世劫", intro: "太古力修至高范围禁术，灭世之力横扫寰宇、万防皆破", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "dealDamagePierce", baseValue: [150, 750], scalingRatio: [0.45, 1.6], scalingStat: "spirit" }
        ], type: "主动", isAoE: true
      },
      { name: "万咒术", intro: "太古咒修至高禁咒，万咒齐发、令敌心神崩溃", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "applyCc", ccType: "confusion", chance: [0.35, 0.55], duration: 2 },
          { type: "applyCc", ccType: "stun", chance: [0.30, 0.50], duration: 1 }
        ], type: "主动"
      },
      { name: "天锁术", intro: "太古封修至高禁制，天锁镇压、令敌行动迟滞", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "gaugeManipulate", value: -50 }
        ], type: "主动"
      },
      { name: "不灭体", intro: "据传以天道碎片淬体而成，道韵流转周身、万法不侵", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "deathWard", duration: 99 },
          { type: "reflect", percent: [20, 35], duration: 99 }
        ], type: "被动"
      },
      { name: "天罡诀", intro: "传闻承自上古天罡修，行功时天罡之韵流转、攻守相生", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "counter", baseValue: [250, 1560], scalingRatio: [0.4, 1.8], scalingStat: "agility", duration: 99 },
          { type: "applyModifier", modifierType: "dodgeRate", value: [5, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  },

  "剑修": {
    "下品": [
      { name: "御剑诀", intro: "剑修入门御剑根本法门，丹田灵力化作飞剑悬于周身，可自主御敌", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "summon", name: "飞剑", trigger: "on_turn_end", summonDamage: 0, scalingRatio: 0.5, scalingStat: "strength", countPerCast: [1, 10], duration: 99 }
        ], type: "主动"
      },
      { name: "锋锐诀", intro: "剑修磨砺剑心的入门心法，修炼后目光如炬、剑锋所指无不中的", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "critRate", value: [5, 15], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "疾风剑法", intro: "追风剑法深修而来的杀伐剑术，剑势如狂风骤雨，出剑间飞剑相随", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [40, 350], scalingRatio: [0.4, 1.5], scalingStat: "strength" },
          { type: "summon", name: "飞剑", trigger: "on_turn_end", summonDamage: 0, scalingRatio: 0.5, scalingStat: "strength", countPerCast: [1, 5], duration: 99 }
        ], type: "主动"
      },
      { name: "剑罡诀", intro: "剑修淬炼剑罡的中阶心法，修炼后剑气凝实、暴击之势愈发凌厉", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "critDmg", value: [10, 25], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "万剑诀", intro: "上古剑宗镇派杀伐之术，驱使已御飞剑齐发、剑气冲霄", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "dealDamageBySummon", damageType: "physical", baseValue: [20, 150], scalingRatio: [0.2, 0.8], scalingStat: "strength", summonName: "飞剑" }
        ], type: "主动"
      },
      { name: "凌风剑步", intro: "上古剑修传承的身法秘术，剑随风动、身随剑行，动若流风", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "speed", value: [8, 16], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "天剑诀", intro: "上古天剑宗镇宗秘传御剑之术，一念引动九天剑气化作飞剑万千", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "summon", name: "飞剑", trigger: "on_turn_end", summonDamage: 0, scalingRatio: 0.5, scalingStat: "strength", countPerCast: [3, 20], duration: 99 }
        ], type: "主动"
      },
      { name: "剑心诀", intro: "上古剑修参透剑心的至秘心法，目光所及、万物皆为破绽", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "critRate", value: [12, 25], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "诛仙剑法", intro: "上古诛仙剑仙传承的杀伐秘术，剑光一闪、仙佛皆杀，出剑间飞剑群至", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamage", damageType: "physical", baseValue: [100, 800], scalingRatio: [0.8, 2.5], scalingStat: "strength" },
          { type: "summon", name: "飞剑", trigger: "on_turn_end", summonDamage: 0, scalingRatio: 0.5, scalingStat: "strength", countPerCast: [2, 10], duration: 99 }
        ], type: "主动"
      },
      { name: "极罡诀", intro: "上古剑修淬炼至极剑罡的仙家心法，剑罡凝如实质、暴击摧枯拉朽", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "critDmg", value: [20, 45], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "开天剑法", intro: "据传承自太古开天剑祖，驱使万剑归一、一剑可裂苍穹、开辟天地", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "dealDamageBySummon", damageType: "physical", baseValue: [40, 300], scalingRatio: [0.4, 1.5], scalingStat: "strength", summonName: "飞剑" }
        ], type: "主动"
      },
      { name: "瞬影剑步", intro: "太古剑祖顿悟的身法神通，一步跨越千山万水、快逾闪电", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "speed", value: [15, 28], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  },

  "体修": {
    "下品": [
      { name: "铁衣功", intro: "上古体修淬炼肉身的入门护体法门，运转时体魄凝作铁衣、刀枪难入", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "shield", baseValue: [50, 400], scalingRatio: [0.5, 2.0], scalingStat: "physique" }
        ], type: "主动"
      },
      { name: "气血功", intro: "上古体修以血气淬炼肉身的入门心法，气血越充沛、攻势愈发猛烈", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "normalAttackHpRatio", value: [1, 5], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "磐石功", intro: "上古体修以大地岩石化身淬体的入门心法，肉身越坚实、拳势越沉重", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "normalAttackDefRatio", value: [10, 30], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
      { name: "灵壁功", intro: "上古体修兼修灵御的入门心法，以灵力护体、化御为攻", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "normalAttackResRatio", value: [10, 30], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "化盾诀", intro: "上古体修淬体的进阶心法，溢出的治疗化为护体罡气、固若金汤", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "healOverflowToShield", value: [25, 50], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
      { name: "回元功", intro: "上古体修温养血肉的进阶心法，行功时血脉温润、生机暗生", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "hpRecover", value: [2, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "金身功", intro: "上古体修以金刚淬体所成的至高护体法门，运转时肉身化作金身、万法不侵", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "shield", baseValue: [200, 1200], scalingRatio: [1.0, 3.5], scalingStat: "physique" }
        ], type: "主动"
      },
      { name: "血魄功", intro: "上古体修以精血淬炼肉身的至高心法，气血澎湃如海、拳势吞天", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "normalAttackHpRatio", value: [1, 5], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "不动功", intro: "上古体修参悟大地之力的仙家心法，肉身坚如磐石、万击不动", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "normalAttackDefRatio", value: [25, 60], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
      { name: "万灵功", intro: "上古体修兼修万灵之御的仙家心法，灵御通神、化万法为攻", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "normalAttackResRatio", value: [25, 60], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "归盾诀", intro: "太古体祖以万血淬体所成的神通，万般治疗皆化为不灭罡盾", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "healOverflowToShield", value: [50, 100], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
      { name: "生生诀", intro: "太古体祖参悟造化生机的至高心法，生生不息、造化无穷", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "hpRecover", value: [5, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  },

  "法修": {
    "下品": [
      { name: "寒霜弹", intro: "据传承自上古冰修，掌心凝出冰弹激射、寒气侵骨", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [20, 375], scalingRatio: [0.45, 1.8], scalingStat: "perception" },
          { type: "applyCc", ccType: "freeze", chance: [0.15, 0.30], duration: 1 }
        ], type: "主动"
      },
      { name: "灵泉诀", intro: "上古御气修士温养灵台的入门心法，行功时灵台如泉、法力暗生", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "mpRecover", value: [1, 5], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "慑魂术", intro: "上古魂修秘传惊魂之术，灵元化作惧涛、令敌心胆俱裂", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [60, 540], scalingRatio: [0.65, 2.4], scalingStat: "perception" },
          { type: "applyCc", ccType: "fear", chance: [0.15, 0.30], duration: 1 }
        ], type: "主动"
      },
      { name: "破魔功", intro: "上古御气修士遗刻所载的进阶心法，行功时破法之韵流转、法术无坚不摧", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "magDefensePenetration", value: [5, 15], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "玄冰阵", intro: "上古冰修镇派秘术，灵元化作玄冰阵法、冰封八方", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [80, 550], scalingRatio: [0.55, 1.8], scalingStat: "perception" },
          { type: "applyCc", ccType: "freeze", chance: [0.10, 0.25], duration: 1 }
        ], type: "主动", isAoE: true
      },
      { name: "法威诀", intro: "上古御气修士凝练法威的进阶心法，万法归一、法威浩荡", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "magDamageDealt", value: [10, 20], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "九幽寒霜", intro: "上古冰修镇宗秘传杀伐之术，凝九幽寒霜激射、寒彻魂魄", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [50, 800], scalingRatio: [0.8, 2.8], scalingStat: "perception" },
          { type: "applyCc", ccType: "freeze", chance: [0.25, 0.50], duration: 1 }
        ], type: "主动"
      },
      { name: "天泉诀", intro: "上古御气修士温养灵台的至高心法，灵台如天泉奔涌、法力生生不息", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "mpRecover", value: [4, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "诛魂术", intro: "上古魂修仙家秘传惊魂之术，灵元化作惧涛怒浪、令敌魂飞魄散", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [120, 900], scalingRatio: [1.0, 3.5], scalingStat: "perception" },
          { type: "applyCc", ccType: "fear", chance: [0.30, 0.50], duration: 1 }
        ], type: "主动"
      },
      { name: "灭法功", intro: "上古御气修士遗刻所载的仙家心法，破法之韵凝如实质、万法皆破", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "magDefensePenetration", value: [15, 35], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "万冰诀", intro: "太古冰祖传承的至高秘术，灵元化作万道玄冰、冰封天地万物", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [180, 1000], scalingRatio: [1.0, 3.0], scalingStat: "perception" },
          { type: "applyCc", ccType: "freeze", chance: [0.25, 0.45], duration: 1 }
        ], type: "主动", isAoE: true
      },
      { name: "万法诀", intro: "太古法祖所悟万法归一的至高心法，万法归宗、法威通天", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "magDamageDealt", value: [20, 45], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  },

  "毒修": {
    "下品": [
      { name: "毒雾术", intro: "南疆蛊修入门杀伐之术，施术时毒雾弥漫、蚀肉销骨", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [25, 400], scalingRatio: [0.45, 1.8], scalingStat: "perception" },
          { type: "applyStatus", statusType: "poison", tickValue: 0.5, isPercent: true, duration: 3, maxStacks: 9999 }
        ], type: "主动"
      },
      { name: "噬血蛊", intro: "南疆蛊修以蛊虫寄生之术反哺己身，施术伤敌时气血暗生", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "lifesteal", value: [3, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "蛊毒术", intro: "南疆蛊修深修杀伐之术，施术时蛊虫携毒而出、席卷全场", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [15, 250], scalingRatio: [0.3, 1.0], scalingStat: "perception" },
          { type: "applyStatus", statusType: "poison", tickValue: 0.5, isPercent: true, duration: 3, maxStacks: 9999 }
        ], type: "主动", isAoE: true
      },
      { name: "毒道真解", intro: "南疆蛊修参悟毒道本源的进阶心法，万毒归一、杀伐愈烈", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "damageDealt", value: [5, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "穿心毒术", intro: "南疆蛊修深修杀伐秘术，百毒穿心、引爆剧毒一举毙命", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [80, 550], scalingRatio: [0.55, 1.8], scalingStat: "perception" },
          { type: "consumePoisonDamage" }
        ], type: "主动"
      },
      { name: "蛇影步", intro: "南疆蛊修秘传身法，身形如蛇影游走、快逾鬼魅", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "speed", value: [6, 14], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "九幽毒雾", intro: "南疆蛊修至高杀伐秘术，九幽毒雾弥漫、无孔不入", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [50, 800], scalingRatio: [0.8, 2.8], scalingStat: "perception" },
          { type: "applyStatus", statusType: "poison", tickValue: 0.5, isPercent: true, duration: 5, maxStacks: 9999 }
        ], type: "主动"
      },
      { name: "天蛊噬血", intro: "南疆蛊修至高养蛊心法，万蛊噬敌精血、反哺己身", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "lifesteal", value: [8, 18], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "万蛊噬魂", intro: "南疆蛊修仙家秘传，万蛊齐出携毒席卷、噬魂销骨", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [40, 500], scalingRatio: [0.6, 1.8], scalingStat: "perception" },
          { type: "applyStatus", statusType: "poison", tickValue: 0.5, isPercent: true, duration: 5, maxStacks: 9999 }
        ], type: "主动", isAoE: true
      },
      { name: "毒道至解", intro: "南疆蛊修参悟毒道本源的至高心法，万毒归宗、杀伐通天", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "damageDealt", value: [12, 25], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "九幽穿心", intro: "太古毒祖传承的至高杀伐神通，百毒穿心、引爆万毒一举毙命", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [180, 1000], scalingRatio: [1.0, 3.0], scalingStat: "perception" },
          { type: "consumePoisonDamage" }
        ], type: "主动"
      },
      { name: "天蛇行", intro: "太古毒祖所悟身法神通，身如天蛇游走、快逾闪电", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "speed", value: [10, 22], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  },

  "药修": {
    "下品": [
      { name: "回春术", intro: "上古药修入门治伤法门，掌心青光一闪、枯木逢春", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "heal", baseValue: [80, 1200], scalingRatio: [0.6, 2.5], scalingStat: "spirit" }
        ], type: "主动"
      },
      { name: "妙手诀", intro: "上古药修调息心法，修炼后药力吸收愈发精纯", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "healReceived", value: [15, 30], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "灵愈术", intro: "上古药修深修秘术，灵元化作温润光雨洒落全场", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "heal", baseValue: [50, 700], scalingRatio: [0.4, 1.5], scalingStat: "spirit" }
        ], type: "主动", isAoE: true
      },
      { name: "药王心法", intro: "上古药王传承的养气心法，行功时灵药之气暗生", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "mpRecover", value: [2, 5], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "生生诀", intro: "上古药修镇派秘术，掌心绿光持续注入、生机绵绵不绝", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "applyStatus", statusType: "hpRegen", tickValue: [100, 800], isPercent: false, duration: 3, maxStacks: 1 }
        ], type: "主动"
      },
      { name: "延年功", intro: "上古药修温养肉身的进阶心法，行功时血脉温润、延年益寿", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "hpRecover", value: [2, 5], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "天回术", intro: "上古药修至高治伤秘术，掌心青光大盛、肉身再生如初", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "heal", baseValue: [100, 1500], scalingRatio: [1.0, 3.5], scalingStat: "spirit" }
        ], type: "主动"
      },
      { name: "天妙诀", intro: "上古药修参悟药道本源的至高心法，药力精纯无比、百治百效", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "healReceived", value: [25, 50], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "万灵术", intro: "上古药修仙家秘传，灵元化作漫天光雨、润泽万众", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "heal", baseValue: [120, 1500], scalingRatio: [0.8, 2.5], scalingStat: "spirit" }
        ], type: "主动", isAoE: true
      },
      { name: "药神圣典", intro: "上古药王仙家传承的至高心法，灵药之气生生不息", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "mpRecover", value: [5, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "造化诀", intro: "太古药祖传承的至高神通，掌心造化之光持续注入、起死回生", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "applyStatus", statusType: "hpRegen", tickValue: [500, 3000], isPercent: false, duration: 5, maxStacks: 1 }
        ], type: "主动"
      },
      { name: "长生功", intro: "太古药祖温养肉身的至高心法，血脉永驻、长生不老", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "hpRecover", value: [5, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  },

  "魔修": {
    "下品": [
      { name: "祭血术", intro: "魔修以血祭法的入门秘术，以精血燃作魔力、攻势骤增", mpCost: [50, 500], cooldown: 1,
        battleEffects: [
          { type: "sacrificeHp", percent: 5 },
          { type: "applyModifier", modifierType: "damageDealt", value: [15, 35], duration: 3, maxStacks: 1, targetSelf: true }
        ], type: "主动"
      },
      { name: "噬血魔功", intro: "魔修以魔力反哺肉身的入门心法，伤敌时气血暗生", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "lifesteal", value: [3, 10], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "中品": [
      { name: "魔蚀术", intro: "魔修以魔力侵蚀敌体，伤其根基、破其护体灵御", mpCost: [75, 750], cooldown: 2,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [40, 350], scalingRatio: [0.4, 1.5], scalingStat: "spirit" },
          { type: "applyModifier", modifierType: "physDamageTaken", value: [10, 25], duration: 3, maxStacks: 1 },
          { type: "applyModifier", modifierType: "magDamageTaken", value: [10, 25], duration: 3, maxStacks: 1 }
        ], type: "主动"
      },
      { name: "魔力真解", intro: "魔修参悟魔力本源的进阶心法，万魔归一、杀伐愈烈", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "damageDealt", value: [8, 18], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "上品": [
      { name: "噬魂魔功", intro: "魔修至高杀伐秘术，以大量精血换取毁灭性魔力一击", mpCost: [100, 1000], cooldown: 4,
        battleEffects: [
          { type: "sacrificeHp", percent: 10 },
          { type: "dealDamage", damageType: "magical", baseValue: [300, 3000], scalingRatio: [1.0, 3.5], scalingStat: "spirit" }
        ], type: "主动"
      },
      { name: "魔威诀", intro: "魔修凝练魔威的进阶心法，暴击之势摧枯拉朽", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "critDmg", value: [10, 25], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "极品": [
      { name: "天魔祭血", intro: "魔修至高血祭秘术，以大量精血燃作滔天魔力、攻势暴增", mpCost: [200, 2000], cooldown: 6,
        battleEffects: [
          { type: "sacrificeHp", percent: 8 },
          { type: "applyModifier", modifierType: "damageDealt", value: [25, 55], duration: 3, maxStacks: 1, targetSelf: true }
        ], type: "主动"
      },
      { name: "天魔噬血", intro: "魔修至高养魔心法，伤敌时气血大生、反哺无穷", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "lifesteal", value: [8, 18], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "仙品": [
      { name: "天魔蚀", intro: "魔修仙家秘传，魔力侵蚀敌体根基、护体灵御尽溃", mpCost: [300, 3000], cooldown: 8,
        battleEffects: [
          { type: "dealDamage", damageType: "magical", baseValue: [100, 800], scalingRatio: [0.8, 2.5], scalingStat: "spirit" },
          { type: "applyModifier", modifierType: "physDamageTaken", value: [20, 45], duration: 3, maxStacks: 1 },
          { type: "applyModifier", modifierType: "magDamageTaken", value: [20, 45], duration: 3, maxStacks: 1 }
        ], type: "主动"
      },
      { name: "天魔真解", intro: "魔修参悟天魔本源的至高心法，万魔归宗、杀伐通天", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "damageDealt", value: [15, 30], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
    "神品": [
      { name: "天魔噬魂", intro: "太古魔祖传承的至高杀伐神通，以精血换取灭世魔力一击", mpCost: [500, 5000], cooldown: 10,
        battleEffects: [
          { type: "sacrificeHp", percent: 20 },
          { type: "dealDamage", damageType: "magical", baseValue: [500, 5000], scalingRatio: [1.5, 5.0], scalingStat: "spirit" }
        ], type: "主动"
      },
      { name: "天魔威", intro: "太古魔祖凝练天魔之威的至高心法，暴击之势如天魔降世", mpCost: 0, cooldown: 0,
        battleEffects: [
          { type: "applyModifier", modifierType: "critDmg", value: [20, 45], duration: 99, maxStacks: 1 }
        ], type: "被动"
      },
    ],
  }

};

// ═══════════════════════════════════════════════════════════════════════════
// 体系校验
// ═══════════════════════════════════════════════════════════════════════════

export function normalizeGongfaSystem(raw: unknown): GongfaSystem {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if ((GONGFA_SYSTEM_KEYS as readonly string[]).includes(trimmed)) {
      return trimmed as GongfaSystem;
    }
  }
  return GONGFA_SYSTEM_KEYS[Math.floor(Math.random() * GONGFA_SYSTEM_KEYS.length)];
}

// ═══════════════════════════════════════════════════════════════════════════
// 角色定位校验
// ═══════════════════════════════════════════════════════════════════════════

const ROLE_TO_EFFECT_TYPE: Record<GongfaRole, GongfaEffectType> = {
  "攻击": "主动",
  "辅助": "被动",
};

export function normalizeGongfaRole(raw: unknown): GongfaRole | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "攻击" || trimmed === "辅助") return trimmed;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 随机分配
// ═══════════════════════════════════════════════════════════════════════════

function pickFromPool(pool: readonly GongfaSpecialEffect[]): GongfaSpecialEffect {
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

function filterPool(pool: readonly GongfaSpecialEffect[], effectType?: GongfaEffectType): readonly GongfaSpecialEffect[] {
  if (!effectType) return pool;
  const filtered = pool.filter(e => e.type === effectType);
  return filtered.length > 0 ? filtered : pool;
}

export function rollGongfaFunction(system: GongfaSystem, grade: ItemGrade, role?: GongfaRole): GongfaSpecialEffect {
  const systemCatalog = GONGFA_EFFECT_CATALOG[system];
  const effectType = role ? ROLE_TO_EFFECT_TYPE[role] : undefined;

  const pool = filterPool(systemCatalog[grade], effectType);
  if (pool.length > 0) return pickFromPool(pool);

  for (const sys of Object.values(GONGFA_EFFECT_CATALOG)) {
    for (const g of GRADE_ORDER) {
      const fallbackPool = filterPool(sys[g], effectType);
      if (fallbackPool.length > 0) return pickFromPool(fallbackPool);
    }
  }

  for (const sys of Object.values(GONGFA_EFFECT_CATALOG)) {
    for (const g of GRADE_ORDER) {
      if (sys[g].length > 0) return pickFromPool(sys[g]);
    }
  }

  return { name: "默认功法", intro: "来历不明的基础修行法门，运转时丹田微微发热", mpCost: [10, 50], cooldown: 0, battleEffects: [{ type: "dealDamage", damageType: "physical", baseValue: [50, 500], scalingRatio: [1.0, 4.0], scalingStat: "strength" }], type: "主动" };
}

// ═══════════════════════════════════════════════════════════════════════════
// 物品定义
// ═══════════════════════════════════════════════════════════════════════════

export interface GongfaItemDefinition {
  itemType: "功法";
  name: string;
  desc: string;
  grade: ItemGrade;
  count: number;
  bonus: ItemBonusMap;
  system?: GongfaSystem;
  role?: GongfaRole;
  function?: GongfaSpecialEffect;
  mastery?: number;
  masteryExp?: number;
  /**
   * 阶层（凡人 / 练气 / 筑基 / 结丹 / 元婴 / 化神）。
   *
   * 与法宝同理，决定数值量级与跨境界压制；额外决定**修为门槛**——
   * 使用者境界高于功法阶层后，修炼该功法不再产出修为（见 `isGongfaObsolete`）。
   *
   * 旧存档无此字段时**不按品阶回退**（避免无预警削号），视为不受压制；
   * 玩家可在「天道编辑」中显式指定。
   */
  tier?: ItemTier;
}
