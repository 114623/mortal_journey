import {
  rollGradeAttriValue,
  GONGFA_GRADE_ATTRI_TABLE,
} from "../role_core/types/playInfo";
import type { InventoryStackItem } from "../role_core/types/playInfo";
import {
  createSpiritStoneInventoryStack,
} from "../role_core/types/spiritStone";
import type {
  GongfaItemDefinition,
  ItemGrade,
  TreasureItemDefinition,
  MaterialItemDefinition,
  MiscItemDefinition,
  CategorizedItemDefinition,
  GradeDropRate,
} from "../role_core/types/itemInfo";
import {
  GRADE_DROP_TABLE,
  GRADE_INDEX,
  gradeRangeForPowerTier,
  type GradeConstraint,
} from "../role_core/types/gameConstants";
import { rollTreasureFunction, rollTreasureSpecialEffect } from "../role_core/types/treasure";
import { rollItemTier } from "../role_core/types/itemTier";
import {
  rollMortalWeapon,
  rollMortalMartialArt,
  isMortalWeaponName,
  isMortalMartialArtName,
} from "../role_core/types/mortalArsenal";
import { rollGongfaFunction, normalizeGongfaSystem, normalizeGongfaRole, type GongfaRole } from "../role_core/types/gongfa";
import {
  rollElixirValue,
  isElixirPercent,
} from "../role_core/types/elixir";
import { resolveElixirFromAi } from "../role_core/alchemy";

export const VALID_BONUS_NAMES: ReadonlySet<string> = new Set(Object.keys(GONGFA_GRADE_ATTRI_TABLE));

export function parseBonusField(raw: unknown, grade: string): Record<string, number> {
  if (typeof raw !== "string") return {};
  const name = raw.trim();
  if (!VALID_BONUS_NAMES.has(name)) return {};
  return { [name]: rollGradeAttriValue(name, grade, GONGFA_GRADE_ATTRI_TABLE) };
}

export function extractTagContent(raw: string, openTag: string, closeTag: string): string {
  const i = raw.indexOf(openTag);
  if (i < 0) return "";
  const from = i + openTag.length;
  const j = raw.indexOf(closeTag, from);
  if (j < 0) return raw.slice(from).trim();
  return raw.slice(from, j).trim();
}

export function sanitizeJsonLike(text: string): string {
  let s = text;
  s = s.replace(/\{"([^"]*)"\s*(?:,\s*"[^"]*")*\}/g, (m) => {
    const items: string[] = [];
    const re = /"([^"]*)"/g;
    let r: RegExpExecArray | null;
    while ((r = re.exec(m)) !== null) items.push('"' + r[1] + '"');
    return "[" + items.join(",") + "]";
  });
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

export function tryParseJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tryParse = (src: string): unknown[] | null => {
    try {
      const parsed = JSON.parse(src);
      if (Array.isArray(parsed)) return parsed;
      return null;
    } catch {
      return null;
    }
  };
  let result = tryParse(trimmed);
  if (result) return result;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const segment = trimmed.slice(start, end + 1);
    result = tryParse(segment);
    if (result) return result;
    result = tryParse(sanitizeJsonLike(segment));
    if (result) return result;
  }
  result = tryParse(sanitizeJsonLike(trimmed));
  if (result) return result;
  return null;
}

export function safeStr(val: unknown, fallback: string): string {
  return typeof val === "string" && val.trim() ? val.trim() : fallback;
}

export const GRADE_KEYS: readonly (keyof GradeDropRate)[] = ["下品", "中品", "上品", "极品", "仙品", "神品"];

/** 合法品阶集合（用于校验 AI 输出）。 */
export const VALID_GRADES: ReadonlySet<string> = new Set<string>(GRADE_KEYS);

/**
 * 按境界掉落表随机品阶，可选地约束在 [min, max] 区间内。
 *
 * 区间约束的做法是**把区间外权重清零后重新归一化**，而非硬截断——
 * 这样低境界 NPC 仍以低品阶为主，不会变成均匀分布。
 *
 * @param realmMajor 大境界。
 * @param realmMinor 小境界。
 * @param range 品阶区间；`pinned` 存在时直接返回该品阶。
 */
export function rollGrade(
  realmMajor: string,
  realmMinor: string,
  range?: GradeConstraint,
): ItemGrade {
  if (range?.pinned && VALID_GRADES.has(range.pinned)) return range.pinned;
  const stage = GRADE_DROP_TABLE[realmMajor]?.[realmMinor];
  if (!stage) return "下品";

  const minIdx = range?.min != null ? (GRADE_INDEX[range.min] ?? 0) : 0;
  const maxIdx = range?.max != null ? (GRADE_INDEX[range.max] ?? GRADE_KEYS.length - 1) : GRADE_KEYS.length - 1;

  let total = 0;
  const weights = GRADE_KEYS.map((key, i) => {
    const w = i >= minIdx && i <= maxIdx ? stage[key] : 0;
    total += w;
    return w;
  });
  // 区间内无任何权重（低境界 + 高档区间）：退回区间下限，避免退化成下品。
  if (total <= 0) return GRADE_KEYS[Math.max(minIdx, 0)] ?? "下品";

  let roll = Math.random() * total;
  for (let i = 0; i < GRADE_KEYS.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return GRADE_KEYS[i];
  }
  return "下品";
}

/** 校验并规范化品阶字符串；非法返回 null。 */
export function parseGrade(raw: unknown): ItemGrade | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return VALID_GRADES.has(t) ? (t as ItemGrade) : null;
}

/**
 * 决定物品最终品阶，优先级：AI 显式指定 > 战力档区间约束 > 境界掉落表随机。
 *
 * AI 显式给的品阶必须优先——「花十灵石从摊贩手里买的飞剑」在剧情上就该是下品，
 * 若重摇成神品，同一笔小额交易会一会儿下品一会儿神品，极其出戏。
 *
 * @param obj AI 输出的物品对象。
 * @param constraint 区间 / 锁定约束（来自 NPC 战力档或上层已解析的 AI 品阶）。
 */
export function resolveGrade(
  obj: Record<string, unknown>,
  realmMajor: string,
  realmMinor: string,
  constraint?: GradeConstraint,
): ItemGrade {
  const ai = parseGrade(obj.grade);
  if (ai) return ai;
  return rollGrade(realmMajor, realmMinor, constraint);
}

export function safeCount(val: unknown): number {
  const n = typeof val === "number" ? val : parseInt(String(val), 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

export const TYPE_TO_ITEM_TYPE: Record<string, CategorizedItemDefinition["itemType"]> = {
  "法宝": "法宝",
  "功法": "功法",
  "丹药": "丹药",
  "材料": "材料",
  "杂物": "杂物",
};

export function parseEquipObject(
  e: unknown,
  realmMajor: string,
  realmMinor: string,
  constraint?: GradeConstraint,
): TreasureItemDefinition {
  const obj = e as Record<string, unknown>;
  const grade = resolveGrade(obj, realmMajor, realmMinor, constraint);
  const tier = rollItemTier(realmMajor);
  // 凡人阶一律走「凡人兵器图鉴」：名称/简介/词条成套取用，
  // 只有 AI 恰好点到了图鉴里的名字才沿用该名，否则随机一件。
  if (tier === "凡人") {
    const aiName = safeStr(obj.name, "").trim();
    return rollMortalWeapon(grade, isMortalWeaponName(aiName) ? aiName : undefined);
  }
  return {
    itemType: "法宝",
    name: safeStr(obj.name, "未命名法宝"),
    desc: safeStr(obj.intro, ""),
    grade,
    tier,
    count: 1,
    function: rollTreasureFunction(grade, tier),
    specialEffect: rollTreasureSpecialEffect(grade),
  };
}

export function parseGongfaObject(
  e: unknown,
  realmMajor: string,
  realmMinor: string,
  _playerLinggen?: readonly string[] | null,
  constraint?: GradeConstraint,
): GongfaItemDefinition {
  const obj = e as Record<string, unknown>;
  const grade = resolveGrade(obj, realmMajor, realmMinor, constraint);
  const tier = rollItemTier(realmMajor);
  // 同上：凡人阶一律走「凡人武功图鉴」。
  if (tier === "凡人") {
    const aiName = safeStr(obj.name, "").trim();
    return rollMortalMartialArt(grade, isMortalMartialArtName(aiName) ? aiName : undefined);
  }
  const system = normalizeGongfaSystem(obj.system);
  const role = normalizeGongfaRole(obj.role);
  // 机缘续作：AI 标注了继承自哪门旧功法时保留该字段，程序侧据此沿用其修炼进度。
  const inheritFrom = safeStr(obj.inheritFrom, "").trim() || undefined;
  return {
    itemType: "功法",
    name: safeStr(obj.name, "未命名功法"),
    desc: safeStr(obj.intro, ""),
    grade,
    tier,
    count: 1,
    bonus: parseBonusField(obj.bonus, grade),
    system,
    role,
    mastery: 1,
    function: rollGongfaFunction(system, grade, role),
    inheritFrom,
  };
}

export function parseStorageObject(
  e: unknown,
  realmMajor: string,
  realmMinor: string,
  _playerLinggen?: readonly string[] | null,
  constraint?: GradeConstraint,
): InventoryStackItem | null {
  const obj = e as Record<string, unknown>;
  const typeStr = safeStr(obj.type, "杂物");

  if (typeStr === "灵石") {
    const count = safeCount(obj.count);
    if (count <= 0) return null;
    return createSpiritStoneInventoryStack(count);
  }

  const name = safeStr(obj.name, "未命名物品");
  const desc = safeStr(obj.intro, "");
  const grade = resolveGrade(obj, realmMajor, realmMinor, constraint);
  const count = safeCount(obj.count);
  const itemType = TYPE_TO_ITEM_TYPE[typeStr] ?? "杂物";
  if (itemType === "功法") {
    const gTier = rollItemTier(realmMajor);
    if (gTier === "凡人") {
      return rollMortalMartialArt(grade, isMortalMartialArtName(name) ? name : undefined);
    }
    const system = normalizeGongfaSystem(obj.system);
    const role = normalizeGongfaRole(obj.role);
    return { itemType: "功法", name, desc, grade, tier: gTier, count, system, role, mastery: 1, bonus: parseBonusField(obj.bonus, grade), function: rollGongfaFunction(system, grade, role) } as GongfaItemDefinition;
  }

  switch (itemType) {
    case "法宝": {
      const t = rollItemTier(realmMajor);
      if (t === "凡人") {
        return rollMortalWeapon(grade, isMortalWeaponName(name) ? name : undefined);
      }
      return { itemType: "法宝", name, desc, grade, tier: t, count, function: rollTreasureFunction(grade, t), specialEffect: rollTreasureSpecialEffect(grade) } as TreasureItemDefinition;
    }
    case "丹药": {
      // 名实相符：名称/简介优先决定效果类型（命中命名表时连品阶一并锁定），
      // AI 的 effectType 只作为兜底，避免「疗伤丹却恢复法力」。
      // AI 显式给的 grade 优先级最高——小额交易买的便宜丹就该稳定是低品阶。
      const aiPinned = parseGrade(obj.grade);
      const rolled = aiPinned ?? rollGrade(realmMajor, realmMinor, constraint);
      const resolved = resolveElixirFromAi(name, desc, obj.effectType, rolled, aiPinned);
      const tier = rollItemTier(realmMajor);
      const value = rollElixirValue(resolved.effectType, resolved.grade, tier);
      return {
        itemType: "丹药" as const,
        name: resolved.name,
        desc: resolved.desc,
        grade: resolved.grade,
        tier,
        count,
        effectType: resolved.effectType,
        effects: { value, isPercent: isElixirPercent(resolved.effectType, resolved.grade) },
      };
    }
    case "材料": {
      const t = rollItemTier(realmMajor);
      return { itemType: "材料", name, desc, grade, tier: t, count } as MaterialItemDefinition;
    }
    case "杂物":
    default:
      return { itemType: "杂物", name, desc, grade, count } as MiscItemDefinition;
  }
}
