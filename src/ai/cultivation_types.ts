export interface CultivationInput {
  gongfaIndex: number;
  gongfaName: string;
  gongfaGrade: string;
  gongfaSystem: string;
  currentMastery: number;
  currentMasteryExp: number;
  masteryThreshold: number;
  /** 该功法的层数上限（由阶层决定），用于展示「第N/M层」。 */
  maxLayer: number;
  spiritStoneCount: number;
  estimatedMonths: number;
}

export interface CultivationConfirmPayload {
  spiritStoneCount: number;
  estimatedMonths: number;
}
