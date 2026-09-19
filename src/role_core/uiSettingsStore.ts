/**
 * @fileoverview 游戏内「设置」的运行时状态与持久化。
 *
 * 目前只有一项：剧情正文字号缩放。后续新增界面类设置（行距、气泡字号等）
 * 也放这里——统一走「localStorage 持久化 + 写入 CSS 变量」的方式，
 * 这样样式层无需在每个组件里读 ref。
 */

import { ref } from "vue";

const STORY_FONT_SCALE_KEY = "MJ_STORY_FONT_SCALE_V1";

/** 剧情正文字号缩放的可选范围（相对默认 1rem）。 */
export const STORY_FONT_SCALE_MIN = 0.8;
export const STORY_FONT_SCALE_MAX = 2;
export const STORY_FONT_SCALE_STEP = 0.05;
export const STORY_FONT_SCALE_DEFAULT = 1;

/** 写入 documentElement 的 CSS 变量名（样式表用它做 calc）。 */
const CSS_VAR = "--mj-story-font-scale";

function clamp(v: number): number {
  if (!Number.isFinite(v)) return STORY_FONT_SCALE_DEFAULT;
  const c = Math.min(STORY_FONT_SCALE_MAX, Math.max(STORY_FONT_SCALE_MIN, v));
  // 对齐到步长，避免滑块出现 0.8700000000000001 这类脏值
  return Math.round(c / STORY_FONT_SCALE_STEP) * STORY_FONT_SCALE_STEP;
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORY_FONT_SCALE_KEY);
    if (raw == null) return STORY_FONT_SCALE_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : STORY_FONT_SCALE_DEFAULT;
  } catch {
    return STORY_FONT_SCALE_DEFAULT;
  }
}

/** 当前剧情正文字号缩放（1 = 默认）。只读引用，写入请用 setStoryFontScale。 */
export const storyFontScale = ref(readStored());

function applyToDom(v: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(CSS_VAR, String(v));
}

// 初始化即生效（刷新后保留玩家的字号设置）。
applyToDom(storyFontScale.value);

/** 当前剧情正文字号缩放（1 = 默认）。 */
export function getStoryFontScale(): number {
  return storyFontScale.value;
}

/** 设置剧情正文字号缩放：夹取到合法范围、落盘并立即生效。 */
export function setStoryFontScale(v: number): void {
  const next = clamp(v);
  storyFontScale.value = next;
  applyToDom(next);
  try {
    localStorage.setItem(STORY_FONT_SCALE_KEY, String(next));
  } catch {
    /* 配额不足等场景忽略，仅本次会话内生效 */
  }
}

/** 恢复默认字号。 */
export function resetStoryFontScale(): void {
  setStoryFontScale(STORY_FONT_SCALE_DEFAULT);
}
