import { describe, it, expect, vi, afterEach } from "vitest";
import { safeJsonParse } from "./safeJsonParse";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeJsonParse", () => {
  it("解析成功：返回解析结果（对象/数组/标量）", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
    expect(safeJsonParse<string[]>('["Domain","UI"]', [])).toEqual(["Domain", "UI"]);
    expect(safeJsonParse<number>("42", 0)).toBe(42);
  });

  it("非法 JSON：console.warn 后返回 fallback（fallback 原样返回，不新建副本）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = ["默认目录"];
    expect(safeJsonParse<string[]>("{不是合法JSON}", fallback)).toBe(fallback);
    expect(safeJsonParse<string[]>("[{截断的数组", fallback)).toBe(fallback);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("null / undefined / 空串 / 空白串：返回 fallback 且不告警（视为未配置）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(safeJsonParse<string[] | null>(null, null)).toBeNull();
    expect(safeJsonParse<string[] | undefined>(undefined, undefined)).toBeUndefined();
    expect(safeJsonParse<string[] | null>("", null)).toBeNull();
    expect(safeJsonParse<string[] | null>("   ", null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("合法 JSON 但结果为 null：原样返回 null 且不告警（由调用方守卫兜底）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(safeJsonParse<string[] | null>("null", ["兜底"])).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
