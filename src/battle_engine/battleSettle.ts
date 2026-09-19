import type { BattleState, BattleResult, BattleCombatant, BattleOutcome, LootEntry } from "./types";
import { protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import type { Npc } from "../role_core/Npc";
import type { InventoryStackItem, TreasureItemDefinition, GongfaItemDefinition } from "../role_core/types/itemInfo";
import type { BattleTriggerEntry } from "../ai/state_generate";
import { gameLog } from "../log/gameLog";

/**
 * 从 NPC 的 equippedSlots（法宝）+ gongfaSlots（功法）中随机抽取一件作为战利品。
 *
 * 纯游戏性掉落，不经过 AI。候选池为空（敌人既无法宝也无功法）返回 null。
 * 采用浅拷贝 + 重置 count/mastery，避免共享引用污染 NPC 数据（NPC 槽位不移除）。
 */
function rollLootFromNpc(npc: Npc): { item: InventoryStackItem; kind: "法宝" | "功法" } | null {
  const candidates: Array<{ item: InventoryStackItem; kind: "法宝" | "功法" }> = [];
  for (const tr of npc.equippedSlots) {
    if (tr) candidates.push({ item: tr as TreasureItemDefinition, kind: "法宝" });
  }
  for (const gf of npc.gongfaSlots) {
    if (gf) candidates.push({ item: gf as GongfaItemDefinition, kind: "功法" });
  }
  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const loot = { ...pick.item, count: 1 } as InventoryStackItem;
  if (pick.kind === "功法") {
    const g = loot as GongfaItemDefinition;
    g.mastery = 1;
    g.masteryExp = 0;
  }
  return { item: loot, kind: pick.kind };
}

export interface SettleBattleOptions {
  /** 主角战败是否身亡（正常/困难=true；简单=false，主角不会死亡）。 */
  protagonistCanDie?: boolean;
  /** 队友战败是否身亡（正常/困难=true；简单=false，队友不会死亡）。 */
  companionsCanDie?: boolean;
}

/**
 * 死斗中**胜方**血量归零者的存活概率（2026-09 规则）。
 *
 * 七成留一条命（重伤昏死 / 被同伴抢回），三成真死。
 * 注意：只有胜方享有这七成；败方倒下者没有优待（见 {@link resolveFate}）。
 */
export const DEATH_MATCH_SURVIVE_RATE = 0.7;

/** 掷一次生死：true = 活下来。 */
function rollSurvives(rate = DEATH_MATCH_SURVIVE_RATE): boolean {
  return Math.random() < rate;
}

/**
 * 血量归零者的生死判定。
 *
 * - **切磋（spar）**：点到为止，任何人血量归零都不会死（昏厥 / 认输 / 被扶起）。
 * - **死斗（kill）· 胜方**：七成存活（重伤）、三成真死。
 * - **死斗（kill）· 败方**：无优待，倒下即真死。
 * - 难度开关优先：`canDie=false`（简单模式）时必不死亡。
 *
 * 注：**敌方倒下者不在结算时判生死**——交由战后的处置环节决定
 * （玩家选"饶命 / 补刀 / 索取财物"，由 AI 写进剧情，再经状态 AI 的
 * `<MJ_NPC_CORE_CHANGE_TAG>` 死亡事件落地），见 `enemiesDowned`。
 */
export function resolveFate(
  isSpar: boolean,
  canDie: boolean,
  isWinner: boolean,
): "alive" | "dead" {
  if (isSpar) return "alive";
  if (!canDie) return "alive";
  if (!isWinner) return "dead";
  return rollSurvives() ? "alive" : "dead";
}

export function settleBattle(state: BattleState, opts?: SettleBattleOptions): BattleResult {
  const trigger = state.triggerEntry as BattleTriggerEntry;
  const protagonistCombatant = state.allies.find(a => a.isProtagonist);
  const elixirsUsed: { name: string; count: number }[] = [];
  const enemiesKilled: string[] = [];
  const protagonistCanDie = opts?.protagonistCanDie ?? true;
  const companionsCanDie = opts?.companionsCanDie ?? true;
  // 战斗性质：spar=切磋（不死人），kill=死斗。缺省按死斗。
  const isSpar = trigger.lethality === "spar";
  /** 主角一方是否获胜——只有胜方倒下者才享 70% 存活（重伤）。 */
  const isVictory = state.phase === "victory";

  const elixirMap = new Map<string, number>();
  for (const ally of state.allies) {
    for (const el of ally.elixirs) {
      const original = el.count;
      if (original <= 0) continue;
      const used = (elixirMap.get(el.name) ?? 0) + (original > el.count ? original - el.count : 0);
      elixirMap.set(el.name, used);
    }
  }
  for (const [name, count] of elixirMap) {
    if (count > 0) elixirsUsed.push({ name, count });
  }

  // 敌方倒下者**不在结算时判生死**：留给战后处置（玩家表态 → AI 写剧情 → 状态 AI 落地）。
  // 这里只统计名单，并保底 1 HP，避免他们以 0 血"活着"造成 UI 与快照歧义。
  const enemiesDowned: string[] = [];
  for (const enemy of state.enemies) {
    if (enemy.isDead && enemy.sourceNpcName) {
      enemiesDowned.push(enemy.sourceNpcName);
    }
  }

  const p = protagonist.value;
  let protagonistDied = false;
  if (p && protagonistCombatant) {
    // 主角被打下（战败，或虽胜但本人已倒下）时按战斗性质判生死。
    const protagonistDown = state.phase === "defeat" || protagonistCombatant.isDead;
    if (protagonistDown) {
      const fate = resolveFate(isSpar, protagonistCanDie, isVictory);
      if (fate === "dead") {
        // 死斗败方（或胜方那三成）：主角身亡，HP 归零（由 App.vue 路由到结局页）。
        p.setCurrentHpMp(0, 0);
        protagonistDied = true;
      } else {
        // 切磋 / 死斗胜方七成：侥幸生还，保底 1 HP。
        p.setCurrentHpMp(1, Math.max(0, Math.round(p.maxMp * 0.1)));
        gameLog.info(
          isSpar
            ? "[战斗结算] 切磋之战，主角落败但无性命之忧。"
            : "[战斗结算] 死斗之中主角重伤倒地，侥幸留得性命。",
        );
      }
    } else {
      const hpPct = protagonistCombatant.stats.maxHp > 0
        ? Math.round(protagonistCombatant.hp / protagonistCombatant.stats.maxHp * 100)
        : 0;
      const mpPct = protagonistCombatant.stats.maxMp > 0
        ? Math.round(protagonistCombatant.mp / protagonistCombatant.stats.maxMp * 100)
        : 0;
      p.setCurrentHpMp(
        Math.round(p.maxHp * hpPct / 100),
        Math.round(p.maxMp * mpPct / 100),
      );
    }
  }

  if (elixirsUsed.length > 0 && p) {
    for (const used of elixirsUsed) {
      let remaining = used.count;
      for (let i = 0; i < p.inventorySlots.length && remaining > 0; i++) {
        const slot = p.inventorySlots[i];
        if (!slot || !("name" in slot) || slot.name !== used.name) continue;
        const take = Math.min(remaining, slot.count);
        slot.count -= take;
        remaining -= take;
        if (slot.count <= 0) p.setInventorySlot(i, null);
      }
    }
  }

  const loot: LootEntry[] = [];
  const lootRecipient = p;
  for (const enemy of state.enemies) {
    if (enemy.isDead && enemy.sourceNpcName) {
      const npc = npcStore.getNpc(enemy.sourceNpcName);
      if (npc) {
        // 倒地但生死未定：不标记死亡，保底 1 HP（重伤昏厥）。
        // 是否补刀由战后处置决定——玩家的处置语句写进剧情后，
        // 由状态 AI 的 <MJ_NPC_CORE_CHANGE_TAG> 死亡事件落地。
        npc.setCurrentHpMp(1, npc.currentMp);

        // 战利品：胜利方搜刮倒地敌人（纯游戏性，不经 AI，与其是否身亡无关）。
        if (state.phase === "victory" && lootRecipient) {
          const rolled = rollLootFromNpc(npc);
          if (rolled) {
            const idx = lootRecipient.addToInventory(rolled.item);
            if (idx >= 0) {
              loot.push({
                enemyName: enemy.sourceNpcName,
                itemKind: rolled.kind,
                itemName: rolled.item.name,
              });
            } else {
              gameLog.warn(`[settleBattle] 储物袋已满，无法收取战利品「${rolled.item.name}」（来自 ${enemy.sourceNpcName}）`);
            }
          }
        }
      }
    }
  }

  for (const ally of state.allies) {
    if (ally.isProtagonist || !ally.sourceNpcName) continue;
    const npc = npcStore.getNpc(ally.sourceNpcName);
    if (!npc) continue;

    if (ally.isDead) {
      // 队友生死：胜方倒下七成活（重伤），败方倒下（死斗）真死；切磋必活。
      if (resolveFate(isSpar, companionsCanDie, isVictory) === "dead") {
        npc.isDead = true;
        npc.currentHp = 0;
      } else {
        npc.setCurrentHpMp(1, npc.currentMp);
      }
    } else {
      const hpPct = ally.stats.maxHp > 0 ? Math.round(ally.hp / ally.stats.maxHp * 100) : 0;
      const mpPct = ally.stats.maxMp > 0 ? Math.round(ally.mp / ally.stats.maxMp * 100) : 0;
      npc.setCurrentHpMp(
        Math.round(npc.maxHp * hpPct / 100),
        Math.round(npc.maxMp * mpPct / 100),
      );
    }
  }

  const outcome: BattleOutcome = state.phase === "victory" ? "victory"
    : state.phase === "defeat" ? "defeat"
    : state.phase === "fled" ? "fled"
    : "fled";

  return {
    outcome,
    actionCount: state.actionCount,
    protagonistHpPercent: protagonistCombatant ? Math.round(protagonistCombatant.hp / Math.max(1, protagonistCombatant.stats.maxHp) * 100) : 0,
    protagonistMpPercent: protagonistCombatant ? Math.round(protagonistCombatant.mp / Math.max(1, protagonistCombatant.stats.maxMp) * 100) : 0,
    elixirsUsed,
    enemiesKilled,
    /** 倒地但生死未定的敌人：交由战后处置决定（不再在结算时判死）。 */
    enemiesDowned,
    triggerReason: trigger.triggerReason,
    allyNames: trigger.allies.map(a => a.displayName),
    enemyNames: trigger.enemies.map(e => e.displayName),
    triggerKind: trigger.triggerKind,
    lethality: isSpar ? "spar" : "kill",
    loot,
    protagonistDied,
  };
}
