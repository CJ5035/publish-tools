// 安全 JSON 解析（方案 §3.1）：统一替代发布流程中的裸 JSON.parse。
// 解析失败时 console.warn 并返回 fallback，避免损坏的配置数据以异常形式中断流程；
// null / undefined / 空白串视为"未配置"，静默返回 fallback（正常业务状态，不产生噪音日志）。
export const safeJsonParse = <T>(
  raw: string | null | undefined,
  fallback: T
): T => {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  try {
    return JSON.parse(String(raw)) as T;
  } catch (error) {
    console.warn(
      "[safeJsonParse] JSON 解析失败，已返回默认值. 原始内容:",
      raw,
      "错误:",
      error
    );
    return fallback;
  }
};
