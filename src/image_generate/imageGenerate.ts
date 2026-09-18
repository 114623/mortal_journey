/**
 * @fileoverview 文生图高层编排：构建 prompt → 同步生成 → base64 转 JPEG dataURL。
 *
 * 返回的 dataURL 规格与手动上传一致（主角 512×512 / NPC 683×1024），可直接喂给 `setAvatarUrl`。
 * 因 Ark 4.0+ 模型请求 2K 大图，这里复用 {@link ../main-screen/avatarUpload.ts} 的 canvas 缩放
 * 管线下采样到目标尺寸，保证产物与存档格式统一。
 */

import { gameLog } from "../log/gameLog";
import { generateImageSync } from "./volcImageBridge";
import { getArkImageConfig } from "./useImageApiConfig";
import { SHAPE_SIZE, type ImageShape } from "./types";
import { resizeImageFileToAvatar, resizeImageFileToPortrait, resizeImageFileToLandscape } from "../main-screen/avatarUpload";
import { buildNpcPortraitPrompt, buildProtagonistPortraitPrompt, buildLocationBackgroundPrompt } from "./promptBuilder";
import type { Npc } from "../role_core/Npc";
import type { Protagonist } from "../role_core/Protagonist";
import type { WorldLocation } from "../role_core/types/worldLocation";

/**
 * 生成一张图：同步请求 → 返回 JPEG dataURL。
 *
 * @param prompt 文生图提示词。
 * @param shape 目标形状（决定请求 size 与最终缩放）。
 * @param signal 可选中断信号。
 * @return 归一化后的 JPEG dataURL，可直接喂给 `setAvatarUrl`。
 * @throws {Error} 未配置、Ark 返回 `error`、超时、或被 signal 中断。
 */
export async function generateImage(prompt: string, shape: ImageShape, signal?: AbortSignal): Promise<string> {
  const cfg = getArkImageConfig();
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error("文生图未配置，请在「API设置」中填写地址与模型。");
  }

  gameLog.info(`[图 生成] shape=${shape}`);
  const dataUrl = await generateImageSync({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    prompt,
    size: SHAPE_SIZE[shape],
    signal,
  });

  // 2K 大图下采样到目标尺寸，复用现有缩放管线（含背景填充、JPEG 0.85 质量）。
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], "volc-gen.jpg", { type: blob.type || "image/jpeg" });
  let normalized: string;
  if (shape === "square") {
    normalized = await resizeImageFileToAvatar(file);
  } else if (shape === "landscape") {
    normalized = await resizeImageFileToLandscape(file);
  } else {
    normalized = await resizeImageFileToPortrait(file);
  }
  gameLog.info(`[图 完成] shape=${shape} -> dataURL`);
  return normalized;
}

/**
 * 为 NPC 生成 683×1024 立绘：拼 prompt → 生成 → 返回 JPEG dataURL。
 *
 * @throws {Error} 同 {@link generateImage}。
 */
export async function generateNpcPortrait(npc: Npc, signal?: AbortSignal): Promise<string> {
  const prompt = buildNpcPortraitPrompt(npc);
  return generateImage(prompt, "portrait", signal);
}

/**
 * 为主角生成 683×1024 立绘：拼 prompt → 生成 → 返回 JPEG dataURL。
 *
 * Prompt 综合性别、境界、年龄感、出身、天赋、灵根、法宝与功法信息，
 * 确保生成帅气/美丽的修仙者立绘。
 *
 * @throws {Error} 同 {@link generateImage}。
 */
export async function generateProtagonistPortrait(
  protagonist: Protagonist,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildProtagonistPortraitPrompt(protagonist);
  return generateImage(prompt, "portrait", signal);
}

/**
 * 为地点生成 1024×768 横版背景图：拼 prompt → 生成 → 返回 JPEG dataURL。
 *
 * @param location 世界地点（四层结构）。
 * @param realmMajor 当前主角境界（用于氛围注入，可选）。
 * @throws {Error} 同 {@link generateImage}。
 */
export async function generateLocationBackground(
  location: WorldLocation,
  realmMajor?: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildLocationBackgroundPrompt(location, realmMajor);
  return generateImage(prompt, "landscape", signal);
}
