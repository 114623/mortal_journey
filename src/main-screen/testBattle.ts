/**
 * @fileoverview 战斗测试用的假人名与配置。
 *
 * 假人属性全部相同（由 {@link MainScreen.vue} 的 `startTestBattle` 按主角境界推算），
 * 仅供战斗测试，战斗结束后由 {@link App.vue} 的 `onBattleEnd` 从 npcStore 清除。
 */

/** 友方假人名（主角之外的我方）。 */
export const TEST_ALLY_DUMMY_NAMES = ["友方人偶·甲", "友方人偶·乙"] as const;

/** 敌方假人名（3 名，统一命名）。 */
export const TEST_ENEMY_DUMMY_NAMES = ["敌方人偶·甲", "敌方人偶·乙", "敌方人偶·丙"] as const;

/** 全部假人名（预清理 / 战后清理用）。 */
export const ALL_TEST_DUMMY_NAMES: readonly string[] = [
  ...TEST_ALLY_DUMMY_NAMES,
  ...TEST_ENEMY_DUMMY_NAMES,
];
