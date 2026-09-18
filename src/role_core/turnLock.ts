/**
 * 回合锁：标记当前是否处于「回合进行中」（AI 生成剧情/状态/大总结，或开局剧情生成中）。
 *
 * 用途：角色画像提示词（性格/外貌/记忆）允许玩家在非回合期间随时改写，
 * 但回合进行中禁止修改——否则玩家改到的内容会被本回合 AI 的输出覆盖或与之冲突。
 *
 * 由 `StoryChatPanel` 在生成开始/结束时维护；其余模块只读。
 */

import { ref } from "vue";

/** 是否处于回合进行中。 */
export const turnBusy = ref(false);

/** 设置回合锁状态。 */
export function setTurnBusy(v: boolean): void {
  turnBusy.value = v === true;
}
