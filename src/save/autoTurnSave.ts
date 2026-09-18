/**
 * @fileoverview 回合自动存档：滚动保留最近 N 个回合的存档快照。
 *
 * 语义：在**每个回合开始时**把「上一回合结束时的完整状态」另存为一份独立存档。
 * 于是玩家随时可以回滚到最近 N 个回合中的任意一个起点，而不必从头再来。
 *
 * 为什么在回合开始时存而不是结束时存：结束时存的内容与 `writeActiveSave` 写入的
 * 活动存档完全重复，白占一倍空间；回合开始时存，快照 = 上一回合结束态，
 * 与活动存档天然错开，N 份快照就是 N 个「过去」。
 *
 * 存储风险与兜底：存档含 dataURL 立绘，单份可达数百 KB～数 MB，而 localStorage
 * 一般只有 5MB。因此写入失败（配额超限）时会**从最旧的自动快照开始丢弃并重试**，
 * 最多重试 3 次；仍失败则放弃本次快照，绝不影响正常游玩与主存档。
 */

import { ref } from "vue";
import { storyStore } from "../role_core/storyStore";
import { formatWorldLocation } from "../role_core/types/worldLocation";
import { gameLog } from "../log/gameLog";
import {
  serializeAll,
  writeSaveBlob,
  readIndexRaw,
  writeIndexRaw,
  upsertIndex,
  removeSave,
  getActiveSaveId,
  type MjSavePayload,
  type SaveIndexEntry,
} from "./gameSave";

/** 本地持久化的「保留回合数」键。 */
export const AUTO_TURN_SAVE_KEY = "MJ_AUTO_TURN_SAVES_V1";
/** 默认保留最近 3 个回合。 */
export const DEFAULT_AUTO_TURN_SAVES = 3;
/** 上限：再多就会明显挤占 localStorage 配额。 */
export const MAX_AUTO_TURN_SAVES = 10;

/** 当前保留的回合快照数量（0 = 关闭自动快照）。 */
export const autoTurnSaveCount = ref<number>(readStoredCount());

function readStoredCount(): number {
  try {
    const raw = localStorage.getItem(AUTO_TURN_SAVE_KEY);
    if (raw == null) return DEFAULT_AUTO_TURN_SAVES;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_AUTO_TURN_SAVES;
    return clampCount(Math.floor(n));
  } catch {
    return DEFAULT_AUTO_TURN_SAVES;
  }
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_AUTO_TURN_SAVES;
  return Math.max(0, Math.min(MAX_AUTO_TURN_SAVES, Math.floor(n)));
}

/**
 * 设置保留的回合快照数量并立即轮转（调小后立即删除超出的旧快照）。
 * @param n 0 表示关闭；超出 [0, MAX_AUTO_TURN_SAVES] 会被夹取。
 */
export function setAutoTurnSaveCount(n: number): void {
  const v = clampCount(n);
  autoTurnSaveCount.value = v;
  try {
    localStorage.setItem(AUTO_TURN_SAVE_KEY, String(v));
  } catch {
    /* ignore */
  }
  // 数量调小后立刻把超出的旧快照清掉，避免占着配额。
  const activeId = getActiveSaveId();
  if (activeId) pruneAutoTurnSaves(resolveBaseId(activeId), v);
  else pruneAllAutoTurnSaves(v);
}

// ---------------------------------------------------------------------------
// 快照 id 与轮转
// ---------------------------------------------------------------------------

/** 快照 id 形如 `${baseId}~T${turn}`。 */
const SNAPSHOT_SUFFIX = /~T(\d+)$/;

/**
 * 判定某个存档 id 是否为回合快照。
 * 读取快照后活动存档会变成快照 id，UI 需要据此提示玩家。
 */
export function isAutoTurnSaveId(id: string): boolean {
  return SNAPSHOT_SUFFIX.test(id);
}

/** 解析活动存档所属的主存档 id（若活动存档本身就是快照，则回溯到它的 baseId）。 */
function resolveBaseId(activeId: string): string {
  const entry = readIndexRaw().find((e) => e && e.id === activeId);
  return entry?.auto?.baseId || activeId;
}

/** 列出挂在 baseId 下的全部快照，按回合序号升序。 */
export function listAutoTurnSaves(baseId?: string): SaveIndexEntry[] {
  const base = baseId || resolveBaseId(getActiveSaveId() ?? "");
  if (!base) return [];
  return readIndexRaw()
    .filter((e) => e && e.auto && e.auto.baseId === base)
    .sort((a, b) => (a.auto?.turn ?? 0) - (b.auto?.turn ?? 0));
}

/** 下一个回合序号 = 现有最大序号 + 1。 */
function nextTurn(base: string): number {
  const list = listAutoTurnSaves(base);
  return list.length === 0 ? 1 : (list[list.length - 1].auto?.turn ?? 0) + 1;
}

/** 按保留数量裁剪：超出则从最旧开始删。 */
function pruneAutoTurnSaves(base: string, keep: number): void {
  if (!base) return;
  const list = listAutoTurnSaves(base);
  const overflow = list.length - keep;
  if (overflow <= 0) return;
  for (let i = 0; i < overflow; i++) {
    removeSave(list[i].id);
    gameLog.info(`[自动存档] 已淘汰旧快照：${list[i].id}（超出保留 ${keep} 个）`);
  }
}

/** 全量裁剪（无活动存档时按每个 baseId 分别裁）。 */
function pruneAllAutoTurnSaves(keep: number): void {
  const bases = new Set<string>();
  for (const e of readIndexRaw()) {
    if (e?.auto?.baseId) bases.add(e.auto.baseId);
  }
  for (const b of bases) pruneAutoTurnSaves(b, keep);
}

/** 配额不足时丢弃的一批候选：优先最旧的自动快照（全库），其次当前 base 的最旧。 */
function dropOldestAutoSnapshot(base: string): boolean {
  const all = readIndexRaw().filter((e) => e && e.auto);
  if (all.length === 0) return false;
  // 先丢当前存档链上最旧的，实在没有再丢别的主存档的旧快照。
  const mine = all.filter((e) => e.auto?.baseId === base);
  const target = (mine.length > 0 ? mine : all).sort(
    (a, b) => (a.auto?.turn ?? 0) - (b.auto?.turn ?? 0),
  )[0];
  removeSave(target.id);
  gameLog.warn(`[自动存档] 存储空间不足，已丢弃旧快照：${target.id}`);
  return true;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 捕获一份回合快照（应在回合开始时、任何状态改动之前调用）。
 *
 * 守卫：数量设为 0 / 无活动存档 / 剧情未就绪（开局生成中或已终结）/ 载荷不完整 → 跳过。
 *
 * @returns 新建快照的 id；跳过或失败返回 null。
 */
export function captureAutoTurnSave(): string | null {
  const keep = autoTurnSaveCount.value;
  if (keep <= 0) return null;

  const activeId = getActiveSaveId();
  if (!activeId) return null;
  // 开局生成中（loading）或已终结（ended）不存：前者是半成品，后者没有继续意义。
  if (storyStore.phase.value !== "ready") return null;

  const payload: MjSavePayload | null = serializeAll();
  if (!payload || !payload.protagonist || !payload.story) return null;

  const base = resolveBaseId(activeId);
  const turn = nextTurn(base);
  const id = `${base}~T${turn}`;

  // 配额超限兜底：丢弃最旧的自动快照后重试，最多 3 次。
  let ok = writeSaveBlob(id, payload);
  for (let i = 0; !ok && i < 3; i++) {
    if (!dropOldestAutoSnapshot(base)) break;
    ok = writeSaveBlob(id, payload);
  }
  if (!ok) {
    gameLog.warn(`[自动存档] 快照写入失败（空间不足）：${id}`);
    return null;
  }

  const baseEntry = readIndexRaw().find((e) => e && e.id === base);
  const baseName = baseEntry?.name || (payload.fateChoice.basics?.playerName ?? "").trim() || base;
  const entry: SaveIndexEntry = {
    id,
    name: `${baseName} · 第${turn}回合`,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    realm: (payload.protagonist.realm?.major || "") + (payload.protagonist.realm?.minor || ""),
    location: formatWorldLocation(payload.story.worldLocation),
    auto: { turn, baseId: base },
  };
  upsertIndex(entry);
  pruneAutoTurnSaves(base, keep);
  gameLog.info(`[自动存档] 已保存第 ${turn} 回合快照：${id}`);
  return id;
}
