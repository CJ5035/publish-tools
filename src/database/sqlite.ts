import Database from "@tauri-apps/plugin-sql";
import { formatDate } from "@/utils/formatTime";

let database: Database | null = null;
let schemaReady = false;

// Sqlite数据库[smom.db]
export async function db(): Promise<Database> {
    if (!database) database = await Database.load("sqlite:smom.db");
    if (!schemaReady) {
        await ensureSchema(database);
        schemaReady = true;
    }
    return database;
}

async function ensureSchema(database: Database) {
    // ========== 建表（CREATE TABLE IF NOT EXISTS，幂等安全） ==========
    await database.execute(`CREATE TABLE IF NOT EXISTS t_project (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        code TEXT,
        name TEXT,
        is_default INTEGER,
        assembly_out_path TEXT,
        description TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_app_config (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        environment INTEGER,
        ms_build_path TEXT,
        dll_mode TEXT,
        dll_mode_value TEXT,
        config_items_json TEXT,
        build_mode TEXT default 'Debug'
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_server (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        name TEXT,
        os INTEGER,
        ip TEXT,
        port INTEGER,
        account TEXT,
        pwd TEXT,
        description TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_backup (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        project_name TEXT,
        environment INTEGER,
        backup_date TEXT,
        remark TEXT,
        backup_items_json TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_restore (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        backup_id INTEGER,
        restore_date TEXT,
        result INTEGER,
        log_content TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_team_foundation_server (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        tfs_name TEXT,
        tfs_server_url TEXT,
        tfs_source_path TEXT,
        tfvc_path TEXT,
        remark TEXT,
        tfs_local_path TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_git (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        git_name TEXT,
        git_repository TEXT,
        git_path TEXT,
        branch_name TEXT,
        remark TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_publish_schedule (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        project_name TEXT,
        environment INTEGER,
        appconfig_id INTEGER,
        publish_type TEXT,
        scheduled_time TEXT,
        status TEXT DEFAULT 'pending',
        create_time TEXT,
        execute_time TEXT,
        result_log TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_settings (
        id INTEGER NOT NULL PRIMARY KEY,
        one_click_publish_enabled INTEGER DEFAULT 0,
        win_service_stop_retry_count INTEGER DEFAULT 3,
        win_service_stop_retry_interval INTEGER DEFAULT 2,
        win_copy_retry_count INTEGER DEFAULT 3,
        win_copy_retry_interval INTEGER DEFAULT 2,
        update_time TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_scan_config (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        exclude_patterns TEXT,
        include_patterns TEXT,
        exclude_system_dirs INTEGER DEFAULT 1,
        exclude_hidden_dirs INTEGER DEFAULT 1,
        is_global INTEGER DEFAULT 0,
        project_id INTEGER,
        create_time TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_deploy_task (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        project_name TEXT,
        environment INTEGER,
        appconfig_id INTEGER,
        run_id TEXT,
        trigger_type TEXT,
        status TEXT,
        operator TEXT,
        source TEXT,
        selected_services TEXT,
        start_time TEXT,
        end_time TEXT,
        rollback_time TEXT,
        rollback_reason TEXT,
        create_time TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_deploy_task_detail (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        run_id TEXT,
        service_name TEXT,
        server_id INTEGER,
        server_name TEXT,
        server_identity TEXT,
        remote_path TEXT,
        status TEXT,
        retry_count INTEGER DEFAULT 0,
        health_check_result TEXT,
        backup_path TEXT,
        error_message TEXT,
        step TEXT,
        start_time TEXT,
        end_time TEXT,
        create_time TEXT
    )`);

    await database.execute(`CREATE TABLE IF NOT EXISTS t_health_check (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        environment INTEGER NOT NULL,
        service_name TEXT NOT NULL,
        server_id INTEGER NOT NULL,
        check_url TEXT,
        check_timeout INTEGER DEFAULT 30,
        enabled INTEGER DEFAULT 1,
        create_time TEXT
    )`);
    await database.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_t_health_check_unique ON t_health_check (project_id, environment, service_name, server_id)`);

    // ========== 改表（已有表加字段，先检查是否存在） ==========
    const columns = await database.select<{ name: string }[]>("PRAGMA table_info(t_app_config)");
    const hasBuildMode = columns.some((column) => column.name === "build_mode");
    if (!hasBuildMode) {
        await database.execute("ALTER TABLE t_app_config ADD COLUMN build_mode TEXT DEFAULT 'Debug'");
    }

    const settingsCols = await database.select<{ name: string }[]>("PRAGMA table_info(t_settings)");
    if (!settingsCols.some((c) => c.name === "win_upload_retry_count")) {
        await database.execute("ALTER TABLE t_settings ADD COLUMN win_upload_retry_count INTEGER DEFAULT 100");
    }
    if (!settingsCols.some((c) => c.name === "win_upload_retry_interval")) {
        await database.execute("ALTER TABLE t_settings ADD COLUMN win_upload_retry_interval INTEGER DEFAULT 3");
    }

    await database.execute(`INSERT INTO t_scan_config (name, exclude_patterns, include_patterns, exclude_system_dirs, exclude_hidden_dirs, is_global, project_id, create_time)
SELECT '默认扫描规则',
  '["bin","boot","dev","etc","lib","lib64","proc","sys","tmp","var","usr","logs","temp"]',
  '["*.dll","*.exe","*.config","*.json","*.so"]',
  1, 1, 1, NULL, '${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}'
WHERE NOT EXISTS (SELECT 1 FROM t_scan_config WHERE is_global = 1 AND name = '默认扫描规则')`);
}

// 关闭数据库连接
export async function closeDb() {
    if (!database) return;
    await database.close();
    database = null;
    schemaReady = false;
}