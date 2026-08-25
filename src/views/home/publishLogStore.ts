// 发布日志环形缓冲：上限裁剪最旧日志；print 返回日志对象引用供进度更新直接改写
// （原 home 的 logPrintInfo + printInfoLog 返回数组下标，裁剪会致下标错位，故改为对象引用）
import { ref, type Ref } from "vue";
import { formatDate } from "@/utils/formatTime";

export const LOG_LIMIT = 2000;

export interface LogStore {
  logs: Ref<LogPrintType[]>;
  print: (content: string, type?: LogPrintType["type"], showDate?: boolean) => LogPrintType;
  clear: () => void;
}

export function createLogStore(limit: number = LOG_LIMIT): LogStore {
  const logs = ref<LogPrintType[]>([]) as Ref<LogPrintType[]>;

  const print = (
    content: string,
    type: LogPrintType["type"] = "log-info",
    showDate: boolean = true
  ): LogPrintType => {
    const nowDate = showDate ? `[${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}] ` : "";
    const logInfo: LogPrintType = {
      type,
      content: {
        value: content ? `${nowDate}${content}` : "　",
        uploadFile: { currNumber: 0, totalNumber: 0 },
      },
    };
    logs.value.push(logInfo);
    if (logs.value.length > limit) logs.value.splice(0, logs.value.length - limit);
    return logInfo;
  };

  const clear = () => {
    logs.value = [];
  };

  return { logs, print, clear };
}
