<script setup lang="ts">
import type { TraitOption } from "./useFateChoice";
import { describeTraitEffect } from "./traitEffect";

defineProps<{
  trait: TraitOption | null;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <Transition name="mj-backdrop">
    <div
      v-if="trait"
      class="mj-trait-modal-root"
      aria-hidden="false"
    >
      <div class="mj-trait-modal-backdrop" @click="emit('close')"></div>
      <Transition name="mj-modal" appear>
        <div
          class="mj-trait-modal"
          :data-rarity="trait.rarity"
          role="dialog"
          aria-modal="true"
        >
          <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
          <h3 class="mj-trait-modal-title">{{ trait.name }}</h3>
          <div class="mj-trait-modal-rarity">品质：{{ trait.rarity }}</div>
          <div class="mj-trait-modal-body">
            <div class="mj-trait-modal-section">
              <span class="mj-trait-modal-k">简述</span>
              <div class="mj-trait-modal-v">{{ trait.desc }}</div>
            </div>
            <div v-if="describeTraitEffect(trait.effect)" class="mj-trait-modal-section">
              <span class="mj-trait-modal-k">效果</span>
              <div class="mj-trait-modal-v">{{ describeTraitEffect(trait.effect) }}</div>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
