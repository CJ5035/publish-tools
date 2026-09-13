import { describe, it, expect } from "vitest";
import { createLogStore, LOG_LIMIT } from "./publishLogStore";

describe("createLogStore", () => {
  it("默认参数：log-info + 日期前缀 + 进度字段归零", () => {
    const store = createLogStore();
    const entry = store.print("开始发布");
    expect(store.logs.value).toHaveLength(1);
    expect(entry.type).toBe("log-info");
    expect(entry.content.value).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 开始发布$/);
    expect(entry.content.uploadFile).toEqual({ currNumber: 0, totalNumber: 0 });
  });

  it("空内容输出全角空格（原 printInfoLog 行为）", () => {
    const store = createLogStore();
    const entry = store.print("");
    expect(entry.content.value).toBe("　");
  });

  it("showDate=false 不加日期前缀", () => {
    const store = createLogStore();
    const entry = store.print("纯文本", "log-warning", false);
    expect(entry.content.value).toBe("纯文本");
    expect(entry.type).toBe("log-warning");
  });

  it("超过上限裁掉最旧日志，保留最新 limit 条", () => {
    const store = createLogStore(5);
    for (let i = 1; i <= 8; i++) store.print(`第${i}条`, "log-info", false);
    expect(store.logs.value).toHaveLength(5);
    expect(store.logs.value[0].content.value).toBe("第4条");
    expect(store.logs.value[4].content.value).toBe("第8条");
  });

  it("print 返回的对象在数组中，可直接改写进度字段", () => {
    const store = createLogStore();
    const entry = store.print("正在发布.", "log-info", false);
    entry.content.uploadFile.currNumber = 3;
    entry.content.uploadFile.totalNumber = 10;
    expect(store.logs.value[0].content.uploadFile.currNumber).toBe(3);
  });

  it("clear 清空日志", () => {
    const store = createLogStore();
    store.print("a", "log-info", false);
    store.clear();
    expect(store.logs.value).toHaveLength(0);
  });

  it("默认上限为 2000", () => {
    expect(LOG_LIMIT).toBe(2000);
  });
});
