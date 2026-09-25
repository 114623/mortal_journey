<script setup lang="ts">
import { ref } from "vue";
import DebugLogPanel from "./log/DebugLogPanel.vue";
import StartFrame from "./start_frame/StartFrame.vue";
import FateChoiceScreen from "./fate_choice/FateChoiceScreen.vue";
import MainScreen from "./main-screen/MainScreen.vue";
import BattleScreen from "./battle_view/BattleScreen.vue";
import BattleRosterModal from "./battle_view/BattleRosterModal.vue";
import { gameLog } from "./log/gameLog";
import { protagonist } from "./role_core/Protagonist";
import { npcStore } from "./role_core/npcStore";
import { storyStore } from "./role_core/storyStore";
import { ALL_TEST_DUMMY_NAMES } from "./main-screen/testBattle";
import type { FateChoiceResult } from "./fate_choice/types";
import type { BattleTriggerEntry } from "./ai/state_generate";
import type { BattleResult } from "./battle_engine/types";
import {
  resetAllGameState,
  createSave,
  writeActiveSave,
  restoreSave,
  setActiveSave,
  isCompleteSave,
  isEndedSave,
  markActiveSaveEnded,
  readSave,
  getPersistedActiveId,
  clearActiveId,
  type MjSavePayload,
} from "./save/gameSave";

const fateChoiceVisible = ref(false);
const mainScreenVisible = ref(false);
const lastFateChoice = ref<FateChoiceResult | null>(null);

function openFateChoice() {
  fateChoiceVisible.value = true;
}

function closeFateChoice() {
  fateChoiceVisible.value = false;
}

function onFateChoiceComplete(payload: FateChoiceResult) {
  gameLog.info("[App] 命运抉择 JSON: " + JSON.stringify(payload, null, 2));
  resetAllGameState();
  createSave(payload);
  lastFateChoice.value = payload;
  fateChoiceVisible.value = false;
  mainScreenVisible.value = true;
}

function onMainScreenBack() {
  writeActiveSave();
  clearActiveId();
  mainScreenVisible.value = false;
}

/** 恢复一个完整存档并进入主界面。`resetFirst=true` 时先清空上一局状态（手动读档）。 */
function enterSaveSession(id: string, payload: MjSavePayload, resetFirst: boolean): void {
  if (resetFirst) resetAllGameState();
  setActiveSave(id, payload.fateChoice, payload.createdAt || Date.now());
  restoreSave(payload);
  lastFateChoice.value = null;
  fateChoiceVisible.value = false;
  mainScreenVisible.value = true;
}

/** 从标题读取人生：恢复存档（完整则直接读档，占位/未完成则按 fateChoice 重跑开局）。 */
function onSaveLoaded(value: { id: string; payload: MjSavePayload }): void {
  const { id, payload } = value;
  if (isEndedSave(payload)) {
    // 已终结存档：恢复数据（供结局页展示姓名）后直接进入纪念碑。
    enterSaveSession(id, payload, true);
    showGameOverMemorial(payload.ended!.reason);
  } else if (isCompleteSave(payload)) {
    enterSaveSession(id, payload, true);
  } else {
    resetAllGameState();
    setActiveSave(id, payload.fateChoice, payload.createdAt || Date.now());
    lastFateChoice.value = payload.fateChoice;
    fateChoiceVisible.value = false;
    mainScreenVisible.value = true;
  }
}

// 刷新续玩：若本地持久化了活动存档，启动时自动恢复（完整存档直接进主界面，
// 已终结存档进结局纪念碑；占位/未完成则忽略并清指针）。
(function resumeOnStartup(): void {
  const id = getPersistedActiveId();
  if (!id) {
    gameLog.info("[App] 刷新续玩：无活动存档指针，停在标题");
    return;
  }
  const payload = readSave(id);
  if (!payload) {
    gameLog.warn(`[App] 刷新续玩：存档 ${id} 读取失败，清除指针`);
    clearActiveId();
    return;
  }
  if (isEndedSave(payload)) {
    enterSaveSession(id, payload, false);
    showGameOverMemorial(payload.ended!.reason);
  } else if (isCompleteSave(payload)) {
    enterSaveSession(id, payload, false);
    gameLog.info(
      `[App] 刷新续玩：已恢复存档 ${id}，主角=${protagonist.value?.displayName ?? "空"}`,
    );
    if (!protagonist.value) {
      gameLog.error("[App] 刷新续玩：恢复后主角仍为空，主角档案将显示占位文案");
    }
  } else {
    gameLog.warn(`[App] 刷新续玩：存档 ${id} 不完整（开局未生成完），清除指针`);
    clearActiveId();
  }
})();

const pendingBattleTrigger = ref<BattleTriggerEntry | null>(null);

/** 开战前的参战人员选择是否开着（见 BattleRosterModal）。 */
const rosterOpen = ref(false);

/**
 * 剧情推进触发战斗。
 *
 * 不直接进战斗界面，先让玩家过一遍名单——可能场上有五个人但只想带两个，
 * 也可能想反手把某个在场之人划到对面（见 BattleRosterModal 的注释）。
 * 测试战斗同样过这道手：假人就在名单里，正好拿 1v3、2v2 之类的编队试数值。
 */
function onBattleTrigger(entry: BattleTriggerEntry) {
  gameLog.info("[App] 战斗触发: " + JSON.stringify(entry, null, 2));
  pendingBattleTrigger.value = entry;
  rosterOpen.value = true;
}

/** 名单敲定（或放弃修改）后真正进战斗界面。 */
function enterBattle(entry: BattleTriggerEntry): void {
  rosterOpen.value = false;
  pendingBattleTrigger.value = entry;
  battleVisible.value = true;
}

function onRosterConfirm(entry: BattleTriggerEntry): void {
  gameLog.info(
    `[App] 玩家编队：我方 ${entry.allies.map(a => a.displayName).join("、") || "仅主角"}；` +
      `敌方 ${entry.enemies.map(e => e.displayName).join("、")}`,
  );
  enterBattle(entry);
}

/** 「用剧情名单」/ 直接关闭：按 AI 给的名单开打（战斗已触发，不能凭空取消）。 */
function onRosterUseDefault(): void {
  const entry = pendingBattleTrigger.value;
  if (!entry) {
    rosterOpen.value = false;
    return;
  }
  enterBattle(entry);
}

const battleVisible = ref(false);
const lastBattleResult = ref<BattleResult | null>(null);

function onBattleEnd(result: BattleResult | null) {
  const wasTest = pendingBattleTrigger.value?.isTestBattle ?? false;
  battleVisible.value = false;
  pendingBattleTrigger.value = null;
  if (wasTest) {
    for (const n of ALL_TEST_DUMMY_NAMES) {
      npcStore.removeNpcByName(n);
    }
  } else if (result) {
    // 无论胜负，都把结果传给 StoryChatPanel；战败时由其生成走马灯后 emit gameOver。
    lastBattleResult.value = result;
  }
}

function onBattleResultConsumed() {
  lastBattleResult.value = null;
}

// ── 游戏结束（寿尽/战败） ────────────────────────────────────────────────────
/**
 * 主角死亡：落盘 ended 标记并置灰主界面输入框（phase=ended）。
 * 走马灯结局叙事由 StoryChatPanel 在 emit gameOver 之前生成，此处只做收尾。
 */
function triggerGameOver(reason: string): void {
  markActiveSaveEnded(reason);
  storyStore.phase.value = "ended";
  storyStore.gameOverReason.value = reason;
  battleVisible.value = false;
  gameLog.info("[App] 游戏结束：" + reason);
}

/** 进入已终结存档：置灰输入框（不重写 ended 标记，保留原始死亡时间）。 */
function showGameOverMemorial(reason: string): void {
  storyStore.phase.value = "ended";
  storyStore.gameOverReason.value = reason;
  gameLog.info(`[App] 进入已终结存档（${reason}）`);
}

/** 主界面寿元耗尽/战败身亡事件（走马灯生成完成后触发）。 */
function onGameOver(reason: string): void {
  triggerGameOver(reason);
}
</script>

<template>
  <DebugLogPanel />

  <Transition name="mj-fade">
    <StartFrame
      v-if="!mainScreenVisible && !fateChoiceVisible"
      :main-screen-visible="mainScreenVisible"
      @start-new-life="openFateChoice"
      @save-loaded="onSaveLoaded"
    />
  </Transition>

  <Transition name="mj-slide-up">
    <FateChoiceScreen
      v-if="fateChoiceVisible"
      :visible="fateChoiceVisible"
      @close="closeFateChoice"
      @complete="onFateChoiceComplete"
    />
  </Transition>

  <Transition name="mj-main">
    <MainScreen
      v-if="mainScreenVisible"
      :visible="mainScreenVisible"
      :fate-choice="lastFateChoice"
      :battle-result="lastBattleResult"
      @back="onMainScreenBack"
      @battle-trigger="onBattleTrigger"
      @consume-battle-result="onBattleResultConsumed"
      @game-over="onGameOver"
      @load-save="onSaveLoaded"
    />
  </Transition>

  <BattleRosterModal
    :open="rosterOpen"
    :trigger="pendingBattleTrigger"
    @confirm="onRosterConfirm"
    @use-default="onRosterUseDefault"
  />
  <BattleScreen
    v-if="battleVisible"
    :trigger="pendingBattleTrigger"
    @battle-end="onBattleEnd"
  />
</template>
