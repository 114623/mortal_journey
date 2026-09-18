<script setup lang="ts">
import { computed } from "vue";
import { LINGGEN_ELEMENT_EFFECTS } from "./types";
import { LINGGEN_CULTIVATION_MULT } from "../role_core/types/gameConstants";

const props = defineProps<{
  open: boolean;
  type: string;
  elements: string[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const cultivationSpeed = computed(() => {
  const mult = LINGGEN_CULTIVATION_MULT[props.elements.length] ?? 0.5;
  return Math.round(mult * 100) + "%";
});

const effectEntries = computed(() =>
  props.elements.map((el) => ({ element: el, effect: LINGGEN_ELEMENT_EFFECTS[el] ?? "未知效果" })),
);
</script>

<template>
  <Transition name="mj-backdrop">
    <div v-if="open" class="mj-trait-modal-root" aria-hidden="false">
      <div class="mj-trait-modal-backdrop" @click="emit('close')"></div>
      <Transition name="mj-modal" appear>
        <div class="mj-trait-modal" role="dialog" aria-modal="true">
          <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
          <h3 class="mj-trait-modal-title">{{ type }}</h3>
          <div class="mj-trait-modal-rarity">灵根元素：{{ elements.join('、') }}</div>
          <div class="mj-trait-modal-body">
            <div class="mj-trait-modal-section">
              <span class="mj-trait-modal-k">灵根效果</span>
              <div class="mj-trait-modal-v">
                <div v-for="entry in effectEntries" :key="entry.element" style="margin-bottom: 4px">
                  <span style="color: var(--mj-gold-dim)">{{ entry.element }}：</span>{{ entry.effect }}
                </div>
              </div>
            </div>
            <div class="mj-trait-modal-section">
              <span class="mj-trait-modal-k">修炼速度</span>
              <div class="mj-trait-modal-v">{{ cultivationSpeed }}</div>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
