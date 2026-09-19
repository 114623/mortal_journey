<script setup lang="ts">
/**
 * 世界设定弹窗：世界观 / 规则 / 预设 三段提示词的查看与编辑界面。
 *
 * 三段文本直接决定 AI 怎么写剧情与状态：
 * - 世界观：境界体系、寿元、灵根、称呼规则等世界常识（剧情 AI + 状态 AI 共用）。
 * - 规则：剧情长度、战斗红线、灵石经济、突破任务等玩法规则（剧情 AI）。
 * - 预设：台词与去旁白散文化、角色防全知、轻小说文风（剧情 AI 系列）。
 *
 * 输出契约（`<thinking>` + `<mj_story_body>` 标签结构）不在此列——它是解析层的硬要求，
 * 玩家改写会直接导致剧情解析失败。
 *
 * 随时可改；回合进行中保存会进「待应用队列」，本回合结束后生效。
 */
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import {
  createDefaultWorldSettings,
  isDefaultWorldSettings,
  type WorldSettingsText,
} from "../ai/worldSettings";
import { turnBusy } from "../role_core/turnLock";
import { worldSettings, setWorldSettings, writeGlobalWorldSettings } from "../role_core/worldSettingsStore";
import {
  clearPendingWorldSettings,
  getPendingWorldSettings,
  setPendingWorldSettings,
} from "../role_core/pendingEdits";
import { writeActiveSave } from "../save/gameSave";
import { useScrollLock } from "../composables/useScrollLock";

const props = defineProps<{
  open: boolean;
  /** 打开时默认落在哪个标签页（侧边栏「剧情脉络」入口传 storyOutline）。 */
  initialTab?: TabKey;
}>();

const emit = defineEmits<{
  close: [];
}>();

const scrollLock = useScrollLock();

/** 回合进行中：改动进队列，回合结束后生效。 */
const busy = computed(() => turnBusy.value);

type TabKey = "worldView" | "rules" | "preset" | "storyOutline";

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  {
    key: "worldView",
    label: "世界观",
    hint: "境界体系、寿元、灵根、称呼规则等世界常识。剧情 AI 与状态 AI 共用同一份。",
  },
  {
    key: "rules",
    label: "规则",
    hint: "剧情长度、战斗红线、灵石经济、突破任务、地点移动等玩法规则。只作用于剧情 AI。",
  },
  {
    key: "preset",
    label: "预设",
    hint: "台词与去旁白散文化、角色防全知、轻小说文风。作用于剧情 / 开局 / 修炼 / 结局 AI。",
  },
  {
    key: "storyOutline",
    label: "剧情脉络",
    hint: "在这里写下你希望的剧情发展方向供ai参考。可留空；非空时注入剧情 / 开局 / 修炼 / 结局 AI。",
  },
];

const OUTLINE_PLACEHOLDER =
  "例如：希望主角先加入青云宗，三年内筑基；中途遭遇一次背叛；长期目标是找到失踪的师姐……";

const activeTab = ref<TabKey>("worldView");
const draft = ref<WorldSettingsText>(createDefaultWorldSettings());

/** 是否有未应用的待生效改动。 */
const hasPending = computed(() => !!getPendingWorldSettings());
/** 编辑区是否与「已生效值」不同。 */
const dirty = computed(() => {
  const cur = worldSettings.value;
  return (
    draft.value.worldView !== cur.worldView ||
    draft.value.rules !== cur.rules ||
    draft.value.preset !== cur.preset ||
    draft.value.storyOutline !== cur.storyOutline
  );
});
/** 三段是否都不是默认文本。 */
const modified = computed(() => !isDefaultWorldSettings(draft.value));

const activeText = computed({
  get: () => draft.value[activeTab.value],
  set: (v: string) => {
    draft.value = { ...draft.value, [activeTab.value]: v };
  },
});

const activeHint = computed(() => TABS.find((t) => t.key === activeTab.value)?.hint ?? "");

const savedHint = ref("");

/** 打开时按「待应用草稿 → 已生效值」的优先顺序同步编辑区。 */
function syncDraft(): void {
  draft.value = { ...(getPendingWorldSettings() ?? worldSettings.value) };
  savedHint.value = "";
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      activeTab.value = props.initialTab ?? "worldView";
      syncDraft();
      scrollLock.acquire();
    } else {
      scrollLock.release();
    }
  },
);

function onSave(): void {
  const next: WorldSettingsText = {
    worldView: draft.value.worldView,
    rules: draft.value.rules,
    preset: draft.value.preset,
    storyOutline: draft.value.storyOutline,
  };
  // 两条分支都要写全局副本：玩家点「保存」即视为「这就是我想要的设定」，
  // 队列只是延后到回合结束再应用于当前人生，不影响它成为新人生的模板。
  writeGlobalWorldSettings(next);
  if (busy.value) {
    setPendingWorldSettings(next);
    savedHint.value = "已排队，本回合结束后应用。";
  } else {
    setWorldSettings(next);
    clearPendingWorldSettings();
    writeActiveSave();
    savedHint.value = "已保存并立即生效。";
  }
}

/** 把当前标签页恢复为内置默认文本（需再点保存）。 */
function onRestoreCurrent(): void {
  const def = createDefaultWorldSettings();
  draft.value = { ...draft.value, [activeTab.value]: def[activeTab.value] };
  savedHint.value = "";
}

/** 把三段全部恢复为内置默认文本（需再点保存）。 */
function onRestoreAll(): void {
  draft.value = createDefaultWorldSettings();
  savedHint.value = "";
}

/** 丢弃尚未应用的改动，回到已生效值。 */
function onDiscardPending(): void {
  clearPendingWorldSettings();
  syncDraft();
  savedHint.value = "已撤销待应用的改动。";
}

function onCloseClick(): void {
  emit("close");
}

function onBackdropClick(): void {
  emit("close");
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && props.open) {
    ev.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown, true);
});
onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="mj-backdrop">
      <div
        v-if="open"
        class="mj-trait-modal-root mj-protagonist-detail-root mj-worldset-root"
        role="presentation"
        aria-hidden="false"
      >
        <div
          class="mj-trait-modal-backdrop"
          tabindex="-1"
          aria-label="关闭"
          @click="onBackdropClick"
        />
        <Transition name="mj-modal" appear>
          <div
            class="mj-trait-modal mj-worldset-panel"
            role="dialog"
            aria-modal="true"
            @click.stop
          >
            <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="onCloseClick">
              ×
            </button>
            <h4 class="mj-trait-modal-title">世界设定</h4>
            <div class="mj-trait-modal-rarity">
              直接决定 AI 如何写剧情与状态，可随时修改<span v-if="modified" class="mj-worldset-modified">（已改动）</span>
            </div>
            <p class="mj-worldset-hint">
              保存后写入当前人生，并同步为<b>新开人生</b>的默认设定；读取其它人生时以该存档自身的设定为准。
            </p>

            <p v-if="busy" class="mj-worldset-banner mj-worldset-banner--busy">
              回合进行中：可以随时改，点「保存」后进入队列，<b>本回合结束后</b>才生效。
            </p>
            <p v-else-if="hasPending" class="mj-worldset-banner mj-worldset-banner--pending">
              有尚未应用的世界设定改动（已在编辑区显示），将在下一个回合结束后生效。
            </p>

            <div class="mj-worldset-tabs">
              <button
                v-for="t in TABS"
                :key="t.key"
                type="button"
                class="mj-worldset-tab"
                :class="{ 'mj-worldset-tab--active': activeTab === t.key }"
                @click="activeTab = t.key"
              >
                {{ t.label }}
              </button>
            </div>

            <p class="mj-worldset-hint">{{ activeHint }}</p>

            <textarea
              v-model="activeText"
              class="mj-worldset-input"
              :class="{ 'mj-worldset-input--short': activeTab === 'storyOutline' }"
              :placeholder="activeTab === 'storyOutline' ? OUTLINE_PLACEHOLDER : ''"
              spellcheck="false"
            />

            <div class="mj-worldset-meta">
              {{ activeText.length }} 字
              <span v-if="dirty" class="mj-worldset-dirty">· 有未保存的修改</span>
            </div>

            <p v-if="savedHint" class="mj-worldset-saved">{{ savedHint }}</p>

            <div class="mj-item-detail-actions">
              <button type="button" class="mj-item-detail-action-btn" @click="onRestoreCurrent">
                恢复本节默认
              </button>
              <button type="button" class="mj-item-detail-action-btn" @click="onRestoreAll">
                全部恢复默认
              </button>
              <button
                v-if="hasPending"
                type="button"
                class="mj-item-detail-action-btn"
                @click="onDiscardPending"
              >
                撤销待应用
              </button>
              <button
                type="button"
                class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                @click="onSave"
              >
                {{ busy ? '保存（回合结束后生效）' : '保存' }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mj-worldset-root .mj-trait-modal.mj-worldset-panel {
  max-width: 640px;
  width: min(92vw, 640px);
  max-height: min(86vh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mj-worldset-modified {
  color: var(--mj-gold, #e8c547);
}

.mj-worldset-banner {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 0.78rem;
  line-height: 1.45;
}

.mj-worldset-banner b {
  color: #f0d9b8;
}

.mj-worldset-banner--busy {
  color: #e8c5a0;
  background: rgba(198, 122, 58, 0.14);
  border: 1px solid rgba(198, 122, 58, 0.35);
}

.mj-worldset-banner--pending {
  color: #cfe0ff;
  background: rgba(88, 130, 200, 0.14);
  border: 1px solid rgba(120, 160, 230, 0.35);
}

.mj-worldset-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.mj-worldset-tab {
  flex: 1;
  padding: 6px 4px;
  font-size: 0.78rem;
  font-family: inherit;
  border-radius: 8px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: rgba(0, 0, 0, 0.28);
  color: var(--mj-text, #e8e4dc);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.mj-worldset-tab:hover {
  border-color: rgba(232, 197, 71, 0.35);
}

.mj-worldset-tab--active {
  color: #1b1710;
  background: var(--mj-gold, #e8c547);
  border-color: var(--mj-gold, #e8c547);
  font-weight: 600;
}

.mj-worldset-hint {
  margin: 0 0 6px;
  font-size: 0.68rem;
  line-height: 1.4;
  color: var(--mj-muted, #8a9088);
}

.mj-worldset-input {
  flex: 1;
  min-height: 260px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: rgba(0, 0, 0, 0.35);
  color: var(--mj-text, #e8e4dc);
  font-size: 0.74rem;
  line-height: 1.6;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  resize: none;
}

/* 剧情脉络通常是几句话，不必占满整屏高度 */
.mj-worldset-input--short {
  min-height: 160px;
}

.mj-worldset-input:focus {
  outline: none;
  border-color: var(--mj-gold-dim, #b89a4a);
  box-shadow: 0 0 0 1px rgba(232, 197, 71, 0.25);
}

.mj-worldset-meta {
  margin-top: 5px;
  font-size: 0.68rem;
  color: var(--mj-muted, #8a9088);
}

.mj-worldset-dirty {
  color: #e8c5a0;
}

.mj-worldset-saved {
  margin: 6px 0 0;
  font-size: 0.72rem;
  color: #9fd6a8;
}
</style>
