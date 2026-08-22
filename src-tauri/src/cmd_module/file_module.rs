use crate::cmd_module::ssh_pool;
use crate::utils::compression::{create_zip, unzip_files};
use crate::utils::msbuild::build_project;
use chrono::{DateTime, Local, NaiveDateTime};
use encoding_rs::GBK;
use encoding_rs::UTF_8;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::fs::File;
use std::io::ErrorKind;
use std::io::{self, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str;
use std::time::Instant;
use std::{thread, time::Duration};
use walkdir::WalkDir;
use zip::{write::FileOptions, ZipWriter};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// 远程目录扫描结果
#[derive(serde::Serialize)]
pub struct RemoteDirectory {
    pub path: String,
    pub name: String,
    pub has_binaries: bool,
}

/// 智能解码字节流：优先尝试 UTF-8，失败回退到 GBK
///
/// 适配混合服务器场景：
/// - Linux 服务器：默认输出为 UTF-8
/// - Windows 服务器/本地 cmd：默认输出为 GBK（简体中文 ANSI 代码页）
///
/// 由于 UTF-8 格式严格（非法字节序列一定校验失败），可作为安全的首选尝试；
/// 失败后再回退到 GBK，避免 Linux 输出被当作 GBK 解码产生乱码。
fn smart_decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = GBK.decode(bytes);
            cow.to_string()
        }
    }
}

/// 连接远程服务器
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn server_connection(
    username: &str,
    password: &str,
    server: &str,
) -> Result<bool, String> {
    // 测试连接需要严格校验"当前传入的密码"，先丢弃池中可能存在的旧会话，
    // 否则若用户改了密码但池中仍缓存着旧会话，会误报连通成功。
    ssh_pool::invalidate(username, server);

    match ssh_pool::get_session(username, password, server) {
        Ok(_) => Ok(true),
        Err(e) => Err(e),
    }
}

/// 在远程服务器上执行命令
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
/// * `command` - 执行的命令
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn execute_remote_command(
    username: &str,
    password: &str,
    server: &str,
    command: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<String, String> {
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;

    while attempts < max_attempts {
        match remote_command(username, password, server, command).await {
            Ok(output) => return Ok(output),
            Err(e) => {
                eprintln!("尝试 {} 失败: {}，正在重试...", attempts + 1, e);
                attempts += 1;
                if attempts < max_attempts {
                    thread::sleep(delay);
                }
            }
        }
    }
    Err(format!(
        "尝试 {} 次后，仍无法执行命令：{}",
        attempts, command
    ))
}

/// 服务器上执行命令
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
/// * `command` - 执行的命令
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
async fn remote_command(
    username: &str,
    password: &str,
    server: &str,
    command: &str,
) -> Result<String, String> {
    // 从连接池取（或新建）已认证的 SSH 会话
    let shared = ssh_pool::get_session(username, password, server)?;

    // 在锁内完成 channel 全生命周期，避免 libssh2 同会话并发使用
    let channel_outcome: Result<(i32, String, String), String> = (|| {
        let mut entry = shared
            .lock()
            .map_err(|_| "SSH 会话锁中毒".to_string())?;

        let (exit_status, stdout, stderr) = {
            let mut channel = entry
                .session
                .channel_session()
                .map_err(|_| "无法打开远程命令通道".to_string())?;
            println!("执行远程命令: {}", command);
            channel
                .exec(command)
                .map_err(|_| "无法执行命令".to_string())?;

            let mut stdout_bytes = Vec::new();
            let mut stderr_bytes = Vec::new();
            channel
                .read_to_end(&mut stdout_bytes)
                .map_err(|_| "无法读取命令输出".to_string())?;
            channel
                .stderr()
                .read_to_end(&mut stderr_bytes)
                .map_err(|_| "无法读取命令错误输出".to_string())?;
            channel
                .wait_close()
                .map_err(|_| "无法关闭命令通道".to_string())?;
            let status = channel
                .exit_status()
                .map_err(|_| "无法获取命令退出状态".to_string())?;

            (
                status,
                smart_decode_bytes(&stdout_bytes),
                smart_decode_bytes(&stderr_bytes),
            )
        };

        entry.last_used = Instant::now();
        Ok((exit_status, stdout, stderr))
    })();

    match channel_outcome {
        Ok((exit_status, stdout, stderr)) => {
            if exit_status == 0 {
                Ok(stdout)
            } else {
                // 命令业务级失败：会话本身仍可继续复用，无需丢弃
                Err(format!(
                    "命令执行异常。退出状态：{}。输出：{}；错误输出：{}",
                    exit_status, stdout, stderr
                ))
            }
        }
        Err(e) => {
            // 通道级错误（连接断开等），使会话失效以便下次重建
            ssh_pool::invalidate(username, server);
            Err(e)
        }
    }
}

/// 扫描远程服务器指定根目录下的一级子目录，并探测是否含可部署二进制。
///
/// # Arguments
/// * `username` / `password` / `server` - SSH 凭据（与 execute_remote_command 一致）
/// * `server_os` - 服务器系统类型：1=Windows(PowerShell)，2=Docker/Linux(find)
/// * `scan_root` - 扫描根路径（每服务器独立）
/// * `exclude_patterns` - 目录名排除列表（精确匹配）
///
/// # Returns
/// * `Ok(Vec<RemoteDirectory>)` 成功
/// * `Err(String)` 扫描失败（前端走"扫描失败→手动配置"分支）
#[tauri::command]
pub async fn scan_server_directories(
    username: &str,
    password: &str,
    server: &str,
    server_os: i64,
    scan_root: &str,
    exclude_patterns: Option<Vec<String>>,
) -> Result<Vec<RemoteDirectory>, String> {
    let root = scan_root.trim_end_matches(|c| c == '/' || c == '\\');
    if root.is_empty() {
        return Err("扫描根路径不能为空".to_string());
    }
    // 先校验路径，禁止换行、分号、命令替换和未转义空白。
    validate_scan_root(root)?;
    let excludes = exclude_patterns.unwrap_or_default();
    if excludes.iter().any(|p| !is_safe_pattern(p)) {
        return Err("排除规则包含非法字符".to_string());
    }

    let list_cmd = match server_os {
        1 => format!("powershell -NoProfile -Command \"$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath '{}' -Directory | ForEach-Object {{ $_.FullName }}\"", powershell_quote(root)),
        2 => format!("find {} -maxdepth 1 -mindepth 1 -type d", shell_quote(root)),
        _ => return Err(format!("暂不支持服务器系统类型：{}", server_os)),
    };
    let output = remote_command(username, password, server, &list_cmd).await?;

    let mut result: Vec<RemoteDirectory> = Vec::new();
    for line in output.lines() {
        let dir = line.trim();
        if dir.is_empty() {
            continue;
        }
        let name = match server_os {
            1 => dir.rsplit(|c| c == '\\' || c == '/').next().unwrap_or("").to_string(),
            2 => dir.rsplit('/').next().unwrap_or("").to_string(),
            _ => return Err(format!("暂不支持服务器系统类型：{}", server_os)),
        };
        if name.is_empty() || excludes.iter().any(|p| p == &name) {
            continue;
        }
        let probe = match server_os {
            // 用 -print -quit 而非管道：remote_command 靠 exit_status != 0 判失败，
            // 加 `| head -1` 会让退出码取自 head 恒为 0，权限错误被静默吞成「无 binaries」，
            // 下面的降级警告分支将永不触发。-quit 需 GNU findutils，busybox 环境按约定标 blocked。
            2 => format!("find {} -maxdepth 1 -type f \\( -name '*.dll' -o -name '*.exe' -o -name '*.config' -o -name '*.json' -o -name '*.so' \\) -print -quit", shell_quote(dir)),
            1 => format!("powershell -NoProfile -Command \"$ErrorActionPreference='Stop'; if (Get-ChildItem -LiteralPath '{}' -File | Where-Object {{ $_.Extension -in '.dll','.exe','.config','.json','.so' }} | Select-Object -First 1) {{ 'hit' }}\"", powershell_quote(dir)),
            _ => return Err(format!("暂不支持服务器系统类型：{}", server_os)),
        };
        // probe 单目录失败时降级（权限受限/路径消失）：将该目录 has_binaries 置 false 并记警告，
        // 不因单目录错误中断整次扫描（只有根目录列表不可用才返回 Err）
        let has_binaries = match remote_command(username, password, server, &probe).await {
            Ok(o) => !o.trim().is_empty(),
            Err(e) => {
                eprintln!("警告：探测目录 {} 文件失败（已降级为 has_binaries=false）：{}", dir, e);
                false
            }
        };
        result.push(RemoteDirectory {
            path: dir.to_string(),
            name,
            has_binaries,
        });
    }
    Ok(result)
}

/// 远程服务枚举结果
#[derive(serde::Serialize)]
pub struct RemoteService {
    pub name: String,
    pub display_name: String,
    pub exec_dir: String,
    pub source: String,
    /// 容器全部挂载的宿主机路径（仅 docker 分支非空；不含 exec_dir，供前端候选切换）
    pub mounts: Vec<String>,
}

/// 扫描远程服务器服务（Windows 服务 / Linux systemd+docker）
///
/// # Arguments
/// * `username` / `password` / `server` - SSH 凭据
/// * `server_os` - 服务器系统类型：1=Windows(PowerShell)，2=Linux
///
/// # Returns
/// * `Ok(Vec<RemoteService>)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn scan_server_services(
    username: &str,
    password: &str,
    server: &str,
    server_os: i64,
) -> Result<Vec<RemoteService>, String> {
    if server_os == 1 {
        let ps = "powershell -NoProfile -Command \"Get-CimInstance Win32_Service | Select-Object Name,DisplayName,PathName | ConvertTo-Json -Compress\"";
        let output = remote_command(username, password, server, ps).await?;
        parse_win32_services(&output)
    } else if server_os == 2 {
        scan_linux_services(username, password, server).await
    } else {
        Err(format!("不支持的服务器系统类型: {}", server_os))
    }
}

fn parse_win32_services(json: &str) -> Result<Vec<RemoteService>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("解析服务数据失败: {}", e))?;
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(arr) => arr.iter().collect(),
        serde_json::Value::Object(_) => vec![&value],
        serde_json::Value::Null => return Ok(vec![]),
        _ => return Ok(vec![]),
    };
    let mut result = Vec::new();
    for item in items {
        let name = item
            .get("Name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let display_name = item
            .get("DisplayName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let display_name = if display_name.is_empty() {
            name.clone()
        } else {
            display_name
        };
        let path_name = item
            .get("PathName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if path_name.is_empty() {
            continue;
        }
        let lower = path_name.to_ascii_lowercase();
        let Some(pos) = lower.find(".exe") else {
            continue;
        };
        let truncated = &path_name[..pos + 4];
        let truncated_trimmed = truncated.trim().trim_matches('"').trim();
        let truncated_trimmed = truncated_trimmed.trim_matches('\'').trim();
        let Some(idx) = truncated_trimmed.rfind(|c| c == '\\' || c == '/') else {
            continue;
        };
        let dir = truncated_trimmed[..idx]
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if dir.is_empty() {
            continue;
        }
        result.push(RemoteService {
            name: name.clone(),
            display_name,
            exec_dir: dir,
            source: "service".to_string(),
            mounts: vec![],
        });
    }
    Ok(result)
}

async fn scan_linux_services(
    username: &str,
    password: &str,
    server: &str,
) -> Result<Vec<RemoteService>, String> {
    let systemd_cmd = r#"systemctl list-units --type=service --all --no-pager --plain --no-legend | cut -d' ' -f1 | grep '\.service$' | while read u; do printf '%s|%s\n' "$u" "$(systemctl show "$u" -p ExecStart --value)"; done"#;
    let docker_cmd = "docker inspect -f '{{.Name}}|{{range .Mounts}}{{.Source}}>{{.Destination}};{{end}}' $(docker ps -q)";
    let mut results: Vec<RemoteService> = Vec::new();

    match remote_command(username, password, server, systemd_cmd).await {
        Ok(output) => {
            for line in output.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Some((unit, exec)) = line.split_once('|') else {
                    continue;
                };
                let unit = unit.trim();
                let exec = exec.trim();
                if unit.is_empty() || exec.is_empty() {
                    continue;
                }
                let mut path_token: Option<String> = None;
                for token in exec.split_whitespace() {
                    let t = token.trim();
                    if t.is_empty() {
                        continue;
                    }
                    if t.starts_with('{') || t.starts_with('}') {
                        continue;
                    }
                    let cleaned = t.trim_matches(|c| c == '"' || c == '\'');
                    if cleaned.is_empty() {
                        continue;
                    }
                    if cleaned.starts_with('{') || cleaned.starts_with('}') {
                        continue;
                    }
                    path_token = Some(cleaned.to_string());
                    break;
                }
                let Some(pt) = path_token else {
                    continue;
                };
                let pt_trim = pt.trim().trim_matches('"').trim_matches('\'').trim();
                if pt_trim.is_empty() {
                    continue;
                }
                let Some(idx) = pt_trim.rfind('/') else {
                    continue;
                };
                let dir = pt_trim[..idx].trim().to_string();
                if dir.is_empty() {
                    continue;
                }
                results.push(RemoteService {
                    name: unit.to_string(),
                    display_name: unit.to_string(),
                    exec_dir: dir,
                    source: "service".to_string(),
                    mounts: vec![],
                });
            }
        }
        Err(_) => {
            // systemd 扫描失败仅跳过，继续尝试 docker（纯 Docker 宿主机无 systemd 时输出为空）
        }
    }

    match remote_command(username, password, server, docker_cmd).await {
        Ok(output) => {
            for line in output.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Some((name_part, mounts_part)) = line.split_once('|') else {
                    continue;
                };
                let name = name_part.trim().trim_start_matches('/').trim().to_string();
                if name.is_empty() {
                    continue;
                }
                // 解析 "source>destination;..." 为挂载对，跳过空项
                let pairs: Vec<(String, String)> = mounts_part
                    .split(';')
                    .filter_map(|m| m.trim().split_once('>'))
                    .map(|(s, d)| (s.trim().to_string(), d.trim().to_string()))
                    .filter(|(s, _)| !s.is_empty())
                    .collect();
                if pairs.is_empty() {
                    continue;
                }

                // 非应用挂载黑名单（Source/Destination 命中任一即排除；子串匹配、忽略大小写）
                const MOUNT_BLACKLIST: &[&str] = &[
                    "/usr/share/fonts", "/etc/localtime", "/etc/timezone",
                    "/etc/hosts", "/etc/resolv.conf", "docker.sock", "cert", "ssl",
                ];
                let is_blacklisted = |s: &str, d: &str| {
                    let sl = s.to_ascii_lowercase();
                    let dl = d.to_ascii_lowercase();
                    MOUNT_BLACKLIST.iter().any(|b| sl.contains(b) || dl.contains(b))
                };

                // 优选：SMOM 部署约定 —— 发布目录挂载的 Destination == "/"+容器名（实测确认，见诊断报告）
                let name_lower = name.to_ascii_lowercase();
                let preferred = pairs.iter().find(|(_, d)| {
                    d.trim_end_matches('/').to_ascii_lowercase() == format!("/{}", name_lower)
                });
                // 兜底：黑名单过滤后第一个；全被过滤则取原始第一个（不退化）
                let exec_dir = preferred
                    .map(|(s, _)| s.clone())
                    .or_else(|| pairs.iter().find(|(s, d)| !is_blacklisted(s, d)).map(|(s, _)| s.clone()))
                    .unwrap_or_else(|| pairs[0].0.clone());

                // 候选：全部 Source，去重、去已选
                let mut mounts: Vec<String> = Vec::new();
                for (s, _) in &pairs {
                    if *s != exec_dir && !mounts.contains(s) {
                        mounts.push(s.clone());
                    }
                }
                results.push(RemoteService { name: name.clone(), display_name: name, exec_dir, source: "docker".to_string(), mounts });
            }
        }
        Err(_) => {
            // docker 未安装 / 无权限 / 无运行容器时静默跳过，永不返回 Err
        }
    }

    Ok(results)
}

/// wpfClient 发布目录探测结果行解析：trim、去空行、保序去重
fn parse_wpf_dir_lines(output: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in output.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x == l) {
            out.push(l.to_string());
        }
    }
    out
}

/// Linux 端 wpfClient 发布目录探测命令（单次往返）：
/// 找 Manifest.xml 且同目录存在 *.zip，输出其所在目录。
/// - 锚点模式：逐锚点 maxdepth 2；
/// - 全盘模式：maxdepth 5 + 系统/虚拟目录/NFS prune + timeout 60；
/// - 全模式尾部 `; true` 中和退出码（find 遇权限错误返回 1，remote_command 非 0 即判失败）。
fn build_wpf_scan_cmd_linux(anchors: &[String], full_scan: bool) -> String {
    const ZIP_CHECK: &str = " | while IFS= read -r m; do d=$(dirname \"$m\"); z=$(find \"$d\" -maxdepth 1 -name '*.zip' -print -quit 2>/dev/null); [ -n \"$z\" ] && printf '%s\\n' \"$d\"; done; true";
    if full_scan {
        format!("timeout 60 find / -maxdepth 5 \\( -path /proc -o -path /sys -o -path /run -o -path /snap -o -path /var/lib/docker -o -fstype nfs \\) -prune -o -name Manifest.xml -print 2>/dev/null{ZIP_CHECK}")
    } else {
        let quoted: Vec<String> = anchors.iter().map(|a| shell_quote(a)).collect();
        format!("for p in {}; do find \"$p\" -maxdepth 2 -name Manifest.xml -print 2>/dev/null; done{ZIP_CHECK}", quoted.join(" "))
    }
}

/// Windows 端 wpfClient 发布目录探测命令（单次往返）：
/// - 锚点模式：Get-ChildItem -Depth 2 -Filter Manifest.xml（-Filter 快于 -Include）；
/// - 全盘模式：robocopy /L /S /LEV:4（原生速度，避开 WinSxS/Program Files），/XD 排除系统目录；
/// - 全模式尾部 `exit 0` 中和退出码（robocopy 退出码为位标志 0-7）；
/// - `-ErrorAction SilentlyContinue`：全盘必撞系统目录 Access Denied，不可沿用 ErrorActionPreference=Stop 模式。
fn build_wpf_scan_cmd_windows(anchors: &[String], full_scan: bool) -> String {
    const ZIP_CHECK: &str = " | ForEach-Object { $dir = Split-Path -Parent $_; if (@(Get-ChildItem -Path (Join-Path $dir '*.zip') -File -ErrorAction SilentlyContinue).Count -gt 0) { $dir } }; exit 0";
    let collect = if full_scan {
        "foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null })) { $r = '{0}:\\' -f $d.Name; $hits += robocopy $r '\\noop' Manifest.xml /L /S /LEV:4 /XD ($r + 'Windows') ($r + '$Recycle.Bin') ($r + 'Program Files') ($r + 'Program Files (x86)') ($r + 'ProgramData') /NJH /NJS /NDL /NC /NS /NP 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ -like '*\\Manifest.xml' } }".to_string()
    } else {
        let quoted: Vec<String> = anchors
            .iter()
            .map(|a| format!("'{}'", powershell_quote(a)))
            .collect();
        format!("foreach ($r in @({})) {{ $hits += Get-ChildItem -LiteralPath $r -Recurse -Depth 2 -Filter Manifest.xml -File -ErrorAction SilentlyContinue | ForEach-Object {{ $_.FullName }} }}", quoted.join(", "))
    };
    format!("powershell -NoProfile -Command \"$hits = @(); {}; $hits{}\"", collect, ZIP_CHECK)
}

#[cfg(test)]
mod wpf_scan_tests {
    use super::*;

    #[test]
    fn linux_anchor_cmd_quotes_anchors_and_depth2() {
        let cmd = build_wpf_scan_cmd_linux(&["/data/app".into(), "/home/u".into()], false);
        assert!(cmd.starts_with("for p in '/data/app' '/home/u'; do find \"$p\" -maxdepth 2 -name Manifest.xml"));
        assert!(cmd.ends_with("; true"));
    }

    #[test]
    fn linux_anchor_cmd_escapes_single_quote() {
        let cmd = build_wpf_scan_cmd_linux(&["/data/a'b".into()], false);
        assert!(cmd.contains("'/data/a'\\''b'"));
    }

    #[test]
    fn linux_full_cmd_prunes_systems_and_neutralizes_exit() {
        let cmd = build_wpf_scan_cmd_linux(&[], true);
        assert!(cmd.starts_with("timeout 60 find / -maxdepth 5"));
        for p in ["/proc", "/sys", "/run", "/snap", "/var/lib/docker", "-fstype nfs"] {
            assert!(cmd.contains(p), "missing prune: {p}");
        }
        assert!(cmd.ends_with("; true"));
    }

    #[test]
    fn windows_anchor_cmd_uses_gci_depth2_and_exit0() {
        let cmd = build_wpf_scan_cmd_windows(&["D:\\Smom".into()], false);
        assert!(cmd.contains("@('D:\\Smom')"));
        assert!(cmd.contains("-Recurse -Depth 2 -Filter Manifest.xml"));
        assert!(cmd.ends_with("exit 0\""));
    }

    #[test]
    fn windows_full_cmd_uses_robocopy_lev4_and_xd_excludes() {
        let cmd = build_wpf_scan_cmd_windows(&[], true);
        assert!(cmd.contains("robocopy"));
        assert!(cmd.contains("/LEV:4"));
        for x in ["'Windows'", "'$Recycle.Bin'", "'Program Files'", "'Program Files (x86)'", "'ProgramData'"] {
            assert!(cmd.contains(x), "missing /XD {x}");
        }
        assert!(cmd.ends_with("exit 0\""));
    }

    #[test]
    fn parse_wpf_dir_lines_trims_dedupes_drops_empty() {
        assert_eq!(
            parse_wpf_dir_lines("\n/data/app/WpfClient\n/data/app/WpfClient\n \nD:\\Smom\\Wpf\n"),
            vec!["/data/app/WpfClient", "D:\\Smom\\Wpf"]
        );
    }
}

/// 扫描远程服务器上的 wpfClient 发布目录（存在 Manifest.xml 且同目录含 *.zip 的目录）
///
/// # Arguments
/// * `username` / `password` / `server` - SSH 凭据（与 scan_server_services 一致）
/// * `server_os` - 服务器系统类型：1=Windows，2=Linux
/// * `anchors` - 锚点根目录列表（锚点模式）；全盘模式下忽略
/// * `full_scan` - true 时全盘扫描（用户手动触发的深度扫描，禁止自动调用）
///
/// # Returns
/// * `Ok(Vec<String>)` 命中目录列表（已 trim 去重）；无命中返回空 Vec
/// * `Err(String)` 扫描失败
#[tauri::command]
pub async fn scan_wpf_publish_dirs(
    username: &str,
    password: &str,
    server: &str,
    server_os: i64,
    anchors: Vec<String>,
    full_scan: bool,
) -> Result<Vec<String>, String> {
    if !full_scan && anchors.is_empty() {
        return Err("锚点为空且未开启全盘扫描".to_string());
    }
    if anchors.iter().any(|a| a.chars().any(|c| c == '\r' || c == '\n')) {
        return Err("锚点路径包含非法字符".to_string());
    }
    let cmd = match server_os {
        1 => build_wpf_scan_cmd_windows(&anchors, full_scan),
        2 => build_wpf_scan_cmd_linux(&anchors, full_scan),
        _ => return Err(format!("暂不支持服务器系统类型：{}", server_os)),
    };
    let output = remote_command(username, password, server, &cmd).await?;
    Ok(parse_wpf_dir_lines(&output))
}

/// 健康检查：对指定 URL 发起 GET，2xx 视为健康。
///
/// # Arguments
/// * `check_url` - 健康检查 URL（手动配置）
/// * `timeout_sec` - 超时秒数
///
/// # Returns
/// * `Ok("healthy")` 成功
/// * `Err("unhealthy: ..." / "健康检查请求失败：..." / "健康检查超时时间必须大于 0")` 失败
#[tauri::command]
pub async fn check_service_health(check_url: String, timeout_sec: i64) -> Result<String, String> {
    if timeout_sec <= 0 {
        return Err("健康检查超时时间必须大于 0".to_string());
    }
    let dur = std::time::Duration::from_secs(timeout_sec as u64);
    let client = reqwest::Client::builder()
        .timeout(dur)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{}", e))?;
    let resp = client
        .get(&check_url)
        .send()
        .await
        .map_err(|e| format!("健康检查请求失败：{}", e))?;
    if resp.status().is_success() {
        Ok("healthy".to_string())
    } else {
        Err(format!("unhealthy: HTTP {}", resp.status()))
    }
}

fn validate_scan_root(root: &str) -> Result<(), String> {
    if root.is_empty() || root.chars().any(|c| c == '\r' || c == '\n' || c == ';' || c == '`' || c == '$' || c == '"') {
        return Err("扫描根路径包含非法字符".to_string());
    }
    Ok(())
}

fn is_safe_pattern(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.chars().any(|c| c == '\r' || c == '\n' || c == ';' || c == '`' || c == '$' || c == '"')
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// 使某个 SSH 连接池中的会话失效（切换项目后调用）
#[tauri::command]
pub async fn invalidate_ssh_session(username: &str, server: &str) -> Result<bool, String> {
    ssh_pool::invalidate(username, server);
    Ok(true)
}

/// 判断文件或目录是否存在
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn exists(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    if path.exists() {
        Ok(true)
    } else {
        Err(format!("路径[{}]不存在！", path.display()))
    }
}

/// 判断文件或目录是否存在
///
/// # Arguments
/// * `path` - 文件目录路径
/// * `is_rebuild` - 是否重新编译
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn build_project_release(
    project_file_path: &str,
    msbuild_path: &str,
    is_rebuild: bool,
    build_mode: &str,
) -> Result<bool, String> {
    match build_project(project_file_path, msbuild_path, is_rebuild, build_mode) {
        Ok(_) => Ok(true),
        Err(e) => Err(e),
    }
}

/// 判断文件夹是否为空目录
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn is_dir_empty(path: &str) -> Result<bool, String> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(entries.peekable().peek().is_none()),
        Err(e) => Err(e.to_string()),
    }
}

/// 创建文件目录
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn create_dir(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    match fs::create_dir_all(path) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

/// 目录压缩[ZIP]文件
///
/// # Arguments
/// * `src_dir` - 文件夹路径
/// * `dst_file` - 输出的zip文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn zip_dir(src_dir: &str, dst_file: &str) -> Result<bool, String> {
    let path = Path::new(src_dir);
    let file = File::create(dst_file).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    for entry in WalkDir::new(path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path
            .strip_prefix(Path::new(src_dir))
            .map_err(|e| e.to_string())?;

        if path.is_file() {
            // zip.start_file_from_path(name, options)
            zip.start_file(path_to_string(name), options)
                .map_err(|e| e.to_string())?;
            let mut f = File::open(path).map_err(|e| e.to_string())?;
            io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
        } else if path.is_dir() && !name.as_os_str().is_empty() {
            // zip.add_directory_from_path(name, options)
            zip.add_directory(path_to_string(name), options)
                .map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(true)
}

fn path_to_string(path: &std::path::Path) -> String {
    let mut path_str = String::new();
    for component in path.components() {
        if let std::path::Component::Normal(os_str) = component {
            if !path_str.is_empty() {
                path_str.push('/');
            }
            path_str.push_str(&os_str.to_string_lossy());
        }
    }
    path_str
}

/// 压缩[ZIP]文件
///
/// # Arguments
/// * `file_paths` - 文件|文件夹路径
/// * `dst_file` - 输出的zip文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn compress_zip(file_paths: Vec<String>, dst_file: &str) -> Result<bool, String> {
    // 直接将Vec<String>转换为Vec<&str>，减少中间步骤
    let file_paths: Vec<&str> = file_paths.iter().map(String::as_str).collect();
    // 调用create_zip函数并处理结果
    create_zip(&file_paths, dst_file)
        .map_err(|e| e.to_string())
        .map(|_| true)
}

/// 解压压缩文件
///
/// # Arguments
/// * `file_paths` - 文件路径
/// * `destination` - 输出解压路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn un_zip(file_paths: Vec<String>, destination: &str) -> Result<bool, String> {
    let file_paths: Vec<&str> = file_paths.iter().map(String::as_str).collect();
    unzip_files(&file_paths, destination)
        .map_err(|e| e.to_string())
        .map(|_| true)
}

/// 读取文件目录中的文件
///
/// # Arguments
/// * `path` - 文件目录
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_files(path: &str) -> Result<Vec<String>, String> {
    match fs::read_dir(path) {
        Ok(entries) => {
            let mut file_names = Vec::new();
            for entry in entries {
                match entry {
                    Ok(entry) => {
                        if let Ok(file_name) = entry.file_name().into_string() {
                            file_names.push(file_name);
                        }
                    }
                    Err(e) => return Err(format!("获取条目出错: {}", e)),
                }
            }
            Ok(file_names)
        }
        Err(e) => Err(format!("读取目录出错: {}", e)),
    }
}

/// 查找 Directory Opus 的请求器工具 dopusrt.exe
///
/// 按以下顺序检测，取第一个存在 dopusrt.exe 的目录：
/// 1. 官方注册表键 `SOFTWARE\GPSoftware\Directory Opus` → `InstallDirectory`（HKLM/HKCU，覆盖 64/32 位注册表视图）
/// 2. 扫描 Uninstall 键中 DisplayName 为 `Directory Opus` 的条目，取 `InstallLocation` / `Inno Setup: App Path`（兼容非标准安装）
/// 3. 文件系统默认目录 `%ProgramFiles%\GPSoftware\Directory Opus`（含 x86 目录）
///
/// # Returns
/// * `Some(path)` dopusrt.exe 完整路径
/// * `None` 未安装 Directory Opus，调用方应回退到系统资源管理器
fn find_directory_opus_rt() -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Directory Opus 官方注册表键：HKLM/HKCU × 64 位/32 位注册表视图
    let sam_flags = [KEY_READ | KEY_WOW64_64KEY, KEY_READ | KEY_WOW64_32KEY];
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for sam in sam_flags {
            let predef = RegKey::predef(root);
            if let Ok(key) = predef.open_subkey_with_flags(r"SOFTWARE\GPSoftware\Directory Opus", sam) {
                if let Ok(dir) = key.get_value::<String, _>("InstallDirectory") {
                    candidates.push(PathBuf::from(dir));
                }
            }
        }
    }

    // 2. Uninstall 注册表键：兼容自定义 Inno Setup 打包等非标准安装
    let uninstall_paths = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let predef = RegKey::predef(root);
        for uninstall_path in uninstall_paths {
            let uninstall = match predef.open_subkey(uninstall_path) {
                Ok(k) => k,
                Err(_) => continue,
            };
            for entry in uninstall.enum_keys().flatten() {
                let app = match uninstall.open_subkey(&entry) {
                    Ok(k) => k,
                    Err(_) => continue,
                };
                let display_name: String = app.get_value("DisplayName").unwrap_or_default();
                if display_name != "Directory Opus" {
                    continue;
                }
                if let Ok(dir) = app.get_value::<String, _>("InstallLocation") {
                    candidates.push(PathBuf::from(dir.trim_end_matches(['\\', '/'])));
                } else if let Ok(dir) = app.get_value::<String, _>("Inno Setup: App Path") {
                    candidates.push(PathBuf::from(dir));
                }
            }
        }
    }

    // 3. 文件系统默认安装目录
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(base) = env::var_os(var) {
            candidates.push(PathBuf::from(base).join(r"GPSoftware\Directory Opus"));
        }
    }

    // 校验候选目录：必须存在 dopusrt.exe 才视为有效安装
    for dir in candidates {
        let rt = dir.join("dopusrt.exe");
        if rt.is_file() {
            return Some(rt);
        }
    }
    None
}

/// 打开文件目录
///
/// Windows 下优先使用 Directory Opus（已安装时通过 dopusrt.exe 打开），
/// 未安装或启动失败时回退到系统资源管理器 explorer。
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn open_dir(path: &str) -> Result<bool, String> {
    // 处理路径
    let path = Path::new(path);
    let path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Err("路径无效！".to_string());
        }
    };
    let path_str = path.to_str().ok_or_else(|| "路径转换失败".to_string())?;

    // 去除 canonicalize 在 Windows 上添加的 \\?\ 扩展长度前缀：
    // explorer 对该前缀透明兼容，但 Directory Opus 会原样显示，需剥离；
    // \\?\UNC\server\share 形式需还原为 \\server\share
    let path_string = if let Some(rest) = path_str.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path_str.strip_prefix(r"\\?\").unwrap_or(path_str).to_string()
    };
    let path_str = path_string.as_str();

    // 获取当前操作系统信息
    let os_type = env::consts::OS;

    // 根据操作系统类型执行不同的命令
    let result = match os_type {
        "windows" => {
            // 优先 Directory Opus：dopusrt.exe /acmd 会在 DOpus 未运行时先拉起主程序，
            // 再执行 Go 命令；NEWTAB=tofront 在最近活动窗口新开标签（不覆盖用户当前
            // 浏览的目录），并把窗口恢复/置前，保证打开结果对用户可见
            match find_directory_opus_rt() {
                Some(rt) => match Command::new(&rt)
                    .args(["/acmd", "Go", path_str, "NEWTAB=tofront"])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn()
                {
                    Ok(child) => Ok(child),
                    Err(_) => Command::new("explorer").arg(path_str).spawn(),
                },
                None => Command::new("explorer").arg(path_str).spawn(),
            }
        }
        "macos" => Command::new("open").arg(path_str).spawn(),
        "linux" => Command::new("xdg-open").arg(path_str).spawn(),
        _ => {
            return Err("不支持的操作系统".to_string());
        }
    };

    match result {
        Ok(_) => Ok(true),
        Err(e) => Err(format!("无法打开目录: {}", e)),
    }
}

/// 复制路径文件
///
/// # Arguments
/// * `source` - 文件|文件夹来源路径
/// * `destination` - 文件|文件夹目标路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_path(
    source: &str,
    destination: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<bool, String> {
    let source = Path::new(source);
    let destination = Path::new(destination);

    if !source.exists() {
        // 不存在源文件直接忽略吧
        return Ok(true);
    }

    if source.is_dir() {
        // 检查并创建目标文件夹
        if !destination.exists() {
            if let Err(e) = fs::create_dir_all(destination) {
                return Err(e.to_string());
            }
        }

        for entry in match fs::read_dir(source) {
            Ok(entries) => entries,
            Err(e) => return Err(e.to_string()),
        } {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => return Err(e.to_string()),
            };
            let entry_path = entry.path();
            let entry_name = entry.file_name();

            // 递归复制子文件或子目录（透传重试参数）
            let source_path = entry_path.to_str().ok_or("源路径无效")?;
            let destination_path_tmp = destination.join(entry_name);
            let destination_path = destination_path_tmp.to_str().ok_or("目标路径无效")?;
            Box::pin(copy_path(source_path, destination_path, retry_count, retry_interval_secs)).await?;
        }
        return Ok(true);
    }

    // 复制文件（带重试）
    // retry_count = None 或 0 → 单次尝试（旧行为）；否则按 retry_count 次尝试，间隔 retry_interval_secs 秒
    let max_attempts = retry_count.unwrap_or(0).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut last_err = String::new();
    for attempt in 1..=max_attempts {
        match fs::copy(source, destination) {
            Ok(_) => return Ok(true),
            Err(e) => {
                last_err = e.to_string();
                eprintln!(
                    "复制失败 [{}/{}]: {} -> {}",
                    attempt,
                    max_attempts,
                    source.display(),
                    last_err
                );
                if attempt < max_attempts {
                    thread::sleep(delay);
                }
            }
        }
    }
    Err(format!("复制失败（尝试 {} 次）：{}", max_attempts, last_err))
}

/// 复制路径(时间段内)文件
///
/// # Arguments
/// * `source` - 文件|文件夹来源路径
/// * `destination` - 文件|文件夹目标路径
/// * `start_time` - 开始时间 格式: "%Y-%m-%d %H:%M:%S"
/// * `end_time` - 结束时间 格式: "%Y-%m-%d %H:%M:%S"
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_path_by_time(
    source: &str,
    destination: &str,
    start_time: &str,
    end_time: &str,
) -> Result<bool, String> {
    // 解析时间
    let start_date = match NaiveDateTime::parse_from_str(start_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("解析开始时间失败: {}", e)),
    };

    let end_date = match NaiveDateTime::parse_from_str(end_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("解析结束时间失败: {}", e)),
    };

    let source = Path::new(source);
    if !source.exists() {
        // 不存在源文件直接忽略吧
        return Ok(true);
    }

    let destination = Path::new(destination);
    if source.is_dir() {
        // 检查并创建目标文件夹
        if !destination.exists() {
            if let Err(e) = fs::create_dir_all(destination) {
                return Err(format!("创建目标文件夹失败: {}", e));
            }
        }
        for entry in match fs::read_dir(source) {
            Ok(entries) => entries,
            Err(e) => return Err(format!("读取源文件夹失败: {}", e)),
        } {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => return Err(format!("读取文件夹条目失败: {}", e)),
            };
            let entry_path = entry.path();
            let entry_name = entry.file_name();

            // 递归复制子文件或子目录
            let source_path = entry_path.to_str().ok_or("无效的源路径字符串")?;
            let destination_path_tmp = destination.join(entry_name); // 创建一个临时变量
            let destination_path = destination_path_tmp
                .to_str()
                .ok_or("无效的目标路径字符串")?; // 借用这个临时变量
                                                 /*
                                                 let copy_result = copy_path_by_time(source_path, destination_path, start_time, end_time);
                                                 if let Err(e) = copy_result {
                                                     return Err(format!("递归复制失败: {}", e));
                                                 }
                                                 */
            Box::pin(copy_path_by_time(
                source_path,
                destination_path,
                start_time,
                end_time,
            ))
            .await?;
        }
        return Ok(true);
    }

    // 复制文件
    let metadata = match fs::metadata(source) {
        Ok(meta) => meta,
        Err(e) => return Err(format!("获取文件元数据失败: {}", e)),
    };
    let modified_time: NaiveDateTime = match metadata.modified() {
        Ok(time) => {
            let datetime: DateTime<Local> = time.into();
            datetime.naive_local()
        }
        Err(e) => return Err(format!("获取文件修改时间失败: {}", e)),
    };
    if modified_time >= start_date && modified_time <= end_date {
        if let Err(e) = fs::copy(source, destination) {
            return Err(format!("复制文件失败: {}", e));
        }
    }
    Ok(true)
}

/// 复制文件夹中的所有*.dll文件
///
/// # Arguments
/// * `source` - 来源路径
/// * `destination` - 目标路径
/// * `del_destination` - 删除目标路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_dll_files(
    source: &str,
    destination: &str,
    del_destination: bool,
) -> Result<bool, String> {
    let src_dir = Path::new(source);
    let dst_dir = Path::new(destination);

    // 删除目标文件夹
    if del_destination {
        if let Err(e) = delete_dir(destination).await {
            return Err(e.to_string());
        }
    }

    // 检查并创建目标文件夹
    if !dst_dir.exists() {
        if let Err(e) = fs::create_dir_all(dst_dir) {
            return Err(format!("无法创建目标目录: {}", e));
        }
    }

    for entry in match fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(e) => return Err(format!("无法读取源目录: {}", e)),
    } {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return Err(format!("无法读取目录条目: {}", e)),
        };
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "dll") {
            let destination_file = dst_dir.join(path.file_name().ok_or("无效的文件名")?);
            if let Err(e) = fs::copy(&path, &destination_file) {
                return Err(format!("无法复制文件: {}", e));
            }
        }
    }

    Ok(true)
}

/// 复制文件夹中的所有(时间段内)*.dll文件
///
/// # Arguments
/// * `source` - 来源路径
/// * `destination` - 目标路径
/// * `del_destination` - 删除目标路径
/// * `start_time` - 开始时间 格式: "%Y-%m-%d %H:%M:%S"
/// * `end_time` - 结束时间 格式: "%Y-%m-%d %H:%M:%S"
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_dll_files_by_time(
    source: &str,
    destination: &str,
    del_destination: bool,
    start_time: &str,
    end_time: &str,
) -> Result<bool, String> {
    // 解析时间
    let start_date = match NaiveDateTime::parse_from_str(start_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("无法解析开始时间: {}", e)),
    };

    let end_date = match NaiveDateTime::parse_from_str(end_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("无法解析结束时间: {}", e)),
    };

    let src_dir = Path::new(source);
    let dst_dir = Path::new(destination);

    // 删除目标文件夹
    if del_destination {
        if let Err(e) = delete_dir(destination).await {
            return Err(e.to_string());
        }
    }

    // 检查并创建目标文件夹
    if !dst_dir.exists() {
        if let Err(e) = fs::create_dir_all(dst_dir) {
            return Err(format!("无法创建目标目录: {}", e));
        }
    }

    for entry in match fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(e) => return Err(format!("无法读取源目录: {}", e)),
    } {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return Err(format!("无法读取目录条目: {}", e)),
        };
        let path = entry.path();
        if path.is_file() && path.extension().unwrap_or_default() == "dll" {
            let metadata = match fs::metadata(&path) {
                Ok(meta) => meta,
                Err(e) => return Err(format!("无法获取文件的元数据: {}", e)),
            };
            let modified_time: NaiveDateTime = match metadata.modified() {
                Ok(time) => {
                    let datetime: DateTime<Local> = time.into();
                    datetime.naive_local()
                }
                Err(e) => return Err(format!("无法获取文件的修改时间: {}", e)),
            };

            if modified_time >= start_date && modified_time <= end_date {
                let destination_file = match path.file_name() {
                    Some(filename) => dst_dir.join(filename),
                    None => return Err("无法获取文件名".to_string()),
                };
                if let Err(e) = fs::copy(&path, &destination_file) {
                    return Err(format!("无法复制文件: {}", e));
                }
            }
        }
    }

    Ok(true)
}

/// 移动文件
///
/// # Arguments
/// * `source` - 来源路径
/// * `destination` - 目标路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn move_file(source: &str, destination: &str) -> Result<bool, String> {
    let src_path = Path::new(source);
    let dest_path = Path::new(destination);

    // 检查是否在同一个盘符
    if let (Some(src_drive), Some(dest_drive)) =
        (src_path.components().next(), dest_path.components().next())
    {
        if src_drive == dest_drive {
            // 尝试重命名
            return match fs::rename(source, destination) {
                Ok(_) => Ok(true),
                Err(e) => Err(format!("移动文件失败: {}", e)),
            };
        }
    }

    // 不在同一个盘符，使用复制+删除
    if let Err(e) = fs::copy(source, destination) {
        return Err(format!("复制文件失败: {}", e));
    }
    if let Err(e) = fs::remove_file(source) {
        return Err(format!("删除原文件失败: {}", e));
    }
    Ok(true)
}

/// 删除给定路径列表中的文件或文件夹
///
/// # Arguments
/// * `paths` - 要删除的文件或目录路径列表
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn delete_paths(paths: Vec<String>) -> Result<bool, String> {
    for src in paths {
        let path = Path::new(&src);
        if path.is_file() {
            if let Err(e) = delete_file(&src).await {
                return Err(e.to_string());
            }
        } else if path.is_dir() {
            if let Err(e) = delete_dir(&src).await {
                return Err(e.to_string());
            }
        } else {
            return Err(format!("路径 {} 不是文件或目录", src));
        }
    }
    Ok(true)
}

/// 删除文件
///
/// # Arguments
/// * `path` - 要删除的文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn delete_file(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    match fs::remove_file(path) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

/// 删除目录,包括所有子文件和子目录
///
/// # Arguments
/// * `path` - 要删除的目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn delete_dir(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    match fs::remove_dir_all(path) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

/// 下载远程服务器文件到本地
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 远程服务器地址
/// * `remote_paths` - 远程文件路径
/// * `local_paths` - 本地文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn download_server_files(
    local_paths: Vec<String>,
    remote_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
) -> Result<bool, String> {
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < MAX_RETRIES {
        match exec_download_server_files(
            local_paths.clone(),
            remote_paths.clone(),
            username,
            password,
            server,
        )
        .await
        {
            Ok(output) => return Ok(output),
            Err(e) => {
                eprintln!("尝试 {} 失败: {}，正在重试...", attempts + 1, e);
                attempts += 1;
                thread::sleep(RETRY_DELAY);
                err_msg = e.to_string();
            }
        }
    }
    // 错误以具体原因为主体（如"下载文件[路径]失败！"），次数作后缀；
    // 不再包"仍无法下载…到本地"外壳，避免与前端"文件上传失败，N s 后重试"等包装语重复
    Err(format!("{}（已尝试 {} 次）", err_msg, attempts))
}

/// 下载远程服务器文件到本地
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 远程服务器地址
/// * `remote_paths` - 远程文件路径
/// * `local_paths` - 本地文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
async fn exec_download_server_files(
    local_paths: Vec<String>,
    remote_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
) -> Result<bool, String> {
    if local_paths.len() != remote_paths.len() {
        return Err("本地路径和远程路径的数量必须相同.".into());
    }

    // 从连接池取（或新建）已认证的 SSH 会话
    let shared = ssh_pool::get_session(username, password, server)?;

    let outcome: Result<bool, String> = (|| {
        let mut entry = shared
            .lock()
            .map_err(|_| "SSH 会话锁中毒".to_string())?;

        let sftp = entry
            .session
            .sftp()
            .map_err(|e| format!("无法创建 SFTP 会话: {}", e))?;
        for (local_path, remote_path) in local_paths.iter().zip(remote_paths.iter()) {
            let local_path = Path::new(local_path);
            let remote_path = Path::new(remote_path);
            if remote_path_is_dir(&sftp, remote_path) {
                // 递归下载目录
                for entry in WalkDir::new(remote_path) {
                    let entry = entry.map_err(|e| format!("无法读取目录条目: {}", e))?;
                    let entry_path = entry.path();
                    let relative_path = entry_path.strip_prefix(remote_path).unwrap();
                    let local_file_path = local_path.join(relative_path);
                    if remote_path_is_dir(&sftp, entry_path) {
                        // 创建本地目录
                        std::fs::create_dir_all(&local_file_path)
                            .map_err(|e| format!("无法创建本地目录: {:?}", e))?;
                    } else {
                        // 下载文件
                        if !download_server_file(entry_path, &local_file_path, &sftp) {
                            return Err(format!("下载文件[{}]失败！", entry_path.display()));
                        }
                    }
                }
            } else {
                // 下载单个文件
                if !download_server_file(remote_path, local_path, &sftp) {
                    return Err(format!("下载文件[{}]失败！", remote_path.display()));
                }
            }
        }

        entry.last_used = Instant::now();
        Ok(true)
    })();

    match outcome {
        Ok(_) => Ok(true),
        Err(e) => {
            ssh_pool::invalidate(username, server);
            Err(e)
        }
    }
}

/// 验证远程服务器路径是否是目录
///
/// # Arguments
/// * `sftp` - SFTP会话
/// * `path` - 远程路径
///
/// # Returns
/// * `true` 成功 - 路径是目录
/// * `false` 失败 - 路径不是目录
// 这是一个辅助函数，用于确定远程路径是否是目录
fn remote_path_is_dir(sftp: &ssh2::Sftp, path: &Path) -> bool {
    if let Ok(metadata) = sftp.stat(path) {
        metadata.is_dir()
    } else {
        false
    }
}

/// 下载远程服务器文件
///
/// # Arguments
/// * `remote_path` - 远程文件路径
/// * `local_path` - 本地文件路径
/// * `sftp` - SFTP会话
///
/// # Returns
/// * `true` 成功
/// * `false` 失败
fn download_server_file(remote_path: &Path, local_path: &Path, sftp: &ssh2::Sftp) -> bool {
    match sftp.open(remote_path) {
        Ok(mut remote_file) => {
            if let Ok(mut local_file) = File::create(local_path) {
                let mut buffer = Vec::new();
                if remote_file.read_to_end(&mut buffer).is_ok()
                    && local_file.write_all(&buffer).is_ok() {
                        return true;
                    }
            }
        }
        Err(e) => {
            eprintln!("无法打开远程文件: {:?}", e);
        }
    }
    false
}

/// 上传文件到服务器
///
/// # Arguments
/// * `local_paths` - 本地文件|目录路径
/// * `remote_paths` - 远程文件|目录路径
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn upload_server_files(
    remote_paths: Vec<String>,
    local_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<bool, String> {
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < max_attempts {
        match exec_upload_server_files(
            remote_paths.clone(),
            local_paths.clone(),
            username,
            password,
            server,
        )
        .await
        {
            Ok(output) => return Ok(output),
            Err(e) => {
                eprintln!("尝试 {} 失败: {}，正在重试...", attempts + 1, e);
                attempts += 1;
                if attempts < max_attempts {
                    thread::sleep(delay);
                }
                err_msg = e.to_string();
            }
        }
    }
    // 错误以具体原因为主体（如"上传文件[路径]失败！"），次数作后缀；
    // 不再包"仍无法将上传文件到服务器"外壳，避免与前端"文件上传失败，N s 后重试"等包装语重复
    Err(format!("{}（已尝试 {} 次）", err_msg, attempts))
}

/// 上传文件到服务器
///
/// # Arguments
/// * `local_paths` - 本地文件|目录路径
/// * `remote_paths` - 远程文件|目录路径
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
async fn exec_upload_server_files(
    remote_paths: Vec<String>,
    local_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
) -> Result<bool, String> {
    if local_paths.len() != remote_paths.len() {
        return Err("本地路径和远程路径的数量必须相同.".into());
    }

    // 从连接池取（或新建）已认证的 SSH 会话
    let shared = ssh_pool::get_session(username, password, server)?;

    let outcome: Result<bool, String> = (|| {
        let mut entry = shared
            .lock()
            .map_err(|_| "SSH 会话锁中毒".to_string())?;

        let sftp = entry
            .session
            .sftp()
            .map_err(|e| format!("无法创建 SFTP 会话: {}", e))?;
        for (local_path, remote_path) in local_paths.iter().zip(remote_paths.iter()) {
            let local_path = Path::new(local_path);
            let remote_path = Path::new(remote_path);
            if local_path.is_dir() {
                // 递归上传目录
                for entry in WalkDir::new(local_path) {
                    let entry = entry.map_err(|e| format!("无法读取目录条目: {}", e))?;
                    let entry_path = entry.path();
                    let relative_path = entry_path.strip_prefix(local_path).unwrap();
                    let remote_file_path = remote_path.join(relative_path);
                    if entry_path.is_dir() {
                        // 创建远程目录
                        println!("创建远程目录: {}", remote_file_path.display());
                        sftp.mkdir(&remote_file_path, 0o755)
                            .map_err(|e| format!("无法创建远程目录: {:?}", e))?;
                    } else {
                        // 上传文件
                        if !upload_server_file(entry_path, &remote_file_path, &sftp) {
                            return Err(format!("上传文件[{}]失败！", entry_path.display()));
                        }
                    }
                }
            } else {
                // 上传单个文件
                if !upload_server_file(local_path, remote_path, &sftp) {
                    return Err(format!("上传文件[{}]失败！", local_path.display()));
                }
            }
        }

        entry.last_used = Instant::now();
        Ok(true)
    })();

    match outcome {
        Ok(_) => Ok(true),
        Err(e) => {
            ssh_pool::invalidate(username, server);
            Err(e)
        }
    }
}

/// 上传服务器文件
///
/// # Arguments
/// * `local_paths` - 本地文件|目录路径
/// * `remote_paths` - 远程文件|目录路径
/// * `sftp` - SFTP会话
///
/// # Returns
/// * `true` 成功
/// * `false` 失败
fn upload_server_file(local_path: &Path, remote_path: &Path, sftp: &ssh2::Sftp) -> bool {
    // 打开本地文件
    let local_file_result = File::open(local_path);
    let mut local_file = match local_file_result {
        Ok(file) => file,
        Err(e) => {
            println!("无法打开本地文件 {}: {}", local_path.display(), e);
            return false;
        }
    };

    // 创建远程文件
    let mut remote_file = match sftp.create(remote_path) {
        Ok(file) => file,
        Err(e) => {
            println!("无法创建远程文件 {}: {}", remote_path.display(), e);
            return false;
        }
    };

    // 将本地文件内容写入远程文件
    let mut buffer = Vec::new();
    if local_file.read_to_end(&mut buffer).is_err() {
        println!("无法读取本地文件 {}", local_path.display());
        return false;
    }
    if remote_file.write_all(&buffer).is_err() {
        println!("无法写入远程文件 {}", remote_path.display());
        return false;
    }

    true
}

/// 执行本地命令
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn execute_local_command(
    command: &str,
    args: Vec<String>,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<String, String> {
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < max_attempts {
        match exec_local_command(command, args.clone()).await {
            Ok(output) => return Ok(output),
            Err(e) => {
                eprintln!("尝试 {} 失败: {}，正在重试...", attempts + 1, e);
                attempts += 1;
                if attempts < max_attempts {
                    thread::sleep(delay);
                }
                err_msg = e.to_string();
            }
        }
    }
    Err(format!(
        "尝试 {} 次后，该命令仍无法执行：{}",
        attempts, err_msg
    ))
}

/// 执行本地命令
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
async fn exec_local_command(command: &str, args: Vec<String>) -> Result<String, String> {
    match Command::new(command)
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let (stdout, _, _) = GBK.decode(&output.stdout);
                Ok(stdout.to_string())
            } else {
                let (stderr, _, _) = GBK.decode(&output.stderr);
                Err(format!("命令失败，出现错误:\n{}", stderr))
            }
        }
        Err(e) => {
            if e.kind() == ErrorKind::NotFound {
                Err("找不到命令".to_string())
            } else {
                Err(format!("无法执行命令: {}", e))
            }
        }
    }
}

/// 运行命令
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn exec_local_command_spawn(command: &str, args: Vec<String>) -> Result<(), String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("命令失败，出现错误: {}", e))?;

    let status = child.wait().map_err(|e| format!("无法等待 child: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("命令已退出，状态为： {}", status))
    }
}

/// 执行本地命令（指定工作目录）
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
/// * `working_dir` - 工作目录
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn execute_local_command_with_working_dir(
    command: &str,
    args: Vec<String>,
    working_dir: &str,
) -> Result<String, String> {
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < MAX_RETRIES {
        match exec_local_command_with_working_dir(command, args.clone(), working_dir).await {
            Ok(output) => return Ok(output),
            Err(e) => {
                eprintln!("尝试 {} 失败: {}，正在重试...", attempts + 1, e);
                attempts += 1;
                thread::sleep(RETRY_DELAY);
                err_msg = e.to_string();
            }
        }
    }
    Err(format!(
        "尝试 {} 次后，该命令仍无法执行：{}",
        attempts, err_msg
    ))
}

/// 执行本地命令（指定工作目录）
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
/// * `working_dir` - 工作目录
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
async fn exec_local_command_with_working_dir(
    command: &str,
    args: Vec<String>,
    working_dir: &str,
) -> Result<String, String> {
    match Command::new(command)
        .args(args)
        .current_dir(working_dir)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                // 尝试使用 UTF-8 解码，如果失败则回退到 GBK 解码
                let (stdout, _encoding_used, is_errors) = UTF_8.decode(&output.stdout);
                if is_errors {
                    // 如果 UTF-8 解码出现错误，使用 GBK 解码
                    let (gbk_stdout, _, _) = GBK.decode(&output.stdout);
                    Ok(gbk_stdout.to_string())
                } else {
                    Ok(stdout.to_string())
                }
            } else {
                // 错误信息同样处理编码问题
                let (stderr, _encoding_used, is_errors) = UTF_8.decode(&output.stderr);
                if is_errors {
                    let (gbk_stderr, _, _) = GBK.decode(&output.stderr);
                    Err(format!("命令失败，出现错误:\n{}", gbk_stderr))
                } else {
                    Err(format!("命令失败，出现错误:\n{}", stderr))
                }
            }
        }
        Err(e) => {
            if e.kind() == ErrorKind::NotFound {
                Err("找不到命令".to_string())
            } else {
                Err(format!("无法执行命令: {}", e))
            }
        }
    }
}

/// 读取目录中的所有DLL文件
///
/// # Arguments
/// * `dir` - 目录路径
///
/// # Returns
/// * `Ok(Vec<String>)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_all_dlls(dir: &str) -> Result<Vec<String>, String> {
    let mut dll_files = Vec::new();

    // 迭代指定目录中的文件
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // 检查文件是否为 DLL
        if path.extension() == Some(OsStr::new("dll")) {
            if let Some(file_name) = path.to_str() {
                dll_files.push(file_name.to_string());
            }
        }
    }

    Ok(dll_files)
}

/// 读取日期范围内的DLL文件
///
/// # Arguments
/// * `dir` - 目录路径
/// * `start_date` - 起始日期
/// * `end_date` - 结束日期
///
/// # Returns
/// * `Ok(Vec<String>)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_dlls_in_date_range(
    dir: &str,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<String>, String> {
    let start_date: NaiveDateTime = NaiveDateTime::parse_from_str(start_date, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("无效的起始日期: {}", e))?;
    let end_date = NaiveDateTime::parse_from_str(end_date, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("无效的结束日期: {}", e))?;

    let mut dll_files = Vec::new();

    // 迭代指定目录中的文件
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // 检查文件是否为 DLL
        if path.extension() == Some(OsStr::new("dll")) {
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;

            if let Ok(modified) = metadata.modified() {
                let modified_date: DateTime<Local> = modified.into();
                let file_date = modified_date.naive_local();

                // 检查文件的修改日期是否在指定范围内
                if file_date >= start_date && file_date <= end_date {
                    if let Some(file_name) = path.to_str() {
                        dll_files.push(file_name.to_string());
                    }
                }
            }
        }
    }

    Ok(dll_files)
}

/// 保存内容到文件
///
/// # Arguments
/// * `content` - 内容
/// * `file_path` - 文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn save_content_to_file(content: &str, file_path: &str) -> Result<bool, String> {
    // 创建或打开文件
    let mut file = File::create(file_path).map_err(|e| e.to_string())?;
    // 将内容值写入文件
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 读取内容文件
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_content_to_file(file_path: &str) -> Result<String, String> {
    match File::open(file_path) {
        Ok(mut file) => {
            let mut contents = String::new();
            if file.read_to_string(&mut contents).is_ok() {
                Ok(contents)
            } else {
                Err("无法读取文件".to_string())
            }
        }
        Err(e) => Err(format!("打开文件时出错: {}", e)),
    }
}

/// 获取加密Key
///
/// # Returns
/// * `Ok(String)` 成功
#[tauri::command]
pub async fn get_encryption_key() -> String {
    // 先写死
    let key = "REX_SMOM_15200";
    // ...
    key.to_string()
}

/// 删除指定目录中所有以给定前缀开头的文件
///
/// # 参数
/// - `dir_path`: 要扫描并删除文件的目录路径
/// - `prefix`: 文件名前缀，用于匹配需要删除的文件
///
/// # 返回值
/// - `Ok(true)` 表示操作完成（不一定有文件被删除）
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn delete_files_with_prefix(dir_path: &str, prefix: &str) -> Result<bool, String> {
    let path = Path::new(dir_path);

    if !path.exists() {
        return Err(format!("目录不存在: {}", dir_path));
    }

    if !path.is_dir() {
        return Err(format!("提供的路径不是一个目录: {}", dir_path));
    }

    for entry in fs::read_dir(path).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.starts_with(prefix) {
                    if let Err(e) = fs::remove_file(&path) {
                        return Err(format!("删除文件失败 {}: {}", path.display(), e));
                    }
                }
            }
        }
    }

    Ok(true)
}

/// 根据文件名过滤器复制
///
/// # 参数
/// - `src_dir`: 源目录
/// - `dest_dir`: 目标目录
/// - `filter`: 过滤条件
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
fn copy_dlls_with_filter<P, F>(src_dir: P, dest_dir: P, filter: F) -> Result<bool, String>
where
    P: AsRef<Path>,
    F: Fn(&str) -> bool,
{
    let src = src_dir.as_ref();
    let dest = dest_dir.as_ref();

    // 确保目标目录存在
    fs::create_dir_all(dest).map_err(|e| format!("无法创建目标目录 {:?}: {}", dest, e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("无法读取源目录 {:?}: {}", src, e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();

        // 跳过非文件项（如子目录）
        if !path.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue, // 跳过非 UTF-8 文件名（不视为错误）
        };

        // 检查是否是 .dll 文件（不区分大小写）
        if !file_name.to_lowercase().ends_with(".dll") {
            continue;
        }

        if filter(file_name) {
            let dest_path = dest.join(file_name);
            fs::copy(&path, &dest_path)
                .map_err(|e| format!("复制文件 {:?} 到 {:?} 失败: {}", path, dest_path, e))?;
        }
    }

    Ok(true) // 成功完成
}

/// 复制以SIE开头的dll文件
///
/// # 参数
/// - `src_dir`: 源目录
/// - `dest_dir`: 目标目录
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn copy_sie_dlls(src_dir: &str, dest_dir: &str) -> Result<bool, String> {
    copy_dlls_with_filter(src_dir, dest_dir, |file_name| file_name.starts_with("SIE"))
}

/// 复制不以SIE开头的dll文件
///
/// # 参数
/// - `src_dir`: 源目录
/// - `dest_dir`: 目标目录
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn copy_non_sie_dlls(src_dir: &str, dest_dir: &str) -> Result<bool, String> {
    copy_dlls_with_filter(src_dir, dest_dir, |file_name| !file_name.starts_with("SIE"))
}

use regex::Regex;
use std::collections::HashMap;
use std::time::SystemTime;

/// 将通配符模式转换为正则表达式
fn wildcard_to_regex(pattern: &str) -> Result<Regex, regex::Error> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Regex::new("^$");
    }
    let regex_str = if pattern.to_lowercase().ends_with(".dll") {
        regex::escape(pattern)
    } else {
        format!("{}\\.dll", regex::escape(pattern))
    };
    let regex_str = regex_str.replace(r"\*", ".*").replace(r"\?", ".");
    Regex::new(&format!("^{}$", regex_str))
}

/// 解析模式文本，支持换行和顿号分隔
fn parse_patterns(patterns_text: &str) -> Vec<Regex> {
    let mut patterns = Vec::new();
    for line in patterns_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 如果行中包含顿号且不含通配符，则按顿号分割
        if line.contains('、') && !line.contains('*') && !line.contains('?') {
            for item in line.split('、') {
                let item = item.trim();
                if item.is_empty() {
                    continue;
                }
                if let Ok(re) = wildcard_to_regex(item) {
                    patterns.push(re);
                }
            }
        } else if let Ok(re) = wildcard_to_regex(line) {
            patterns.push(re);
        }
    }
    patterns
}

/// 根据DLL名称模式复制文件（支持*和?通配符，同名文件保留最新的）
///
/// # 参数
/// - `source`: 源目录
/// - `destination`: 目标目录
/// - `patterns`: DLL名称模式文本，每行一个，支持顿号分隔
/// - `del_destination`: 是否先删除目标目录（避免残留旧文件）
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn copy_dll_files_by_name(
    source: &str,
    destination: &str,
    patterns: &str,
    del_destination: bool,
) -> Result<bool, String> {
    let src_dir = Path::new(source);
    let dst_dir = Path::new(destination);

    if !src_dir.exists() {
        return Err(format!("源目录不存在: {}", source));
    }

    // 删除目标文件夹
    if del_destination {
        if let Err(e) = delete_dir(destination).await {
            return Err(e.to_string());
        }
    }

    // 确保目标目录存在
    fs::create_dir_all(dst_dir).map_err(|e| format!("无法创建目标目录 {:?}: {}", dst_dir, e))?;

    let regex_patterns = parse_patterns(patterns);
    if regex_patterns.is_empty() {
        return Err("未提供有效的DLL匹配模式".to_string());
    }

    // 字典：filename -> (mtime, full_path)
    let mut latest_files: HashMap<String, (SystemTime, std::path::PathBuf)> = HashMap::new();

    // 遍历源目录中的所有文件
    for entry in
        fs::read_dir(src_dir).map_err(|e| format!("无法读取源目录 {:?}: {}", src_dir, e))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();

        // 跳过非文件项
        if !path.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };

        // 检查是否是 .dll 文件（不区分大小写）
        if !file_name.to_lowercase().ends_with(".dll") {
            continue;
        }

        // 尝试匹配任一模式
        let mut matched = false;
        for re in &regex_patterns {
            if re.is_match(file_name) {
                matched = true;
                break;
            }
        }

        if !matched {
            continue;
        }

        let mtime = match fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(time) => time,
            Err(_) => SystemTime::UNIX_EPOCH,
        };

        // 以文件名（忽略大小写）作为唯一键，保留修改时间最新的
        let key = file_name.to_lowercase();
        if let Some((existing_mtime, _)) = latest_files.get(&key) {
            if mtime <= *existing_mtime {
                continue;
            }
        }
        latest_files.insert(key, (mtime, path));
    }

    // 复制匹配的文件
    for (_, (_, src_path)) in latest_files {
        let dest_path = dst_dir.join(
            src_path
                .file_name()
                .ok_or_else(|| "无法获取文件名".to_string())?,
        );
        fs::copy(&src_path, &dest_path)
            .map_err(|e| format!("复制文件 {:?} 到 {:?} 失败: {}", src_path, dest_path, e))?;
    }

    Ok(true)
}

/// 按DLL名称模式读取匹配的DLL文件名列表（支持*和?通配符、顿号分隔）
///
/// # 参数
/// - `dir`: 源目录
/// - `patterns`: DLL名称模式文本，每行一个，支持顿号分隔
///
/// # 返回值
/// - `Ok(Vec<String>)` 匹配的DLL文件名列表（仅文件名，不含路径）
/// - `Err(String)` 失败
#[tauri::command]
pub async fn read_dlls_by_name(dir: &str, patterns: &str) -> Result<Vec<String>, String> {
    let src_dir = Path::new(dir);
    if !src_dir.exists() {
        return Err(format!("源目录不存在: {}", dir));
    }

    let regex_patterns = parse_patterns(patterns);
    if regex_patterns.is_empty() {
        return Err("未提供有效的DLL匹配模式".to_string());
    }

    let mut dll_files = Vec::new();
    for entry in fs::read_dir(src_dir).map_err(|e| format!("无法读取源目录 {:?}: {}", src_dir, e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        // 检查是否是 .dll 文件（不区分大小写），与 copy_dll_files_by_name 一致
        if !file_name.to_lowercase().ends_with(".dll") {
            continue;
        }
        // 尝试匹配任一模式（大小写敏感，与 copy_dll_files_by_name 一致）
        if regex_patterns.iter().any(|re| re.is_match(file_name)) {
            dll_files.push(file_name.to_string());
        }
    }
    Ok(dll_files)
}