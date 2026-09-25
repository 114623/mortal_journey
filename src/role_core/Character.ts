import type { InventoryStackItem } from "./types/itemInfo";
import type {
  CultivationRealm,
  EquippedSlotsState,
  GongfaSlotsState,
  EquipSlotKey,
  ProtagonistDetailAction,
  PrimaryStatKey,
  CharacterPlayInfoCommon,
  CharacterProfile,
} from "./types/playInfo";
import {
  PRIMARY_STAT_KEYS,
  PRIMARY_STAT_KEY_TO_ZH,
  EQUIP_SLOT_COUNT,
  GONGFA_SLOT_COUNT,
  TABLE,
  PROFILE_FIELD_MAX_LENGTH,
  MEMORY_MAX_LENGTH,
  MEMORY_COMPRESS_THRESHOLD,
  normalizeProfile,
} from "./types/playInfo";
import {
  getRealmPrimaryStats,
  gongfaContLayer,
  inheritGongfaProgress,
} from "./realmUtils";
import { gongfaLayerValue, gongfaTypicalValue, finalizeZhBonus } from "./realmScale";
import type { SpiritStoneName } from "./types/spiritStone";
import {
  DEFAULT_INVENTORY_SLOT_COUNT,
  INVENTORY_SLOT_EXPAND_STEP,
  setInventorySlot as invSetSlot,
  addToInventory as invAdd,
  addSpiritStone as invAddStone,
  removeSpiritStone as invRemoveStone,
} from "./CharacterInventory";
import {
  isTreasureItem,
  setGongfaSlot as eqSetGongfa,
  unequipGongfaToInventory as eqUnequipGf,
  equipGongfaFromInventory as eqEquipGf,
  setEquippedSlot as eqSetEquip,
  equipFromInventory as eqEquip,
  unequipToInventory as eqUnequip,
  applyDetailAction as eqApply,
} from "./CharacterEquip";
import { applyLinggenElixirBoost } from "./types/elixir";
import { applyStatConversions, applyResourceConversions, type TreasureConversion } from "./types/treasure";
import { treasureTierFactor, resolveItemTier, gongfaTierFactor, ensureGongfaTier } from "./types/itemTier";
import { guardMemoryUpdate, splitMemoryEntries, stripMemoryJsonShell } from "./memoryLog";
import type { WorldTime } from "./worldTime";
import type { CharacterBuff } from "./types/characterBuff";
import { normalizeBuffs, pruneExpiredBuffs, sumBuffResourcePct } from "./types/characterBuff";
import { gameLog } from "../log/gameLog";

const HP_PER_PHYSIQUE = 10;
const MP_PER_SPIRIT = 10;

/**
 * 【机缘·续作承继】功法入袋/装备时，若它标注了 `inheritFrom`（后续篇 / 续写 / 补全残卷），
 * 且持有者名下确有那门旧功法，就沿用其修炼进度——按进度比例折算到本篇层数。
 *
 * 与 `ensureGongfaTier` 同挂在「物品进入角色」的收口点，覆盖 AI 掉落、命运抉择、
 * 天道编辑、NPC 卡片全部来源；找不到源功法或未标注时静默跳过。
 */
export function applyGongfaInheritance(
  holder: { gongfaSlots?: readonly unknown[] | null; inventorySlots?: readonly unknown[] | null },
  item: unknown,
): boolean {
  if (!item || typeof item !== "object") return false;
  const rec = item as Record<string, unknown>;
  if (rec.itemType !== "功法") return false;
  const srcName = typeof rec.inheritFrom === "string" ? rec.inheritFrom.trim() : "";
  if (!srcName) return false;
  let src: unknown = null;
  for (const arr of [holder.gongfaSlots, holder.inventorySlots]) {
    if (!Array.isArray(arr)) continue;
    for (const g of arr) {
      if (!g || typeof g !== "object") continue;
      const gr = g as Record<string, unknown>;
      if (gr.itemType === "功法" && gr.name === srcName && g !== item) {
        src = g;
        break;
      }
    }
    if (src) break;
  }
  if (!src) return false;
  const got = inheritGongfaProgress(src as never, item as never);
  if (!got) return false;
  rec.mastery = got.mastery;
  rec.masteryExp = got.masteryExp;
  return true;
}

/**
 * 规范化丹药/天赋加成映射：仅保留有限且非零的数值项。
 *
 * 用于反序列化（`Protagonist.fromJson` / `Npc.fromJson`）时恢复 `elixirBonuses`，
 * 避免存档中该字段被丢弃导致属性加成在刷新/读档后消失。
 */
export function normalizeElixirBonuses(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) out[k] = v;
  }
  return out;
}

export class Character {

  id: string;
  displayName: string;
  realm: CultivationRealm;
  primaryStats: Record<PrimaryStatKey, number>;
  maxHp: number;
  maxMp: number;
  currentHp: number;
  currentMp: number;
  avatarUrl: string;
  gender: string;
  linggen: string[];
  age: number;
  ageConfirmed: boolean;
  shouyuan: number;
  equippedSlots: EquippedSlotsState;
  gongfaSlots: GongfaSlotsState;
  inventorySlots: Array<InventoryStackItem | null>;
  elixirBonuses: Record<string, number>;
  /**
   * 角色持久增益/减益（跨战斗、进存档），如重伤后的「气血亏虚」。
   *
   * 到期判定需要「当前世界时间」，由外部调 {@link pruneBuffs} 触发，
   * 角色层不反向依赖 storyStore（避免模块环）。
   */
  buffs: CharacterBuff[];
  /** 角色画像提示词（性格/外貌/记忆），NPC 由 AI 生成、主角由玩家填写。 */
  profile: CharacterProfile;

  constructor(data: CharacterPlayInfoCommon) {
    this.id = data.id;
    this.displayName = data.displayName;
    this.realm = data.realm;
    this.primaryStats = { ...data.primaryStats };
    this.maxHp = data.maxHp;
    this.maxMp = data.maxMp;
    this.currentHp = data.currentHp;
    this.currentMp = data.currentMp;
    this.avatarUrl = data.avatarUrl;
    this.gender = data.gender;
    this.linggen = data.linggen;
    this.age = data.age;
    this.ageConfirmed = data.ageConfirmed;
    this.shouyuan = data.shouyuan;
    this.equippedSlots = data.equippedSlots;
    this.gongfaSlots = data.gongfaSlots;
    this.inventorySlots = data.inventorySlots;
    this.elixirBonuses = data.elixirBonuses ? { ...data.elixirBonuses } : {};
    this.buffs = normalizeBuffs(data.buffs);
    this.profile = normalizeProfile(data.profile);
  }

  // ===================================================================
  // 持久 buff（跨战斗）
  // ===================================================================

  /**
   * 按当前世界时间剔除已过期的 buff。
   *
   * 应在推进回合 / 战斗结算 / 打开面板等持有 worldTime 的地方调用；
   * 角色层自己拿不到 now，故不做惰性清理。
   *
   * @returns 被剔除的条数（0 表示无变化）。
   */
  pruneBuffs(now: WorldTime | null | undefined): number {
    if (!now || this.buffs.length === 0) return 0;
    const { kept, removed } = pruneExpiredBuffs(this.buffs, now);
    if (removed.length === 0) return 0;
    this.buffs = kept;
    return removed.length;
  }

  /** 当前 buff 对血/法上限的合计百分点（-30 表示上限打七折）。 */
  buffResourcePct(): { maxHpPct: number; maxMpPct: number } {
    return sumBuffResourcePct(this.buffs);
  }

  // ===================================================================
  // 静态格式化
  // ===================================================================

  static formatLinggenElements(elements: string[]): string {
    const els = elements.map((e) => String(e).trim()).filter(Boolean);
    return els.length ? els.join("") : "—";
  }

  static formatRealm(realm: CultivationRealm): string {
    const major = realm.major?.trim() || "—";
    const minor = realm.minor?.trim() || "";
    return minor ? `${major}${minor}` : major;
  }

  // ===================================================================
  // 主属性计算
  // ===================================================================

  protected static readonly ZH_BONUS_TO_PRIMARY_KEY: Readonly<Record<string, PrimaryStatKey>> = (() => {
    const o: Record<string, PrimaryStatKey> = {};
    for (const en of Object.keys(PRIMARY_STAT_KEY_TO_ZH) as PrimaryStatKey[]) {
      o[PRIMARY_STAT_KEY_TO_ZH[en]] = en;
    }
    return o;
  })();

  protected realmTableBaseOrStored(): Record<PrimaryStatKey, number> {
    const fromTable = getRealmPrimaryStats(this.realm.major, this.realm.minor);
    return fromTable ? { ...fromTable } : { ...this.primaryStats };
  }

  private static addZhItemBonusInto(
    target: Record<string, number>,
    bonus: Record<string, number | undefined> | undefined,
    realmRatio = 1,
  ): void {
    if (!bonus || typeof bonus !== "object") return;
    const r = typeof realmRatio === "number" && Number.isFinite(realmRatio) && realmRatio > 0 ? realmRatio : 1;
    for (const [zh, v] of Object.entries(bonus)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const key = Character.ZH_BONUS_TO_PRIMARY_KEY[zh];
      if (!key) continue;
      target[key] = (target[key] ?? 0) + Math.trunc(v * r);
    }
  }

  protected collectPrimaryBonuses(): Record<string, number> {
    const base = this.realmTableBaseOrStored();
    const primaryStats: Record<string, number> = {};
    for (const k of PRIMARY_STAT_KEYS) {
      primaryStats[k] = base[k] ?? 0;
    }
    // 功法加成改为「先浮点累加、最后统一取整」：
    // 原先每条功法各自 trunc，多件小幅加成的截断误差会累积（低数值甚至被截成 0），
    // 统一取整并保底 1 之后，装了就一定有效果。
    const gongfaAcc: Record<string, number> = {};
    for (const gf of this.gongfaSlots) {
      if (!gf) continue;
      // 【2026-09-25 v4】加成由**连续层号**唯一决定（同层同值，与功法阶层无关），
      // 阶层唯一的作用是通过 gongfaMaxLayerOf 决定这功法能修到第几层。
      // 连续层号让层内经验立刻反映到面板，层数退化为纯里程碑。
      const contLayer = gongfaContLayer(gf);
      // 仅凡人 tier 保留衰减（凡俗之物不入修行：练气期 40%、筑基起归零），
      // 练气及以上恒为 1——自然淘汰靠「绝对值固定 + 境界基准上涨」实现。
      const tierF = gongfaTierFactor(gf.tier, this.realm.major);
      const isMortal = gf.tier === "凡人";
      for (const [zh, v] of Object.entries(gf.bonus as Record<string, number>)) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        // 凡人武功论外：保持旧口径「原始词条值 × 2.0」，不查层号曲线。
        const add = isMortal
          ? v * 2.0
          : (v / Math.max(1, gongfaTypicalValue(zh))) * gongfaLayerValue(zh, contLayer);
        gongfaAcc[zh] = (gongfaAcc[zh] ?? 0) + add * tierF;
      }
    }
    Character.addZhItemBonusInto(primaryStats, finalizeZhBonus(gongfaAcc));
    for (const [k, v] of Object.entries(this.elixirBonuses)) {
      if (typeof v === "number" && v !== 0) primaryStats[k] = (primaryStats[k] ?? 0) + v;
    }
    // 法宝特殊效果：主属性转换（仅仙品/神品法宝生效）
    const statConversions = this.collectEquippedConversions().filter(c => c.target === "stat");
    if (statConversions.length > 0) {
      const converted = applyStatConversions(primaryStats as Record<PrimaryStatKey, number>, statConversions);
      for (const k of PRIMARY_STAT_KEYS) primaryStats[k] = converted[k];
    }
    return primaryStats;
  }

  /**
   * 汇总当前已装备法宝的特殊效果转换项。
   *
   * 转换比率会先按 {@link treasureTierFactor} 做跨阶压制（低阶法宝按 0.65^Δ 削弱，
   * 高阶法宝被低阶修士使用时受器灵封印；凡人阶走专属衰减），再返回。
   * 由于主属性与 HP/MP 上限都读这里的结果，两处压制自然保持一致。
   *
   * @returns 所有已装备法宝 `specialEffect.conversions` 的扁平列表（比率已压制）。
   */
  protected collectEquippedConversions(): TreasureConversion[] {
    const out: TreasureConversion[] = [];
    for (const tr of this.equippedSlots) {
      if (!tr || !tr.specialEffect) continue;
      const f = treasureTierFactor(resolveItemTier(tr.tier, tr.grade), this.realm.major);
      for (const c of tr.specialEffect.conversions) {
        out.push(f >= 1 ? c : { ...c, ratio: c.ratio * f });
      }
    }
    return out;
  }

  getComputedPrimaryStats(): Readonly<Record<PrimaryStatKey, number>> {
    return this.collectPrimaryBonuses() as Readonly<Record<PrimaryStatKey, number>>;
  }

  getPrimaryStats(): Readonly<Record<PrimaryStatKey, number>> {
    return this.getComputedPrimaryStats();
  }

  computeMaxHpMp(): { maxHp: number; maxMp: number } {
    const stats = this.getComputedPrimaryStats();
    const realmRow = this.getRealmRow();
    const baseHp = realmRow?.hp ?? 200;
    const baseMp = realmRow?.mp ?? 100;
    let maxHp = Math.max(1, Math.round((baseHp + stats.physique * HP_PER_PHYSIQUE) * (1 + stats.physique / 1000)));
    let maxMp = Math.max(1, Math.round((baseMp + stats.spirit * MP_PER_SPIRIT) * (1 + stats.spirit / 1000)));
    // 持久 buff 的血/法上限增减（如重伤后的「气血亏虚 −30%」）。
    // 注意在资源转换**之前**应用：转换读的是「受伤后的上限」，符合直觉。
    const bp = this.buffResourcePct();
    if (bp.maxHpPct !== 0) maxHp = Math.max(1, Math.round(maxHp * (1 + bp.maxHpPct / 100)));
    if (bp.maxMpPct !== 0) maxMp = Math.max(1, Math.round(maxMp * (1 + bp.maxMpPct / 100)));
    // 法宝特殊效果：血量/法力上限转换（仅仙品/神品法宝生效）
    const resConversions = this.collectEquippedConversions().filter(c => c.target === "mpToHp" || c.target === "hpToMp");
    if (resConversions.length > 0) {
      const r = applyResourceConversions(maxHp, maxMp, resConversions);
      maxHp = r.maxHp;
      maxMp = r.maxMp;
    }
    return { maxHp, maxMp };
  }

  protected getRealmRow(): { hp: number; mp: number } | null {
    for (const row of TABLE) {
      if (row.realm === this.realm.major && row.stage === this.realm.minor) {
        return row;
      }
    }
    return null;
  }

  // ===================================================================
  // 生命 / 法力（HP / MP）
  // ===================================================================

  setCurrentHpMp(currentHp: number, currentMp: number): void {
    const maxH = Math.max(1, this.maxHp);
    const maxM = Math.max(1, this.maxMp);
    this.currentHp = Math.max(0, Math.min(maxH, Math.round(currentHp)));
    this.currentMp = Math.max(0, Math.min(maxM, Math.round(currentMp)));
  }

  setMaxHpMp(maxHp: number, maxMp: number): void {
    this.maxHp = Math.max(1, Math.floor(maxHp));
    this.maxMp = Math.max(1, Math.floor(maxMp));
    this.currentHp = Math.min(this.currentHp, this.maxHp);
    this.currentMp = Math.min(this.currentMp, this.maxMp);
  }

  // ===================================================================
  // 境界 · 年龄 · 寿元 · 名称 · 头像 · 属性
  // ===================================================================

  setRealm(major: string, minor: string): void {
    this.realm = {
      major: major.trim() || "练气",
      minor: minor.trim() || "初期",
    };
  }

  setAge(age: number): void {
    this.age = typeof age === "number" && Number.isFinite(age) ? Math.max(0, Math.floor(age)) : this.age;
  }

  setShouyuan(n: number): void {
    this.shouyuan = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : this.shouyuan;
  }

  setDisplayName(name: string): void {
    this.displayName = String(name).trim() || "未命名";
  }

  setAvatarUrl(url: string): void {
    this.avatarUrl = url != null ? String(url) : "";
  }

  patchPrimaryStats(partial: Partial<Record<PrimaryStatKey, number>>): void {
    for (const k of PRIMARY_STAT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) {
        const v = partial[k];
        if (typeof v === "number" && Number.isFinite(v)) this.primaryStats[k] = v;
      }
    }
  }

  // ===================================================================
  // 角色画像提示词（性格 / 外貌 / 记忆）
  // ===================================================================

  /**
   * 读取外貌提示词。
   *
   * NPC 覆写为文生图核心字段 `appearance`（两者本就是同一段描述，改一处即同步立绘 prompt）；
   * 主角读 `profile.appearance`。
   */
  getProfileAppearance(): string {
    return this.profile.appearance;
  }

  /**
   * 写入外貌提示词。NPC 覆写到文生图核心字段 `appearance`。
   */
  setProfileAppearance(text: string): void {
    this.profile.appearance = String(text ?? "").slice(0, PROFILE_FIELD_MAX_LENGTH);
  }

  /** 写入性格提示词。 */
  setProfilePersonality(text: string): void {
    this.profile.personality = String(text ?? "").slice(0, PROFILE_FIELD_MAX_LENGTH);
  }

  /** 写入记忆提示词。记忆无硬上限，仅受安全上限保护（体积由「超阈值压缩」控制）。 */
  setProfileMemory(text: string): void {
    this.profile.memory = String(text ?? "").slice(0, MEMORY_MAX_LENGTH);
  }

  /**
   * 就地自愈「记忆被存成 JSON 外壳」的老存档。
   *
   * 历史版本曾把主角记忆写成 `{"full":…,"entries":[…]}`，这种文本进入「只追加」
   * 逻辑后会被当成一条旧条目，每轮整份再复制一遍，越滚越大且无法解析
   * （详见 {@link stripMemoryJsonShell} 的文档）。读写记忆前先调一次即可修好，
   * 不需要额外的存档迁移脚本。
   *
   * @returns 是否做了剥离（true 时 `profile.memory` 已被就地改写）。
   */
  private healMemoryJsonShell(): boolean {
    const shell = stripMemoryJsonShell(this.profile.memory);
    if (!shell.stripped || shell.text === this.profile.memory) return false;
    const before = String(this.profile.memory ?? "").length;
    this.setProfileMemory(shell.text);
    gameLog.warn(
      `[画像] ${this.displayName} 的记忆是 JSON 外壳（${before} 字），` +
        `已剥离为纯文本日志（${shell.text.length} 字）。`,
    );
    return true;
  }

  /**
   * 设置画像来源：ai=AI 可继续维护；manual=玩家锁定，AI 不再覆写。
   */
  setProfileSource(source: "ai" | "manual"): void {
    this.profile.source = source === "manual" ? "manual" : "ai";
  }

  /**
   * 主角记忆通道：追加 / 替换 AI 维护的记忆日志（**只动 memory**，性格与外貌不由 AI 管）。
   *
   * 与 {@link applyAiProfile} 的两点区别：
   *   1. 主角的性格 / 外貌是玩家设定，AI 一律不碰，故单独开一条只写记忆的通道；
   *   2. 主角画像整体可能是 `source:"manual"`，但记忆是 AI 维护的日志，不受该锁定影响。
   *
   * @param entries 本轮新增条目（三行一条，新的在前），见 `memoryLog` 的格式约定。
   * @param fullText 压缩轮专用：AI 提炼后的**整段**记忆；给了它就以它为准（仍走只追加校验）。
   * @returns 是否实际写入。
   */
  appendAiMemoryEntries(entries: string[], fullText?: string): boolean {
    // ① 先自愈旧存档的 JSON 外壳：不剥掉的话，下面的 splitMemoryEntries 会把整段
    //    JSON 当成「旧条目」，每轮把它整体再追加一份（实测滚到 4922 字 / 6 份）。
    this.healMemoryJsonShell();
    // ② AI 也可能把单条"条目"写成 JSON 外壳（它照着提示词里的样子回传），逐条剥。
    const incoming = (entries ?? [])
      .map((e) => stripMemoryJsonShell(String(e ?? "").replace(/\r\n?/g, "\n")).text.trim())
      .filter((e) => e.length > 0);
    const full = String(fullText ?? "").replace(/\r\n?/g, "\n").trim();
    if (!full && incoming.length === 0) return false;

    // 主角记忆的契约是「只给本轮新增条目」，整段（full）只在压缩轮才合法。
    // 没超阈值时模型若越权回传整段，直接丢弃整段、只取新增条目——否则玩家手写的
    // 条目会被模型的一版重写整体顶掉。
    const compressing = String(this.profile.memory ?? "").trim().length > MEMORY_COMPRESS_THRESHOLD;
    const useFull = compressing ? full : "";

    const next = useFull || [...incoming, ...splitMemoryEntries(this.profile.memory)].join("\n\n");
    const guarded = guardMemoryUpdate(this.profile.memory, next);
    if (guarded.repaired) {
      gameLog.warn(
        `[画像] ${this.displayName} 的记忆含 ${guarded.rewritten} 条改写、${guarded.missing} 条丢失，` +
          `已按「只追加」回滚`,
      );
    }
    if (guarded.text === this.profile.memory) return false;
    this.setProfileMemory(guarded.text);
    return true;
  }

  /**
   * 应用 AI 生成 / 更新的画像片段（性格 / 记忆）。
   *
   * 玩家已手动锁定（`source === "manual"`）时整体拒绝写入并返回 false，
   * 避免玩家设定被下一回合的 AI 输出冲掉。
   *
   * @param patch AI 输出的画像片段；空字符串视为「不更新」。
   * @returns 是否实际写入了内容。
   */
  applyAiProfile(patch: { personality?: string; memory?: string }): boolean {
    if (this.profile.source === "manual") return false;
    let changed = false;
    if (typeof patch.personality === "string" && patch.personality.trim()) {
      this.setProfilePersonality(patch.personality.trim());
      changed = true;
    }
    if (typeof patch.memory === "string" && patch.memory.trim()) {
      // 记忆是「只追加、不改旧条目」的日志：AI 每回合返回整段文本，容易顺手润色旧条目，
      // 这里按时间行逐条校验，改写过的版本会被回滚成「旧条目原样 + 新条目追加到顶部」。
      // 进守卫前先剥掉可能的 JSON 外壳（模型照着提示词里的样子回传时会带）。
      this.healMemoryJsonShell();
      const incoming = stripMemoryJsonShell(patch.memory.trim()).text;
      const guarded = guardMemoryUpdate(this.profile.memory, incoming);
      if (guarded.repaired) {
        gameLog.warn(
          `[画像] ${this.displayName} 的记忆含 ${guarded.rewritten} 条改写、${guarded.missing} 条丢失，` +
            `已按「只追加」回滚`,
        );
      }
      this.setProfileMemory(guarded.text);
      changed = true;
    }
    return changed;
  }

  // ===================================================================
  // 储物袋（委托给 CharacterInventory）
  // ===================================================================

  setInventorySlot(index: number, item: InventoryStackItem | null): boolean {
    if (item) {
      applyLinggenElixirBoost(item, this.linggen, this.realm.major);
      // 阶层兜底：AI / 天道编辑 / 命运抉择漏填 tier 的功法，入袋时按当前境界固化。
      ensureGongfaTier(item, this.realm.major);
      applyGongfaInheritance(this, item);
    }
    return invSetSlot(this, index, item);
  }

  addToInventory(item: InventoryStackItem): number {
    applyLinggenElixirBoost(item, this.linggen, this.realm.major);
    // 同上：所有「物品进入角色」的路径都收口到这里，功法阶层在此一次补齐。
    ensureGongfaTier(item, this.realm.major);
    applyGongfaInheritance(this, item);
    return invAdd(this, item);
  }

  // ===================================================================
  // 灵石（委托给 CharacterInventory）
  // ===================================================================

  addSpiritStone(name: SpiritStoneName, count: number): void {
    invAddStone(this, count);
  }

  removeSpiritStone(name: SpiritStoneName, count: number): void {
    invRemoveStone(this, count);
  }

  // ===================================================================
  // 功法（委托给 CharacterEquip）
  // ===================================================================

  setGongfaSlot(index: number, item: import("./types/itemInfo").GongfaItemDefinition | null): boolean {
    // 直接装备（不经储物袋）的功法同样补阶层，例如天道编辑、NPC 卡片写入。
    if (item) {
      ensureGongfaTier(item, this.realm.major);
      applyGongfaInheritance(this, item);
    }
    return eqSetGongfa(this, index, item);
  }

  unequipGongfaToInventory(gongfaSlotIndex: number): boolean {
    return eqUnequipGf(this, gongfaSlotIndex);
  }

  equipGongfaFromInventory(inventoryIndex: number): boolean {
    return eqEquipGf(this, inventoryIndex);
  }

  // ===================================================================
  // 穿戴（委托给 CharacterEquip）
  // ===================================================================

  setEquippedSlot(slot: EquipSlotKey, item: import("./types/itemInfo").TreasureItemDefinition | null): boolean {
    return eqSetEquip(this, slot, item);
  }

  equipFromInventory(inventoryIndex: number): boolean {
    return eqEquip(this, inventoryIndex);
  }

  unequipToInventory(slot: EquipSlotKey): boolean {
    return eqUnequip(this, slot);
  }

  // ===================================================================
  // 详情弹窗动作
  // ===================================================================

  applyDetailAction(a: ProtagonistDetailAction): boolean {
    return eqApply(this, a);
  }

  // ===================================================================
  // 序列化
  // ===================================================================

  toCommonData(): CharacterPlayInfoCommon {
    return {
      id: this.id,
      displayName: this.displayName,
      realm: this.realm,
      primaryStats: { ...this.primaryStats },
      maxHp: this.maxHp,
      maxMp: this.maxMp,
      currentHp: this.currentHp,
      currentMp: this.currentMp,
      avatarUrl: this.avatarUrl,
      gender: this.gender,
      linggen: this.linggen,
      age: this.age,
      ageConfirmed: this.ageConfirmed,
      shouyuan: this.shouyuan,
      equippedSlots: this.equippedSlots,
      gongfaSlots: this.gongfaSlots,
      inventorySlots: this.inventorySlots,
      elixirBonuses: this.elixirBonuses,
      buffs: this.buffs.map(b => ({ ...b })),
      profile: { ...this.profile },
    };
  }

  // ===================================================================
  // 静态工具方法
  // ===================================================================

  protected static emptyPrimaryStats(): Record<PrimaryStatKey, number> {
    const o: Record<string, number> = {};
    for (const k of PRIMARY_STAT_KEYS) {
      o[k] = 0;
    }
    return o as Record<PrimaryStatKey, number>;
  }
}
