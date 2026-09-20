// ═══════════════════════════════════════════════════════════════
// 战斗引擎常量
// ═══════════════════════════════════════════════════════════════

export const GAUGE_MAX = 100;
export const NORMAL_ATTACK_COST = 50;
export const NORMAL_ATTACK_DAMAGE_TYPE = "physical" as const;
export const ELIXIR_COST = 30;
export const FLEE_COST = 100;
export const MIN_DAMAGE = 1;
export const BASE_CRIT_DMG = 150;

export const BATTLE_DEBUG = false;

export const BASE_GAUGE_TIME_MS = 5000;
export const AGILITY_DIVISOR = 100;
export const ACTION_DELAY_MS = 300;

// ─── 闪避（身法差 + 硬上限） ───
// 身法闪避 = DODGE_AGI_MAX ×(守方有效身法 − 攻方有效身法)/(两者之和)。
// 比值形式天然递减：身法高出一倍也只有约 1/3 的差值，永远逼近不到 DODGE_AGI_MAX。
/** 身法差能贡献的闪避上限（%）。 */
export const DODGE_AGI_MAX = 35;
/** 最终闪避率硬上限（%）：dodgeRate 修正 + 身法闪避 之和封顶于此。 */
export const DODGE_HARD_CAP = 50;
