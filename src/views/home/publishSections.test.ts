import { describe, it, expect } from "vitest";
import {
  APP_TYPE_ORDER,
  APP_TYPE_DISPLAY,
  buildAppSections,
  filterAppconfigForDialog,
  isTypeActive,
  type PublishStatusMap,
} from "./publishSections";
// 注意：noUnusedLocals 开启且 vue-tsc 检查测试文件，import 里不得出现未使用的符号（AppTypeKey 未用到，勿引入）

// 测试夹具：最小可用的 configItems（形状对齐 src/types/appconfig.d.ts 的 ConfigItemsType）
const makeConfigItems = () =>
  ({
    webApiHost: {
      clientPath: "D:/src/WebApiHost/bin",
      serverArr: [
        {
          id: 1,
          name: "应用服务器A",
          serverPathArr: [
            { label: "x", value: [{ identity: "ApiSite", path: "D:/Web/Api" }, { identity: "Bff", path: "D:/Web/Bff" }] },
          ],
        },
        { id: 2, name: "应用服务器B", serverPathArr: [{ label: "x", value: [{ identity: "ApiSite", path: "D:/Web/Api2" }] }] },
      ],
    },
    webClient: { clientPath: "D:/src/WebClient/bin", serverArr: [{ id: 3, name: "Web服务器", serverPathArr: [{ label: "x", value: [{ identity: "Web", path: "D:/Web/Client" }] }] }] },
    scheduleServer: { clientPath: "", serverArr: [] },
    spcMonitor: { clientPath: "", serverArr: [] },
    wpfClient: {
      clientPath: "D:/src/WpfClient/bin",
      generateDirJson: JSON.stringify(["Plugins", "Lib"]),
      isCompress: 1,
      compressFileJson: JSON.stringify(["Plugins.zip"]),
      serverId: 9,
      serverName: "Wpf服务器",
      serverPath: "D:/Wpf/Publish",
    },
    isRebuild: 0,
    isBackup: 0,
    isNewVersion: false,
  }) as any;

const allPending: PublishStatusMap = { webApiHost: "pending", webClient: "pending", scheduleServer: "pending", wpfClient: "pending", spcMonitor: "pending" };

describe("APP_TYPE_ORDER", () => {
  it("顺序与原 getConfigItemHosts/serviceNames 一致（决定编译顺序，不可调整）", () => {
    expect(APP_TYPE_ORDER.map((t) => t.key)).toEqual(["webApiHost", "scheduleServer", "webClient", "spcMonitor", "wpfClient"]);
    expect(APP_TYPE_ORDER.map((t) => t.pascal)).toEqual(["WebApiHost", "ScheduleServer", "WebClient", "SpcMonitor", "WpfClient"]);
  });
  it("展示顺序与原模板 5 张表格一致", () => {
    expect(APP_TYPE_DISPLAY).toEqual(["webApiHost", "webClient", "scheduleServer", "wpfClient", "spcMonitor"]);
  });
});

describe("isTypeActive", () => {
  it("clientPath 为空一律不参与", () => {
    expect(isTypeActive("", "pending")).toBe(false);
    expect(isTypeActive(null, "pending")).toBe(false);
  });
  it("已发布类型跳过（失败续发语义），其余状态参与", () => {
    expect(isTypeActive("D:/x", "published")).toBe(false);
    expect(isTypeActive("D:/x", "pending")).toBe(true);
    expect(isTypeActive("D:/x", "publishing")).toBe(true);
    expect(isTypeActive("D:/x", "failed")).toBe(true);
    expect(isTypeActive("D:/x", "removed")).toBe(true);
  });
});

describe("buildAppSections", () => {
  it("未配置类型不出现；已配置类型按展示顺序生成", () => {
    const sections = buildAppSections(makeConfigItems(), allPending);
    expect(sections.map((s) => s.key)).toEqual(["webApiHost", "webClient", "wpfClient"]);
  });

  it("server 类型摘要统计服务器数与发布路径数", () => {
    const api = buildAppSections(makeConfigItems(), allPending).find((s) => s.key === "webApiHost")!;
    expect(api.summary).toBe("2 台服务器 · 3 个发布路径");
    expect(api.servers).toHaveLength(2);
    expect(api.servers[0].paths).toEqual([
      { identity: "ApiSite", path: "D:/Web/Api" },
      { identity: "Bff", path: "D:/Web/Bff" },
    ]);
  });

  it("wpf 类型解析 JSON 字段并生成摘要", () => {
    const wpf = buildAppSections(makeConfigItems(), allPending).find((s) => s.key === "wpfClient")!;
    expect(wpf.kind).toBe("wpf");
    expect(wpf.wpf!.generateDirs).toEqual(["Plugins", "Lib"]);
    expect(wpf.wpf!.compressFiles).toEqual(["Plugins.zip"]);
    expect(wpf.wpf!.isCompress).toBe(true);
    expect(wpf.summary).toBe("压缩打包 · Wpf服务器");
  });

  it("JSON 字段损坏不抛错，回退空数组", () => {
    const items = makeConfigItems();
    items.wpfClient.generateDirJson = "{bad json";
    const wpf = buildAppSections(items, allPending).find((s) => s.key === "wpfClient")!;
    expect(wpf.wpf!.generateDirs).toEqual([]);
  });

  it("未配置但状态为 removed 的类型保留展示（禁用态）", () => {
    const items = makeConfigItems();
    items.webClient.clientPath = "";
    const sections = buildAppSections(items, { ...allPending, webClient: "removed" });
    expect(sections.map((s) => s.key)).toContain("webClient");
    expect(sections.find((s) => s.key === "webClient")!.status).toBe("removed");
  });

  it("configItems 为空对象时返回空数组", () => {
    expect(buildAppSections({} as any, allPending)).toEqual([]);
  });
});

describe("filterAppconfigForDialog", () => {
  it("published 类型的 clientPath 置空且生成新子对象；其余类型保持原引用（保留原共享突变语义）", () => {
    const appconfig = { id: 1, configItems: makeConfigItems() } as any;
    const status: PublishStatusMap = { ...allPending, webApiHost: "published" };
    const filtered = filterAppconfigForDialog(appconfig, status);
    expect(filtered.configItems.webApiHost.clientPath).toBe("");
    expect(filtered.configItems.webApiHost).not.toBe(appconfig.configItems.webApiHost);
    expect(filtered.configItems.webClient).toBe(appconfig.configItems.webClient);
    expect(filtered.configItems).not.toBe(appconfig.configItems);
    expect(appconfig.configItems.webApiHost.clientPath).toBe("D:/src/WebApiHost/bin"); // 原对象不被篡改
  });
});
