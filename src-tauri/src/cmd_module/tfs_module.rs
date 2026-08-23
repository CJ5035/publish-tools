use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use encoding_rs::{GB18030, GBK};
use regex::Regex;
use serde::Serialize;

/// workfold 单次输出解析结果（`workfold <dir>` 模式仅含 1 条映射行）
#[derive(Debug, PartialEq)]
pub struct WorkfoldInfo {
    pub server_url: String,
    pub workspace_name: String,
    pub mapping_server: String,
    pub mapping_local: String,
}

/// TFS 工作区探测结果（前端向导展示并落库 t_team_foundation_server 的数据源）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TfsDetectResult {
    pub tfs_server_url: String,
    pub tfs_source_path: String,
    pub tfs_local_path: String,
    pub tfvc_path: String,
    pub workspace_name: String,
}

/// tf.exe 输出解码链（照搬两个参考项目 TfCliRunner.DecodeOutput 的修复方式）：
/// UTF-8(严格) → GBK(ANSI 936) → GB18030(超集) → 宽松 UTF-8 兜底。
/// tf.exe 重定向输出实测为 GBK（控制台程序按系统代码页输出，非 UTF-8）。
pub fn decode_tf_output(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (gbk, _, had_errors) = GBK.decode(bytes);
    if !had_errors {
        return gbk.into_owned();
    }
    let (gb, _, had_errors) = GB18030.decode(bytes);
    if !had_errors {
        return gb.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 解析 tf workfold 输出（中英双语；实测含 CRLF 行尾、全角空格"集合  :"、====分隔线、(已隐藏) cloaked 行）。
/// 任一字段缺失返回 None——未映射路径的输出是错误文本（且 exit=0），必须以本函数结果判失败。
pub fn parse_workfold_output(output: &str) -> Option<WorkfoldInfo> {
    let col_re = Regex::new(r"^\s*(?:Collection|集合)\s*[:：]\s*(.+)$").unwrap();
    let ws_re = Regex::new(r"^\s*(?:Workspace|工作区)\s*[:：]\s*(\S+)(?:\s*\((.+)\))?\s*$").unwrap();
    let map_re = Regex::new(r"^\s*(\$/.+?)\s*[:：]\s*(.+)$").unwrap();

    let mut info = WorkfoldInfo {
        server_url: String::new(),
        workspace_name: String::new(),
        mapping_server: String::new(),
        mapping_local: String::new(),
    };

    for raw in output.split('\n') {
        let line = raw.trim_end_matches(['\r', '\n']).trim();
        if line.is_empty() || line.chars().all(|c| c == '=') {
            continue;
        }
        if let Some(c) = col_re.captures(line) {
            info.server_url = c.get(1).unwrap().as_str().trim().to_string();
            continue;
        }
        if let Some(w) = ws_re.captures(line) {
            info.workspace_name = w.get(1).unwrap().as_str().trim().to_string();
            continue;
        }
        if let Some(m) = map_re.captures(line) {
            let local = m.get(2).unwrap().as_str().trim().to_string();
            // cloaked 映射行：本地侧为 "(已隐藏)"/"(cloaked)"，非真实本地路径
            if local.starts_with('(') {
                continue;
            }
            info.mapping_server = m.get(1).unwrap().as_str().trim().to_string();
            info.mapping_local = local;
        }
    }

    if info.server_url.is_empty() || info.workspace_name.is_empty() || info.mapping_server.is_empty() {
        return None;
    }
    Some(info)
}

/// 路径归一化比较键：统一反斜杠、去尾部斜杠、ASCII 小写折叠。
/// 映射根判定「回显映射本地路径 == 查询目录」必须用本键比较。
pub fn path_cmp_key(p: &str) -> String {
    let p = p.trim().replace('/', "\\");
    let p = p.trim_end_matches('\\');
    p.to_ascii_lowercase()
}

/// 取父目录（输出统一反斜杠风格）；盘符根返回 None 终止向上遍历
pub fn parent_dir(p: &str) -> Option<String> {
    let p = p.trim().replace('/', "\\").trim_end_matches('\\').to_string();
    Path::new(&p).parent().map(|x| x.to_string_lossy().into_owned())
}

/// 查找 tf.exe（参考项目 FindTfExe）：1) PATH 逐目录；2) 全盘
/// Program Files / Program Files (x86) 下 Microsoft Visual Studio\{版本}\{Edition}\...Team Explorer\tf.exe，
/// 版本目录按修改时间降序——多 VS 共存优先最新（本机实证 VS2026 在 D 盘 "18" 目录）。
pub fn find_tf_exe() -> Option<String> {
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(';') {
            let candidate = format!("{}\\tf.exe", dir.trim_end_matches('\\'));
            if Path::new(&candidate).is_file() {
                return Some(candidate);
            }
        }
    }

    const TF_TAIL: &str = "Common7\\IDE\\CommonExtensions\\Microsoft\\TeamFoundation\\Team Explorer\\tf.exe";
    let mut version_dirs: Vec<(String, std::time::SystemTime)> = Vec::new();
    for drive in 'A'..='Z' {
        for pf in ["Program Files", "Program Files (x86)"] {
            let vs_root = format!("{}:\\{}\\Microsoft Visual Studio", drive, pf);
            if let Ok(rd) = fs::read_dir(&vs_root) {
                for entry in rd.flatten() {
                    if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                        version_dirs.push((entry.path().to_string_lossy().into_owned(), modified));
                    }
                }
            }
        }
    }
    version_dirs.sort_by(|a, b| b.1.cmp(&a.1));
    for (version_dir, _) in version_dirs {
        if let Ok(editions) = fs::read_dir(&version_dir) {
            for edition in editions.flatten() {
                let candidate = format!("{}\\{}", edition.path().to_string_lossy(), TF_TAIL);
                if Path::new(&candidate).is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// 执行 tf.exe workfold <dir>，返回解码后的输出。超时 15s（workfold 走本地工作区缓存，实测瞬时返回；
/// 参考项目的 120s 是为可能联网的命令设计，这里向上遍历会多次调用故收紧）。
/// 不校验退出码——实测未映射路径 exit=0 + 错误文本，失败判定交给 parse_workfold_output。
fn run_workfold(tf_path: &str, dir: &str) -> Result<String, String> {
    let mut child = Command::new(tf_path)
        .arg("workfold")
        .arg(dir)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 tf.exe 失败: {}", e))?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(15) {
                    let _ = child.kill();
                    return Err("tf.exe workfold 执行超时（15 秒）".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("等待 tf.exe 失败: {}", e)),
        }
    }

    let out = child.wait_with_output().map_err(|e| format!("读取 tf.exe 输出失败: {}", e))?;
    Ok(decode_tf_output(&out.stdout))
}

/// 配置向导 TFS 自动识别：从 SLN 所在目录向上查找工作区映射根。
/// 实测 `workfold <dir>` 返回"最紧包含映射"（子目录级），映射根判定 = 回显映射本地路径 == 查询目录；
/// 解析失败（未映射，含 exit=0 错误文本场景）同样向上遍历，到盘符根未命中即失败。
#[tauri::command]
pub async fn detect_tfs_workspace(sln_path: String, tfvc_path: Option<String>) -> Result<TfsDetectResult, String> {
    // tf.exe 路径：优先复用入参（前端取自存量 TFS 记录，避免每次全盘扫描），否则查找
    let tf_path = match tfvc_path {
        Some(p) if Path::new(&p).is_file() => p,
        _ => find_tf_exe().ok_or("未找到 tf.exe，请先在 TFS 管理页录入 TFVC 工具路径")?,
    };

    let mut dir = Path::new(&sln_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or("无法解析 SLN 所在目录")?;

    loop {
        let output = run_workfold(&tf_path, &dir)?;
        if let Some(info) = parse_workfold_output(&output) {
            if path_cmp_key(&info.mapping_local) == path_cmp_key(&dir) {
                return Ok(TfsDetectResult {
                    tfs_server_url: info.server_url,
                    tfs_source_path: info.mapping_server,
                    tfs_local_path: info.mapping_local,
                    tfvc_path: tf_path,
                    workspace_name: info.workspace_name,
                });
            }
        }
        match parent_dir(&dir) {
            Some(p) => dir = p,
            None => return Err("未识别到 TFS 工作区（SLN 不在任何工作区映射内）".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机实测真实输出（新容工作区，GBK + CRLF + 全角空格"集合  :"）
    const REAL_OUTPUT: &str = "===============================================================================\r\n工作区: CJ_服务器工作区2 (成骏)\r\n集合  : http://218.13.91.106:8081/tfs/smom.dev\r\n $/SMOM.DEV.10.2/SMOM.NBXR: F:\\项目\\新容\\C#\r\n";

    #[test]
    fn parse_real_chinese_output() {
        let info = parse_workfold_output(REAL_OUTPUT).unwrap();
        assert_eq!(info.server_url, "http://218.13.91.106:8081/tfs/smom.dev");
        assert_eq!(info.workspace_name, "CJ_服务器工作区2");
        assert_eq!(info.mapping_server, "$/SMOM.DEV.10.2/SMOM.NBXR");
        assert_eq!(info.mapping_local, "F:\\项目\\新容\\C#");
    }

    #[test]
    fn parse_english_output() {
        let out = "===============================================================================\nWorkspace: WS1 (owner)\nCollection: http://t:8080/tfs/col\n $/A/B: C:\\ws\\b\n";
        let info = parse_workfold_output(out).unwrap();
        assert_eq!(info.server_url, "http://t:8080/tfs/col");
        assert_eq!(info.workspace_name, "WS1");
        assert_eq!(info.mapping_local, "C:\\ws\\b");
    }

    #[test]
    fn parse_unmapped_error_text_returns_none() {
        // 实测：未映射路径 exit=0 + 错误文本，必须以解析结果判失败
        let out = "无法确定工作区。可以运行“tf workspaces /collection:TeamProjectCollectionUrl”来更正此问题。";
        assert!(parse_workfold_output(out).is_none());
    }

    #[test]
    fn parse_skips_separator_and_cloaked_lines() {
        let out = "=============\n集合: http://x/tfs\n工作区: WS\n $/A/B: (已隐藏)\n $/A/C: D:\\ws\\c\n";
        let info = parse_workfold_output(out).unwrap();
        assert_eq!(info.mapping_local, "D:\\ws\\c"); // cloaked 行被跳过，取真实映射
    }

    #[test]
    fn decode_prefers_utf8_then_gbk() {
        // UTF-8 直通
        assert_eq!(decode_tf_output("集合: x".as_bytes()), "集合: x");
        // GBK 字节 → 正确解码（严格 UTF-8 失败后落到 GBK）
        let (gbk_bytes, _, _) = GBK.encode("工作区: CJ_服务器工作区2");
        assert_eq!(decode_tf_output(&gbk_bytes), "工作区: CJ_服务器工作区2");
        // 双双非法 → 宽松兜底（替换字符）
        assert!(decode_tf_output(&[0xFF, 0xFE, 0x81]).contains('\u{FFFD}'));
    }

    #[test]
    fn path_cmp_key_normalizes_case_slash_and_trailing() {
        // tf.exe 回显大小写/斜杠风格不保证与查询串一致，实测必须归一后比较
        assert_eq!(path_cmp_key("F:\\项目\\新容\\C#"), path_cmp_key("f:/项目/新容/c#/"));
        assert_eq!(path_cmp_key("D:\\A\\"), path_cmp_key("d:/a"));
    }

    #[test]
    fn parent_dir_walks_up_and_stops_at_drive_root() {
        assert_eq!(parent_dir("F:\\项目\\新容\\C#").unwrap(), "F:\\项目\\新容");
        assert_eq!(parent_dir("F:\\项目").unwrap(), "F:\\");
        assert_eq!(parent_dir("F:\\"), None);
        // 正斜杠输入也归一
        assert_eq!(parent_dir("F:/a/b").unwrap(), "F:\\a");
    }

    #[test]
    fn run_workfold_err_on_missing_tf() {
        let r = run_workfold("C:\\definitely_not_exists_tf.exe", "C:\\");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("启动 tf.exe 失败"));
    }
}
