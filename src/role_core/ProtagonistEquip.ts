/**
 * @deprecated Use `./CharacterEquip` instead. This file re-exports for backward compatibility.
 */

export {
  type EquipCarrier,
  isTreasureItem,
  findFirstEmptyEquipSlot,
  setGongfaSlot,
  findFirstEmptyGongfaSlot,
  unequipGongfaToInventory,
  equipGongfaFromInventory,
  setEquippedSlot,
  equipFromInventory,
  unequipToInventory,
  applyDetailAction,
} from "./CharacterEquip";
