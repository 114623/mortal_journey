// ═══════════════════════════════════════════════════════════════
// 战斗公式
// ═══════════════════════════════════════════════════════════════

import type { BattleCombatant, DamageType } from "./types";
import { MIN_DAMAGE, DODGE_AGI_MAX, DODGE_HARD_CAP } from "./constants";

export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function calcDefenseReduction(rawDamage: number, defense: number, damageType: DamageType): number {
  if (damageType === "true") return rawDamage;
  return Math.max(MIN_DAMAGE, rawDamage - defense);
}

export function checkCrit(critRate: number): boolean {
  return Math.random() * 100 < critRate;
}

export function checkDodge(dodgeRate: number): boolean {
  return Math.random() * 100 < dodgeRate;
}

/**
 * 有效身法：基础身法 ×(1 + speed 修正%)，最低 1。
 * 与行动条增速（GaugeManager）同一口径——身法既决定出手频率，也决定难不难被命中。
 */
export function effectiveSpeed(c: BattleCombatant): number {
  const mod = c.effects
    .filter(e => e.category === "modifier" && e.modifierType === "speed")
    .reduce((sum, e) => sum + (e.modifierValue ?? 0) * e.stacks, 0);
  return Math.max(1, Math.round(c.stats.speed * (1 + mod / 100)));
}

/**
 * 身法闪避（%）：守方身法越高，越难被命中。
 *
 * 采用比值型而非差值型：dodge = DODGE_AGI_MAX ×(守 − 攻)/(守 + 攻)。
 * 好处是天然递减——守方身法高出一倍也只拿到约 11.7%，且永远逼近不到 DODGE_AGI_MAX，
 * 不会出现跨大境界一刀切的免疫式闪避。守方不占优时为 0（不倒扣命中）。
 */
export function calcAgilityDodge(defenderSpeed: number, attackerSpeed: number): number {
  const sum = defenderSpeed + attackerSpeed;
  if (sum <= 0) return 0;
  const raw = (DODGE_AGI_MAX * (defenderSpeed - attackerSpeed)) / sum;
  return Math.min(DODGE_AGI_MAX, Math.max(0, raw));
}

/** 最终闪避率：dodgeRate 修正 + 身法闪避，再用硬上限封顶（且不为负）。 */
export function calcFinalDodge(baseDodgeRate: number, agilityDodge: number): number {
  return Math.max(0, Math.min(DODGE_HARD_CAP, baseDodgeRate + agilityDodge));
}
