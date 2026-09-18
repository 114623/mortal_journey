/**
 * @fileoverview 文生图模块 barrel 导出。
 *
 * 走火山引擎方舟 Ark OpenAI 兼容 `/images/generations` 接口。
 * 浏览器把配置的 `baseUrl` 当作黑盒：可为 Ark 直连、自建 CORS 代理、或 one-api 网关。
 */

export type { ArkImageConfig, ImageShape } from "./types";
export { SHAPE_SIZE, IMAGE_GEN_TIMEOUT_MS } from "./types";

export { generateImageSync, pingReachable } from "./volcImageBridge";
export type { GenerateImageParams } from "./volcImageBridge";

export {
  useImageApiConfig,
  isImageApiConfigured,
  isAutoGenerateEnabled,
  getArkImageConfig,
  IMAGE_API_OVERRIDE_KEY,
} from "./useImageApiConfig";
export type { UseImageApiConfigReturn } from "./useImageApiConfig";

export { buildNpcPortraitPrompt, buildProtagonistPortraitPrompt, buildLocationBackgroundPrompt } from "./promptBuilder";

export { generateImage, generateNpcPortrait, generateProtagonistPortrait, generateLocationBackground } from "./imageGenerate";

export { autoGeneratePortraits, autoGenerateLocationBackgrounds } from "./autoPortrait";
