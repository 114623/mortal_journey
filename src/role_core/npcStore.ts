import { ref, type Ref } from "vue";
import { Npc } from "./Npc";
import type { NpcPlayInfo, PowerTier } from "./types/playInfo";
import type { NpcNearbyEntry } from "../ai/state_generate";
import type { NpcCoreChangeEvent } from "./npcCoreChange";
import { applyCoreChange } from "./npcCoreChange";
import type { WorldLocation } from "./types/worldLocation";
import { isWorldLocationEqual } from "./types/worldLocation";
import type { WorldTime } from "./worldTime";
import { cloneWorldTime, createDefaultWorldTime, worldTimeToDays } from "./worldTime";

const npcMap: Ref<Map<string, Npc>> = ref(new Map());

/** applyNpcUpdates 的可选项。 */
export interface ApplyNpcUpdatesOptions {
  /** AI 声明的核心字段变更事件（来自 <MJ_NPC_CORE_CHANGE_TAG>）。 */
  coreChangeEvents?: NpcCoreChangeEvent[];
  /** 当前所在地点，用于为新建 NPC 合成稳定的 npcId 并作为 currentLocation 回退。 */
  currentLocation?: WorldLocation | null;
  /** 当前世界时间，用于写入 NPC.lastSeenWorldTime。 */
  currentWorldTime?: WorldTime | null;
}

/** 触发「重要羁绊」简表的门槛（绝对值）。 */
export const NPC_BOND_FAVOR_THRESHOLD = 40;
/** 触发「重要羁绊」简表的 powerTier 集合。 */
const NPC_BOND_POWER_TIERS: ReadonlySet<PowerTier> = new Set(["小boss", "大boss"]);

export function useNpcStore() {
  /** 按稳定 npcId（Npc.id）查找。 */
  function findByNpcId(npcId: string): Npc | undefined {
    if (!npcId) return undefined;
    for (const npc of npcMap.value.values()) {
      if (npc.id === npcId) return npc;
    }
    return undefined;
  }

  function getNpc(displayName: string): Npc | undefined {
    return npcMap.value.get(displayName);
  }

  function getNpcById(npcId: string): Npc | undefined {
    return findByNpcId(npcId);
  }

  function allNpcs(): Npc[] {
    return Array.from(npcMap.value.values());
  }

  // ─────────────────────────────────────────────────────────────────
  // 地点 / 状态机 查询
  // ─────────────────────────────────────────────────────────────────

  /** 当前所在地点匹配 loc 的所有 NPC。 */
  function getNpcsAtLocation(loc: WorldLocation | null | undefined): Npc[] {
    if (!loc) return [];
    return allNpcs().filter(n => n.currentLocation && isWorldLocationEqual(n.currentLocation, loc));
  }

  /** 当前在主角所在地点且 presence=active 的 NPC。 */
  function getActiveNpcsAt(loc: WorldLocation | null | undefined): Npc[] {
    return getNpcsAtLocation(loc).filter(n => n.presence === "active");
  }

  /** 归属本地点但 presence=dormant 的 NPC（主角离开期间休眠者）。 */
  function getDormantNpcsAt(loc: WorldLocation | null | undefined): Npc[] {
    return getNpcsAtLocation(loc).filter(n => n.presence === "dormant");
  }

  /** 「重要羁绊」NPC：高好感或 boss 级，无论身在何方。 */
  function getBondedNpcs(threshold = NPC_BOND_FAVOR_THRESHOLD): Npc[] {
    return allNpcs().filter(n =>
      Math.abs(n.favorability) >= threshold || NPC_BOND_POWER_TIERS.has(n.powerTier),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // 状态机维护
  // ─────────────────────────────────────────────────────────────────

  /** 把指定 NPC 标记为在场：presence=active，刷新 lastSeen，encounterCount++。 */
  function markActive(npc: Npc, worldTime: WorldTime | null | undefined): void {
    npc.presence = npc.isDead ? "dead" : "active";
    npc.lastSeenWorldTime = worldTime ? cloneWorldTime(worldTime) : npc.lastSeenWorldTime;
    npc.encounterCount += 1;
  }

  /**
   * 主角离开某地点时调用：把该地点所有 active 的 NPC 置为 dormant（保留全部数据，
   * 等待主角回归时唤醒）。dead 状态不变。
   */
  function markDormantAtLocation(loc: WorldLocation | null | undefined): void {
    if (!loc) return;
    for (const npc of getNpcsAtLocation(loc)) {
      if (npc.presence === "active" && !npc.isDead) {
        npc.presence = "dormant";
      }
    }
  }

  /**
   * 主角进入某地点时调用：把该地点所有 dormant 的 NPC 唤醒为 active（不触发重评估，
   * 重评估由 onEnterLocation 钩子在 P3 单独处理）。
   */
  function wakeDormantAtLocation(loc: WorldLocation | null | undefined, worldTime: WorldTime | null | undefined): Npc[] {
    if (!loc) return [];
    const woken: Npc[] = [];
    for (const npc of getNpcsAtLocation(loc)) {
      if (npc.presence === "dormant" && !npc.isDead) {
        npc.presence = "active";
        npc.lastSeenWorldTime = worldTime ? cloneWorldTime(worldTime) : npc.lastSeenWorldTime;
        woken.push(npc);
      }
    }
    return woken;
  }

  // ─────────────────────────────────────────────────────────────────
  // 主入口：AI nearbyNpcs 合并 + 核心变更应用 + 在场标记
  // ─────────────────────────────────────────────────────────────────

  /**
   * 把 AI 返回的 nearbyNpcs 合并进 store，并应用核心变更事件。
   *
   * 匹配顺序：① entry.npcId 命中已有 NPC 的稳定 id；② 回退到按 displayName 匹配。
   * 已存在 NPC 调 {@link Npc.mergeFromAi}（白名单策略，核心层默认冻结）。
    * 新 NPC 调 {@link Npc.fromAiData} 构造，currentLocation 取 entry.currentLocation 或回退到 options.currentLocation。
    * 全部 nearbyNpcs 处理完后，统一标记为 active 并刷新 lastSeen。
    * 最后应用 coreChangeEvents。
    * @return 本次新建的 NPC 列表（供调用方按需触发立绘自动生成等副作用）。
    */
  function applyNpcUpdates(
    entries: NpcNearbyEntry[],
    protagonistLinggen?: string[],
    options?: ApplyNpcUpdatesOptions,
  ): Npc[] {
    const currentLocation = options?.currentLocation ?? null;
    const currentWorldTime = options?.currentWorldTime ?? null;
    const touchedThisRound = new Set<Npc>();
    const createdThisRound: Npc[] = [];

    for (const entry of entries) {
      const name = entry.displayName?.trim();
      if (!name) continue;

      const existingByNpcId = entry.npcId ? findByNpcId(entry.npcId) : undefined;
      const existing = existingByNpcId ?? npcMap.value.get(name);
      if (existing) {
        existing.mergeFromAi(entry, protagonistLinggen);
        // 若 AI 这次给了 npcId 而旧 NPC 没有稳定 id，补记一下（便于后续按 id 查）。
        if (entry.npcId && existing.id !== entry.npcId && !existing.id.startsWith("npc_")) {
          // id 已稳定存储，保留不动，避免身份漂移
        }
        touchedThisRound.add(existing);
      } else {
        const npc = Npc.fromAiData(entry, protagonistLinggen, currentLocation, currentWorldTime);
        npcMap.value.set(name, npc);
        touchedThisRound.add(npc);
        createdThisRound.push(npc);
      }
    }

    // 统一标记本回合出场者为 active。
    for (const npc of touchedThisRound) {
      markActive(npc, currentWorldTime);
    }

    if (options?.coreChangeEvents && options.coreChangeEvents.length > 0) {
      for (const event of options.coreChangeEvents) {
        const npc = findByNpcId(event.npcId);
        if (npc) {
          applyCoreChange(npc, event, protagonistLinggen);
          // 死亡事件需同步 presence。
          if (event.kind === "death") npc.presence = "dead";
        }
      }
    }

    return createdThisRound;
  }

  /**
   * 批量应用重评估结果（核心层整体替换）。
   *
   * 由 onEnterLocation 钩子在主角回到长期未见的 dormant NPC 所在地时调用。
   * 按 entry.npcId 查找目标 NPC，调 {@link Npc.applyReevaluation} 整体替换境界/装备/功法/储物袋。
   */
  function applyReevaluation(entries: NpcNearbyEntry[], protagonistLinggen?: string[]): void {
    for (const entry of entries) {
      if (!entry.npcId) continue;
      const npc = findByNpcId(entry.npcId);
      if (npc) npc.applyReevaluation(entry, protagonistLinggen);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 最近出场排序
  // ─────────────────────────────────────────────────────────────────

  /**
   * 「最近出场」分：越大越靠前。
   *
   * 以 `lastSeenWorldTime` 折算成绝对小时数（世界时间已在存档里，无需新增字段，
   * 读档后顺序照常保留）。从未记录过出场时间的 NPC 返回 -Infinity，排在所有条目之后。
   */
  function lastSeenScore(npc: Npc): number {
    const t = npc.lastSeenWorldTime;
    if (!t) return Number.NEGATIVE_INFINITY;
    return worldTimeToDays(t) * 24 + (t.hour ?? 0);
  }

  /** 按最近出场排序（新近在前）；时间相同则按名字，保证顺序稳定。 */
  function sortByRecent<T extends { npc: Npc } | Npc>(list: T[]): T[] {
    const npcOf = (x: T): Npc => ("npc" in x ? (x as { npc: Npc }).npc : (x as Npc));
    return list.slice().sort((a, b) => {
      const sa = lastSeenScore(npcOf(a));
      const sb = lastSeenScore(npcOf(b));
      // 两者都无出场时间时 -Infinity 相减为 NaN，需单独兜住。
      if (sa === sb) return npcOf(a).displayName.localeCompare(npcOf(b).displayName, "zh-Hans-CN");
      if (sa === Number.NEGATIVE_INFINITY) return 1;
      if (sb === Number.NEGATIVE_INFINITY) return -1;
      return sb - sa;
    });
  }

  function serializeNpcs(): NpcPlayInfo[] {
    const result: NpcPlayInfo[] = [];
    for (const npc of npcMap.value.values()) {
      result.push(npc.toData());
    }
    return result;
  }

  function restoreNpcs(data: NpcPlayInfo[]): void {
    npcMap.value.clear();
    for (const d of data) {
      const npc = Npc.fromData(d);
      npcMap.value.set(npc.displayName, npc);
    }
  }

  function clearNpcs(): void {
    npcMap.value.clear();
  }

  function setNpc(npc: Npc): void {
    npcMap.value.set(npc.displayName, npc);
  }

  function removeNpc(displayName: string): void {
    npcMap.value.delete(displayName);
  }

  return {
    npcs: npcMap,
    applyNpcUpdates,
    getNpc,
    getNpcById,
    allNpcs,
    getNpcsAtLocation,
    getActiveNpcsAt,
    getDormantNpcsAt,
    getBondedNpcs,
    markActive,
    markDormantAtLocation,
    wakeDormantAtLocation,
    applyReevaluation,
    serializeNpcs,
    restoreNpcs,
    clearNpcs,
    setNpc,
    removeNpc,
    lastSeenScore,
    sortByRecent,
  };
}

export const npcStore = useNpcStore();
