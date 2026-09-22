/**
 * @fileoverview 角色记忆日志：三行一条、新的在最上面、**只追加不改**。
 *
 * 格式（由状态 AI 的 [NPC画像提示词规则] 第 3 条定义）：
 *
 * ```
 * 0005年12月20日 17:00          ← 第 1 行：时间（世界时间只到小时，分钟恒 00）
 * 溪京城·振远镖局·院内           ← 第 2 行：地点
 * 擦净灶台又到院门口张望了一回……  ← 第 3 行：正文（该角色视角）
 *
 * 0005年12月20日 15:00          ← 条目之间空一行，新的在上
 * …
 * ```
 *
 * 为什么要程序兜底（而不是只靠提示词）：玩家明确要求「除非是超了字数限制要压缩，
 * 否则不要让 AI 更改已经记录的事」。记忆是**日志**语义——发生过的事写下来就定了，
 * 后续只能补新条目。但 AI 每回合返回的是整段 memory 文本，天然会顺手润色旧条目、
 * 把几条合并成一条，光靠提示词拦不住。于是这里按「时间行」逐条比对：
 *
 *   - 旧记忆**未超压缩阈值** → 严格只追加：旧条目一律原文原序保留，
 *     改写（同时间行文字不同 / 高相似度的无时间行条目）与**丢失**都算违规，
 *     整段拒绝，兜底保留旧日志不动、只把新条目追加到最上面；
 *   - 旧记忆**已超阈值**（压缩轮）→ 放行：此时提示词允许「提炼压缩」旧条目
 *     （压短文字、合并同时段相邻条目），程序不再拦截，否则压缩根本做不了。
 *
 * 注意压缩 ≠ 删除：提示词明确禁止整条丢掉旧条目来凑字数（见 state_preset 第 4 条）。
 *
 * 玩家手写的记忆同样受保护：玩家写的常常是**没有时间行的自由散文**，早期实现里
 * 遇到「整段不是日志格式」就整段放行，导致玩家写进去的东西被 AI 一轮重写掉——
 * 现在改成逐条保护，无时间行的条目靠文本相似度认亲（见 `diceSimilarity`）。
 */

import { MEMORY_COMPRESS_THRESHOLD } from "./types/playInfo";

/** 时间行的识别正则：`0005年12月20日 17:00` / `0001年05月17日-0001年05月18日`。 */
const TIME_LINE =
  /^\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?(?:-\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)?$/;

/**
 * 把记忆文本切成条目（空行分隔）。
 *
 * 注意：不对条目内部做归一化（不改换行、不 trim 行首空格），
 * 否则「原样保留」的比对就失去意义。
 */
export function splitMemoryEntries(text: string): string[] {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 取条目的时间键（第 1 行的时间行）；不是时间行则返回空串。
 *
 * 时间键是比对的锚点——同一时刻只允许存在一条，改了正文即视为改写旧条目。
 */
export function memoryEntryTimeKey(entry: string): string {
  const first = (entry.split("\n", 1)[0] ?? "").trim();
  return TIME_LINE.test(first) ? first : "";
}

/** 记忆是否为「三行日志」格式（旧存档的自由散文返回 false）。 */
export function isMemoryLogFormat(text: string): boolean {
  const entries = splitMemoryEntries(text);
  if (entries.length === 0) return false;
  return entries.some((e) => memoryEntryTimeKey(e) !== "");
}

export interface MemoryGuardResult {
  /** 最终应写入的记忆文本。 */
  text: string;
  /** true = AI 改写了旧条目且本轮**不该**改（未超压缩阈值），已回滚为「旧条目原样 + 新条目追加到顶部」。 */
  repaired: boolean;
  /** 被判定为「改写旧条目」的条数（诊断用）。 */
  rewritten: number;
  /** 被判定为「丢掉旧条目」的条数（诊断用）——AI 少抄一条也算违规。 */
  missing: number;
  /** true = 本轮是压缩轮（旧记忆已超阈值），放行对旧条目的提炼。 */
  compressing: boolean;
}

/**
 * 条目的**规范化指纹**：逐行去首尾空白后再拼回。
 *
 * 用途：AI 常常只是给旧条目多敲了个空格或换行，若按原文严格比对会被误判成「新条目」，
 * 于是旧条目在文本里被重复堆一份。指纹比对可吃掉这类纯排版差异。
 */
function canonicalEntry(entry: string): string {
  return String(entry ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

/** 去掉全部空白后的正文——用于「无时间行条目」的相似度认亲。 */
function squeeze(text: string): string {
  return String(text ?? "").replace(/\s+/g, "");
}

/** 二元组集合（中文没有空格，按字切分即可）。 */
function bigrams(text: string): string[] {
  const t = squeeze(text);
  if (t.length === 0) return [];
  if (t.length === 1) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * Dice 相似度（0~1）：两条文本有多像。
 *
 * 只给「没有时间行的条目」兜底用——玩家手写的散文、旧存档的一段白话没有时间行可锚定，
 * AI 顺手润色后程序就认不出它是旧条目了，会把润色版当新条目再追加一份（旧条目还在 → 重复）。
 * 相似度够高就判定为「这一条是某条旧内容的改写版」，丢掉 AI 的版本、保留原文。
 */
function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of B) {
    const left = counts.get(g) ?? 0;
    if (left > 0) {
      counts.set(g, left - 1);
      hit += 1;
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/** 判定「同一条旧内容的改写版」的相似度门槛。 */
const REWRITE_SIMILARITY = 0.5;

/**
 * 校验 AI 写回的整段记忆，产出可安全写入的文本。
 *
 * @param oldText 现有的记忆（已生效值）
 * @param nextText AI 本轮输出的整段记忆
 * @param compressThreshold 压缩阈值（字）；旧记忆超过它时本轮允许提炼旧条目
 */
export function guardMemoryUpdate(
  oldText: string,
  nextText: string,
  compressThreshold: number = MEMORY_COMPRESS_THRESHOLD,
): MemoryGuardResult {
  const oldEntries = splitMemoryEntries(oldText);
  const nextEntries = splitMemoryEntries(nextText);

  // 旧记忆为空 → 没有要保护的东西，AI 写什么算什么。
  if (oldEntries.length === 0) {
    return { text: nextText, repaired: false, rewritten: 0, missing: 0, compressing: false };
  }
  // AI 交了白卷 → 保持原样，不要顺手把旧日志重新排版一遍。
  if (nextEntries.length === 0) {
    return { text: oldText, repaired: false, rewritten: 0, missing: 0, compressing: false };
  }

  // 压缩轮：旧记忆已超阈值，提示词允许「提炼」，程序放行（否则压缩做不了）。
  // 注意本轮不校验，但「压缩 ≠ 删除」仍由提示词约束。
  if (String(oldText ?? "").trim().length > compressThreshold) {
    return { text: nextText, repaired: false, rewritten: 0, missing: 0, compressing: true };
  }

  // 旧条目建索引：指纹索引认「原样保留」，时间行索引认「改写」。
  // 不再要求整段是日志格式——玩家手写的散文同样要保（这是本次修复的重点）。
  const oldCanon = new Map<string, number>();
  const oldByKey = new Map<string, number>();
  const oldPlain: string[] = [];
  const oldTimed: boolean[] = [];
  oldEntries.forEach((e, i) => {
    const c = canonicalEntry(e);
    if (!oldCanon.has(c)) oldCanon.set(c, i);
    const k = memoryEntryTimeKey(e);
    if (k && !oldByKey.has(k)) oldByKey.set(k, i);
    oldPlain.push(squeeze(e));
    oldTimed.push(k !== "");
  });

  const kept = new Set<number>();
  const fresh: string[] = [];
  let rewritten = 0;

  for (const e of nextEntries) {
    // ① 原样保留（允许纯排版差异）→ 通过。
    const exact = oldCanon.get(canonicalEntry(e));
    if (exact !== undefined) {
      kept.add(exact);
      continue;
    }
    // ② 时间行命中旧条目但文字不同 → AI 改了旧条目，违规；丢掉 AI 的版本，保原文。
    const key = memoryEntryTimeKey(e);
    const byKey = key ? oldByKey.get(key) : undefined;
    if (byKey !== undefined) {
      rewritten += 1;
      kept.add(byKey);
      continue;
    }
    // ③ 没有时间行可锚定（玩家手写的散文 / 旧存档白话）：靠相似度认亲，
    //    认上了就当它是旧条目的润色版 → 同样按「改写」处理，保原文。
    //    只对「两边都是无时间行的散文」启用——带了时间行的条目一律按时间键判定，
    //    否则同一地点写两条日志时，正文之外的地点行就足以让相似度虚高、把新条目误吞掉。
    const np = squeeze(e);
    let bestIdx = -1;
    let bestScore = 0;
    if (!key) {
      for (let i = 0; i < oldPlain.length; i++) {
        if (kept.has(i) || oldTimed[i]) continue;
        const s = diceSimilarity(oldPlain[i], np);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0 && bestScore >= REWRITE_SIMILARITY) {
      rewritten += 1;
      kept.add(bestIdx);
      continue;
    }
    // ④ 都不是 → 确实是新条目。
    fresh.push(e);
  }

  // ⑤ 旧条目在 AI 的文本里彻底消失 → 违规（「只追加」当然也不许删）。
  let missing = 0;
  for (let i = 0; i < oldEntries.length; i++) {
    if (!kept.has(i)) missing += 1;
  }

  if (rewritten === 0 && missing === 0) {
    return { text: nextText, repaired: false, rewritten: 0, missing: 0, compressing: false };
  }

  // 违规处理：旧日志整段不动（原文、原顺序），只把 AI 新写的条目追加到最上面。
  const merged = [...fresh, ...oldEntries].join("\n\n");
  return { text: merged, repaired: true, rewritten, missing, compressing: false };
}
