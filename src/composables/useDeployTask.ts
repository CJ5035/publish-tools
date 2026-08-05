import { useDeployTaskDb } from "@/database/deployTask";

/**
 * 发布任务记录高层编排：在四条发布链路（home/papersPublish/restore/generate）
 * 的关键步骤点插入任务与详情记录。阶段2 起被各链路调用。
 */
export function useDeployTask() {
    const db = useDeployTaskDb();

    /** 生成 run_id（同一次发布所有 detail 共用） */
    const genRunId = (): string => {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        return `run_${ts}_${rand}`;
    };

    /** 开始一次发布任务，返回 { taskId, runId } */
    const createTask = async (params: {
        source: DeployTaskSource;
        projectId?: number;
        projectName?: string;
        environment?: number;
        appconfigId?: number;
        triggerType?: DeployTriggerType;
        selectedServices?: string[] | null;
    }) => {
        const runId = genRunId();
        const r = await db.insertTask({
            runId,
            source: params.source,
            projectId: params.projectId,
            projectName: params.projectName,
            environment: params.environment,
            appconfigId: params.appconfigId,
            triggerType: params.triggerType ?? 'manual',
            status: 'running',
            selectedServices: params.selectedServices ? JSON.stringify(params.selectedServices) : null,
        });
        if (r.code !== 0) throw new Error(r.msg);
        return { taskId: r.data as number, runId };
    };

    /** 记录一个步骤开始（如 upload/unzip/switch/health/backup/copy/zip） */
    const appendDetail = async (params: {
        taskId: number; runId: string;
        serviceName: string;
        serverId?: number; serverName?: string; serverIdentity?: string; remotePath?: string;
        step: DeployDetailStep;
    }) => {
        const r = await db.insertDetail({
            taskId: params.taskId, runId: params.runId,
            serviceName: params.serviceName,
            serverId: params.serverId, serverName: params.serverName,
            serverIdentity: params.serverIdentity, remotePath: params.remotePath,
            status: 'running', step: params.step,
        });
        if (r.code !== 0) throw new Error(r.msg);
        return r.data as number;
    };

    /** 更新某详情结果（成功/失败 + 可选 retryCount/health/error/backup） */
    const updateDetailStatus = async (detailId: number, status: DeployDetailStatus, extra?: {
        retryCount?: number; healthCheckResult?: string; errorMessage?: string; backupPath?: string;
    }) => {
        const r = await db.updateDetail(detailId, {
            status,
            retryCount: extra?.retryCount,
            healthCheckResult: extra?.healthCheckResult,
            errorMessage: extra?.errorMessage,
            backupPath: extra?.backupPath,
        });
        if (r.code !== 0) throw new Error(r.msg);
    };

    /** 结束任务：自动据 detail 聚合状态（全成功=success，全失败=failed，混合=partial） */
    const finishTask = async (taskId: number) => {
        const detailR = await db.getDetailsByTaskId(taskId);
        if (detailR.code !== 0) throw new Error(detailR.msg || "查询任务详情失败");
        const details = detailR.data ?? [];
        const total = details.length;
        if (total === 0) {
            await db.updateTaskStatus(taskId, 'failed');
            throw new Error("任务没有任何详情，不能标记为成功");
        }
        const failed = details.filter(d => d.status === 'failed').length;
        const running = details.filter(d => d.status === 'running' || d.status === 'pending').length;
        if (running > 0) throw new Error("仍有未完成的任务详情，不能结束任务");
        const status: DeployTaskStatus = failed === total ? 'failed' : failed === 0 ? 'success' : 'partial';
        await db.updateTaskStatus(taskId, status);
        return status;
    };

    /** 记录回退（定时任务自动回退时调用） */
    const recordRollback = async (taskId: number, reason: string) => {
        await db.recordRollback(taskId, reason);
    };

    return { createTask, appendDetail, updateDetailStatus, finishTask, recordRollback, genRunId };
}
