/**
 * @fileoverview 「AI 请求超时」这一项界面设置的运行时状态与持久化。
 *
 * 仿 `uiSettingsStore.ts` 的单值设置范式：localStorage 读 → ref → 写回落盘。
 *
 * ⚠️ **本模块必须是叶子**：只允许 import `vue`，不得 import 任何 `role_core` 业务模块。
 * 原因是它的唯一消费方 `ai/openAiChatBridge.ts` 处在依赖图的底层——一旦这里反向
 * 引到 realmUtils / playInfo 那一圈，就会构成循环，ESM 求值顺序下表现为**白屏**
 * （项目有 TDZ 前科，见 `types/itemTier.ts` 头部注释）。
 *
 * 为什么需要可调：原先超时硬编码 300s，而玩家手上的渠道差异极大——
 * 有的中转排队动辄几分钟（300s 不够，状态 AI 十五段输出被判超时作废），
 * 有的渠道挂死不返回（300s 太长，玩家干等五分钟才知道失败）。
 * 交给玩家自己调，比替他猜一个数字强。
 */

import { ref } from "vue";

const AI_TIMEOUT_SEC_KEY = "MJ_AI_TIMEOUT_SEC_V1";

/** 单次 AI 请求等待时间的可选范围（秒）与默认值。 */
export const AI_TIMEOUT_SEC_MIN = 60;
export const AI_TIMEOUT_SEC_MAX = 900;
export const AI_TIMEOUT_SEC_STEP = 30;
export const AI_TIMEOUT_SEC_DEFAULT = 420;

/** 滑杆 UI 上直接展示的文案，避免各组件各写一遍。 */
export const AI_TIMEOUT_HINT =
  "单次 AI 请求的最长等待时间。过短会在长输出时误判失败，过长会在渠道挂死时干等。";

function clamp(v: number): number {
  if (!Number.isFinite(v)) return AI_TIMEOUT_SEC_DEFAULT;
  const c = Math.min(AI_TIMEOUT_SEC_MAX, Math.max(AI_TIMEOUT_SEC_MIN, v));
  return Math.round(c / AI_TIMEOUT_SEC_STEP) * AI_TIMEOUT_SEC_STEP;
}

function readStored(): number {
  try {
    if (typeof localStorage === "undefined") return AI_TIMEOUT_SEC_DEFAULT;
    const raw = localStorage.getItem(AI_TIMEOUT_SEC_KEY);
    if (raw == null) return AI_TIMEOUT_SEC_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : AI_TIMEOUT_SEC_DEFAULT;
  } catch {
    return AI_TIMEOUT_SEC_DEFAULT;
  }
}

/** 当前 AI 请求超时（秒）。只读引用，写入请用 {@link setAiTimeoutSec}。 */
export const aiTimeoutSec = ref(readStored());

/** 当前 AI 请求超时（秒）。 */
export function getAiTimeoutSec(): number {
  return aiTimeoutSec.value;
}

/** 当前 AI 请求超时（毫秒），桥接层直接用这个。 */
export function getAiRequestTimeoutMs(): number {
  return aiTimeoutSec.value * 1000;
}

/** 设置 AI 请求超时：夹取到合法范围、落盘并立即生效。 */
export function setAiTimeoutSec(v: number): void {
  const next = clamp(v);
  aiTimeoutSec.value = next;
  try {
    localStorage.setItem(AI_TIMEOUT_SEC_KEY, String(next));
  } catch {
    /* 隐私模式/配额不足等场景忽略，仅本次会话内生效 */
  }
}

/** 恢复默认超时。 */
export function resetAiTimeoutSec(): void {
  setAiTimeoutSec(AI_TIMEOUT_SEC_DEFAULT);
}
