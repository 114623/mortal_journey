<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ProtagonistDetailAction, ProtagonistDetailPayload } from "./protagonistDetailPayload";
import { useScrollLock } from "../composables/useScrollLock";

const props = defineProps<{
  open: boolean;
  payload: ProtagonistDetailPayload | null;
}>();

const emit = defineEmits<{
  close: [];
  action: [a: ProtagonistDetailAction];
}>();

const scrollLock = useScrollLock();

function onActionClick(a: ProtagonistDetailAction) {
  emit("action", a);
}

function onBackdropClick() {
  emit("close");
}

function onCloseClick() {
  emit("close");
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && props.open) {
    if (sellConfirmOpen.value) {
      sellConfirmOpen.value = false;
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    emit("close");
  }
}

// ---- 售卖确认 ----
const sellConfirmOpen = ref(false);
const sellQty = ref(1);

const sellUnitPrice = computed(() => props.payload?.sell?.unitPrice ?? 0);
const sellMaxCount = computed(() => props.payload?.sell?.maxCount ?? 1);
const sellTotal = computed(
  () => sellUnitPrice.value * Math.max(1, Math.min(Math.floor(sellQty.value) || 1, sellMaxCount.value)),
);

function openSellConfirm() {
  const s = props.payload?.sell;
  if (!s) return;
  sellQty.value = s.maxCount;
  sellConfirmOpen.value = true;
}

function closeSellConfirm() {
  sellConfirmOpen.value = false;
}

function clampSellQty() {
  const max = sellMaxCount.value;
  let v = Math.floor(Number(sellQty.value));
  if (!isFinite(v) || v < 1) v = 1;
  if (v > max) v = max;
  sellQty.value = v;
}

function confirmSell() {
  const s = props.payload?.sell;
  if (!s) return;
  clampSellQty();
  const count = Math.max(1, Math.min(Math.floor(sellQty.value) || 1, sellMaxCount.value));
  emit("action", { id: "sellFromBag", inventoryIndex: s.inventoryIndex, count });
  sellConfirmOpen.value = false;
}

watch(
  () => props.open,
  (v) => {
    if (v) scrollLock.acquire();
    else {
      scrollLock.release();
      sellConfirmOpen.value = false;
    }
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
        v-if="open && payload"
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
            :data-rarity="payload.dataRarity"
            @click.stop
          >
        <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="onCloseClick">
          ×
        </button>
        <h4 class="mj-trait-modal-title">{{ payload.title }}</h4>
        <div class="mj-trait-modal-rarity">{{ payload.subtitle }}</div>
        <div
          class="mj-trait-modal-body"
          :class="{ 'mj-trait-modal-body--grid': payload.gridSections }"
        >
          <div v-for="(s, si) in payload.sections" :key="si" class="mj-trait-modal-section">
            <span class="mj-trait-modal-k">{{ s.label }}</span>
              <div class="mj-trait-modal-v">
              <template v-if="s.masteryLayer != null">
                <div class="mj-mastery-row">
                  <span class="mj-mastery-layer">{{ s.masteryLayer }}</span>
                  <span class="mj-mastery-exp">{{ s.masteryProgress }}</span>
                </div>
              </template>
              <template v-else>{{ s.text }}</template>
              <div v-if="s.progress && !s.progress.isMax" class="mj-mastery-progress">
                <div class="mj-mastery-progress-bar">
                  <div class="mj-mastery-progress-fill" :style="{ width: s.progress.percent + '%' }" />
                </div>
                <span class="mj-mastery-progress-pct">{{ s.progress.percent }}%</span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="payload.actions?.length" class="mj-item-detail-actions">
          <button
            v-for="(ab, ai) in payload.actions"
            :key="ai"
            type="button"
            class="mj-item-detail-action-btn"
            :class="{ 'mj-item-detail-action-btn--primary': ab.primary }"
            @click="onActionClick(ab.action)"
          >
            {{ ab.label }}
          </button>
        </div>
        <div v-if="payload.sell" class="mj-item-detail-sell">
          <button
            type="button"
            class="mj-item-detail-action-btn mj-item-detail-action-btn--sell"
            @click="openSellConfirm"
          >
            售卖
          </button>
        </div>
        <Transition name="mj-modal">
          <div
            v-if="sellConfirmOpen && payload.sell"
            class="mj-sell-confirm-overlay"
            @click.self="closeSellConfirm"
          >
            <div class="mj-sell-confirm-panel" @click.stop>
              <div class="mj-sell-confirm-title">售卖「{{ payload.sell.itemName }}」</div>
              <div class="mj-sell-confirm-field">
                <span class="mj-sell-confirm-label">数量</span>
                <input
                  class="mj-sell-confirm-input"
                  type="number"
                  min="1"
                  :max="payload.sell.maxCount"
                  v-model.number="sellQty"
                  @input="clampSellQty"
                  @keydown.enter.prevent="confirmSell"
                />
                <span class="mj-sell-confirm-label">/ {{ payload.sell.maxCount }}</span>
              </div>
              <div class="mj-sell-confirm-price">
                单价 {{ sellUnitPrice }} · 总价 <strong>{{ sellTotal }}</strong> 灵石
              </div>
              <div class="mj-sell-confirm-actions">
                <button type="button" class="mj-item-detail-action-btn" @click="closeSellConfirm">取消</button>
                <button
                  type="button"
                  class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                  @click="confirmSell"
                >
                  确认售卖
                </button>
              </div>
            </div>
          </div>
        </Transition>
       </div>
      </Transition>
    </div>
    </Transition>
  </Teleport>
</template>
