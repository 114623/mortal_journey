// ═══════════════════════════════════════════════════════════════
// 战斗公式
// ═══════════════════════════════════════════════════════════════

import type { DamageType } from "./types";
import { MIN_DAMAGE } from "./constants";

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
