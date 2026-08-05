import { useDeployTask } from "@/composables/useDeployTask";

/** 记录一个步骤的上下文（detail 行定位字段，均可选） */
export interface DeployRecorderStepOpts {
    serverId?: number;
    serverName?: string;
    serverIdentity?: string;
    remotePath?: string;
}

/** 更新详情的附加字段 */
export interface DeployRecorderDoneExtra {
    errorMessage?: string;
    step?: DeployDetailStep;
    retryCount?: number;
}

/** 阶段2：发布链路任务记录器 */
export interface DeployRecorder {
    taskId: number;
    runId: string;
    /** 记录一个步骤开始（detail status='running'），返回 detailId；失败返回 null（不打断发布） */
    step(serviceName: string, stepName: DeployDetailStep, opts?: DeployRecorderStepOpts): Promise<number | null>;
    /** 更新某 detail 结果；detailId 为 null 时静默跳过 */
    done(detailId: number | null, status: DeployDetailStatus, extra?: DeployRecorderDoneExtra): Promise<void>;
    /** 收尾：先把 running/pending 详情标 failed 再聚合任务状态；无详情安全返回 */
    finish(reason?: string): Promise<void>;
}

/**
 * 阶段2：创建发布链路任务记录器（generate/home/papersPublish/restore 四链路复用）。
 * 任一步骤写库失败只 console.warn，绝不打断发布执行。
 * 返回 null 表示建任务失败（本次发布不记录），调用方用可选链 `recorder?.step(...)` 全部安全跳过。
 */
export async function createDeployRecorder(params: {
    source: DeployTaskSource;
    projectId?: number;
    projectName?: string;
    environment?: number;
    appconfigId?: number;
    triggerType?: DeployTriggerType;
    selectedServices?: string[] | null;
}): Promise<DeployRecorder | null> {
    const deployTask = useDeployTask();
    try {
        const { taskId, runId } = await deployTask.createTask(params);
        const step = async (serviceName: string, stepName: DeployDetailStep, opts?: DeployRecorderStepOpts): Promise<number | null> => {
            try {
                return await deployTask.appendDetail({
                    taskId,
                    runId,
                    serviceName,
                    step: stepName,
                    serverId: opts?.serverId,
                    serverName: opts?.serverName,
                    serverIdentity: opts?.serverIdentity,
                    remotePath: opts?.remotePath,
                });
            } catch (e) {
                console.warn("任务记录-步骤写入失败：", e);
                return null;
            }
        };
        const done = async (detailId: number | null, status: DeployDetailStatus, extra?: DeployRecorderDoneExtra): Promise<void> => {
            if (!detailId) return;
            try {
                await deployTask.updateDetailStatus(detailId, status, extra);
            } catch (e) {
                console.warn("任务记录-结果更新失败：", e);
            }
        };
        const finish = async (reason?: string): Promise<void> => {
            try {
                await deployTask.finishDeployRun(taskId, reason);
            } catch (e) {
                console.warn("任务记录-收尾失败：", e);
            }
        };
        return { taskId, runId, step, done, finish };
    } catch (e) {
        console.warn("创建发布任务记录失败，本次发布不记录：", e);
        return null;
    }
}
