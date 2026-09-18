import type { BattleCombatant, ModifierType } from "./types";
import { GAUGE_MAX } from "./constants";

export class GaugeManager {

  getEffectiveSpeed(combatant: BattleCombatant): number {
    const speedMod = this.getModifierTotal(combatant, "speed");
    return Math.max(1, Math.round(combatant.stats.speed * (1 + speedMod / 100)));
  }

  advanceToNextActor(
    combatants: BattleCombatant[],
    checkFlee: (protagonist: BattleCombatant) => boolean,
  ): BattleCombatant | null {
    const alive = combatants.filter(c => !c.isDead);
    if (alive.length === 0) return null;

    const protagonist = alive.find(c => c.isFleeing);
    if (protagonist && checkFlee(protagonist)) {
      return null;
    }

    const ready = alive
      .filter(c => c.actionGauge >= GAUGE_MAX && !c.isFleeing)
      .sort((a, b) => b.actionGauge - a.actionGauge || this.getEffectiveSpeed(b) - this.getEffectiveSpeed(a));
    if (ready.length > 0) return ready[0];

    while (true) {
      let minTicks = Infinity;
      for (const c of alive) {
        const spd = this.getEffectiveSpeed(c);
        if (spd <= 0) continue;
        const deficit = GAUGE_MAX - c.actionGauge;
        if (deficit <= 0) { minTicks = 1; break; }
        minTicks = Math.min(minTicks, Math.ceil(deficit / spd));
      }
      if (minTicks === Infinity) return null;

      for (const c of alive) {
        c.actionGauge += this.getEffectiveSpeed(c) * minTicks;
      }

      if (protagonist && checkFlee(protagonist)) {
        return null;
      }

      const nowReady = alive
        .filter(c => c.actionGauge >= GAUGE_MAX && !c.isFleeing)
        .sort((a, b) => b.actionGauge - a.actionGauge || this.getEffectiveSpeed(b) - this.getEffectiveSpeed(a));
      if (nowReady.length > 0) return nowReady[0];
    }
  }

  consumeGauge(combatant: BattleCombatant, cost: number): void {
    combatant.actionGauge -= cost;
    if (combatant.actionGauge < 0) combatant.actionGauge = 0;
  }

  resetGauge(combatant: BattleCombatant): void {
    combatant.actionGauge = 0;
  }

  private getModifierTotal(combatant: BattleCombatant, type: ModifierType): number {
    return combatant.effects
      .filter(e => e.category === "modifier" && e.modifierType === type)
      .reduce((sum, e) => sum + (e.modifierValue ?? 0) * e.stacks, 0);
  }
}
