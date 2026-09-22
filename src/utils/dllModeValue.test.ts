import { describe, it, expect } from "vitest";
import { serializeDllModeDateRange, deserializeDllModeDateRange } from "./dllModeValue";

describe("serializeDllModeDateRange", () => {
  it("序列化格式与原 appconfigDialog.onDllModeDateChange 落库格式一致", () => {
    const s = serializeDllModeDateRange([new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 5, 23, 59, 59)]);
    expect(s).toBe(JSON.stringify(["2026-09-01 00:00:00", "2026-09-05 23:59:59"]));
  });
  it("空值返回空字符串", () => {
    expect(serializeDllModeDateRange(null)).toBe("");
    expect(serializeDllModeDateRange(undefined)).toBe("");
    expect(serializeDllModeDateRange([])).toBe("");
  });
});

describe("deserializeDllModeDateRange", () => {
  it("与序列化往返一致", () => {
    const d: [Date, Date] = [new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 5, 23, 59, 59)];
    expect(deserializeDllModeDateRange(serializeDllModeDateRange(d))).toEqual(d);
  });
  it("坏数据返回 null 不抛错", () => {
    expect(deserializeDllModeDateRange(null)).toBe(null);
    expect(deserializeDllModeDateRange("")).toBe(null);
    expect(deserializeDllModeDateRange("{bad json")).toBe(null);
    expect(deserializeDllModeDateRange('["2026-09-01 00:00:00"]')).toBe(null); // 长度不足
  });
});
