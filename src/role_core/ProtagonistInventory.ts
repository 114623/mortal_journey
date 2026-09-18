/**
 * @deprecated Use `./CharacterInventory` instead. This file re-exports for backward compatibility.
 */

export {
  type InventoryCarrier,
  DEFAULT_INVENTORY_SLOT_COUNT,
  INVENTORY_SLOT_EXPAND_STEP,
  expandInventorySlots,
  findFirstEmptyInventorySlot,
  findFirstEmptyInventorySlotOrExpand,
  compactInventorySlotsInPlace,
  setInventorySlot,
  addToInventory,
  addSpiritStone,
  removeSpiritStone,
} from "./CharacterInventory";
