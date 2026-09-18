<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useFateChoice } from "./useFateChoice";
import type { FateChoiceResult, NarrationPerson, DifficultyLevel } from "./types";
import type { TraitOption } from "./useFateChoice";
import { parseRealmFromCustomText } from "./useFateChoice";
import { CUSTOM_REALM_MAJORS, CUSTOM_REALM_MINORS, START_REALM_MAJOR } from "./types";
import { formatWorldLocationDash } from "../role_core/types/worldLocation";
import TraitDetailModal from "./TraitDetailModal.vue";
import LinggenDetailModal from "./LinggenDetailModal.vue";
import CustomBirthModal from "./CustomBirthModal.vue";

const props = defineProps<{ visible: boolean }>();

const emit = defineEmits<{
  close: [];
  complete: [payload: FateChoiceResult];
}>();

const {
  CREATION_BIRTHS,
  CREATION_GENDERS,
  DIFFICULTY_OPTIONS,
  birthKeysOrdered,
  selectedDifficulty,
  selectedBirth,
  customBirth,
  selectedGender,
  narrationPerson,
  playerName,
  currentTraitOptions,
  selectedLinggen,
  statusMessage,
  isReady,
  reset,
  prepareInitialRolls,
  randomizeTraits,
  toggleTraitLock,
  applyRandomLinggen,
  buildPayload,
  selectBirth,
  applyCustomBirth,
  resolveBirthLocationDescFromDef,
} = useFateChoice();

function birthCardBlurb(birthKey: string): string {
  const bd = CREATION_BIRTHS[birthKey];
  return bd ? resolveBirthLocationDescFromDef(bd) : "";
}

const traitDetailTrait = ref<TraitOption | null>(null);
const linggenDetailOpen = ref(false);
const customModalOpen = ref(false);

const customModalInitial = computed(() => {
  const cb = customBirth.value;
  const fill = selectedBirth.value === "自定义" && cb && !cb.presetBirthKey;
  if (!fill || !cb) {
    return {
      location: { region: "", country: "", area: "", detail: "" } as import("../role_core/types/worldLocation").WorldLocation,
      realmMajor: START_REALM_MAJOR,
      realmMinor: CUSTOM_REALM_MINORS[0]!,
      background: "",
    };
  }
  let maj: string = START_REALM_MAJOR;
  let mino: string = CUSTOM_REALM_MINORS[0]!;
  if (cb.realmMajor && (CUSTOM_REALM_MAJORS as readonly string[]).includes(cb.realmMajor)) {
    maj = cb.realmMajor;
    if (cb.realmMinor && (CUSTOM_REALM_MINORS as readonly string[]).includes(cb.realmMinor)) {
      mino = cb.realmMinor;
    }
  } else if (cb.realmText) {
    const parsed = parseRealmFromCustomText(cb.realmText);
    if (parsed?.major) {
      maj = parsed.major;
      if (parsed.minor && (CUSTOM_REALM_MINORS as readonly string[]).includes(parsed.minor)) mino = parsed.minor;
    }
  }
  return {
    location: cb.location ?? { region: "", country: "", area: "", detail: "" },
    realmMajor: maj,
    realmMinor: mino,
    background: cb.background ?? "",
  };
});

const linggenParts = computed(() => {
  const name = selectedLinggen.value;
  if (!name) return { type: "", elements: [] as string[] };
  const parts = name.split(/\s+/);
  const type = parts[0] || "";
  const elements = parts.slice(1).map((el) => el.replace(/,/g, ""));
  return { type, elements };
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      reset();
      prepareInitialRolls();
      traitDetailTrait.value = null;
      linggenDetailOpen.value = false;
      customModalOpen.value = false;
      statusMessage.value = "";
    }
  },
  { immediate: true },
);

function onBackdropKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (traitDetailTrait.value) {
      traitDetailTrait.value = null;
      e.preventDefault();
      return;
    }
    if (customModalOpen.value) {
      customModalOpen.value = false;
      e.preventDefault();
      return;
    }
    if (linggenDetailOpen.value) {
      linggenDetailOpen.value = false;
      e.preventDefault();
      return;
    }
  }
}

function onBirthCardClick(name: string): void {
  if (name === "自定义") {
    customModalOpen.value = true;
    return;
  }
  selectBirth(name);
}

function onCustomBirthConfirm(payload: import("./types").CustomBirthPayload): void {
  applyCustomBirth(payload);
  customModalOpen.value = false;
}

function onConfirm(): void {
  if (!isReady.value) {
    statusMessage.value = "请完成姓名、叙事人称、性别、出身、灵根与天赋词条。";
    return;
  }
  const payload = buildPayload();
  emit("complete", payload);
}

function narrationDesc(key: string): string {
  if (key === "first") return "我";
  if (key === "second") return "你";
  return String(playerName.value || "无限");
}

function setNarrationPerson(key: string): void {
  if (key === "first" || key === "second" || key === "third") {
    narrationPerson.value = key as NarrationPerson;
  }
}

function setDifficulty(key: string): void {
  if (key === "简单" || key === "正常" || key === "困难") {
    selectedDifficulty.value = key as DifficultyLevel;
  }
}

function customBirthSummary(): string {
  if (selectedBirth.value !== "自定义" || !customBirth.value) {
    return "点击填写出身地点、境界与背景";
  }
  const c = customBirth.value;
  const a = formatWorldLocationDash(c.location) || String(c.tag || "").slice(0, 40);
  const b = String(c.realmText || "").slice(0, 16);
  return a + " · " + b;
}
</script>

<template>
  <Teleport to="body">
    <div
      id="fc-character-screen"
      class="fc-screen"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fc-step-title"
      @keydown="onBackdropKeydown"
    >
      <div class="creation-container" tabindex="-1">
        <div class="creation-content">
          <div class="creation-step-header">
            <div>
              <div id="fc-step-title" class="creation-step-title">
                <i class="fas fa-scroll" aria-hidden="true"></i>
                <span>命运抉择</span>
              </div>
              <div class="creation-step-subtitle">完成配置后点击「确认选择」生成开局 JSON（属性由后续流程计算）</div>
            </div>
          </div>

          <div class="creation-section-title"><i class="fas fa-skull-crossbones"></i> 难度</div>
          <div class="creation-grid">
            <div
              v-for="opt in DIFFICULTY_OPTIONS"
              :key="opt.key"
              class="creation-card"
              :class="{ selected: selectedDifficulty === opt.key }"
              role="button"
              tabindex="0"
              @click="setDifficulty(opt.key)"
              @keydown.enter="setDifficulty(opt.key)"
            >
              <h4>{{ opt.title }}</h4>
              <p>{{ opt.desc }}</p>
            </div>
          </div>

          <div class="creation-section-title"><i class="fas fa-user"></i> 姓名</div>
          <div style="max-width: 620px">
            <input
              v-model="playerName"
              type="text"
              maxlength="24"
              placeholder="请输入姓名"
              class="fc-name-input"
            />
          </div>

          <div class="creation-section-title"><i class="fas fa-pen-fancy"></i> 叙事人称</div>
          <div class="creation-grid">
            <div
              v-for="row in [
                { key: 'first', title: '第一人称' },
                { key: 'second', title: '第二人称' },
                { key: 'third', title: '第三人称' },
              ]"
              :key="row.key"
              class="creation-card"
              :class="{ selected: narrationPerson === row.key }"
              role="button"
              tabindex="0"
              @click="setNarrationPerson(row.key)"
              @keydown.enter="setNarrationPerson(row.key)"
            >
              <h4>{{ row.title }}</h4>
              <p>{{ narrationDesc(row.key) }}</p>
            </div>
          </div>

          <div class="creation-section-title"><i class="fas fa-venus-mars"></i> 性别</div>
          <div class="creation-grid">
            <div
              v-for="name in CREATION_GENDERS"
              :key="name"
              class="creation-card"
              :class="{ selected: selectedGender === name }"
              role="button"
              tabindex="0"
              @click="selectedGender = name"
              @keydown.enter="selectedGender = name"
            >
              <h4>{{ name }}</h4>
            </div>
          </div>

          <div class="creation-section-title"><i class="fas fa-baby"></i> 选择出身</div>
          <div class="creation-grid">
            <template v-for="name in birthKeysOrdered" :key="name">
              <div
                v-if="name === '自定义'"
                class="creation-card"
                :class="{ selected: selectedBirth === '自定义' }"
                role="button"
                tabindex="0"
                @click="onBirthCardClick('自定义')"
                @keydown.enter="onBirthCardClick('自定义')"
              >
                <h4><span>自定义出身</span></h4>
                <p>{{ customBirthSummary() }}</p>
              </div>
              <div
                v-else-if="CREATION_BIRTHS[name]"
                class="creation-card"
                :class="{ selected: selectedBirth === name }"
                role="button"
                tabindex="0"
                @click="onBirthCardClick(name)"
                @keydown.enter="onBirthCardClick(name)"
              >
                <h4><span>{{ name }}</span></h4>
                <p v-if="birthCardBlurb(name)">{{ birthCardBlurb(name) }}</p>
              </div>
            </template>
          </div>

          <div class="creation-section-title"><i class="fas fa-star"></i> 天赋词条</div>
          <div class="fc-trait-stack">
            <div class="action-buttons-grid" style="width: 100%; max-width: 620px; margin: 0 auto">
              <button
                type="button"
                class="major-action-button"
                @click="randomizeTraits()"
              >
                <i class="fas fa-dice"></i> 逆天改命
              </button>
              <p class="fc-trait-hint">点击卡片左下角 🔒 锁定想保留的词条，「逆天改命」不会替换已锁定的词条。</p>
            </div>
            <div id="trait-options-container">
              <template v-if="currentTraitOptions.length">
                <div
                  v-for="(trait, idx) in currentTraitOptions"
                  :key="trait.name"
                  class="trait-card"
                  :class="{ 'trait-locked': trait.locked }"
                  :data-rarity="trait.rarity"
                  :data-trait-name="trait.name"
                >
                  <div class="trait-rarity">{{ trait.rarity }}</div>
                  <div class="trait-name">{{ trait.name }}</div>
                  <button
                    type="button"
                    class="trait-lock-btn"
                    :title="trait.locked ? '解锁' : '锁定（逆天改命时保留）'"
                    @click.stop="toggleTraitLock(idx)"
                  >
                    <i :class="trait.locked ? 'fas fa-lock' : 'fas fa-lock-open'"></i>
                  </button>
                  <button
                    type="button"
                    class="trait-detail-btn"
                    title="查看详情"
                    @click.stop="traitDetailTrait = trait"
                  >
                    <i class="fas fa-info-circle"></i>
                  </button>
                </div>
              </template>
              <div v-else class="muted" style="text-align: center; opacity: 0.7">尚未刷新候选词条，点击「逆天改命」。</div>
            </div>
          </div>

          <div class="creation-section-title"><i class="fas fa-bolt"></i> 灵根</div>
          <div class="fc-linggen-block">
            <div id="linggen-result-display" style="transform: scale(1.08)">
              <div
                v-if="linggenParts.type"
                class="linggen-orb"
                :class="'orb-type-' + linggenParts.type"
              >
                <div class="linggen-tag" :class="'tag-type-' + linggenParts.type">{{ linggenParts.type }}</div>
                <div class="linggen-elements">{{ linggenParts.elements.join(" ") }}</div>
                <button
                  type="button"
                  class="trait-detail-btn"
                  title="查看灵根详情"
                  @click.stop="linggenDetailOpen = true"
                >
                  <i class="fas fa-info-circle"></i>
                </button>
              </div>
              <div v-else style="color: #aaa">请点击「随机灵根」。</div>
            </div>
            <div class="action-buttons-grid fc-linggen-random-row">
              <button type="button" class="major-action-button" @click="applyRandomLinggen()">
                <i class="fas fa-dice-d20"></i> 随机灵根
              </button>
            </div>
          </div>

          <div
            v-if="statusMessage"
            class="fc-status"
            style="margin: 10px 0 0; font-size: 13px; color: #e0b15a"
          >
            {{ statusMessage }}
          </div>
        </div>

        <div class="creation-nav">
          <div class="creation-nav-enhanced">
            <button type="button" class="major-action-button nav-btn nav-btn-back" @click="emit('close')">
              <i class="fas fa-home"></i>
              <span>返回</span>
            </button>
            <button
              type="button"
              class="major-action-button nav-btn nav-btn-next"
              :disabled="!isReady"
              @click="onConfirm"
            >
              <span>确认选择</span>
              <i class="fas fa-check"></i>
            </button>
          </div>
        </div>
      </div>

      <TraitDetailModal :trait="traitDetailTrait" @close="traitDetailTrait = null" />
      <LinggenDetailModal
        :open="linggenDetailOpen"
        :type="linggenParts.type"
        :elements="linggenParts.elements"
        @close="linggenDetailOpen = false"
      />
      <CustomBirthModal
        :open="customModalOpen"
        :initial-location="customModalInitial.location"
        :initial-realm-major="customModalInitial.realmMajor"
        :initial-realm-minor="customModalInitial.realmMinor"
        :initial-background="customModalInitial.background"
        @close="customModalOpen = false"
        @confirm="onCustomBirthConfirm"
      />
    </div>
  </Teleport>
</template>
