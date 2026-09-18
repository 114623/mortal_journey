<script setup lang="ts">
import { toRef, computed, ref, onMounted } from "vue";
import { useOpeningStoryFromFateChoice } from "../ai/useOpeningStory";
import { useApiConfig } from "../ai/useApiConfig";
import { protagonist } from "../role_core/Protagonist";
import { gameLog } from "../log/gameLog";
import { getActiveSaveId, readSave, restoreSave } from "../save/gameSave";
import { Npc } from "../role_core/Npc";
import { npcStore } from "../role_core/npcStore";
import { getRow } from "../role_core/realmUtils";
import type { NpcPlayInfo } from "../role_core/types/playInfo";
import type { FateChoiceResult } from "../fate_choice/types";
import type { BattleTriggerEntry } from "../ai/state_generate";
import type { CultivationInput } from "../ai/cultivation_types";
import type { BattleResult } from "../battle_engine/types";
import type { WorldLocation } from "../role_core/types/worldLocation";
import SideToolbarPanel from "./SideToolbarPanel.vue";
import type { MjSavePayload } from "../save/gameSave";
import PlayerInfoPanel from "./PlayerInfoPanel.vue";
import StoryChatPanel from "./StoryChatPanel.vue";
import { pendingProfileCount, hasPendingWorldSettings } from "../role_core/pendingEdits";
import { TEST_ALLY_DUMMY_NAMES, TEST_ENEMY_DUMMY_NAMES, ALL_TEST_DUMMY_NAMES } from "./testBattle";
import kuileiAvatar from "../assets/kuilei.png";

const props = defineProps<{
  visible: boolean;
  fateChoice?: FateChoiceResult | null;
  battleResult?: BattleResult | null;
}>();

const { apiUrl, apiKey, apiModel } = useApiConfig();

const fateChoiceRef = toRef(props, "fateChoice");
const apiSlice = computed(() => ({
  apiUrl: apiUrl.value,
  apiKey: apiKey.value,
  apiModel: apiModel.value,
}));

const { phase, errorMessage, worldTime, worldTimeBaseline, worldLocation } =
  useOpeningStoryFromFateChoice(fateChoiceRef, apiSlice);

/**
 * 挂载自检：主角为空但活动存档里明明有主角数据时，直接重灌一次。
 *
 * 兜的是开发期热更新导致的模块级单例丢失（主角 ref 被重新初始化），
 * 以及读档链路中途异常导致 restored 未置位的情况——两者都会让主界面只剩占位文案。
 */
onMounted(() => {
  if (protagonist.value) return;
  const id = getActiveSaveId();
  if (!id) return;
  const payload = readSave(id);
  if (!payload?.protagonist) return;
  gameLog.warn("[MainScreen] 挂载时主角为空但存档有主角数据，自动重新载入存档");
  restoreSave(payload);
});

const emit = defineEmits<{
  back: [];
  battleTrigger: [value: BattleTriggerEntry];
  consumeBattleResult: [];
  cultivate: [value: CultivationInput];
  gameOver: [reason: string];
  /** 侧边栏请求读取另一个存档，转交 App 执行切换。 */
  loadSave: [value: { id: string; payload: MjSavePayload }];
}>();

const pendingCultivation = ref<CultivationInput | null>(null);
const chatGenerating = ref(false);

const isBusy = computed(() => phase.value !== "ready" || chatGenerating.value);

/* ── 侧栏折叠（左：主角面板 / 右：功能面板） ─────────────────────
 * 桌面端折叠成 26px 竖条，手机端（≤900px）折叠成一条横向窄条，
 * 给中间剧情区让出空间。状态持久化到 localStorage；
 * 无记录时手机端默认折叠、桌面端默认展开。 */
const SIDEBAR_COLLAPSE_KEY = "MJ_SIDEBAR_COLLAPSE_V1";

function readSidebarCollapse(): { left: boolean; right: boolean } {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { left?: unknown; right?: unknown };
      return { left: v.left === true, right: v.right === true };
    }
  } catch {
    /* 损坏即走默认 */
  }
  const mobile =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 900px)").matches;
  return { left: mobile, right: mobile };
}

const sidebarCollapsed = ref(readSidebarCollapse());

function toggleSidebar(which: "left" | "right"): void {
  sidebarCollapsed.value = {
    ...sidebarCollapsed.value,
    [which]: !sidebarCollapsed.value[which],
  };
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify(sidebarCollapsed.value));
  } catch {
    /* 配额不足等场景忽略，仅本次会话内生效 */
  }
}

/** 右栏折叠时按钮上的待应用角标（画像 + 世界设定）。 */
const sidebarPendingBadge = computed(
  () => pendingProfileCount.value + (hasPendingWorldSettings.value ? 1 : 0),
);

function onCultivate(input: CultivationInput) {
  pendingCultivation.value = input;
}

function consumeCultivation() {
  pendingCultivation.value = null;
}

function onBack() {
  emit("back");
}

function startTestBattle() {
  const p = protagonist.value;
  if (!p) return;

  // 清掉上一次测试残留的假人。
  for (const n of ALL_TEST_DUMMY_NAMES) {
    npcStore.removeNpc(n);
  }

  // 假人 HP/MP/属性全部取自主角境界的纯净基准值（境界表），不受主角丹药/天赋/装备加成影响。
  const realmRow = getRow(p.realm.major, p.realm.minor)
    ?? getRow("练气", "初期")
    ?? { hp: 200, mp: 100, physique: 5, spirit: 5, strength: 25, perception: 25, guard: 3, resistance: 3, agility: 2, insight: 2 };

  const dummyMaxHp = realmRow.hp * 10;
  const dummyMaxMp = realmRow.mp * 10;
  const dummyRealm = { major: p.realm.major, minor: p.realm.minor };

  /** 构建一个战斗测试假人（属性全部一致，取自主角境界表基准）。 */
  function makeDummy(displayName: string, id: string): NpcPlayInfo {
    return {
      id,
      displayName,
      realm: { ...dummyRealm },
      primaryStats: {
        physique: realmRow.physique,
        spirit: realmRow.spirit,
        strength: realmRow.strength,
        perception: realmRow.perception,
        guard: realmRow.guard,
        resistance: realmRow.resistance,
        agility: realmRow.agility,
        insight: realmRow.insight,
      },
      maxHp: dummyMaxHp,
      maxMp: dummyMaxMp,
      currentHp: dummyMaxHp,
      currentMp: dummyMaxMp,
      avatarUrl: kuileiAvatar,
      gender: "无",
      linggen: [],
      age: 0,
      ageConfirmed: true,
      shouyuan: 9999,
      inventorySlots: [],
      gongfaSlots: [null, null, null, null, null, null, null, null],
      equippedSlots: [],
      role: "npc",
      identity: "战斗测试人偶",
      favorability: 0,
      isDead: false,
      powerTier: "小怪",
      race: "修仙者",
      appearance: "",
      clothing: "",
      traits: [],
      xiuwei: 0,
    };
  }

  // 注册 2 友方 + 3 敌方假人（属性完全相同）。
  TEST_ALLY_DUMMY_NAMES.forEach((name, i) => {
    npcStore.setNpc(Npc.fromData(makeDummy(name, `test-ally-${i}`)));
  });
  TEST_ENEMY_DUMMY_NAMES.forEach((name, i) => {
    npcStore.setNpc(Npc.fromData(makeDummy(name, `test-enemy-${i}`)));
  });

  emit("battleTrigger", {
    shouldEnterBattle: true,
    triggerKind: "active" as const,
    triggerReason: "战斗测试",
    allies: [
      { displayName: p.displayName, roleHint: "主角" },
      ...TEST_ALLY_DUMMY_NAMES.map((n) => ({ displayName: n, roleHint: "友方" })),
    ],
    enemies: TEST_ENEMY_DUMMY_NAMES.map((n) => ({ displayName: n, roleHint: "敌人" })),
    isTestBattle: true,
  });
}
</script>

<template>
  <div
    class="main-screen"
    role="application"
    aria-label="无限仙途主界面"
  >
    <header class="main-screen__toolbar">
      <h1 class="main-screen__title">无限仙途</h1>
      <div class="main-screen__toolbar-actions">
        <button type="button" class="main-screen__btn" @click="onBack">返回标题</button>
      </div>
    </header>
    <div
      class="main-screen__body"
      :class="{
        'main-screen__body--left-collapsed': sidebarCollapsed.left,
        'main-screen__body--right-collapsed': sidebarCollapsed.right,
      }"
    >
      <aside
        class="main-screen__pane main-screen__pane--player"
        :class="{ 'main-screen__pane--collapsed': sidebarCollapsed.left }"
        aria-label="左栏：主角与世界时间"
      >
        <div id="pane-player" class="main-screen__pane-inner">
          <PlayerInfoPanel
            :protagonist="protagonist"
            :world-time="worldTime"
            :world-time-baseline="worldTimeBaseline"
            @update:world-time="worldTime = $event"
            @cultivate="onCultivate"
          />
        </div>
        <button
          type="button"
          class="side-collapse side-collapse--at-right"
          :aria-expanded="!sidebarCollapsed.left"
          aria-controls="pane-player"
          :title="sidebarCollapsed.left ? '展开主角面板' : '折叠主角面板'"
          @click="toggleSidebar('left')"
        >
          <span class="side-collapse__arrow" aria-hidden="true">{{ sidebarCollapsed.left ? "»" : "«" }}</span>
          <span class="side-collapse__label">主角面板</span>
        </button>
      </aside>
      <main class="main-screen__pane main-screen__pane--chat" aria-label="中栏：剧情">
        <StoryChatPanel
          :phase="phase"
          :error-message="errorMessage"
          :current-world-location="worldLocation"
          :battle-result="props.battleResult"
          :cultivation-input="pendingCultivation"
          v-model:world-time="worldTime"
          @update:world-location="worldLocation = $event"
          @battle-trigger="emit('battleTrigger', $event)"
          @consume-battle-result="emit('consumeBattleResult')"
          @consume-cultivation="consumeCultivation"
          @generating-change="chatGenerating = $event"
          @game-over="emit('gameOver', $event)"
        />
      </main>
      <aside
        class="main-screen__pane main-screen__pane--side"
        :class="{ 'main-screen__pane--collapsed': sidebarCollapsed.right }"
        aria-label="右栏：功能面板"
      >
        <button
          type="button"
          class="side-collapse side-collapse--at-left"
          :aria-expanded="!sidebarCollapsed.right"
          aria-controls="pane-side"
          :title="sidebarCollapsed.right ? '展开功能面板' : '折叠功能面板'"
          @click="toggleSidebar('right')"
        >
          <span v-if="sidebarPendingBadge > 0" class="side-collapse__dot" aria-hidden="true"></span>
          <span class="side-collapse__arrow" aria-hidden="true">{{ sidebarCollapsed.right ? "«" : "»" }}</span>
          <span class="side-collapse__label">功能面板</span>
        </button>
        <div id="pane-side" class="main-screen__pane-inner">
          <SideToolbarPanel
            :current-location="worldLocation"
            :test-disabled="isBusy"
            @test-battle="startTestBattle"
            @load-save="(v) => emit('loadSave', v)"
          />
        </div>
      </aside>
    </div>
  </div>
</template>
