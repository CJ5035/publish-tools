type ServerModuleKey = "webApiHost" | "scheduleServer" | "webClient" | "wpfClient" | "spcMonitor";

export interface StaleServerFixResult {
  fixed: string[];
  stale: string[];
}

const MODULES: ReadonlyArray<{ key: ServerModuleKey; name: string }> = [
  { key: "webApiHost", name: "WebApiHost" },
  { key: "scheduleServer", name: "ScheduleServer" },
  { key: "webClient", name: "WebClient" },
  { key: "spcMonitor", name: "SpcMonitor" },
  { key: "wpfClient", name: "WpfClient" },
];
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// 仅修正编辑草稿。调用方须先确认 serverList 是当前项目完整且成功加载的结果。
export function fixStaleServerIds(configItems: ConfigItemsType, serverList: RowServerType[]): StaleServerFixResult {
  const fixed: string[] = [];
  const stale: string[] = [];
  const currentById = new Map<number, RowServerType>();
  for (const server of serverList) if (validId(server.id)) currentById.set(server.id, server);

  for (const { key, name } of MODULES) {
    const item = (configItems as any)?.[key];
    const ids = item?.serverIds;
    const servers = item?.serverArr;
    if (!Array.isArray(ids) && !Array.isArray(servers)) continue;
    if (!Array.isArray(ids) || !Array.isArray(servers) || ids.length !== servers.length || new Set(ids).size !== ids.length) {
      stale.push(`${name}：服务器引用结构不一致，未自动修正`);
      continue;
    }
    const changes: Array<{ index: number; oldId: number; newId: number; server: SelectServerType }> = [];
    let invalid = false;
    for (let index = 0; index < ids.length; index++) {
      const oldId = ids[index];
      const server = servers[index];
      if (!server || !validId(oldId) || server.id !== oldId) { invalid = true; break; }
      if (currentById.has(oldId)) continue;
      const candidates = serverList.filter((candidate) => candidate.name === server.name && validId(candidate.id));
      if (candidates.length !== 1) { stale.push(`${name}/${server.name || oldId}：无法唯一匹配当前服务器`); continue; }
      changes.push({ index, oldId, newId: candidates[0].id!, server });
    }
    if (invalid) { stale.push(`${name}：服务器引用结构不一致，未自动修正`); continue; }
    const occupied = new Set(ids.filter((id) => currentById.has(id)));
    const candidateIds = changes.map((change) => change.newId);
    if (candidateIds.some((id, index) => occupied.has(id) || candidateIds.indexOf(id) !== index)) {
      stale.push(`${name}：候选服务器与已有引用冲突，未自动修正`);
      continue;
    }
    for (const change of changes) {
      ids[change.index] = change.newId;
      change.server.id = change.newId;
      fixed.push(`${name}/${change.server.name || change.oldId}：${change.oldId} → ${change.newId}`);
    }
  }
  return { fixed, stale };
}
