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
import { resolveNpcId } from "./npcId";
import { gameLog } from "../log/gameLog";

/**
 * NPC 主键：稳定 npcId（Npc.id）。
 *
 * 同名 NPC 天然共存（不再靠「（2）（3）」后缀另建卡）；改名只改 displayName，
 * 不动键。按名查询 {@link getNpc} 仅供 UI 重名校验等场景，主查询一律走
 * {@link getNpcById}。
 */
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

/**
 * 合成 id 撞车防护：AI 群体同名输出（未给 id）会在同地点算出同一个合成 id；
 * AI 直给的 id 也可能重复。命中已占用 id 时按「身份#序号」重新合成，保证一人一格。
 *
 * 前提：调用方在入库**之后**调用（撞车判定即查 Map）。
 */
function ensureUniqueId(npc: Npc, currentLocation: WorldLocation | null): void {
  if (!npcMap.value.has(npc.id)) return;
  const identity = (npc.identity ?? "").trim();
  let seq = 2;
  let candidate = resolveNpcId(undefined, npc.displayName, `${identity}#${seq}`, currentLocation);
  while (npcMap.value.has(candidate)) {
    seq += 1;
    candidate = resolveNpcId(undefined, npc.displayName, `${identity}#${seq}`, currentLocation);
  }
  gameLog.warn(
    `[NpcStore] NPC id 撞车（${npc.id}），已为「${npc.displayName}」重新生成唯一 id（${candidate}）。`,
  );
  npc.id = candidate;
}

/** 触发「重要羁绊」简表的门槛（绝对值）。 */
export const NPC_BOND_FAVOR_THRESHOLD = 40;
/** 触发「重要羁绊」简表的 powerTier 集合。 */
const NPC_BOND_POWER_TIERS: ReadonlySet<PowerTier> = new Set(["小boss", "大boss"]);

export function useNpcStore() {
  /** 按稳定 npcId 查找（主键直查，O(1)）。 */
  function findByNpcId(npcId: string): Npc | undefined {
    if (!npcId) return undefined;
    return npcMap.value.get(npcId);
  }

  /** 按显示名线性查找。仅供 UI 重名校验等场景；主查询走 {@link getNpcById}。 */
  function getNpc(displayName: string): Npc | undefined {
    if (!displayName) return undefined;
    for (const npc of npcMap.value.values()) {
      if (npc.displayName === displayName) return npc;
    }
    return undefined;
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
   * 匹配顺序：① entry.npcId 命中已有 NPC 的稳定 id；② 回退到按 displayName 线性匹配。
   * 已存在 NPC 调 {@link Npc.mergeFromAi}（白名单策略，核心层默认冻结）；
   * 新 NPC 调 {@link Npc.fromAiData} 构造，currentLocation 取 entry.currentLocation 或回退到 options.currentLocation。
   * 全部 nearbyNpcs 处理完后，统一标记为 active 并刷新 lastSeen。最后应用 coreChangeEvents。
   *
   * 主键是 npcId，同名 NPC 天然共存：AI 群体同名输出（五名守山弟子）各自建卡，
   * 不再塌成一人——本回合已被按名/按 id 命中过的人不再重复命中（防同名条目全并进第一人）。
   * 按 npcId 命中但显示名不同 → 视为 AI 改名（更新显示名，键不动）。
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
    /** 本回合已被按 id 命中过的 npcId（AI 群体输出会带相同 id，第二个起视为新人）。 */
    const usedIds = new Set<string>();
    /** 本回合已被按名命中过的显示名（无 id 的同名群体条目，第二个起视为新人）。 */
    const usedNames = new Set<string>();

    for (const entry of entries) {
      const name = entry.displayName?.trim();
      if (!name) continue;

      const existingByNpcId = entry.npcId ? findByNpcId(entry.npcId) : undefined;
      let existing = existingByNpcId;
      // 该 id 本回合已被命中过（AI 群体输出同 id）→ 当作另一个人。
      if (existing && entry.npcId && usedIds.has(entry.npcId)) existing = undefined;
      // 回退按名匹配：名字本回合已被占用（且不是按 npcId 精确命中）→ 视为新个人。
      if (!existing && !usedNames.has(name)) existing = getNpc(name);

      if (existing) {
        // 按 npcId 命中但显示名不同 → 视为 AI 改名（主键是 id，直接改显示名即可）。
        if (existingByNpcId && existingByNpcId.displayName !== name) {
          gameLog.info(
            `[NpcStore] 「${existingByNpcId.displayName}」被 AI 改名为「${name}」（npcId 一致，视为同一人）。`,
          );
          existingByNpcId.setDisplayName(name);
        }
        existing.mergeFromAi(entry, protagonistLinggen);
        touchedThisRound.add(existing);
        usedIds.add(existing.id);
        usedNames.add(existing.displayName);
      } else {
        const npc = Npc.fromAiData(
          { ...entry, displayName: name },
          protagonistLinggen,
          currentLocation,
          currentWorldTime,
        );
        npcMap.value.set(npc.id, npc);
        ensureUniqueId(npc, currentLocation);
        touchedThisRound.add(npc);
        createdThisRound.push(npc);
        usedIds.add(npc.id);
        usedNames.add(name);
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
      // 存档迁移：老存档 NPC 可能没有 id——按合成规则补齐（迁移点，只此一处），
      // 否则 findByNpcId 对该 NPC 永远 miss。id 在 Character 构造器里无兜底，必须先补。
      const fixed = d.id ? d : { ...d, id: resolveNpcId(undefined, d.displayName ?? "", d.identity ?? "", d.currentLocation ?? null) };
      const npc = Npc.fromData(fixed);
      npcMap.value.set(npc.id, npc);
      ensureUniqueId(npc, npc.currentLocation);
    }
  }

  function clearNpcs(): void {
    npcMap.value.clear();
  }

  function setNpc(npc: Npc): void {
    npcMap.value.set(npc.id, npc);
  }

  function removeNpc(npcId: string): void {
    npcMap.value.delete(npcId);
  }

  /** 按显示名删除（仅供测试假人清理等按名场景；正式链路请用 {@link removeNpc}(npcId)）。 */
  function removeNpcByName(displayName: string): void {
    const npc = getNpc(displayName);
    if (npc) npcMap.value.delete(npc.id);
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
    removeNpcByName,
    lastSeenScore,
    sortByRecent,
  };
}

export const npcStore = useNpcStore();
