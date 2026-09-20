<script setup lang="ts">
/**
 * 角色迷你卡 —— 与世界地图「场景NPC」完全同款的卡片（头像 + 姓名 + 境界 + 身份 + HP/MP 条）。
 *
 * 抽成组件的起因：角色（原人物档案）列表与侧边栏在场人物都要求「样式和世界地图里一样」，
 * 与其把 worldMapModal.css 里的 `.map-npc-*` 复制三份，不如共用一处。
 * 样式是搬过来的副本（scoped），避免改动 `worldMapModal.css` 波及世界地图。
 */
import { computed } from "vue";
import type { Npc } from "../role_core/Npc";
import { npcColorTheme } from "../role_core/npcTheme";

/**
 * 卡片能展示的最小角色面：主角与 NPC 都满足，故两者可共用同一张卡。
 */
export interface MiniCardSubject {
  displayName: string;
  realm: { major: string; minor?: string };
  currentHp: number;
  maxHp: number;
  currentMp: number;
  maxMp: number;
  avatarUrl?: string;
  gender?: string;
  race?: string;
  /** NPC 的身份称谓；主角没有该字段。 */
  identity?: string;
  isDead?: boolean;
}

const props = defineProps<{
  npc: MiniCardSubject;
  /** 右上角徽章文字（如"在场""主角""休眠"）；空则不显示。 */
  badge?: string;
  /** 是否显示删除按钮（二次点击确认）。 */
  deletable?: boolean;
  /** 删除按钮是否已进入待确认（armed）态，由父级维护。 */
  armed?: boolean;
  /** 高亮描边（用于标记「有改动待本回合结束后生效」）。 */
  highlighted?: boolean;
  /** 身份缺省时的占位（主角没有 identity，传"主角"以免显示"未知"）。 */
  fallbackLine?: string;
  /** 右侧快捷操作按钮的文字（如"📝"）；不传则不显示。 */
  actionLabel?: string;
  /** 快捷操作按钮的 tooltip。 */
  actionTitle?: string;
}>();

const emit = defineEmits<{
  click: [];
  delete: [];
  /** 右侧快捷操作按钮被点击（角色列表用它直接进角色设定）。 */
  action: [];
}>();

const theme = computed(() => npcColorTheme(props.npc.gender ?? "", props.npc.race ?? ""));

const hpPercent = computed(() =>
  props.npc.maxHp > 0 ? Math.round((props.npc.currentHp / props.npc.maxHp) * 100) : 0,
);
const mpPercent = computed(() =>
  props.npc.maxMp > 0 ? Math.round((props.npc.currentMp / props.npc.maxMp) * 100) : 0,
);

function onDelete(ev: MouseEvent): void {
  ev.stopPropagation();
  emit("delete");
}

function onAction(ev: MouseEvent): void {
  ev.stopPropagation();
  emit("action");
}
</script>

<template>
  <div
    class="npc-mini-card"
    :class="{ 'npc-mini-card--dead': npc.isDead, 'npc-mini-card--queued': highlighted }"
    :data-npc-theme="theme"
    :title="highlighted ? '有改动待本回合结束后生效' : undefined"
    @click="emit('click')"
  >
    <div class="npc-mini-avatar">
      <img
        v-if="npc.avatarUrl"
        class="npc-mini-avatar-img"
        :src="npc.avatarUrl"
        :alt="npc.displayName"
      />
      <span v-else class="npc-mini-avatar-placeholder">{{ npc.displayName.slice(0, 1) }}</span>
    </div>
    <div class="npc-mini-info">
      <div class="npc-mini-top">
        <span class="npc-mini-name">
          <template v-if="npc.isDead"><s>{{ npc.displayName }}</s></template>
          <template v-else>{{ npc.displayName }}</template>
        </span>
        <span class="npc-mini-realm">{{ npc.realm.major }}{{ npc.realm.minor }}</span>
        <span v-if="badge" class="npc-mini-badge">{{ badge }}</span>
        <button
          v-if="actionLabel"
          type="button"
          class="npc-mini-act"
          :title="actionTitle || actionLabel"
          @click="onAction"
        >{{ actionLabel }}</button>
        <button
          v-if="deletable"
          type="button"
          class="npc-mini-del"
          :class="{ 'is-armed': armed }"
          :title="armed ? '再次点击确认删除' : '删除该角色卡'"
          @click="onDelete"
        >{{ armed ? "确认删除" : "✕" }}</button>
      </div>
      <div class="npc-mini-identity">{{ npc.identity || fallbackLine || "未知" }}</div>
      <div class="npc-mini-bars">
        <div class="npc-mini-bar-row">
          <span class="npc-mini-bar-label">HP</span>
          <div class="npc-mini-bar">
            <div class="npc-mini-bar-fill npc-mini-bar-fill--hp" :style="{ width: hpPercent + '%' }" />
          </div>
        </div>
        <div class="npc-mini-bar-row">
          <span class="npc-mini-bar-label">MP</span>
          <div class="npc-mini-bar">
            <div class="npc-mini-bar-fill npc-mini-bar-fill--mp" :style="{ width: mpPercent + '%' }" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 样式与世界地图 .map-npc-card 同款（搬自 worldMapModal.css，类名前缀改为 npc-mini） */
/* 头像贴到卡片左/上/下边缘：卡片去掉 padding（由 info 自己补内边距），头像撑满高度、无自身圆角。
   头像 84 → 104px：贴边的同时必须真的变大，否则只是把 20px 的 padding 抹掉 = 整卡变小。 */
.npc-mini-card {
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(140, 120, 83, 0.35);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.npc-mini-card:hover {
  background: rgba(30, 50, 35, 0.5);
  border-color: rgba(140, 120, 83, 0.6);
}

.npc-mini-card--dead {
  opacity: 0.45;
}

/* 有改动待回合结束后生效 */
.npc-mini-card--queued {
  border-color: rgba(120, 160, 230, 0.55);
}
.npc-mini-card--queued:hover {
  border-color: rgba(120, 160, 230, 0.8);
}

.npc-mini-card[data-npc-theme="male"] {
  border-color: rgba(80, 120, 190, 0.55);
}
.npc-mini-card[data-npc-theme="male"]:hover {
  border-color: rgba(80, 120, 190, 0.8);
}
.npc-mini-card[data-npc-theme="female"] {
  border-color: rgba(190, 116, 146, 0.55);
}
.npc-mini-card[data-npc-theme="female"]:hover {
  border-color: rgba(190, 116, 146, 0.8);
}
.npc-mini-card[data-npc-theme="male"] .npc-mini-avatar {
  border-color: rgba(80, 120, 190, 0.5);
}
.npc-mini-card[data-npc-theme="female"] .npc-mini-avatar {
  border-color: rgba(190, 116, 146, 0.5);
}

.npc-mini-avatar {
  width: 104px;
  align-self: stretch;
  /* 撑满卡片高度：min-height 保证无立绘时也把卡片撑到 104px（与原来含 padding 的高度相当） */
  min-height: 104px;
  flex-shrink: 0;
  border-radius: 0;
  border: none;
  border-right: 1px solid rgba(140, 120, 83, 0.4);
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.npc-mini-avatar-placeholder {
  font-size: 1.7rem;
  color: var(--mj-muted, #8a9088);
  user-select: none;
}

.npc-mini-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
  display: block;
}

.npc-mini-info {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}

.npc-mini-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.npc-mini-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--mj-text, #e8e4dc);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.npc-mini-realm {
  font-size: 0.84rem;
  color: var(--mj-gold-dim, #b89a4a);
  white-space: nowrap;
  flex-shrink: 0;
}

.npc-mini-badge {
  font-size: 0.65rem;
  padding: 0 6px;
  line-height: 16px;
  border-radius: 8px;
  color: var(--mj-gold, #e8c547);
  background: rgba(232, 197, 71, 0.14);
  white-space: nowrap;
  flex-shrink: 0;
}

.npc-mini-act {
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.78rem;
  line-height: 1.4;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.npc-mini-act:hover {
  color: var(--mj-gold, #e8c547);
  border-color: rgba(232, 197, 71, 0.45);
}

/* 有快捷操作按钮时，删除按钮紧跟其后，不再被 margin-left:auto 推走 */
.npc-mini-act ~ .npc-mini-del {
  margin-left: 0;
}

.npc-mini-del {
  margin-left: auto;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.65rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.npc-mini-del:hover {
  color: #f0a8a8;
  border-color: rgba(200, 90, 90, 0.45);
}
.npc-mini-del.is-armed {
  color: #f0a8a8;
  background: rgba(200, 90, 90, 0.18);
  border-color: rgba(220, 110, 110, 0.7);
}

.npc-mini-identity {
  font-size: 0.84rem;
  color: var(--mj-muted, #8a9088);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.npc-mini-bars {
  width: 100%;
  margin-top: 2px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.npc-mini-bar-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.npc-mini-bar-label {
  font-size: 0.78rem;
  color: var(--mj-muted, #8a9088);
  width: 28px;
  text-align: center;
  flex-shrink: 0;
}

.npc-mini-bar {
  flex: 1;
  height: 10px;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 5px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.npc-mini-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s ease;
}

/* 血条红 / 法力蓝（沿用中国区习惯的资源色） */
.npc-mini-bar-fill--hp {
  background: linear-gradient(90deg, #8b2942, #c62828);
}

.npc-mini-bar-fill--mp {
  background: linear-gradient(90deg, #1565c0, #4fc3f7);
}
</style>
