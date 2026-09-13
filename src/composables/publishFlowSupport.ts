// 发布引擎纯支撑层：ctx 类型、信号量、状态控制器、调度互斥键、日志留档收集
// 仅类型依赖 views/home 的 publishSections / publishLogStore，无运行时反向耦合
import { ref, type Ref } from "vue";
import { formatDate } from "@/utils/formatTime";
import type { AppTypeKey, PublishStatusMap } from "@/views/home/publishSections";
import type { LogStore } from "@/views/home/publishLogStore";

// 调度器等外部模块统一从本模块取 LogStore 类型（纯类型再导出，类型本体源自 views/home/publishLogStore.ts）
export type { LogStore };

// ===== generatePublishLog 状态（原 home 内 ref 结构的类型化）=====
export interface GeneratePublishLogState {
  isEnable: boolean;
  type: string;
  displayPublishField: {
    isChangeSet: boolean;
    isDateTime: boolean;
    isUser: boolean;
    isDll: boolean;
  };
  data: string;
  logs: string;
}

export const createGeneratePublishLogState = (): GeneratePublishLogState => ({
  isEnable: true,
  type: "默认",
  displayPublishField: { isChangeSet: true, isDateTime: true, isUser: true, isDll: true },
  data: "",
  logs: "",
});

// ===== 暂停/停止信号量（原 state.publishData.publishStopped/publishPaused/resumeResolve）=====
export interface PublishSignal {
  stopped: boolean;
  paused: boolean;
  resumeResolve: (() => void) | null;
}

export const createPublishSignal = (): PublishSignal => ({
  stopped: false,
  paused: false,
  resumeResolve: null,
});

// ===== 应用类型发布状态控制器（第一批 publishStatus/publishedAt/markXxx 的 ctx 化）=====
const STATUS_KEYS: AppTypeKey[] = ["webApiHost", "scheduleServer", "webClient", "wpfClient", "spcMonitor"];

export interface PublishStatusCtl {
  map: PublishStatusMap;
  publishedAt: Record<AppTypeKey, string>;
  markPublishing: (key: AppTypeKey) => void;
  markPublished: (key: AppTypeKey) => void;
  markFailed: (key: AppTypeKey) => void;
  reset: () => void;
}

export const createStatusCtl = (
  map: PublishStatusMap,
  publishedAt: Record<AppTypeKey, string>
): PublishStatusCtl => ({
  map,
  publishedAt,
  markPublishing(key) {
    if (this.map[key] !== "published") this.map[key] = "publishing";
  },
  markPublished(key) {
    this.map[key] = "published";
    this.publishedAt[key] = formatDate(new Date(), "HH:MM");
  },
  markFailed(key) {
    if (this.map[key] !== "published") this.map[key] = "failed";
  },
  reset() {
    for (const key of STATUS_KEYS) {
      this.map[key] = "pending";
      this.publishedAt[key] = "";
    }
  },
});

// ===== 调度互斥键（同项目+同环境互斥，§4.4）=====
export const buildScheduleMutexKey = (
  projectId: number | null,
  environment: number | null
): string => `${projectId ?? "null"}:${environment ?? "null"}`;

// ===== 运行日志留档：拼全文、滤空行/全角空格占位、截最后 maxLines 行 =====
export const collectRunLogText = (logs: LogPrintType[], maxLines: number = 2000): string =>
  logs
    .slice(-maxLines)
    .map((l) => l.content.value)
    .filter((v) => v.trim() !== "" && v.trim() !== "　")
    .join("\n");

// ===== 配置快照深拷贝（防止跨运行突变）=====
export const cloneAppconfig = (a: RowAppconfigType): RowAppconfigType =>
  JSON.parse(JSON.stringify(a));

// ===== 发布运行上下文 =====
export interface PublishSignalLike extends PublishSignal {}
export interface PublishContext {
  projectId: number | null;
  projectName: string;
  environment: number;
  /** 定时链路为 true：checkpoint 跳过暂停等待 */
  isScheduled: boolean;
  /** 配置快照（深拷贝），引擎内一切读取走这里 */
  appconfig: RowAppconfigType;
  /** 构建 ctx 时已解析完毕的程序集输出路径（含项目名/环境段） */
  assemblyOutPath: string;
  logger: LogStore;
  signal: PublishSignal;
  status: PublishStatusCtl;
  generatePublishLog: GeneratePublishLogState;
  /** 暂停/恢复时的页面 UI 回调（loadingText），定时链路不传 */
  onPauseUi?: (paused: boolean) => void;
  /** 由引擎 projectPublish 开头创建赋值（原模块级变量的 ctx 化） */
  deployRecorder: import("@/utils/deployTaskRecorder").DeployRecorder | null;
}

// 便捷工厂：页面/调度器各自填充业务字段
export const createContextSkeleton = () => ({
  logger: undefined as unknown as LogStore,
  signal: createPublishSignal(),
});

// ===== 调度器专用日志存储工厂（与 views/home/publishLogStore 的 createLogStore 同形态；
// 独立实现以保持 composables 不依赖 views 运行时代码，仅保留类型导入）=====
export const createLogStoreForScheduler = (): LogStore => {
  const logs = ref<LogPrintType[]>([]) as Ref<LogPrintType[]>;
  return {
    logs,
    print: (content, type = "log-info", showDate = true) => {
      const nowDate = showDate ? `[${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}] ` : "";
      const entry: LogPrintType = { type, content: { value: content ? `${nowDate}${content}` : "　", uploadFile: { currNumber: 0, totalNumber: 0 } } };
      logs.value.push(entry);
      if (logs.value.length > 2000) logs.value.splice(0, logs.value.length - 2000);
      return entry;
    },
    clear: () => { logs.value = []; },
  };
};
