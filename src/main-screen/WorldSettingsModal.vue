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
import {
  chapter,
  chapterTurnLimit,
  openChapter,
  updateChapter,
  closeChapter,
  clearChapter,
} from "../role_core/chapterStore";
import { storyStore } from "../role_core/storyStore";

const props = defineProps<{
  open: boolean;
  /** 打开时默认落在哪个标签页（侧边栏「篇章」入口传 storyOutline，即「主线 · 篇章」页）。 */
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
    label: "主线 · 篇章",
    hint: "上半部＝主线（你设定的长期方向，注入剧情 / 开局 / 修炼 / 结局 AI 与状态 AI）；下半部＝当前篇章（主线之下一个具体的短期目标，只作用于剧情 AI 与状态 AI）。都不填则完全不干扰 AI。",
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

/** 主线进度记录（状态 AI 每回合自报，只读展示，最多 10 条）。 */
const mainlineTrail = computed(() => storyStore.recentMainlineTrail());

const savedHint = ref("");

/** 打开时按「待应用草稿 → 已生效值」的优先顺序同步编辑区。 */
function syncDraft(): void {
  draft.value = { ...(getPendingWorldSettings() ?? worldSettings.value) };
  savedHint.value = "";
  syncChapterDraft();
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

/* ---------- 篇章 ---------- */

/** 篇章编辑草稿（标题/目标）。 */
const chapterTitle = ref("");
const chapterGoal = ref("");
/** 篇章区的操作反馈。 */
const chapterHint = ref("");
/** 「清除篇章」的两击确认：第一击进入待确认，第二击才真删。 */
const clearArmed = ref(false);

/** 当前是否有进行中的篇章。 */
const hasChapter = computed(() => !!chapter.value);
const isChapterActive = computed(() => chapter.value?.status === "active");

/** 把篇章草稿同步为当前篇章（无篇章时置空）。 */
function syncChapterDraft(): void {
  const cur = chapter.value;
  chapterTitle.value = cur?.title ?? "";
  chapterGoal.value = cur?.goal ?? "";
  clearArmed.value = false;
}

/** 篇章改动即时生效后落盘；回合进行中不写盘（回合结束会自动存）。 */
function commitChapter(msg: string): void {
  chapterHint.value = msg;
  if (busy.value) return;
  try {
    writeActiveSave();
  } catch {
    /* 写盘失败不阻断操作，回合结束还会再存一次 */
  }
}

function onOpenChapter(): void {
  if (!chapterTitle.value.trim()) {
    chapterHint.value = "篇章名不能为空。";
    return;
  }
  openChapter(chapterTitle.value, chapterGoal.value);
  syncChapterDraft();
  commitChapter(isChapterActive.value ? "已开启篇章，下一回合起注入 AI。" : "篇章已开启但状态异常，请重开。");
}

function onSaveChapter(): void {
  if (!chapter.value) return;
  updateChapter({ title: chapterTitle.value, goal: chapterGoal.value });
  syncChapterDraft();
  commitChapter("已更新篇章。");
}

function onCloseChapter(): void {
  if (!chapter.value) return;
  // 先把输入框里没点「保存修改」的改动落下去，再收束——否则玩家改完直接点收束会白改。
  updateChapter({ title: chapterTitle.value, goal: chapterGoal.value });
  closeChapter();
  syncChapterDraft();
  commitChapter("已收束。收束不等于成功，可在下方改个名字重新开启新篇章。");
}

/** 两击确认：第一击只是「上膛」。 */
function onClearChapter(): void {
  if (!clearArmed.value) {
    clearArmed.value = true;
    chapterHint.value = "再点一次「确认清除」即可彻底删除当前篇章。";
    return;
  }
  clearChapter();
  syncChapterDraft();
  chapterHint.value = "已清除篇章，AI 不再收到任何篇章指令。";
  if (!busy.value) {
    try {
      writeActiveSave();
    } catch {
      /* ignore */
    }
  }
}

/** 切标签页时取消「上膛」，避免误删。 */
watch(activeTab, () => {
  clearArmed.value = false;
});

/** 篇章被外部改动（如读档）时同步编辑区。 */
watch(chapter, syncChapterDraft);

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

            <!-- 篇章：只在「主线 · 篇章」页出现；不开篇章时 AI 完全收不到篇章指令 -->
            <section v-if="activeTab === 'storyOutline'" class="mj-worldset-chapter">
              <div class="mj-worldset-chapter-head">
                <span class="mj-worldset-chapter-title">当前篇章</span>
                <span
                  class="mj-worldset-chapter-state"
                  :class="{ 'is-active': isChapterActive }"
                >{{ !hasChapter ? '未开启' : (isChapterActive ? '进行中' : '已收束') }}</span>
                <span v-if="hasChapter" class="mj-worldset-chapter-turns">
                  已进行 {{ chapter?.turns ?? 0 }} / 上限 {{ chapterTurnLimit }} 回合
                </span>
              </div>

              <input
                v-model="chapterTitle"
                class="mj-worldset-chapter-input"
                placeholder="篇章名，如：查明血色禁地失踪的弟子"
                spellcheck="false"
              />
              <input
                v-model="chapterGoal"
                class="mj-worldset-chapter-input"
                placeholder="目标，如：拿到禁地第三层的令牌，且不被宗门发现"
                spellcheck="false"
              />

              <div class="mj-worldset-chapter-actions">
                <button
                  v-if="!hasChapter"
                  type="button"
                  class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                  @click="onOpenChapter"
                >开启篇章</button>
                <template v-else>
                  <button
                    v-if="isChapterActive"
                    type="button"
                    class="mj-item-detail-action-btn"
                    @click="onSaveChapter"
                  >保存修改</button>
                  <button
                    v-if="isChapterActive"
                    type="button"
                    class="mj-item-detail-action-btn"
                    @click="onCloseChapter"
                  >收束篇章</button>
                  <button
                    v-else
                    type="button"
                    class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                    @click="onOpenChapter"
                  >重新开启（回合数归零）</button>
                  <button
                    type="button"
                    class="mj-item-detail-action-btn"
                    :class="{ 'mj-worldset-chapter-danger': clearArmed }"
                    @click="onClearChapter"
                  >{{ clearArmed ? '确认清除' : '清除篇章' }}</button>
                </template>
              </div>

              <p v-if="chapterHint" class="mj-worldset-chapter-hint">{{ chapterHint }}</p>
              <p class="mj-worldset-chapter-note">
                不开启篇章时，AI 完全不会看到任何篇章字样；开启后每回合以「推进 / 受阻 / 铺垫 / 背景压力」
                四种方式之一服务它，但<b>玩家输入始终优先</b>，绝不硬拽回篇章。
              </p>
            </section>

            <!-- 主线进度记录：只读，状态 AI 每回合自报，玩家据此验证主线闭环在转 -->
            <section v-if="activeTab === 'storyOutline'" class="mj-worldset-mainline">
              <div class="mj-worldset-chapter-head">
                <span class="mj-worldset-chapter-title">主线进度记录</span>
                <span class="mj-worldset-chapter-state">{{ mainlineTrail.length > 0 ? `最近 ${mainlineTrail.length} 回合` : "暂无" }}</span>
              </div>
              <ul v-if="mainlineTrail.length > 0" class="mj-worldset-mainline-list">
                <li v-for="(t, i) in mainlineTrail" :key="i" class="mj-worldset-mainline-item">
                  <span class="mj-worldset-mainline-mark" :class="t.advanced ? 'is-advanced' : 'is-idle'">
                    {{ t.advanced ? "✅" : "❌" }}
                  </span>
                  <span class="mj-worldset-mainline-round">第{{ t.round }}回合</span>
                  <span v-if="t.advanced && t.note" class="mj-worldset-mainline-note">{{ t.note }}</span>
                  <span v-else class="mj-worldset-mainline-note is-dim">本回合未触及主线</span>
                </li>
              </ul>
              <p v-else class="mj-worldset-chapter-hint">
                还没有记录。写下主线后每回合由状态 AI 自报：✅ = 与主线有关，❌ = 本回合在忙别的。
              </p>
              <p class="mj-worldset-chapter-note">
                连续多回合 ❌ 时，剧情 AI 会让环境 / NPC 把线索往你身边送（不打断你正在做的事）。
              </p>
            </section>

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

/* 主线通常只有几句话：定高，把剩余空间让给下方的篇章区 */
.mj-worldset-input--short {
  flex: none;
  height: 150px;
  min-height: 150px;
}

/* 篇章编辑区：占据主线文本框以下的剩余高度，内容多时自身滚动 */
.mj-worldset-chapter {
  flex: 1;
  min-height: 0;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  overflow-y: auto;
}

.mj-worldset-chapter-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.mj-worldset-chapter-title {
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  color: #d8cbaf;
}

.mj-worldset-chapter-state {
  padding: 1px 7px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 8px;
  font-size: 0.66rem;
  color: var(--mj-muted, #8a9088);
}

.mj-worldset-chapter-state.is-active {
  color: var(--mj-gold, #e8c547);
  border-color: var(--mj-gold-dim, #b89a4a);
}

.mj-worldset-chapter-turns {
  margin-left: auto;
  font-size: 0.66rem;
  color: var(--mj-muted, #8a9088);
}

.mj-worldset-chapter-input {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: rgba(0, 0, 0, 0.35);
  color: var(--mj-text, #e8e4dc);
  font-size: 0.74rem;
  line-height: 1.5;
  font-family: inherit;
}

.mj-worldset-chapter-input:focus {
  outline: none;
  border-color: var(--mj-gold-dim, #b89a4a);
}

.mj-worldset-chapter-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.mj-worldset-chapter-danger {
  color: #e88b7d;
  border-color: rgba(232, 139, 125, 0.5);
}

.mj-worldset-chapter-hint {
  margin: 8px 0 0;
  font-size: 0.7rem;
  line-height: 1.5;
  color: #9fd6a8;
}

.mj-worldset-chapter-note {
  margin: 8px 0 0;
  font-size: 0.66rem;
  line-height: 1.55;
  color: var(--mj-muted, #8a9088);
}

.mj-worldset-chapter-note b {
  color: #c3ab88;
}

/* 主线进度记录（只读列表，随存档保存，最多展示 10 条） */
.mj-worldset-mainline {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--mj-border-subtle, rgba(140, 150, 140, 0.18));
}

.mj-worldset-mainline-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.mj-worldset-mainline-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--mj-fg, #dfe4dc);
}

.mj-worldset-mainline-mark {
  flex: none;
}

.mj-worldset-mainline-round {
  flex: none;
  color: var(--mj-muted, #8a9088);
}

.mj-worldset-mainline-note {
  word-break: break-word;
}

.mj-worldset-mainline-note.is-dim {
  color: var(--mj-muted, #8a9088);
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
