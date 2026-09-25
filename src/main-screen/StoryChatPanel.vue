<script setup lang="ts">
import { ref, watch, computed, nextTick, onUnmounted } from "vue";
import type { OpeningStoryPhase } from "../ai/useOpeningStory";
import { useApiConfig } from "../ai/useApiConfig";
import { generateStory, type StoryChatEntry } from "../ai/story_generate";
import {
  generateState,
  findMissingCriticalTags,
  type StateParsed,
  type BattleTriggerEntry,
} from "../ai/state_generate";
import { filterRepeatedOptions, OPTION_DEDUP_MIN_KEEP } from "../role_core/optionDedup";
import { generateCultivationStory } from "../ai/cultivation_story_generate";
import { generateBattleStory } from "../ai/battle_story_generate";
import { generateBattleChoices } from "../ai/battle_choice_generate";
import { generateFinaleStory } from "../ai/finale_story_generate";
import { generateGrandSummary } from "../ai/grand_summary_generate";
import { generateNpcReevaluation } from "../ai/npc_reevaluation_generate";
import { AiOutputTruncatedError } from "../ai/openAiChatBridge";
import type { CultivationInput } from "../ai/cultivation_types";
import { protagonist, Protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import { factionStore, type Faction } from "../role_core/factionStore";
import { chapterStore, type Chapter } from "../role_core/chapterStore";
import { worldMapStore, type WorldMapSerialData } from "../role_core/worldMapStore";
import { storyStore, type StorySerialData, type ChatMessage } from "../role_core/storyStore";
import { writeActiveSave, getActiveDifficulty } from "../save/gameSave";
import { captureAutoTurnSave } from "../save/autoTurnSave";
import type { NpcPlayInfo } from "../role_core/types/playInfo";
import type { InventoryStackItem } from "../role_core/types/itemInfo";
import { Character } from "../role_core/Character";
import { gameLog } from "../log/gameLog";
import {
  advanceWorldTime,
  formatWorldTimeZhDisplay,
  worldTimeYearsBetween,
  calendarYearsElapsed,
  NPC_REEVALUATION_THRESHOLD_YEARS,
  worldTimeToDays,
  type WorldTime,
} from "../role_core/worldTime";
import type { BattleResult } from "../battle_engine/types";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { formatWorldLocationDash, isEmptyWorldLocation, isWorldLocationEqual } from "../role_core/types/worldLocation";
import type { Npc } from "../role_core/Npc";
import { setTurnBusy } from "../role_core/turnLock";
import {
  applySceneReport,
  buildSceneDirective,
  isSceneClosing,
  noteBattleInScene,
  noteSceneTurn,
} from "../role_core/sceneBudgetStore";
import { flushPendingEdits } from "../role_core/pendingEdits";
import { MEMORY_COMPRESS_TARGET, MEMORY_COMPRESS_THRESHOLD } from "../role_core/types/playInfo";
import { autoGeneratePortraits, autoGenerateLocationBackgrounds } from "../image_generate";
import { locationImageStore } from "../role_core/locationImageStore";

const props = withDefaults(
  defineProps<{
    phase?: OpeningStoryPhase;
    errorMessage?: string;
    /** 开局状态（功法 / 物品 / NPC / 地点）生成失败：需显示 warning + 重试按钮。 */
    initStateFailed?: boolean;
    /** 「重新生成初始状态」是否正在跑。 */
    retryingInitState?: boolean;
    currentWorldLocation?: WorldLocation | null;
    worldTime?: WorldTime;
    battleResult?: BattleResult | null;
    cultivationInput?: CultivationInput | null;
  }>(),
  {
    phase: "idle",
    errorMessage: "",
    initStateFailed: false,
    retryingInitState: false,
    currentWorldLocation: null,
    worldTime: undefined,
    battleResult: undefined,
    cultivationInput: null,
  },
);

const { apiUrl, apiKey, apiModel } = useApiConfig();

const emit = defineEmits<{
  "update:worldLocation": [value: WorldLocation | null];
  "update:worldTime": [value: WorldTime];
  "battleTrigger": [value: BattleTriggerEntry];
  "consumeBattleResult": [];
  "consumeCultivation": [];
  "generatingChange": [value: boolean];
  "gameOver": [reason: string];
  /** 玩家点了「重新生成初始状态」。 */
  "retryInitState": [];
}>();

const chatMessages = storyStore.chatMessages;
const grandSummary = storyStore.grandSummary;
const grandSummaryUpTo = storyStore.grandSummaryUpTo;
const gameOverReason = storyStore.gameOverReason;

const chatBgUrl = computed(() => {
  const loc = storyStore.worldLocation.value;
  if (!loc) return null;
  return locationImageStore.get(loc)?.avatarUrl ?? null;
});
const inputText = ref("");
const generating = ref(false);
const generatingPhase = ref<"story" | "state" | "summary">("story");
const genError = ref("");
/**
 * 状态 AI 失败提示。
 *
 * 【2026-09-25】此前状态更新失败**不显示在界面上**——只在控制台写一行日志，
 * 玩家看到的只是「剧情出来了但没有推进选项」，既不知道失败也没有补救入口
 * （实测一份存档里玩家原样重发了 3 遍相同内容）。现在独立成一条提示。
 */
const stateError = ref("");
/** 当前显示的推进选项（来自状态 AI，协议格式数组）。null 时隐藏按钮区。 */
const actionOptions = storyStore.actionOptions;

function beginGenerating(): void {
  generating.value = true;
  generatingPhase.value = "story";
  genError.value = "";
  stateError.value = "";
}
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const pendingBattleTrigger = ref<BattleTriggerEntry | null>(null);
const battlePending = computed(() => pendingBattleTrigger.value !== null);
/**
 * 战后等待玩家表态的战况（非 null = 战斗已结束、正在等玩家点处置建议或自己写一句）。
 * 为 null 时走常规对话链路。
 */
const pendingBattleResult = ref<BattleResult | null>(null);

function autoResizeTextarea(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

/** 点击快捷选项：填入输入框（玩家可编辑后手动发送），并触发 textarea 自适应高度。 */
/**
 * 点击推进选项：把选项正文填入输入框。
 *
 * 采用**追加**而非覆盖——玩家可能想把两条选项拼成一段完整的行动描述，
 * 覆盖写法会让先点的那一条凭空消失。已包含相同文本时不再重复追加（连点同一条无副作用）。
 */
function useActionOption(text: string): void {
  const t = text.trim();
  if (!t) return;
  const cur = inputText.value.trim();
  if (cur === t) {
    nextTick(() => autoResizeTextarea());
    return;
  }
  // 已追加过同一条 → 不再重复（避免连点堆出多份）。
  if (cur && cur.includes(t)) {
    nextTick(() => autoResizeTextarea());
    return;
  }
  inputText.value = cur ? `${cur}\n${t}` : t;
  nextTick(() => {
    autoResizeTextarea();
    textareaRef.value?.focus();
  });
}

let abortCtl: AbortController | null = null;

function buildChatHistory(): StoryChatEntry[] {
  const msgs = chatMessages.value;
  const upTo = grandSummaryUpTo.value;
  const grand = grandSummary.value;

  let latestStoryIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "story") {
      latestStoryIdx = i;
      break;
    }
  }

  // summary 消息永远在 index 0（物理裁剪后置顶），只扫前几条即可判断是否已裁剪。
  let hasSummaryMsg = false;
  for (let i = 0; i < Math.min(msgs.length, 3); i++) {
    if (msgs[i].type === "summary") {
      hasSummaryMsg = true;
      break;
    }
  }

  const entries: StoryChatEntry[] = [];

  // index < upTo 的消息已被大总结覆盖，跳过；从 upTo 起纳入近期历史。
  // 注：物理裁剪后 upTo 通常归零，summary 消息作为首条纳入，替代旧版的合成前缀。
  for (let idx = Math.max(0, upTo); idx < msgs.length; idx++) {
    const m = msgs[idx];
    // notice 是给玩家看的本地提示（如"本回合状态回报不完整"），绝不喂给 AI：
    // 否则模型会把它当成玩家的发言或剧情的一部分。
    if (m.type === "notice") continue;
    if (m.type === "summary") {
      entries.push({ role: "assistant", content: `【剧情总纲·截至早期】\n${m.content.trim()}` });
      continue;
    }
    const isStory = m.type === "story";
    const isLatest = isStory && idx === latestStoryIdx;
    const useSnapshot = isStory && !isLatest && m.snapshot;
    entries.push({
      role: isStory ? ("assistant" as const) : ("user" as const),
      content: useSnapshot ? m.snapshot! : m.content,
    });
  }

  // 兼容旧存档：grandSummary 已生成但尚未物理裁剪时（chatMessages 中无 summary 消息），
  // 沿用旧版合成前缀，避免 AI 在第一次裁剪触发前丢失早期记忆。
  // 一旦物理裁剪发生（summary 消息进入 chatMessages），此兜底自动失效。
  if (!hasSummaryMsg && grand.trim()) {
    entries.unshift({ role: "assistant", content: `【剧情总纲·截至早期】\n${grand.trim()}` });
  }

  return entries;
}

/** 滚动大总结：待总结区达阈值时，把旧快照压缩进约 1000 字总纲。 */
const GRAND_SUMMARY_THRESHOLD = 30;
const GRAND_SUMMARY_KEEP_RECENT = 30;

async function maybeGenerateGrandSummary(
  url: string,
  model: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const msgs = chatMessages.value;
  const storyIndices: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].type === "story") storyIndices.push(i);
  }
  // story 总数不足「保留窗口 + 触发阈值」时无需总结。
  if (storyIndices.length <= GRAND_SUMMARY_KEEP_RECENT + GRAND_SUMMARY_THRESHOLD) return;

  const upTo = grandSummaryUpTo.value;
  // 最近 KEEP_RECENT 条 story 的起始索引：其之前、尚未被总结的 story 构成待总结区。
  const recentStartIdx = storyIndices[storyIndices.length - GRAND_SUMMARY_KEEP_RECENT];

  const toSummarize: string[] = [];
  for (const idx of storyIndices) {
    if (idx < upTo || idx >= recentStartIdx) continue;
    const m = msgs[idx];
    const snap = (m.snapshot && m.snapshot.trim()) || m.content.trim();
    if (snap) toSummarize.push(snap);
  }
  if (toSummarize.length < GRAND_SUMMARY_THRESHOLD) return;

  generatingPhase.value = "summary";
  try {
    const result = await generateGrandSummary({
      apiUrl: url,
      apiKey,
      model,
      oldGrandSummary: grandSummary.value,
      snapshots: toSummarize,
      protagonistGender: protagonist.value?.gender,
      signal,
    });
    if (signal.aborted) return;
    const summary = result.grandSummary.trim();
    if (summary) {
      // 先用旧引用切片，再整体替换数组。newMsgs 构造完才赋值，避免引用失效。
      const kept = msgs.slice(recentStartIdx);
      const newMsgs: ChatMessage[] = [
        { type: "summary", content: summary },
        ...kept,
      ];
      chatMessages.value = newMsgs;
      grandSummary.value = summary;
      grandSummaryUpTo.value = 0;
      gameLog.info(`[StoryChat] 滚动大总结已更新并裁剪历史（压缩 ${toSummarize.length} 条快照，保留近期 ${kept.length} 条消息）。`);
    }
  } catch (e) {
    gameLog.error("[StoryChat] 大总结生成失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

type RoundKind = "chat" | "battle" | "cultivation";

interface RoundContext {
  kind: RoundKind;
  userContent: string;
  cultivationInput?: CultivationInput;
  /** 战斗回合的战况（供「战后战斗描写」专用链路使用）。 */
  battleResult?: BattleResult | null;
  /** 玩家在战后的处置表态（点选的建议或自写的一句话）。 */
  playerChoice?: string;
}

/** 一轮「生成前」的完整状态快照，用于重试时回退该轮的全部副作用。 */
/**
 * 一轮「生成前」的状态快照，用于重试时回退该轮的副作用。
 *
 * 设计：重新生成只影响「剧情 + 储物袋 + NPC + 世界地图」，**不触碰**主角的
 * HP/MP/属性/装备/功法/丹药/修为/境界（这些是角色成长结果，不应因换剧情而回退）。
 * 因此只快照 inventorySlots（深拷贝），不快照整个 protagonist。
 */
interface PreGenSnapshot {
  inventorySlots: Array<InventoryStackItem | null>;
  npcs: NpcPlayInfo[];
  factions: Faction[];
  chapter: Chapter | null;
  worldMap: WorldMapSerialData;
  story: StorySerialData;
  pendingBattleTrigger: BattleTriggerEntry | null;
  userContent: string;
}

/** 上一轮生成开始前的状态快照，供重试回退使用。null 表示当前无可重试的轮次。 */
let lastPreGenSnapshot: PreGenSnapshot | null = null;
/** 是否存在可重试的轮次（响应式，供模板控制重试按钮显隐）。 */
const hasRetryable = ref(false);

/** 捕获生成前的状态快照（在任何修改之前调用）。返回 null 表示主角未就绪。 */
function capturePreGenSnapshot(ctx: RoundContext): PreGenSnapshot | null {
  const p = protagonist.value;
  if (!p) return null;
  return {
    inventorySlots: p.inventorySlots.map(s => s ? JSON.parse(JSON.stringify(s)) as InventoryStackItem : null),
    npcs: npcStore.serializeNpcs(),
    factions: factionStore.serializeFactions(),
    chapter: chapterStore.serializeChapter(),
    worldMap: worldMapStore.serializeWorldMap(),
    story: storyStore.serializeStory(),
    pendingBattleTrigger: pendingBattleTrigger.value,
    userContent: ctx.userContent,
  };
}

/**
 * 从上一轮快照回退：只还原剧情、储物袋、NPC、世界地图，不触碰主角数值。
 *
 * 主角的 HP/MP/属性/装备(equippedSlots)/功法(gongfaSlots)/丹药(elixirBonuses)/修为/境界
 * 保持当前值不变。因此「上一轮新获得且已穿戴的法宝 / 已入槽的功法 / 已使用的丹药」
 * 不会被强制脱下或扣回——其加成保留，仅储物袋恢复到生成前内容。
 */
function restorePreGenSnapshot(): void {
  const snap = lastPreGenSnapshot;
  if (!snap) return;
  const p = protagonist.value;
  if (p) {
    p.inventorySlots = snap.inventorySlots.map(s => s ? JSON.parse(JSON.stringify(s)) as InventoryStackItem : null);
    Protagonist.notifyChanged();
  }
  npcStore.restoreNpcs(snap.npcs);
  factionStore.restoreFactions(snap.factions ?? []);
  // 篇章回合数也要回退：重试等于这一轮没发生过。
  chapterStore.restoreChapter(snap.chapter ?? null);
  worldMapStore.restoreWorldMap(snap.worldMap);
  storyStore.applyStorySnapshot(snap.story);
  pendingBattleTrigger.value = snap.pendingBattleTrigger;
}

watch(generating, (val) => {
  emit("generatingChange", val);
});

/**
 * 回合锁：AI 生成中或开局剧情生成中 → 玩家的画像/世界设定改动进入待应用队列。
 * 生成结束（含开局 ready / error / ended）后解锁并立即 flush 队列。
 */
watch(
  [generating, () => props.phase],
  ([g, ph], prev) => {
    const next = g || ph === "loading";
    const wasBusy = prev ? prev[0] || prev[1] === "loading" : false;
    setTurnBusy(next);
    // 回合（含开局生成）刚结束：此刻 AI 已写完状态，玩家的待应用改动落地。
    if (wasBusy && !next) flushPendingEdits();
  },
  { immediate: true },
);

// 组件卸载（返回标题等）时务必解锁，避免残留的回合锁永久禁用画像编辑。
onUnmounted(() => {
  setTurnBusy(false);
});

/**
 * 主角进入新地点时：唤醒该地点 dormant NPC，并对长期未见的（≥ NPC_REEVALUATION_THRESHOLD_YEARS）
 * 批量触发 AI 核心层重评估。低频、批量、整体性更新，是「严格事件驱动」的受控例外。
 */
async function handleLocationEnter(
  newLocation: WorldLocation,
  worldTime: WorldTime,
  linggen: string[],
): Promise<void> {
  // wake 前先收集 dormant 列表（此时 lastSeen 仍是旧值，用于算 gap）。
  const dormantHere = npcStore.getDormantNpcsAt(newLocation);
  if (dormantHere.length === 0) return;

  // 计算每个 dormant NPC 的间隔年数，筛出需重评估者。
  const reevaluationBatch: Array<{ npc: Npc; gap: number }> = [];
  let maxGap = 0;
  for (const npc of dormantHere) {
    const gap = worldTimeYearsBetween(npc.lastSeenWorldTime, worldTime);
    if (gap >= NPC_REEVALUATION_THRESHOLD_YEARS) {
      reevaluationBatch.push({ npc, gap });
      if (gap > maxGap) maxGap = gap;
    }
  }

  // 唤醒（更新 presence + lastSeen=now）。
  npcStore.wakeDormantAtLocation(newLocation, worldTime);

  if (reevaluationBatch.length === 0) return;

  const url = String(apiUrl.value || "").trim();
  const model = String(apiModel.value || "").trim();
  if (!url || !model) return;

  const p = protagonist.value;
  try {
    gameLog.info(`[StoryChat] 重评估 ${reevaluationBatch.length} 名长期未见的 NPC（间隔约 ${maxGap.toFixed(1)} 年）…`);
    const results = await generateNpcReevaluation({
      apiUrl: url,
      apiKey: String(apiKey.value || "").trim() || undefined,
      model,
      yearsElapsed: maxGap,
      currentWorldTime: worldTime,
      protagonistRealm: p ? { major: p.realm.major, minor: p.realm.minor } : { major: "练气", minor: "初期" },
      npcs: reevaluationBatch.map(b => b.npc),
      signal: undefined,
    });
    npcStore.applyReevaluation(results, linggen);
  } catch (e) {
    gameLog.error("[StoryChat] NPC 重评估失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

async function applyStateResult(stateResult: StateParsed, linggen: string[]): Promise<{ gameOverReason?: string }> {
  let gameOverReason: string | undefined;
  const oldLocation = props.currentWorldLocation ?? null;
  const newLocation = stateResult.worldLocation && !isEmptyWorldLocation(stateResult.worldLocation)
    ? stateResult.worldLocation
    : oldLocation;
  const locationChanged = !isWorldLocationEqual(oldLocation, newLocation);

  // ① 快照旧地点 active 集合（在 markDormant 之前），用于后续判定跨地点跟随的合法性。
  const oldActiveSet = locationChanged && oldLocation
    ? new Set(npcStore.getActiveNpcsAt(oldLocation))
    : new Set<Npc>();

  // ② 地点切换：旧地点 active NPC 转入休眠。
  try {
    if (locationChanged && oldLocation) {
      npcStore.markDormantAtLocation(oldLocation);
    }
  } catch (e) {
    gameLog.error("[StoryChat] 地点休眠失败：" + (e instanceof Error ? e.message : String(e)));
  }

  try {
    if (newLocation && !isWorldLocationEqual(newLocation, oldLocation)) {
      emit("update:worldLocation", newLocation);
    }
  } catch (e) {
    gameLog.error("[StoryChat] 地点更新失败：" + (e instanceof Error ? e.message : String(e)));
  }

  // ③ 主角状态应用 + 时间推进 + 寿元检测（各步独立容错）。
  const current = protagonist.value;
  let newWorldTime: WorldTime | undefined = props.worldTime;
  if (current) {
    try {
      current.applyStateChanges(stateResult);
    } catch (e) {
      gameLog.error("[StoryChat] 主角状态更新失败：" + (e instanceof Error ? e.message : String(e)));
    }

    // 主角记忆（AI 维护的日志）：只写 memory，性格与外貌不由 AI 管。
    try {
      const mem = stateResult.protagonistMemory;
      if (mem && (mem.full || mem.entries.length > 0)) {
        current.appendAiMemoryEntries(mem.entries, mem.full);
        Protagonist.notifyChanged();
      }
    } catch (e) {
      gameLog.error("[StoryChat] 主角记忆更新失败：" + (e instanceof Error ? e.message : String(e)));
    }

    try {
      if (stateResult.timeAdvance && props.worldTime) {
        const delta = stateResult.timeAdvance;
        newWorldTime = advanceWorldTime(props.worldTime, delta);
        emit("update:worldTime", newWorldTime);

        // 世界时间推进后清理到期的持久状态（如「气血亏虚」三十天满即自动痊愈）。
        // 这是 buff 的常规到期通道；战斗结算另有一条（battleSettle）。
        if (current.pruneBuffs(newWorldTime) > 0) {
          // buff 影响血上限，剔除后要重算，否则上限一直停在打折值。
          current.refreshDerivedStats();
          gameLog.info("[StoryChat] 有状态到期，已自动清除。");
        }

        // 寿元耗尽检查：当前年龄 = 开局档案年龄 + 自基线起经过的整年数。
        if (getActiveDifficulty() !== "简单" && newWorldTime) {
          const currentAge = current.age + calendarYearsElapsed(storyStore.worldTimeBaseline.value, newWorldTime);
          if (currentAge >= current.shouyuan) {
            gameLog.warn(`[StoryChat] 寿元耗尽！currentAge=${currentAge}, shouyuan=${current.shouyuan}`);
            gameOverReason = "寿元耗尽，坐化于世";
          }
        }
      }
    } catch (e) {
      gameLog.error("[StoryChat] 时间推进失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ④ 地点切换：唤醒新地点 dormant NPC，并对长期未见的批量重评估。
  try {
    if (locationChanged && newLocation && newWorldTime) {
      await handleLocationEnter(newLocation, newWorldTime, linggen);
    }
  } catch (e) {
    gameLog.error("[StoryChat] 地点进入处理失败：" + (e instanceof Error ? e.message : String(e)));
  }

  // ⑤ nearbyNpcs 一致性校正 + 跨地点迁移合法性过滤 + NPC 更新。
  try {
    let nearbyNpcsToApply = stateResult.nearbyNpcs;
    if (nearbyNpcsToApply.length > 0) {
      nearbyNpcsToApply = nearbyNpcsToApply.map(entry => {
        if (newLocation && (!entry.currentLocation || !isWorldLocationEqual(entry.currentLocation, newLocation))) {
          if (entry.currentLocation) {
            gameLog.warn(`[StoryChat] NPC「${entry.displayName}」的 currentLocation 与主角地点不符，已强制校正`);
          }
          return { ...entry, currentLocation: { ...newLocation } };
        }
        return entry;
      });

      if (locationChanged && oldLocation) {
        nearbyNpcsToApply = nearbyNpcsToApply.filter(entry => {
          const existing = entry.npcId
            ? npcStore.getNpcById(entry.npcId)
            : (entry.displayName ? npcStore.getNpc(entry.displayName) : undefined);
          // 新 NPC 或无位置信息：保留
          if (!existing || !existing.currentLocation) return true;
          // 上一回合在旧地点 active：合法跟随主角迁移
          if (oldActiveSet.has(existing)) return true;
          // 上一回合就在新地点（被唤醒的 dormant 或本就在场）：保留
          if (isWorldLocationEqual(existing.currentLocation, newLocation)) return true;
          // 上一回合在第三地 dormant：不可能瞬间跨地点，剔除并告警
          gameLog.warn(`[StoryChat] 地点切换兜底：剔除 NPC「${existing.displayName}」误入新地点 nearbyNpcs（上一回合在 ${formatWorldLocationDash(existing.currentLocation)}，不可能瞬间跨地点）`);
          return false;
        });
      }
    }

    if (nearbyNpcsToApply.length > 0 || stateResult.npcCoreChanges.length > 0) {
      const createdNpcs = npcStore.applyNpcUpdates(nearbyNpcsToApply, linggen, {
        coreChangeEvents: stateResult.npcCoreChanges,
        currentLocation: newLocation,
        currentWorldTime: newWorldTime ?? null,
      });
      autoGeneratePortraits(createdNpcs);
    }
  } catch (e) {
    gameLog.error("[StoryChat] NPC 更新失败：" + (e instanceof Error ? e.message : String(e)));
  }

  // ⑤-2 势力变更事件（状态 AI 第 15 段 <MJ_FACTION_TAG>）。
  // update 指向未登记的势力时 applyFactionChange 返回 false —— 宁可漏更新，
  // 也不凭空造一个玩家没探知过的势力。
  try {
    for (const change of stateResult.factionChanges) {
      if (!factionStore.applyFactionChange(change)) {
        gameLog.warn(
          `[StoryChat] 势力变更被丢弃：op=${change.op} name=${change.name}（update 时该势力尚未登记）`,
        );
      }
    }
  } catch (e) {
    gameLog.error("[StoryChat] 势力更新失败：" + (e instanceof Error ? e.message : String(e)));
  }

  // ⑥ 登记新地点到世界地图。
  try {
    if (stateResult.worldLocation && !isEmptyWorldLocation(stateResult.worldLocation)) {
      worldMapStore.addLocation(stateResult.worldLocation);
      autoGenerateLocationBackgrounds(
        [stateResult.worldLocation],
        protagonist.value?.realm?.major,
      );
    }
  } catch (e) {
    gameLog.error("[StoryChat] 世界地图更新失败：" + (e instanceof Error ? e.message : String(e)));
  }

  // ⑦ 战斗触发校验。
  try {
    if (stateResult.battleTrigger) {
      const missing = findMissingBattleCombatants(stateResult.battleTrigger);
      if (missing.length > 0) {
        gameLog.warn(`[StoryChat] 战斗触发校验失败：${missing.join("、")} 未在 npcStore 中找到或已死亡，本次不触发战斗`);
      } else {
        pendingBattleTrigger.value = stateResult.battleTrigger;
      }
    }
  } catch (e) {
    gameLog.error("[StoryChat] 战斗触发处理失败：" + (e instanceof Error ? e.message : String(e)));
  }

  // 防复读硬兜底：提示词只是"请"模型别重复，这里再拦一道——
  // 与最近 3 轮给过的选项撞了 ≥8 字公共子串的候选直接丢掉（保底留 2 条）。
  const recentTexts = storyStore.recentOptionTexts();
  const dedup = filterRepeatedOptions(stateResult.actionOptions ?? [], recentTexts);
  if (dedup.dropped.length > 0) {
    gameLog.info(`[推进] 过滤掉 ${dedup.dropped.length} 条与上轮重复的选项：` + dedup.dropped.join(" / "));
  }
  if (dedup.kept.length < (stateResult.actionOptions?.length ?? 0) && dedup.kept.length <= OPTION_DEDUP_MIN_KEEP) {
    gameLog.warn("[推进] 去重后选项不足，已按重合程度回补。");
  }
  const finalOptions = dedup.kept.length > 0 ? dedup.kept : stateResult.actionOptions;

  actionOptions.value = finalOptions;
  // 记录本轮推进轴与选项正文，供下轮做跨回合轮换 / 防复读（各保留最近 3 轮）。
  storyStore.noteBranchAxes(finalOptions);
  storyStore.noteActionOptions(finalOptions);
  // 主线进度回报：AI 自报本回合是否与主线有关，供剧情 AI 回注（§G 闭环）。
  storyStore.noteMainlineReport(stateResult.mainlineReport);
  return { gameOverReason };
}

function enterBattle(): void {
  const entry = pendingBattleTrigger.value;
  if (!entry) return;
  pendingBattleTrigger.value = null;
  emit("battleTrigger", entry);
}

/**
 * 场景被强制清零时，程序代写一段转场。
 *
 * 为什么需要：收束锁撑满宽限回合后 `noteSceneTurn` 会直接把场景进度清零防死锁，
 * 但玩家侧看到的是「打得好好的，场景限制突然没了」——没有任何交代，
 * 下一回合 AI 也不知道该往哪儿接。这里补一句旁白 + 推进一天，让断点是连续的。
 *
 * **不主动改地点**：世界地点留给下一回合状态 AI 自然输出。程序越权改地点
 * 会和 AI 的 `mj_world_body` 打架（两边各写一个，玩家看到瞬移）。
 *
 * @param sceneName 清零前的场景名（秘境 / 擂台名，可能为空）。
 * @param locationName 清零前的地点锚点串（可能为空）。
 */
async function writeSceneForceClearTransition(sceneName: string, locationName: string): Promise<void> {
  const where = sceneName || locationName || "此地";
  const text = `【转场】在${where}的机缘已尽。你收拾行装，离开了${where}。`;
  chatMessages.value.push({ type: "story", content: text });
  gameLog.info(`[场景配额] 收束锁超时强制清零，已代写转场（${where}）。`);

  try {
    if (props.worldTime) {
      const next = advanceWorldTime(props.worldTime, { days: 1 });
      emit("update:worldTime", next);
      // 推进一天后照常清理到期状态（与常规时间推进同一条通道）。
      const p = protagonist.value;
      if (p && p.pruneBuffs(next) > 0) {
        p.refreshDerivedStats();
        gameLog.info("[StoryChat] 转场推进时间后，有持久状态到期已清除。");
      }
    }
  } catch (e) {
    gameLog.error("[StoryChat] 转场推进世界时间失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

/**
 * 校验战斗触发条目：除主角外，所有参战者必须在 npcStore 中存在且未死亡。
 * 优先按 npcId 校验（精确），未带 id（旧存档/AI 未输出）时按 displayName 兜底。
 * 返回缺失（未找到或已死亡）的参战者标识列表；空数组表示全部就绪。
 */
function findMissingBattleCombatants(trigger: BattleTriggerEntry): string[] {
  const missing: string[] = [];
  const protagonistName = protagonist.value?.displayName;
  const isReady = (c: { npcId?: string; displayName: string }): boolean => {
    const npc = c.npcId ? npcStore.getNpcById(c.npcId) : undefined;
    const found = npc ?? npcStore.getNpc(c.displayName);
    return !!found && !found.isDead;
  };
  for (const ally of trigger.allies) {
    if (ally.roleHint === "主角") continue;
    if (protagonistName && ally.displayName === protagonistName) continue;
    if (!isReady(ally)) missing.push(ally.displayName);
  }
  for (const enemy of trigger.enemies) {
    if (!isReady(enemy)) missing.push(enemy.displayName);
  }
  return missing;
}

async function handleSend(): Promise<void> {
  const msg = inputText.value.trim();
  if (!msg || generating.value) return;

  const p = protagonist.value;
  if (!p) {
    genError.value = "主角数据未就绪，无法生成剧情。";
    return;
  }

  const url = String(apiUrl.value || "").trim();
  const model = String(apiModel.value || "").trim();
  if (!url || !model) {
    genError.value = "未配置 API URL 或模型。";
    return;
  }

  // 校验通过后才清空输入框（校验失败时保留文本供玩家修正）。
  inputText.value = "";
  if (textareaRef.value) textareaRef.value.style.height = "auto";

  // 战后处置待表态：玩家这句话就是处置意见，带上战况一起生成战后剧情。
  const pending = pendingBattleResult.value;
  if (pending) {
    pendingBattleResult.value = null;
    await runStoryGenerationRound({
      kind: "battle",
      userContent: msg,
      battleResult: pending,
      playerChoice: msg,
    });
    return;
  }

  await runStoryGenerationRound({ kind: "chat", userContent: msg });
}

/**
 * 通用生成管道：push 用户消息 → 生成剧情 → push 剧情消息 → 生成状态 → 应用状态 → 落盘。
 *
 * 三个入口共用此函数：
 * - handleSend（普通对话）：kind="chat"，用 generateStory。
 * - 战斗结果回写：kind="battle"，用 generateBattleStory（战后战斗描写，需 battleResult）。
 * - 修炼回写：kind="cultivation"，用 generateCultivationStory（需要 cultivationInput）。
 *
 * 在 push 用户消息之前捕获完整快照到 `lastPreGenSnapshot`，供重试回退使用。
 */
async function runStoryGenerationRound(ctx: RoundContext): Promise<void> {
  const p = protagonist.value;
  if (!p) {
    genError.value = "主角数据未就绪，无法生成剧情。";
    return;
  }

  const url = String(apiUrl.value || "").trim();
  const model = String(apiModel.value || "").trim();
  if (!url || !model) {
    genError.value = "未配置 API URL 或模型。";
    return;
  }

  // 在任何修改之前捕获快照，供后续重试回退。
  const snapshot = capturePreGenSnapshot(ctx);
  if (snapshot) lastPreGenSnapshot = snapshot;

  // 回合自动存档：此刻状态 = 上一回合结束态，另存为快照（滚动保留最近 N 个回合）。
  // 必须在 push 用户消息之前——否则存的就是「本回合开始后」的状态，回滚点会错位。
  captureAutoTurnSave();

  actionOptions.value = null;
  chatMessages.value.push({ type: "user", content: ctx.userContent });
  beginGenerating();

  const chatHistory: StoryChatEntry[] = buildChatHistory();
  const npcSnapshot = buildNpcSnapshot();

  const ac = new AbortController();
  abortCtl = ac;

  // 场景配额硬约束：按「上一回合结束时」的场景进度算出，注入剧情 AI 与状态 AI。
  // 未进入分层场景或尚未触顶时为空串，不会额外占用提示词。
  const sceneDirective = buildSceneDirective();

  try {
    // 阶段 1：生成剧情正文（修炼走 generateCultivationStory，其余走 generateStory）。
    let storyBody: string;
    if (ctx.kind === "battle" && ctx.battleResult) {
      // 战后：由专用链路把战况"描写"成一段交手剧情，而不是复述胜/败结论。
      const battleResult = await generateBattleStory({
        apiUrl: url,
        apiKey: String(apiKey.value || "").trim() || undefined,
        model,
        battleResult: ctx.battleResult,
        playerChoice: ctx.playerChoice,
        protagonist: p,
        npcSnapshot: buildSceneNpcSnapshot() || undefined,
        chatHistory,
        signal: ac.signal,
      });
      storyBody = battleResult.storyBody;
    } else if (ctx.kind === "cultivation" && ctx.cultivationInput) {
      const ci = ctx.cultivationInput;
      const cultResult = await generateCultivationStory({
        apiUrl: url,
        apiKey: String(apiKey.value || "").trim() || undefined,
        model,
        gongfaName: ci.gongfaName,
        gongfaGrade: ci.gongfaGrade,
        gongfaSystem: ci.gongfaSystem,
        currentMastery: ci.currentMastery,
        currentMasteryExp: ci.currentMasteryExp,
        masteryThreshold: ci.masteryThreshold,
        maxLayer: ci.maxLayer,
        spiritStoneCount: ci.spiritStoneCount,
        estimatedMonths: ci.estimatedMonths,
        protagonist: p,
        currentWorldLocation: props.currentWorldLocation ?? undefined,
        npcSnapshot: npcSnapshot || undefined,
        chatHistory,
        signal: ac.signal,
      });
      storyBody = cultResult.storyBody;
    } else {
      const storyResult = await generateStory({
        apiUrl: url,
        apiKey: String(apiKey.value || "").trim() || undefined,
        model,
        protagonist: p,
        chatHistory,
        sceneNpcSnapshot: buildSceneNpcSnapshot() || undefined,
        currentWorldLocation: props.currentWorldLocation ? formatWorldLocationDash(props.currentWorldLocation) : undefined,
        currentWorldTime: props.worldTime,
        sceneDirective,
        signal: ac.signal,
      });
      storyBody = storyResult.storyBody;
    }

    if (abortCtl !== ac) return;

    if (!storyBody.trim()) {
      genError.value = "模型返回的剧情正文为空。";
      return;
    }

    chatMessages.value.push({ type: "story", content: storyBody.trim() });

    try {
      generatingPhase.value = "state";
      const stateInput = {
        apiUrl: url,
        apiKey: String(apiKey.value || "").trim() || undefined,
        model,
        storyBody,
        protagonist: p,
        currentWorldLocation: props.currentWorldLocation ?? undefined,
        currentWorldTime: props.worldTime,
        npcSnapshot: npcSnapshot || undefined,
        recentBranchAxes: storyStore.recentBranchAxes(),
        // 最近 3 轮（最多 12 条）给过的选项正文：玩家没选的等于拒绝了，别再端上来。
        recentOptionTexts: storyStore.recentOptionTexts(),
        sceneDirective,
        signal: ac.signal,
      };
      const stateResult: StateParsed = await callStateAI(stateInput, ac);

      if (abortCtl !== ac) return;

      // 缺失标签可见化：状态 AI 少写了关键段（多半是输出被截断）时程序不会报错，
      // 玩家只会隐约觉得"这回合好像什么都没记"。写 gameLog 供排查，
      // 并在剧情栏给一条灰色提示——至少让玩家知道刚才那回合没记全。
      {
        const missing = findMissingCriticalTags(stateResult);
        if (missing.length > 0) {
          gameLog.warn("[状态AI] 本回合缺失标签：" + missing.join("、"));
          // 时间推进本就可能合法为空（原地对话/不动的回合），只记日志不打扰玩家。
          const worthTelling = missing.filter(m => m !== "时间推进");
          if (worthTelling.length > 0) {
            chatMessages.value.push({
              type: "notice",
              content: `本回合状态回报不完整（缺：${worthTelling.join("、")}），已自动兜底，不影响继续。`,
            });
          }
        }
      }

      // 兜底：既没有推进选项也没有战斗触发 = 玩家这一回合无路可走。
      // 常见成因是模型漏写/提前收笔，末尾两段标签没出来——带一句点名要求重试一次，
      // 重试结果**只取选项与战斗触发**，状态不重复应用（避免修为、物品、时间被算两遍）。
      if (!stateResult.actionOptions && !stateResult.battleTrigger) {
        gameLog.warn("[推进] 本回合既无推进选项也无战斗触发，点名重试一次。");
        const retryHint =
          `${sceneDirective ? sceneDirective + "\n" : ""}` +
          "【补充·最重要】你上一条输出漏了收尾标签：本条必须完整输出第 16 段（满足战斗触发条件时）" +
          "与第 17 段（4 条并列推进选项），不得留空、不得因为前面内容长而提前收笔。";
        try {
          const retry = await generateState({ ...stateInput, sceneDirective: retryHint });
          if (abortCtl !== ac) return;
          if (retry.actionOptions) stateResult.actionOptions = retry.actionOptions;
          if (!stateResult.battleTrigger && retry.battleTrigger) {
            stateResult.battleTrigger = retry.battleTrigger;
          }
          if (!stateResult.actionOptions && !stateResult.battleTrigger) {
            gameLog.warn("[推进] 重试后仍无选项与战斗触发，本回合将不显示推进选项。");
          }
        } catch (retryErr) {
          gameLog.error(
            "[推进] 点名重试失败：" + (retryErr instanceof Error ? retryErr.message : String(retryErr)),
          );
        }
      }

      // 合并本回合 AI 报的场景进度（秘境层 / 擂台轮），供下一轮算配额。
      applySceneReport(stateResult.sceneReport);

      // 硬闸：场景已进收束锁时，直接吃掉战斗触发——不是求 AI 别打，是让它打不起来。
      if (isSceneClosing() && stateResult.battleTrigger) {
        gameLog.info(
          `[场景配额] 收束锁生效，本回合的战斗触发已被拦截（${stateResult.battleTrigger.triggerReason || "无原因"}）`,
        );
        stateResult.battleTrigger = null;
      }

      const { gameOverReason } = await applyStateResult(stateResult, p.linggen);

      // 本场景又过了一回合：这是层/轮推进与收束判定的真正来源（不依赖 AI 报数）。
      // 非战斗回合按 0.5 计——配额要拦的是「刷无成本的回合赖在秘境里」，
      // 战斗回合自带战损与消耗，同价计费等于凭空砍掉一半可玩回合。
      const sceneTurn = noteSceneTurn(stateResult.battleTrigger ? 1 : 0.5);
      if (sceneTurn.forceCleared) {
        // 收束锁撑满宽限回合 → 程序强制清零。此时玩家视角若没有任何交代，
        // 就是「打得好好的，场景限制突然没了」。补一段转场旁白 + 推进一天。
        await writeSceneForceClearTransition(sceneTurn.sceneName, sceneTurn.locationName);
      }
      // 篇章回合数 +1（同样不依赖 AI 报数；无篇章时内部直接返回）。
      chapterStore.noteChapterTurn();

      if (stateResult.storySnapshot.trim()) {
        const last = chatMessages.value[chatMessages.value.length - 1];
        if (last && last.type === "story") {
          last.snapshot = stateResult.storySnapshot.trim();
        }
      }

      // 滚动大总结：当待总结区达阈值时同步压缩旧快照（失败不影响本轮）。
      await maybeGenerateGrandSummary(url, model, String(apiKey.value || "").trim() || undefined, ac.signal);

      if (gameOverReason) {
        // 寿元耗尽：生成走马灯结局叙事（不走状态 AI），然后触发 game over。
        await generateAndAppendFinale(gameOverReason);
      } else {
        writeActiveSave();
      }
    } catch (stateErr) {
      if (ac.signal.aborted) return;
      const raw = stateErr instanceof Error ? stateErr.message : String(stateErr);
      gameLog.error("[StoryChat] 状态更新失败：" + raw);
      // 失败要说人话：告诉玩家「什么没落地」以及「能怎么办」，
      // 而不是让他对着"没出现选项"自己猜（这正是此前反复重发同一句话的原因）。
      stateError.value =
        stateErr instanceof AiOutputTruncatedError
          ? "本回合状态未更新：模型输出被长度上限截断（血量 / 物品 / 时间 / 推进选项都没落地）。" +
            "可在「API设置」换用输出上限更高的模型或渠道，然后重试本回合。"
          : `本回合状态未更新，剧情已生成但血量 / 物品 / 时间 / 推进选项可能没落地。原因：${raw}`;
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    genError.value = e instanceof Error ? e.message : String(e);
    gameLog.error("[StoryChat] " + genError.value);
  } finally {
    if (abortCtl === ac) abortCtl = null;
    // 回合收尾：此刻状态 AI 已写完，玩家的待应用改动最后落地，确保压过本回合 AI 的输出。
    flushPendingEdits();
    generating.value = false;
    hasRetryable.value = lastPreGenSnapshot !== null;
  }
}

/**
 * 状态 AI 调用（**带一次自动重试**）。
 *
 * 【2026-09-25】原先这里是裸调 `generateState`，异常直接落到外层的静默 catch：
 * 不重试、不提示，玩家只能靠「没出现选项」自己猜，于是原样重发（存档实证：连续 3 条
 * 相同输入）。现在对**可重试的失败**（输出被截断、网络抖动、上游 5xx）自动重试一次，
 * 仍失败才把原因抛给上层显示。
 *
 * 截断时重试必须带「精简输出」的要求——同样的输入、同样的输出量，
 * 不提示的话第二次几乎必然再截断。
 */
async function callStateAI(
  base: Parameters<typeof generateState>[0],
  ac: AbortController,
): Promise<StateParsed> {
  let input = base;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await generateState(input);
      stateError.value = "";
      return r;
    } catch (e) {
      lastErr = e;
      if (ac.signal.aborted) throw e;
      const truncated = e instanceof AiOutputTruncatedError;
      const msg = e instanceof Error ? e.message : String(e);
      gameLog.warn(
        `[状态AI] 第 ${attempt}/2 次调用失败${truncated ? "（输出被截断）" : ""}：${msg}`,
      );
      if (attempt === 1 && truncated) {
        input = {
          ...base,
          sceneDirective:
            (base.sceneDirective ?? "") +
            "\n【补充·最重要】上一条回复因输出长度上限被截断，末尾标签已丢失。本条请**大幅精简**：" +
            "各段只留必要信息、压缩叙事性描写，务必完整输出第 16 段（满足条件时）、" +
            "第 17 段（4 条推进选项）与第 15 段（剧情快照）。",
        };
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 生成走马灯结局叙事并追加到剧情栏，然后触发游戏结束（emit gameOver）。
 * 走马灯回顾主角一生，不走状态 AI（主角已死，无状态需更新）。
 * 无论生成成功与否都会 emit gameOver——主角已死，游戏必须结束。
 */
async function generateAndAppendFinale(reason: string, sceneContext?: string): Promise<void> {
  const p = protagonist.value;
  if (!p) {
    emit("gameOver", reason);
    return;
  }
  const url = String(apiUrl.value || "").trim();
  const model = String(apiModel.value || "").trim();
  if (!url || !model) {
    emit("gameOver", reason);
    return;
  }

  generatingPhase.value = "story";
  const chatHistory: StoryChatEntry[] = buildChatHistory();
  const npcSnapshot = buildNpcSnapshot();

  try {
    const result = await generateFinaleStory({
      apiUrl: url,
      apiKey: String(apiKey.value || "").trim() || undefined,
      model,
      protagonist: p,
      chatHistory,
      deathReason: reason,
      sceneContext,
      npcSnapshot: npcSnapshot || undefined,
    });
    if (result.storyBody.trim()) {
      chatMessages.value.push({ type: "story", content: result.storyBody.trim() });
    }
  } catch (e) {
    gameLog.error("[StoryChat] 走马灯生成失败：" + (e instanceof Error ? e.message : String(e)));
  }

  writeActiveSave();
  emit("gameOver", reason);
}

/**
 * 重试最近一轮：回退上一轮的剧情/储物袋/NPC/世界地图副作用，并把上次的用户消息
 * 填回输入框，供玩家编辑后手动重新发送（统一走普通对话管道）。
 */
function retryLastMessage(): void {
  if (generating.value) return;
  const snap = lastPreGenSnapshot;
  if (!snap) return;

  restorePreGenSnapshot();
  inputText.value = snap.userContent;
  if (textareaRef.value) textareaRef.value.style.height = "auto";
  nextTick(() => autoResizeTextarea());
  lastPreGenSnapshot = null;
  hasRetryable.value = false;
}

/**
 * 最近一条可重试的「用户消息」在 chatMessages 中的索引；-1 表示当前不可重试
 * （无快照 / 生成中 / phase 非 ready / 无用户消息）。
 */
const retryableUserIdx = computed(() => {
  if (!hasRetryable.value || generating.value || props.phase !== "ready") return -1;
  const msgs = chatMessages.value;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "user") return i;
  }
  return -1;
});

/**
 * 构建发给 AI 的 NPC 上下文快照（三段式精简注入）。
 *
 * - 【当前场景在场】主角所在地点的 active NPC，完整状态（境界/HP/MP/好感/npcId）。
 *   npcId 必须给出，AI 才能在 nearbyNpcs 和核心变更事件里正确引用。
 * - 【本地点休眠】归属本地点但当前不在场的 dormant NPC，简表（用于让 AI 知道这些人
 *   仍在该地点，可在剧情里自然提及）。
 * - 【重要羁绊】高好感或 boss 级 NPC，无论身在何方，简表（老熟人线索）。
 *
 * 已故 NPC 不再出现。token 开销相比「全表灌入」大幅下降，也杜绝了 AI 因看到无关
 * NPC 而误改其数据。
 */
/**
 * 把 NPC 的画像提示词（性格 / 记忆）拼成快照后缀。
 *
 * 玩家已手动锁定画像时追加 [画像已锁定]，提示状态 AI 不要再输出该 NPC 的 profile。
 */
function formatNpcProfileSuffix(npc: Npc): string {
  const prof = npc.profile;
  if (!prof) return "";
  const parts: string[] = [];
  if (prof.personality.trim()) parts.push(`性格[${prof.personality.trim()}]`);
  const mem = prof.memory.trim();
  if (mem) {
    // 附上字数：状态 AI 据此判断是否触发「超 1000 字压缩到 700 字」。
    // 记忆是三行一条的日志（新的在最上面），压缩 = 提炼压短旧条目，不是整条删掉。
    const needCompress = mem.length > MEMORY_COMPRESS_THRESHOLD;
    parts.push(
      `记忆(${mem.length}字${needCompress ? `·超${MEMORY_COMPRESS_THRESHOLD}字，需把旧条目提炼压缩至约${MEMORY_COMPRESS_TARGET}字（保留事实、压短文字，不是删条目）` : ""})[${mem}]`,
    );
  }
  const locked = prof.source === "manual" ? " [画像已锁定·勿改]" : "";
  if (parts.length === 0) return locked;
  return "，" + parts.join("，") + locked;
}

function formatNpcFullLine(npc: Npc): string {
  const favor = npc.favorability;
  const hp = `${npc.currentHp}/${npc.maxHp}`;
  const mp = `${npc.currentMp}/${npc.maxMp}`;
  const dead = npc.isDead ? " [已故]" : "";
  const cur = npc.currentLocation ? formatWorldLocationDash(npc.currentLocation) : "未知";
  const race = npc.race && npc.race !== "修仙者" ? `，${npc.race}` : "";
  const profileSuffix = formatNpcProfileSuffix(npc);
  return `${npc.displayName}（npcId:${npc.id}，${npc.identity}${race}，${Character.formatRealm(npc.realm)}，当前:${cur}，好感${favor}，HP ${hp}，MP ${mp}${profileSuffix}）${dead}`;
}

function formatNpcBriefLine(npc: Npc): string {
  const lastSeen = npc.lastSeenWorldTime ? formatWorldTimeZhDisplay(npc.lastSeenWorldTime) : "未知";
  const cur = npc.currentLocation ? formatWorldLocationDash(npc.currentLocation) : "未知";
  return `${npc.displayName}（npcId:${npc.id}，${npc.identity}，${Character.formatRealm(npc.realm)}，当前:${cur}，好感${npc.favorability}，上次见面:${lastSeen}）`;
}

/**
 * NPC 快照的体量配额。
 *
 * 为什么要限：快照是**每回合**都要塞进状态 AI 的一大段文本，而休眠者与羁绊者
 * 会随游戏时长无上限地攒——回一趟老巢可能几十行，广结善缘玩法下羁绊段同样膨胀。
 * 体量一大，输出更容易撞到上限被截断，末尾的推进选项先死（见 §B/§A 的截断事故）。
 * 这几个数字是可调的旋钮，觉得 AI 记不住人可以往上调，觉得输出太长就往下调。
 */
/** 本地点休眠 NPC 最多列几名全行（其余折叠成一行计数）。 */
const NPC_SNAPSHOT_DORMANT_CAP = 8;
/** 折叠行里最多再罗列几个名字。 */
const NPC_SNAPSHOT_DORMANT_NAMES = 12;
/** 重要羁绊 NPC 最多列几名（按好感绝对值降序）。 */
const NPC_SNAPSHOT_BONDED_CAP = 6;
/** 快照超过多少字就在日志里警告（提示该清理旧 NPC / 调小配额）。 */
const NPC_SNAPSHOT_WARN_CHARS = 4000;

function buildNpcSnapshot(): string {
  const loc = props.currentWorldLocation ?? null;
  const activeNpcs = loc ? npcStore.getActiveNpcsAt(loc) : [];
  const dormantAll = loc ? npcStore.getDormantNpcsAt(loc) : [];
  const activeSet = new Set<Npc>(activeNpcs);
  const dormantSet = new Set<Npc>(dormantAll);
  const bondedAll = npcStore.getBondedNpcs().filter(n =>
    !activeSet.has(n) && !dormantSet.has(n) && n.presence !== "dead",
  );

  // 休眠段：按「上次见面时间」从近到远排序，只留最近见过的 CAP 名，
  // 其余折叠成一行（避免老巢回一趟几十行把快照撑爆）。
  const dormantSorted = dormantAll.slice().sort((a, b) => {
    const ta = a.lastSeenWorldTime ? worldTimeToDays(a.lastSeenWorldTime) : -1;
    const tb = b.lastSeenWorldTime ? worldTimeToDays(b.lastSeenWorldTime) : -1;
    return tb - ta;
  });
  const dormantNpcs = dormantSorted.slice(0, NPC_SNAPSHOT_DORMANT_CAP);
  const dormantOverflow = dormantSorted.slice(NPC_SNAPSHOT_DORMANT_CAP);
  // 羁绊段：按好感绝对值降序，只留最要紧的 CAP 名。
  const bondedNpcs = bondedAll
    .slice()
    .sort((a, b) => Math.abs(b.favorability) - Math.abs(a.favorability))
    .slice(0, NPC_SNAPSHOT_BONDED_CAP);
  const bondedOverflow = bondedNpcs.length < bondedAll.length ? bondedAll.length - bondedNpcs.length : 0;

  const sections: string[] = [];

  if (activeNpcs.length > 0) {
    sections.push("【当前场景在场NPC】\n" + activeNpcs.map(formatNpcFullLine).join("\n"));
  }
  if (dormantNpcs.length > 0) {
    const lines = dormantNpcs.map(formatNpcBriefLine);
    if (dormantOverflow.length > 0) {
      const names = dormantOverflow.slice(0, NPC_SNAPSHOT_DORMANT_NAMES).map(n => n.displayName);
      const more = dormantOverflow.length > NPC_SNAPSHOT_DORMANT_NAMES ? "等" : "";
      lines.push(
        `（另有 ${dormantOverflow.length} 名休眠者从略：${names.join("、")}${more}）`,
      );
    }
    sections.push("【本地点休眠NPC（曾在此地见过，当前不在场）】\n" + lines.join("\n"));
  }
  if (bondedNpcs.length > 0) {
    const lines = bondedNpcs.map(formatNpcBriefLine);
    if (bondedOverflow > 0) lines.push(`（另有 ${bondedOverflow} 名羁绊 NPC 从略）`);
    sections.push("【重要羁绊NPC（高好感或boss级，可能身在别处）】\n" + lines.join("\n"));
  }

  const text = sections.join("\n\n");
  if (text.length > NPC_SNAPSHOT_WARN_CHARS) {
    gameLog.warn(`[NPC快照] 本回合快照 ${text.length} 字，偏大，可考虑清理旧 NPC 或调小配额。`);
  }
  return text;
}

/**
 * 仅当前场景在场 NPC 的快照（给剧情 AI，让它描写与场景 NPC 行为一致）。
 * 比三段式更精简——剧情 AI 只需关心在场者，不需要休眠/羁绊 NPC。
 */
function buildSceneNpcSnapshot(): string {
  const loc = props.currentWorldLocation ?? null;
  const activeNpcs = loc ? npcStore.getActiveNpcsAt(loc) : [];
  return activeNpcs.map(formatNpcFullLine).join("\n");
}

function onInputKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function formatBattleResultMessage(r: BattleResult): string {
  const outcomeMap: Record<string, string> = {
    victory: "胜",
    defeat: "败",
    fled: "撤退",
  };
  const outcomeText = outcomeMap[r.outcome];
  const enemyText = r.enemyNames.join("、");

  const parts: string[] = [];
  parts.push(`与${enemyText}的战斗结束，${outcomeText}。`);

  if (r.enemiesKilled.length > 0) {
    parts.push(`${r.enemiesKilled.join("、")}已被击杀。`);
  }

  if (r.protagonistDied) {
    parts.push("主角不幸陨落，魂归天地。");
  }

  return parts.join("");
}

/**
 * 战后用户气泡：只陈述**战况事实**，不写胜负结论——
 * 胜负由随后的「战斗描写」剧情自然呈现（见 battle_story_preset）。
 */
function formatBattleRecordMessage(r: BattleResult): string {
  const kind = r.lethality === "spar" ? "切磋" : "死斗";
  return `【战罢】与${r.enemyNames.join("、")}的一场${kind}，交手 ${r.actionCount} 回合。`;
}

function formatCultivationMessage(input: CultivationInput): string {
  const years = Math.floor(input.estimatedMonths / 12);
  const months = input.estimatedMonths % 12;
  const timeParts: string[] = [];
  if (years > 0) timeParts.push(`${years}年`);
  if (months > 0) timeParts.push(`${months}个月`);
  const timeStr = timeParts.join("") || "数日";

  return `取出${input.spiritStoneCount}枚灵石，开始闭关修炼${input.gongfaName}，预计需要${timeStr}。`;
}

watch(
  () => props.cultivationInput,
  async (input) => {
    if (!input) return;
    emit("consumeCultivation");
    await runStoryGenerationRound({
      kind: "cultivation",
      userContent: formatCultivationMessage(input),
      cultivationInput: input,
    });
  },
);

watch(
  () => props.battleResult,
  async (result) => {
    if (!result) return;
    emit("consumeBattleResult");
    // 本场景已发生一场战斗：程序侧独立计数并按地点归并，AI 不报数也能拦住刷波。
    noteBattleInScene(
      props.currentWorldLocation ? formatWorldLocationDash(props.currentWorldLocation) : "",
    );
    if (result.protagonistDied) {
      // 战败身亡：先展示战斗结算气泡（与非死亡战斗一致），再生成走马灯结局叙事，完成后触发 game over。
      chatMessages.value.push({ type: "user", content: formatBattleResultMessage(result) });
      beginGenerating();
      try {
        await generateAndAppendFinale("战败身亡，魂归天地", formatBattleResultMessage(result));
      } finally {
        generating.value = false;
        hasRetryable.value = false;
      }
      return;
    }

    // 战后先给处置建议、等玩家表态（点选或自己写一句），再据此描写战斗收场；
    // 生成失败（无选项）则直接输出，不卡住玩家。
    pendingBattleResult.value = result;
    beginGenerating();
    let choices = null;
    const pNow = protagonist.value;
    try {
      if (pNow) {
        choices = await generateBattleChoices({
          apiUrl: String(apiUrl.value || "").trim(),
          apiKey: String(apiKey.value || "").trim() || undefined,
          model: String(apiModel.value || "").trim(),
          battleResult: result,
          protagonist: pNow,
          chatHistory: buildChatHistory(),
        });
      }
    } catch {
      choices = null;
    }

    if (choices) {
      actionOptions.value = choices;
      generating.value = false;
      return;
    }

    // 没有选项 → 直接输出战后描写（等玩家未表态，倒地者生死留白）。
    pendingBattleResult.value = null;
    await runStoryGenerationRound({
      kind: "battle",
      userContent: formatBattleRecordMessage(result),
      battleResult: result,
    });
  },
);
</script>

<template>
  <section class="main-panel main-panel--story" aria-label="剧情对话">
    <header class="main-panel__head">
      <h2 class="main-panel__title">剧情</h2>
      <div v-if="currentWorldLocation" class="main-panel__location-breadcrumb">
        <span v-if="currentWorldLocation.region" class="mj-breadcrumb-seg">{{ currentWorldLocation.region }}</span>
        <template v-if="currentWorldLocation.country">
          <span class="mj-breadcrumb-sep">›</span>
          <span class="mj-breadcrumb-seg">{{ currentWorldLocation.country }}</span>
        </template>
        <template v-if="currentWorldLocation.area">
          <span class="mj-breadcrumb-sep">›</span>
          <span class="mj-breadcrumb-seg">{{ currentWorldLocation.area }}</span>
        </template>
        <template v-if="currentWorldLocation.detail">
          <span class="mj-breadcrumb-sep">›</span>
          <span class="mj-breadcrumb-seg mj-breadcrumb-seg--detail">{{ currentWorldLocation.detail }}</span>
        </template>
      </div>
    </header>
    <div class="main-panel__body">
      <div
        class="main-panel__chat-messages"
        :class="{ 'main-panel__chat-messages--has-bg': chatBgUrl }"
        :style="chatBgUrl ? { backgroundImage: `linear-gradient(rgba(10, 16, 12, 0.82), rgba(10, 16, 12, 0.82)), url(${chatBgUrl})` } : {}"
        aria-label="剧情正文区域"
        aria-live="polite"
      >
        <p v-if="phase === 'loading' && chatMessages.length === 0" class="main-panel__story-status main-panel__story-status--loading">
          正在生成开局剧情…
        </p>
        <p
          v-else-if="phase === 'error' && chatMessages.length === 0"
          class="main-panel__story-status main-panel__story-status--error"
        >
          {{ errorMessage || "开局剧情生成失败。" }}
        </p>
        <p
          v-else-if="phase === 'idle' && chatMessages.length === 0"
          class="main-panel__placeholder"
        >
          完成命运抉择并进入主界面后，开局剧情将显示于此。
        </p>
        <!-- 开局状态失败：正文出来了但功法 / 物品 / NPC / 地点没落地，必须让玩家看见 -->
        <div v-if="initStateFailed && phase === 'ready'" class="main-panel__init-state-warning">
          <span>初始状态生成失败（功法 / 物品 / NPC 可能缺失）。</span>
          <button
            type="button"
            class="main-panel__init-state-btn"
            :disabled="retryingInitState"
            @click="emit('retryInitState')"
          >{{ retryingInitState ? "生成中…" : "重新生成初始状态" }}</button>
        </div>
        <template v-else>
          <div
            v-for="(msg, idx) in chatMessages"
            :key="idx"
            :class="['main-panel__chat-item', `main-panel__chat-item--${msg.type}`]"
          >
            <template v-if="msg.type === 'summary'">
              <div class="main-panel__chat-bubble main-panel__chat-bubble--summary">
                <div class="main-panel__summary-title">【剧情总纲·早期经历】</div>
                <div class="main-panel__story-prose">{{ msg.content }}</div>
              </div>
            </template>
            <template v-else-if="msg.type === 'story'">
              <div class="main-panel__chat-bubble main-panel__chat-bubble--story">
                <div class="main-panel__story-prose">{{ msg.content }}</div>
              </div>
            </template>
            <template v-else-if="msg.type === 'notice'">
              <div class="main-panel__chat-bubble main-panel__chat-bubble--notice">
                {{ msg.content }}
              </div>
            </template>
            <template v-else>
              <button
                v-if="idx === retryableUserIdx"
                type="button"
                class="main-panel__retry-btn"
                title="重新生成本轮剧情与状态"
                @click="retryLastMessage"
              >
                <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
              </button>
              <div class="main-panel__chat-bubble main-panel__chat-bubble--user">
                {{ msg.content }}
              </div>
            </template>
          </div>
        </template>
      </div>
      <div class="main-panel__composer-area">
        <div v-if="generating || (phase === 'loading' && chatMessages.length > 0)" class="main-panel__composer-status main-panel__composer-status--loading">
          <span class="main-panel__status-pulse"></span>
          {{ phase === 'loading' && chatMessages.length > 0 ? 'AI 正在更新开局状态…' : (generatingPhase === 'state' ? 'AI 正在更新状态…' : (generatingPhase === 'summary' ? 'AI 正在整理过往经历…' : 'AI 正在生成剧情…')) }}
        </div>
        <div v-else-if="genError" class="main-panel__composer-status main-panel__composer-status--error">
          <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>{{ genError }}
        </div>
        <div v-else-if="stateError" class="main-panel__composer-status main-panel__composer-status--error">
          <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>{{ stateError }}
        </div>
        <div v-if="battlePending" class="main-panel__battle-entry main-panel__battle-entry--inline">
          <button type="button" class="main-panel__battle-entry-btn" @click="enterBattle">
            <i class="fa-solid fa-swords" aria-hidden="true"></i>
            进入战斗
          </button>
        </div>
        <div v-else-if="phase === 'ended'" class="main-panel__gameover-banner">
          <i class="fa-solid fa-skull" aria-hidden="true"></i>
          <span>游戏结束 · {{ gameOverReason }}</span>
        </div>
        <div v-else class="main-panel__composer">
          <!-- 战后处置：提示玩家点选处置建议，或自己写一句 -->
          <p v-if="pendingBattleResult" class="main-panel__postbattle-hint">
            战斗结束 · 选择如何处置下方敌人（也可直接在输入框写下你的做法，如「饶你一命，快滚吧」）
          </p>
          <div
            v-if="actionOptions && phase === 'ready'"
            class="main-panel__action-options"
            aria-label="快捷行动选项"
          >
            <button
              v-for="(opt, i) in actionOptions"
              :key="i"
              type="button"
              class="action-option"
              @click="useActionOption(opt.text)"
              :title="opt.text"
            >
              <span class="action-option__text">{{ opt.text }}</span>
            </button>
          </div>
          <textarea
            ref="textareaRef"
            class="main-panel__input"
            :readonly="generating"
            :disabled="phase !== 'ready'"
            placeholder="输入你的行动…"
            aria-label="消息输入"
            v-model="inputText"
            @input="autoResizeTextarea"
            @keydown="onInputKeydown"
            rows="1"
          />
          <button
            type="button"
            class="main-screen__btn"
            :disabled="generating || phase !== 'ready' || !inputText.trim()"
            @click="handleSend"
          >
            {{ generating ? "生成中…" : "发送" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
