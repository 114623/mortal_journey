/**
 * @fileoverview 文生图（火山引擎方舟 Ark OpenAI 兼容图片生成）相关类型。
 *
 * Ark 接口走纯 Bearer API Key 鉴权、同步返回，与 OpenAI `/v1/images/generations` 一致。
 * 浏览器把配置的 `baseUrl` 当作黑盒：`POST ${baseUrl}/images/generations` + Bearer。
 * 该 base 可为 Ark 直连、自建 CORS 代理、或 one-api 类网关——客户端不关心中转形态。
 *
 * 因 Ark（4.0+ 模型）最小像素 ~3.6M，远超头像目标尺寸，故统一请求 2K 再交给
 * avatarUpload.ts 的 canvas 缩放管线下采样到 512×512 / 683×1024。
 */

/** 文生图 API 配置（localStorage 持久化）。 */
export interface ArkImageConfig {
  /** 中转或 Ark 根地址（如 `https://ark.cn-beijing.volces.com/api/v3` 或代理）。 */
  baseUrl: string;
  /** Ark API Key（Bearer 鉴权）。 */
  apiKey: string;
  /** 模型 ID / Endpoint ID，如 `doubao-seedream-4-0-...`。 */
  model: string;
  /** 是否为新出现的 NPC 自动生成立绘（默认 false）。 */
  autoGenerate: boolean;
}

/** 目标图像形状：主角正方形 / NPC 立绘 / 地点横版背景。 */
export type ImageShape = "square" | "portrait" | "landscape";

/**
 * 各形状对应的请求尺寸（2K 档，4.0+ 模型在 [3.6M, 16M] 区间内）。
 *
 * 返回的 2K 大图会经 avatarUpload.ts 下采样到目标尺寸。
 */
export const SHAPE_SIZE: Record<ImageShape, string> = {
  square: "2048x2048",       // 1:1，4,194,304 px → 512×512
  portrait: "1664x2496",     // 2:3，4,153,344 px → 683×1024
  landscape: "2304x1728",    // 4:3，3,981,312 px → 1024×768
};

/** 单次同步生成请求的超时上限（毫秒）；2K 大图通常 10~30s。 */
export const IMAGE_GEN_TIMEOUT_MS = 120000;
