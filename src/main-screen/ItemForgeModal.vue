<script setup lang="ts">
/**
 * 天道编辑弹窗：查看并改写**主角或任意 NPC**名下物品的**品级**、**阶层**与**词条**。
 * 借「天道」之名，行改命之实。
 *
 * 覆盖范围：
 * - 角色切换：主角 / 全部 NPC（含已故、休眠、离开者），副标题带当前所在地点。
 * - 已装备法宝（equippedSlots）/ 已装备功法（gongfaSlots）/ 储物袋全部物品（inventorySlots）。
 * - 法宝：百分比词条（增删改数值与类型）、仙品/神品的转换型特效。
 * - 功法：主属性加成 bonus、体系（通用/剑修/…）、定位（攻击/辅助）、战斗效果。
 * - 丹药：效果类型与数值。
 * - 材料 / 杂物：仅品级与阶层。
 * - **转移**：把当前物品移交（或复制）给主角 / 任意 NPC，可指定落入储物袋、法宝栏或功法栏。
 *
 * 与「世界设定 / 人物档案」不同，物品改动**即时生效并立即落盘**——
 * 它改的是游戏数值而非喂给 AI 的提示词，改完属性面板应当立刻反映。
 * 改品级 / 阶层时默认勾选「同步重算数值」，避免出现「化神阶法宝却是练气阶数值」。
 *
 * 注意：NPC 的装备/功法/储物袋属于状态 AI 的「核心冻结字段」，AI 不会每回合覆写，
 * 但玩家手动改完后若 AI 通过 <MJ_NPC_CORE_CHANGE_TAG> 声明核心变更，仍可能被替换。
 */
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import { protagonist } from "../role_core/Protagonist";
import { Character } from "../role_core/Character";
import { npcStore } from "../role_core/npcStore";
import type { Npc } from "../role_core/Npc";
import { storyStore } from "../role_core/storyStore";
import { formatWorldLocationDash } from "../role_core/types/worldLocation";
import { writeActiveSave } from "../save/gameSave";
import { useScrollLock } from "../composables/useScrollLock";
import {
  TIER_ORDER,
  tierLabel,
  isItemTier,
  describeTierSuppression,
  describeGongfaCultivation,
} from "../role_core/types/itemTier";
import type { ItemTier } from "../role_core/types/itemTier";
import type {
  ItemGrade,
  InventoryStackItem,
  TreasureItemDefinition,
  GongfaItemDefinition,
} from "../role_core/types/itemInfo";
import { addToInventory, setInventorySlot } from "../role_core/CharacterInventory";
import type { TreasureModifierType } from "../role_core/types/treasure";
import {
  TREASURE_MODIFIER_NAMES,
  TREASURE_MODIFIER_TYPES,
  rerollTreasureModifiersKeepTypes,
  rollTreasureFunction,
  rollTreasureSpecialEffect,
} from "../role_core/types/treasure";
import { GONGFA_SYSTEM_KEYS, rollGongfaFunction } from "../role_core/types/gongfa";
import type { ElixirEffectType } from "../role_core/types/elixir";
import {
  VALID_ELIXIR_EFFECT_TYPES,
  isElixirPercent,
  rollElixirValue,
} from "../role_core/types/elixir";
import {
  GONGFA_GRADE_ATTRI_TABLE,
  rollGradeAttriValue,
} from "../role_core/types/gameConstants";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const scrollLock = useScrollLock();

// ── 常量 ────────────────────────────────────────────────────────────────────

const GRADE_ORDER: readonly ItemGrade[] = ["下品", "中品", "上品", "极品", "仙品", "神品"];
const GONGFA_ROLES = ["攻击", "辅助"] as const;
const BONUS_STATS = Object.keys(GONGFA_GRADE_ATTRI_TABLE);

// ── 角色（主角 / NPC）──────────────────────────────────────────────────────

/** 主角在角色列表里的固定 key。 */
const PROTAGONIST_KEY = "__protagonist__";

interface OwnerEntry {
  key: string;
  name: string;
  /** 副标题：身份 · 境界 · 当前地点（NPC 额外标已故/在场）。 */
  sub: string;
  /** 排序权重：在场 < 休眠 < 离开 < 已故。 */
  rank: number;
}

/** 把四级地点格式化成「大区域-国家-区域-具体地点」；缺失时返回「未知」。 */
function formatLoc(loc: unknown): string {
  if (!loc || typeof loc !== "object") return "未知";
  const l = loc as { region?: string; country?: string; area?: string; detail?: string };
  return formatWorldLocationDash({
    region: l.region ?? "",
    country: l.country ?? "",
    area: l.area ?? "",
    detail: l.detail ?? "",
  });
}

const selectedOwnerKey = ref<string>(PROTAGONIST_KEY);

/** 解析当前选中的角色。 */
const owner = computed(() => {
  if (selectedOwnerKey.value === PROTAGONIST_KEY) return protagonist.value;
  return npcStore.getNpcById(selectedOwnerKey.value) ?? null;
});

const isProtagonistOwner = computed(() => selectedOwnerKey.value === PROTAGONIST_KEY);

/** 角色列表：主角 + 全部 NPC（在场 → 休眠 → 离开 → 已故）。 */
const owners = computed<OwnerEntry[]>(() => {
  const out: OwnerEntry[] = [];
  const p = protagonist.value;
  if (p) {
    out.push({
      key: PROTAGONIST_KEY,
      name: p.displayName || "主角",
      sub: `主角 · ${Character.formatRealm(p.realm)} · ${formatLoc(storyStore.worldLocation.value)}`,
      rank: -1,
    });
  }
  const npcs = npcStore.allNpcs().map((n) => ({
    npc: n,
    rank: n.isDead ? 3 : n.presence === "active" ? 0 : n.presence === "dormant" ? 1 : 2,
  }));
  npcs.sort((a, b) => a.rank - b.rank || a.npc.displayName.localeCompare(b.npc.displayName, "zh"));
  for (const { npc, rank } of npcs) {
    const tag = npc.isDead ? " · 已故" : npc.presence === "active" ? " · 在场" : "";
    out.push({
      key: npc.id,
      name: npc.displayName,
      sub: `${npc.identity || "NPC"} · ${Character.formatRealm(npc.realm)} · ${formatLoc(npc.currentLocation)}${tag}`,
      rank,
    });
  }
  return out;
});

function selectOwner(key: string): void {
  selectedOwnerKey.value = key;
  selectedKey.value = null;
  hint.value = "";
}

// ── 物品定位 ────────────────────────────────────────────────────────────────

type ItemZone = "equip" | "gongfa" | "bag";

interface ItemRef {
  zone: ItemZone;
  index: number;
}

interface ItemEntry {
  key: string;
  zone: ItemZone;
  index: number;
  item: InventoryStackItem;
  /** 是否为可编辑的物品（灵石堆不可编辑，仅跳过）。 */
  editable: boolean;
}

/** 物品是否有 itemType（灵石堆没有）。 */
function isTypedItem(it: InventoryStackItem | null): boolean {
  return !!it && typeof it === "object" && "itemType" in it;
}

function itemDisplayName(it: InventoryStackItem): string {
  if (!isTypedItem(it)) return "灵石";
  return (it as { name?: string }).name ?? "未知道具";
}

function itemTypeLabel(it: InventoryStackItem): string {
  if (!isTypedItem(it)) return "灵石";
  return (it as { itemType: string }).itemType;
}

/** 汇总当前角色名下全部物品，按区域分组。 */
const allEntries = computed<ItemEntry[]>(() => {
  const c = owner.value;
  if (!c) return [];
  const out: ItemEntry[] = [];
  c.equippedSlots.forEach((it, index) => {
    if (!it) return;
    out.push({ key: `equip:${index}`, zone: "equip", index, item: it as InventoryStackItem, editable: true });
  });
  c.gongfaSlots.forEach((it, index) => {
    if (!it) return;
    out.push({ key: `gongfa:${index}`, zone: "gongfa", index, item: it as InventoryStackItem, editable: true });
  });
  c.inventorySlots.forEach((it, index) => {
    if (!it) return;
    const typed = isTypedItem(it);
    out.push({
      key: `bag:${index}`,
      zone: "bag",
      index,
      item: it,
      editable: typed && itemTypeLabel(it) !== "灵石",
    });
  });
  return out;
});

function resolveEntry(ref0: ItemRef): InventoryStackItem | null {
  const c = owner.value;
  if (!c) return null;
  if (ref0.zone === "equip") return (c.equippedSlots[ref0.index] as InventoryStackItem) ?? null;
  if (ref0.zone === "gongfa") return (c.gongfaSlots[ref0.index] as InventoryStackItem) ?? null;
  return c.inventorySlots[ref0.index] ?? null;
}

// ── 编辑态 ──────────────────────────────────────────────────────────────────

interface ModifierDraft {
  modifierType: TreasureModifierType;
  value: number;
}

interface ForgeDraft {
  name: string;
  grade: ItemGrade;
  tier: ItemTier;
  modifiers: ModifierDraft[];
  bonusStat: string;
  bonusValue: number;
  system: string;
  role: string;
  effectType: ElixirEffectType;
  elixirValue: number;
  elixirIsPercent: boolean;
}

const selectedKey = ref<string | null>(null);
const draft = ref<ForgeDraft | null>(null);
/** 改品级 / 阶层时是否同步重算数值。 */
const autoRescale = ref(true);
const hint = ref("");

const selectedEntry = computed<ItemEntry | null>(
  () => allEntries.value.find((e) => e.key === selectedKey.value) ?? null,
);

const selectedType = computed(() => {
  const e = selectedEntry.value;
  return e ? itemTypeLabel(e.item) : "";
});

const realmMajor = computed(() => owner.value?.realm.major ?? "");

function emptyDraft(g: ItemGrade, t: ItemTier): ForgeDraft {
  return {
    name: "",
    grade: g,
    tier: t,
    modifiers: [],
    bonusStat: BONUS_STATS[0],
    bonusValue: 0,
    system: GONGFA_SYSTEM_KEYS[0],
    role: "攻击",
    effectType: "恢复血量",
    elixirValue: 1,
    elixirIsPercent: false,
  };
}

function loadDraft(it: InventoryStackItem): ForgeDraft {
  const anyIt = it as unknown as Record<string, unknown>;
  const grade = (typeof anyIt.grade === "string" ? anyIt.grade : "下品") as ItemGrade;
  // 功法缺 tier 是老存档常态。此时回退到「与持有者同阶」而非练气——
  // 否则玩家只是打开看一眼再保存，就会给元婴老角色的入门功法打上「练气阶」，
  // 立刻被压制到两三成，属无预警削号。
  const fallbackTier: ItemTier =
    anyIt.itemType === "功法"
      ? (isItemTier(realmMajor.value) ? realmMajor.value : "练气")
      : "练气";
  const tier = (typeof anyIt.tier === "string" ? anyIt.tier : fallbackTier) as ItemTier;
  const d = emptyDraft(grade, tier);
  d.name = typeof anyIt.name === "string" ? anyIt.name : "";

  if (anyIt.itemType === "法宝") {
    const fn = anyIt.function as { modifiers?: Array<{ modifierType: string; value: number }> } | undefined;
    d.modifiers = (fn?.modifiers ?? []).map((m) => ({
      modifierType: m.modifierType as TreasureModifierType,
      value: Number(m.value) || 0,
    }));
  } else if (anyIt.itemType === "功法") {
    const bonus = (anyIt.bonus ?? {}) as Record<string, number>;
    const keys = Object.keys(bonus);
    d.bonusStat = BONUS_STATS.includes(keys[0]) ? keys[0] : BONUS_STATS[0];
    d.bonusValue = Number(bonus[d.bonusStat] ?? 0) || 0;
    d.system = typeof anyIt.system === "string" ? anyIt.system : GONGFA_SYSTEM_KEYS[0];
    d.role = typeof anyIt.role === "string" ? anyIt.role : "攻击";
  } else if (anyIt.itemType === "丹药") {
    d.effectType = (typeof anyIt.effectType === "string" ? anyIt.effectType : "恢复血量") as ElixirEffectType;
    const eff = (anyIt.effects ?? {}) as { value?: number; isPercent?: boolean };
    d.elixirValue = Number(eff.value ?? 1) || 1;
    d.elixirIsPercent = eff.isPercent === true;
  }
  return d;
}

function select(key: string): void {
  selectedKey.value = key;
  hint.value = "";
}

watch(
  () => [props.open, selectedKey.value, allEntries.value.length] as const,
  () => {
    if (!props.open) return;
    const e = selectedEntry.value;
    if (!e) {
      draft.value = null;
      return;
    }
    if (!e.editable) {
      draft.value = null;
      return;
    }
    draft.value = loadDraft(e.item);
  },
  { immediate: true },
);

// 打开时默认选中主角、并选中其第一件可编辑物品
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    selectedOwnerKey.value = PROTAGONIST_KEY;
    const first = allEntries.value.find((e) => e.editable);
    selectedKey.value = first ? first.key : null;
  },
  { immediate: true },
);

// 角色消失（如 NPC 被移除）时回退到主角，避免编辑区悬空
watch(owners, (list) => {
  if (selectedOwnerKey.value === PROTAGONIST_KEY) return;
  if (!list.some((o) => o.key === selectedOwnerKey.value)) {
    selectedOwnerKey.value = PROTAGONIST_KEY;
    selectedKey.value = null;
  }
});

// ── 数值重算 ────────────────────────────────────────────────────────────────

/** 按当前品阶 / 阶层重算词条数值（法宝词条、功法加成、丹药数值）。 */
function rescale(): void {
  const d = draft.value;
  if (!d) return;
  if (selectedType.value === "法宝") {
    if (d.modifiers.length === 0) return;
    const next = rerollTreasureModifiersKeepTypes(
      { name: "", modifiers: d.modifiers.map((m) => ({ ...m })) },
      d.grade,
      d.tier,
    );
    d.modifiers = next.modifiers.map((m) => ({ ...m }));
  } else if (selectedType.value === "功法") {
    d.bonusValue = rollGradeAttriValue(d.bonusStat, d.grade, GONGFA_GRADE_ATTRI_TABLE);
  } else if (selectedType.value === "丹药") {
    d.elixirValue = rollElixirValue(d.effectType, d.grade, d.tier);
    d.elixirIsPercent = isElixirPercent(d.effectType, d.grade);
  }
}

// 品级 / 阶层变化时按开关同步重算数值
watch(
  () => (draft.value ? [draft.value.grade, draft.value.tier] : null),
  () => {
    if (!autoRescale.value || !draft.value) return;
    rescale();
  },
);

// 丹药效果类型变化时同步百分比标记与建议数值
watch(
  () => (draft.value && selectedType.value === "丹药" ? draft.value.effectType : null),
  () => {
    const d = draft.value;
    if (!d || selectedType.value !== "丹药") return;
    d.elixirIsPercent = isElixirPercent(d.effectType, d.grade);
    if (autoRescale.value) {
      d.elixirValue = rollElixirValue(d.effectType, d.grade, d.tier);
    }
  },
);

// ── 词条操作（法宝）────────────────────────────────────────────────────────

function addModifier(): void {
  const d = draft.value;
  if (!d) return;
  const used = new Set(d.modifiers.map((m) => m.modifierType));
  const next = TREASURE_MODIFIER_TYPES.find((t) => !used.has(t)) ?? TREASURE_MODIFIER_TYPES[0];
  d.modifiers.push({ modifierType: next, value: 5 });
}

function removeModifier(i: number): void {
  draft.value?.modifiers.splice(i, 1);
}

/** 整体重掷法宝词条（保留条数，类型随机）。 */
function rerollModifiers(): void {
  const d = draft.value;
  if (!d) return;
  const fn = rollTreasureFunction(d.grade, d.tier);
  d.modifiers = fn.modifiers.map((m) => ({ ...m }));
}

/** 重掷功法战斗效果（按体系 + 品阶 + 定位）。 */
function rerollGongfaFunction(): void {
  const d = draft.value;
  if (!d) return;
  const fn = rollGongfaFunction(
    (GONGFA_SYSTEM_KEYS as readonly string[]).includes(d.system)
      ? (d.system as (typeof GONGFA_SYSTEM_KEYS)[number])
      : "通用",
    d.grade,
    (GONGFA_ROLES as readonly string[]).includes(d.role)
      ? (d.role as (typeof GONGFA_ROLES)[number])
      : "攻击",
  );
  // 名称/简介/效果整体替换，保留层级与熟练度
  const it = currentItem();
  if (it) {
    const rec = it as unknown as Record<string, unknown>;
    if (rec.itemType === "功法") rec.function = fn;
  }
  hint.value = `已重掷战斗效果：${fn.name}`;
  persist();
}

/** 为仙品 / 神品法宝生成（或清除）转换型特效。 */
function toggleSpecialEffect(): void {
  const it = currentItem();
  const d = draft.value;
  if (!it || !d) return;
  const rec = it as unknown as Record<string, unknown>;
  if (rec.specialEffect) {
    delete rec.specialEffect;
    hint.value = "已移除转换型特效。";
  } else {
    const se = rollTreasureSpecialEffect(d.grade);
    if (!se) {
      hint.value = "仅仙品 / 神品法宝可拥有转换型特效。";
      return;
    }
    rec.specialEffect = se;
    hint.value = `已生成转换型特效：${se.name}`;
  }
  persist();
}

const hasSpecialEffect = computed(() => {
  const it = currentItem();
  if (!it) return false;
  return !!(it as unknown as Record<string, unknown>).specialEffect;
});

// ── 读写 ────────────────────────────────────────────────────────────────────

function currentItemRef(): ItemRef | null {
  const e = selectedEntry.value;
  if (!e) return null;
  return { zone: e.zone, index: e.index };
}

function currentItem(): InventoryStackItem | null {
  const r = currentItemRef();
  return r ? resolveEntry(r) : null;
}

/**
 * 重算单个角色的派生数值并回写响应式链路。
 *
 * 主角：重算主属性面板。NPC：重算 HP/MP 上限并夹取当前值，再 `setNpc`
 * 触发 Map 变更（NPC 详情面板同步刷新）。
 *
 * @param c 目标角色（主角或 NPC）。
 */
function refreshChar(c: Character): void {
  if (c === protagonist.value) {
    protagonist.value?.refreshDerivedStats();
    return;
  }
  const npc = c as Npc;
  const { maxHp, maxMp } = npc.computeMaxHpMp();
  npc.setMaxHpMp(maxHp, maxMp);
  npcStore.setNpc(npc);
}

function persist(): void {
  const c = owner.value;
  if (!c) return;
  refreshChar(c);
  writeActiveSave();
}

// ── 物品转移 ────────────────────────────────────────────────────────────────

/** 可落入的区域；bag 为储物袋（不足时自动扩容）。 */
const TRANSFER_ZONES = ["bag", "equip", "gongfa"] as const;
type TransferZone = (typeof TRANSFER_ZONES)[number];

function transferZoneLabel(z: TransferZone): string {
  return z === "bag" ? "储物袋" : z === "equip" ? "法宝栏" : "功法栏";
}

/** 接收者在角色列表中的 key；空串表示未选。 */
const transferTargetKey = ref<string>("");
const transferZone = ref<TransferZone>("bag");
/** 勾选后为「复制一份给对方」，原件保留在当前角色名下。 */
const transferKeepOriginal = ref(false);

/** 除当前角色外的全部角色（主角 + NPC）。 */
const transferTargets = computed(() =>
  owners.value.filter((o) => o.key !== selectedOwnerKey.value),
);

/**
 * 当前物品允许落入的区域。
 * 法宝 → 储物袋 / 法宝栏；功法 → 储物袋 / 功法栏；其余（丹药·材料·杂物）→ 仅储物袋。
 */
const allowedZones = computed<readonly TransferZone[]>(() => {
  if (selectedType.value === "法宝") return ["bag", "equip"];
  if (selectedType.value === "功法") return ["bag", "gongfa"];
  return ["bag"];
});

// 切换角色或物品后修正目标与区域，避免残留无效选择
watch(
  () => [selectedOwnerKey.value, allowedZones.value.join(",")] as const,
  () => {
    if (!transferTargets.value.some((o) => o.key === transferTargetKey.value)) {
      transferTargetKey.value = "";
    }
    if (!allowedZones.value.includes(transferZone.value)) transferZone.value = "bag";
  },
  { immediate: true },
);

/** 按 key 解析角色（主角或 NPC）；不存在返回 null。 */
function resolveOwner(key: string): Character | null {
  if (key === PROTAGONIST_KEY) return protagonist.value;
  return npcStore.getNpcById(key) ?? null;
}

/** 找目标角色的第一个空槽；bag 返回 -1（储物袋可自动扩容，无需预检）。 */
function findEmptySlot(c: Character, zone: TransferZone): number {
  if (zone === "equip") return c.equippedSlots.findIndex((s) => s == null);
  if (zone === "gongfa") return c.gongfaSlots.findIndex((s) => s == null);
  return -1;
}

/**
 * 把当前选中物品转移（或复制）给另一个角色。
 *
 * 顺序：目标侧先落位 → 源侧再移除 → 双方重算 → 写盘。
 * 目标侧先行可保证「目标没位置时源物品不受影响」，不会出现物品凭空消失。
 * 物品一律深拷贝，避免两个角色共享同一对象引用。
 */
function doTransfer(): void {
  const src = owner.value;
  const e = selectedEntry.value;
  if (!src || !e || !e.editable) return;

  if (!transferTargetKey.value) {
    hint.value = "请先选择接收者。";
    return;
  }
  const dst = resolveOwner(transferTargetKey.value);
  if (!dst) {
    hint.value = "接收者已不存在，请重新选择。";
    return;
  }
  if (dst === src) {
    hint.value = "不能转给自己。";
    return;
  }

  const zone = transferZone.value;
  const itemName = itemDisplayName(e.item);
  const dstName = owners.value.find((o) => o.key === transferTargetKey.value)?.name ?? "对方";
  const copy = JSON.parse(JSON.stringify(e.item)) as InventoryStackItem;

  // 1) 目标侧落位
  if (zone === "equip") {
    const idx = findEmptySlot(dst, "equip");
    if (idx < 0) {
      hint.value = `${dstName} 的法宝栏已满（${dst.equippedSlots.length} 格），无法接收。`;
      return;
    }
    dst.equippedSlots[idx] = copy as TreasureItemDefinition;
  } else if (zone === "gongfa") {
    const idx = findEmptySlot(dst, "gongfa");
    if (idx < 0) {
      hint.value = `${dstName} 的功法栏已满（${dst.gongfaSlots.length} 格），无法接收。`;
      return;
    }
    dst.gongfaSlots[idx] = copy as GongfaItemDefinition;
  } else {
    const idx = addToInventory(dst, copy);
    if (idx < 0) {
      hint.value = `${dstName} 的储物袋无法扩容。`;
      return;
    }
  }

  // 2) 源侧移除原件（复制模式保留）；储物袋走 setInventorySlot 以触发紧凑整理
  if (!transferKeepOriginal.value) {
    if (e.zone === "bag") setInventorySlot(src, e.index, null);
    else if (e.zone === "equip") src.equippedSlots[e.index] = null;
    else src.gongfaSlots[e.index] = null;
  }

  // 3) 双方重算派生数值并落盘
  refreshChar(dst);
  refreshChar(src);
  writeActiveSave();

  // 索引可能因紧凑整理而失效，清空选中态
  selectedKey.value = null;
  hint.value = transferKeepOriginal.value
    ? `已复制「${itemName}」给 ${dstName}（落入${transferZoneLabel(zone)}）。`
    : `已将「${itemName}」转移给 ${dstName}（落入${transferZoneLabel(zone)}）。`;
}

function onSave(): void {
  const it = currentItem();
  const d = draft.value;
  if (!it || !d) return;
  const rec = it as unknown as Record<string, unknown>;

  rec.name = d.name.trim() || rec.name;
  rec.grade = d.grade;
  rec.tier = d.tier;

  if (rec.itemType === "法宝") {
    rec.function = {
      name: d.modifiers.map((m) => `${TREASURE_MODIFIER_NAMES[m.modifierType]}+${m.value}%`).join(" "),
      modifiers: d.modifiers.map((m) => ({ modifierType: m.modifierType, value: Math.max(0, Math.round(m.value)) })),
    };
    // 非仙品 / 神品不应保留转换型特效
    if (d.grade !== "仙品" && d.grade !== "神品") delete rec.specialEffect;
  } else if (rec.itemType === "功法") {
    rec.bonus = { [d.bonusStat]: Math.max(0, Math.round(d.bonusValue)) };
    rec.system = d.system;
    rec.role = d.role;
  } else if (rec.itemType === "丹药") {
    rec.effectType = d.effectType;
    rec.effects = {
      value: Math.max(1, Math.round(d.elixirValue)),
      isPercent: d.elixirIsPercent,
    };
  }

  persist();
  draft.value = loadDraft(it);
  hint.value = "已保存并立即生效。";
}

function onRevert(): void {
  const it = currentItem();
  if (!it) return;
  draft.value = loadDraft(it);
  hint.value = "已还原为当前生效值。";
}

// ── 展示辅助 ────────────────────────────────────────────────────────────────

const tierHint = computed(() => {
  const d = draft.value;
  if (!d) return "";
  const base = describeTierSuppression(d.tier, realmMajor.value);
  // 功法额外一条：阶层低于持有者境界后，修炼它不再产出修为。
  if (selectedType.value === "功法") {
    const cult = describeGongfaCultivation(d.tier, realmMajor.value);
    return cult ? `${base}；${cult}` : base;
  }
  return base;
});

const elixirTierHint = computed(() => {
  const d = draft.value;
  if (!d || selectedType.value !== "丹药") return "";
  return d.elixirIsPercent ? "（百分比型，不随阶层缩放）" : "（定值型，随阶层缩放）";
});

function entrySummary(e: ItemEntry): string {
  const rec = e.item as unknown as Record<string, unknown>;
  const grade = typeof rec.grade === "string" ? rec.grade : "";
  const tier = typeof rec.tier === "string" ? tierLabel(rec.tier) : "";
  return [grade, tier].filter(Boolean).join(" · ");
}

const zoneLabel = (z: ItemZone): string =>
  z === "equip" ? "已装备法宝" : z === "gongfa" ? "已装备功法" : "储物袋";

const grouped = computed(() => {
  const order: ItemZone[] = ["equip", "gongfa", "bag"];
  return order.map((z) => ({
    zone: z,
    label: zoneLabel(z),
    items: allEntries.value.filter((e) => e.zone === z),
  }));
});

// ── 弹窗生命周期 ────────────────────────────────────────────────────────────

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
  <div v-if="open" class="mj-forge-mask" @click.self="emit('close')">
    <div class="mj-forge" role="dialog" aria-modal="true" aria-label="天道编辑">
      <header class="mj-forge__head">
        <h3 class="mj-forge__title">天道编辑</h3>
        <button type="button" class="mj-forge__close" title="关闭" @click="emit('close')">✕</button>
      </header>

      <p class="mj-forge__lead">
        可改<b>主角或任意 NPC</b> 的品级 / 阶层 / 词条。改动<b>即时生效</b>并写盘（不同于世界设定的回合后应用）。
        勾选「同步重算数值」后，改品阶或阶层会自动刷新数值量级。<br />
        注意：NPC 装备属 AI 的「核心冻结字段」，正常情况下 AI 每回合不会覆写；但若 AI 通过核心变更事件声明了装备变动，仍可能替换。
      </p>

      <div class="mj-forge__body">
        <!-- 左一：角色（主角 + NPC） -->
        <aside class="mj-forge__owners">
          <div class="mj-forge__group-title">角色</div>
          <button
            v-for="o in owners"
            :key="o.key"
            type="button"
            class="mj-forge__item"
            :class="{ 'is-active': o.key === selectedOwnerKey }"
            @click="selectOwner(o.key)"
          >
            <span class="mj-forge__item-name">{{ o.name }}</span>
            <span class="mj-forge__item-meta">{{ o.sub }}</span>
          </button>
          <p v-if="owners.length === 0" class="mj-forge__empty">暂无角色。</p>
        </aside>

        <!-- 左二：物品列表 -->
        <aside class="mj-forge__list">
          <div v-for="g in grouped" :key="g.zone" class="mj-forge__group">
            <div v-if="g.items.length" class="mj-forge__group-title">{{ g.label }}</div>
            <button
              v-for="e in g.items"
              :key="e.key"
              type="button"
              class="mj-forge__item"
              :class="{
                'is-active': e.key === selectedKey,
                'is-disabled': !e.editable,
              }"
              :disabled="!e.editable"
              @click="select(e.key)"
            >
              <span class="mj-forge__item-name">{{ itemDisplayName(e.item) }}</span>
              <span class="mj-forge__item-meta">{{ entrySummary(e) }}</span>
            </button>
          </div>
          <p v-if="allEntries.length === 0" class="mj-forge__empty">当前没有任何物品。</p>
        </aside>

        <!-- 右：编辑区 -->
        <section class="mj-forge__editor">
          <template v-if="draft">
            <div class="mj-forge__row">
              <label class="mj-forge__label">名称</label>
              <input v-model="draft.name" class="mj-forge__input" type="text" />
            </div>

            <div class="mj-forge__row">
              <label class="mj-forge__label">品级</label>
              <div class="mj-forge__chips">
                <button
                  v-for="g in GRADE_ORDER"
                  :key="g"
                  type="button"
                  class="mj-forge__chip"
                  :class="{ 'is-on': draft.grade === g }"
                  @click="draft.grade = g"
                >{{ g }}</button>
              </div>
            </div>

            <div class="mj-forge__row">
              <label class="mj-forge__label">阶层</label>
              <div class="mj-forge__chips">
                <button
                  v-for="t in TIER_ORDER"
                  :key="t"
                  type="button"
                  class="mj-forge__chip"
                  :class="{ 'is-on': draft.tier === t }"
                  @click="draft.tier = t"
                >{{ tierLabel(t) }}</button>
              </div>
              <p v-if="tierHint" class="mj-forge__hintline">{{ tierHint }}</p>
            </div>

            <label class="mj-forge__switch">
              <input v-model="autoRescale" type="checkbox" />
              <span>同步重算数值（改品阶 / 阶层时按新档位刷新数值）</span>
            </label>

            <!-- 法宝词条 -->
            <template v-if="selectedType === '法宝'">
              <div class="mj-forge__sec">
                <div class="mj-forge__sec-head">
                  <span>百分比词条</span>
                  <span class="mj-forge__sec-actions">
                    <button type="button" class="mj-forge__mini" @click="addModifier">+ 添加</button>
                    <button type="button" class="mj-forge__mini" @click="rerollModifiers">重掷</button>
                    <button type="button" class="mj-forge__mini" @click="rescale">按档位重算</button>
                  </span>
                </div>
                <div
                  v-for="(m, i) in draft.modifiers"
                  :key="i"
                  class="mj-forge__mod"
                >
                  <select v-model="m.modifierType" class="mj-forge__select">
                    <option v-for="t in TREASURE_MODIFIER_TYPES" :key="t" :value="t">
                      {{ TREASURE_MODIFIER_NAMES[t] }}
                    </option>
                  </select>
                  <input v-model.number="m.value" class="mj-forge__input mj-forge__input--num" type="number" min="0" />
                  <span class="mj-forge__unit">%</span>
                  <button type="button" class="mj-forge__mini mj-forge__mini--danger" @click="removeModifier(i)">✕</button>
                </div>
                <p v-if="draft.modifiers.length === 0" class="mj-forge__hintline">暂无词条，可点击「+ 添加」。</p>
              </div>

              <div class="mj-forge__sec">
                <div class="mj-forge__sec-head">
                  <span>转换型特效（仙品 / 神品）</span>
                  <button type="button" class="mj-forge__mini" @click="toggleSpecialEffect">
                    {{ hasSpecialEffect ? "移除" : "生成" }}
                  </button>
                </div>
                <p class="mj-forge__hintline">
                  当前：{{ hasSpecialEffect ? "已有" : "无" }}。仅仙品 / 神品法宝可拥有。
                </p>
              </div>
            </template>

            <!-- 功法 -->
            <template v-else-if="selectedType === '功法'">
              <div class="mj-forge__sec">
                <div class="mj-forge__sec-head"><span>主属性加成</span></div>
                <div class="mj-forge__mod">
                  <select v-model="draft.bonusStat" class="mj-forge__select">
                    <option v-for="s in BONUS_STATS" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <input v-model.number="draft.bonusValue" class="mj-forge__input mj-forge__input--num" type="number" min="0" />
                  <button type="button" class="mj-forge__mini" @click="rescale">按档位重算</button>
                </div>
              </div>

              <div class="mj-forge__row">
                <label class="mj-forge__label">体系</label>
                <div class="mj-forge__chips">
                  <button
                    v-for="s in GONGFA_SYSTEM_KEYS"
                    :key="s"
                    type="button"
                    class="mj-forge__chip"
                    :class="{ 'is-on': draft.system === s }"
                    @click="draft.system = s"
                  >{{ s }}</button>
                </div>
              </div>

              <div class="mj-forge__row">
                <label class="mj-forge__label">定位</label>
                <div class="mj-forge__chips">
                  <button
                    v-for="r in GONGFA_ROLES"
                    :key="r"
                    type="button"
                    class="mj-forge__chip"
                    :class="{ 'is-on': draft.role === r }"
                    @click="draft.role = r"
                  >{{ r }}</button>
                </div>
              </div>

              <div class="mj-forge__sec">
                <div class="mj-forge__sec-head">
                  <span>战斗效果</span>
                  <button type="button" class="mj-forge__mini" @click="rerollGongfaFunction">按体系+品阶重掷</button>
                </div>
                <p class="mj-forge__hintline">重掷会整体替换招式名 / 简介 / 效果，熟练度与层数保留。</p>
              </div>
            </template>

            <!-- 丹药 -->
            <template v-else-if="selectedType === '丹药'">
              <div class="mj-forge__row">
                <label class="mj-forge__label">效果类型</label>
                <select v-model="draft.effectType" class="mj-forge__select mj-forge__select--wide">
                  <option v-for="t in VALID_ELIXIR_EFFECT_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
              <div class="mj-forge__row">
                <label class="mj-forge__label">数值</label>
                <input v-model.number="draft.elixirValue" class="mj-forge__input mj-forge__input--num" type="number" min="1" />
                <span class="mj-forge__unit">{{ draft.elixirIsPercent ? "%" : "点" }}</span>
                <button type="button" class="mj-forge__mini" @click="rescale">按档位重算</button>
              </div>
              <p class="mj-forge__hintline">{{ elixirTierHint }}</p>
            </template>

            <p v-else class="mj-forge__hintline">该物品无词条，仅可改品级与阶层。</p>

            <!-- 转移：把当前物品交给另一个角色 -->
            <div class="mj-forge__sec mj-forge__sec--transfer">
              <div class="mj-forge__sec-head">
                <span>转移他人</span>
                <button
                  type="button"
                  class="mj-forge__mini mj-forge__mini--go"
                  :disabled="!transferTargetKey"
                  @click="doTransfer"
                >执行</button>
              </div>

              <template v-if="transferTargets.length">
                <div class="mj-forge__mod">
                  <select v-model="transferTargetKey" class="mj-forge__select mj-forge__select--wide">
                    <option value="">— 选择接收者 —</option>
                    <option v-for="o in transferTargets" :key="o.key" :value="o.key">
                      {{ o.name }}（{{ o.sub }}）
                    </option>
                  </select>
                </div>

                <div class="mj-forge__row">
                  <label class="mj-forge__label">落入区域</label>
                  <div class="mj-forge__chips">
                    <button
                      v-for="z in TRANSFER_ZONES"
                      :key="z"
                      type="button"
                      class="mj-forge__chip"
                      :class="{ 'is-on': transferZone === z }"
                      :disabled="!allowedZones.includes(z)"
                      @click="transferZone = z"
                    >{{ transferZoneLabel(z) }}</button>
                  </div>
                </div>

                <label class="mj-forge__switch">
                  <input v-model="transferKeepOriginal" type="checkbox" />
                  <span>保留原件（复制一份给对方，双方各持一件）</span>
                </label>

                <p class="mj-forge__hintline">
                  物品会深拷贝一份交给对方，双方互不干扰。储物袋不足时自动扩容；
                  法宝栏 / 功法栏已满则拒绝。转移后双方属性立即重算。
                </p>
              </template>
              <p v-else class="mj-forge__hintline">当前没有其他角色可接收。</p>
            </div>
          </template>

          <p v-else class="mj-forge__empty">请选择一件物品。</p>
        </section>
      </div>

      <footer class="mj-forge__foot">
        <span class="mj-forge__hint">{{ hint }}</span>
        <span class="mj-forge__foot-btns">
          <button type="button" class="mj-forge__btn" @click="onRevert">还原</button>
          <button type="button" class="mj-forge__btn mj-forge__btn--primary" @click="onSave">保存（立即生效）</button>
        </span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mj-forge-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.62);
  padding: 20px;
}

.mj-forge {
  width: min(920px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  background: #1b1713;
  color: #f0d9b8;
  border-radius: 6px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
}

.mj-forge__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
}

.mj-forge__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.mj-forge__close {
  background: transparent;
  border: none;
  color: #b9a488;
  font-size: 1rem;
  cursor: pointer;
  padding: 2px 6px;
}
.mj-forge__close:hover {
  color: #f0d9b8;
}

.mj-forge__lead {
  margin: 0;
  padding: 10px 16px;
  font-size: 0.78rem;
  line-height: 1.6;
  color: #b9a488;
  border-bottom: 1px solid rgba(140, 120, 83, 0.25);
}
.mj-forge__lead b {
  color: #e8c5a0;
}

.mj-forge__body {
  display: grid;
  grid-template-columns: 148px 210px 1fr;
  gap: 0;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

/* 左一：角色（主角 + NPC） */
.mj-forge__owners {
  overflow-y: auto;
  padding: 10px;
  border-right: 1px solid rgba(140, 120, 83, 0.25);
  background: rgba(0, 0, 0, 0.34);
}

/* 左二：物品列表 */
.mj-forge__list {
  overflow-y: auto;
  padding: 10px;
  border-right: 1px solid rgba(140, 120, 83, 0.25);
  background: rgba(0, 0, 0, 0.28);
}

.mj-forge__group + .mj-forge__group {
  margin-top: 10px;
}

.mj-forge__group-title {
  font-size: 0.72rem;
  color: #8d7a5f;
  letter-spacing: 0.1em;
  padding: 4px 6px;
}

.mj-forge__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 7px 8px;
  margin-bottom: 3px;
  text-align: left;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid transparent;
  border-radius: 4px;
  color: #d8c4a6;
  cursor: pointer;
  font-size: 0.8rem;
}
.mj-forge__item:hover:not(.is-disabled) {
  border-color: rgba(198, 122, 58, 0.45);
  background: rgba(198, 122, 58, 0.12);
}
.mj-forge__item.is-active {
  border-color: var(--mj-gold, #e8c547);
  background: rgba(232, 197, 71, 0.12);
  color: #f5e3bd;
}
.mj-forge__item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mj-forge__item-meta {
  font-size: 0.68rem;
  color: #8d7a5f;
}

.mj-forge__empty {
  font-size: 0.78rem;
  color: #8d7a5f;
  padding: 12px 4px;
}

/* 右列 */
.mj-forge__editor {
  overflow-y: auto;
  padding: 14px 16px;
}

.mj-forge__row {
  margin-bottom: 12px;
}

.mj-forge__label {
  display: block;
  font-size: 0.72rem;
  color: #8d7a5f;
  letter-spacing: 0.08em;
  margin-bottom: 5px;
}

.mj-forge__input {
  width: 100%;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 4px;
  color: #f0d9b8;
  font-size: 0.82rem;
  font-family: inherit;
}
.mj-forge__input:focus {
  outline: none;
  border-color: var(--mj-gold, #e8c547);
}

.mj-forge__input--num {
  width: 84px;
}

.mj-forge__select {
  padding: 5px 8px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 4px;
  color: #f0d9b8;
  font-size: 0.8rem;
  font-family: inherit;
}
.mj-forge__select--wide {
  width: 100%;
}

.mj-forge__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.mj-forge__chip {
  padding: 4px 10px;
  font-size: 0.76rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  color: #c3ab88;
  cursor: pointer;
  font-family: inherit;
}
.mj-forge__chip:hover {
  border-color: rgba(198, 122, 58, 0.5);
}
.mj-forge__chip.is-on {
  background: rgba(232, 197, 71, 0.16);
  border-color: var(--mj-gold, #e8c547);
  color: #f5e3bd;
}

.mj-forge__switch {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.76rem;
  color: #b9a488;
  margin: 4px 0 14px;
  cursor: pointer;
}

.mj-forge__sec {
  border: 1px solid rgba(140, 120, 83, 0.3);
  border-radius: 4px;
  padding: 10px;
  margin-bottom: 12px;
  background: rgba(0, 0, 0, 0.2);
}

.mj-forge__sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.74rem;
  color: #8d7a5f;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
}

.mj-forge__sec-actions {
  display: flex;
  gap: 5px;
}

.mj-forge__mod {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.mj-forge__unit {
  font-size: 0.76rem;
  color: #8d7a5f;
}

.mj-forge__mini {
  padding: 3px 9px;
  font-size: 0.72rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 3px;
  color: #c3ab88;
  cursor: pointer;
  font-family: inherit;
}
.mj-forge__mini:hover {
  border-color: rgba(198, 122, 58, 0.55);
  color: #f0d9b8;
}
.mj-forge__mini--danger:hover {
  border-color: rgba(200, 80, 60, 0.6);
  color: #e8a08c;
}

/* 转移区块：与其他编辑区分开，避免误点「执行」 */
.mj-forge__sec--transfer {
  border-color: rgba(198, 122, 58, 0.4);
  background: rgba(198, 122, 58, 0.07);
}

.mj-forge__mini--go {
  border-color: rgba(198, 122, 58, 0.55);
  color: #e8c5a0;
}
.mj-forge__mini--go:hover:not(:disabled) {
  background: rgba(198, 122, 58, 0.22);
  border-color: var(--mj-gold, #e8c547);
  color: #f5e3bd;
}

.mj-forge__mini:disabled,
.mj-forge__chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mj-forge__mini:disabled:hover,
.mj-forge__chip:disabled:hover {
  border-color: var(--mj-border, rgba(140, 120, 83, 0.45));
  color: #c3ab88;
}

.mj-forge__hintline {
  margin: 6px 0 0;
  font-size: 0.72rem;
  color: #8d7a5f;
  line-height: 1.6;
}

/* 底栏 */
.mj-forge__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
}

.mj-forge__hint {
  font-size: 0.74rem;
  color: #9fd6a8;
  min-height: 1em;
}

.mj-forge__foot-btns {
  display: flex;
  gap: 8px;
}

.mj-forge__btn {
  padding: 6px 14px;
  font-size: 0.8rem;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--mj-border, rgba(140, 120, 83, 0.45));
  border-radius: 4px;
  color: #d8c4a6;
  cursor: pointer;
  font-family: inherit;
}
.mj-forge__btn:hover {
  border-color: rgba(198, 122, 58, 0.55);
}
.mj-forge__btn--primary {
  background: var(--mj-gold, #e8c547);
  border-color: var(--mj-gold, #e8c547);
  color: #1b1710;
  font-weight: 600;
}
.mj-forge__btn--primary:hover {
  filter: brightness(1.08);
}

@media (max-width: 860px) {
  .mj-forge__body {
    grid-template-columns: 1fr;
  }
  .mj-forge__owners,
  .mj-forge__list {
    max-height: 160px;
    border-right: none;
    border-bottom: 1px solid rgba(140, 120, 83, 0.25);
  }
}
</style>
