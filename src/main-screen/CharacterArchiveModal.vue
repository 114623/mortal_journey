<script setup lang="ts">
/**
 * 人物档案总览：主角 + 全部已登场 NPC 的列表入口。
 *
 * 点击任一人物打开 {@link CharacterProfileModal} 编辑其性格 / 外貌 / 记忆。
 * 列表按「主角 → 在场 → 休眠 → 已故」分组，NPC 组内按名字排序。
 */
import { computed, ref, shallowRef, watch, onMounted, onUnmounted } from "vue";
import { protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import { Character } from "../role_core/Character";
import type { NpcPresence } from "../role_core/types/playInfo";
import { useScrollLock } from "../composables/useScrollLock";
import {
  clearPendingNpcBasics,
  clearPendingProfile,
  getPendingNpcBasics,
  getPendingProfile,
  pendingKeyOf,
} from "../role_core/pendingEdits";
import { writeActiveSave } from "../save/gameSave";
import CharacterProfileModal from "./CharacterProfileModal.vue";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const scrollLock = useScrollLock();

const detailOpen = ref(false);
/**
 * 当前打开画像的角色（主角或某个 NPC）。
 *
 * 用 shallowRef 而非 ref：Vue 的深层 UnwrapRef 会剥掉类的 protected 成员，
 * 导致实例类型不再可赋值给 `Character`。
 */
const detailTarget = shallowRef<Character | null>(null);

const PRESENCE_LABEL: Record<NpcPresence, string> = {
  active: "在场",
  dormant: "休眠",
  departed: "离开",
  dead: "已故",
};

const PRESENCE_ORDER: Record<NpcPresence, number> = {
  active: 0,
  dormant: 1,
  departed: 2,
  dead: 3,
};

/**
 * 画像状态标签（两行信息合一）：
 * 有未应用草稿时优先显示「待应用」；否则显示已生效的归属（玩家设定 / AI 生成 / 未填写）。
 */
function profileStatus(c: Character): string {
  const key = pendingKeyOf(c);
  if (getPendingProfile(key) || getPendingNpcBasics(key)) return "待应用";
  const p = c.profile;
  if (!p) return "未填写";
  const filled = p.personality.trim() || p.memory.trim() || c.getProfileAppearance().trim();
  if (!filled) return "未填写";
  return p.source === "manual" ? "玩家设定" : "AI 生成";
}

const entries = computed(() => {
  const list: Array<{
    key: string;
    character: Character;
    name: string;
    sub: string;
    tag: string;
    status: string;
    queued: boolean;
    isDead: boolean;
    deletable: boolean;
  }> = [];

  const p = protagonist.value;
  if (p) {
    list.push({
      key: "protagonist",
      character: p,
      name: p.displayName,
      sub: `${Character.formatRealm(p.realm)} · 主角`,
      tag: "主角",
      status: profileStatus(p),
      queued: !!getPendingProfile(pendingKeyOf(p)),
      isDead: false,
      deletable: false,
    });
  }

  const npcs = npcStore.allNpcs().slice().sort((a, b) => {
    const pa = PRESENCE_ORDER[a.presence] ?? 9;
    const pb = PRESENCE_ORDER[b.presence] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.displayName.localeCompare(b.displayName, "zh-Hans-CN");
  });

  for (const npc of npcs) {
    const key = pendingKeyOf(npc);
    list.push({
      key: npc.id || npc.displayName,
      character: npc,
      name: npc.displayName,
      sub: `${npc.identity || "身份未知"} · ${Character.formatRealm(npc.realm)}`,
      tag: PRESENCE_LABEL[npc.presence] ?? "",
      status: profileStatus(npc),
      queued: !!getPendingProfile(key) || !!getPendingNpcBasics(key),
      isDead: npc.isDead,
      deletable: true,
    });
  }

  return list;
});

/** 列表中待删除确认的角色（二次点击才真正删除）。 */
const pendingDelete = ref<string | null>(null);

function openDetail(entryIndex: number): void {
  const entry = entries.value[entryIndex];
  if (!entry) return;
  detailTarget.value = entry.character;
  detailOpen.value = true;
}

function closeDetail(): void {
  detailOpen.value = false;
  detailTarget.value = null;
}

/** 列表内快速删除 NPC 卡（二次点击确认）。 */
function onEntryDelete(entryIndex: number, ev: MouseEvent): void {
  ev.stopPropagation();
  const entry = entries.value[entryIndex];
  if (!entry || !entry.deletable) return;
  if (pendingDelete.value !== entry.key) {
    pendingDelete.value = entry.key;
    return;
  }
  pendingDelete.value = null;
  const npc = entry.character as unknown as { displayName?: string; id?: string };
  clearPendingProfile(entry.key);
  clearPendingNpcBasics(entry.key);
  npcStore.removeNpc(npc.displayName ?? entry.name);
  writeActiveSave();
  if (detailTarget.value === entry.character) closeDetail();
}

/** 画像弹窗内删除后同步关闭详情。 */
function onProfileDeleted(): void {
  closeDetail();
}

function onBackdropClick(): void {
  emit("close");
}

function onCloseClick(): void {
  emit("close");
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && props.open && !detailOpen.value) {
    ev.preventDefault();
    emit("close");
  }
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
        class="mj-trait-modal-root mj-protagonist-detail-root mj-archive-root"
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
            class="mj-trait-modal mj-archive-panel"
            role="dialog"
            aria-modal="true"
            @click.stop
          >
            <button type="button" class="mj-trait-modal-close" aria-label="关闭" @click="onCloseClick">
              ×
            </button>
            <h4 class="mj-trait-modal-title">人物档案</h4>
            <div class="mj-trait-modal-rarity">
              点击人物编辑性格 / 外貌 / 记忆与基本信息（回合进行中也可改，回合结束后生效）
            </div>

            <div class="mj-archive-body">
              <div v-if="entries.length === 0" class="mj-archive-empty">
                暂无可编辑的人物
              </div>
              <div
                v-for="(entry, idx) in entries"
                :key="entry.key"
                class="mj-archive-entry"
                :class="{ 'mj-archive-entry--dead': entry.isDead, 'mj-archive-entry--queued': entry.queued }"
                @click="openDetail(idx)"
              >
                <div class="mj-archive-entry__main">
                  <span class="mj-archive-entry__name">
                    <template v-if="entry.isDead"><s>{{ entry.name }}</s></template>
                    <template v-else>{{ entry.name }}</template>
                  </span>
                  <span v-if="entry.tag" class="mj-archive-entry__tag">{{ entry.tag }}</span>
                  <button
                    v-if="entry.deletable"
                    type="button"
                    class="mj-archive-entry__del"
                    :class="{ 'is-armed': pendingDelete === entry.key }"
                    :title="pendingDelete === entry.key ? '再次点击确认删除' : '删除该角色卡'"
                    @click="onEntryDelete(idx, $event)"
                  >
                    {{ pendingDelete === entry.key ? '确认删除' : '✕' }}
                  </button>
                </div>
                <div class="mj-archive-entry__sub">{{ entry.sub }}</div>
                <div
                  class="mj-archive-entry__status"
                  :class="{ 'mj-archive-entry__status--queued': entry.status === '待应用' }"
                >画像：{{ entry.status }}</div>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
    <CharacterProfileModal
      :open="detailOpen"
      :character="detailTarget"
      @close="closeDetail"
      @deleted="onProfileDeleted"
    />
  </Teleport>
</template>

<style scoped>
.mj-archive-root .mj-trait-modal.mj-archive-panel {
  max-width: 420px;
  max-height: min(76vh, 560px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mj-archive-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.mj-archive-empty {
  padding: 24px;
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.8rem;
}

.mj-archive-entry {
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.22);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.mj-archive-entry:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(232, 197, 71, 0.35);
}

.mj-archive-entry--dead {
  opacity: 0.5;
}

.mj-archive-entry--queued {
  border-color: rgba(120, 160, 230, 0.4);
}

.mj-archive-entry__main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mj-archive-entry__del {
  margin-left: auto;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.65rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.mj-archive-entry__del:hover {
  color: #f0a8a8;
  border-color: rgba(200, 90, 90, 0.45);
}

.mj-archive-entry__del.is-armed {
  color: #f0a8a8;
  background: rgba(200, 90, 90, 0.18);
  border-color: rgba(220, 110, 110, 0.7);
}

.mj-archive-entry__name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--mj-text, #e8e4dc);
}

.mj-archive-entry__tag {
  font-size: 0.65rem;
  padding: 0 6px;
  line-height: 16px;
  border-radius: 8px;
  color: var(--mj-gold, #e8c547);
  background: rgba(232, 197, 71, 0.14);
}

.mj-archive-entry__sub {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.55);
  margin-top: 2px;
}

.mj-archive-entry__status {
  font-size: 0.68rem;
  color: var(--mj-gold-dim, #b89a4a);
  margin-top: 2px;
}

.mj-archive-entry__status--queued {
  color: #cfe0ff;
}
</style>
