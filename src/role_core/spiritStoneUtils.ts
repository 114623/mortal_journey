/**
 * 灵石功能函数。
 * 类型和常量数据表定义在 `types/spiritStone.ts`。
 */

import {
  SPIRIT_STONE_DESC,
  SPIRIT_STONE_INVENTORY_KIND,
  type SpiritStoneInventoryStack,
} from "./types/spiritStone";

export function createSpiritStoneInventoryStack(count: number): SpiritStoneInventoryStack {
  return {
    name: "灵石",
    count,
    desc: SPIRIT_STONE_DESC,
    type: SPIRIT_STONE_INVENTORY_KIND,
  };
}
