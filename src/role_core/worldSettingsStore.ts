/**
 * @fileoverview 世界设定运行时状态：世界观 / 规则 / 预设 三段提示词的当前值。
 *
 * 两套副本，职责不同：
 *   - **全局副本**（localStorage `MJ_WORLD_SETTINGS_V1`）：玩家每次点「保存」时同步写入，
 *     作为**新开人生**的初始设定。与任何存档无关，换存档、开新人生都不丢。
 *   - **存档副本**（`MjSavePayload.worldSettings`）：随单个存档走，读档时覆盖当前值，
 *     保证「回到这个人生还是当初那个设定」。
 *
 * 玩家在「世界设定」界面改写后，非回合期间立即生效，回合期间进入待应用队列
 * （见 `pendingEdits.ts`）。
 */

import { ref } from "vue";
import {
  createDefaultWorldSettings,
  normalizeWorldSettings,
  type WorldSettingsText,
} from "../ai/worldSettings";

/** 全局副本的 localStorage 键（跨存档、跨人生，只由玩家主动保存时写入）。 */
export const WORLD_SETTINGS_GLOBAL_KEY = "MJ_WORLD_SETTINGS_V1";

/** 当前生效的世界设定。初值取全局副本（无则内置默认）——登录后尚未读档时也用得上。 */
export const worldSettings = ref<WorldSettingsText>(readGlobalWorldSettings());

/** 整体替换世界设定（内部做规范化，防御脏数据）。 */
export function setWorldSettings(next: WorldSettingsText): void {
  worldSettings.value = normalizeWorldSettings(next);
}

/**
 * 读取全局副本（新人生的设定模板）。
 *
 * 无副本、损坏、非法时一律回退内置默认——旧版本玩家从未改过设定，
 * 行为与改动前完全一致。
 */
export function readGlobalWorldSettings(): WorldSettingsText {
  try {
    const raw = localStorage.getItem(WORLD_SETTINGS_GLOBAL_KEY);
    if (!raw) return createDefaultWorldSettings();
    return normalizeWorldSettings(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultWorldSettings();
  }
}

/** 写入全局副本（玩家点「保存」时调用；写失败只忽略，不影响本次生效）。 */
export function writeGlobalWorldSettings(ws: WorldSettingsText): void {
  try {
    localStorage.setItem(WORLD_SETTINGS_GLOBAL_KEY, JSON.stringify(ws));
  } catch {
    /* ignore */
  }
}

/**
 * 把当前生效值重置为全局副本（无则内置默认）。
 *
 * 供 `gameSave.resetAllGameState()` 清场时调用——开新人生时用它当初始设定，
 * 而不是回到内置默认，否则玩家改过的设定一开新档就丢。
 */
export function loadGlobalWorldSettings(): void {
  worldSettings.value = readGlobalWorldSettings();
}

/**
 * 取当前世界设定（供 AI 组装 prompt 用）。
 *
 * 用 getter 而非直接导出 ref，避免调用方持有引用后错过整体替换。
 */
export function getWorldPreset(): WorldSettingsText {
  return worldSettings.value;
}
