/**
 * 头像上传与缩放工具。
 *
 * 将玩家选择的图片文件居中裁剪为正方形，再缩放到固定尺寸（默认 512×512），
 * 输出为 JPEG dataURL（默认 0.85 质量）以控制 localStorage 体积。
 *
 * 流程：FileReader.readAsDataURL → 载入 Image → canvas 居中裁剪缩放 → toDataURL。
 */

/** 头像存储分辨率（正方形边长）。 */
export const AVATAR_SIZE = 512;
/** JPEG 编码质量。 */
export const AVATAR_QUALITY = 0.85;

/**
 * 将图片文件处理为指定尺寸的正方形头像 dataURL。
 *
 * 非正方形图片采用「居中裁剪」：取宽高较小的一边作为源正方形边长，居中截取后
 * 等比缩放到目标尺寸，避免拉伸变形。canvas 先填充背景色，防止透明 PNG 转 JPEG
 * 后透明区域变黑。
 *
 * @throws 若文件不是图片类型，或图片解码失败。
 */
export function resizeImageFileToAvatar(
  file: File,
  size: number = AVATAR_SIZE,
  quality: number = AVATAR_QUALITY,
): Promise<string> {
  if (!file.type || !file.type.startsWith("image/")) {
    return Promise.reject(new Error("请选择图片文件。"));
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        reject(new Error("图片读取失败。"));
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error("图片解码失败，请换一张试试。"));
      img.onload = () => {
        try {
          const srcW = img.naturalWidth || img.width;
          const srcH = img.naturalHeight || img.height;
          if (srcW <= 0 || srcH <= 0) {
            reject(new Error("图片尺寸无效。"));
            return;
          }
          const sSide = Math.min(srcW, srcH);
          const sx = Math.round((srcW - sSide) / 2);
          const sy = Math.round((srcH - sSide) / 2);

          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("无法创建画布上下文。"));
            return;
          }
          // 先填充背景色，避免透明 PNG 转 JPEG 时透明区域变成黑色。
          ctx.fillStyle = "#1a1a2e";
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, sx, sy, sSide, sSide, 0, 0, size, size);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) {
          reject(e instanceof Error ? e : new Error("图片处理失败。"));
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * NPC 立绘（半身/全身）尺寸（宽×高）。世界地图与战斗模块取其上半部分作为方形头像。
 */
export const NPC_PORTRAIT_WIDTH = 683;
export const NPC_PORTRAIT_HEIGHT = 1024;

/** 地点背景图尺寸（4:3 横版）。 */
export const LANDSCAPE_WIDTH = 1024;
export const LANDSCAPE_HEIGHT = 768;

/**
 * 将图片文件处理为 NPC 立绘 dataURL（默认 683×1024）。
 *
 * 采用「等比 contain + 背景填充」：按比例缩放使整张图完整放入目标画布，居中，
 * 空白区域填充背景色。这样任意比例的图都不会裁掉角色（文生图 2:3 输出刚好铺满）。
 * 世界地图/战斗模块通过 CSS `object-position: top` 取其上半部分作为方形头像。
 *
 * @throws 若文件不是图片类型，或图片解码失败。
 */
export function resizeImageFileToPortrait(
  file: File,
  width: number = NPC_PORTRAIT_WIDTH,
  height: number = NPC_PORTRAIT_HEIGHT,
  quality: number = AVATAR_QUALITY,
): Promise<string> {
  if (!file.type || !file.type.startsWith("image/")) {
    return Promise.reject(new Error("请选择图片文件。"));
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        reject(new Error("图片读取失败。"));
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error("图片解码失败，请换一张试试。"));
      img.onload = () => {
        try {
          const srcW = img.naturalWidth || img.width;
          const srcH = img.naturalHeight || img.height;
          if (srcW <= 0 || srcH <= 0) {
            reject(new Error("图片尺寸无效。"));
            return;
          }
          // 等比缩放，使整张图完整放入 width×height 画布（contain）。
          const scale = Math.min(width / srcW, height / srcH);
          const dstW = Math.max(1, Math.round(srcW * scale));
          const dstH = Math.max(1, Math.round(srcH * scale));
          const dx = Math.round((width - dstW) / 2);
          const dy = Math.round((height - dstH) / 2);

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("无法创建画布上下文。"));
            return;
          }
          // 先填充背景色，避免透明 PNG 转 JPEG 时透明区域变成黑色。
          ctx.fillStyle = "#1a1a2e";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, dx, dy, dstW, dstH);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) {
          reject(e instanceof Error ? e : new Error("图片处理失败。"));
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export function resizeImageFileToLandscape(
  file: File,
  width: number = LANDSCAPE_WIDTH,
  height: number = LANDSCAPE_HEIGHT,
  quality: number = AVATAR_QUALITY,
): Promise<string> {
  if (!file.type || !file.type.startsWith("image/")) {
    return Promise.reject(new Error("请选择图片文件。"));
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") { reject(new Error("图片读取失败。")); return; }
      const img = new Image();
      img.onerror = () => reject(new Error("图片解码失败，请换一张试试。"));
      img.onload = () => {
        try {
          const srcW = img.naturalWidth || img.width;
          const srcH = img.naturalHeight || img.height;
          if (srcW <= 0 || srcH <= 0) { reject(new Error("图片尺寸无效。")); return; }
          const scale = Math.min(width / srcW, height / srcH);
          const dstW = Math.max(1, Math.round(srcW * scale));
          const dstH = Math.max(1, Math.round(srcH * scale));
          const dx = Math.round((width - dstW) / 2);
          const dy = Math.round((height - dstH) / 2);
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("无法创建画布上下文。")); return; }
          ctx.fillStyle = "#1a1a2e";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, dx, dy, dstW, dstH);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) { reject(e instanceof Error ? e : new Error("图片处理失败。")); }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
