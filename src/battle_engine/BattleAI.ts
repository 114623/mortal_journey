import type { BattleCombatant, BattleState, BattleAction, BattleEngineLike } from "./types";
import { ELIXIR_COST } from "./constants";

export class BattleAI {
  decide(actor: BattleCombatant, state: BattleState, engine: BattleEngineLike): BattleAction | null {
    const enemies = actor.team === "ally" ? state.enemies : state.allies;
    const aliveEnemies = enemies.filter(e => !e.isDead);
    if (aliveEnemies.length === 0) return null;

    if (!engine.effectManager.canAct(actor)) return null;

    const canUseSkills = engine.effectManager.canUseSkills(actor);

    if (canUseSkills) {
      const skillAction = this.trySelectSkill(actor, state, aliveEnemies);
      if (skillAction) return skillAction;
    }

    if (actor.hp < actor.stats.maxHp * 0.3) {
      const elixirIdx = actor.elixirs.findIndex(e => e.effectType === "healHp" && e.count > 0);
      if (elixirIdx >= 0) {
        return { type: "elixir", elixirIndex: elixirIdx };
      }
    }

    if (actor.mp < actor.stats.maxMp * 0.3) {
      const elixirIdx = actor.elixirs.findIndex(e => e.effectType === "healMp" && e.count > 0);
      if (elixirIdx >= 0) {
        return { type: "elixir", elixirIndex: elixirIdx };
      }
    }

    const target = this.selectTarget(aliveEnemies);
    if (target) return { type: "normalAttack", targetId: target.id };

    return null;
  }

  private trySelectSkill(actor: BattleCombatant, state: BattleState, aliveEnemies: BattleCombatant[]): BattleAction | null {
    for (let i = 0; i < actor.skills.length; i++) {
      const skill = actor.skills[i];
      if (actor.cooldowns[i] > 0) continue;
      if (skill.mpCost > actor.mp) continue;
      if (Math.random() > 0.4) continue;

      if (skill.needTarget && aliveEnemies.length > 0) {
        const target = this.selectTarget(aliveEnemies);
        if (target) return { type: "skill", skillIndex: i, targetId: target.id };
      } else if (!skill.needTarget) {
        const allies = actor.team === "ally" ? state.allies : state.enemies;
        const self = allies.find(a => a.id === actor.id);
        return { type: "skill", skillIndex: i, targetId: self?.id ?? actor.id };
      }
    }
    return null;
  }

  private selectTarget(aliveEnemies: BattleCombatant[]): BattleCombatant | null {
    if (aliveEnemies.length === 0) return null;
    const lowestHp = aliveEnemies.reduce((a, b) => a.hp < b.hp ? a : b);
    if (Math.random() < 0.6) return lowestHp;
    return aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
  }
}
