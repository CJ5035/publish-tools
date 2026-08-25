/**
 * wpfClient 配置新旧结构同步工具（诊断报告 20260824）。
 * 两套结构并存：旧单服务器 serverId/serverName/serverPath（发布链路与发布页展示读取）、
 * 新多服务器 serverIds/serverArr[].serverPathArr（弹窗编辑与发布前备份读取）。
 * 保存时必须新→旧回写，否则弹窗修改的发布路径不生效于发布。
 */

// 存量兼容：旧单服务器配置归一化为多服务器结构（旧 → 新，幂等，null 安全）
export const normalizeWpfClientServer = (wpfClient: WpfClientConfigType) => {
  if (!wpfClient) return;
  // 旧数据可能没有 serverIds/serverArr 字段（serverId 为 null 时），先补齐为数组，
  // 避免切换监听中访问 serverArr.length 时报错导致发布路径输入项不显示
  if (!wpfClient.serverIds) wpfClient.serverIds = [];
  if (!wpfClient.serverArr) wpfClient.serverArr = [];
  if (wpfClient.serverArr.length < 1 && wpfClient.serverId) {
    wpfClient.serverIds = [wpfClient.serverId];
    wpfClient.serverArr = [
      makeWpfServerArrEntry(wpfClient.serverId, wpfClient.serverName ?? "", wpfClient.serverPath || ""),
    ];
  }
};

// 构造 serverArr 单服务器条目（normalize 与向导 buildConfigItems 共用的形状）
export const makeWpfServerArrEntry = (id: number, name: string, path: string): SelectServerType => ({
  id,
  name,
  serverPathArr: [{ label: "", value: [{ identity: "", path }] }],
});

// 反向同步：多服务器首台回写旧字段（新 → 旧）。发布/展示链路读旧字段，保存前必须调用。
export const syncWpfClientLegacyFields = (wpfClient: WpfClientConfigType | null | undefined) => {
  if (!wpfClient) return;
  const first = wpfClient.serverArr?.[0];
  if (!first) {
    wpfClient.serverId = null;
    wpfClient.serverName = null;
    wpfClient.serverPath = "";
    return;
  }
  wpfClient.serverId = first.id ?? null;
  wpfClient.serverName = first.name ?? null;
  wpfClient.serverPath = first.serverPathArr?.[0]?.value?.[0]?.path ?? "";
};
