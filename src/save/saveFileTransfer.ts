/**
 * @fileoverview 存档文件的本地导入/导出（浏览器端）。
 *
 * 用于「读取人生」弹窗的存档备份与分享：玩家导出存档为 JSON 文件，
 * 开发者导入该文件以复现问题。与存储后端无关，仅处理浏览器文件 I/O。
 */

/** 将数据以 JSON 文件形式触发浏览器下载。 */
export function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 读取用户选择的单个文件并以 JSON 解析。
 * @throws 文件读取失败或 JSON 解析失败时抛出 Error。
 */
export function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("文件不是合法的 JSON。"));
      }
    };
    reader.onerror = () => reject(new Error("读取文件失败。"));
    reader.readAsText(file);
  });
}
