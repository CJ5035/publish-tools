import { describe, expect, it } from "vitest";
import { fixStaleServerIds } from "./staleServerIds";

const server = (id: number, name: string) => ({ id, name, serverPathArr: [{ label: "x", value: [{ identity: "svc", path: "/keep" }] }] });
const list = (...items: Array<[number, string]>) => items.map(([id, name]) => ({ id, name })) as RowServerType[];
const items = () => ({
  webApiHost: { serverIds: [1], serverArr: [server(1, "A")] }, scheduleServer: { serverIds: [], serverArr: [] }, webClient: { serverIds: [], serverArr: [] }, spcMonitor: { serverIds: [], serverArr: [] }, wpfClient: { serverIds: [], serverArr: [] }, isBackup: 0, isNewVersion: false, isRebuild: 0,
}) as any;

describe("fixStaleServerIds", () => {
  it("唯一同名服务器重建后仅修正 ID，保留路径", () => {
    const config = items(); const beforePath = config.webApiHost.serverArr[0].serverPathArr;
    expect(fixStaleServerIds(config, list([2, "A"]))).toEqual({ fixed: ["WebApiHost/A：1 → 2"], stale: [] });
    expect(config.webApiHost.serverIds).toEqual([2]); expect(config.webApiHost.serverArr[0].id).toBe(2); expect(config.webApiHost.serverArr[0].serverPathArr).toBe(beforePath);
  });
  it("空列表、歧义匹配与冲突均保留原草稿", () => {
    for (const servers of [list(), list([2, "A"], [3, "A"]), list([2, "A"])]) {
      const config = items(); if (servers[0]?.id === 2) config.webApiHost.serverIds.push(2), config.webApiHost.serverArr.push(server(2, "B"));
      fixStaleServerIds(config, servers); expect(config.webApiHost.serverIds[0]).toBe(1);
    }
  });
  it("结构不一致或重复输入不自动丢弃任何引用", () => {
    const config = items(); config.webApiHost.serverIds = [1, 1]; config.webApiHost.serverArr = [server(1, "A"), server(1, "A")];
    expect(fixStaleServerIds(config, list([2, "A"])).stale).not.toEqual([]); expect(config.webApiHost.serverIds).toEqual([1, 1]);
  });
});
