// dllMode=日期范围 时 dllModeValue 的序列化/反序列化
// appconfigDialog 与发布页内联编辑共用，保证落库格式一致（["YYYY-mm-dd HH:MM:SS", "YYYY-mm-dd HH:MM:SS"]）
import { formatDate } from "@/utils/formatTime";

export const serializeDllModeDateRange = (val: Date[] | null | undefined): string => {
  if (!val || val.length < 2 || !val[0] || !val[1]) return "";
  return JSON.stringify([formatDate(val[0], "YYYY-mm-dd HH:MM:SS"), formatDate(val[1], "YYYY-mm-dd HH:MM:SS")]);
};

export const deserializeDllModeDateRange = (raw: string | null | undefined): [Date, Date] | null => {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 2 || !arr[0] || !arr[1]) return null;
    const start = new Date(arr[0]);
    const end = new Date(arr[1]);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    return [start, end];
  } catch {
    return null;
  }
};
