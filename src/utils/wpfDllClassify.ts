export interface WpfDllClassifyResult {
  Domain: string[];
  UI: string[];
  skipped: string[];
}

/**
 * 按 PublicTool 三分支规则分选扁平 DLL 列表
 * 判定顺序：含 WPF → UI；否则含 WEB → skipped；否则 → Domain
 * 不区分大小写，入参允许为完整路径（兼容 / 和 \ 双分隔符）
 */
export function classifyWpfDlls(dllFileNames: string[]): WpfDllClassifyResult {
  const result: WpfDllClassifyResult = { Domain: [], UI: [], skipped: [] };
  const seen = new Set<string>();

  for (const raw of dllFileNames) {
    if (!raw) continue;
    // 取文件名：兼容 / 与 \ 双分隔符
    const lastSlash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    const fileName = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
    if (!fileName) continue;
    // 去重（精确去重，按取 basename 后的文件名）
    if (seen.has(fileName)) continue;
    seen.add(fileName);

    const upper = fileName.toUpperCase();
    if (upper.includes("WPF")) {
      result.UI.push(fileName);
    } else if (upper.includes("WEB")) {
      result.skipped.push(fileName);
    } else {
      result.Domain.push(fileName);
    }
  }

  return result;
}
