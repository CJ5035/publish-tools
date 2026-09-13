// 全局定时发布调度器：脱离页面存活，30s 扫描到期任务并以独立 ctx 执行引擎（方案 §4.3 3b）
import { computed, reactive, ref, shallowReactive } from "vue";
import { defineStore } from "pinia";
import { usePublishScheduleDb } from "@/database/publishSchedule/index";
import { useAppconfigDb } from "@/database/appconfig/index";
import { loadPublishSettings } from "@/utils/publishSettings";
import { sendNotification } from "@tauri-apps/plugin-notification";
import {
  oneClickPublishing, projectPublish, resolveAssemblyOutPath,
} from "@/composables/usePublishFlow";
import {
  type PublishContext, type LogStore,
  createPublishSignal, createStatusCtl, createGeneratePublishLogState,
  createLogStoreForScheduler, buildScheduleMutexKey, collectRunLogText, cloneAppconfig,
} from "@/composables/publishFlowSupport";

// 任务行类型使用全局 ambient 的 RowPublishScheduleType（含 resultLog/executeTime 字段），勿在本地重复定义

export const usePublishSchedulerStore = defineStore("publishScheduler", () => {
  const publishScheduleDb = usePublishScheduleDb();
  const appconfigDb = useAppconfigDb();

  const timer = ref<ReturnType<typeof setInterval> | null>(null);
  const ticking = ref(false);
  /** key → scheduleId：同项目+同环境互斥登记表 */
  const runningKeys = reactive(new Map<string, number>());
  /** 执行中任务（角标与任务页实时状态）。
   *  用 shallowReactive 而非 reactive：reactive 会把值内 LogStore.logs 的 Ref 深解包（UnwrapRef），
   *  类型与响应式语义均被破坏；shallowReactive 只跟踪 Map 自身的 set/delete，内层 ref 照常被读取方跟踪。 */
  const runningTasks = shallowReactive(new Map<number, { label: string; logs: LogStore }>());

  const runningCount = computed(() => runningTasks.size);

  const getTaskLogs = (scheduleId: number) => runningTasks.get(scheduleId)?.logs.logs.value ?? [];

  // 手动发布与定时任务共用同一张互斥表（§4.4 第3条）：manual 占用时 value 用 -1（无 scheduleId）
  const tryLock = (projectId: number | null, environment: number | null): boolean => {
    const key = buildScheduleMutexKey(projectId, environment);
    if (runningKeys.has(key)) return false;
    runningKeys.set(key, -1);
    return true;
  };
  const release = (projectId: number | null, environment: number | null) => {
    runningKeys.delete(buildScheduleMutexKey(projectId, environment));
  };

  const start = () => {
    if (timer.value) return;
    // 应用重启清扫：崩溃/强退后遗留的 executing 行永远不会被推进，首次 tick 前一次性标记失败（fire-and-forget）
    void publishScheduleDb.getExecutingSchedules().then((r) => {
      if (r.code !== 0) return;
      r.data.forEach((sch) => void publishScheduleDb.updateScheduleStatus(sch.id, "failed", "应用重启导致任务中断"));
    });
    timer.value = setInterval(() => void tick(), 30000);
    void tick();
  };

  const tick = async () => {
    if (ticking.value) return;
    ticking.value = true;
    try {
      const r = await publishScheduleDb.getPendingSchedules();
      if (r.code !== 0 || !r.data.length) return;
      // 并行触发：不同项目任务互不阻塞（§4.4 的核心目标）；
      // 同项目+同环境冲突由 runningKeys 互斥兜底。切勿改回 for-await 串行——
      // 长任务会阻塞后续 tick，“互不干扰”目标落空。
      const due = (r.data as RowPublishScheduleType[]).filter(
        (sch) => new Date(sch.scheduledTime).getTime() <= Date.now()
      );
      due.forEach((sch) => void execute(sch));
    } catch (e) {
      console.error("调度器扫描出错:", e);
    } finally {
      ticking.value = false;
    }
  };

  const execute = async (sch: RowPublishScheduleType) => {
    const key = buildScheduleMutexKey(sch.projectId, sch.environment);
    if (runningKeys.has(key)) {
      // 同项目+同环境互斥：显式记录冲突，不静默丢弃
      await publishScheduleDb.updateScheduleStatus(sch.id, "failed", `与正在执行的发布任务冲突（同项目+同环境），本次未执行`);
      return;
    }
    runningKeys.set(key, sch.id);
    // 尽早落库 executing：关闭跨 tick 重复拾取窗口（后续配置解析等 await 期间行状态已可见）
    await publishScheduleDb.updateScheduleStatus(sch.id, "executing");

    // 独立 ctx：配置快照 + 独立日志缓冲 + 固定默认发布日志设置（行为差异 D1）
    const logger = createLogStoreForScheduler();
    runningTasks.set(sch.id, { label: `${sch.projectName}/${sch.publishType}`, logs: logger });
    let success = false;
    try {
      await loadPublishSettings();
      const appconfigResult = await appconfigDb.getPublishAppconfigs(sch.projectId, sch.environment);
      if (!(appconfigResult.code === 0 && appconfigResult.data.data?.id)) throw new Error("未找到该项目该环境的发布配置");
      const ctx: PublishContext = {
        projectId: sch.projectId,
        projectName: sch.projectName,
        environment: sch.environment,
        isScheduled: true,
        appconfig: cloneAppconfig(appconfigResult.data.data),
        assemblyOutPath: await resolveAssemblyOutPath(sch.projectId, sch.projectName, sch.environment, logger),
        logger,
        signal: createPublishSignal(),
        status: createStatusCtl(
          { webApiHost: "pending", webClient: "pending", scheduleServer: "pending", wpfClient: "pending", spcMonitor: "pending" },
          { webApiHost: "", webClient: "", scheduleServer: "", wpfClient: "", spcMonitor: "" }
        ),
        generatePublishLog: createGeneratePublishLogState(),
        deployRecorder: null,
      };
      logger.print(`定时发布任务开始执行：${sch.publishType}`);
      if (sch.publishType === "一键发布") success = await oneClickPublishing(ctx);
      else if (sch.publishType === "手动发布") success = await projectPublish(ctx);
      else throw new Error(`未知发布类型：${sch.publishType}`);

      if (success) {
        logger.print(`${sch.publishType}成功（定时任务）.`);
        try { sendNotification({ title: "定时发布完成", body: `${sch.publishType} - ${sch.projectName} 发布成功！` }); } catch { /* 通知失败不影响结果 */ }
        await publishScheduleDb.updateScheduleStatus(sch.id, "completed", collectRunLogText(logger.logs.value));
      } else {
        await publishScheduleDb.updateScheduleStatus(sch.id, "failed", collectRunLogText(logger.logs.value) || `${sch.publishType}失败`);
      }
    } catch (error) {
      const errorMsg = String(error);
      logger.print(`定时发布执行异常：${errorMsg}`, "log-error");
      await publishScheduleDb.updateScheduleStatus(sch.id, "failed", `${errorMsg}\n${collectRunLogText(logger.logs.value)}`.trim());
    } finally {
      runningTasks.delete(sch.id);
      runningKeys.delete(key);
    }
  };

  return { start, runningCount, getTaskLogs, runningTasks, tryLock, release };
});
