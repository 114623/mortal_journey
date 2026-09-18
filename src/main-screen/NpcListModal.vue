<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from "vue";
import { npcStore } from "../role_core/npcStore";
import { buildNpcListEntryPayload } from "./npcDetailPayload";
import type { Npc } from "../role_core/Npc";
import { useScrollLock } from "../composables/useScrollLock";
import NpcDetailModal from "./NpcDetailModal.vue";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const scrollLock = useScrollLock();

const detailOpen = ref(false);
const detailNpc = shallowRef<Npc | null>(null);

const npcList = computed(() => {
  const list = [];
  for (const npc of npcStore.npcs.value.values()) {
    list.push({
      npc,
      summary: buildNpcListEntryPayload(npc),
    });
  }
  return list;
});

function onBackdropClick() {
  emit("close");
}

function onCloseClick() {
  emit("close");
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && props.open && !detailOpen.value) {
    ev.preventDefault();
    emit("close");
  }
}

function openNpcDetail(npcIndex: number) {
  const entry = npcList.value[npcIndex];
  if (!entry) return;
  detailNpc.value = entry.npc;
  detailOpen.value = true;
}

function closeNpcDetail() {
  detailOpen.value = false;
  detailNpc.value = null;
}

watch(
  () => props.open,
  (v) => {
    if (v) scrollLock.acquire();
    else scrollLock.release();
  },
);

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
        class="mj-trait-modal-root mj-protagonist-detail-root"
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
            class="mj-trait-modal mj-item-detail-panel"
            role="dialog"
            aria-modal="true"
            @click.stop
          >
        <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="onCloseClick">
          ×
        </button>
        <h4 class="mj-trait-modal-title">当前场景 NPC</h4>
        <div class="mj-trait-modal-body">
          <div v-if="npcList.length === 0" class="npc-list-empty">
            当前场景没有 NPC
          </div>
          <div
            v-for="(entry, idx) in npcList"
            :key="idx"
            class="npc-list-entry"
            :class="{ 'npc-list-entry--dead': entry.summary.isDead }"
            @click="openNpcDetail(idx)"
          >
            <div class="npc-list-entry__name">
              <template v-if="entry.summary.isDead">
                <s>{{ entry.summary.title }}</s> <span style="font-size:11px;color:#c62828;">（已故）</span>
              </template>
              <template v-else>{{ entry.summary.title }}</template>
            </div>
            <div class="npc-list-entry__sub">{{ entry.summary.subtitle }}</div>
            <div class="npc-list-entry__bar-wrap">
              <div class="npc-list-entry__bar">
                <div class="mj-bar">
                  <div class="mj-bar-fill mj-bar-fill--hp" :style="{ width: entry.summary.hpPct + '%' }" />
                </div>
              </div>
              <div class="npc-list-entry__bar">
                <div class="mj-bar">
                  <div class="mj-bar-fill mj-bar-fill--mp" :style="{ width: entry.summary.mpPct + '%' }" />
                </div>
              </div>
            </div>
            <div class="npc-list-entry__favor">好感：{{ entry.summary.favorLabel }}（{{ entry.summary.favorability }}）</div>
          </div>
        </div>
       </div>
      </Transition>
    </div>
    </Transition>
    <NpcDetailModal
      :open="detailOpen"
      :npc="detailNpc"
      @close="closeNpcDetail"
    />
  </Teleport>
</template>

<style scoped>
.npc-list-entry {
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  transition: background 0.15s;
}
.npc-list-entry:hover {
  background: rgba(255,255,255,0.06);
}
.npc-list-entry--dead {
  opacity: 0.45;
}
.npc-list-entry__name {
  font-weight: bold;
  font-size: 14px;
}
.npc-list-entry__sub {
  font-size: 12px;
  color: rgba(255,255,255,0.55);
}
.npc-list-entry__favor {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
}
.npc-list-entry__bar-wrap {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  align-items: center;
}
.npc-list-entry__bar {
  flex: 1;
}
.npc-list-empty {
  padding: 24px;
  text-align: center;
  color: rgba(255,255,255,0.4);
}
</style>
