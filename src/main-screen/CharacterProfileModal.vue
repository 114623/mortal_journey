<script setup lang="ts">
/**
 * 人物档案弹窗：性格 / 外貌 / 记忆 三段提示词的编辑界面。
 *
 * 主角与 NPC 共用本组件（`character` 传 `Protagonist` 或 `Npc`）：
 * - NPC：三段由状态 AI 生成并持续维护；玩家一旦手动保存即锁定为「玩家设定」，AI 不再覆写。
 * - 主角：由玩家自行填写，AI 不写入，用于约束后续叙事的口吻与行为风格。
 * - NPC 的「外貌」直接读写文生图核心字段 `appearance`，改完下一次生成立绘即生效。
 *
 * 回合进行中也可以改：此时改动不立即写入角色，而是进「待应用队列」，
 * 等本回合结束（AI 写完状态）后统一应用，避免被本回合的 AI 输出覆盖。
 */
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import type { Character } from "../role_core/Character";
import type { Npc } from "../role_core/Npc";
import { Protagonist } from "../role_core/Protagonist";
import { Character as CharacterBase } from "../role_core/Character";
import { npcStore } from "../role_core/npcStore";
import { turnBusy } from "../role_core/turnLock";
import {
  MEMORY_COMPRESS_TARGET,
  MEMORY_COMPRESS_THRESHOLD,
} from "../role_core/types/playInfo";
import {
  applyNpcBasicsDraft,
  applyProfileDraft,
  clearPendingNpcBasics,
  clearPendingProfile,
  getPendingNpcBasics,
  getPendingProfile,
  pendingKeyOf,
  readNpcBasicsDraft,
  readProfileDraft,
  setPendingNpcBasics,
  setPendingProfile,
  type NpcBasicsDraft,
} from "../role_core/pendingEdits";
import { getShouyuanForRealm } from "../role_core/realmUtils";
import { REALM_ORDER, SUB_STAGES } from "../role_core/types/playInfo";
import { writeActiveSave } from "../save/gameSave";
import { useScrollLock } from "../composables/useScrollLock";

/** 灵根可选元素（五行）。 */
const LINGGEN_OPTIONS = ["金", "木", "水", "火", "土"] as const;
/** 性别选项。 */
const GENDER_OPTIONS = ["男", "女"] as const;

const props = defineProps<{
  open: boolean;
  character: Character | null;
}>();

const emit = defineEmits<{
  close: [];
  /** 该角色已被删除（供调用方清理选中态）。 */
  deleted: [npcId: string];
}>();

const scrollLock = useScrollLock();

/** 回合进行中：改动进队列，回合结束后生效。 */
const busy = computed(() => turnBusy.value);

const isNpc = computed(
  () => !!props.character && (props.character as unknown as { role?: string }).role === "npc",
);

/** 当前编辑对象在待应用队列里的键。 */
const pendingKey = computed(() => (props.character ? pendingKeyOf(props.character) : ""));
/** 该角色是否已有未应用的改动。 */
const hasPending = computed(
  () => !!getPendingProfile(pendingKey.value) || !!getPendingNpcBasics(pendingKey.value),
);

/** 基本信息编辑区（仅 NPC）。 */
const basics = ref<NpcBasicsDraft | null>(null);
/** 基本信息对照基线。 */
const basicsBaseline = ref<NpcBasicsDraft | null>(null);
/** 删除确认（二次点击才真正删除）。 */
const confirmDelete = ref(false);

const personality = ref("");
const appearance = ref("");
const memory = ref("");
/** 是否允许 AI 自动更新画像（false = 玩家锁定）。 */
const aiMaintained = ref(true);
const savedHint = ref("");

/**
 * 编辑区的对照基线（打开时的值 / 上次保存的值）。
 * 用它而不是 watch 来判定「是否改动过」，避免打开弹窗同步数据时误报未保存。
 */
const baseline = ref({ personality: "", appearance: "", memory: "", source: "ai" as "ai" | "manual" });

const dirty = computed(() => {
  const b = basics.value;
  const bb = basicsBaseline.value;
  const basicsDirty =
    !!b && !!bb &&
    (b.displayName !== bb.displayName ||
      b.gender !== bb.gender ||
      b.age !== bb.age ||
      b.shouyuan !== bb.shouyuan ||
      b.realmMajor !== bb.realmMajor ||
      b.realmMinor !== bb.realmMinor ||
      b.linggen.join("") !== bb.linggen.join("") ||
      b.identity !== bb.identity);
  return (
    basicsDirty ||
    personality.value !== baseline.value.personality ||
    appearance.value !== baseline.value.appearance ||
    memory.value !== baseline.value.memory ||
    aiMaintained.value !== (baseline.value.source !== "manual")
  );
});

const memoryLength = computed(() => memory.value.trim().length);
/** 记忆超过压缩阈值：提示玩家下回合 AI 会自动压缩。 */
const memoryOverThreshold = computed(() => memoryLength.value > MEMORY_COMPRESS_THRESHOLD);

const subtitle = computed(() => {
  const c = props.character;
  if (!c) return "";
  const realm = CharacterBase.formatRealm(c.realm);
  if (isNpc.value) {
    const npc = c as Npc;
    const dead = npc.isDead ? " · 已故" : "";
    return `${npc.identity || "身份未知"} · ${realm}${dead}`;
  }
  const p = c as Protagonist;
  return `${realm} · ${p.gender || "—"} · ${CharacterBase.formatLinggenElements(p.linggen)}灵根`;
});

/** 打开（或切换目标角色）时按「待应用草稿 → 已生效值」的优先顺序同步进编辑区。 */
function syncDraft(): void {
  const c = props.character;
  if (!c) {
    personality.value = "";
    appearance.value = "";
    memory.value = "";
    aiMaintained.value = true;
    baseline.value = { personality: "", appearance: "", memory: "", source: "ai" };
    basics.value = null;
    basicsBaseline.value = null;
    confirmDelete.value = false;
    savedHint.value = "";
    return;
  }
  const draft = getPendingProfile(pendingKey.value) ?? readProfileDraft(c);
  baseline.value = { ...draft };
  personality.value = draft.personality;
  appearance.value = draft.appearance;
  memory.value = draft.memory;
  aiMaintained.value = draft.source !== "manual";

  if (isNpc.value) {
    const b = getPendingNpcBasics(pendingKey.value) ?? readNpcBasicsDraft(c as Npc);
    basics.value = { ...b, linggen: [...b.linggen] };
    basicsBaseline.value = { ...b, linggen: [...b.linggen] };
  } else {
    basics.value = null;
    basicsBaseline.value = null;
  }
  confirmDelete.value = false;
  savedHint.value = "";
}

watch(
  () => [props.open, props.character] as const,
  () => {
    if (props.open) syncDraft();
  },
  { immediate: true },
);

watch(
  () => props.open,
  (v) => {
    if (v) scrollLock.acquire();
    else scrollLock.release();
  },
);

/** 写回运行时 + 落盘。NPC 需回写 store 触发响应式。 */
function persist(c: Character): void {
  if (isNpc.value) {
    npcStore.setNpc(c as Npc);
  } else {
    Protagonist.notifyChanged();
  }
  writeActiveSave();
}

function onSave(): void {
  const c = props.character;
  if (!c) return;

  // ── 基本信息（仅 NPC）──
  const b = basics.value;
  let basicsChanged = false;
  if (isNpc.value && b) {
    const appliedB = readNpcBasicsDraft(c as Npc);
    basicsChanged =
      b.displayName !== appliedB.displayName ||
      b.gender !== appliedB.gender ||
      b.age !== appliedB.age ||
      b.shouyuan !== appliedB.shouyuan ||
      b.realmMajor !== appliedB.realmMajor ||
      b.realmMinor !== appliedB.realmMinor ||
      b.linggen.join("") !== appliedB.linggen.join("") ||
      b.identity !== appliedB.identity;
    const bDraft: NpcBasicsDraft = { ...b, linggen: [...b.linggen] };
    if (busy.value) {
      if (basicsChanged) setPendingNpcBasics(pendingKey.value, bDraft);
    } else {
      if (basicsChanged) applyNpcBasicsDraft(c as Npc, bDraft);
      clearPendingNpcBasics(pendingKey.value);
    }
    basicsBaseline.value = { ...bDraft, linggen: [...bDraft.linggen] };
  }

  // 与「已生效值」比对，判断是否真的改了内容（决定要不要锁定为玩家设定）。
  const applied = readProfileDraft(c);
  const changed =
    personality.value !== applied.personality ||
    appearance.value !== applied.appearance ||
    memory.value !== applied.memory;

  // ── 是否交给 AI 维护 ──
  // 只认玩家手里那个勾选框：改过文字**不再**顺带把画像锁成 manual（旧行为会让玩家一改档案，
  // AI 就永久停更，等于变相惩罚手动编辑）。想锁定请自己取消勾选。
  const wantAi = aiMaintained.value;
  const draft = {
    personality: personality.value,
    appearance: appearance.value,
    memory: memory.value,
    source: (wantAi ? "ai" : "manual") as "ai" | "manual",
  };
  baseline.value = { ...draft };
  aiMaintained.value = wantAi;

  if (busy.value) {
    // 回合进行中：进队列，回合结束后应用。
    // 队列里已有草稿时也要重写一次——否则「打开勾选框」这类只改 source 的保存会被丢掉。
    if (changed || !wantAi || hasPending.value) setPendingProfile(pendingKey.value, draft);
    if (basicsChanged) persist(c);
    savedHint.value = wantAi
      ? "已排队，本回合结束后应用（AI 仍会在后续回合继续更新此画像）。"
      : "已排队，本回合结束后应用（已锁定为玩家设定，AI 不再覆写）。";
  } else {
    applyProfileDraft(c, draft);
    clearPendingProfile(pendingKey.value);
    persist(c);
    savedHint.value = basicsChanged && !changed
      ? "已保存。"
      : changed
        ? (wantAi
          ? "已保存；AI 仍会在后续回合继续更新此画像。"
          : "已保存，并锁定为玩家设定（AI 不再覆写）。")
        : wantAi
          ? "已交还 AI 维护，后续回合会由 AI 更新。"
          : "已锁定为玩家设定。";
  }
}

/** 丢弃该角色尚未应用的改动，回到已生效值。 */
function onDiscardPending(): void {
  clearPendingProfile(pendingKey.value);
  clearPendingNpcBasics(pendingKey.value);
  syncDraft();
  savedHint.value = "已撤销待应用的改动。";
}

/** 改境界时，把寿元同步成该境界的默认值（玩家仍可再手改）。 */
function onRealmChange(): void {
  const b = basics.value;
  if (!b) return;
  const def = getShouyuanForRealm(b.realmMajor, b.realmMinor);
  if (typeof def === "number" && def > 0) b.shouyuan = def;
}

/** 切换某个灵根元素。 */
function toggleLinggen(el: string): void {
  const b = basics.value;
  if (!b) return;
  const i = b.linggen.indexOf(el);
  if (i >= 0) b.linggen.splice(i, 1);
  else b.linggen.push(el);
}

/** 删除该 NPC 卡（二次点击确认）。 */
function onDelete(): void {
  const c = props.character;
  if (!c || !isNpc.value) return;
  const npc = c as Npc;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    savedHint.value = "";
    return;
  }
  const id = npc.id;
  const name = npc.displayName;
  clearPendingProfile(pendingKey.value);
  clearPendingNpcBasics(pendingKey.value);
  npcStore.removeNpc(name);
  writeActiveSave();
  emit("deleted", id);
  emit("close");
}

/** 清空三段编辑区（不写入，需再点保存）。 */
function onClear(): void {
  personality.value = "";
  appearance.value = "";
  memory.value = "";
}

function onCloseClick(): void {
  emit("close");
}

function onBackdropClick(): void {
  emit("close");
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && props.open) {
    ev.preventDefault();
    emit("close");
  }
}

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
        v-if="open && character"
        class="mj-trait-modal-root mj-protagonist-detail-root mj-profile-root"
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
            class="mj-trait-modal mj-profile-panel"
            role="dialog"
            aria-modal="true"
            @click.stop
          >
            <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="onCloseClick">
              ×
            </button>
            <h4 class="mj-trait-modal-title">角色设定 · {{ character.displayName }}</h4>
            <div class="mj-trait-modal-rarity">{{ subtitle }}</div>

            <p v-if="busy" class="mj-profile-locked">
              回合进行中：可以随时改，点「保存」后进入队列，<b>本回合结束后</b>才生效。
            </p>
            <p v-else-if="hasPending" class="mj-profile-locked mj-profile-locked--pending">
              该角色有尚未应用的改动（已在编辑区显示），将在下一个回合结束后生效。
            </p>

            <div class="mj-profile-body">
              <!-- 基本信息（仅 NPC） -->
              <div v-if="basics" class="mj-profile-basics">
                <div class="mj-profile-basics-title">基本信息</div>

                <div class="mj-profile-row">
                  <label class="mj-profile-row-k">名字</label>
                  <input v-model="basics.displayName" class="mj-profile-input mj-profile-input--short" type="text" />
                </div>

                <!-- 名字下面那行简介（显示为「身份 · 境界」）的可编辑部分 -->
                <div class="mj-profile-row">
                  <label class="mj-profile-row-k" title="角色卡与信息界面里名字下面那行简介">简介</label>
                  <input
                    v-model="basics.identity"
                    class="mj-profile-input mj-profile-input--short"
                    type="text"
                    placeholder="例：七玄门外门弟子 / 溪京城振远镖局伙计"
                  />
                </div>

                <div class="mj-profile-row">
                  <label class="mj-profile-row-k">性别</label>
                  <div class="mj-profile-chips">
                    <button
                      v-for="g in GENDER_OPTIONS"
                      :key="g"
                      type="button"
                      class="mj-profile-chip"
                      :class="{ 'is-on': basics.gender === g }"
                      @click="basics.gender = g"
                    >{{ g }}</button>
                  </div>
                </div>

                <div class="mj-profile-row">
                  <label class="mj-profile-row-k">境界</label>
                  <select v-model="basics.realmMajor" class="mj-profile-select" @change="onRealmChange">
                    <option v-for="r in REALM_ORDER" :key="r" :value="r">{{ r }}</option>
                  </select>
                  <select v-model="basics.realmMinor" class="mj-profile-select" @change="onRealmChange">
                    <option v-for="s in SUB_STAGES" :key="s" :value="s">{{ s }}</option>
                  </select>
                </div>

                <div class="mj-profile-row">
                  <label class="mj-profile-row-k">年龄</label>
                  <input v-model.number="basics.age" class="mj-profile-input mj-profile-input--num" type="number" min="0" />
                  <label class="mj-profile-row-k mj-profile-row-k--gap">寿元</label>
                  <input v-model.number="basics.shouyuan" class="mj-profile-input mj-profile-input--num" type="number" min="0" />
                </div>

                <div class="mj-profile-row">
                  <label class="mj-profile-row-k">灵根</label>
                  <div class="mj-profile-chips">
                    <button
                      v-for="el in LINGGEN_OPTIONS"
                      :key="el"
                      type="button"
                      class="mj-profile-chip"
                      :class="{ 'is-on': basics.linggen.includes(el) }"
                      @click="toggleLinggen(el)"
                    >{{ el }}</button>
                  </div>
                  <span class="mj-profile-row-note">{{ basics.linggen.length }} 灵根</span>
                </div>

                <p class="mj-profile-note">
                  改境界会按境界表重算属性与气血上限，并把寿元设为该境界的默认值（可再手改）。
                </p>
              </div>

              <div class="mj-profile-field">
                <div class="mj-profile-field-head">
                  <span class="mj-profile-field-k">性格</span>
                  <span class="mj-profile-field-hint">行事准则、说话风格、好恶与底线</span>
                </div>
                <textarea
                  v-model="personality"
                  class="mj-profile-input"
                  rows="3"
                  placeholder="例：外冷内热，嘴硬心软；极重同门情义，对背信之人记仇极深"
                />
              </div>

              <div class="mj-profile-field">
                <div class="mj-profile-field-head">
                  <span class="mj-profile-field-k">外貌</span>
                  <span class="mj-profile-field-hint">
                    {{ isNpc ? '与立绘生成共用同一段描述，改完重新生成立绘即生效' : '直接影响主角立绘与剧情中的外貌描写' }}
                  </span>
                </div>
                <textarea
                  v-model="appearance"
                  class="mj-profile-input"
                  rows="3"
                  placeholder="例：及腰黑发以青丝带束起，鹅蛋脸，眉目清秀，右颊有浅淡酒窝"
                />
              </div>

              <div class="mj-profile-field">
                <div class="mj-profile-field-head">
                  <span class="mj-profile-field-k">记忆</span>
                  <span class="mj-profile-field-hint">他/她记住的关键经历、恩怨与承诺</span>
                </div>
                <textarea
                  v-model="memory"
                  class="mj-profile-input mj-profile-input--tall"
                  rows="7"
                  placeholder="一行时间 / 一行地点 / 一行正文，空行分条，新的在最上面。例：
0005年12月20日 17:00
溪京城·振远镖局·院内
擦净灶台又到院门口张望了一回，见坊市方向只有暮色，回身把蒸好的饭用棉布盖好，盼姐姐早些到家。"
                />
                <div class="mj-profile-counter" :class="{ 'mj-profile-counter--warn': memoryOverThreshold }">
                  {{ memoryLength }} 字<span v-if="memoryOverThreshold"> · 已超过 {{ MEMORY_COMPRESS_THRESHOLD }} 字，记忆会在下回合由 AI 提炼压缩至约 {{ MEMORY_COMPRESS_TARGET }} 字（保留事实、压短文字，不删条目）</span><span v-else> · 未超 {{ MEMORY_COMPRESS_THRESHOLD }} 字时 AI 只追加新条目，你写的内容不会被改写</span>
                </div>
              </div>

              <label v-if="isNpc" class="mj-profile-switch">
                <input v-model="aiMaintained" type="checkbox" />
                <span>允许 AI 自动更新（取消勾选 = 锁定为玩家设定，AI 不再覆写；改动文字不会自动取消勾选）</span>
              </label>
              <p v-else class="mj-profile-note">
                性格与外貌由玩家设定，AI 不会改写；<b>记忆由 AI 每回合维护</b>（上方同样可手动改）。
              </p>

              <p v-if="savedHint" class="mj-profile-saved-hint">{{ savedHint }}</p>
            </div>

            <div class="mj-item-detail-actions">
              <button
                v-if="isNpc"
                type="button"
                class="mj-item-detail-action-btn mj-item-detail-action-btn--danger"
                @click="onDelete"
              >
                {{ confirmDelete ? '确认删除？此操作不可撤销' : '删除角色卡' }}
              </button>
              <button type="button" class="mj-item-detail-action-btn" @click="onClear">
                清空
              </button>
              <button
                v-if="hasPending"
                type="button"
                class="mj-item-detail-action-btn"
                @click="onDiscardPending"
              >
                撤销待应用
              </button>
              <button
                type="button"
                class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                @click="onSave"
              >
                {{ busy ? '保存（回合结束后生效）' : '保存' }}
              </button>
            </div>
            <p v-if="dirty && !savedHint" class="mj-profile-dirty-hint">有未保存的修改。</p>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mj-profile-root .mj-trait-modal.mj-profile-panel {
  max-width: 460px;
  max-height: min(82vh, 680px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mj-profile-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.mj-profile-locked {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 0.78rem;
  line-height: 1.45;
  color: #e8c5a0;
  background: rgba(198, 122, 58, 0.14);
  border: 1px solid rgba(198, 122, 58, 0.35);
}

.mj-profile-locked b {
  color: #f0d9b8;
}

.mj-profile-locked--pending {
  color: #cfe0ff;
  background: rgba(88, 130, 200, 0.14);
  border-color: rgba(120, 160, 230, 0.35);
}

.mj-profile-basics {
  margin-bottom: 14px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid rgba(140, 120, 83, 0.3);
  background: rgba(0, 0, 0, 0.22);
}

.mj-profile-basics-title {
  margin-bottom: 8px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--mj-gold, #e8c547);
}

.mj-profile-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 7px;
  flex-wrap: wrap;
}

.mj-profile-row-k {
  font-size: 0.74rem;
  color: var(--mj-text, #e8e4dc);
  flex-shrink: 0;
  min-width: 32px;
}

.mj-profile-row-k--gap {
  margin-left: 8px;
}

.mj-profile-row-note {
  font-size: 0.68rem;
  color: var(--mj-muted, #8a9088);
}

.mj-profile-input--short {
  flex: 1;
  min-width: 120px;
}

.mj-profile-input--num {
  width: 74px;
  flex-shrink: 0;
}

.mj-profile-select {
  padding: 5px 7px;
  border-radius: 7px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: rgba(0, 0, 0, 0.32);
  color: var(--mj-text, #e8e4dc);
  font-size: 0.76rem;
  font-family: inherit;
  cursor: pointer;
}

.mj-profile-chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.mj-profile-chip {
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid rgba(140, 120, 83, 0.45);
  background: rgba(0, 0, 0, 0.3);
  color: var(--mj-muted, #8a9088);
  font-size: 0.74rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.mj-profile-chip:hover {
  border-color: var(--mj-gold-dim, #b89a4a);
  color: var(--mj-text, #e8e4dc);
}

.mj-profile-chip.is-on {
  background: rgba(232, 197, 71, 0.18);
  border-color: var(--mj-gold, #e8c547);
  color: var(--mj-gold, #e8c547);
}

.mj-item-detail-action-btn--danger {
  color: #f0a8a8;
  border-color: rgba(200, 90, 90, 0.45);
}

.mj-item-detail-action-btn--danger:hover {
  background: rgba(200, 90, 90, 0.16);
  border-color: rgba(220, 110, 110, 0.7);
}

.mj-profile-field {
  margin-bottom: 12px;
}

.mj-profile-field-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}

.mj-profile-field-k {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--mj-gold, #e8c547);
  flex-shrink: 0;
}

.mj-profile-field-hint {
  font-size: 0.68rem;
  color: var(--mj-muted, #8a9088);
  line-height: 1.35;
}

.mj-profile-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: rgba(0, 0, 0, 0.32);
  color: var(--mj-text, #e8e4dc);
  font-size: 0.8rem;
  line-height: 1.55;
  font-family: inherit;
  resize: vertical;
}

.mj-profile-input:focus {
  outline: none;
  border-color: var(--mj-gold-dim, #b89a4a);
  box-shadow: 0 0 0 1px rgba(232, 197, 71, 0.25);
}

.mj-profile-input--tall {
  min-height: 100px;
}

.mj-profile-counter {
  margin-top: 4px;
  font-size: 0.68rem;
  color: var(--mj-muted, #8a9088);
}

.mj-profile-counter--warn {
  color: #e8c5a0;
}

.mj-profile-switch {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.76rem;
  color: var(--mj-text, #e8e4dc);
  cursor: pointer;
  user-select: none;
}

.mj-profile-switch input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--mj-gold, #e8c547);
  cursor: pointer;
}

.mj-profile-note {
  margin: 2px 0 0;
  font-size: 0.72rem;
  color: var(--mj-muted, #8a9088);
}

.mj-profile-saved-hint {
  margin: 8px 0 0;
  font-size: 0.72rem;
  color: #9fd6a8;
}

.mj-profile-dirty-hint {
  margin: 6px 0 0;
  font-size: 0.7rem;
  color: var(--mj-muted, #8a9088);
  text-align: right;
}
</style>
