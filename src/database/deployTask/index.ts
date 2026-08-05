import { db } from '@/database/sqlite';
import { formatDate } from "@/utils/formatTime";

const TASK_COLS = "id, project_id projectId, project_name projectName, environment, appconfig_id appconfigId, run_id runId, trigger_type triggerType, status, operator, source, selected_services selectedServices, start_time startTime, end_time endTime, rollback_time rollbackTime, rollback_reason rollbackReason, create_time createTime";
const DETAIL_COLS = "id, task_id taskId, run_id runId, service_name serviceName, server_id serverId, server_name serverName, server_identity serverIdentity, remote_path remotePath, status, retry_count retryCount, health_check_result healthCheckResult, backup_path backupPath, error_message errorMessage, step, start_time startTime, end_time endTime, create_time createTime";

export function useDeployTaskDb() {
    return {
        /** 新增任务（开始发布时调用），返回任务 id */
        insertTask: async (data: RowDeployTaskType) => {
            const sql = "INSERT INTO t_deploy_task (project_id, project_name, environment, appconfig_id, run_id, trigger_type, status, operator, source, selected_services, start_time, create_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id;";
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const now = formatDate(new Date(), "YYYY-mm-dd HH:MM:SS");
                const r = await (await db()).execute(sql, [
                    data.projectId, data.projectName, data.environment, data.appconfigId,
                    data.runId, data.triggerType, data.status ?? 'running', data.operator ?? 'system',
                    data.source, data.selectedServices ?? null, now, now,
                ]);
                if (r.lastInsertId && r.lastInsertId > 0) { dataResult.code = 0; dataResult.data = r.lastInsertId; dataResult.msg = "新增发布任务成功"; }
                else { dataResult.msg = "新增发布任务失败"; }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "新增发布任务出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 更新任务状态（结束/回退） */
        updateTaskStatus: async (id: number, status: DeployTaskStatus, endTime?: string) => {
            const sql = "UPDATE t_deploy_task SET status = $1, end_time = $2 WHERE id = $3";
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const r = await (await db()).execute(sql, [status, endTime ?? formatDate(new Date(), "YYYY-mm-dd HH:MM:SS"), id]);
                if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = id; dataResult.msg = "更新任务状态成功"; }
                else { dataResult.msg = "更新任务状态失败"; }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "更新任务状态出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 记录回退信息 */
        recordRollback: async (id: number, reason: string) => {
            const sql = "UPDATE t_deploy_task SET rollback_time = $1, rollback_reason = $2 WHERE id = $3";
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const r = await (await db()).execute(sql, [formatDate(new Date(), "YYYY-mm-dd HH:MM:SS"), reason, id]);
                if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = id; dataResult.msg = "记录回退信息成功"; }
                else { dataResult.msg = "记录回退信息失败"; }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "记录回退信息出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 按 id 查任务 */
        getTaskById: async (id: number) => {
            let dataResult: DataResultType<RowDeployTaskType> = { code: 0, msg: "", data: {} as RowDeployTaskType };
            try {
                const rows = await (await db()).select<RowDeployTaskType[]>(`select ${TASK_COLS} from t_deploy_task where id = $1`, [id]);
                if (rows && rows.length > 0) dataResult.data = rows[0];
                dataResult.msg = "查询任务成功";
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "查询任务出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 任务列表（按开始时间倒序） */
        getTaskList: async (projectId?: number, limit = 50) => {
            let dataResult: DataResultType<RowDeployTaskType[]> = { code: 0, msg: "", data: [] };
            try {
                let sql = `select ${TASK_COLS} from t_deploy_task`;
                const bind: any[] = [];
                if (projectId !== undefined) { sql += " where project_id = $1"; bind.push(projectId); }
                sql += ` order by start_time desc limit ${limit}`;
                dataResult.data = await (await db()).select<RowDeployTaskType[]>(sql, bind);
                dataResult.msg = "查询任务列表成功";
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "查询任务列表出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 新增一条详情（开始某服务×服务器步骤时调用） */
        insertDetail: async (data: RowDeployTaskDetailType) => {
            const sql = "INSERT INTO t_deploy_task_detail (task_id, run_id, service_name, server_id, server_name, server_identity, remote_path, status, retry_count, step, start_time, create_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id;";
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const now = formatDate(new Date(), "YYYY-mm-dd HH:MM:SS");
                const r = await (await db()).execute(sql, [
                    data.taskId, data.runId, data.serviceName, data.serverId, data.serverName,
                    data.serverIdentity, data.remotePath, data.status ?? 'running', data.retryCount ?? 0,
                    data.step, now, now,
                ]);
                if (r.lastInsertId && r.lastInsertId > 0) { dataResult.code = 0; dataResult.data = r.lastInsertId; dataResult.msg = "新增任务详情成功"; }
                else { dataResult.msg = "新增任务详情失败"; }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "新增任务详情出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 更新详情状态/步骤/重试/健康/错误/备份等（按需传字段） */
        updateDetail: async (id: number, fields: {
            status?: DeployDetailStatus; step?: DeployDetailStep; retryCount?: number;
            healthCheckResult?: string; backupPath?: string; errorMessage?: string; endTime?: string;
        }) => {
            const sets: string[] = [];
            const bind: any[] = [];
            if (fields.status !== undefined) { bind.push(fields.status); sets.push(`status = $${bind.length}`); }
            if (fields.step !== undefined) { bind.push(fields.step); sets.push(`step = $${bind.length}`); }
            if (fields.retryCount !== undefined) { bind.push(fields.retryCount); sets.push(`retry_count = $${bind.length}`); }
            if (fields.healthCheckResult !== undefined) { bind.push(fields.healthCheckResult); sets.push(`health_check_result = $${bind.length}`); }
            if (fields.backupPath !== undefined) { bind.push(fields.backupPath); sets.push(`backup_path = $${bind.length}`); }
            if (fields.errorMessage !== undefined) { bind.push(fields.errorMessage); sets.push(`error_message = $${bind.length}`); }
            sets.push(`end_time = $${bind.length + 1}`); bind.push(fields.endTime ?? formatDate(new Date(), "YYYY-mm-dd HH:MM:SS"));
            bind.push(id);
            const sql = `UPDATE t_deploy_task_detail SET ${sets.join(", ")} WHERE id = $${bind.length}`;
            let dataResult: DataResultType<number> = { code: 1, msg: "", data: 0 };
            try {
                const r = await (await db()).execute(sql, bind);
                if (r.rowsAffected > 0) { dataResult.code = 0; dataResult.data = id; dataResult.msg = "更新任务详情成功"; }
                else { dataResult.msg = "更新任务详情失败"; }
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "更新任务详情出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },

        /** 按任务 id 查全部详情 */
        getDetailsByTaskId: async (taskId: number) => {
            let dataResult: DataResultType<RowDeployTaskDetailType[]> = { code: 0, msg: "", data: [] };
            try {
                dataResult.data = await (await db()).select<RowDeployTaskDetailType[]>(`select ${DETAIL_COLS} from t_deploy_task_detail where task_id = $1 order by id asc`, [taskId]);
                dataResult.msg = "查询任务详情成功";
            } catch (error) {
                dataResult.code = -1; dataResult.msg = "查询任务详情出错：" + JSON.stringify(error); console.error(error);
            }
            return dataResult;
        },
    };
}
