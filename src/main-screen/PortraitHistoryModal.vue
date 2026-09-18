<script setup lang="ts">
import { ref, watch } from "vue";
import { useScrollLock } from "../composables/useScrollLock";
import { resizeImageFileToPortrait, resizeImageFileToLandscape } from "./avatarUpload";

const props = defineProps<{
  open: boolean;
  displayName: string;
  candidates: string[];
  avatarUrl: string;
  aspectRatio?: string;
}>();

const emit = defineEmits<{
  close: [];
  select: [url: string];
  remove: [url: string];
  upload: [dataUrl: string];
}>();

const scrollLock = useScrollLock();

watch(
  () => props.open,
  (v) => {
    if (v) scrollLock.acquire();
    else scrollLock.release();
  },
);

const uploadFileInput = ref<HTMLInputElement | null>(null);
const uploadError = ref("");

function onUploadClick() {
  uploadError.value = "";
  uploadFileInput.value?.click();
}

async function onUploadFileChange(e: Event) {
  const input = e.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) {
    if (input) input.value = "";
    return;
  }
  try {
    const dataUrl =
      props.aspectRatio === "4/3"
        ? await resizeImageFileToLandscape(file)
        : await resizeImageFileToPortrait(file);
    emit("upload", dataUrl);
    uploadError.value = "";
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : "立绘上传失败。";
  } finally {
    if (input) input.value = "";
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    emit("close");
    e.preventDefault();
  }
}

// ── 立绘全屏预览 ──────────────────────────────────────────────────────────
const previewUrl = ref<string | null>(null);

function openPreview(url: string) {
  previewUrl.value = url;
}
function closePreview() {
  previewUrl.value = null;
}
function onPreviewKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    closePreview();
    e.preventDefault();
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="mj-backdrop">
      <div
        v-if="open"
        class="mj-portrait-hist-root"
        @keydown="onKeydown"
      >
        <div class="mj-portrait-hist-backdrop" @click="emit('close')"></div>
        <Transition name="mj-modal" appear>
          <div class="mj-portrait-hist-panel" role="dialog" aria-modal="true" :data-aspect="aspectRatio ?? '2/3'" @click.stop>
            <button type="button" class="mj-portrait-hist-close" aria-label="关闭" @click="emit('close')">×</button>
            <h4 class="mj-portrait-hist-title">历史立绘 · {{ displayName }}</h4>
            <p class="mj-portrait-hist-sub">点击选用，× 删除（高亮者为当前立绘）</p>
            <div v-if="candidates.length" class="mj-portrait-hist-grid">
              <div
                v-for="(url, idx) in candidates"
                :key="idx"
                class="mj-portrait-hist-card"
                :class="{ 'is-selected': url === avatarUrl }"
                :data-aspect="aspectRatio ?? '2/3'"
                title="点击选用这张立绘"
                @click="emit('select', url)"
              >
                <img :src="url" :alt="`${displayName} 立绘 ${idx + 1}`" />
                <span v-if="url === avatarUrl" class="mj-portrait-hist-badge">当前</span>
                <button
                  type="button"
                  class="mj-portrait-hist-del"
                  title="删除这张立绘"
                  @click.stop="emit('remove', url)"
                >×</button>
                <button
                  type="button"
                  class="mj-portrait-hist-zoom"
                  title="查看完整立绘"
                  @click.stop="openPreview(url)"
                >🔍</button>
              </div>
            </div>
            <p v-else class="mj-portrait-hist-empty">暂无历史立绘，点击「上传」创建。</p>
            <div class="mj-portrait-hist-footer">
              <p v-if="uploadError" class="mj-portrait-hist-upload-error">{{ uploadError }}</p>
              <button type="button" class="main-screen__btn mj-portrait-hist-upload-btn" @click="onUploadClick">⬆ 上传立绘</button>
              <input ref="uploadFileInput" type="file" accept="image/*" class="mj-portrait-hist-file-input" @change="onUploadFileChange" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="mj-backdrop">
      <div
        v-if="previewUrl"
        class="mj-portrait-hist-preview-root"
        @keydown="onPreviewKeydown"
      >
        <div class="mj-portrait-hist-preview-backdrop" @click="closePreview"></div>
        <div class="mj-portrait-hist-preview-wrap" @click="closePreview">
          <img :src="previewUrl" class="mj-portrait-hist-preview-img" alt="立绘预览" />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
