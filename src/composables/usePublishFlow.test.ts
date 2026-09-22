import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublishSignal, createStatusCtl } from "./publishFlowSupport";

const mocks = vi.hoisted(() => ({
  cmdInvoke: vi.fn(),
  createDeployRecorder: vi.fn(),
  getServerById: vi.fn(),
  loadBackupItems: vi.fn(),
  backupRemoteServer: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@/utils/command", () => ({ cmdInvoke: mocks.cmdInvoke }));
vi.mock("@tauri-apps/api", () => ({ path: { appDataDir: vi.fn() } }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: mocks.sendNotification }));
vi.mock("@/utils/other", () => ({
  removeSlash: (value: string) => value,
  displayEnvironment: (value: number) => String(value),
  displayOs: (value: string) => value,
}));
vi.mock("@/utils/formatTime", () => ({ formatDate: () => "2026-09-22" }));
vi.mock("@/utils/outPublishInfo", () => ({
  outPublishContents: vi.fn(),
  outDetaultPublishContents: vi.fn(),
  outPublishContentByDates: vi.fn(),
  outPublishContentByUsers: vi.fn(),
  getDllFilesByChangedItems: vi.fn(),
  getTfsChangedPath: vi.fn(),
}));
vi.mock("@/utils/deployTaskRecorder", () => ({ createDeployRecorder: mocks.createDeployRecorder }));
vi.mock("@/utils/wpfDllClassify", () => ({ classifyWpfDlls: vi.fn() }));
vi.mock("@/utils/publishSettings", () => ({ getRetryArgs: () => ({}) }));
vi.mock("@/utils/uploadServerFilesWithRetry", () => ({ uploadServerFilesWithRetry: vi.fn() }));
vi.mock("@/utils/backupAppconfig", () => ({
  loadBackupItems: mocks.loadBackupItems,
  backupRemoteServer: mocks.backupRemoteServer,
}));
vi.mock("@/utils/safeJsonParse", () => ({ safeJsonParse: vi.fn() }));
vi.mock("@/database/project/index", () => ({ useProjectDb: () => ({}) }));
vi.mock("@/database/servers/index", () => ({ useServerDb: () => ({ getServerById: mocks.getServerById }) }));
vi.mock("@/database/teamFoundationServer/index", () => ({ useTfsDb: () => ({}) }));
vi.mock("@/database/git/index", () => ({ useGitDb: () => ({}) }));
vi.mock("@/database/backups/index", () => ({ useBackupDb: () => ({}) }));

import { getServerDetail, projectPublish } from "./usePublishFlow";

const makeConfigItems = () => ({
  webApiHost: { clientPath: "D:/api", serverIds: [1], serverArr: [{ id: 1, name: "Api", serverPathArr: [] }] },
  scheduleServer: { clientPath: "", serverIds: [], serverArr: [] },
  webClient: { clientPath: "D:/web", serverIds: [2], serverArr: [{ id: 2, name: "Web", serverPathArr: [] }] },
  wpfClient: { clientPath: "", serverIds: [], serverArr: [], serverId: null, serverName: null, serverPath: "" },
  spcMonitor: { clientPath: "", serverIds: [], serverArr: [] },
  isBackup: 1,
  isNewVersion: false,
  isRebuild: 0,
});

const makeContext = (overrides: Record<string, unknown> = {}) => {
  const map = { webApiHost: "pending", scheduleServer: "pending", webClient: "pending", wpfClient: "pending", spcMonitor: "pending" } as any;
  const logger = { print: vi.fn(() => ({ content: { uploadFile: {} } })), clear: vi.fn(), logs: { value: [] } };
  return {
    projectId: 1,
    projectName: "测试项目",
    environment: 1,
    isScheduled: false,
    appconfig: { id: 1, dllMode: null, dllModeValue: null, configItems: makeConfigItems() },
    assemblyOutPath: "D:/out",
    logger,
    signal: createPublishSignal(),
    status: createStatusCtl(map, { webApiHost: "", scheduleServer: "", webClient: "", wpfClient: "", spcMonitor: "" }),
    generatePublishLog: { data: "", logs: "" },
    deployRecorder: null,
    ...overrides,
  } as any;
};

const successServer = (id: number) => ({ code: 0, msg: "", data: { data: { id, name: `服务器${id}` } } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cmdInvoke.mockResolvedValue({ code: 0, msg: "", data: [] });
  mocks.createDeployRecorder.mockResolvedValue({ step: vi.fn(), done: vi.fn(), finish: vi.fn() });
  mocks.getServerById.mockImplementation(async (id: number) => successServer(id));
});

describe("projectPublish 发布前服务器校验", () => {
  it.each([false, true])("后续模块的失效服务器会在任何副作用前阻断（isScheduled=%s）", async (isScheduled) => {
    const ctx = makeContext({ isScheduled });
    const before = JSON.stringify(ctx.appconfig);
    mocks.getServerById.mockImplementation(async (id: number) => (id === 1 ? successServer(id) : { code: 0, msg: "", data: { data: {} } }));

    await expect(projectPublish(ctx)).resolves.toBe(false);

    expect(mocks.getServerById).toHaveBeenCalledWith(1);
    expect(mocks.getServerById).toHaveBeenCalledWith(2);
    expect(mocks.createDeployRecorder).not.toHaveBeenCalled();
    expect(mocks.cmdInvoke).not.toHaveBeenCalled();
    expect(mocks.loadBackupItems).not.toHaveBeenCalled();
    expect(mocks.backupRemoteServer).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.appconfig)).toBe(before);
    expect(ctx.status.map.webApiHost).toBe("pending");
    expect(ctx.status.map.webClient).toBe("pending");
  });

  it("配置整体缺失、空数组和 Wpf 旧 ID 缺失均在入口阻断", async () => {
    const missingConfig = makeContext();
    missingConfig.appconfig.configItems = undefined;
    const emptyArray = makeContext();
    emptyArray.appconfig.configItems.webApiHost.serverArr = [];
    const missingWpf = makeContext();
    missingWpf.appconfig.configItems.webApiHost.clientPath = "";
    missingWpf.appconfig.configItems.webClient.clientPath = "";
    missingWpf.appconfig.configItems.wpfClient.clientPath = "D:/wpf";

    await expect(projectPublish(missingConfig)).resolves.toBe(false);
    await expect(projectPublish(emptyArray)).resolves.toBe(false);
    await expect(projectPublish(missingWpf)).resolves.toBe(false);
    expect(mocks.createDeployRecorder).not.toHaveBeenCalled();
    expect(mocks.getServerById).not.toHaveBeenCalled();
  });

  it("重复服务器 ID 只查询一次", async () => {
    const ctx = makeContext();
    ctx.appconfig.configItems.webApiHost.serverArr.push({ id: 2, name: "重复 Web", serverPathArr: [] });
    mocks.getServerById.mockResolvedValue({ code: 0, msg: "", data: { data: {} } });

    await expect(projectPublish(ctx)).resolves.toBe(false);

    expect(mocks.getServerById).toHaveBeenCalledTimes(2);
    expect(mocks.getServerById.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(mocks.createDeployRecorder).not.toHaveBeenCalled();
  });

  it("数据库查询拒绝时记录校验失败并阻断", async () => {
    const ctx = makeContext();
    mocks.getServerById.mockRejectedValue(new Error("database unavailable"));

    await expect(projectPublish(ctx)).resolves.toBe(false);

    expect(ctx.logger.print).toHaveBeenCalledWith(expect.stringContaining("服务器校验失败"), "log-error");
    expect(mocks.createDeployRecorder).not.toHaveBeenCalled();
  });

  it("所有目标有效后才进入既有获取程序集和确认流程", async () => {
    const confirmBeforeUpload = vi.fn().mockResolvedValue(false);
    const ctx = makeContext({ confirmBeforeUpload });

    await expect(projectPublish(ctx)).resolves.toBe(false);

    expect(mocks.getServerById).toHaveBeenCalledTimes(2);
    expect(mocks.createDeployRecorder).toHaveBeenCalledTimes(1);
    expect(mocks.cmdInvoke).toHaveBeenCalled();
    expect(confirmBeforeUpload).toHaveBeenCalledTimes(1);
    expect(mocks.loadBackupItems).not.toHaveBeenCalled();
  });

  it("已发布或已移除模块的失效 ID 不参与本次入口查询", async () => {
    const ctx = makeContext();
    ctx.status.map.webApiHost = "published";
    ctx.status.map.webClient = "removed";

    await projectPublish(ctx);

    expect(mocks.getServerById).not.toHaveBeenCalled();
  });
});

describe("getServerDetail", () => {
  it.each([
    [{}, "空对象"],
    [null, "null"],
    [undefined, "undefined"],
    [{ id: 2 }, "不匹配 ID"],
  ])("code 为 0 但返回%s时拒绝结果", async (server, _label) => {
    const ctx = makeContext();
    mocks.getServerById.mockResolvedValue({ code: 0, msg: "", data: { data: server } });

    await expect(getServerDetail(ctx, 1)).resolves.toBeNull();
  });

  it("code 非零时保留错误日志并返回 null", async () => {
    const ctx = makeContext();
    mocks.getServerById.mockResolvedValue({ code: -1, msg: "查询失败", data: { data: {} } });

    await expect(getServerDetail(ctx, 1)).resolves.toBeNull();
    expect(ctx.logger.print).toHaveBeenCalledWith("查询失败", "log-error");
  });
});
