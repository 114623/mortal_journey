/**
 * @fileoverview 剧情/对话状态模块单例。
 *
 * 把原本散落在 `useOpeningStory`（开局）与 `StoryChatPanel`（每轮对话）的组件级 ref
 * 提升为模块级单例，对齐 `npcStore` / `worldMapStore` 模式，使存档系统可统一序列化：
 *
 *   存档 = Protagonist.toData() + npcStore.serializeNpcs()
 *        + worldMapStore.serializeWorldMap() + storyStore.serializeStory()
 *
 * `useOpeningStory` 写入本 store；`MainScreen` / `StoryChatPanel` 读取本 store。
 */

import { ref } from "vue";
import type { OpeningStoryPhase } from "../ai/useOpeningStory";
import type { ActionSuggestions } from "../ai/state_generate";
import { normalizeActionSuggestions } from "../ai/state_generate";
import type { WorldLocation } from "./types/worldLocation";
import type { WorldTime } from "./worldTime";
import { cloneWorldTime, createDefaultWorldTime } from "./worldTime";

/** 单条聊天消息。story 消息可携带 AI 生成的快照（compact summary），用于后续上下文。
 *  summary 类型用于滚动大总结裁剪历史后，作为聊天栏顶部的「早期经历总纲」占位消息，
 *  替代已被物理删除的旧 story 消息。
 *  notice 类型是**纯本地提示**（如「本回合状态回报不完整」），只给玩家看，
 *  不进 AI 上下文——所以凡是拼 chatHistory 的地方都要把它滤掉。 */
export interface ChatMessage {
  type: "story" | "user" | "summary" | "notice";
  content: string;
  snapshot?: string;
}

/** 一条主线进度回报（状态 AI 每回合自报，最多留 10 条）。 */
export interface MainlineTrailEntry {
  /** 第几回合（1 起）。 */
  round: number;
  /** 本回合是否与主线有关。 */
  advanced: boolean;
  /** advanced 为真时的一句说明；假时为空串。 */
  note: string;
}

/** 可序列化的剧情快照（存档载荷的 story 分量）。 */
export interface StorySerialData {
  storyBody: string;
  /** 存档恢复后恒为 "ready"；保存时原样记录。 */
  phase: OpeningStoryPhase;
  worldTime: WorldTime;
  worldTimeBaseline: WorldTime;
  worldLocation: WorldLocation | null;
  initSnapshot: string;
  /** 推进选项（协议格式数组；旧存档为四倾向对象，读档时归一化）。 */
  actionOptions: ActionSuggestions | null;
  chatMessages: ChatMessage[];
  /** 最近 3 轮出现过的推进轴（每轮一个数组），用于跨回合轮换提示。 */
  branchAxisRounds?: string[][];
  /** 最近 3 轮给出的推进选项正文（每轮一个数组），用于跨回合防复读。旧存档无此字段。 */
  optionTextRounds?: string[][];
  /** 最近若干回合的主线进度回报（最多 10 条），用于回注剧情 AI。旧存档无此字段。 */
  mainlineTrail?: MainlineTrailEntry[];
  /** 滚动大总结（约 1000 字剧情总纲），替代已被压缩的旧轮快照。空串表示无大总结。 */
  grandSummary: string;
  /** 大总结覆盖到的 chatMessages 索引（不含）；index < 此值的 story 已被吃进大总结。 */
  grandSummaryUpTo: number;
}

const storyBody = ref("");
const phase = ref<OpeningStoryPhase>("idle");
const worldTime = ref<WorldTime>(createDefaultWorldTime());
const worldTimeBaseline = ref<WorldTime>(cloneWorldTime(worldTime.value));
const worldLocation = ref<WorldLocation | null>(null);
const initSnapshot = ref("");
const actionOptions = ref<ActionSuggestions | null>(null);
const chatMessages = ref<ChatMessage[]>([]);
/** 最近若干轮出现过的推进轴（每轮一组，最多保留 3 轮），供状态 AI 做跨回合轮换。 */
const branchAxisRounds = ref<string[][]>([]);
/** 最近 3 轮给出的推进选项正文（每轮一组），供状态 AI 做跨回合防复读。 */
const optionTextRounds = ref<string[][]>([]);
/** 最近若干回合的主线进度回报（最多 10 条），供剧情 AI 回注主线近况。 */
const mainlineTrail = ref<MainlineTrailEntry[]>([]);
/** 滚动大总结（约 1000 字剧情总纲）。空串表示尚无大总结。 */
const grandSummary = ref("");
/** 大总结覆盖到的 chatMessages 索引（不含）；index < 此值的 story 已被吃进大总结。 */
const grandSummaryUpTo = ref(0);
/** 游戏结束原因（战败/寿尽），仅在 phase==="ended" 时展示用；不持久化，进入 ended 状态时实时写入。 */
const gameOverReason = ref("");

/**
 * 读档会话标志：true 表示当前 MainScreen 是从存档恢复挂载的，
 * `useOpeningStory` 据此跳过「清空主角/剧情」与「重跑开局 AI」。
 * 仅会话内有效，不持久化。
 */
const restored = ref(false);

/** 重置全部剧情/对话状态到初始值（开新档、读档前清场用）。 */
function clearStory(): void {
  storyBody.value = "";
  phase.value = "idle";
  const w = createDefaultWorldTime();
  worldTime.value = w;
  worldTimeBaseline.value = cloneWorldTime(w);
  worldLocation.value = null;
  initSnapshot.value = "";
  actionOptions.value = null;
  chatMessages.value = [];
  branchAxisRounds.value = [];
  optionTextRounds.value = [];
  mainlineTrail.value = [];
    grandSummary.value = "";
    grandSummaryUpTo.value = 0;
    gameOverReason.value = "";
    restored.value = false;
}

/**
 * 记录本轮推进选项用到的推进轴（保留最近 3 轮），供状态 AI 做跨回合轮换。
 * 空轴（"未分类"）不记，避免污染轮换提示。
 */
function noteBranchAxes(items: ActionSuggestions | null): void {
  if (!items || items.length === 0) return;
  const axes = Array.from(new Set(
    items.map(i => (i.axis || "").trim()).filter(a => a && a !== "未分类"),
  ));
  if (axes.length === 0) return;
  const next = branchAxisRounds.value.concat([axes]);
  branchAxisRounds.value = next.slice(-3);
}

/** 最近 3 轮出现过的推进轴（扁平去重，供 prompt 注入）。 */
function recentBranchAxes(): string[] {
  return Array.from(new Set(branchAxisRounds.value.flat().map(a => a.trim()).filter(Boolean)));
}

/**
 * 记录本轮给出的推进选项正文（保留最近 3 轮），供状态 AI 做跨回合防复读。
 *
 * 只记正文：选项的元信息（轴 / 类型）由 `noteBranchAxes` 那边负责，
 * 这里关心的是「这句话是不是已经说过了」。
 */
function noteActionOptions(items: ActionSuggestions | null): void {
  if (!items || items.length === 0) return;
  const texts = items.map(i => (i.text || "").trim()).filter(Boolean);
  if (texts.length === 0) return;
  optionTextRounds.value = optionTextRounds.value.concat([texts]).slice(-3);
}

/** 最近 3 轮给出的推进选项正文（扁平，最多 12 条，供 prompt 注入）。 */
function recentOptionTexts(): string[] {
  return optionTextRounds.value.flat().map(t => t.trim()).filter(Boolean);
}

/** 回合序号（1 起）：主线进度记录用，等于已走过的回合数。 */
function currentRound(): number {
  return chatMessages.value.filter(m => m.type === "user").length;
}

/**
 * 记录本回合的主线进度回报（最多留 10 条）。
 *
 * 传 null（AI 没输出该标签）时不记——避免把「缺失」当成「未推进」塞进 trail，
 * 那样连续几回合的 ❌ 会误导剧情 AI 以为主线真的停滞了。
 */
function noteMainlineReport(report: { advanced: boolean; note: string } | null): void {
  if (!report) return;
  const entry: MainlineTrailEntry = {
    round: Math.max(1, currentRound()),
    advanced: report.advanced === true,
    note: String(report.note || "").trim().slice(0, 60),
  };
  mainlineTrail.value = mainlineTrail.value.concat([entry]).slice(-10);
}

/** 最近的主线进度回报（最多 10 条，供 prompt 注入）。 */
function recentMainlineTrail(): MainlineTrailEntry[] {
  return mainlineTrail.value.slice();
}

/** 序列化当前剧情状态为纯 JSON（深拷贝，断开与响应式引用的联系）。 */
function serializeStory(): StorySerialData {
  return {
    storyBody: storyBody.value,
    phase: phase.value,
    worldTime: cloneWorldTime(worldTime.value),
    worldTimeBaseline: cloneWorldTime(worldTimeBaseline.value),
    worldLocation: worldLocation.value ? { ...worldLocation.value } : null,
    initSnapshot: initSnapshot.value,
    actionOptions: actionOptions.value,
    chatMessages: chatMessages.value.map((m) => ({ ...m })),
    grandSummary: grandSummary.value,
    grandSummaryUpTo: grandSummaryUpTo.value,
    branchAxisRounds: branchAxisRounds.value.map(r => r.slice()),
    optionTextRounds: optionTextRounds.value.map(r => r.slice()),
    mainlineTrail: mainlineTrail.value.map(e => ({ ...e })),
  };
}

/** 从存档数据恢复剧情状态，并置 restored=true（读档会话）。 */
function restoreStory(data: StorySerialData | null | undefined): void {
  const d = data ?? ({} as Partial<StorySerialData>);
  storyBody.value = d.storyBody || "";
  // 读档总是在「就绪」状态恢复——不存档生成中途。
  phase.value = "ready";
  worldTime.value = d.worldTime ? cloneWorldTime(d.worldTime) : createDefaultWorldTime();
  worldTimeBaseline.value = d.worldTimeBaseline
    ? cloneWorldTime(d.worldTimeBaseline)
    : createDefaultWorldTime();
  worldLocation.value = d.worldLocation ? { ...d.worldLocation } : null;
  initSnapshot.value = d.initSnapshot || "";
  actionOptions.value = normalizeActionSuggestions(d.actionOptions);
  chatMessages.value = (d.chatMessages ?? []).map((m) => ({ ...m }));
  grandSummary.value = d.grandSummary ?? "";
  grandSummaryUpTo.value = d.grandSummaryUpTo ?? 0;
  branchAxisRounds.value = Array.isArray(d.branchAxisRounds) ? d.branchAxisRounds.map(r => r.slice()) : [];
  optionTextRounds.value = Array.isArray(d.optionTextRounds) ? d.optionTextRounds.map(r => r.slice()) : [];
  mainlineTrail.value = Array.isArray(d.mainlineTrail) ? d.mainlineTrail.map(e => ({ ...e })) : [];
  restored.value = true;
}

/**
 * 从快照还原剧情状态，但不设置 `restored`、不强制 `phase`。
 *
 * 与 `restoreStory` 的区别：`restoreStory` 面向「读档」，会强制 `phase="ready"` 并置
 * `restored=true`（使 `useOpeningStory` 跳过开局逻辑）；本方法面向「重试回退」等
 * 局部还原场景，原样恢复快照内的全部字段（含 phase），不动 `restored` 标志。
 */
function applyStorySnapshot(data: StorySerialData | null | undefined): void {
  const d = data ?? ({} as Partial<StorySerialData>);
  storyBody.value = d.storyBody || "";
  phase.value = d.phase ?? "idle";
  worldTime.value = d.worldTime ? cloneWorldTime(d.worldTime) : createDefaultWorldTime();
  worldTimeBaseline.value = d.worldTimeBaseline
    ? cloneWorldTime(d.worldTimeBaseline)
    : createDefaultWorldTime();
  worldLocation.value = d.worldLocation ? { ...d.worldLocation } : null;
  initSnapshot.value = d.initSnapshot || "";
  actionOptions.value = normalizeActionSuggestions(d.actionOptions);
  chatMessages.value = (d.chatMessages ?? []).map((m) => ({ ...m }));
  grandSummary.value = d.grandSummary ?? "";
  grandSummaryUpTo.value = d.grandSummaryUpTo ?? 0;
  branchAxisRounds.value = Array.isArray(d.branchAxisRounds) ? d.branchAxisRounds.map(r => r.slice()) : [];
  optionTextRounds.value = Array.isArray(d.optionTextRounds) ? d.optionTextRounds.map(r => r.slice()) : [];
  mainlineTrail.value = Array.isArray(d.mainlineTrail) ? d.mainlineTrail.map(e => ({ ...e })) : [];
}

export const storyStore = {
  storyBody,
  phase,
  worldTime,
  worldTimeBaseline,
  worldLocation,
  initSnapshot,
  actionOptions,
  chatMessages,
  grandSummary,
  grandSummaryUpTo,
  gameOverReason,
  restored,
  branchAxisRounds,
  optionTextRounds,
  mainlineTrail,
  clearStory,
  serializeStory,
  restoreStory,
  applyStorySnapshot,
  noteBranchAxes,
  recentBranchAxes,
  noteActionOptions,
  recentOptionTexts,
  noteMainlineReport,
  recentMainlineTrail,
};
