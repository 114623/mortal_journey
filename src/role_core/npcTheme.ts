/**
 * NPC 配色主题：用于弹窗/列表按「性别 + 种族」区分背景色。
 *
 * - 修仙者 / 人形妖兽：按性别着色（男→蓝，女→粉）。
 * - 妖兽（兽形）/ 未知性别：保持默认色系。
 */

export type NpcColorTheme = "male" | "female" | "default";

export function npcColorTheme(gender: string, race: string): NpcColorTheme {
  if (race === "妖兽") return "default";
  if (gender === "女") return "female";
  if (gender === "男") return "male";
  return "default";
}
