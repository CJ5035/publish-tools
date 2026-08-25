import { db } from '@/database/sqlite';
import { formatDate } from "@/utils/formatTime";

export function useScanConfigDb() {
    return {
        /** 查询扫描规则列表（含全局 + 指定项目） */
        getScanConfigList: async (projectId?: number) => {
            let sql = "select id, name, exclude_patterns excludePatterns, include_patterns includePatterns, exclude_system_dirs excludeSystemDirs, exclude_hidden_dirs excludeHiddenDirs, is_global isGlobal, project_id projectId, create_time createTime, service_keywords serviceKeywords from t_scan_config";
            let dataResult: DataResultType<RowScanConfigType[]> = { code: 0, msg: "", data: [] };
            try {
                if (projectId !== undefined) {
                    sql += " where is_global = 1 or project_id = $1 order by is_global desc, id asc";
                    dataResult.data = await (await db()).select<RowScanConfigType[]>(sql, [projectId]);
                } else {
                    sql += " where is_global = 1 order by id asc";
                    dataResult.data = await (await db()).select<RowScanConfigType[]>(sql);
                }
                dataResult.msg = "查询扫描规则成功";
            } catch (error) {
                dataResult.code = -1;
                dataResult.msg = "查询扫描规则出错：" + JSON.stringify(error);
                console.error(error);
            }
            return dataResult;
        },

        /** 根据ID查询 */
        getScanConfigById: async (id: number) => {
            const sql = "select id, name, exclude_patterns excludePatterns, include_patterns includePatterns, exclude_system_dirs excludeSystemDirs, exclude_hidden_dirs excludeHiddenDirs, is_global isGlobal, project_id projectId, create_time createTime, service_keywords serviceKeywords from t_scan_config where id = $1";
            let dataResult: DataResultType<RowScanConfigType> = { code: 0, msg: "", data: {} as RowScanConfigType };
            try {
                const rows = await (await db()).select<RowScanConfigType[]>(sql, [id]);
                if (rows && rows.length > 0) dataResult.data = rows[0];
                dataResult.msg = "查询扫描规则成功";
            } catch (error) {
                dataResult.code = -1;
                dataResult.msg = "查询扫描规则出错：" + JSON.stringify(error);
                console.error(error);
            }
            return dataResult;
        },

        /** 取默认全局规则（is_global=1） */
        getDefaultScanConfig: async () => {
            const sql = "select id, name, exclude_patterns excludePatterns, include_patterns includePatterns, exclude_system_dirs excludeSystemDirs, exclude_hidden_dirs excludeHiddenDirs, is_global isGlobal, project_id projectId, create_time createTime, service_keywords serviceKeywords from t_scan_config where is_global = 1 order by id asc limit 1";
            let dataResult: DataResultType<RowScanConfigType> = { code: 0, msg: "", data: {} as RowScanConfigType };
            try {
                const rows = await (await db()).select<RowScanConfigType[]>(sql);
                if (rows && rows.length > 0) dataResult.data = rows[0];
                dataResult.msg = "查询默认扫描规则成功";
            } catch (error) {
                dataResult.code = -1;
                dataResult.msg = "查询默认扫描规则出错：" + JSON.stringify(error);
                console.error(error);
            }
            return dataResult;
        },

        /** 新增/更新扫描规则（有 id 走 update，无走 insert） */
        upsertScanConfig: async (data: RowScanConfigType) => {
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                if (data.id && data.id > 0) {
                    const sql = "UPDATE t_scan_config SET name = $1, exclude_patterns = $2, include_patterns = $3, exclude_system_dirs = $4, exclude_hidden_dirs = $5, is_global = $6, project_id = $7, service_keywords = $8 WHERE id = $9";
                    const r = await (await db()).execute(sql, [
                        data.name, data.excludePatterns, data.includePatterns,
                        data.excludeSystemDirs, data.excludeHiddenDirs, data.isGlobal, data.projectId ?? null, (data.serviceKeywords ?? null), data.id,
                    ]);
                    if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = data.id; dataResult.msg = "更新扫描规则成功"; }
                    else { dataResult.msg = "更新扫描规则失败"; }
                } else {
                    const sql = "INSERT INTO t_scan_config (name, exclude_patterns, include_patterns, exclude_system_dirs, exclude_hidden_dirs, is_global, project_id, create_time, service_keywords) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id;";
                    const r = await (await db()).execute(sql, [
                        data.name, data.excludePatterns, data.includePatterns,
                        data.excludeSystemDirs, data.excludeHiddenDirs, data.isGlobal, data.projectId ?? null,
                        formatDate(new Date(), "YYYY-mm-dd HH:MM:SS"),
                        (data.serviceKeywords ?? null),
                    ]);
                    if (r.lastInsertId && r.lastInsertId > 0) { dataResult.code = 0; dataResult.data = r.lastInsertId; dataResult.msg = "新增扫描规则成功"; }
                    else { dataResult.msg = "新增扫描规则失败"; }
                }
            } catch (error) {
                dataResult.code = -1;
                dataResult.msg = "保存扫描规则出错：" + JSON.stringify(error);
                console.error(error);
            }
            return dataResult;
        },

        /** 删除扫描规则 */
        deleteScanConfig: async (id: number) => {
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const r = await (await db()).execute("DELETE FROM t_scan_config WHERE id = $1", [id]);
                if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = id; dataResult.msg = "删除扫描规则成功"; }
                else { dataResult.msg = "删除扫描规则失败"; }
            } catch (error) {
                dataResult.code = -1;
                dataResult.msg = "删除扫描规则出错：" + JSON.stringify(error);
                console.error(error);
            }
            return dataResult;
        },
    };
}
