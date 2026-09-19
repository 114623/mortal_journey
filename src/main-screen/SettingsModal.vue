<script setup lang="ts">
/**
 * 游戏内「设置」弹窗。
 *
 * 目前只有一项：剧情正文字号缩放（0.8× ~ 2.0×）。
 * 设置值由 uiSettingsStore 持久化到 localStorage 并写入 CSS 变量，
 * 刷新后依然生效；本弹窗只负责交互与预览。
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

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
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

.mj-settings__preview-text {
  margin: 0;
  font-family: var(--mj-font-story);
  line-height: 1.9;
  color: var(--mj-fg);
  /* 字号由 :style 内联绑定（scale rem），与剧情正文同源 */
}
</style>
