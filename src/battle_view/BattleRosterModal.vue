<script setup lang="ts">
/**
 * 开战前的参战人员选择。
 *
 * 剧情推进触发战斗后、进战斗界面之前弹出：把状态 AI 那份「谁打谁」的名单摊开给玩家，
 * 可以逐人改成 **我方 / 敌方 / 不参战**，再开打。
 *
 * 之所以放在 App 层拦截而不是塞进 BattleScreen：`createBattleCombatants` 只依赖
 * triggerEntry 里的 npcId（displayName 兜底）去向 npcStore 取人（见 battleInit），所以这里只需产出
 * 一份**改写过的 triggerEntry**，下游一行都不用动。
 *
 * 边界：
 * - 主角固定在我方（战斗永远有主角，故不可改、也不可取消参战）；
 * - 每方上限 5（与 battleInit 的截断一致，超了直接拒绝并给提示）；
 * - 敌方至少 1 人，否则不让开打（战斗初始化会因为找不到敌人直接抛错）；
 * - 测试战斗（`isTestBattle`）由调用方跳过本弹窗——假人是临时造的，没必要选。
 */
import { computed, ref, watch } from "vue";
import type { BattleTriggerEntry } from "../ai/state_generate";
import { protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import { Character } from "../role_core/Character";
import type { Npc } from "../role_core/Npc";

/** 单方参战人数上限（与 `createBattleCombatants` 里的截断保持一致）。 */
const MAX_SIDE = 5;

type Side = "ally" | "enemy" | "none";

interface RosterRow {
  key: string;
  /** 稳定 npcId（NPC 行必有；主角行无）。编队产出 triggerEntry 时随行携带，供战斗链按 id 回查。 */
  npcId?: string;
  name: string;
  /** 名字下面那行：简介 · 境界 */
  sub: string;
  presence: string;
  hp: string;
  isProtagonist: boolean;
  side: Side;
}

const props = defineProps<{
  open: boolean;
  trigger: BattleTriggerEntry | null;
}>();

const emit = defineEmits<{
  /** 按玩家的编队开打（携带改写过的 triggerEntry）。 */
  confirm: [entry: BattleTriggerEntry];
  /** 不改，按剧情（AI）给的名单开打。 */
  useDefault: [];
}>();

const rows = ref<RosterRow[]>([]);
const hint = ref("");

const allyCount = computed(() => rows.value.filter(r => r.side === "ally").length);
const enemyCount = computed(() => rows.value.filter(r => r.side === "enemy").length);
const canStart = computed(() => enemyCount.value >= 1);

function buildRows(entry: BattleTriggerEntry | null): RosterRow[] {
  // 名单身份判定优先 npcId（精确），未带 id 的条目（旧存档）回退按名。
  const allyIds = new Set((entry?.allies ?? []).map(a => a.npcId).filter((v): v is string => !!v));
  const enemyIds = new Set((entry?.enemies ?? []).map(e => e.npcId).filter((v): v is string => !!v));
  const allyNames = new Set((entry?.allies ?? []).filter(a => !a.npcId).map(a => a.displayName));
  const enemyNames = new Set((entry?.enemies ?? []).filter(e => !e.npcId).map(e => e.displayName));
  const pick = (npcId: string | undefined, name: string): Side => {
    if (npcId && (allyIds.has(npcId) || enemyIds.has(npcId))) {
      return allyIds.has(npcId) ? "ally" : "enemy";
    }
    return allyNames.has(name) ? "ally" : enemyNames.has(name) ? "enemy" : "none";
  };

  const out: RosterRow[] = [];

  const p = protagonist.value;
  if (p) {
    out.push({
      key: "__protagonist__",
      name: p.displayName,
      sub: `主角 · ${Character.formatRealm(p.realm)}`,
      presence: "—",
      hp: `${p.currentHp}/${p.maxHp}`,
      isProtagonist: true,
      // 主角恒在我方：thisIS主角的主场，战斗必须有人代表玩家。
      side: "ally",
    });
  }

  // 在场 → 休眠 → 离开；同桶内按最近出场排序。已故的不进候选（死人不能出战）。
  const ORDER: Record<string, number> = { active: 0, dormant: 1, departed: 2, dead: 3 };
  const buckets: Npc[][] = [[], [], [], []];
  for (const n of npcStore.allNpcs()) {
    if (n.isDead) continue;
    buckets[ORDER[n.presence] ?? 3].push(n);
  }
  const PRESENCE_ZH: Record<string, string> = { active: "在场", dormant: "休眠", departed: "离开", dead: "已故" };
  const list = buckets.flatMap(b => npcStore.sortByRecent(b));

  for (const n of list) {
    out.push({
      key: n.id || n.displayName,
      npcId: n.id,
      name: n.displayName,
      sub: `${n.identity || "身份未知"} · ${Character.formatRealm(n.realm)}`,
      presence: PRESENCE_ZH[n.presence] ?? "",
      hp: `${n.currentHp}/${n.maxHp}`,
      isProtagonist: false,
      side: pick(n.id, n.displayName),
    });
  }

  // 参与战斗的排前面，其余按原顺序——免得开打前还要在一堆路人里翻。
  const WEIGHT: Record<Side, number> = { ally: 0, enemy: 0, none: 1 };
  return out.sort((a, b) => {
    if (a.isProtagonist) return -1;
    if (b.isProtagonist) return 1;
    return WEIGHT[a.side] - WEIGHT[b.side];
  });
}

watch(
  () => [props.open, props.trigger] as const,
  () => {
    if (!props.open) return;
    rows.value = buildRows(props.trigger);
    hint.value = "";
  },
  { immediate: true },
);

function setSide(row: RosterRow, side: Side): void {
  if (row.isProtagonist) return;
  if (row.side === side) return;
  // 换边前先验额度：目标那一侧满了就给提示，不要默默挤掉别人。
  if (side !== "none") {
    const nextCount = side === "ally" ? allyCount.value : enemyCount.value;
    if (row.side !== side && nextCount >= MAX_SIDE) {
      hint.value = `${side === "ally" ? "我方" : "敌方"}最多 ${MAX_SIDE} 人，先把其他人撤下来。`;
      return;
    }
  }
  hint.value = "";
  row.side = side;
}

/** 按当前编队产出一份新的 triggerEntry（其余字段沿用 AI 给的；NPC 行携带 npcId）。 */
function buildEntry(): BattleTriggerEntry | null {
  const base = props.trigger;
  if (!base) return null;
  const allies = rows.value
    .filter(r => r.side === "ally" && !r.isProtagonist)
    .map(r => ({ npcId: r.npcId, displayName: r.name, roleHint: "友方" }));
  const enemies = rows.value
    .filter(r => r.side === "enemy")
    .map(r => ({ npcId: r.npcId, displayName: r.name, roleHint: "敌方" }));
  return { ...base, allies, enemies };
}

function onConfirm(): void {
  if (!canStart.value) {
    hint.value = "至少要有一个敌人才能开打。";
    return;
  }
  const entry = buildEntry();
  if (entry) emit("confirm", entry);
}

function onUseDefault(): void {
  emit("useDefault");
}

function onClose(): void {
  // 关闭 = 不改名单，直接按剧情开打（战斗已经触发了，不能凭空取消）。
  onUseDefault();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="mj-backdrop">
      <div
        v-if="open && trigger"
        class="mj-protagonist-detail-root mj-roster-root mj-trait-modal-root"
        role="presentation"
      >
        <div class="mj-trait-modal-backdrop" @click="onClose" />
        <Transition name="mj-modal" appear>
          <div class="mj-trait-modal mj-roster-panel" role="dialog" aria-modal="true" @click.stop>
            <h4 class="mj-trait-modal-title">参战人员</h4>
            <div class="mj-trait-modal-rarity">{{ trigger.triggerReason || '剧情触发了战斗' }}</div>

            <div class="mj-roster-count">
              <span>我方 <b>{{ allyCount }}</b>/{{ MAX_SIDE }}</span>
              <span>敌方 <b>{{ enemyCount }}</b>/{{ MAX_SIDE }}</span>
              <span class="mj-roster-count-note">主角必参战，可自行增删其他人的归属</span>
            </div>

            <div class="mj-roster-body">
              <div v-for="row in rows" :key="row.key" class="mj-roster-row">
                <div class="mj-roster-info">
                  <div class="mj-roster-name">
                    {{ row.name }}
                    <span v-if="row.isProtagonist" class="mj-roster-tag">主角</span>
                    <span v-else-if="row.presence" class="mj-roster-tag mj-roster-tag--dim">{{ row.presence }}</span>
                  </div>
                  <div class="mj-roster-sub">{{ row.sub }} · HP {{ row.hp }}</div>
                </div>
                <div class="mj-roster-seg">
                  <button
                    type="button"
                    class="mj-roster-seg-btn"
                    :class="{ 'is-on': row.side === 'ally' }"
                    :disabled="row.isProtagonist"
                    @click="setSide(row, 'ally')"
                  >
                    我方
                  </button>
                  <button
                    type="button"
                    class="mj-roster-seg-btn"
                    :class="{ 'is-on': row.side === 'enemy' }"
                    :disabled="row.isProtagonist"
                    @click="setSide(row, 'enemy')"
                  >
                    敌方
                  </button>
                  <button
                    type="button"
                    class="mj-roster-seg-btn"
                    :class="{ 'is-on': row.side === 'none' }"
                    :disabled="row.isProtagonist"
                    @click="setSide(row, 'none')"
                  >
                    不参战
                  </button>
                </div>
              </div>
              <div v-if="rows.length <= 1" class="mj-roster-empty">
                当前没有可参战的 NPC，只有主角在场（单人出战）。
              </div>
            </div>

            <p v-if="hint" class="mj-roster-hint">{{ hint }}</p>

            <div class="mj-roster-actions">
              <button type="button" class="mj-roster-btn" @click="onUseDefault">用剧情名单</button>
              <button
                type="button"
                class="mj-roster-btn mj-roster-btn--primary"
                :disabled="!canStart"
                @click="onConfirm"
              >
                {{ canStart ? `开打（${allyCount} vs ${enemyCount}）` : '至少要有一个敌人' }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mj-roster-panel {
  max-width: 460px;
  max-height: min(78vh, 620px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mj-roster-count {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
  font-size: 0.75rem;
  color: var(--mj-muted, rgba(232, 228, 220, 0.6));
}

.mj-roster-count b {
  color: var(--mj-gold, #e8c547);
}

.mj-roster-count-note {
  margin-left: auto;
  font-size: 0.68rem;
  opacity: 0.7;
}

.mj-roster-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.mj-roster-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.25));
}

.mj-roster-info {
  flex: 1;
  min-width: 0;
}

.mj-roster-name {
  font-size: 0.85rem;
  color: var(--mj-fg, #e8e4dc);
}

.mj-roster-tag {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.62rem;
  color: #1b1710;
  background: var(--mj-gold, #e8c547);
  vertical-align: 1px;
}

.mj-roster-tag--dim {
  color: var(--mj-muted, rgba(232, 228, 220, 0.7));
  background: rgba(140, 120, 83, 0.28);
}

.mj-roster-sub {
  margin-top: 2px;
  font-size: 0.7rem;
  color: var(--mj-muted, rgba(232, 228, 220, 0.55));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mj-roster-seg {
  display: flex;
  flex: none;
  border: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.35));
  border-radius: 6px;
  overflow: hidden;
}

.mj-roster-seg-btn {
  padding: 5px 9px;
  border: none;
  border-right: 1px solid var(--mj-border-subtle, rgba(140, 120, 83, 0.35));
  background: transparent;
  color: var(--mj-muted, rgba(232, 228, 220, 0.6));
  font-size: 0.72rem;
  cursor: pointer;
}

.mj-roster-seg-btn:last-child {
  border-right: none;
}

.mj-roster-seg-btn.is-on {
  background: rgba(140, 120, 83, 0.34);
  color: var(--mj-fg, #e8e4dc);
}

.mj-roster-seg-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.mj-roster-empty {
  padding: 18px 4px;
  text-align: center;
  font-size: 0.75rem;
  color: var(--mj-muted, rgba(232, 228, 220, 0.45));
}

.mj-roster-hint {
  margin: 8px 0 0;
  font-size: 0.72rem;
  color: #e8b06a;
}

.mj-roster-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.mj-roster-btn {
  flex: 1;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: rgba(20, 28, 22, 0.6);
  color: var(--mj-fg, #e8e4dc);
  font-size: 0.82rem;
  cursor: pointer;
}

.mj-roster-btn--primary {
  border-color: var(--mj-gold-dim, rgba(198, 166, 116, 0.6));
  background: rgba(140, 120, 83, 0.32);
}

.mj-roster-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
