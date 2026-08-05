import { db } from '@/database/sqlite';
import { formatDate } from "@/utils/formatTime";

const COLS = "id, project_id projectId, environment, service_name serviceName, server_id serverId, check_url checkUrl, check_timeout checkTimeout, enabled, create_time createTime";

export function useHealthCheckDb() {
    return {
        /** 查询某项目+环境下的健康检查配置（可选按服务过滤） */
        getHealthCheck: async (projectId: number, environment: number, serviceName?: string) => {
            let sql = `select ${COLS} from t_health_check where project_id = $1 and environment = $2`;
            const bind: any[] = [projectId, environment];
            if (serviceName) { sql += " and service_name = $3"; bind.push(serviceName); }
            let dataResult: DataResultType<RowHealthCheckType[]> = { code: 0, msg: "", data: [] };
            try {
                dataResult.data = await (await db()).select<RowHealthCheckType[]>(sql, bind);
                dataResult.msg = "查询健康检查配置成功";
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "查询健康检查配置出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 查询启用的健康检查（发布后健康检查步骤遍历调用） */
        listEnabled: async (projectId: number, environment: number) => {
            const sql = `select ${COLS} from t_health_check where project_id = $1 and environment = $2 and enabled = 1`;
            let dataResult: DataResultType<RowHealthCheckType[]> = { code: 0, msg: "", data: [] };
            try {
                dataResult.data = await (await db()).select<RowHealthCheckType[]>(sql, [projectId, environment]);
                dataResult.msg = "查询启用健康检查成功";
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "查询启用健康检查出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 新增/更新（按 (project_id, environment, service_name, server_id) 唯一键：先查存在行再决定 update/insert） */
        upsertHealthCheck: async (data: RowHealthCheckType) => {
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const existSql = "select id from t_health_check where project_id = $1 and environment = $2 and service_name = $3 and server_id = $4 limit 1";
                const existRows = await (await db()).select<{ id: number }[]>(existSql, [data.projectId, data.environment, data.serviceName, data.serverId]);
                const existingId = existRows && existRows.length > 0 ? existRows[0].id : null;
                if (existingId) {
                    const sql = "UPDATE t_health_check SET check_url = $1, check_timeout = $2, enabled = $3 WHERE id = $4";
                    const r = await (await db()).execute(sql, [data.checkUrl, data.checkTimeout ?? 30, data.enabled, existingId]);
                    if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = existingId; dataResult.msg = "更新健康检查成功"; }
                    else { dataResult.msg = "更新健康检查失败"; }
                } else {
                    const sql = "INSERT INTO t_health_check (project_id, environment, service_name, server_id, check_url, check_timeout, enabled, create_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id;";
                    const r = await (await db()).execute(sql, [
                        data.projectId, data.environment, data.serviceName, data.serverId,
                        data.checkUrl, data.checkTimeout ?? 30, data.enabled,
                        formatDate(new Date(), "YYYY-mm-dd HH:MM:SS"),
                    ]);
                    if (r.lastInsertId && r.lastInsertId > 0) { dataResult.code = 0; dataResult.data = r.lastInsertId; dataResult.msg = "新增健康检查成功"; }
                    else { dataResult.msg = "新增健康检查失败"; }
                }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "保存健康检查出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 删除 */
        deleteHealthCheck: async (id: number) => {
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const r = await (await db()).execute("DELETE FROM t_health_check WHERE id = $1", [id]);
                if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = id; dataResult.msg = "删除健康检查成功"; }
                else { dataResult.msg = "删除健康检查失败"; }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "删除健康检查出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },
    };
}
