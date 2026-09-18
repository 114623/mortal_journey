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
  GONGFA_MASTERY_ATTRI_MULT,
  PROFILE_FIELD_MAX_LENGTH,
  MEMORY_MAX_LENGTH,
  normalizeProfile,
} from "./types/playInfo";
import {
  getRealmPrimaryStats,
} from "./realmUtils";
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
import { tierFactor, resolveItemTier, gongfaTierFactor } from "./types/itemTier";

const HP_PER_PHYSIQUE = 10;
const MP_PER_SPIRIT = 10;

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
    this.profile = normalizeProfile(data.profile);
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
    for (const gf of this.gongfaSlots) {
      if (!gf) continue;
      const mastery = gf.mastery ?? 1;
      const masteryMult = GONGFA_MASTERY_ATTRI_MULT[Math.min(mastery, GONGFA_MASTERY_ATTRI_MULT.length) - 1];
      // 功法阶层压制：低阶功法被高阶修士修习时加成衰减（凡人武功在练气期只剩一成）。
      const tierF = gongfaTierFactor(gf.tier, this.realm.major);
      const adjusted: Record<string, number> = {};
      for (const [k, v] of Object.entries(gf.bonus as Record<string, number>)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          adjusted[k] = Math.trunc(v * masteryMult * tierF);
        }
      }
      Character.addZhItemBonusInto(primaryStats, adjusted);
    }
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
   * 转换比率会先按 {@link tierFactor} 做跨阶压制（低阶法宝被高阶修士使用时
   * 威能衰减，高阶法宝被低阶修士使用时受器灵封印），再返回。
   * 由于主属性与 HP/MP 上限都读这里的结果，两处压制自然保持一致。
   *
   * @returns 所有已装备法宝 `specialEffect.conversions` 的扁平列表（比率已压制）。
   */
  protected collectEquippedConversions(): TreasureConversion[] {
    const out: TreasureConversion[] = [];
    for (const tr of this.equippedSlots) {
      if (!tr || !tr.specialEffect) continue;
      const f = tierFactor(resolveItemTier(tr.tier, tr.grade), this.realm.major);
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
   * 设置画像来源：ai=AI 可继续维护；manual=玩家锁定，AI 不再覆写。
   */
  setProfileSource(source: "ai" | "manual"): void {
    this.profile.source = source === "manual" ? "manual" : "ai";
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
      this.setProfileMemory(patch.memory.trim());
      changed = true;
    }
    return changed;
  }

  // ===================================================================
  // 储物袋（委托给 CharacterInventory）
  // ===================================================================

  setInventorySlot(index: number, item: InventoryStackItem | null): boolean {
    if (item) applyLinggenElixirBoost(item, this.linggen, this.realm.major);
    return invSetSlot(this, index, item);
  }

  addToInventory(item: InventoryStackItem): number {
    applyLinggenElixirBoost(item, this.linggen, this.realm.major);
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
