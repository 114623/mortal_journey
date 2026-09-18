<script setup lang="ts">
/**
 * 游戏内「读取人生」弹窗。
 *
 * 与标题界面的读取人生共用同一批存档（localStorage），但可以直接在游戏中切换人生，
 * 不必退回标题界面。读取行为与标题界面完全一致：
 * - 完整存档 → 直接进入主界面
 * - 已终结存档 → 进入结局纪念碑
 *
 * 存档位置（浏览器 localStorage，同一浏览器 + 同一域名下共享）：
 * - 索引：`MJ_SAVES_INDEX_V1`
 * - 每条存档：`MJ_SAVE_V1:<id>`
 * - 当前活动存档指针：`MJ_ACTIVE_SAVE_ID_V1`
 */
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import {
  readSaveIndex,
  readSave,
  removeSave,
  getActiveSaveId,
  SAVE_INDEX_KEY,
  SAVE_PREFIX,
  type MjSavePayload,
  type SaveIndexEntry,
} from "../save/gameSave";
import { downloadJson } from "../save/saveFileTransfer";
import { useScrollLock } from "../composables/useScrollLock";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  /** 请求读取指定存档；由上层（App）执行与标题界面一致的切换流程。 */
  load: [value: { id: string; payload: MjSavePayload }];
}>();

const scrollLock = useScrollLock();

const saves = ref<SaveIndexEntry[]>([]);
const status = ref("");
const statusOk = ref(false);
const activeId = ref<string | null>(null);

function setStatus(msg: string, ok: boolean): void {
  status.value = msg;
  statusOk.value = ok;
}

function refresh(): void {
  saves.value = readSaveIndex();
  activeId.value = getActiveSaveId();
}

/** 最新更新的排前面；自动快照按回合号倒序跟在各自主存档后面。 */
const sorted = computed(() =>
  [...saves.value].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      status.value = "";
      refresh();
    }
  },
  { immediate: true },
);

function fmtTime(ts: number | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function onLoad(it: SaveIndexEntry): void {
  if (it.id === activeId.value) {
    setStatus("这已经是当前正在进行的人生。", false);
    return;
  }
  const ok = window.confirm(
    `确定读取「${it.name || it.id}」？\n当前人生会自动保存，之后可再读回来。`,
  );
  if (!ok) return;
  let payload: MjSavePayload | null;
  try {
    payload = readSave(it.id);
  } catch (e) {
    setStatus("读取失败：" + (e instanceof Error ? e.message : "未知错误"), false);
    return;
  }
  if (!payload || !payload.fateChoice) {
    setStatus("读取失败：存档内容不存在或已损坏。", false);
    return;
  }
  emit("load", { id: it.id, payload });
}

function onDelete(it: SaveIndexEntry): void {
  if (it.id === activeId.value) {
    setStatus("不能删除当前正在进行的人生。", false);
    return;
  }
  if (!window.confirm(`确定删除存档「${it.name || it.id}」？\n此操作不可撤销。`)) return;
  removeSave(it.id);
  refresh();
  setStatus("已删除。", true);
}

function onExport(it: SaveIndexEntry): void {
  try {
    const payload = readSave(it.id);
    if (!payload || !payload.fateChoice) {
      setStatus("导出失败：存档内容不存在或已损坏。", false);
      return;
    }
    const name = (payload.fateChoice.basics?.playerName || it.id).trim() || it.id;
    downloadJson(`${name}-${it.id}.json`, payload);
    setStatus("已导出存档文件。", true);
  } catch (e) {
    setStatus("导出失败：" + (e instanceof Error ? e.message : "未知错误"), false);
  }
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && props.open) emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) scrollLock.acquire();
    else scrollLock.release();
  },
  { immediate: true },
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  scrollLock.release();
});
</script>

<template>
  <div v-if="open" class="mj-saveload-mask" @click.self="emit('close')">
    <div class="mj-saveload" role="dialog" aria-modal="true" aria-label="读取人生">
      <header class="mj-saveload__head">
        <h3 class="mj-saveload__title">读取人生</h3>
        <button type="button" class="mj-saveload__close" title="关闭" @click="emit('close')">✕</button>
      </header>

      <p class="mj-saveload__lead">
        存档保存在<b>本机浏览器</b>（localStorage，索引键 <code>{{ SAVE_INDEX_KEY }}</code>，
        各条存档键前缀 <code>{{ SAVE_PREFIX }}</code>）。与标题界面的「读取人生」是同一批数据。
      </p>

      <div class="mj-saveload__body">
        <p v-if="!sorted.length" class="mj-saveload__empty">暂无存档。</p>

        <div v-for="it in sorted" :key="it.id" class="mj-saveload__row">
          <div class="mj-saveload__info">
            <p class="mj-saveload__name">
              {{ it.name || it.id }}
              <span v-if="it.id === activeId" class="mj-saveload__badge mj-saveload__badge--current">当前</span>
              <span v-if="it.ended" class="mj-saveload__badge mj-saveload__badge--ended">已殒落</span>
              <span v-if="it.auto" class="mj-saveload__badge mj-saveload__badge--auto">自动 · {{ it.auto.turn }}</span>
              <span v-if="it.imported" class="mj-saveload__badge mj-saveload__badge--imported">导入</span>
            </p>
            <p v-if="it.realm || it.location" class="mj-saveload__meta">
              {{ it.realm }}<template v-if="it.realm && it.location"> · </template>{{ it.location }}
            </p>
            <p class="mj-saveload__meta">
              更新：{{ fmtTime(it.updatedAt) }} · 创建：{{ fmtTime(it.createdAt) }}
            </p>
          </div>
          <div class="mj-saveload__actions">
            <button
              type="button"
              class="mj-saveload__btn"
              :disabled="it.id === activeId"
              @click="onLoad(it)"
            >读取</button>
            <button type="button" class="mj-saveload__btn" @click="onExport(it)">导出</button>
            <button
              type="button"
              class="mj-saveload__btn mj-saveload__btn--danger"
              :disabled="it.id === activeId"
              @click="onDelete(it)"
            >删除</button>
          </div>
        </div>
      </div>

      <p v-if="status" class="mj-saveload__status" :class="{ 'is-ok': statusOk }">{{ status }}</p>
    </div>
  </div>
</template>

<style scoped>
.mj-saveload-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.62);
  padding: 16px;
}

.mj-saveload {
  width: min(720px, 96vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(140, 120, 83, 0.45);
  border-radius: 6px;
  background: linear-gradient(180deg, #1b1710 0%, #141009 100%);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  color: #e8dcc2;
  font-family: inherit;
}

.mj-saveload__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(140, 120, 83, 0.32);
}

.mj-saveload__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--mj-gold, #e8c547);
}

.mj-saveload__close {
  background: none;
  border: none;
  color: #a89574;
  font-size: 1rem;
  cursor: pointer;
  padding: 0 4px;
}
.mj-saveload__close:hover {
  color: #f0d9b8;
}

.mj-saveload__lead {
  margin: 0;
  padding: 8px 14px;
  font-size: 0.7rem;
  line-height: 1.6;
  color: #9d8a6a;
  border-bottom: 1px solid rgba(140, 120, 83, 0.2);
}
.mj-saveload__lead code {
  color: #c3ab88;
  font-size: 0.68rem;
}

.mj-saveload__body {
  overflow-y: auto;
  padding: 10px 14px;
  flex: 1;
}

.mj-saveload__empty {
  margin: 18px 0;
  text-align: center;
  font-size: 0.78rem;
  color: #8d7a5f;
}

.mj-saveload__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid rgba(140, 120, 83, 0.28);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
}

.mj-saveload__info {
  min-width: 0;
  flex: 1;
}

.mj-saveload__name {
  margin: 0 0 2px;
  font-size: 0.84rem;
  color: #f0d9b8;
}

.mj-saveload__badge {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  line-height: 15px;
  border-radius: 8px;
  font-size: 0.62rem;
  vertical-align: 1px;
}
.mj-saveload__badge--current {
  color: #1b1710;
  background: var(--mj-gold, #e8c547);
}
.mj-saveload__badge--auto {
  color: #9fd6a0;
  border: 1px solid rgba(120, 190, 130, 0.5);
  background: rgba(90, 160, 100, 0.15);
}
.mj-saveload__badge--ended {
  color: #d08a8a;
  border: 1px solid rgba(200, 120, 120, 0.45);
}
.mj-saveload__badge--imported {
  color: #d8c486;
  border: 1px solid rgba(200, 180, 100, 0.5);
}

.mj-saveload__meta {
  margin: 1px 0 0;
  font-size: 0.68rem;
  color: #8d7a5f;
}

.mj-saveload__actions {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
}

.mj-saveload__btn {
  padding: 4px 9px;
  font-size: 0.72rem;
  font-family: inherit;
  color: #c3ab88;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(140, 120, 83, 0.45);
  border-radius: 3px;
  cursor: pointer;
}
.mj-saveload__btn:hover:not(:disabled) {
  border-color: var(--mj-gold, #e8c547);
  color: #f0d9b8;
}
.mj-saveload__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mj-saveload__btn--danger:hover:not(:disabled) {
  border-color: #c96a6a;
  color: #e5a0a0;
}

.mj-saveload__status {
  margin: 0;
  padding: 7px 14px;
  border-top: 1px solid rgba(140, 120, 83, 0.28);
  font-size: 0.7rem;
  color: #d0a0a0;
}
.mj-saveload__status.is-ok {
  color: #a8cf9a;
}
</style>
