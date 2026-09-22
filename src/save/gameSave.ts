/**
 * @fileoverview 存档服务：自动存档的写入/读取/恢复/重置。
 *
 * 设计要点：
 *   - **自包含纯 JSON 载荷**：单 id 对应单个 blob，聚合四个数据源
 *     （主角 / NPC / 世界地图 / 剧情），无类实例、无 Map，天然可作云端「文档」。
 *   - **存储后端抽象** `SaveBackend`：默认 localStorage，日后云存档只需替换实现。
 *   - **自动存档**：本模块不提供 UI，仅暴露 `createSave` / `writeActiveSave` /
 *     `restoreSave` / `resetAllGameState`，由 `App.vue`、`useOpeningStory`、
 *     `StoryChatPanel` 在关键节点调用。
 *
 * 存档唯一标识：`${主角名}-${YYYYMMDD-HHMMSS}`。同一存档在会话中原地更新；
 * 开新人生才生成新存档。
 */

import type { FateChoiceResult, DifficultyLevel } from "../fate_choice/types";
import type { NpcPlayInfo, ProtagonistPlayInfo } from "../role_core/types/playInfo";
import type { WorldSettingsText } from "../ai/worldSettings";
import { readGlobalWorldSettings } from "../role_core/worldSettingsStore";
import type { PendingEditsSerial } from "../role_core/pendingEdits";
import type { WorldMapSerialData } from "../role_core/worldMapStore";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { formatWorldLocation } from "../role_core/types/worldLocation";
import { Protagonist, protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import { factionStore, type Faction } from "../role_core/factionStore";
import { chapterStore, type Chapter } from "../role_core/chapterStore";
import { worldMapStore } from "../role_core/worldMapStore";
import { locationImageStore, type LocationImagesSerialData } from "../role_core/locationImageStore";
import { storyStore, type StorySerialData } from "../role_core/storyStore";
import { worldSettings, setWorldSettings, loadGlobalWorldSettings } from "../role_core/worldSettingsStore";
import { serializePendingEdits, restorePendingEdits, clearAllPendingEdits } from "../role_core/pendingEdits";
import { backfillGongfaTiers, clampGongfaMasteryInHolder } from "../role_core/types/itemTier";
import { resetSceneProgress } from "../role_core/sceneBudgetStore";
import { gameLog } from "../log/gameLog";

export const SAVE_VERSION = 1;
export const SAVE_INDEX_KEY = "MJ_SAVES_INDEX_V1";
export const SAVE_PREFIX = "MJ_SAVE_V1:";
/** 当前活动存档 id 的本地持久化键——用于刷新网页后自动恢复到当前存档。 */
export const ACTIVE_SAVE_ID_KEY = "MJ_ACTIVE_SAVE_ID_V1";

// ---------------------------------------------------------------------------
// 活动存档 id 的持久化（刷新续玩）
// ---------------------------------------------------------------------------

function persistActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_SAVE_ID_KEY, id);
  } catch {
    /* ignore */
  }
}

/** 清除本地持久化的活动存档指针（返回标题=退出当前存档时调用）。 */
export function clearActiveId(): void {
  try {
    localStorage.removeItem(ACTIVE_SAVE_ID_KEY);
  } catch {
    /* ignore */
  }
}

/** 读取本地持久化的活动存档 id（无则 null）。 */
export function getPersistedActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SAVE_ID_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 存储后端抽象（云存档替换点）
// ---------------------------------------------------------------------------

export interface SaveBackend {
  read(id: string): string | null;
  /** 写入存档 blob；成功返回 true，配额超限等失败返回 false。 */
  write(id: string, blob: string): boolean;
  remove(id: string): void;
}

const localStorageBackend: SaveBackend = {
  read(id) {
    try {
      return localStorage.getItem(SAVE_PREFIX + id);
    } catch {
      return null;
    }
  },
  write(id, blob) {
    try {
      localStorage.setItem(SAVE_PREFIX + id, blob);
      return true;
    } catch (e) {
      // 主要是 QuotaExceededError：localStorage 一般仅 5MB，而存档含 dataURL 立绘。
      // 返回 false 让调用方（如回合自动存档）有机会丢弃旧快照后重试。
      gameLog.error("[GameSave] 写入存档失败：" + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  },
  remove(id) {
    try {
      localStorage.removeItem(SAVE_PREFIX + id);
    } catch {
      /* ignore */
    }
  },
};

let backend: SaveBackend = localStorageBackend;

/** 替换存储后端（云存档接入点）。 */
export function setSaveBackend(b: SaveBackend): void {
  backend = b;
}

// ---------------------------------------------------------------------------
// 存档载荷与索引
// ---------------------------------------------------------------------------

/**
 * 完整存档载荷。占位存档（开局 AI 尚未完成）仅含 `fateChoice` 并标记 `incomplete`，
 * 其余字段缺省；读档时由 {@link isCompleteSave} 判定是否直接恢复。
 */
export interface MjSavePayload {
  version: number;
  fateChoice: FateChoiceResult;
  createdAt: number;
  updatedAt: number;
  /** 占位标记：开局 AI 未完成时写入；完整存档不带此字段。 */
  incomplete?: true;
  /** 终结标记：主角死亡（寿尽/战败）后写入；该存档不可继续游玩。 */
  ended?: { reason: string; at: number };
  protagonist?: ProtagonistPlayInfo;
  npcs?: NpcPlayInfo[];
  worldMap?: WorldMapSerialData;
  locationImages?: LocationImagesSerialData;
  story?: StorySerialData;
  /** 玩家可编辑的世界设定（世界观/规则/预设）。旧存档缺省为内置默认。 */
  worldSettings?: WorldSettingsText;
  /** 回合进行中保存、尚未生效的改动。旧存档缺省为空队列。 */
  pendingEdits?: PendingEditsSerial;
  /** 已登记的势力档案。旧存档缺省为空表。 */
  factions?: Faction[];
  /** 当前篇章（玩家在世界设定里自己开）。旧存档缺省视为无篇章。 */
  chapter?: Chapter | null;
}

export interface SaveIndexEntry {
  id: string;
  /** 主角名。 */
  name: string;
  updatedAt: number;
  createdAt: number;
  /** 预览：境界（如「练气初期」）。 */
  realm?: string;
  /** 预览：当前地点。 */
  location?: string;
  /** 终结标记：主角已死亡，存档不可继续。 */
  ended?: boolean;
  /** 导入标记：从外部 JSON 导入的存档；游玩一次后由 writeActiveSave 重写即消失。 */
  imported?: boolean;
  /** 导入时刻（ms）。 */
  importedAt?: number;
  /**
   * 回合自动存档标记（由 `save/autoTurnSave` 写入）。
   * `baseId` 为其所属的主存档 id，`turn` 为回合序号（从 1 递增）。
   */
  auto?: { turn: number; baseId: string };
}

// ---------------------------------------------------------------------------
// 会话内的「活动存档」记账（模块级，供各处无入参调用 writeActiveSave）
// ---------------------------------------------------------------------------

let activeSaveId: string | null = null;
let activeCreatedAt: number = 0;
let activeFateChoice: FateChoiceResult | null = null;
/** 活动存档是否已终结。终结后禁止任何自动存档覆盖 ended 标记。 */
let activeEnded = false;

/** 设置当前会话的活动存档（读档时调用）。 */
export function setActiveSave(id: string, fateChoice: FateChoiceResult, createdAt: number): void {
  activeSaveId = id;
  activeFateChoice = fateChoice;
  activeCreatedAt = createdAt;
  activeEnded = isEndedSave(readSave(id));
  persistActiveId(id);
}

export function hasActiveSave(): boolean {
  return activeSaveId !== null;
}

/** 当前活动存档 id（无则 null）。 */
export function getActiveSaveId(): string | null {
  return activeSaveId;
}

/** 读取当前活动存档的难度等级；无活动存档或缺省时回退为「正常」。 */
export function getActiveDifficulty(): DifficultyLevel {
  return activeFateChoice?.basics?.difficulty ?? "正常";
}

// ---------------------------------------------------------------------------
// 索引读写
// ---------------------------------------------------------------------------

/**
 * 读取原始索引（顺序未整理）。
 * 供 `save/autoTurnSave` 复用——回合自动存档需按 `auto.baseId` 扫描与轮转。
 */
export function readIndexRaw(): SaveIndexEntry[] {
  try {
    const raw = localStorage.getItem(SAVE_INDEX_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as SaveIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/** 写入原始索引（供 `save/autoTurnSave` 复用）。 */
export function writeIndexRaw(arr: SaveIndexEntry[]): void {
  try {
    localStorage.setItem(SAVE_INDEX_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
  } catch {
    /* ignore */
  }
}

/** 读取存档索引（按 updatedAt 倒序），供 UI 列表使用。 */
export function readSaveIndex(): SaveIndexEntry[] {
  const idx = readIndexRaw().filter((x) => x && x.id);
  idx.sort((a, b) => Number(b?.updatedAt) - Number(a?.updatedAt));
  return idx;
}

/** 新增或更新索引条目（供 `save/autoTurnSave` 复用）。 */
export function upsertIndex(entry: SaveIndexEntry): void {
  const idx = readIndexRaw();
  const i = idx.findIndex((e) => e && e.id === entry.id);
  if (i >= 0) idx[i] = entry;
  else idx.push(entry);
  writeIndexRaw(idx);
}

// ---------------------------------------------------------------------------
// 序列化 / 反序列化
// ---------------------------------------------------------------------------

function realmPreview(p: ProtagonistPlayInfo): string {
  return (p.realm?.major || "") + (p.realm?.minor || "");
}

function locationPreview(loc: WorldLocation | null | undefined): string {
  return loc ? formatWorldLocation(loc) : "";
}

/** 聚合四个数据源构建完整存档载荷。protagonist 缺省时返回 null。 */
export function serializeAll(now = Date.now()): MjSavePayload | null {
  const p = protagonist.value;
  if (!p || !activeFateChoice) return null;
  return {
    version: SAVE_VERSION,
    fateChoice: activeFateChoice,
    createdAt: activeCreatedAt || now,
    updatedAt: now,
    protagonist: p.toData(),
    npcs: npcStore.serializeNpcs(),
    worldMap: worldMapStore.serializeWorldMap(),
    locationImages: locationImageStore.serialize(),
    story: storyStore.serializeStory(),
    worldSettings: { ...worldSettings.value },
    pendingEdits: serializePendingEdits(),
    factions: factionStore.serializeFactions(),
    chapter: chapterStore.serializeChapter(),
  };
}

/**
 * 写入当前活动存档（原地更新）。在 `phase !== "ready"`、无活动存档、无主角时跳过，
 * 避免存入战斗中或半成品状态。
 */
export function writeActiveSave(): void {
  if (!activeSaveId || !activeFateChoice) return;
  if (storyStore.phase.value !== "ready") return;
  if (activeEnded) return; // 已终结存档不再覆盖 ended 标记
  const payload = serializeAll();
  if (!payload || !payload.protagonist || !payload.story) return;
  backend.write(activeSaveId, JSON.stringify(payload));
  upsertIndex({
    id: activeSaveId,
    name: payload.fateChoice.basics.playerName || activeSaveId,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    realm: realmPreview(payload.protagonist),
    location: locationPreview(payload.story.worldLocation),
  });
}

/**
 * 标记当前活动存档为已终结（主角死亡：寿尽/战败）。
 * 绕过 `phase === "ready"` 门控——死亡必须落盘。在最近一次完整存档上叠加 `ended`
 * 标记（不重写运行时状态，避免在战斗/生成中途写入半成品数据）。
 */
export function markActiveSaveEnded(reason: string): void {
  if (!activeSaveId) return;
  const existing = readSave(activeSaveId);
  if (!existing) {
    gameLog.warn(`[GameSave] markActiveSaveEnded: 找不到存档 ${activeSaveId}，跳过`);
    return;
  }
  const payload: MjSavePayload = {
    ...existing,
    ended: { reason, at: Date.now() },
  };
  backend.write(activeSaveId, JSON.stringify(payload));
  activeEnded = true;
  const idx = readIndexRaw();
  const i = idx.findIndex((e) => e && e.id === activeSaveId);
  if (i >= 0) {
    idx[i] = { ...idx[i], ended: true };
    writeIndexRaw(idx);
  }
  gameLog.info(`[GameSave] 存档已标记终结：${activeSaveId}（${reason}）`);
}

/**
 * 命运抉择确认时创建存档：生成 id（名+时间），写入占位载荷并登记索引。
 * 开局 AI 完成后由 `writeActiveSave` 写入完整载荷。
 *
 * @returns 新建存档 id。
 */
export function createSave(fc: FateChoiceResult): string {
  const name = (fc.basics?.playerName || "").trim() || "未命名";
  const id = composeSaveId(name);
  const now = Date.now();
  activeSaveId = id;
  activeCreatedAt = now;
  activeFateChoice = fc;
  activeEnded = false;
  const placeholder: MjSavePayload = {
    version: SAVE_VERSION,
    fateChoice: fc,
    createdAt: now,
    updatedAt: now,
    incomplete: true,
  };
  backend.write(id, JSON.stringify(placeholder));
  upsertIndex({
    id,
    name,
    createdAt: now,
    updatedAt: now,
    realm: (fc.basics?.realmMajor || "") + (fc.basics?.realmMinor || ""),
    location: locationPreview(fc.basics?.birthPlace),
  });
  gameLog.info("[GameSave] 创建存档：" + id);
  persistActiveId(id);
  return id;
}

/**
 * 把给定载荷写入指定 id（不改动活动存档记账）。
 *
 * 供 `save/autoTurnSave` 写回合快照使用——需要知道写入是否成功，
 * 以便在 localStorage 配额超限时丢弃旧快照并重试。
 *
 * @returns 写入成功返回 true；配额超限等失败返回 false。
 */
export function writeSaveBlob(id: string, payload: MjSavePayload): boolean {
  return backend.write(id, JSON.stringify(payload));
}

/**
 * 从外部 JSON 载荷导入存档：校验后生成新 id（不覆盖现有存档），写入 blob 并登记索引。
 * 不会设为活动存档——导入后需在列表点「读取」才进入。
 * @returns 新存档 id；载荷非法（缺少 fateChoice）返回 null。
 */
export function importSave(payload: MjSavePayload): string | null {
  if (!payload || typeof payload !== "object" || !payload.fateChoice) return null;
  const name = (payload.fateChoice.basics?.playerName || "").trim() || "未命名";
  const id = uniqueSaveId(name);
  const now = Date.now();
  backend.write(id, JSON.stringify(payload));
  upsertIndex({
    id,
    name,
    createdAt: payload.createdAt || now,
    updatedAt: payload.updatedAt || now,
    realm: payload.protagonist ? realmPreview(payload.protagonist) : "",
    location: locationPreview(payload.story?.worldLocation),
    ended: isEndedSave(payload),
    imported: true,
    importedAt: now,
  });
  gameLog.info("[GameSave] 导入存档：" + id);
  return id;
}

/** 读取并存档载荷（不恢复到运行时状态）。损坏或不存在返回 null。 */
export function readSave(id: string): MjSavePayload | null {
  const raw = backend.read(id);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const p = obj as MjSavePayload;
    if (!p.fateChoice) return null;
    return p;
  } catch {
    return null;
  }
}

/** 判定存档是否为可直接恢复的完整存档。 */
export function isCompleteSave(p: MjSavePayload | null | undefined): boolean {
  return (
    !!p &&
    !p.incomplete &&
    !!p.protagonist &&
    !!p.story &&
    Array.isArray(p.story.chatMessages) &&
    p.story.chatMessages.length > 0
  );
}

/** 判定存档是否已终结（主角死亡，不可继续游玩）。 */
export function isEndedSave(p: MjSavePayload | null | undefined): boolean {
  return !!p?.ended;
}

/**
 * 从完整存档恢复全部运行时状态（主角 / NPC / 世界地图 / 剧情）。
 * 调用前应先 `resetAllGameState()` 清场；恢复后 `storyStore.restored=true`。
 */
export function restoreSave(payload: MjSavePayload): void {
  // 存档迁移：阶层系统上线前的老存档，功法全部缺 tier 字段。
  // 补「与持有者同阶」——同阶压制系数为 1，数值与行为完全不变，
  // 但阶层从此显形（天道编辑/修为摘要可见），此后境界提升即按正常规则参与压制。
  // 必须在 loadFromJson / restoreNpcs 之前做（它们会拷贝/重建数据）。
  const migratedGongfa =
    backfillGongfaTiers(payload.protagonist) +
    (payload.npcs ?? []).reduce((acc, n) => acc + backfillGongfaTiers(n), 0);
  if (migratedGongfa > 0) {
    gameLog.info(
      `[GameSave] 功法阶层迁移：已为 ${migratedGongfa} 门无阶层的老功法补「与持有者同阶」`,
    );
  }
  // 迁移：层数上限改为按阶层决定后，旧存档可能出现 mastery 超过新上限的功法，夹回满层。
  const clampedGongfa =
    clampGongfaMasteryInHolder(payload.protagonist) +
    (payload.npcs ?? []).reduce((acc, n) => acc + clampGongfaMasteryInHolder(n), 0);
  if (clampedGongfa > 0) {
    gameLog.info(
      `[GameSave] 功法层数迁移：已把 ${clampedGongfa} 门超过新上限的功法夹回满层`,
    );
  }
  if (payload.protagonist) {
    // loadFromJson 失败（role 非 protagonist / 结构损坏）时静默返回 false，
    // 主角会保持 null —— 主界面面板随之显示占位文案。这里必须落日志，否则无从排查。
    if (!Protagonist.loadFromJson(payload.protagonist)) {
      gameLog.error(
        `[GameSave] 主角数据解析失败（存档 ${activeSaveId}）：role 字段非 protagonist 或结构损坏`,
      );
      // 自愈：用命运抉择数据重建一个初始主角，至少让档案不再是空的。
      if (payload.fateChoice) {
        Protagonist.loadFromFateChoice(payload.fateChoice);
        gameLog.warn("[GameSave] 已用命运抉择数据重建主角（境界/物品/剧情进度不会因此丢失）");
      }
    }
  } else {
    gameLog.warn(`[GameSave] 存档 ${activeSaveId} 无主角数据`);
  }
  npcStore.restoreNpcs(payload.npcs ?? []);
  factionStore.restoreFactions(payload.factions ?? []);
  // 篇章跨回合延续，必须随存档走（与场景进度不同，后者只在会话内）。
  chapterStore.restoreChapter(payload.chapter);
  worldMapStore.restoreWorldMap(payload.worldMap ?? null);
  locationImageStore.restore(payload.locationImages ?? null);
  storyStore.restoreStory(payload.story ?? null);
  // 存档内的设定优先（回到这个人生还是当初那个设定）；旧存档无此字段时
  // 回退全局副本（玩家改过就用玩家的，没改过即内置默认）。
  setWorldSettings(payload.worldSettings ?? readGlobalWorldSettings());
  restorePendingEdits(payload.pendingEdits);
  activeFateChoice = payload.fateChoice;
  // 场景进度只在会话内维护：读档后旧的层/轮计数可能与新存档不符，直接清零。
  resetSceneProgress();
}

/**
 * 清空全部游戏状态（主角 / NPC / 世界地图 / 剧情）与活动存档记账。
 * 开新人生、读档前清场均应调用。
 */
export function resetAllGameState(): void {
  Protagonist.clear();
  npcStore.clearNpcs();
  factionStore.clearFactions();
  chapterStore.clearChapter();
  worldMapStore.clearWorldMap();
  locationImageStore.clearAll();
  storyStore.clearStory();
  resetSceneProgress();
  // 注意：不是回到内置默认，而是载入玩家的全局设定副本——
  // 否则「开新人生」会把玩家在世界设定里改过的内容全部抹掉。
  loadGlobalWorldSettings();
  clearAllPendingEdits();
  activeSaveId = null;
  activeCreatedAt = 0;
  activeFateChoice = null;
  clearActiveId();
}

/** 删除一个存档（blob + 索引条目）；同时级联删除挂在它下面的回合自动存档。若为当前活动存档，一并清空活动记账。 */
export function removeSave(id: string): void {
  backend.remove(id);
  // 级联：删除以它为 baseId 的自动回合快照（避免留下无主存档）。
  const orphans = readIndexRaw().filter((e) => e && e.auto && e.auto.baseId === id);
  for (const o of orphans) backend.remove(o.id);
  const orphanIds = new Set(orphans.map((o) => o.id));
  const idx = readIndexRaw().filter((e) => e && e.id !== id && !orphanIds.has(e.id));
  writeIndexRaw(idx);
  if (activeSaveId === id) {
  activeSaveId = null;
  activeCreatedAt = 0;
  activeFateChoice = null;
  activeEnded = false;
  clearActiveId();
}
}

/** 清空全部存档（不动运行时游戏状态）。 */
export function clearAllSaves(): void {
  const idx = readIndexRaw();
  for (const e of idx) {
    if (e?.id) backend.remove(e.id);
  }
  writeIndexRaw([]);
  activeSaveId = null;
  activeCreatedAt = 0;
  activeFateChoice = null;
  clearActiveId();
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 生成存档 id：`${name}-${YYYYMMDD-HHMMSS}`。 */
function composeSaveId(name: string): string {
  const d = new Date();
  const pad = (x: number): string => (x < 10 ? "0" + x : String(x));
  const ts =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return name + "-" + ts;
}

/** 生成不与现有索引冲突的存档 id（同名时追加 -2/-3…）。 */
function uniqueSaveId(name: string): string {
  const idx = readIndexRaw();
  const base = composeSaveId(name);
  if (!idx.some((e) => e && e.id === base)) return base;
  let n = 2;
  while (idx.some((e) => e && e.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
