// 发布页应用类型面板的数据模型（纯函数，供 home/index.vue 消费）
import { safeJsonParse } from "@/utils/safeJsonParse";

// 应用类型 key = configItems 字段名
export type AppTypeKey = "webApiHost" | "scheduleServer" | "webClient" | "wpfClient" | "spcMonitor";
// 面板状态徽标：待发布/发布中/已发布/发布失败/已移除
export type PublishStatus = "pending" | "publishing" | "published" | "failed" | "removed";
export type PublishStatusMap = Record<AppTypeKey, PublishStatus>;

// 逻辑顺序 = 原 getConfigItemHosts / serviceNames 的既有顺序（影响编译顺序与部署记录，禁止调整）
export const APP_TYPE_ORDER: ReadonlyArray<{ key: AppTypeKey; pascal: string; csprojFile: string }> = [
  { key: "webApiHost", pascal: "WebApiHost", csprojFile: "SIE.WebApiHost.csproj" },
  { key: "scheduleServer", pascal: "ScheduleServer", csprojFile: "SIE.ScheduleServer.csproj" },
  { key: "webClient", pascal: "WebClient", csprojFile: "WebClient.csproj" },
  { key: "spcMonitor", pascal: "SpcMonitor", csprojFile: "SIE.SpcMonitor.csproj" },
  { key: "wpfClient", pascal: "WpfClient", csprojFile: "WpfClient.csproj" },
];

// 展示顺序 = 原模板 5 张表格的出现顺序
export const APP_TYPE_DISPLAY: ReadonlyArray<AppTypeKey> = ["webApiHost", "webClient", "scheduleServer", "wpfClient", "spcMonitor"];

// 该类型是否参与编译/发布：原 if (!clientPath) 语义 + "已发布跳过"的失败续发语义
export const isTypeActive = (clientPath: string | null | undefined, status: PublishStatus): boolean =>
  Boolean(clientPath) && status !== "published";

export interface AppSectionPath {
  identity: string;
  path: string;
}
export interface AppSectionServer {
  name: string;
  paths: AppSectionPath[];
}
export interface WpfSectionInfo {
  generateDirs: string[];
  isCompress: boolean;
  compressFiles: string[];
  serverName: string;
  serverPath: string;
}
export interface AppSection {
  key: AppTypeKey;
  name: string; // Pascal 名，与日志文案一致
  tagType: "primary" | "success" | "warning" | "danger" | "info";
  kind: "server" | "wpf";
  clientPath: string;
  status: PublishStatus;
  summary: string;
  servers: AppSectionServer[];
  pathCount: number;
  wpf?: WpfSectionInfo;
}

const TAG_TYPE: Record<AppTypeKey, AppSection["tagType"]> = {
  webApiHost: "primary",
  webClient: "success",
  scheduleServer: "warning",
  wpfClient: "danger",
  spcMonitor: "info",
};
const PASCAL: Record<AppTypeKey, string> = {
  webApiHost: "WebApiHost",
  webClient: "WebClient",
  scheduleServer: "ScheduleServer",
  wpfClient: "WpfClient",
  spcMonitor: "SpcMonitor",
};

// JSON 数组字段的安全解析：损坏返回 []（原模板 showGenerateDir/showCompressFile 为裸 parse；
// 现基于全局 safeJsonParse 实现，避免两套安全解析并存漂移；空值早退保持无告警的原有行为）
const safeParseArray = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  const parsed = safeJsonParse<string[]>(raw, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
};

const countPaths = (servers: AppSectionServer[]): number => servers.reduce((n, s) => n + s.paths.length, 0);

// 由 configItems + 状态生成折叠面板模型：未配置（clientPath 空）不显示；已移除保留禁用态展示
export function buildAppSections(configItems: ConfigItemsType, status: PublishStatusMap): AppSection[] {
  if (!configItems) return [];
  const sections: AppSection[] = [];
  for (const key of APP_TYPE_DISPLAY) {
    const item = (configItems as any)[key];
    if (!item) continue;
    const clientPath = String(item.clientPath || "");
    if (!clientPath && status[key] !== "removed") continue;

    if (key === "wpfClient") {
      const wpf: WpfSectionInfo = {
        generateDirs: safeParseArray(item.generateDirJson),
        isCompress: item.isCompress == 1,
        compressFiles: safeParseArray(item.compressFileJson),
        serverName: String(item.serverName || ""),
        serverPath: String(item.serverPath || ""),
      };
      sections.push({
        key,
        name: PASCAL[key],
        tagType: TAG_TYPE[key],
        kind: "wpf",
        clientPath,
        status: status[key],
        summary: `${wpf.isCompress ? "压缩打包" : "直接拷贝"} · ${wpf.serverName || "未选择服务器"}`,
        servers: [],
        pathCount: 0,
        wpf,
      });
      continue;
    }

    const servers: AppSectionServer[] = (item.serverArr || []).map((s: any) => ({
      name: String(s.name || ""),
      paths: (s.serverPathArr || []).flatMap((p: any) =>
        (p.value || []).map((v: any) => ({ identity: String(v.identity || ""), path: String(v.path || "") }))
      ),
    }));
    sections.push({
      key,
      name: PASCAL[key],
      tagType: TAG_TYPE[key],
      kind: "server",
      clientPath,
      status: status[key],
      summary: `${servers.length} 台服务器 · ${countPaths(servers)} 个发布路径`,
      servers,
      pathCount: countPaths(servers),
    });
  }
  return sections;
}

// 生成发布文件对话框的过滤副本：published 类型的 clientPath 置空（对话框按 clientPath 控制显隐，见其模板 44/73/104/133/162 行）
// 浅拷贝仅对 published 类型新建子对象，未发布类型保持引用共享（保留原 Object.assign 的共享突变语义）
export function filterAppconfigForDialog(appconfig: RowAppconfigType, status: PublishStatusMap): RowAppconfigType {
  const configItems = { ...(appconfig.configItems as any) };
  for (const { key } of APP_TYPE_ORDER) {
    if (status[key] === "published" && configItems[key]) {
      configItems[key] = { ...configItems[key], clientPath: "" };
    }
  }
  return { ...appconfig, configItems };
}
