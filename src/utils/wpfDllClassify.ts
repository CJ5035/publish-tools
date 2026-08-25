export interface WpfDllClassifyResult {
  Domain: string[];
  UI: string[];
  skipped: string[];
}

/**
 * 按非10.2版 WpfClient 生成后事件五分支规则分选扁平 DLL 列表
 * 分支顺序严格不可调换（大小写不敏感，按 stem 去 .dll 后缀后的程序集名判定）：
 * 1. stem 裸名 SIE 或 SIE.Wpf → skipped（壳程序集，属 Main.zip）
 * 2. stem 以 SIE.Wpf. 开头 → UI
 * 3. 否则 stem 含 WEB → skipped（Web 程序集归 WebClient 流程，安全兜底）
 * 4. 否则 stem 以 SIE. 开头 → Domain
 * 5. 其余 → skipped（第三方 DLL，归 Lib/，不在 Plugins.zip 范围）
 *
 * 健壮性：入参允许为完整路径（内部按 / 和 \ 双分隔符取最后一段），与 getReadAllDlls 产物兼容
 * 去重：按取 basename 后的文件名精确去重
 */
export function classifyWpfDlls(dllFileNames: string[]): WpfDllClassifyResult {
  const result: WpfDllClassifyResult = { Domain: [], UI: [], skipped: [] };
  const seen = new Set<string>();

  for (const raw of dllFileNames) {
    if (!raw) continue;
    const lastSlash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    const fileName = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
    if (!fileName) continue;
    if (seen.has(fileName)) continue;
    seen.add(fileName);

    // 取 stem：去掉 .dll 后缀（大小写不敏感）后的程序集名
    let stem = fileName;
    if (stem.toLowerCase().endsWith(".dll")) {
      stem = stem.slice(0, -4);
    }
    const upperStem = stem.toUpperCase();

    // 分支 1：裸名 SIE / SIE.Wpf → skipped
    if (upperStem === "SIE" || upperStem === "SIE.WPF") {
      result.skipped.push(fileName);
      continue;
    }
    // 分支 2：SIE.Wpf. 开头 → UI
    if (upperStem.startsWith("SIE.WPF.")) {
      result.UI.push(fileName);
      continue;
    }
    // 分支 3：含 WEB → skipped
    if (upperStem.includes("WEB")) {
      result.skipped.push(fileName);
      continue;
    }
    // 分支 4：SIE. 开头 → Domain
    if (upperStem.startsWith("SIE.")) {
      result.Domain.push(fileName);
      continue;
    }
    // 分支 5：其余 → skipped
    result.skipped.push(fileName);
  }

  return result;
}
