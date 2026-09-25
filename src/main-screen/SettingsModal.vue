<script setup lang="ts">
/**
 * 游戏内「设置」弹窗。
 *
 * 三项：
 * 1. 剧情正文字号缩放（0.8× ~ 2.0×），由 uiSettingsStore 持久化到 localStorage
 *    并写入 CSS 变量，刷新后依然生效；本弹窗只负责交互与预览。
 * 2. 场景配额（秘境层数上限 / 擂台轮次上限 / 同场景连续战斗波次上限）——
 *    用来拦住 AI 在秘境、擂台赛这类场景里「打完一波又来一波」的无限刷波。
 * 3. 篇章回合上限——篇章是玩家自选的短期目标，超过后只逐级温和加压、不设硬闸。
 * 4. 回合自动存档——保留最近 N 个回合的快照（0 = 关闭）；读取入口在侧栏「读取人生」。
 */
import { computed, watch, onMounted, onUnmounted } from "vue";
import { useScrollLock } from "../composables/useScrollLock";
import {
  storyFontScale,
  setStoryFontScale,
  resetStoryFontScale,
  STORY_FONT_SCALE_MIN,
  STORY_FONT_SCALE_MAX,
  STORY_FONT_SCALE_STEP,
  STORY_FONT_SCALE_DEFAULT,
} from "../role_core/uiSettingsStore";
import {
  sceneBudget,
  setSceneBudget,
  resetSceneBudget,
  resetSceneProgress,
  SCENE_BUDGET_MIN,
  SCENE_BUDGET_MAX,
  SCENE_BUDGET_DEFAULT,
  formatSceneProgress,
  type SceneBudgetSettings,
} from "../role_core/sceneBudgetStore";
import {
  chapter,
  chapterTurnLimit,
  setChapterTurnLimit,
  DEFAULT_CHAPTER_TURN_LIMIT,
  MIN_CHAPTER_TURN_LIMIT,
  MAX_CHAPTER_TURN_LIMIT,
} from "../role_core/chapterStore";
import {
  autoTurnSaveCount,
  setAutoTurnSaveCount,
  MAX_AUTO_TURN_SAVES,
} from "../save/autoTurnSave";
import {
  aiTimeoutSec,
  setAiTimeoutSec,
  resetAiTimeoutSec,
  AI_TIMEOUT_SEC_MIN,
  AI_TIMEOUT_SEC_MAX,
  AI_TIMEOUT_SEC_STEP,
  AI_TIMEOUT_SEC_DEFAULT,
  AI_TIMEOUT_HINT,
} from "../role_core/aiTimeoutStore";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  /** 请求打开「读取人生 / 切换存档」弹窗（宿主侧栏持有该弹窗，本弹窗只发信号）。 */
  openSaves: [];
}>();

const scrollLock = useScrollLock();

const scale = computed(() => storyFontScale.value);
/** 展示用的百分比（如 125%）。 */
const percentText = computed(() => `${Math.round(scale.value * 100)}%`);

/** 快捷档位：小 / 标准 / 大 / 特大。 */
const presets: { label: string; value: number }[] = [
  { label: "小", value: 0.9 },
  { label: "标准", value: 1 },
  { label: "大", value: 1.25 },
  { label: "特大", value: 1.5 },
];

function onSlide(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  if (Number.isFinite(v)) setStoryFontScale(v);
}

function step(delta: number): void {
  setStoryFontScale(scale.value + delta * STORY_FONT_SCALE_STEP);
}

function isActive(v: number): boolean {
  return Math.abs(scale.value - v) < STORY_FONT_SCALE_STEP / 2;
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && props.open) emit("close");
}

/* ---------- 场景配额 ---------- */

/** 三个配额的展示元信息（顺序即面板顺序）。 */
const budgetFields: {
  key: keyof SceneBudgetSettings;
  label: string;
  hint: string;
}[] = [
  { key: "secretRealmLayers", label: "秘境层数上限", hint: "秘境 / 古修洞府 / 试炼塔最多几层" },
  { key: "arenaRounds", label: "擂台轮次上限", hint: "擂台赛 / 宗门大比 / 车轮战最多几轮" },
  { key: "turnsPerStage", label: "每层 / 每轮回合数", hint: "一层（一轮）最多写几个回合；层/轮上限 × 此值 = 场景总回合预算" },
  { key: "battleWavesPerScene", label: "同场景战斗上限", hint: "同一场景内最多打几场；到顶后本场景不再开新战斗" },
];

const budget = computed(() => sceneBudget.value);

/** 当前进行中的场景进度（如「秘境·血色禁地 2/3 层」）；不在分层场景时为空。 */
const sceneProgressText = computed(() => formatSceneProgress());

function budgetValue(key: keyof SceneBudgetSettings): number {
  return budget.value[key];
}

function onBudgetInput(key: keyof SceneBudgetSettings, ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  if (Number.isFinite(v)) setSceneBudget({ [key]: v });
}

function isBudgetDefault(): boolean {
  return (Object.keys(SCENE_BUDGET_DEFAULT) as (keyof SceneBudgetSettings)[])
    .every(k => budget.value[k] === SCENE_BUDGET_DEFAULT[k]);
}

/* ---------- 篇章 ---------- */

/** 进行中的篇章进度（无篇章时为空）。 */
const chapterActive = computed(() => {
  const c = chapter.value;
  return c && c.status === "active" ? c : null;
});

/** 篇章是否已超上限（用于变色提示）。 */
const chapterOverdue = computed(() => !!chapterActive.value && chapterActive.value.turns > chapterTurnLimit.value);

function onChapterLimitInput(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  if (Number.isFinite(v)) setChapterTurnLimit(v);
}

function resetChapterLimit(): void {
  setChapterTurnLimit(DEFAULT_CHAPTER_TURN_LIMIT);
}

/* ---------- AI 请求超时 ---------- */

/** 单次 AI 请求的最长等待秒数。 */
const timeoutSec = computed(() => aiTimeoutSec.value);

/** 展示文案：满一分钟写「7 分 0 秒」这类，短于 60s 直接写秒。 */
const timeoutText = computed(() => {
  const s = timeoutSec.value;
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
});

function onTimeoutSlide(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  if (Number.isFinite(v)) setAiTimeoutSec(v);
}

function stepTimeout(delta: number): void {
  setAiTimeoutSec(timeoutSec.value + delta * AI_TIMEOUT_SEC_STEP);
}

function isTimeoutDefault(): boolean {
  return timeoutSec.value === AI_TIMEOUT_SEC_DEFAULT;
}

/* ---------- 回合自动存档 ---------- */

/** 保留的回合快照数量（0 = 关闭）；写入时由 setAutoTurnSaveCount 夹取到 [0, MAX]。 */
const autoTurn = computed<number>({
  get: () => autoTurnSaveCount.value,
  set: (v) => setAutoTurnSaveCount(v),
});

function onAutoTurnInput(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  if (Number.isFinite(v)) setAutoTurnSaveCount(v);
}

watch(
  () => props.open,
  (open) => {
    if (open) scrollLock.acquire();
    else scrollLock.release();
  },
  { immediate: true },
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  scrollLock.release();
});
</script>

<template>
  <div v-if="open" class="mj-settings-mask" @click.self="emit('close')">
    <div class="mj-settings" role="dialog" aria-modal="true" aria-label="设置">
      <header class="mj-settings__head">
        <h3 class="mj-settings__title">设置</h3>
        <button type="button" class="mj-settings__close" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="mj-settings__body">
        <section class="mj-settings__group">
          <div class="mj-settings__row">
            <span class="mj-settings__label">剧情字体大小</span>
            <span class="mj-settings__value">{{ percentText }}</span>
          </div>

          <div class="mj-settings__slider">
            <button
              type="button"
              class="mj-settings__step"
              title="减小"
              :disabled="scale <= STORY_FONT_SCALE_MIN"
              @click="step(-1)"
            >−</button>
            <input
              class="mj-settings__range"
              type="range"
              :min="STORY_FONT_SCALE_MIN"
              :max="STORY_FONT_SCALE_MAX"
              :step="STORY_FONT_SCALE_STEP"
              :value="scale"
              aria-label="剧情字体大小"
              @input="onSlide"
            />
            <button
              type="button"
              class="mj-settings__step"
              title="增大"
              :disabled="scale >= STORY_FONT_SCALE_MAX"
              @click="step(1)"
            >＋</button>
          </div>

          <div class="mj-settings__presets">
            <button
              v-for="p in presets"
              :key="p.label"
              type="button"
              class="mj-settings__preset"
              :class="{ 'is-active': isActive(p.value) }"
              @click="setStoryFontScale(p.value)"
            >{{ p.label }}</button>
            <button
              type="button"
              class="mj-settings__preset mj-settings__preset--reset"
              :disabled="isActive(STORY_FONT_SCALE_DEFAULT)"
              @click="resetStoryFontScale()"
            >恢复默认</button>
          </div>

          <p class="mj-settings__hint">
            只影响剧情正文（AI 生成的叙事段落），不影响界面按钮与面板文字。设置保存在本机浏览器，换设备不会同步。
          </p>

          <div class="mj-settings__preview">
            <span class="mj-settings__preview-tag">预览</span>
            <p class="mj-settings__preview-text" :style="{ fontSize: scale + 'rem' }">
              山风穿林而过，韩立袖中青元剑诀的最后一页已被翻得发皱。他抬眼望向雾中那道影子，指节缓缓收紧——
            </p>
          </div>
        </section>

        <section class="mj-settings__group">
          <div class="mj-settings__row">
            <span class="mj-settings__label">场景配额（防无限刷波）</span>
            <button
              type="button"
              class="mj-settings__preset mj-settings__preset--reset"
              :disabled="isBudgetDefault()"
              @click="resetSceneBudget()"
            >恢复默认</button>
          </div>

          <div v-for="f in budgetFields" :key="f.key" class="mj-settings__budget">
            <div class="mj-settings__budget-head">
              <span class="mj-settings__budget-label">{{ f.label }}</span>
              <span class="mj-settings__value">{{ budgetValue(f.key) }}</span>
            </div>
            <div class="mj-settings__slider">
              <button
                type="button"
                class="mj-settings__step"
                title="减少"
                :disabled="budgetValue(f.key) <= SCENE_BUDGET_MIN[f.key]"
                @click="setSceneBudget({ [f.key]: budgetValue(f.key) - 1 })"
              >−</button>
              <input
                class="mj-settings__range"
                type="range"
                :min="SCENE_BUDGET_MIN[f.key]"
                :max="SCENE_BUDGET_MAX[f.key]"
                :step="1"
                :value="budgetValue(f.key)"
                :aria-label="f.label"
                @input="onBudgetInput(f.key, $event)"
              />
              <button
                type="button"
                class="mj-settings__step"
                title="增加"
                :disabled="budgetValue(f.key) >= SCENE_BUDGET_MAX[f.key]"
                @click="setSceneBudget({ [f.key]: budgetValue(f.key) + 1 })"
              >＋</button>
            </div>
            <p class="mj-settings__budget-hint">{{ f.hint }}</p>
          </div>

          <p v-if="sceneProgressText" class="mj-settings__budget-now">
            当前场景进度：{{ sceneProgressText }}
            <button
              type="button"
              class="mj-settings__linkbtn"
              title="把当前场景进度清零，重新从第一层/第一轮开始计"
              @click="resetSceneProgress()"
            >清零进度</button>
          </p>

          <p class="mj-settings__hint">
            到顶后进入「收束锁」：每回合都要求 AI 把场景收掉（脱离 + 结算 + 转场），
            并直接拦截新的战斗触发（想再打也打不起来），直到 AI 收束为止。
            层/轮的推进由程序按回合数掌握，AI 不报进度也拦得住。
            修改只对新回合生效；设置保存在本机浏览器。
          </p>
        </section>

        <section class="mj-settings__group">
          <div class="mj-settings__row">
            <span class="mj-settings__label">篇章回合上限</span>
            <span class="mj-settings__value">{{ chapterTurnLimit }} 回合</span>
            <button
              type="button"
              class="mj-settings__preset mj-settings__preset--reset"
              :disabled="chapterTurnLimit === DEFAULT_CHAPTER_TURN_LIMIT"
              @click="resetChapterLimit()"
            >恢复默认</button>
          </div>

          <div class="mj-settings__slider">
            <button
              type="button"
              class="mj-settings__step"
              title="减少"
              :disabled="chapterTurnLimit <= MIN_CHAPTER_TURN_LIMIT"
              @click="setChapterTurnLimit(chapterTurnLimit - 1)"
            >−</button>
            <input
              class="mj-settings__range"
              type="range"
              :min="MIN_CHAPTER_TURN_LIMIT"
              :max="MAX_CHAPTER_TURN_LIMIT"
              :step="1"
              :value="chapterTurnLimit"
              aria-label="篇章回合上限"
              @input="onChapterLimitInput"
            />
            <button
              type="button"
              class="mj-settings__step"
              title="增加"
              :disabled="chapterTurnLimit >= MAX_CHAPTER_TURN_LIMIT"
              @click="setChapterTurnLimit(chapterTurnLimit + 1)"
            >＋</button>
          </div>

          <p v-if="chapterActive" class="mj-settings__budget-now" :class="{ 'is-overdue': chapterOverdue }">
            当前篇章：{{ chapterActive.title }} — 已进行 {{ chapterActive.turns }} / {{ chapterTurnLimit }} 回合
          </p>
          <p v-else class="mj-settings__budget-now">当前未开启篇章，AI 不会收到任何篇章指令。</p>

          <p class="mj-settings__hint">
            超过上限后逐级温和加压（先催收拢 → 再催最近一两回合内出结果 → 最后要求本回合必须推向结果），
            <b>不设硬闸</b> —— 篇章是方向不是枷锁，玩家在做别的事时它退为背景。
            篇章在「世界设定 → 主线 · 篇章」里开启；设置保存在本机浏览器，跨人生生效。
          </p>
        </section>

        <section class="mj-settings__group">
          <div class="mj-settings__row">
            <span class="mj-settings__label">回合自动存档</span>
            <span class="mj-settings__value">{{ autoTurn === 0 ? "已关闭" : autoTurn + " 回合" }}</span>
          </div>

          <div class="mj-settings__slider">
            <button
              type="button"
              class="mj-settings__step"
              title="减少"
              :disabled="autoTurn <= 0"
              @click="setAutoTurnSaveCount(autoTurn - 1)"
            >−</button>
            <input
              class="mj-settings__range"
              type="range"
              :min="0"
              :max="MAX_AUTO_TURN_SAVES"
              :step="1"
              :value="autoTurn"
              aria-label="回合自动存档保留数量"
              @input="onAutoTurnInput"
            />
            <button
              type="button"
              class="mj-settings__step"
              title="增加"
              :disabled="autoTurn >= MAX_AUTO_TURN_SAVES"
              @click="setAutoTurnSaveCount(autoTurn + 1)"
            >＋</button>
          </div>

          <p class="mj-settings__hint">
            每回合开始时另存一份快照，滚动保留最近 {{ autoTurn }} 个回合；设为 0 即关闭。
            调小会立即淘汰超出的旧快照。快照含立绘、较占空间，数量越大越容易顶到浏览器存储上限
            （顶到后会自动丢弃最旧快照，不影响主存档）。
          </p>

          <button
            type="button"
            class="mj-settings__widebtn"
            title="打开存档列表：读取人生 / 回到某个回合快照 / 删除存档"
            @click="emit('openSaves')"
          >读取人生 / 切换存档</button>
          <p class="mj-settings__hint">
            快照与主存档都在同一份列表里：快照名形如「某某 · 第N回合」，读取即回到那一回合的开头。
            切换前会自动把当前进度落盘，不会丢档。
          </p>
        </section>

        <section class="mj-settings__group">
          <div class="mj-settings__row">
            <span class="mj-settings__label">AI 请求超时</span>
            <span class="mj-settings__value">{{ timeoutText }}</span>
          </div>

          <div class="mj-settings__slider">
            <button
              type="button"
              class="mj-settings__step"
              title="减少 30 秒"
              :disabled="timeoutSec <= AI_TIMEOUT_SEC_MIN"
              @click="stepTimeout(-1)"
            >−</button>
            <input
              class="mj-settings__range"
              type="range"
              :min="AI_TIMEOUT_SEC_MIN"
              :max="AI_TIMEOUT_SEC_MAX"
              :step="AI_TIMEOUT_SEC_STEP"
              :value="timeoutSec"
              aria-label="AI 请求超时秒数"
              @input="onTimeoutSlide"
            />
            <button
              type="button"
              class="mj-settings__step"
              title="增加 30 秒"
              :disabled="timeoutSec >= AI_TIMEOUT_SEC_MAX"
              @click="stepTimeout(1)"
            >＋</button>
          </div>

          <button
            type="button"
            class="mj-settings__preset mj-settings__preset--reset"
            :disabled="isTimeoutDefault()"
            @click="resetAiTimeoutSec()"
          >恢复默认</button>

          <p class="mj-settings__hint">{{ AI_TIMEOUT_HINT }}</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mj-settings-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.62);
  padding: 16px;
}

.mj-settings {
  width: min(520px, 96vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(140, 120, 83, 0.45);
  border-radius: 6px;
  background: linear-gradient(180deg, #1b1710 0%, #141009 100%);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  color: #e8dcc2;
  font-family: inherit;
}

.mj-settings__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(140, 120, 83, 0.32);
}

.mj-settings__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--mj-gold, #e8c547);
}

.mj-settings__close {
  background: none;
  border: none;
  color: #a89574;
  font-size: 1rem;
  cursor: pointer;
  padding: 0 4px;
}
.mj-settings__close:hover {
  color: #f0d9b8;
}

.mj-settings__body {
  overflow-y: auto;
  padding: 12px 14px 16px;
}

.mj-settings__group {
  padding: 10px 12px 12px;
  border: 1px solid rgba(140, 120, 83, 0.32);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.22);
}

.mj-settings__group + .mj-settings__group {
  margin-top: 10px;
}

.mj-settings__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.mj-settings__label {
  font-size: 0.86rem;
  letter-spacing: 0.05em;
  color: #e8dcc2;
}

.mj-settings__value {
  font-size: 0.8rem;
  color: var(--mj-gold, #e8c547);
}

.mj-settings__slider {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mj-settings__step {
  width: 26px;
  height: 26px;
  flex: none;
  line-height: 1;
  font-size: 1rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  color: #c3ab88;
  cursor: pointer;
  font-family: inherit;
}
.mj-settings__step:hover:not(:disabled) {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}
.mj-settings__step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mj-settings__range {
  flex: 1;
  height: 20px;
  accent-color: var(--mj-gold, #e8c547);
  cursor: pointer;
}

.mj-settings__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.mj-settings__preset {
  padding: 4px 10px;
  font-size: 0.74rem;
  font-family: inherit;
  color: #c3ab88;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  cursor: pointer;
}
.mj-settings__preset:hover:not(:disabled) {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}
.mj-settings__preset.is-active {
  color: #1b1710;
  background: var(--mj-gold, #e8c547);
  border-color: var(--mj-gold, #e8c547);
}
.mj-settings__preset:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mj-settings__preset--reset {
  margin-left: auto;
}

.mj-settings__hint {
  margin: 10px 0 0;
  font-size: 0.68rem;
  line-height: 1.6;
  color: #8d7a5f;
}

.mj-settings__preview {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed rgba(140, 120, 83, 0.4);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
}

.mj-settings__preview-tag {
  display: block;
  margin-bottom: 6px;
  font-size: 0.64rem;
  letter-spacing: 0.12em;
  color: #8d7a5f;
}

.mj-settings__budget {
  margin-top: 12px;
}

.mj-settings__budget-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.mj-settings__budget-label {
  font-size: 0.8rem;
  color: #d8cbaf;
}

.mj-settings__budget-hint {
  margin: 4px 0 0;
  font-size: 0.66rem;
  color: #8d7a5f;
}

.mj-settings__budget-now {
  margin: 12px 0 0;
  font-size: 0.72rem;
  color: #c3ab88;
}

/* 篇章已超上限：换暖色提示，但仍只是提示，不拦任何操作 */
.mj-settings__budget-now.is-overdue {
  color: #e8c5a0;
}

.mj-settings__hint b {
  color: #c3ab88;
}

.mj-settings__linkbtn {
  margin-left: 6px;
  padding: 2px 8px;
  font-size: 0.68rem;
  font-family: inherit;
  color: #c3ab88;
  background: none;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  cursor: pointer;
}
.mj-settings__linkbtn:hover {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}

/* 组内的整宽动作按钮（如「读取人生」）：与预设按钮同款，但撑满一行并留出上下间距 */
.mj-settings__widebtn {
  display: block;
  width: 100%;
  margin-top: 12px;
  padding: 7px 10px;
  font-size: 0.8rem;
  font-family: inherit;
  color: #c3ab88;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  cursor: pointer;
}
.mj-settings__widebtn:hover {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}

.mj-settings__preview-text {
  margin: 0;
  font-family: var(--mj-font-story);
  line-height: 1.9;
  color: var(--mj-fg);
  /* 字号由 :style 内联绑定（scale rem），与剧情正文同源 */
}
</style>
