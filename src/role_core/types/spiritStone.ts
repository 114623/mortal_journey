/**
 * 灵石：统一货币，不区分品阶。
 * 功能函数见 `spiritStoneUtils.ts`。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 灵石在储物袋中的名称 */
export type SpiritStoneName = "灵石";

/** 灵石描述 */
export const SPIRIT_STONE_DESC = "修仙界通用货币，蕴含灵气，用于交易和修炼。" as const;

// ---------------------------------------------------------------------------
// 储物袋堆叠（无 `itemType`，用 `type` 与装备/材料等区分）
// ---------------------------------------------------------------------------

/** 灵石在储物袋中与 `CategorizedItemDefinition` 的判别字面量 */
export const SPIRIT_STONE_INVENTORY_KIND = "灵石" as const;

/** 灵石在储物袋中的堆叠形态 */
export interface SpiritStoneInventoryStack {
  name: SpiritStoneName;
  count: number;
  desc: string;
  type: typeof SPIRIT_STONE_INVENTORY_KIND;
}

// ---------------------------------------------------------------------------
// 从 spiritStoneUtils 再导出功能函数（保持旧 import 路径兼容）
// ---------------------------------------------------------------------------

export { createSpiritStoneInventoryStack } from "../spiritStoneUtils";
