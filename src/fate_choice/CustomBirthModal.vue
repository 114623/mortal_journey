<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { CUSTOM_REALM_MAJORS, CUSTOM_REALM_MINORS, START_REALM_MAJOR } from "./types";
import type { CustomBirthPayload } from "./types";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { formatWorldLocationDash } from "../role_core/types/worldLocation";

const props = defineProps<{
  open: boolean;
  initialLocation?: WorldLocation;
  initialRealmMajor?: string;
  initialRealmMinor?: string;
  initialBackground?: string;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [payload: CustomBirthPayload];
}>();

const customRegion = ref("天南");
const customCountry = ref("越国");
const customArea = ref("");
const customDetail = ref("");
const customRealmMajor = ref<string>(START_REALM_MAJOR);
const customRealmMinor = ref<string>(CUSTOM_REALM_MINORS[0]!);
const customBg = ref("");

const customBirthFormValid = computed(
  () =>
    String(customRegion.value || "").trim() !== "" &&
    String(customCountry.value || "").trim() !== "" &&
    String(customDetail.value || "").trim() !== "" &&
    String(customBg.value || "").trim() !== "",
);

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    const loc = props.initialLocation;
    customRegion.value = loc?.region ?? "天南";
    customCountry.value = loc?.country ?? "越国";
    customArea.value = loc?.area ?? "";
    customDetail.value = loc?.detail ?? "";
    customRealmMajor.value = props.initialRealmMajor ?? START_REALM_MAJOR;
    customRealmMinor.value = props.initialRealmMinor ?? CUSTOM_REALM_MINORS[0]!;
    customBg.value = props.initialBackground ?? "";
  },
);

function confirm(): void {
  if (!customBirthFormValid.value) return;
  const loc: WorldLocation = {
    region: String(customRegion.value || "").trim(),
    country: String(customCountry.value || "").trim(),
    area: String(customArea.value || "").trim(),
    detail: String(customDetail.value || "").trim(),
  };
  const maj = String(customRealmMajor.value || "").trim();
  const bg = String(customBg.value || "").trim();
  const mino = String(customRealmMinor.value || "").trim();
  const realmTxt = maj + mino;
  const locStr = formatWorldLocationDash(loc);
  emit("confirm", {
    tag: locStr,
    name: locStr,
    location: loc,
    realmMajor: maj,
    realmMinor: mino,
    realmText: realmTxt,
    background: bg,
  });
}
</script>

<template>
  <Transition name="mj-backdrop">
    <div
      v-if="open"
      class="mj-trait-modal-root"
      aria-hidden="false"
    >
      <div class="mj-trait-modal-backdrop" @click="emit('close')"></div>
      <Transition name="mj-modal" appear>
        <div class="mj-trait-modal mj-custom-birth-dialog" role="dialog" aria-modal="true">
          <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
          <h3 class="mj-trait-modal-title">自定义出身</h3>
          <div class="mj-trait-modal-body mj-custom-birth-body">
            <div class="mj-custom-birth-loc-grid">
              <div>
                <label class="mj-custom-birth-label" for="fc-custom-region">大区域</label>
                <input id="fc-custom-region" v-model="customRegion" class="mj-custom-birth-input" type="text" placeholder="如：天南" />
              </div>
              <div>
                <label class="mj-custom-birth-label" for="fc-custom-country">国家</label>
                <input id="fc-custom-country" v-model="customCountry" class="mj-custom-birth-input" type="text" placeholder="如：越国" />
              </div>
              <div>
                <label class="mj-custom-birth-label" for="fc-custom-area">区域/宗门</label>
                <input id="fc-custom-area" v-model="customArea" class="mj-custom-birth-input" type="text" placeholder="如：黄枫谷" />
              </div>
              <div>
                <label class="mj-custom-birth-label" for="fc-custom-detail">具体地点</label>
                <input id="fc-custom-detail" v-model="customDetail" class="mj-custom-birth-input" type="text" placeholder="如：外门" />
              </div>
            </div>
            <span class="mj-custom-birth-label">境界</span>
            <div class="mj-custom-birth-realm-row">
              <select id="fc-custom-major" v-model="customRealmMajor" class="mj-custom-birth-select">
                <option v-for="m in CUSTOM_REALM_MAJORS" :key="m" :value="m">{{ m }}</option>
              </select>
              <div class="mj-custom-birth-realm-minor-wrap">
                <select id="fc-custom-minor" v-model="customRealmMinor" class="mj-custom-birth-select">
                  <option v-for="m in CUSTOM_REALM_MINORS" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
            </div>
            <label class="mj-custom-birth-label" for="fc-custom-bg">出身背景</label>
            <textarea id="fc-custom-bg" v-model="customBg" class="mj-custom-birth-textarea"></textarea>
            <div class="mj-custom-birth-actions">
              <button type="button" class="major-action-button mj-custom-birth-btn-cancel" @click="emit('close')">
                取消
              </button>
              <button
                type="button"
                class="major-action-button"
                :disabled="!customBirthFormValid"
                :title="customBirthFormValid ? undefined : '请填写大区域、国家、具体地点与出身背景'"
                @click="confirm"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
