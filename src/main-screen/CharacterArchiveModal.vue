<script setup lang="ts">
/**
 * 角色总览：主角 + 全部已登场 NPC 的列表入口（侧边栏入口名「角色」）。
 *
 * 卡片与世界地图「场景NPC」同款（见 {@link NpcMiniCard}，含 HP/MP 条）：
 * - 点 NPC 卡 → 打开 {@link NpcDetailModal}（与世界地图点人物卡一致的信息界面），
 *   界面里的「角色设定」按钮再进 {@link CharacterProfileModal} 编辑性格/外貌/记忆；
 * - 主角没有 NpcDetailModal 那套信息界面，点卡直接进 CharacterProfileModal。
 *
 * 排序：按 presence 分组（在场 → 休眠 → 离开 → 已故），组内按**最近出场**排序。
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
import NpcDetailModal from "./NpcDetailModal.vue";
import NpcMiniCard from "./NpcMiniCard.vue";
import type { Npc } from "../role_core/Npc";

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

/** 当前打开的 NPC 信息界面（与世界地图点人物卡同一套）。 */
const npcDetailOpen = ref(false);
const npcDetailTarget = shallowRef<Npc | null>(null);

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
    isProtagonist: boolean;
  }> = [];

  const p = protagonist.value;
  if (p) {
    list.push({
      key: "protagonist",
      character: p,
      name: p.displayName,
      sub: `${Character.formatRealm(p.realm)} · 主角`,
      status: profileStatus(p),
      queued: !!getPendingProfile(pendingKeyOf(p)),
      isDead: false,
      deletable: false,
      isProtagonist: true,
      tag: "主角",
    });
  }

  // 先按 presence 分桶，桶内各自按最近出场排序——避免新近出场的休眠者插到在场者前面。
  const buckets: Npc[][] = [[], [], [], []];
  for (const n of npcStore.allNpcs()) {
    const idx = PRESENCE_ORDER[n.presence] ?? 3;
    buckets[idx].push(n);
  }
  const npcs = buckets.flatMap(b => npcStore.sortByRecent(b));

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
      isProtagonist: false,
    });
  }

  return list;
});

/** 列表中待删除确认的角色（二次点击才真正删除）。 */
const pendingDelete = ref<string | null>(null);

/**
 * 点卡片：NPC 开信息界面（同世界地图），主角直接开角色设定编辑。
 *
 * 信息界面里的「角色设定」按钮再通到 {@link CharacterProfileModal}，
 * 与 {@link NpcDetailModal} 内部的行为完全一致。
 */
function openDetail(entryIndex: number): void {
  const entry = entries.value[entryIndex];
  if (!entry) return;
  if (entry.isProtagonist) {
    detailTarget.value = entry.character;
    detailOpen.value = true;
    return;
  }
  npcDetailTarget.value = entry.character as Npc;
  npcDetailOpen.value = true;
}

/** 卡片右侧「📝」：直接进角色设定编辑，免去先点开信息界面的两步。 */
function openProfile(entryIndex: number): void {
  const entry = entries.value[entryIndex];
  if (!entry) return;
  detailTarget.value = entry.character;
  detailOpen.value = true;
}

function closeNpcDetail(): void {
  npcDetailOpen.value = false;
  npcDetailTarget.value = null;
}

function closeDetail(): void {
  detailOpen.value = false;
  detailTarget.value = null;
}

/** 列表内快速删除 NPC 卡（二次点击确认）。 */
function onEntryDelete(entryIndex: number): void {
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
  if (ev.key === "Escape" && props.open && !detailOpen.value && !npcDetailOpen.value) {
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
            <h4 class="mj-trait-modal-title">角色</h4>
            <div class="mj-trait-modal-rarity">
              点人物查看信息，信息界面内可进「角色设定」编辑性格 / 外貌 / 记忆（回合进行中也可改，回合结束后生效）
            </div>

            <div class="mj-archive-body">
              <div v-if="entries.length === 0" class="mj-archive-empty">
                暂无可编辑的人物
              </div>
              <NpcMiniCard
                v-for="(entry, idx) in entries"
                :key="entry.key"
                class="mj-archive-card"
                :npc="entry.character"
                :badge="entry.tag"
                :fallback-line="entry.isProtagonist ? '主角' : undefined"
                :action-label="'📝'"
                :action-title="'编辑角色设定：性格 / 外貌 / 记忆'"
                @action="openProfile(idx)"
                :deletable="entry.deletable"
                :armed="pendingDelete === entry.key"
                :highlighted="entry.queued"
                @click="openDetail(idx)"
                @delete="onEntryDelete(idx)"
              />
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
    <NpcDetailModal
      :open="npcDetailOpen"
      :npc="npcDetailTarget"
      @close="closeNpcDetail"
    />
  </Teleport>
</template>

<style scoped>
.mj-archive-root .mj-trait-modal.mj-archive-panel {
  /* 卡片含 84px 头像与血条，比原来的单行条目宽 */
  max-width: 460px;
  max-height: min(80vh, 640px);
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

.mj-archive-card {
  margin-bottom: 8px;
}

.mj-archive-empty {
  padding: 24px;
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.8rem;
}

</style>
