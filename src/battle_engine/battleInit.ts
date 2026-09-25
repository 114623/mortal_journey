import type { BattleCombatant, BattleSkill, BattleElixir, BattleEffect, SkillEffect, DamageType, ModifierType, CcType, StatusType, SummonTrigger } from "./types";
import type { BattleTriggerEntry } from "../ai/state_generate";
import type { GongfaSlotsState, EquippedSlotsState, GongfaItemDefinition } from "../role_core/types/playInfo";
import type { InventoryStackItem, ElixirItemDefinition } from "../role_core/types/itemInfo";
import type { GongfaBattleEffect, LayerValue } from "../role_core/types/gongfa";
import type { PrimaryStatKey } from "../role_core/types/playInfo";
import {
  atLayer,
  atLayerFloat,
  resolveGongfaBattleEffectDesc,
  gradeSkillSrMult,
  gongfaMpPct,
  gongfaMpCost,
  bvTypeMult,
  systemBvMult,
} from "../role_core/types/gongfa";
import type { GongfaSystem } from "../role_core/types/gongfa";
import { protagonist } from "../role_core/Protagonist";
import { Npc } from "../role_core/Npc";
import { npcStore } from "../role_core/npcStore";
import { gameLog } from "../log/gameLog";
import { GONGFA_SLOT_COUNT, computeLinggenCombatBonuses } from "../role_core/types/gameConstants";
import { gongfaMaxLayer } from "../role_core/types/itemTier";
import {
  gongfaCombatMultAt,
  gongfaContLayer,
  gongfaLayer10At,
} from "../role_core/realmUtils";
import { gongfaBvValue } from "../role_core/realmScale";
import { treasureTierFactor, resolveItemTier, applyElixirTierSuppression, gongfaTierFactor } from "../role_core/types/itemTier";
import { generateId as generateEffectId } from "./formulas";
import { BASE_CRIT_DMG } from "./constants";

function generateId(team: "ally" | "enemy", index: number): string {
  return `${team}_${index}`;
}

/**
 * 【2026-09-25 v4】战斗倍率与目录取样位置一律走**连续层号**。
 *
 * 旧口径是「按整数层在 [1, 上限] 之间插值」，层内经验在升级前完全不体现在数值上。
 * 现在每颗灵石都立刻生效，层数退化为里程碑。
 *
 * @returns mult 战斗倍率（练气满层 1.45 ~ 化神满层 2.35）；
 *          layer10 目录数值曲线的取样位置（1~10）。
 */
function gongfaLayerContext(gf: GongfaItemDefinition): { mult: number; layer10: number; contLayer: number } {
  const contLayer = gongfaContLayer(gf);
  return {
    mult: gongfaCombatMultAt(contLayer),
    layer10: gongfaLayer10At(contLayer),
    contLayer,
  };
}

/**
 * 技能的**绝对点数**底盘（`baseValue` / `summonDamage` / 定值 `tickValue`）。
 *
 * 【2026-09-25 改】由「目录死数字 × 施法者境界缩放」改为
 * **`realmScale.gongfaBvValue(连续层号)`**：底盘**只认层号**（同层同值），
 * 不看使用者境界 —— 旧口径在练气期只有 0.0091 的系数，把 250~1500 的点数打到 6 点，
 * 等于归零，练气期技能全程弱于普攻；而按施法者境界缩放又会废掉自然淘汰
 * （练气功法带到化神被算成化神量级，永远淘汰不掉）。
 *
 * 底盘**不乘 `masteryMult`**（曲线已含层号成长，再乘会双重成长）；
 * `scalingRatio × 属性` 那部分继续乘（它是"练得更深 + 堆属性"的奖励）。
 *
 * @param bvValue 层号底盘值，由调用方 `gongfaBvValue(contLayer)` 算好。
 * @param system 功法体系，用于体系系数（只影响直接造成伤害的条目）。
 */
function bakeScalingValue(
  eff: GongfaBattleEffect,
  getStat: (key: string) => number,
  masteryMult: number,
  layer: number,
  bvValue: number,
  gradeMult: number = 1,
  system?: GongfaSystem | null,
): number | undefined {
  if (!("baseValue" in eff) || !("scalingRatio" in eff) || !("scalingStat" in eff)) {
    return undefined;
  }
  const bv = bvValue * bvTypeMult(eff.type) * (isDamageEffectType(eff.type) ? systemBvMult(system) : 1);
  const sr = atLayerFloat(eff.scalingRatio as LayerValue, layer) * gradeMult;
  const stat = getStat(eff.scalingStat);
  return Math.round(bv + sr * stat * masteryMult);
}

/** 直接造成伤害的效果类型（只有这些受体系系数影响）。 */
function isDamageEffectType(t: string): boolean {
  return t === "dealDamage" || t === "dealDamageExecute"
    || t === "dealDamagePierce" || t === "dealDamageBySummon";
}

function convertBattleEffectToSkillEffect(
  eff: GongfaBattleEffect,
  getStat: (key: string) => number,
  masteryMult: number,
  layer: number,
  bvValue: number,
  gradeMult: number = 1,
  system?: GongfaSystem | null,
): SkillEffect {
  const v = bakeScalingValue(eff, getStat, masteryMult, layer, bvValue, gradeMult, system);

  switch (eff.type) {
    case "dealDamage":
      return { type: "dealDamage", damageType: eff.damageType as DamageType, value: v ?? 0 };
    case "dealDamageExecute":
      return { type: "dealDamageExecute", damageType: eff.damageType as DamageType, value: v ?? 0, threshold: eff.threshold, bonusPercent: eff.bonusPercent };
    case "dealDamagePierce":
      return { type: "dealDamagePierce", value: v ?? 0 };
    case "dealDamageBySummon":
      return { type: "dealDamageBySummon", damageType: eff.damageType as DamageType, value: v ?? 0, summonName: eff.summonName };
    case "consumePoisonDamage":
      return { type: "consumePoisonDamage" };
    case "sacrificeHp":
      return { type: "sacrificeHp", percent: atLayer(eff.percent as LayerValue, layer) };
    case "heal":
      return { type: "heal", value: v ?? 0 };
    case "lifesteal":
      return { type: "lifesteal", damageType: eff.damageType as DamageType, damagePercent: atLayer(eff.damagePercent, layer) };
    case "applyModifier":
      return { type: "applyModifier", modifierType: eff.modifierType as ModifierType, value: atLayer(eff.value, layer), duration: eff.duration, maxStacks: eff.maxStacks, targetSelf: eff.targetSelf };
    case "applyCc":
      return { type: "applyCc", ccType: eff.ccType as CcType, chance: atLayerFloat(eff.chance, layer), duration: eff.duration };
    case "applyStatus":
      // 定值型跳伤同样是绝对点数，走层号底盘（按跳数摊薄）；
      // 百分比型（最大生命 5%）天然水涨船高，不能乘。
      return {
        type: "applyStatus",
        statusType: eff.statusType as StatusType,
        tickValue: eff.isPercent
          ? atLayer(eff.tickValue, layer)
          : Math.round(bvValue * bvTypeMult("applyStatus")),
        isPercent: eff.isPercent,
        duration: eff.duration,
        maxStacks: eff.maxStacks,
      };
    case "shield":
      return { type: "shield", value: v ?? 0 };
    case "counter":
      return { type: "counter", damage: v ?? 0, duration: eff.duration };
    case "reflect":
      return { type: "reflect", percent: atLayer(eff.percent, layer), duration: eff.duration };
    case "damageShare":
      return { type: "damageShare", percent: atLayer(eff.percent, layer), duration: eff.duration };
    case "deathWard":
      return { type: "deathWard", duration: eff.duration };
    case "extraAction":
      return { type: "extraAction", chance: eff.chance };
    case "gaugeManipulate":
      return { type: "gaugeManipulate", value: eff.value };
    case "stealth":
      return { type: "stealth", duration: eff.duration };
    case "cleanse":
      return { type: "cleanse" };
    case "dispel":
      return { type: "dispel" };
    case "revive":
      return { type: "revive", hpPercent: eff.hpPercent };
    case "summon": {
      const baseDmg = bvValue * bvTypeMult("summon");
      const scalingDmg = eff.scalingRatio != null && eff.scalingStat
        ? atLayerFloat(eff.scalingRatio as LayerValue, layer) * gradeMult * getStat(eff.scalingStat)
        : 0;
      const dmg = Math.round(baseDmg + scalingDmg);
      const count = eff.countPerCast != null ? atLayer(eff.countPerCast as LayerValue, layer) : 1;
      return { type: "summon", name: eff.name, trigger: eff.trigger as SummonTrigger, effect: { type: "dealDamage", damageType: "physical", value: dmg }, duration: eff.duration, stacksPerCast: count };
    }
  }
}

function isTargetEnemy(eff: GongfaBattleEffect): boolean {
  switch (eff.type) {
    case "dealDamage": case "dealDamageExecute": case "dealDamagePierce": case "dealDamageBySummon":
    case "consumePoisonDamage":
    case "lifesteal": case "applyCc":
    case "gaugeManipulate": case "dispel":
      return true;
    case "applyStatus":
      return eff.statusType !== "hpRegen";
    case "applyModifier":
      return !eff.targetSelf;
    default:
      return false;
  }
}

function needsTarget(eff: GongfaBattleEffect): boolean {
  switch (eff.type) {
    case "dealDamage": case "dealDamageExecute": case "dealDamagePierce": case "dealDamageBySummon":
    case "consumePoisonDamage":
    case "lifesteal": case "applyCc": case "applyStatus":
    case "gaugeManipulate": case "dispel": case "heal":
      return true;
    case "applyModifier":
      return !eff.targetSelf;
    default:
      return false;
  }
}
function buildBattleSkills(
  gongfaSlots: GongfaSlotsState,
  getStat: (key: string) => number,
  cooldownReduce: number,
  realmMajor?: string,
  realmMinor?: string,
  maxMp: number = 0,
): BattleSkill[] {
  const skills: BattleSkill[] = [];

  for (const gf of gongfaSlots) {
    if (!gf || !gf.function) continue;
    if (gf.function.type !== "主动") continue;

    // 连续层号：倍率与目录取样都按它走，层内经验立刻生效。
    const { mult, layer10: layer, contLayer } = gongfaLayerContext(gf);
    // 绝对点数的底盘：只认层号（同层同值），不看使用者境界。
    const bvValue = gongfaBvValue(contLayer);
    // 仅凡人 tier 有衰减（练气期 40%、筑基起归零），练气及以上恒 1。
    const tierMult = gongfaTierFactor(gf.tier, realmMajor);
    const masteryMult = mult * tierMult;
    const gradeMult = gradeSkillSrMult(gf.grade);
    const effects = gf.function.battleEffects.map(eff =>
      convertBattleEffectToSkillEffect(eff, getStat, masteryMult, layer, bvValue, gradeMult, gf.system),
    );

    const hasOffensive = gf.function.battleEffects.some(isTargetEnemy);
    const hasNeedTarget = gf.function.battleEffects.some(needsTarget);

    const getStatForDesc = (key: PrimaryStatKey) => getStat(key);
    const desc = gf.function.battleEffects
      .map(e => resolveGongfaBattleEffectDesc(
        e, getStatForDesc, masteryMult, layer, false, false, false, bvValue, gradeMult, gf.system,
      ))
      .join("；");

    // 【2026-09-25 v4】蓝耗改「占自身最大法力百分比」，目录 mpCost 绝对点数不再使用。
    const mpPct = gongfaMpPct(gf.grade, contLayer);
    skills.push({
      name: gf.name,
      desc,
      mpCost: gongfaMpCost(maxMp, mpPct),
      actionCost: 100,
      cooldown: Math.max(0, (gf.function.cooldown ?? 0) - cooldownReduce),
      needTarget: hasNeedTarget,
      targetTeam: hasOffensive ? "enemy" : "ally",
      isAoE: !!gf.function.isAoE,
      effects,
    });
  }
  return skills;
}

function convertBattleEffectToInitEffect(
  eff: GongfaBattleEffect,
  getStat: (key: string) => number,
  masteryMult: number,
  layer: number,
  effectName: string,
  combatantId: string,
  bvValue: number = 0,
  gradeMult: number = 1,
  system?: GongfaSystem | null,
): BattleEffect {
  const v = bakeScalingValue(eff, getStat, masteryMult, layer, bvValue, gradeMult, system);
  const base: BattleEffect = {
    id: generateEffectId(),
    name: effectName,
    sourceId: combatantId,
    category: "special",
    remainingDuration: 2,
    stacks: 1,
    maxStacks: 1,
  };

  switch (eff.type) {
    case "applyModifier":
      return { ...base, category: "modifier", modifierType: eff.modifierType as ModifierType, modifierValue: atLayer(eff.value, layer), remainingDuration: eff.duration, maxStacks: eff.maxStacks };
    case "applyCc":
      return { ...base, category: "cc", ccType: eff.ccType as CcType, remainingDuration: eff.duration };
    case "applyStatus": {
      const isDoT = eff.statusType === "poison" || eff.statusType === "burn" || eff.statusType === "bleed" || eff.statusType === "mpDrain";
      // 定值跳伤走层号底盘（按跳数摊薄）；百分比型不动（isPercent 分支天然水涨船高）。
      const tick = eff.isPercent
        ? atLayer(eff.tickValue, layer)
        : Math.round(bvValue * bvTypeMult("applyStatus"));
      return { ...base, category: isDoT ? "dot" : "hot", tickValue: tick, tickIsPercent: eff.isPercent, tickResource: eff.statusType === "mpDrain" ? "mp" : "hp", statusType: eff.statusType as StatusType, remainingDuration: eff.duration, maxStacks: eff.maxStacks };
    }
    case "shield":
      return { ...base, specialType: "shield", specialValue: v ?? 0, remainingDuration: 99 };
    case "counter":
      return { ...base, specialType: "counter", specialValue: v ?? 0, remainingDuration: eff.duration };
    case "reflect":
      return { ...base, specialType: "reflect", specialValue: atLayer(eff.percent, layer), remainingDuration: eff.duration };
    case "damageShare":
      return { ...base, specialType: "damageShare", specialValue: atLayer(eff.percent, layer), remainingDuration: eff.duration };
    case "deathWard":
      return { ...base, specialType: "deathWard", remainingDuration: eff.duration };
    case "stealth":
      return { ...base, specialType: "stealth", remainingDuration: eff.duration };
    case "extraAction":
      return { ...base, specialType: "extraAction", specialValue: Math.round(eff.chance * 100), remainingDuration: 99 };
    case "dealDamage":
    case "dealDamageExecute":
    case "dealDamagePierce":
    case "dealDamageBySummon":
    case "consumePoisonDamage":
    case "sacrificeHp":
    case "heal":
    case "lifesteal":
      return { ...base, category: "modifier", modifierType: "damageDealt" as ModifierType, modifierValue: 0, remainingDuration: 99 };
    case "gaugeManipulate":
      return base;
    case "cleanse":
    case "dispel":
    case "revive":
    case "summon":
      return base;
  }
}

function extractPassiveEffects(
  gongfaSlots: GongfaSlotsState,
  getStat: (key: string) => number,
  combatantId: string,
  realmMajor?: string,
  realmMinor?: string,
): BattleEffect[] {
  const effects: BattleEffect[] = [];

  for (const gf of gongfaSlots) {
    if (!gf || !gf.function) continue;
    if (gf.function.type !== "被动") continue;

    const { mult, layer10: layer, contLayer } = gongfaLayerContext(gf);
    // 被动（开局护盾、反击、持续恢复）的绝对点数同样走层号底盘。
    const bvValue = gongfaBvValue(contLayer);
    const masteryMult = mult * gongfaTierFactor(gf.tier, realmMajor);
    const gradeMult = gradeSkillSrMult(gf.grade);
    for (const eff of gf.function.battleEffects) {
      const be = convertBattleEffectToInitEffect(
        eff, getStat, masteryMult, layer, gf.function.name, combatantId, bvValue, gradeMult, gf.system,
      );
      be.hidden = true;
      effects.push(be);
    }
  }

  return effects;
}

/**
 * 提取已装备法宝的百分比被动，并注入为战斗 modifier。
 *
 * 每条词条的数值会先按 {@link treasureTierFactor} 做跨阶压制：
 * 低阶法宝按 0.65^Δ 削弱；高阶法宝被低阶修士使用时按 0.70^Δ 受器灵封印
 * （2026-09-24 由 0.35 上调）；凡人阶走专属衰减。
 *
 * @param equippedSlots 已装备法宝槽。
 * @param combatantId 战斗单位 id。
 * @param realmMajor 使用者当前大境界（用于阶层压制）；缺省则不压制。
 */
function extractTreasurePassiveEffects(
  equippedSlots: EquippedSlotsState,
  combatantId: string,
  realmMajor?: string,
): BattleEffect[] {
  const effects: BattleEffect[] = [];

  for (const tr of equippedSlots) {
    if (!tr || !tr.function) continue;
    if (!("modifiers" in tr.function)) continue;
    // 法宝跨阶压制（treasureTierFactor）：低阶 0.65^Δ、高阶 0.70^Δ、凡人阶专属衰减。
    const tierF = treasureTierFactor(resolveItemTier(tr.tier, tr.grade), realmMajor);
    for (const mod of tr.function.modifiers) {
      const rawType = mod.modifierType as string;
      const engineType = (rawType === "healReceived" ? "hpRecover" : rawType) as ModifierType;
      const signed = mod.modifierType === "damageTaken" ? -mod.value : mod.value;
      const scaled = Math.round(signed * tierF * 10) / 10;
      effects.push({
        id: generateEffectId(),
        name: tr.function.name,
        sourceId: combatantId,
        category: "modifier",
        remainingDuration: 99,
        stacks: 1,
        maxStacks: 1,
        modifierType: engineType,
        modifierValue: scaled,
        hidden: true,
      });
    }
  }

  return effects;
}

/**
 * 提取储物袋中可在战斗内使用的恢复类丹药。
 *
 * 数值按「丹药阶层 vs 使用者境界」压制（低阶丹药每差一阶 ×0.2），
 * 与 `Protagonist.consumeElixir` 保持同一套规则。
 */
function extractRecoveryElixirs(
  inventorySlots: Array<InventoryStackItem | null>,
  realmMajor?: string,
): BattleElixir[] {
  const result: BattleElixir[] = [];
  for (const slot of inventorySlots) {
    if (!slot) continue;
    if ("itemType" in slot && slot.itemType === "丹药" && "effectType" in slot
      && (slot.effectType === "恢复血量" || slot.effectType === "恢复法力")) {
      const el = slot as ElixirItemDefinition;
      const tier = resolveItemTier(el.tier, el.grade);
      const raw = el.effects?.value ?? 0;
      result.push({
        name: el.name,
        desc: el.desc ?? "",
        effectType: el.effectType === "恢复血量" ? "healHp" : "healMp",
        value: applyElixirTierSuppression(raw, tier, realmMajor),
        isPercent: el.effects?.isPercent ?? false,
        count: el.count,
      });
    }
  }
  return result;
}

function createProtagonistCombatant(): BattleCombatant | null {
  const p = protagonist.value;
  if (!p) return null;

  const primaryStats = p.getPrimaryStats();
  const getStat = (key: string) => (primaryStats as Record<string, number>)[key] ?? 0;
  const linggenBonus = computeLinggenCombatBonuses(p.linggen, p.realm.major);
  const skills = buildBattleSkills(p.gongfaSlots, getStat, linggenBonus.cooldownReduce, p.realm.major, p.realm.minor, p.maxMp);
  const elixirs = extractRecoveryElixirs(p.inventorySlots, p.realm.major);
  const passiveEffects: BattleEffect[] = [
    ...extractPassiveEffects(p.gongfaSlots, getStat, generateId("ally", 0), p.realm.major, p.realm.minor),
    ...extractTreasurePassiveEffects(p.equippedSlots, generateId("ally", 0), p.realm.major),
  ];

  return {
    id: generateId("ally", 0),
    name: p.displayName,
    team: "ally",
    isProtagonist: true,
    isPlayerControlled: true,

    stats: {
      maxHp: p.maxHp,
      maxMp: p.maxMp,
      speed: primaryStats.agility ?? 0,
      physAttack: primaryStats.strength ?? 0,
      magAttack: primaryStats.perception ?? 0,
      physDefense: primaryStats.guard ?? 0,
      magDefense: primaryStats.resistance ?? 0,
      critRate: 0,
      critDmg: BASE_CRIT_DMG + linggenBonus.critDmgBonus,
    },

    hp: p.currentHp,
    mp: p.currentMp,
    shield: 0,
    actionGauge: 0,
    isDead: false,
    isFleeing: false,

    skills,
    cooldowns: new Array(Math.max(GONGFA_SLOT_COUNT, skills.length)).fill(0),
    elixirs,

    effects: passiveEffects,
    linggenHealMult: linggenBonus.healMult,
    linggenShieldMult: linggenBonus.shieldMult,
    realm: { ...p.realm },
    avatarUrl: p.avatarUrl,
  };
}

function createNpcCombatant(
  npc: Npc,
  team: "ally" | "enemy",
  index: number,
  enemyStatMult = 1,
): BattleCombatant {
  const primaryStats = npc.getPrimaryStats();
  const getStat = (key: string) => (primaryStats as Record<string, number>)[key] ?? 0;
  const linggenBonus = computeLinggenCombatBonuses(npc.linggen, npc.realm.major);
  const skills = buildBattleSkills(npc.gongfaSlots, getStat, linggenBonus.cooldownReduce, npc.realm.major, npc.realm.minor, npc.maxMp);
  const elixirs = extractRecoveryElixirs(npc.inventorySlots, npc.realm.major);
  const id = generateId(team, index);
  const passiveEffects: BattleEffect[] = [
    ...extractPassiveEffects(npc.gongfaSlots, getStat, id, npc.realm.major, npc.realm.minor),
    ...extractTreasurePassiveEffects(npc.equippedSlots, id, npc.realm.major),
  ];

  // 困难模式：敌方全主属性 ×1.5（攻防血速同步放大，含当前 HP/MP 以保证满血开战）。
  const m = team === "enemy" ? enemyStatMult : 1;
  const scale = (v: number): number => Math.round(v * m);

  return {
    id,
    name: npc.displayName,
    team,
    isProtagonist: false,
    isPlayerControlled: false,

    stats: {
      maxHp: scale(npc.maxHp),
      maxMp: scale(npc.maxMp),
      speed: scale(primaryStats.agility ?? 0),
      physAttack: scale(primaryStats.strength ?? 0),
      magAttack: scale(primaryStats.perception ?? 0),
      physDefense: scale(primaryStats.guard ?? 0),
      magDefense: scale(primaryStats.resistance ?? 0),
      critRate: 0,
      critDmg: BASE_CRIT_DMG + linggenBonus.critDmgBonus,
    },

    hp: scale(npc.currentHp),
    mp: scale(npc.currentMp),
    shield: 0,
    actionGauge: 0,
    isDead: false,
    isFleeing: false,

    skills,
    cooldowns: new Array(Math.max(GONGFA_SLOT_COUNT, skills.length)).fill(0),
    elixirs,

    effects: passiveEffects,
    linggenHealMult: linggenBonus.healMult,
    linggenShieldMult: linggenBonus.shieldMult,
    sourceNpcName: npc.displayName,
    sourceNpcId: npc.id,
    realm: { ...npc.realm },
    powerTier: npc.powerTier,
    identity: npc.identity,
    avatarUrl: npc.avatarUrl,
  };
}

/** 按 npcId 精确回查参战者；id 未命中（旧触发名单/AI 未带 id）时按 displayName 兜底。 */
function resolveCombatantNpc(npcId: string | undefined, displayName: string): Npc | undefined {
  const byId = npcId ? npcStore.getNpcById(npcId) : undefined;
  return byId ?? npcStore.getNpc(displayName);
}

export function createBattleCombatants(
  triggerEntry: BattleTriggerEntry,
  opts?: { enemyStatMult?: number },
): {
  allies: BattleCombatant[];
  enemies: BattleCombatant[];
} {
  const enemyStatMult = opts?.enemyStatMult ?? 1;
  const allies: BattleCombatant[] = [];
  const enemies: BattleCombatant[] = [];

  const protagonistCombatant = createProtagonistCombatant();
  if (protagonistCombatant) {
    allies.push(protagonistCombatant);
  }

  let allyIndex = 1;
  for (const ally of triggerEntry.allies) {
    if (ally.roleHint === "主角") continue;
    const npc = resolveCombatantNpc(ally.npcId, ally.displayName);
    if (!npc || npc.isDead) {
      gameLog.warn(`[initBattle] 友方NPC "${ally.displayName}" 未在npcStore中找到或已死亡`);
      continue;
    }
    if (allies.length >= 5) break;
    allies.push(createNpcCombatant(npc, "ally", allyIndex));
    allyIndex++;
  }

  let enemyIndex = 0;
  for (const enemy of triggerEntry.enemies) {
    const npc = resolveCombatantNpc(enemy.npcId, enemy.displayName);
    if (!npc || npc.isDead) {
      gameLog.warn(`[initBattle] 敌方NPC "${enemy.displayName}" 未在npcStore中找到或已死亡`);
      continue;
    }
    if (enemies.length >= 5) break;
    enemies.push(createNpcCombatant(npc, "enemy", enemyIndex, enemyStatMult));
    enemyIndex++;
  }

  return { allies, enemies };
}
