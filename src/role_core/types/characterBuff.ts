/**
 * @fileoverview 角色**持久增益/减益**（CharacterBuff）。
 *
 * ## 与战斗内 buff 的区别
 *
 * `battle_engine` 的 `EffectManager` 里也有一套 buff（DoT / 控制 / 增益），
 * 但那只活在单场战斗内，战斗一结束就清空。
 * 本文件是**跨战斗、进存档**的那一层——「重伤之后血上限掉三成」这类
 * 需要跟着角色走几十天、被叙事 AI 看见、在面板上能查的状态。
 *
 * ## 时间口径
 *
 * 持续期按**世界时间天数**推进（`startedAt` + `durationDays`），不用「回合数」：
 * 本作由 AI 叙事驱动，玩家可能连聊十轮也不推进一个回合，按回合递减会让
 * buff 形同永久。
 *
 * 到期判定依赖「当前世界时间」，而角色层不该反向依赖 `storyStore`（有环风险），
 * 故**由调用方把 now 传进来**（见 {@link pruneExpiredBuffs} 与
 * `Character.pruneBuffs`）。
 *
 * 【2026-09-24 建立】首版只做血/法上限与展示，来源开放（战斗 / 丹药 / 功法 /
 * 剧情 / 天道编辑），其余影响面（属性、修炼速度）的字段位已预留。
 */

import type { WorldTime } from "../worldTime";
import { worldTimeToDays, cloneWorldTime, ensureWorldTime } from "../worldTime";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/** buff 来源；仅用于展示与「能否被常规手段驱散」的判断。 */
export type BuffSource = "战斗" | "丹药" | "功法" | "剧情" | "天道编辑";

/**
 * 角色持久增益 / 减益。
 *
 * 百分比字段均为**百分点**：`-30` 表示血上限 −30%。
 */
export interface CharacterBuff {
  /** 唯一标识（同一次战斗重复挂同一模板时用来去重 / 续期）。 */
  id: string;
  /** 显示名，如「气血亏虚」。 */
  name: string;
  /** 一句话说明，进面板与 AI 上下文。 */
  desc: string;
  kind: "buff" | "debuff";
  source: BuffSource;
  /** 起始世界时间快照。 */
  startedAt: WorldTime;
  /**
   * 持续天数。
   *
   * `<= 0` 表示**永不过期**（用于「残废」「毁容」这类剧情性永久状态，
   * 或天道编辑手动挂的常驻效果）。
   */
  durationDays: number;
  /** 血上限百分点（正为增、负为减）。 */
  maxHpPct: number;
  /** 法力上限百分点。 */
  maxMpPct: number;
  /** 是否可叠加同名（否则新来的只做续期）。 */
  stackable: boolean;
  /** 是否可被疗伤 / 丹药 / 时间之外的方式驱散。 */
  removable: boolean;
}

/** 预置模板（不含时间信息，实例化时才补 `startedAt`）。 */
export interface BuffTemplate {
  name: string;
  desc: string;
  kind: "buff" | "debuff";
  durationDays: number;
  maxHpPct: number;
  maxMpPct: number;
  stackable: boolean;
  removable: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 预置模板
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 预置 buff 模板池。
 *
 * 新增一条只需在这里加一项；调用方也可以完全绕过模板、直接给
 * {@link createBuff} 传自定义字段（"开放全部来源"的用意）。
 */
export const BUFF_TEMPLATES: Readonly<Record<string, BuffTemplate>> = {
  气血亏虚: {
    name: "气血亏虚",
    desc: "经脉受损、元气大伤，气血上限大损，须静养方可复原。",
    kind: "debuff",
    durationDays: 30,
    maxHpPct: -30,
    maxMpPct: 0,
    stackable: false,
    removable: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 构造
// ═══════════════════════════════════════════════════════════════════════════

let seq = 0;

/** 生成 buff id；同一毫秒内多次调用靠序号区分。 */
function nextBuffId(name: string): string {
  seq += 1;
  return `${name}#${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 新建一条 buff 时的入参。 */
export interface NewBuffInput {
  /** 模板名（在 {@link BUFF_TEMPLATES} 中）；与 `custom` 二者至少给其一。 */
  name: string;
  source: BuffSource;
  /** 当前世界时间；缺省则用默认时间（仅测试/兜底）。 */
  now?: WorldTime;
  /** 覆盖模板字段（自定义 buff 时可给全）。 */
  custom?: Partial<Omit<CharacterBuff, "id" | "startedAt" | "name">> & { desc?: string };
}

/**
 * 造一条 buff。
 *
 * 优先取预置模板，再用 `custom` 逐字段覆盖；模板不存在且没给 `custom` 时返回 `null`
 * （避免静默挂上一条「名字好听但没任何效果」的空 buff）。
 *
 * @returns 新 buff；参数不足时返回 `null`。
 */
export function createBuff(input: NewBuffInput): CharacterBuff | null {
  const tpl = BUFF_TEMPLATES[input.name];
  if (!tpl && !input.custom) return null;
  const base: BuffTemplate = tpl ?? {
    name: input.name,
    desc: "",
    kind: "debuff",
    durationDays: 0,
    maxHpPct: 0,
    maxMpPct: 0,
    stackable: false,
    removable: true,
  };
  const c = input.custom ?? {};
  return normalizeBuff({
    id: nextBuffId(input.name),
    name: input.name,
    desc: c.desc ?? base.desc,
    kind: c.kind ?? base.kind,
    source: input.source,
    startedAt: cloneWorldTime(ensureWorldTime(input.now ?? { year: 1, month: 1, day: 1, hour: 8 })),
    durationDays: c.durationDays ?? base.durationDays,
    maxHpPct: c.maxHpPct ?? base.maxHpPct,
    maxMpPct: c.maxMpPct ?? base.maxMpPct,
    stackable: c.stackable ?? base.stackable,
    removable: c.removable ?? base.removable,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 归一化 / 兼容
// ═══════════════════════════════════════════════════════════════════════════

const SOURCES: readonly BuffSource[] = ["战斗", "丹药", "功法", "剧情", "天道编辑"];

/** 单条 buff 归一化；非法或残缺返回 `null`（丢弃而不是塞个空壳进数组）。 */
export function normalizeBuff(raw: unknown): CharacterBuff | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const startedAt = isWorldTime(o.startedAt) ? ensureWorldTime(o.startedAt) : null;
  if (!startedAt) return null;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  return {
    id: typeof o.id === "string" && o.id ? o.id : nextBuffId(name),
    name,
    desc: typeof o.desc === "string" ? o.desc : "",
    kind: o.kind === "buff" ? "buff" : "debuff",
    source: SOURCES.includes(o.source as BuffSource) ? (o.source as BuffSource) : "剧情",
    startedAt,
    durationDays: num(o.durationDays, 0),
    maxHpPct: num(o.maxHpPct, 0),
    maxMpPct: num(o.maxMpPct, 0),
    stackable: o.stackable === true,
    removable: o.removable !== false,
  };
}

function isWorldTime(v: unknown): v is WorldTime {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["year", "month", "day"].every(k => typeof o[k] === "number" && Number.isFinite(o[k]));
}

/** 数组级归一化（老存档无 `buffs` 字段时得到空数组）。 */
export function normalizeBuffs(raw: unknown): CharacterBuff[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterBuff[] = [];
  for (const b of raw) {
    const n = normalizeBuff(b);
    if (n) out.push(n);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 到期与聚合
// ═══════════════════════════════════════════════════════════════════════════

/** 已过去的天数（`to` 早于 `startedAt` 时为 0，避免时间回拨导致负数）。 */
export function buffElapsedDays(buff: CharacterBuff, now: WorldTime): number {
  return Math.max(0, worldTimeToDays(now) - worldTimeToDays(buff.startedAt));
}

/**
 * 是否已过期。
 *
 * `durationDays <= 0` 视为永不过期。
 */
export function isBuffExpired(buff: CharacterBuff, now: WorldTime): boolean {
  if (buff.durationDays <= 0) return false;
  return buffElapsedDays(buff, now) >= buff.durationDays;
}

/** 剩余天数；永不过期时返回 `null`。 */
export function buffRemainingDays(buff: CharacterBuff, now: WorldTime): number | null {
  if (buff.durationDays <= 0) return null;
  return Math.max(0, Math.ceil(buff.durationDays - buffElapsedDays(buff, now)));
}

/** 剔除过期项（纯函数，不改动入参）。 */
export function pruneExpiredBuffs(
  buffs: readonly CharacterBuff[],
  now: WorldTime,
): { kept: CharacterBuff[]; removed: CharacterBuff[] } {
  const kept: CharacterBuff[] = [];
  const removed: CharacterBuff[] = [];
  for (const b of buffs) {
    (isBuffExpired(b, now) ? removed : kept).push(b);
  }
  return { kept, removed };
}

/** 聚合一批 buff 的血/法上限百分点（直接相加）。 */
export function sumBuffResourcePct(
  buffs: readonly CharacterBuff[],
): { maxHpPct: number; maxMpPct: number } {
  let maxHpPct = 0;
  let maxMpPct = 0;
  for (const b of buffs) {
    maxHpPct += b.maxHpPct;
    maxMpPct += b.maxMpPct;
  }
  return { maxHpPct, maxMpPct };
}

// ═══════════════════════════════════════════════════════════════════════════
// 展示
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 面板展示文案：`气血亏虚（血上限 −30%，余 23 天）`。
 *
 * @param now 当前世界时间；缺省则不显示剩余天数。
 */
export function formatBuffForDisplay(buff: CharacterBuff, now?: WorldTime | null): string {
  const parts: string[] = [];
  if (buff.maxHpPct !== 0) parts.push(`血上限 ${buff.maxHpPct > 0 ? "+" : ""}${buff.maxHpPct}%`);
  if (buff.maxMpPct !== 0) parts.push(`法上限 ${buff.maxMpPct > 0 ? "+" : ""}${buff.maxMpPct}%`);
  if (now) {
    const left = buffRemainingDays(buff, now);
    parts.push(left == null ? "永久" : `余 ${left} 天`);
  }
  const detail = parts.length ? `（${parts.join("，")}）` : "";
  return `${buff.name}${detail}`;
}
