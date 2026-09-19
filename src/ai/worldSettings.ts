/**
 * @fileoverview 游戏内可编辑的「世界设定」：世界观 / 规则 / 预设 三段提示词。
 *
 * 三段文本原本硬编码在各 preset 文件里，现在抽成可读写的数据：
 * - **世界观**（[修仙背景信息]）：境界体系、寿元、灵根、称呼规则等世界常识。
 *   剧情 AI 与状态 AI 共用同一份，改一处两处同时生效。
 * - **规则**（[剧情生成基础规则]）：剧情长度、战斗红线、灵石经济、突破任务等玩法规则。
 *   只作用于剧情 AI。
 * - **预设**（文风预设）：台词与去旁白散文化、角色防全知、轻小说文风。
 *   作用于剧情 AI / 开局剧情 AI / 修炼剧情 AI / 结局 AI。
 * - **剧情脉络**（2026-09 新增）：玩家希望剧情往哪个方向发展的提示，供剧情 AI 参考；
 *   可留空。作用于剧情 AI / 开局 / 修炼 / 结局四条叙事链路。
 *
 * 输出契约（`<thinking>` + `<mj_story_body>` 标签结构）**不在此列**——
 * 它是解析层的硬要求，玩家改写会直接导致解析失败。
 */

import { WORLD_VIEW_DEFAULT, RULES_DEFAULT } from "./story_preset";
import { PRESET } from "./preset";

/** 世界设定各段文本。 */
export interface WorldSettingsText {
  /** 世界观：世界运转的常识与设定（剧情 AI + 状态 AI 共用）。 */
  worldView: string;
  /** 规则：剧情生成的玩法规则（剧情 AI）。 */
  rules: string;
  /** 预设：文风与叙事口吻（剧情 AI 系列）。 */
  preset: string;
  /** 剧情脉络：玩家希望的发展方向（叙事类 AI 参考用，可留空）。 */
  storyOutline: string;
}

/** 单段文本的安全上限（仅防极端输入撑爆上下文，正常编辑不会触及）。 */
export const WORLD_SETTINGS_FIELD_MAX_LENGTH = 40000;

/** 构造一份默认世界设定（取各 preset 的内置文本；剧情脉络默认为空）。 */
export function createDefaultWorldSettings(): WorldSettingsText {
  return {
    worldView: WORLD_VIEW_DEFAULT,
    rules: RULES_DEFAULT,
    preset: PRESET,
    storyOutline: "",
  };
}

/**
 * 规范化世界设定：非字符串归零、超长截断、缺失字段回退默认值。
 * 旧存档无此字段时返回完整默认设定。
 */
export function normalizeWorldSettings(raw: unknown): WorldSettingsText {
  const def = createDefaultWorldSettings();
  if (!raw || typeof raw !== "object") return def;
  const o = raw as Record<string, unknown>;
  const pick = (v: unknown, fallback: string): string => {
    if (typeof v !== "string") return fallback;
    const t = v.trim() ? v : fallback;
    return t.slice(0, WORLD_SETTINGS_FIELD_MAX_LENGTH);
  };
  return {
    worldView: pick(o.worldView, def.worldView),
    rules: pick(o.rules, def.rules),
    preset: pick(o.preset, def.preset),
    // 剧情脉络允许为空（玩家没写就不注入，省 token），因此单独处理、不走 pick 的回退逻辑。
    storyOutline:
      typeof o.storyOutline === "string"
        ? o.storyOutline.slice(0, WORLD_SETTINGS_FIELD_MAX_LENGTH)
        : def.storyOutline,
  };
}

/** 四段是否都与默认一致（用于 UI 显示「已改动」）。 */
export function isDefaultWorldSettings(ws: WorldSettingsText): boolean {
  const def = createDefaultWorldSettings();
  return (
    ws.worldView === def.worldView &&
    ws.rules === def.rules &&
    ws.preset === def.preset &&
    ws.storyOutline === def.storyOutline
  );
}
