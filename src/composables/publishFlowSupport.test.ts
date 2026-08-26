import { describe, it, expect } from "vitest";
import {
  createGeneratePublishLogState,
  createPublishSignal,
  createStatusCtl,
  buildScheduleMutexKey,
  collectRunLogText,
  cloneAppconfig,
} from "./publishFlowSupport";

const mkLog = (v: string) => ({ type: "log-info" as const, content: { value: v, uploadFile: { currNumber: 0, totalNumber: 0 } } });

describe("createGeneratePublishLogState", () => {
  it("默认值：开启 / 默认方式 / 四字段全选 / 空缓存", () => {
    expect(createGeneratePublishLogState()).toEqual({
      isEnable: true,
      type: "默认",
      displayPublishField: { isChangeSet: true, isDateTime: true, isUser: true, isDll: true },
      data: "",
      logs: "",
    });
  });
});

describe("createPublishSignal", () => {
  it("初始为未停止未暂停", () => {
    expect(createPublishSignal()).toEqual({ stopped: false, paused: false, resumeResolve: null });
  });
});

describe("createStatusCtl", () => {
  it("markPublishing/markFailed 不覆盖已发布，markPublished 记录时间", () => {
    const map = { webApiHost: "pending", webClient: "pending", scheduleServer: "pending", wpfClient: "pending", spcMonitor: "pending" } as any;
    const publishedAt = { webApiHost: "", webClient: "", scheduleServer: "", wpfClient: "", spcMonitor: "" };
    const ctl = createStatusCtl(map, publishedAt);
    ctl.markPublished("webApiHost");
    expect(map.webApiHost).toBe("published");
    expect(publishedAt.webApiHost).toMatch(/^\d{2}:\d{2}$/);
    ctl.markPublishing("webApiHost");
    ctl.markFailed("webApiHost");
    expect(map.webApiHost).toBe("published"); // 已发布不被覆盖
    ctl.markFailed("webClient");
    expect(map.webClient).toBe("failed");
  });
  it("reset 全部回到待发布", () => {
    const map = { webApiHost: "failed", webClient: "published", scheduleServer: "pending", wpfClient: "removed", spcMonitor: "pending" } as any;
    const ctl = createStatusCtl(map, { webApiHost: "", webClient: "10:00", scheduleServer: "", wpfClient: "", spcMonitor: "" });
    ctl.reset();
    Object.values(map).forEach((v) => expect(v).toBe("pending"));
  });
});

describe("buildScheduleMutexKey", () => {
  it("格式为 projectId:environment", () => {
    expect(buildScheduleMutexKey(3, 2)).toBe("3:2");
    expect(buildScheduleMutexKey(null, null)).toBe("null:null");
  });
});

describe("collectRunLogText", () => {
  it("拼接全部日志并过滤空行与全角空格占位行", () => {
    const text = collectRunLogText([mkLog("开始"), mkLog("　"), mkLog("结束")]);
    expect(text).toBe("开始\n结束");
  });
  it("只保留最后 maxLines 行", () => {
    const logs = Array.from({ length: 5 }, (_, i) => mkLog(`L${i}`));
    expect(collectRunLogText(logs, 2)).toBe("L3\nL4");
  });
});

describe("cloneAppconfig", () => {
  it("深拷贝 configItems，修改副本不影响原对象", () => {
    const a = { id: 1, configItems: { webApiHost: { clientPath: "D:/x" } } } as any;
    const b = cloneAppconfig(a);
    b.configItems.webApiHost.clientPath = "";
    expect(a.configItems.webApiHost.clientPath).toBe("D:/x");
  });
});
