/**
 * @fileoverview 篇章系统：玩家自选的**短期**剧情目标，挂在主线之下。
 *
 * 与主线（世界设定的「storyOutline」，原「剧情脉络」）是上下位关系：
 * 主线＝整个人生的长期方向；篇章＝主线之下一个具体可达成的短期目标。
 *
 * 与「场景配额」（`sceneBudgetStore`）的两点关键差异：
 *   1. **进度入存档**——篇章跨回合延续，读档必须保留；场景进度只在会话内、读档清零。
 *   2. **只有软加压，没有硬闸**——篇章不像秘境/擂台那样能由程序强制收束，
 *      只能逐级温和提示；玩家不开篇章则全程零打扰。
 *
 * 起头方式：开局不设篇章。玩家在「世界设定 → 主线 · 篇章」里自己开；
 * 不开时 `buildChapterDirective()` 返回空串，剧情 AI / 状态 AI 完全不会看到篇章字样。
 *
 * 主线本身沿用 `WorldSettingsText.storyOutline` 字段（语义即「玩家希望的发展方向」），
 * 本 store 只负责**当前篇章**这一层。
 */

import { ref } from "vue";

/** 当前篇章。 */
export interface Chapter {
  /** 篇章名（一句话）。 */
  title: string;
  /** 本篇章要达成的目标。 */
  goal: string;
  /** 状态：进行中 / 已收束。 */
  status: "active" | "closed";
  /** 已进行回合数（仅 active 时递增）。 */
  turns: number;
}

/** 篇章回合上限的本地存储键（跨人生生效，属「设置」而非存档）。 */
export const CHAPTER_TURN_LIMIT_KEY = "MJ_CHAPTER_TURN_LIMIT_V1";
export const DEFAULT_CHAPTER_TURN_LIMIT = 15;
export const MIN_CHAPTER_TURN_LIMIT = 5;
export const MAX_CHAPTER_TURN_LIMIT = 40;

function clampLimit(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CHAPTER_TURN_LIMIT;
  if (n < MIN_CHAPTER_TURN_LIMIT) return MIN_CHAPTER_TURN_LIMIT;
  if (n > MAX_CHAPTER_TURN_LIMIT) return MAX_CHAPTER_TURN_LIMIT;
  return n;
}

function readStoredLimit(): number {
  try {
    const raw = localStorage.getItem(CHAPTER_TURN_LIMIT_KEY);
    if (!raw) return DEFAULT_CHAPTER_TURN_LIMIT;
    return clampLimit(Number.parseInt(raw, 10));
  } catch {
    return DEFAULT_CHAPTER_TURN_LIMIT;
  }
}

/** 篇章回合上限（超过后逐级温和加压，不设硬闸）。 */
export const chapterTurnLimit = ref<number>(readStoredLimit());

/** 当前篇章；null = 玩家未开篇章。 */
export const chapter = ref<Chapter | null>(null);

export function setChapterTurnLimit(n: number): void {
  const v = clampLimit(n);
  chapterTurnLimit.value = v;
  try {
    localStorage.setItem(CHAPTER_TURN_LIMIT_KEY, String(v));
  } catch {
    /* ignore */
  }
}

function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** 开启新篇章（覆盖现有篇章）。标题为空时不开启。 */
export function openChapter(title: string, goal: string): Chapter | null {
  const t = oneLine(title);
  if (!t) return null;
  const next: Chapter = { title: t, goal: oneLine(goal), status: "active", turns: 0 };
  chapter.value = next;
  return next;
}

/** 修改当前篇章的标题/目标（不改回合数与状态）。 */
export function updateChapter(patch: Partial<Pick<Chapter, "title" | "goal">>): void {
  const cur = chapter.value;
  if (!cur) return;
  chapter.value = {
    ...cur,
    title: patch.title !== undefined ? oneLine(patch.title) || cur.title : cur.title,
    goal: patch.goal !== undefined ? oneLine(patch.goal) : cur.goal,
  };
}

/**
 * 收束当前篇章。
 *
 * 收束不等于成功——失败、主动放弃、被迫搁置都算收束，这里只置状态，不判定成败。
 */
export function closeChapter(): void {
  const cur = chapter.value;
  if (!cur) return;
  chapter.value = { ...cur, status: "closed" };
}

/** 直接结束并清空篇章（玩家想彻底不要篇章时用）。 */
export function clearChapter(): void {
  chapter.value = null;
}

/** 每轮剧情生成成功后调用：进行中的篇章回合数 +1。 */
export function noteChapterTurn(): void {
  const cur = chapter.value;
  if (!cur || cur.status !== "active") return;
  chapter.value = { ...cur, turns: cur.turns + 1 };
}

/**
 * 组装篇章指令（注入剧情 AI / 状态 AI）。
 *
 * 无篇章或篇章已收束时返回空串——调用方据此不注入，做到「不开篇章就永不打扰」。
 * 超过回合上限后逐级加压，但始终只给方向、不强制结果。
 */
export function buildChapterDirective(mainline?: string): string {
  const cur = chapter.value;
  if (!cur || cur.status !== "active") return "";
  const limit = chapterTurnLimit.value;
  const ml = (mainline ?? "").replace(/\s+/g, " ").trim();

  const head = [
    "【当前篇章 · 玩家设定，权重最高】",
    `篇章名：${cur.title}`,
    cur.goal ? `目标：${cur.goal}` : "目标：（未填写，自行从篇章名推断一个具体可达成的目标）",
    // 主线是上位长期方向，放这里让 AI 知道篇章在整条主线里的位置，但不让它喧宾夺主。
    ml ? `上位主线（长期方向）：${ml}` : "",
    `已进行：${cur.turns} 回合`,
  ].filter(Boolean).join("\n");

  const service = [
    "本回合剧情须以下列四种方式之一服务篇章（四选一，不要每回合都是同一种）：",
    "- 推进：目标取得实质前进。推进必须经过可观察的因果链（对话、观察、交易、冲突），不许「恰好有人告诉你」。",
    "- 受阻：遇到具体阻力（某人、某条规矩、资源不足、消息有误），并写清楚是什么挡住了。",
    "- 铺垫：为后续埋因，本回合可以不碰目标，但必须留下后面能接上的伏笔。",
    "- 背景压力：目标仅作背景存在，主角在忙别的事，篇章本回合不推进也算合格。",
  ].join("\n");

  // 第 4 条只在玩家真的写了主线时才给——没主线却讲「与上位主线冲突」会让 AI 凭空造一条。
  const guardCount = ml ? "四条保底：" : "三条保底：";
  const guards = [
    guardCount,
    "1. 玩家本轮输入绝对优先。玩家做了与篇章无关的事，以玩家为准，篇章退为背景，严禁硬拽回来。",
    "2. 禁止跳跃式推进。不许「恰好有人告诉你」「忽然想起」「多年未联系的人恰好出现」，推进须有可见因果。",
    "3. 收束不等于成功。失败、主动放弃、被迫搁置都是合法的收束方式，不要为了让玩家「赢」而扭曲剧情。",
    ...(ml
      ? [
          "4. 与上位主线冲突时以篇章为准——它更具体、更近；主线退为长期背景，",
          "   不要为了两头兼顾把本回合写成四平八稳的折中。",
        ]
      : []),
  ].join("\n");

  let pressure = "";
  if (cur.turns > limit + 10) {
    pressure = `\n【篇章进度】该篇章已进行 ${cur.turns} 回合，远超 ${limit} 回合的常规长度。本回合必须把它推向结果——达成、失败、主动放弃、被迫搁置均可，但不能再原地打转。`;
  } else if (cur.turns > limit + 5) {
    pressure = `\n【篇章进度】该篇章已进行 ${cur.turns} 回合（常规 ${limit} 回合）。请在最近一两回合内收束，给出成功或失败或放弃的明确结果。`;
  } else if (cur.turns > limit) {
    pressure = `\n【篇章进度】该篇章已进行 ${cur.turns} 回合，超过常规长度（${limit} 回合）。请开始朝一个阶段性结果收拢。`;
  }

  return [head, "", service, "", guards, pressure].filter(Boolean).join("\n");
}

/** 序列化（存档用）。无篇章时为 null。 */
export function serializeChapter(): Chapter | null {
  const cur = chapter.value;
  if (!cur) return null;
  return JSON.parse(JSON.stringify(cur)) as Chapter;
}

/** 从存档恢复；数据缺失或非法时视为「无篇章」（旧存档无此字段即走这条）。 */
export function restoreChapter(data: Chapter | null | undefined): void {
  if (!data || typeof data !== "object") {
    chapter.value = null;
    return;
  }
  const title = oneLine(data.title);
  if (!title) {
    chapter.value = null;
    return;
  }
  chapter.value = {
    title,
    goal: oneLine(data.goal),
    status: data.status === "closed" ? "closed" : "active",
    turns: typeof data.turns === "number" && Number.isFinite(data.turns) && data.turns > 0
      ? Math.floor(data.turns)
      : 0,
  };
}

export const chapterStore = {
  chapter,
  chapterTurnLimit,
  setChapterTurnLimit,
  openChapter,
  updateChapter,
  closeChapter,
  clearChapter,
  noteChapterTurn,
  buildChapterDirective,
  serializeChapter,
  restoreChapter,
};
