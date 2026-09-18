/**
 * NPC 稳定身份 ID。
 *
 * 设计目标：让同一个 NPC 跨回合、跨地点保持稳定身份，避免「同名 NPC 被覆盖」与
 * 「身份漂移」问题。优先采用 AI 在 NPC 首次出场时主动给出的 UUID；AI 未给则用
 * (归属地点 + 显示名 + 身份) 做确定性合成，保证同地点同名同身份的 NPC 跨回合稳定。
 *
 * 一旦生成便永久存储在 {@link Npc.id} 上，后续永不重算——即便合成算法的输入
 * (如创建时的地点) 后来发生变化，已存在的 NPC 身份也不受影响。
 */

import type { WorldLocation } from "./types/worldLocation";
import { formatWorldLocationDash } from "./types/worldLocation";

const NPC_ID_PREFIX = "npc_";

/**
 * 轻量字符串哈希（cyrb53），输出 53 位无符号整数。
 * 纯函数、无依赖、跨运行时稳定，适合做确定性 ID 合成。
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * 解析一个 NPC 的稳定 ID。
 *
 * @param aiNpcId        AI 在 nearbyNpcs 里主动给出的 npcId（通常是 UUID）。非空字符串直接采纳。
 * @param displayName    NPC 显示名（兜底合成输入）。
 * @param identity       NPC 身份（兜底合成输入，用于区分同名不同身份者）。
 * @param currentLocation NPC 创建时的当前地点（兜底合成输入；可选）。
 * @returns 形如 `npc_<base36>` 的稳定 ID，或 AI 给出的原值。
 */
export function resolveNpcId(
  aiNpcId: unknown,
  displayName: string,
  identity: string,
  currentLocation?: WorldLocation | null,
): string {
  if (typeof aiNpcId === "string") {
    const trimmed = aiNpcId.trim();
    if (trimmed) return trimmed;
  }
  const locPart = currentLocation ? formatWorldLocationDash(currentLocation) : "";
  const seed = [locPart, displayName, identity].filter(Boolean).join("|");
  return NPC_ID_PREFIX + cyrb53(seed).toString(36);
}
