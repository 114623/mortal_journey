/**
 * @fileoverview 势力档案：主角已探知或登记过的修仙势力（宗门 / 世家 / 商会 / 魔道 …）。
 *
 * 与 `npcStore` 一样用「名字做唯一键」——改名等于删旧建新。
 *
 * 两条写入来源：
 *   - **玩家手动探查**（`ai/faction_generate.ts`）：主动点按钮才跑，省 token。
 *   - **状态 AI 增量事件**（`<MJ_FACTION_TAG>`，见 `ai/state_preset.ts` 第 15 段）：
 *     只在「首次出现的有名势力 / 诉求或关系实质变化 / 真实战力曝光」三种情况下输出。
 *
 * 设计要点：
 *   - **强度档位由代码推导**（`factionStrengthTier`），AI 只报原始数字，
 *     避免 AI 自评档位漂移导致展示口径不一。
 *   - **数字夹取**：元婴 0~3 / 结丹 0~10 / 筑基 0~30，防止浮夸。
 *     上限依据世界观：一国政府一般只有十个左右练气，个别统治者可能是筑基
 *     （见 `ai/story_preset.ts` 的 WORLD_VIEW_DEFAULT 第 13 条）。
 */

import { ref } from "vue";

/** 势力战力三档人数。 */
export interface FactionPower {
  /** 元婴期修士数（夹取 0~3）。 */
  yuanying: number;
  /** 结丹期修士数（夹取 0~10）。 */
  jiedan: number;
  /** 筑基期修士数（夹取 0~30）。 */
  zhuji: number;
}

/** 势力档案条目。 */
export interface Faction {
  /** 势力名（唯一键）。 */
  name: string;
  /** 类型：宗门 / 世家 / 商会 / 散修联盟 / 魔道 / 王朝 … */
  type: string;
  /** 驻地文本（region-country-area-detail 四级路径，与世界地图同格式）。 */
  locationText: string;
  /** 战力三档人数。 */
  power: FactionPower;
  /** 诉求 / 图谋，1~2 句。 */
  demands: string;
  /** 与主角的关系：无交集 / 友好 / 敌对 / 隶属 / 竞争 / 敌视 … */
  relation: string;
  /** 一句话特色（可选）。 */
  desc?: string;
}

/**
 * 状态 AI `<MJ_FACTION_TAG>` 解析后的变更事件。
 * 除 `op` 与 `name` 外全部可选——未提供的字段在 update 时保留原值。
 */
export interface FactionChange {
  op: "add" | "update";
  name: string;
  type?: string;
  locationText?: string;
  power?: Partial<FactionPower>;
  demands?: string;
  relation?: string;
  desc?: string;
}

/** 势力强度档位（由 `factionStrengthTier` 推导，不由 AI 填写）。 */
export type FactionTier = "元婴坐镇" | "一方势力" | "中等势力" | "小势力" | "微末势力";

/** 档位从强到弱，UI 分组与排序共用。 */
export const FACTION_TIER_ORDER: readonly FactionTier[] = [
  "元婴坐镇",
  "一方势力",
  "中等势力",
  "小势力",
  "微末势力",
];

/** 各战力档的夹取上限（防 AI 报出浮夸数字）。 */
export const FACTION_POWER_MAX = { yuanying: 3, jiedan: 10, zhuji: 30 } as const;

/** 势力名单软上限：超出后面板提示可清理（不阻断写入）。 */
export const FACTION_SOFT_LIMIT = 12;

/** 把文本安全化为单行（防换行把注入的一行快照撑成多行）。 */
function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function clampInt(v: unknown, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
  if (n < 0) return 0;
  return n > max ? max : n;
}

/** 规范化战力数字（夹取 + 补零）。 */
export function normalizeFactionPower(raw: Partial<FactionPower> | null | undefined): FactionPower {
  const p = raw ?? {};
  return {
    yuanying: clampInt(p.yuanying, FACTION_POWER_MAX.yuanying),
    jiedan: clampInt(p.jiedan, FACTION_POWER_MAX.jiedan),
    zhuji: clampInt(p.zhuji, FACTION_POWER_MAX.zhuji),
  };
}

/**
 * 由战力数字推导强度档位（程序判定，不看 AI 自评）。
 *
 * 元婴≥1 → 元婴坐镇；结丹≥3 → 一方势力；结丹 1~2 → 中等势力；
 * 筑基≥5 → 小势力；其余 → 微末势力。
 */
export function factionStrengthTier(power: FactionPower | null | undefined): FactionTier {
  const p = power ?? { yuanying: 0, jiedan: 0, zhuji: 0 };
  if (p.yuanying >= 1) return "元婴坐镇";
  if (p.jiedan >= 3) return "一方势力";
  if (p.jiedan >= 1) return "中等势力";
  if (p.zhuji >= 5) return "小势力";
  return "微末势力";
}

/** 战力行文本：`元婴0·结丹2·筑基9`。 */
export function formatFactionPower(power: FactionPower | null | undefined): string {
  const p = power ?? { yuanying: 0, jiedan: 0, zhuji: 0 };
  return `元婴${p.yuanying}·结丹${p.jiedan}·筑基${p.zhuji}`;
}

export interface FactionGroup {
  tier: FactionTier;
  items: Faction[];
}

export function useFactionStore() {
  const factions = ref<Map<string, Faction>>(new Map());

  /** 已登记势力列表（按档位从强到弱、同档位按名称排序）。 */
  function listFactions(): Faction[] {
    const all = Array.from(factions.value.values());
    return all.sort((a, b) => {
      const ta = FACTION_TIER_ORDER.indexOf(factionStrengthTier(a.power));
      const tb = FACTION_TIER_ORDER.indexOf(factionStrengthTier(b.power));
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
  }

  function getFaction(name: string): Faction | null {
    const key = oneLine(name);
    return key ? factions.value.get(key) ?? null : null;
  }

  /**
   * 新增或合并一个势力。
   *
   * 已存在时只覆盖「提供了的字段」（`undefined` 视为未提供），
   * 避免 AI 增量事件把玩家手改过的内容冲掉。
   *
   * @returns 写入后的势力；名称为空返回 null。
   */
  function upsertFaction(next: Faction): Faction | null {
    const name = oneLine(next.name);
    if (!name) return null;
    const prev = factions.value.get(name);
    const merged: Faction = {
      name,
      type: oneLine(next.type) || prev?.type || "未知",
      locationText: oneLine(next.locationText) || prev?.locationText || "",
      power: normalizeFactionPower(next.power ?? prev?.power),
      demands: oneLine(next.demands) || prev?.demands || "",
      relation: oneLine(next.relation) || prev?.relation || "无交集",
      desc: oneLine(next.desc) || prev?.desc || "",
    };
    factions.value.set(name, merged);
    return merged;
  }

  /**
   * 应用状态 AI 的势力变更事件。
   *
   * `update` 时若势力不存在则丢弃并返回 false（调用方负责 warn）——
   * 宁可漏更新，也不凭空造一个玩家没探知过的势力。
   */
  function applyFactionChange(change: FactionChange): boolean {
    const name = oneLine(change.name);
    if (!name) return false;
    if (change.op === "update" && !factions.value.has(name)) return false;
    const prev = factions.value.get(name);
    const merged = upsertFaction({
      name,
      type: change.type ?? prev?.type ?? "未知",
      locationText: change.locationText ?? prev?.locationText ?? "",
      power: normalizeFactionPower({
        yuanying: change.power?.yuanying ?? prev?.power.yuanying,
        jiedan: change.power?.jiedan ?? prev?.power.jiedan,
        zhuji: change.power?.zhuji ?? prev?.power.zhuji,
      }),
      demands: change.demands ?? prev?.demands ?? "",
      relation: change.relation ?? prev?.relation ?? "无交集",
      desc: change.desc ?? prev?.desc ?? "",
    });
    return merged !== null;
  }

  function removeFaction(name: string): boolean {
    const key = oneLine(name);
    return key ? factions.value.delete(key) : false;
  }

  /** 按强度档位分组（UI 列表用，空档位不返回）。 */
  function groupFactionsByTier(): FactionGroup[] {
    const buckets = new Map<FactionTier, Faction[]>();
    for (const f of listFactions()) {
      const tier = factionStrengthTier(f.power);
      const arr = buckets.get(tier);
      if (arr) arr.push(f);
      else buckets.set(tier, [f]);
    }
    return FACTION_TIER_ORDER.filter((t) => buckets.has(t)).map((tier) => ({
      tier,
      items: buckets.get(tier) ?? [],
    }));
  }

  /**
   * 势力快照（注入剧情 AI / 状态 AI 用）。
   *
   * 每个势力一行，含名称、类型、驻地、档位、战力、诉求、与主角关系——
   * 让 AI 能直接拿诉求与关系去生长事件，而不是凭空编新势力。
   * 无势力时返回空串（调用方据此不注入该块）。
   */
  function formatFactionSnapshot(): string {
    const all = listFactions();
    if (all.length === 0) return "";
    return all
      .map((f) => {
        const parts = [
          `${f.name}（${f.type}）`,
          f.locationText ? `驻地:${f.locationText}` : "",
          `档位:${factionStrengthTier(f.power)}`,
          `战力:${formatFactionPower(f.power)}`,
          f.demands ? `诉求:${f.demands}` : "",
          `与主角:${f.relation}`,
        ].filter(Boolean);
        return "- " + parts.join(" · ");
      })
      .join("\n");
  }

  function serializeFactions(): Faction[] {
    return Array.from(factions.value.values()).map((f) =>
      JSON.parse(JSON.stringify(f)) as Faction,
    );
  }

  /** 从存档恢复；数据缺省或非法时得到空表（旧存档无此字段即走这条）。 */
  function restoreFactions(data: Faction[] | null | undefined): void {
    const next = new Map<string, Faction>();
    if (Array.isArray(data)) {
      for (const raw of data) {
        if (!raw || typeof raw !== "object") continue;
        const name = oneLine(raw.name);
        if (!name) continue;
        next.set(name, {
          name,
          type: oneLine(raw.type) || "未知",
          locationText: oneLine(raw.locationText),
          power: normalizeFactionPower(raw.power),
          demands: oneLine(raw.demands),
          relation: oneLine(raw.relation) || "无交集",
          desc: oneLine(raw.desc),
        });
      }
    }
    factions.value = next;
  }

  function clearFactions(): void {
    factions.value = new Map();
  }

  return {
    factions,
    listFactions,
    getFaction,
    upsertFaction,
    applyFactionChange,
    removeFaction,
    groupFactionsByTier,
    formatFactionSnapshot,
    serializeFactions,
    restoreFactions,
    clearFactions,
  };
}

export const factionStore = useFactionStore();
