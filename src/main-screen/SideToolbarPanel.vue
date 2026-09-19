<script setup lang="ts">
import { computed, ref } from "vue";
import type { WorldLocation } from "../role_core/types/worldLocation";
import WorldMapModal from "./WorldMapModal.vue";
import AlchemyModal from "./AlchemyModal.vue";
import CharacterArchiveModal from "./CharacterArchiveModal.vue";
import WorldSettingsModal from "./WorldSettingsModal.vue";
import ItemForgeModal from "./ItemForgeModal.vue";
import SaveLoadModal from "./SaveLoadModal.vue";
import SettingsModal from "./SettingsModal.vue";
import type { MjSavePayload } from "../save/gameSave";
import { writeActiveSave } from "../save/gameSave";
import { gameLog } from "../log/gameLog";
import { hasPendingWorldSettings, pendingProfileCount } from "../role_core/pendingEdits";
import {
  autoTurnSaveCount,
  setAutoTurnSaveCount,
  MAX_AUTO_TURN_SAVES,
} from "../save/autoTurnSave";

const props = defineProps<{
  currentLocation?: WorldLocation | null;
  testDisabled?: boolean;
}>();

const emit = defineEmits<{
  testBattle: [];
  /** 请求读取另一个存档（转交 App 执行与标题界面一致的切换流程）。 */
  loadSave: [value: { id: string; payload: MjSavePayload }];
}>();

const mapModalOpen = ref(false);
const alchemyModalOpen = ref(false);
const archiveModalOpen = ref(false);
const worldSettingsOpen = ref(false);
/** 打开世界设定时默认落在哪个标签页；「剧情脉络」入口传 storyOutline。 */
const worldSettingsTab = ref<"worldView" | "rules" | "preset" | "storyOutline">("worldView");
const forgeModalOpen = ref(false);
const saveLoadOpen = ref(false);
const settingsOpen = ref(false);

/** 各类待回合结束才生效的改动条数（显示在对应按钮上）。 */
const queuedProfiles = computed(() => pendingProfileCount.value);
const queuedWorld = computed(() => (hasPendingWorldSettings.value ? 1 : 0));

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

/** 回合自动存档保留数量（0 = 关闭）；写入时夹取到 [0, MAX]。 */
const autoTurnCount = computed<number>({
  get: () => autoTurnSaveCount.value,
  set: (v) => setAutoTurnSaveCount(v),
});

function stepAutoTurn(delta: number): void {
  setAutoTurnSaveCount(autoTurnSaveCount.value + delta);
}

function openForgeModal() {
  forgeModalOpen.value = true;
}

function closeForgeModal() {
  forgeModalOpen.value = false;
}

function openSaveLoadModal() {
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
      <div class="side-btn-group">
        <button type="button" class="main-screen__btn side-btn" @click="openMapModal">世界地图</button>
        <button type="button" class="main-screen__btn side-btn" @click="openArchiveModal">
          人物档案<span v-if="queuedProfiles > 0" class="side-btn__badge">{{ queuedProfiles }}</span>
        </button>
        <button type="button" class="main-screen__btn side-btn" @click="openWorldSettings('storyOutline')">
          剧情脉络<span v-if="queuedWorld > 0" class="side-btn__badge">{{ queuedWorld }}</span>
        </button>
        <button type="button" class="main-screen__btn side-btn" @click="openWorldSettings()">世界设定<span v-if="queuedWorld > 0" class="side-btn__badge">{{ queuedWorld }}</span></button>
        <button type="button" class="main-screen__btn side-btn" @click="openForgeModal">天道编辑</button>
        <button type="button" class="main-screen__btn side-btn" @click="openAlchemyModal">炼丹</button>
        <button type="button" class="main-screen__btn side-btn" @click="emit('testBattle')" :disabled="props.testDisabled">战斗测试</button>
        <button type="button" class="main-screen__btn side-btn" @click="openSettingsModal">设置</button>
      </div>

      <div class="side-autosave">
        <span class="side-autosave__title">自动存档</span>
        <div class="side-autosave__row">
          <button
            type="button"
            class="side-autosave__step"
            title="减少"
            :disabled="autoTurnCount <= 0"
            @click="stepAutoTurn(-1)"
          >−</button>
          <input
            v-model.number="autoTurnCount"
            class="side-autosave__input"
            type="number"
            min="0"
            :max="MAX_AUTO_TURN_SAVES"
            aria-label="自动存档保留回合数"
          />
          <button
            type="button"
            class="side-autosave__step"
            title="增加"
            :disabled="autoTurnCount >= MAX_AUTO_TURN_SAVES"
            @click="stepAutoTurn(1)"
          >＋</button>
          <span class="side-autosave__unit">回合</span>
        </div>
        <p class="side-autosave__hint">
          每回合开始时另存一份快照，滚动保留最近 {{ autoTurnCount }} 个回合（0 = 关闭）。
        </p>
        <button type="button" class="side-autosave__load" @click="openSaveLoadModal">读取人生</button>
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
    <SaveLoadModal
      :open="saveLoadOpen"
      @close="closeSaveLoadModal"
      @load="onLoadSave"
    />
    <SettingsModal
      :open="settingsOpen"
      @close="closeSettingsModal"
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

/* 自动存档保留回合数 */
.side-autosave {
  margin-top: 10px;
  padding: 8px 8px 6px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.22);
}

.side-autosave__title {
  display: block;
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  color: #8d7a5f;
  margin-bottom: 6px;
}

.side-autosave__row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.side-autosave__step {
  width: 22px;
  height: 22px;
  line-height: 1;
  font-size: 0.9rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  color: #c3ab88;
  cursor: pointer;
  font-family: inherit;
}
.side-autosave__step:hover:not(:disabled) {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}
.side-autosave__step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.side-autosave__input {
  width: 46px;
  padding: 3px 4px;
  text-align: center;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  color: #f0d9b8;
  font-size: 0.78rem;
  font-family: inherit;
}
.side-autosave__input:focus {
  outline: none;
  border-color: var(--mj-gold, #e8c547);
}

.side-autosave__unit {
  font-size: 0.72rem;
  color: #8d7a5f;
}

.side-autosave__hint {
  margin: 6px 0 0;
  font-size: 0.66rem;
  line-height: 1.5;
  color: #8d7a5f;
}

/* 读取人生：与自动存档同组，放在其下方 */
.side-autosave__load {
  width: 100%;
  margin-top: 8px;
  padding: 5px 8px;
  font-size: 0.74rem;
  font-family: inherit;
  color: #c3ab88;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  cursor: pointer;
}
.side-autosave__load:hover {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}
</style>
