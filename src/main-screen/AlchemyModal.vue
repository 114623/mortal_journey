<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { protagonist } from "../role_core/Protagonist";
import type { MaterialItemDefinition, ItemGrade } from "../role_core/types/itemInfo";
import type { ElixirItemDefinition } from "../role_core/types/elixir";
import type { ItemTier } from "../role_core/types/itemTier";
import { computeAlchemyGradeOdds, checkAlchemyTier } from "../role_core/alchemy";
import { resolveItemTier, tierLabel, describeElixirTierSuppression } from "../role_core/types/itemTier";
import { gradeToTraitRarity } from "./protagonistPanelDisplay";
import { useScrollLock } from "../composables/useScrollLock";
import { writeActiveSave } from "../save/gameSave";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const scrollLock = useScrollLock();

/** 已选材料格下标（长度 0–3，允许重复以表示从同一堆取多份）。 */
const selected = ref<number[]>([]);
/** 最近一次开炉产出的丹药（用于结果展示）。 */
const result = ref<ElixirItemDefinition | null>(null);

interface MaterialEntry {
  slotIndex: number;
  material: MaterialItemDefinition;
}

/** 储物袋中所有「材料」类物品（带格下标）。 */
const materialEntries = computed<MaterialEntry[]>(() => {
  const p = protagonist.value;
  if (!p) return [];
  const out: MaterialEntry[] = [];
  p.inventorySlots.forEach((cell, i) => {
    if (cell && "itemType" in cell && cell.itemType === "材料") {
      out.push({ slotIndex: i, material: cell as MaterialItemDefinition });
    }
  });
  return out;
});

/** 指定格已被选中的次数。 */
function usageOf(slotIndex: number): number {
  let n = 0;
  for (const s of selected.value) if (s === slotIndex) n++;
  return n;
}

/** 指定格还能再被选几次（= 剩余 count）。 */
function availableOf(slotIndex: number): number {
  const entry = materialEntries.value.find((e) => e.slotIndex === slotIndex);
  if (!entry) return 0;
  return entry.material.count - usageOf(slotIndex);
}

/** 是否还能再选一份材料（未满 3 且至少有一格有余量）。 */
const canSelectMore = computed(() => {
  if (selected.value.length >= 3) return false;
  return materialEntries.value.some(
    (e) => availableOf(e.slotIndex) > 0 && !conflictsWithLockedTier(e.slotIndex),
  );
});

/** 已选材料的品阶列表（用于计算品阶概率）。 */
const selectedGrades = computed<ItemGrade[]>(() => {
  const p = protagonist.value;
  if (!p) return [];
  return selected.value.map((i) => {
    const cell = p.inventorySlots[i];
    return (cell as MaterialItemDefinition).grade;
  });
});

/** 指定格材料的阶层（缺失时按品阶回退，兼容旧存档）。 */
function tierOf(slotIndex: number): ItemTier {
  const p = protagonist.value;
  if (!p) return "练气";
  const cell = p.inventorySlots[slotIndex];
  if (!cell || !("itemType" in cell)) return "练气";
  return resolveItemTier((cell as MaterialItemDefinition).tier, (cell as MaterialItemDefinition).grade);
}

/** 当前已选材料（带阶层，用于一致性校验）。 */
const selectedMaterials = computed(() => {
  const p = protagonist.value;
  if (!p) return [];
  return selected.value.map((i) => {
    const cell = p.inventorySlots[i] as MaterialItemDefinition | null;
    return { grade: (cell?.grade ?? "下品") as ItemGrade, tier: tierOf(i) };
  });
});

/** 阶层一致性校验结果：决定能否开炉。 */
const tierCheck = computed(() => checkAlchemyTier(selectedMaterials.value));

/** 已锁定的阶层（选中第一份材料后确定，后续只能投同阶材料）。 */
const lockedTier = computed<ItemTier | null>(() =>
  selected.value.length > 0 ? tierOf(selected.value[0]) : null,
);

/** 某格材料是否与已锁定阶层冲突（冲突时不可投入）。 */
function conflictsWithLockedTier(slotIndex: number): boolean {
  if (lockedTier.value === null) return false;
  return tierOf(slotIndex) !== lockedTier.value;
}

const gradeOdds = computed(() => computeAlchemyGradeOdds(selectedGrades.value));

/** 是否满足开炉条件：三份材料齐备且阶层一致。 */
const isReady = computed(() => selected.value.length === 3 && tierCheck.value.ok);

/** 开炉按钮禁用时给出的原因。 */
const craftBlockReason = computed(() => {
  if (result.value) return "";
  if (selected.value.length < 3) return "";
  if (!tierCheck.value.ok) return tierCheck.value.reason;
  return "";
});

/** 取指定下标处当前的材料名/品阶（直接读 protagonist，随库存变化而更新）。 */
function slotName(slotIndex: number): string {
  const p = protagonist.value;
  if (!p) return "—";
  const cell = p.inventorySlots[slotIndex];
  if (!cell || !("itemType" in cell)) return "—";
  return (cell as MaterialItemDefinition).name;
}
function slotGrade(slotIndex: number): string {
  const p = protagonist.value;
  if (!p) return "";
  const cell = p.inventorySlots[slotIndex];
  if (!cell || !("itemType" in cell)) return "";
  return (cell as MaterialItemDefinition).grade;
}

function pickMaterial(slotIndex: number) {
  if (result.value) return;
  if (selected.value.length >= 3) return;
  if (availableOf(slotIndex) <= 0) return;
  if (conflictsWithLockedTier(slotIndex)) return;
  selected.value = [...selected.value, slotIndex];
}

function removeAt(idx: number) {
  if (result.value) return;
  if (idx < 0 || idx >= selected.value.length) return;
  const next = selected.value.slice();
  next.splice(idx, 1);
  selected.value = next;
}

function clearSelection() {
  selected.value = [];
  result.value = null;
}

function doCraft() {
  if (!isReady.value || result.value) return;
  const p = protagonist.value;
  if (!p) return;
  const elixir = p.craftElixirFromMaterials(selected.value.slice());
  if (!elixir) return;
  result.value = elixir;
  writeActiveSave();
}

/** 结果展示用的药效文案。 */
function effectText(el: ElixirItemDefinition): string {
  const suffix = el.effects.isPercent ? "%" : "";
  const label = el.effectType.startsWith("提升") ? `永久${el.effectType}` : el.effectType;
  return `${label} ${el.effects.value}${suffix}`;
}

/** 结果展示用的阶层文案（丹药继承材料阶层）。 */
function resultTierText(el: ElixirItemDefinition): string {
  const t = resolveItemTier(el.tier, el.grade);
  const p = protagonist.value;
  return describeElixirTierSuppression(t, p?.realm.major);
}

function onBackdropClick() {
  emit("close");
}
function onCloseClick() {
  emit("close");
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && props.open) {
    ev.preventDefault();
    emit("close");
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      selected.value = [];
      result.value = null;
      scrollLock.acquire();
    } else {
      scrollLock.release();
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
        v-if="open"
        class="side-modal-overlay"
        role="presentation"
        aria-hidden="false"
      >
        <div
          class="side-modal-overlay__backdrop"
          tabindex="-1"
          aria-label="关闭"
          @click="onBackdropClick"
        />
        <Transition name="mj-modal" appear>
          <div
            class="side-modal side-modal--alchemy"
            role="dialog"
            aria-modal="true"
            @click.stop
          >
            <div class="side-modal__header">
              <h4 class="side-modal__title">炼丹炉</h4>
              <button type="button" class="side-modal__close" aria-label="关闭" @click="onCloseClick">
                ×
              </button>
            </div>

            <div class="side-modal__body alchemy-body">
              <!-- 结果展示 -->
              <template v-if="result">
                <div class="alchemy-result" :data-rarity="gradeToTraitRarity(result.grade)">
                  <div class="alchemy-result__title">{{ result.name }}</div>
                  <div class="alchemy-result__grade">{{ result.grade }} · 丹药</div>
                  <div class="alchemy-result__effect">{{ effectText(result) }}</div>
                  <div v-if="resultTierText(result)" class="alchemy-result__tier">{{ resultTierText(result) }}</div>
                  <div class="alchemy-result__desc">{{ result.desc }}</div>
                </div>
                <div class="alchemy-result__hint">丹药已放入储物袋</div>
                <div class="alchemy-actions">
                  <button type="button" class="alchemy-btn" @click="clearSelection">再炼一炉</button>
                  <button type="button" class="alchemy-btn alchemy-btn--primary" @click="onCloseClick">关闭</button>
                </div>
              </template>

              <!-- 炼丹选择界面 -->
              <template v-else>
                <div class="alchemy-section-label">投入材料（三份）</div>
                <div v-if="lockedTier" class="alchemy-tier-lock">
                  已定阶：{{ tierLabel(lockedTier) }}（只能投入同阶材料，产出{{ tierLabel(lockedTier) }}丹药）
                </div>
                <div class="alchemy-slots">
                  <div
                    v-for="(slotIdx, idx) in selected"
                    :key="'sel-' + idx"
                    class="alchemy-slot alchemy-slot--filled"
                    @click="removeAt(idx)"
                  >
                    <span class="alchemy-slot__name">{{ slotName(slotIdx) }}</span>
                    <span class="alchemy-slot__grade">{{ slotGrade(slotIdx) }}</span>
                    <span class="alchemy-slot__tier">{{ tierLabel(tierOf(slotIdx)) }}</span>
                    <span class="alchemy-slot__remove" title="移除">×</span>
                  </div>
                  <div
                    v-for="n in (3 - selected.length)"
                    :key="'empty-' + n"
                    class="alchemy-slot alchemy-slot--empty"
                    :class="{ 'alchemy-slot--disabled': !canSelectMore }"
                  >
                    <span class="alchemy-slot__placeholder">空槽</span>
                  </div>
                </div>

                <!-- 品阶概率预览 -->
                <div v-if="gradeOdds.length > 0" class="alchemy-preview">
                  <div class="alchemy-section-label">品阶概率</div>
                  <div class="alchemy-odds">
                    <span
                      v-for="o in gradeOdds"
                      :key="o.grade"
                      class="alchemy-odds-item"
                      :data-rarity="gradeToTraitRarity(o.grade)"
                    >{{ o.grade }} {{ o.percent }}%</span>
                  </div>
                </div>

                <!-- 材料列表 -->
                <div class="alchemy-section-label">材料储备</div>
                <div class="alchemy-material-list">
                  <template v-if="materialEntries.length === 0">
                    <div class="alchemy-empty">储物袋中暂无材料</div>
                  </template>
                  <template v-else>
                    <button
                      v-for="entry in materialEntries"
                      :key="'mat-' + entry.slotIndex"
                      type="button"
                      class="alchemy-material"
                      :data-rarity="gradeToTraitRarity(entry.material.grade)"
                      :disabled="availableOf(entry.slotIndex) <= 0 || selected.length >= 3 || conflictsWithLockedTier(entry.slotIndex)"
                      @click="pickMaterial(entry.slotIndex)"
                    >
                      <span class="alchemy-material__name">{{ entry.material.name }}</span>
                      <span class="alchemy-material__grade">{{ entry.material.grade }}</span>
                      <span class="alchemy-material__tier">{{ tierLabel(tierOf(entry.slotIndex)) }}</span>
                      <span class="alchemy-material__count">余 {{ availableOf(entry.slotIndex) }}/{{ entry.material.count }}</span>
                    </button>
                  </template>
                </div>

                <div v-if="craftBlockReason" class="alchemy-tier-conflict">{{ craftBlockReason }}</div>

                <div class="alchemy-actions">
                  <button type="button" class="alchemy-btn" :disabled="selected.length === 0" @click="clearSelection">清空</button>
                  <button
                    type="button"
                    class="alchemy-btn alchemy-btn--primary"
                    :disabled="!isReady"
                    @click="doCraft"
                  >开炉炼丹</button>
                </div>
              </template>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

