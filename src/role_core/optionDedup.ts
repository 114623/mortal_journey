/**
 * @fileoverview 推进选项的**程序化防复读**硬兜底。
 *
 * 提示词里已经有两条软约束（【上轮选项】注入 + 【推进轴轮换】），但它们只是"请"模型别重复，
 * 模型照样会把上一轮被玩家拒绝的选项换个说法再给一遍——玩家点开一看，
 * 四条里有两条是上回合自己没选的，观感就是"这游戏在原地打转"。
 *
 * 所以这里加一层程序兜底：拿最近几轮给过的选项正文做滑窗比对，命中就丢掉。
 * 零额外 AI 调用（纯字符串运算）。
 *
 * ⚠️ **本模块必须是叶子**：不 import 任何业务模块（只 `import type` 选项类型），
 * 避免与 state_generate / storyStore 构成环（项目有 TDZ 白屏前科）。
 */

import type { BranchOption } from "../ai/state_generate";

/** 判重的滑窗长度（字符）。8 个连续汉字相同基本可以断定是同一件事的复述。 */
export const OPTION_DEDUP_GRAM = 8;

/** 过滤后至少保留几条（少于此数就回补，宁可重复也不能让玩家没得选）。 */
export const OPTION_DEDUP_MIN_KEEP = 2;

/** 单条选项正文里取多少个滑窗起点；正文很短时靠它避免漏检。 */
const MAX_GRAM_STARTS = 64;

/**
 * 取出文本里用于比对的所有 n-gram。
 *
 * 步长为 1、起点上限 `MAX_GRAM_STARTS`：短文本（<8 字）直接不参与判重——
 * 那么短的正文本来就不该被判成"复述上轮"。
 */
function grams(text: string, n: number): string[] {
  const s = text.replace(/\s+/g, "");
  if (s.length < n) return [];
  const out: string[] = [];
  const limit = Math.min(s.length - n + 1, MAX_GRAM_STARTS);
  for (let i = 0; i < limit; i++) out.push(s.slice(i, i + n));
  return out;
}

/**
 * 一条候选正文与历史正文的重合程度：命中的公共子串越长，越像复读。
 *
 * @return 最长公共子串长度；0 表示不重复。
 */
function overlapLen(candidate: string, history: string[], n: number): number {
  const gs = grams(candidate, n);
  if (gs.length === 0) return 0;
  let best = 0;
  for (const h of history) {
    const hs = h.replace(/\s+/g, "");
    if (hs.length < n) continue;
    for (const g of gs) {
      if (hs.includes(g)) {
        // 命中即计 n（更长公共子串的精确计算没必要，够用即可）。
        if (n > best) best = n;
        break;
      }
    }
    // 已经拿到理论最大值，不必再看后面的历史。
    if (best >= n) return best;
  }
  return best;
}

/**
 * 过滤掉与最近几轮选项重复的候选。
 *
 * 规则：候选正文与任一历史正文存在 ≥ {@link OPTION_DEDUP_GRAM} 字符的公共子串即判重。
 * 保底：过滤后不足 {@link OPTION_DEDUP_MIN_KEEP} 条时，按重合程度从轻到重回补到该数量；
 * 全部被丢且无法回补（历史为空等极端情况）则原样返回——**宁滥勿缺**，
 * 玩家没选项可点比看到重复选项糟糕得多。
 *
 * @param items 本回合 AI 给的选项（保持原顺序与完整对象）。
 * @param recentTexts 最近几轮已经给过的选项正文。
 * @return `kept` 为保留项，`dropped` 为被滤掉的正文（仅供日志）。
 */
export function filterRepeatedOptions(
  items: BranchOption[],
  recentTexts: string[],
): { kept: BranchOption[]; dropped: string[] } {
  if (!items || items.length === 0) return { kept: [], dropped: [] };

  const history = (recentTexts ?? []).map(t => String(t || "")).filter(t => t.trim().length >= OPTION_DEDUP_GRAM);
  if (history.length === 0) return { kept: items.slice(), dropped: [] };

  const scored = items.map((item, idx) => ({
    item,
    idx,
    overlap: overlapLen(String(item.text || ""), history, OPTION_DEDUP_GRAM),
  }));

  const fresh = scored.filter(s => s.overlap === 0).map(s => s.item);
  const dropped = scored.filter(s => s.overlap > 0).map(s => s.item.text);

  // 新鲜选项够用 —— 直接返回，保持 AI 给的原顺序。
  if (fresh.length >= OPTION_DEDUP_MIN_KEEP) return { kept: fresh, dropped };

  // 不够：按重合程度从轻到重回补，直到凑够 MIN_KEEP（或全部用尽）。
  const stale = scored.filter(s => s.overlap > 0).sort((a, b) => a.overlap - b.overlap || a.idx - b.idx);
  const kept = fresh.slice();
  for (const s of stale) {
    if (kept.length >= OPTION_DEDUP_MIN_KEEP) break;
    kept.push(s.item);
    const at = dropped.indexOf(s.item.text);
    if (at >= 0) dropped.splice(at, 1);
  }

  // 保底：一条都没剩下（理论上不会发生），原样放行。
  if (kept.length === 0) return { kept: items.slice(), dropped: [] };

  // 回补可能打乱原顺序，按 AI 原本的顺序排回去，观感更自然。
  const order = new Map(items.map((it, i) => [it, i]));
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { kept, dropped };
}
