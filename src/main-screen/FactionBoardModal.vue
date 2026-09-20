<script setup lang="ts">
/**
 * @fileoverview 势力面板：查看 / 编辑 / 探查主角已探知的修仙势力。
 *
 * 与「天道编辑」同属**即时落盘**类改动——它改的是喂给 AI 的素材，不是提示词本身，
 * 改完立刻写进当前存档，不必等回合结束。
 *
 * 探查是手动触发的独立 AI 链路（见 `ai/faction_generate.ts`）：一次请求消耗 token，
 * 因此加了确认弹窗防误触；结果直接写入 store 并落盘。
 */
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import {
  factionStore,
  factionStrengthTier,
  formatFactionPower,
  FACTION_SOFT_LIMIT,
  type Faction,
} from "../role_core/factionStore";
import { getWorldPreset } from "../role_core/worldSettingsStore";
import { protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import { storyStore } from "../role_core/storyStore";
import { formatWorldLocationDash } from "../role_core/types/worldLocation";
import { writeActiveSave } from "../save/gameSave";
import { useApiConfig } from "../ai/useApiConfig";
import { generateFactionProbe } from "../ai/faction_generate";
import { useScrollLock } from "../composables/useScrollLock";
import { gameLog } from "../log/gameLog";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const scrollLock = useScrollLock();
const { apiUrl, apiKey, apiModel } = useApiConfig();

/** 面板顶部提示条（成功绿 / 失败红）。 */
const hint = ref("");
const hintTone = ref<"ok" | "err">("ok");
/** 正在探查。 */
const probing = ref(false);

/** 当前选中的势力名（= Map 的键）。 */
const selectedName = ref("");
/** 编辑草稿。 */
const draft = ref<Faction | null>(null);
/** 编辑区原始势力名——改名时用来删旧键。 */
const editingName = ref("");
/** 删除二次确认（armed 态）。 */
const armedDelete = ref(false);

/** 按强度档位分组的列表。 */
const groups = computed(() => factionStore.groupFactionsByTier());
const count = computed(() => factionStore.listFactions().length);
const overSoftLimit = computed(() => count.value > FACTION_SOFT_LIMIT);

const hasApi = computed(() => !!String(apiUrl.value || "").trim() && !!String(apiModel.value || "").trim());

/** 当前地点文本（探查输入用）。 */
const currentLocationText = computed(() => {
  const loc = storyStore.worldLocation.value;
  return loc ? formatWorldLocationDash(loc) : "";
});

/** 附近人物快照（供探查时对齐境界）。 */
function buildNpcSnapshot(): string {
  const all = npcStore.serializeNpcs();
  // presence 是枚举（active/dormant/departed/dead），不是中文。
  const present = all.filter((n) => n.presence === "active");
  const src = (present.length > 0 ? present : all).slice(0, 12);
  return src
    .map(
      (n) =>
        `- ${n.displayName} · ${(n.realm?.major ?? "") + (n.realm?.minor ?? "")} · ${n.identity || "—"}`,
    )
    .join("\n");
}

function emptyFaction(): Faction {
  return {
    name: "新势力",
    type: "宗门",
    locationText: currentLocationText.value,
    power: { yuanying: 0, jiedan: 0, zhuji: 0 },
    demands: "不明",
    relation: "无交集",
    desc: "",
  };
}

/** 打开时默认选中第一个势力（有则进入编辑态）。 */
function syncSelection(): void {
  hint.value = "";
  armedDelete.value = false;
  const all = factionStore.listFactions();
  if (all.length === 0) {
    selectedName.value = "";
    draft.value = null;
    editingName.value = "";
    return;
  }
  selectFaction(all[0].name);
}

function selectFaction(name: string): void {
  const f = factionStore.getFaction(name);
  if (!f) return;
  selectedName.value = name;
  editingName.value = name;
  draft.value = JSON.parse(JSON.stringify(f)) as Faction;
  armedDelete.value = false;
}

function setDraftField<K extends keyof Faction>(key: K, value: Faction[K]): void {
  if (!draft.value) return;
  draft.value = { ...draft.value, [key]: value };
}

function setPowerField(key: "yuanying" | "jiedan" | "zhuji", raw: string): void {
  if (!draft.value) return;
  const n = Number.parseInt(raw, 10);
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  draft.value = { ...draft.value, power: { ...draft.value.power, [key]: v } };
}

/** 保存编辑：改名 = 删旧键 + 建新键（与 NPC 用名字做键的模式一致）。 */
function onSave(): void {
  const d = draft.value;
  if (!d) return;
  const name = d.name.replace(/\s+/g, " ").trim();
  if (!name) {
    hint.value = "势力名不能为空。";
    hintTone.value = "err";
    return;
  }
  if (name !== editingName.value) factionStore.removeFaction(editingName.value);
  factionStore.upsertFaction({ ...d, name });
  editingName.value = name;
  selectedName.value = name;
  writeActiveSave();
  hint.value = "已保存并立即生效。";
  hintTone.value = "ok";
}

/** 删除：二次点击确认（照人物档案的 armed 态惯例，不用 window.confirm）。 */
function onDelete(): void {
  if (!armedDelete.value) {
    armedDelete.value = true;
    return;
  }
  factionStore.removeFaction(editingName.value);
  writeActiveSave();
  armedDelete.value = false;
  syncSelection();
  hint.value = "已删除。";
  hintTone.value = "ok";
}

function onAdd(): void {
  const f = emptyFaction();
  // 同名时自动加序号，避免覆盖已有条目。
  let name = f.name;
  let n = 2;
  while (factionStore.getFaction(name)) name = `新势力 ${n++}`;
  f.name = name;
  factionStore.upsertFaction(f);
  writeActiveSave();
  selectFaction(name);
  hint.value = "已新增势力，请填写名称与资料。";
  hintTone.value = "ok";
}

/** 探查附近势力（手动触发，消耗一次 AI 请求）。 */
async function onProbe(): Promise<void> {
  if (probing.value) return;
  if (!hasApi.value) {
    hint.value = "未配置 API URL 或模型，无法探查。";
    hintTone.value = "err";
    return;
  }
  const ok = window.confirm(
    "探查附近势力会调用一次 AI 生成（消耗 token），并把结果直接写入当前人生。是否继续？",
  );
  if (!ok) return;
  probing.value = true;
  hint.value = "";
  try {
    const p = protagonist.value;
    const list = await generateFactionProbe({
      apiUrl: String(apiUrl.value || "").trim(),
      apiKey: String(apiKey.value || "").trim() || undefined,
      model: String(apiModel.value || "").trim(),
      currentLocationText: currentLocationText.value,
      worldView: getWorldPreset().worldView,
      protagonistRealm: p ? `${p.realm.major}${p.realm.minor}` : "练气初期",
      knownFactions: factionStore.formatFactionSnapshot(),
      npcSnapshot: buildNpcSnapshot(),
      signal: undefined,
    });
    if (!list || list.length === 0) {
      hint.value = "探查未返回结果，可稍后重试或手动添加。";
      hintTone.value = "err";
      return;
    }
    let added = 0;
    for (const f of list) {
      if (factionStore.upsertFaction(f)) added++;
    }
    writeActiveSave();
    gameLog.info(`[FactionBoard] 探查写入 ${added} 个势力`);
    hint.value = `已登记 ${added} 个势力。`;
    hintTone.value = "ok";
    const all = factionStore.listFactions();
    if (all.length > 0) selectFaction(all[0].name);
  } catch (e) {
    hint.value = "探查失败：" + (e instanceof Error ? e.message : String(e));
    hintTone.value = "err";
    gameLog.error("[FactionBoard] 势力探查失败：" + (e instanceof Error ? e.message : String(e)));
  } finally {
    probing.value = false;
  }
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

watch(
  () => props.open,
  (v) => {
    if (v) {
      syncSelection();
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
        class="mj-trait-modal-root mj-protagonist-detail-root mj-faction-root"
        role="presentation"
      >
        <div class="mj-trait-modal-backdrop" tabindex="-1" aria-label="关闭" @click="onBackdropClick" />
        <Transition name="mj-modal" appear>
          <div class="mj-trait-modal mj-faction-panel" role="dialog" aria-modal="true" @click.stop>
            <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="onCloseClick">
              ×
            </button>
            <h4 class="mj-trait-modal-title">势力</h4>
            <div class="mj-trait-modal-rarity">
              已探知的修仙势力（{{ count }}）。诉求与关系会喂给剧情 AI，用来生长事件。
            </div>

            <p v-if="hint" class="mj-faction-hint" :class="hintTone === 'err' ? 'is-err' : 'is-ok'">
              {{ hint }}
            </p>

            <div class="mj-faction-body">
              <div class="mj-faction-list">
                <template v-if="groups.length === 0">
                  <p class="mj-faction-empty">尚无登记势力，可探查附近势力或手动添加。</p>
                </template>
                <template v-else>
                  <div v-for="g in groups" :key="g.tier" class="mj-faction-group">
                    <div class="mj-faction-group__label">{{ g.tier }}</div>
                    <button
                      v-for="f in g.items"
                      :key="f.name"
                      type="button"
                      class="mj-faction-item"
                      :class="{ 'is-active': f.name === selectedName }"
                      @click="selectFaction(f.name)"
                    >
                      <span class="mj-faction-item__name">{{ f.name }}</span>
                      <span class="mj-faction-item__type">{{ f.type }}</span>
                      <span class="mj-faction-item__power">{{ formatFactionPower(f.power) }}</span>
                    </button>
                  </div>
                </template>
              </div>

              <div class="mj-faction-edit">
                <template v-if="!draft">
                  <p class="mj-faction-empty">选择左侧势力以编辑，或点「新增势力」。</p>
                </template>
                <template v-else>
                  <label class="mj-faction-field">
                    <span class="mj-faction-field__label">名称</span>
                    <input
                      class="mj-faction-input"
                      type="text"
                      :value="draft.name"
                      @input="setDraftField('name', ($event.target as HTMLInputElement).value)"
                    />
                  </label>
                  <label class="mj-faction-field">
                    <span class="mj-faction-field__label">类型</span>
                    <input
                      class="mj-faction-input"
                      type="text"
                      :value="draft.type"
                      @input="setDraftField('type', ($event.target as HTMLInputElement).value)"
                    />
                  </label>
                  <label class="mj-faction-field">
                    <span class="mj-faction-field__label">驻地</span>
                    <input
                      class="mj-faction-input"
                      type="text"
                      :value="draft.locationText"
                      @input="setDraftField('locationText', ($event.target as HTMLInputElement).value)"
                    />
                  </label>

                  <div class="mj-faction-field">
                    <span class="mj-faction-field__label">
                      战力（档位：{{ factionStrengthTier(draft.power) }}）
                    </span>
                    <div class="mj-faction-power">
                      <label class="mj-faction-power__cell">
                        元婴
                        <input
                          class="mj-faction-input mj-faction-input--num"
                          type="number"
                          min="0"
                          max="3"
                          :value="draft.power.yuanying"
                          @input="setPowerField('yuanying', ($event.target as HTMLInputElement).value)"
                        />
                      </label>
                      <label class="mj-faction-power__cell">
                        结丹
                        <input
                          class="mj-faction-input mj-faction-input--num"
                          type="number"
                          min="0"
                          max="10"
                          :value="draft.power.jiedan"
                          @input="setPowerField('jiedan', ($event.target as HTMLInputElement).value)"
                        />
                      </label>
                      <label class="mj-faction-power__cell">
                        筑基
                        <input
                          class="mj-faction-input mj-faction-input--num"
                          type="number"
                          min="0"
                          max="30"
                          :value="draft.power.zhuji"
                          @input="setPowerField('zhuji', ($event.target as HTMLInputElement).value)"
                        />
                      </label>
                    </div>
                  </div>

                  <label class="mj-faction-field">
                    <span class="mj-faction-field__label">诉求 / 图谋</span>
                    <textarea
                      class="mj-faction-input mj-faction-input--area"
                      rows="2"
                      :value="draft.demands"
                      @input="setDraftField('demands', ($event.target as HTMLTextAreaElement).value)"
                    />
                  </label>
                  <label class="mj-faction-field">
                    <span class="mj-faction-field__label">与主角关系</span>
                    <input
                      class="mj-faction-input"
                      type="text"
                      :value="draft.relation"
                      @input="setDraftField('relation', ($event.target as HTMLInputElement).value)"
                    />
                  </label>
                  <label class="mj-faction-field">
                    <span class="mj-faction-field__label">一句话特色</span>
                    <input
                      class="mj-faction-input"
                      type="text"
                      :value="draft.desc ?? ''"
                      @input="setDraftField('desc', ($event.target as HTMLInputElement).value)"
                    />
                  </label>
                </template>
              </div>
            </div>

            <p v-if="overSoftLimit" class="mj-faction-warn">
              已登记 {{ count }} 个势力，超过 {{ FACTION_SOFT_LIMIT }} 个后注入剧情的素材会偏长，可适当清理。
            </p>

            <div class="mj-item-detail-actions">
              <button type="button" class="mj-item-detail-action-btn" @click="onAdd">+ 新增势力</button>
              <button
                v-if="draft"
                type="button"
                class="mj-item-detail-action-btn mj-item-detail-action-btn--danger"
                :class="{ 'is-armed': armedDelete }"
                @click="onDelete"
              >
                {{ armedDelete ? '再次点击确认删除' : '删除该势力' }}
              </button>
              <button
                v-if="draft"
                type="button"
                class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                @click="onSave"
              >
                保存
              </button>
              <button
                type="button"
                class="mj-item-detail-action-btn mj-item-detail-action-btn--primary"
                :disabled="probing"
                @click="onProbe"
              >
                {{ probing ? '探查中…' : '探查附近势力' }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mj-faction-root .mj-trait-modal.mj-faction-panel {
  max-width: 760px;
  width: min(94vw, 760px);
  max-height: min(86vh, 700px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mj-faction-hint {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: var(--mj-radius-md, 6px);
  font-size: 0.74rem;
  line-height: 1.45;
  border: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.22));
}

.mj-faction-hint.is-ok {
  color: #9fd6a8;
  background: rgba(129, 199, 132, 0.1);
}

.mj-faction-hint.is-err {
  color: #f0a8a8;
  background: rgba(200, 90, 90, 0.12);
}

.mj-faction-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 0;
  overflow: hidden;
}

.mj-faction-list {
  overflow-y: auto;
  padding: 8px;
  border-right: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.22));
  background: rgba(0, 0, 0, 0.28);
}

.mj-faction-group {
  margin-bottom: 8px;
}

.mj-faction-group__label {
  padding: 4px 6px;
  font-size: 0.72rem;
  color: var(--mj-gold-dim, #b89a4a);
  border-bottom: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.22));
}

.mj-faction-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  margin-top: 3px;
  text-align: left;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid transparent;
  border-radius: var(--mj-radius-sm, 4px);
  color: var(--mj-text, #e8e4dc);
  font-size: 0.8rem;
  cursor: pointer;
}

.mj-faction-item:hover {
  border-color: var(--mj-border, rgba(140, 120, 83, 0.45));
}

.mj-faction-item.is-active {
  border-color: var(--mj-gold, #e8c870);
  background: rgba(232, 200, 112, 0.12);
}

.mj-faction-item__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mj-faction-item__type {
  flex: none;
  font-size: 0.68rem;
  color: var(--mj-gold-dim, #b89a4a);
}

.mj-faction-item__power {
  flex: none;
  font-size: 0.68rem;
  color: var(--mj-muted, #8a9088);
}

.mj-faction-edit {
  overflow-y: auto;
  padding: 10px 12px;
}

.mj-faction-field {
  display: block;
  margin-bottom: 8px;
}

.mj-faction-field__label {
  display: block;
  margin-bottom: 3px;
  font-size: 0.72rem;
  color: var(--mj-muted, #8a9088);
}

.mj-faction-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: var(--mj-radius-md, 6px);
  border: 1px solid var(--mj-form-border, rgba(100, 92, 72, 0.5));
  background: var(--mj-form-bg, rgba(8, 12, 10, 0.92));
  color: var(--mj-form-text, #c4bcaa);
  font-size: 0.78rem;
  font-family: inherit;
}

.mj-faction-input:focus {
  outline: none;
  border-color: var(--mj-gold-dim, #b89a4a);
}

.mj-faction-input--area {
  resize: vertical;
  line-height: 1.5;
}

.mj-faction-power {
  display: flex;
  gap: 6px;
}

.mj-faction-power__cell {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  color: var(--mj-muted, #8a9088);
}

.mj-faction-input--num {
  width: 64px;
  flex: 1;
}

.mj-faction-empty {
  margin: 8px 2px;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--mj-muted, #8a9088);
}

.mj-faction-warn {
  margin: 6px 0 0;
  font-size: 0.68rem;
  color: #e8c5a0;
}

/* `--danger` 变体只在别处组件内 scoped 定义过，这里自己补一份（扁平、无阴影）。 */
.mj-faction-root .mj-item-detail-action-btn--danger {
  color: #f0a8a8;
  border-color: rgba(200, 90, 90, 0.45);
}

.mj-faction-root .mj-item-detail-action-btn--danger:hover {
  background: rgba(200, 90, 90, 0.12);
  border-color: rgba(220, 110, 110, 0.7);
}

.mj-faction-root .mj-item-detail-action-btn--danger.is-armed {
  color: #f0a8a8;
  background: rgba(200, 90, 90, 0.18);
  border-color: rgba(220, 110, 110, 0.7);
}

@media (max-width: 860px) {
  .mj-faction-body {
    grid-template-columns: 1fr;
  }

  .mj-faction-list {
    max-height: 160px;
    border-right: none;
    border-bottom: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.22));
  }
}
</style>
