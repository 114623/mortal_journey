<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { npcStore } from "../role_core/npcStore";
import type { Npc } from "../role_core/Npc";
import WorldMapModal from "./WorldMapModal.vue";
import AlchemyModal from "./AlchemyModal.vue";
import CharacterArchiveModal from "./CharacterArchiveModal.vue";
import NpcDetailModal from "./NpcDetailModal.vue";
import NpcMiniCard from "./NpcMiniCard.vue";
import WorldSettingsModal from "./WorldSettingsModal.vue";
import ItemForgeModal from "./ItemForgeModal.vue";
import FactionBoardModal from "./FactionBoardModal.vue";
import SaveLoadModal from "./SaveLoadModal.vue";
import SettingsModal from "./SettingsModal.vue";
import type { MjSavePayload } from "../save/gameSave";
import { writeActiveSave } from "../save/gameSave";
import { gameLog } from "../log/gameLog";
import { hasPendingWorldSettings, pendingProfileCount } from "../role_core/pendingEdits";

const props = defineProps<{
  currentLocation?: WorldLocation | null;
  testDisabled?: boolean;
}>();

const emit = defineEmits<{
  testBattle: [];
  /** 请求读取另一个存档（转交 App 执行与标题界面一致的切换流程）。 */
  loadSave: [value: { id: string; payload: MjSavePayload }];
  /** 折叠本侧栏（折叠开关从竖条改为内容区里的正方形按钮后，由本组件转发）。 */
  collapse: [];
}>();

const mapModalOpen = ref(false);
const alchemyModalOpen = ref(false);
const archiveModalOpen = ref(false);
const worldSettingsOpen = ref(false);
/** 打开世界设定时默认落在哪个标签页；「篇章」入口传 storyOutline（主线 · 篇章页）。 */
const worldSettingsTab = ref<"worldView" | "rules" | "preset" | "storyOutline">("worldView");
const forgeModalOpen = ref(false);
const factionModalOpen = ref(false);
const saveLoadOpen = ref(false);
const settingsOpen = ref(false);

/** 各类待回合结束才生效的改动条数（显示在对应按钮上）。 */
const queuedProfiles = computed(() => pendingProfileCount.value);
const queuedWorld = computed(() => (hasPendingWorldSettings.value ? 1 : 0));

// ── 侧栏「在场人物」卡（与世界地图同款）────────────────────────────────────
const npcDetailOpen = ref(false);
const npcDetailTarget = shallowRef<Npc | null>(null);

/** 当前地点的在场 NPC，按最近出场排序。 */
const presentNpcs = computed<Npc[]>(() =>
  npcStore.sortByRecent(npcStore.getActiveNpcsAt(props.currentLocation)),
);

function openNpcDetail(npc: Npc): void {
  npcDetailTarget.value = npc;
  npcDetailOpen.value = true;
}

function closeNpcDetail(): void {
  npcDetailOpen.value = false;
  npcDetailTarget.value = null;
}

function openMapModal() {
  mapModalOpen.value = true;
}

function closeMapModal() {
  mapModalOpen.value = false;
}

function openArchiveModal() {
  archiveModalOpen.value = true;
}

function closeArchiveModal() {
  archiveModalOpen.value = false;
}

function openWorldSettings(tab: "worldView" | "rules" | "preset" | "storyOutline" = "worldView") {
  worldSettingsTab.value = tab;
  worldSettingsOpen.value = true;
}

function closeWorldSettings() {
  worldSettingsOpen.value = false;
}

function openAlchemyModal() {
  alchemyModalOpen.value = true;
}

function closeAlchemyModal() {
  alchemyModalOpen.value = false;
}

function openForgeModal() {
  forgeModalOpen.value = true;
}

function closeForgeModal() {
  forgeModalOpen.value = false;
}

function openFactionModal() {
  factionModalOpen.value = true;
}

function closeFactionModal() {
  factionModalOpen.value = false;
}

/**
 * 打开「读取人生 / 切换存档」：入口在设置弹窗的「回合自动存档」分组里，
 * 这里只负责把信号转成弹窗开关（弹窗本体挂在本组件，切换流程仍需 emit 给 App）。
 */
function openSaveLoadModal(): void {
  settingsOpen.value = false;
  saveLoadOpen.value = true;
}

function closeSaveLoadModal() {
  saveLoadOpen.value = false;
}

function openSettingsModal() {
  settingsOpen.value = true;
}

function closeSettingsModal() {
  settingsOpen.value = false;
}

/** 读取另一个人生：先把当前进度落盘（避免丢档），再交给 App 切换。 */
function onLoadSave(value: { id: string; payload: MjSavePayload }): void {
  saveLoadOpen.value = false;
  try {
    writeActiveSave();
  } catch (e) {
    gameLog.warn("[读取人生] 切换前保存当前进度失败：" + (e instanceof Error ? e.message : String(e)));
  }
  emit("loadSave", value);
}
</script>

<template>
  <section class="main-panel main-panel--side" aria-label="功能面板">
    <div class="main-panel__body">
      <!-- 在场人物（置顶，无标题无外框）：不必打开「角色」就能看到身边有谁 -->
      <div class="side-present" aria-label="在场人物">
        <div class="side-present__toolbar">
          <button
            type="button"
            class="side-collapse-btn"
            title="折叠功能面板"
            aria-label="折叠功能面板"
            @click="emit('collapse')"
          >
            <span v-if="queuedProfiles + queuedWorld > 0" class="side-collapse__dot" aria-hidden="true"></span>
            »
          </button>
        </div>
        <div v-if="presentNpcs.length === 0" class="side-present__empty">当前地点没有其他人</div>
        <div v-else class="side-present__list">
          <NpcMiniCard
            v-for="npc in presentNpcs"
            :key="npc.id || npc.displayName"
            :npc="npc"
            @click="openNpcDetail(npc)"
          />
        </div>
      </div>

      <div class="side-btn-group">
        <button type="button" class="main-screen__btn side-btn" @click="openMapModal">世界地图</button>
        <button type="button" class="main-screen__btn side-btn" @click="openArchiveModal">
          角色<span v-if="queuedProfiles > 0" class="side-btn__badge">{{ queuedProfiles }}</span>
        </button>
        <button type="button" class="main-screen__btn side-btn" @click="openWorldSettings('storyOutline')">
          篇章<span v-if="queuedWorld > 0" class="side-btn__badge">{{ queuedWorld }}</span>
        </button>
        <button type="button" class="main-screen__btn side-btn" @click="openWorldSettings()">世界设定<span v-if="queuedWorld > 0" class="side-btn__badge">{{ queuedWorld }}</span></button>
        <button type="button" class="main-screen__btn side-btn" @click="openForgeModal">天道编辑</button>
        <button type="button" class="main-screen__btn side-btn" @click="openFactionModal">势力</button>
        <button type="button" class="main-screen__btn side-btn" @click="openAlchemyModal">炼丹</button>
        <button type="button" class="main-screen__btn side-btn" @click="emit('testBattle')" :disabled="props.testDisabled">战斗测试</button>
        <button type="button" class="main-screen__btn side-btn" @click="openSettingsModal">设置</button>
      </div>
    </div>
    <WorldMapModal
      :open="mapModalOpen"
      :current-location="props.currentLocation"
      @close="closeMapModal"
    />
    <AlchemyModal
      :open="alchemyModalOpen"
      @close="closeAlchemyModal"
    />
    <CharacterArchiveModal
      :open="archiveModalOpen"
      @close="closeArchiveModal"
    />
    <WorldSettingsModal
      :open="worldSettingsOpen"
      :initial-tab="worldSettingsTab"
      @close="closeWorldSettings"
    />
    <ItemForgeModal
      :open="forgeModalOpen"
      @close="closeForgeModal"
    />
    <FactionBoardModal
      :open="factionModalOpen"
      @close="closeFactionModal"
    />
    <SaveLoadModal
      :open="saveLoadOpen"
      @close="closeSaveLoadModal"
      @load="onLoadSave"
    />
    <NpcDetailModal
      :open="npcDetailOpen"
      :npc="npcDetailTarget"
      @close="closeNpcDetail"
    />
    <SettingsModal
      :open="settingsOpen"
      @close="closeSettingsModal"
      @open-saves="openSaveLoadModal"
    />
  </section>
</template>

<style scoped>
.side-btn {
  width: 100%;
  margin-bottom: 6px;
}

.side-btn:disabled {
  color: #888;
  cursor: not-allowed;
  opacity: 0.6;
}

.side-btn__badge {
  display: inline-block;
  margin-left: 5px;
  min-width: 15px;
  padding: 0 4px;
  line-height: 15px;
  border-radius: 8px;
  font-size: 0.62rem;
  color: #1b1710;
  background: var(--mj-gold, #e8c547);
  vertical-align: 1px;
}

/* 在场人物（置顶）：无外框、无标题，卡片尽可能大 */
.side-present {
  padding: 6px 6px 2px;
}

.side-present__toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  margin-bottom: 4px;
}

/* 待应用角标挂在折叠按钮角上，不占按钮内部空间 */
.side-present__toolbar .side-collapse-btn {
  position: relative;
}

.side-present__toolbar .side-collapse__dot {
  position: absolute;
  top: -3px;
  right: -3px;
}

.side-present__empty {
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.35);
  padding: 6px 2px;
}

.side-present__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: min(46vh, 420px);
  overflow-y: auto;
}

/* 卡片放大：头像由 46px 提到 88px；代价是压缩信息区，见下方血条。
   注意 mini 卡本体已去 padding，这里不要再叠 padding，否则头像贴不到边。 */
.side-present__list :deep(.npc-mini-avatar) {
  width: 88px;
  min-height: 84px;
}

.side-present__list :deep(.npc-mini-info) {
  padding: 7px 9px;
}

.side-present__list :deep(.npc-mini-avatar-placeholder) {
  font-size: 1.5rem;
}

/* 去掉 HP/MP 文字标签 + 血条缩短压矮，把横向空间让给头像 */
.side-present__list :deep(.npc-mini-bars) {
  max-width: 92px;
  gap: 3px;
}

.side-present__list :deep(.npc-mini-bar-label) {
  display: none;
}

.side-present__list :deep(.npc-mini-bar) {
  height: 6px;
}

.side-present__list :deep(.npc-mini-name) {
  font-size: 0.9rem;
}

.side-present__list :deep(.npc-mini-realm),
.side-present__list :deep(.npc-mini-identity) {
  font-size: 0.72rem;
}

</style>
