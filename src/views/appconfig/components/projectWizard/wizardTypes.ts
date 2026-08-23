export type ServiceName = 'webApiHost' | 'webClient' | 'scheduleServer' | 'spcMonitor' | 'wpfClient';
export const SERVICE_NAMES: ServiceName[] = ['webApiHost', 'webClient', 'scheduleServer', 'spcMonitor', 'wpfClient'];
export const NORMAL_SERVICES: ServiceName[] = ['webApiHost', 'webClient', 'scheduleServer', 'spcMonitor'];

export interface WizardServer {
  id?: number;
  name: string;
  os: number;
  ip: string;
  port: number;
  account: string;
  pwd: string;
  scanRoot: string;
  isNew: boolean;
}

export interface WizardProject {
  id?: number;
  name: string;
  code: string;
  slnPath: string;
  isNewVersion: boolean;
  buildMode: 'Debug' | 'Release';
  assemblyOutPath?: string;
  clientPaths: Partial<Record<ServiceName, string>>;
}

export interface ServiceTarget {
  serverKey: string;
  path: string;
}

export interface EnvService {
  name: ServiceName;
  enabled: boolean;
  targets: ServiceTarget[];
}

export interface EnvConfig {
  services: EnvService[];
}

export interface WizardDraft {
  project: WizardProject;
  servers: WizardServer[];
  /** 每服务器每服务的全部识别节点路径（有序，最优在前）；同服务器多节点全部保留 */
  scanResults: Record<string, Partial<Record<ServiceName, string[]>>>;
  scanCandidates: Record<string, Partial<Record<ServiceName, string[]>>>;
  rawEnumerated: Record<string, RemoteServiceVo[]>;
  manualPaths: Record<string, ServiceName[]>;
  probedWpf: Record<string, string>;
  /** S1 界面状态随草稿持久化（项 8）：否则断点恢复后回不到"已有项目"模式 */
  s1Mode: { projectMode: 'existing' | 'new'; selectedProjectId: number | null };
  envs: number[];
  envConfig: Record<number, EnvConfig>;
}

export const DEFAULT_SERVICE_KEYWORDS: Record<ServiceName, string[]> = {
  webApiHost: ['webapi', 'api'],
  webClient: ['webclient'],
  scheduleServer: ['schedule', 'job'],
  spcMonitor: ['spc', 'monitor'],
  wpfClient: ['wpf'],
};

export interface RemoteServiceVo {
  name: string;
  display_name: string;
  exec_dir: string;
  source: string;
  mounts?: string[];
}

export function createEmptyDraft(): WizardDraft {
  return {
    project: {
      id: undefined,
      name: '',
      code: '',
      slnPath: '',
      isNewVersion: false,
      buildMode: 'Release',
      assemblyOutPath: '',
      clientPaths: {},
    },
    servers: [],
    scanResults: {},
    scanCandidates: {},
    rawEnumerated: {},
    manualPaths: {},
    probedWpf: {},
    s1Mode: { projectMode: 'new', selectedProjectId: null },
    envs: [],
    envConfig: {},
  };
}

/** 关键词匹配：每类服务返回全部命中节点的 exec_dir（按关键词命中长度降序，同分保持枚举序），
 *  系统目录（svchost 宿主解析出的 C:\Windows\system32、/usr 等）整体排除，杜绝系统服务抢占；
 *  全部命中计入 used，防止落选节点被后续服务类型重复认领。docker 挂载路径进 candidates。 */
export function matchServices(
  services: RemoteServiceVo[],
  keywords: Record<ServiceName, string[]>
): { matched: Partial<Record<ServiceName, string[]>>; candidates: Partial<Record<ServiceName, string[]>> } {
  const matched: Partial<Record<ServiceName, string[]>> = {};
  const candidates: Partial<Record<ServiceName, string[]>> = {};
  const used = new Set<string>();
  const bestKwLen = (s: RemoteServiceVo, svc: ServiceName) => {
    const kws = keywords[svc].map((k) => k.toLowerCase());
    let best = 0;
    for (const k of kws) {
      if (s.name.toLowerCase().includes(k) || s.display_name.toLowerCase().includes(k)) {
        if (k.length > best) best = k.length;
      }
    }
    return best;
  };
  for (const svc of SERVICE_NAMES) {
    const kws = keywords[svc].map((k) => k.toLowerCase());
    const hits = services.filter(
      (s) => !used.has(s.name) && kws.some((k) => s.name.toLowerCase().includes(k) || s.display_name.toLowerCase().includes(k))
    ).filter((s) => !isSystemSubtree(s.exec_dir));
    if (hits.length === 0) continue;
    hits.sort((a, b) => bestKwLen(b, svc) - bestKwLen(a, svc));
    for (const h of hits) used.add(h.name);
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      if (!h.exec_dir || seen.has(h.exec_dir)) continue;
      seen.add(h.exec_dir);
      paths.push(h.exec_dir);
    }
    if (paths.length === 0) continue;
    matched[svc] = paths;
    const extra = hits
      .flatMap((h) => h.mounts ?? [])
      .filter((p) => p && !seen.has(p));
    const uniq = [...new Set(extra)];
    if (uniq.length > 0) candidates[svc] = uniq;
  }
  return { matched, candidates };
}

export interface RematchInput {
  rawEnumerated: Record<string, RemoteServiceVo[]>;
  keywords: Record<ServiceName, string[]>;
  manualPaths: Record<string, ServiceName[]>;
  probedWpf: Record<string, string>;
  prevScanResults: WizardDraft['scanResults'];
  prevScanCandidates: WizardDraft['scanCandidates'];
}

/** 关键词保存后的本地重匹配（不联网）：非手动行跟随新关键词；手动行与 wpfClient 既有值/候选
 *  （探测或深度扫描产生）一律保留；wpfClient 取值优先级 = 现值 > probedWpf > 关键词结果。
 *  无原始数据的服务器（如扫描失败后手填）原样透传。 */
export function rematchAll(input: RematchInput): {
  scanResults: WizardDraft['scanResults'];
  scanCandidates: WizardDraft['scanCandidates'];
} {
  const { rawEnumerated, keywords, manualPaths, probedWpf, prevScanResults, prevScanCandidates } = input;
  const scanResults: WizardDraft['scanResults'] = {};
  const scanCandidates: WizardDraft['scanCandidates'] = {};
  const keys = [...new Set([...Object.keys(rawEnumerated), ...Object.keys(prevScanResults)])];
  for (const key of keys) {
    const raw = rawEnumerated[key];
    if (!raw) {
      scanResults[key] = { ...(prevScanResults[key] ?? {}) };
      scanCandidates[key] = { ...(prevScanCandidates[key] ?? {}) };
      continue;
    }
    const { matched, candidates } = matchServices(raw, keywords);
    const manual = new Set(manualPaths[key] ?? []);
    const result: Partial<Record<ServiceName, string[]>> = {};
    const cand: Partial<Record<ServiceName, string[]>> = {};
    for (const svc of SERVICE_NAMES) {
      if (svc === 'wpfClient') {
        const prev = prevScanResults[key]?.wpfClient;
        const existing = prev && prev.length > 0 ? prev : probedWpf[key] ? [probedWpf[key]] : matched.wpfClient;
        if (existing && existing.length > 0) result.wpfClient = existing;
        const existingCand = prevScanCandidates[key]?.wpfClient ?? candidates.wpfClient;
        if (existingCand && existingCand.length > 0) cand.wpfClient = existingCand;
      } else if (manual.has(svc)) {
        const kept = prevScanResults[key]?.[svc];
        if (kept && kept.length > 0) result[svc] = kept;
        const keptC = prevScanCandidates[key]?.[svc];
        if (keptC) cand[svc] = keptC;
      } else {
        const m = matched[svc];
        if (m) result[svc] = m;
        const c = candidates[svc];
        if (c) cand[svc] = c;
      }
    }
    scanResults[key] = result;
    scanCandidates[key] = cand;
  }
  return { scanResults, scanCandidates };
}

export function displayEnv(env: number): string {
  const map: Record<number, string> = { 1: 'Dev', 2: 'Uat', 3: 'Pro', 4: 'Other' };
  return map[env] ?? String(env);
}

/** 差量扫描目标计算：对比服务器池与已扫描键集——未扫描的进 toScan，池中已不存在的旧键进 toRemove。 */
export function diffScanTargets(
  servers: WizardServer[],
  scannedKeys: string[]
): { toScan: WizardServer[]; toRemove: string[] } {
  const liveKeys = new Set(servers.map((s) => `${s.ip}:${s.port}`));
  const scanned = new Set(scannedKeys);
  return {
    toScan: servers.filter((s) => !scanned.has(`${s.ip}:${s.port}`)),
    toRemove: [...scanned].filter((k) => !liveKeys.has(k)),
  };
}

export type ServerScanStatus = 'pending' | 'scanning' | 'done' | 'failed';

/** 更新模式合并：向导管理项以向导本次结果为准（覆盖），向导硬编码默认值/不管理的字段保留用户已有配置。
 *  行级保留字段（msBuildPath/dllMode/dllModeValue）不在本函数，由 Step6Confirm 在 update 分支处理。
 *  generateDirJson：已有非空且版本未变 → 保留用户自定义；版本变化 → 向导按 isNewVersion 推导。
 *  注意：普通服务逐字段显式展开而非 for-in-NORMAL_SERVICES 循环赋值——循环变量类型是 ServiceName
 *  （含 wpfClient），TS 3.5+ 对联合键写入 `merged[svc] = ...` 要求可赋给交集类型，
 *  WpfClientConfigType 的必填字段（serverId/isCompress 等）会让普通服务对象报 TS2345。 */
export function mergeConfigItems(
  existing: ConfigItemsType | null | undefined,
  wizardItems: ConfigItemsType
): ConfigItemsType {
  if (!existing) return wizardItems;
  const keepServerPath = <T extends CommonAppconfigType>(ex: T | undefined, wz: T): T => ({
    ...wz,
    serverPath: ex?.serverPath ? ex.serverPath : wz.serverPath,
  });
  const merged: ConfigItemsType = {
    ...wizardItems,
    isRebuild: existing.isRebuild ?? wizardItems.isRebuild,
    isBackup: existing.isBackup ?? wizardItems.isBackup,
    backupBasePath: existing.backupBasePath ?? wizardItems.backupBasePath ?? null,
    isNewVersion: wizardItems.isNewVersion,
    webApiHost: keepServerPath(existing.webApiHost, wizardItems.webApiHost),
    webClient: keepServerPath(existing.webClient, wizardItems.webClient),
    scheduleServer: keepServerPath(existing.scheduleServer, wizardItems.scheduleServer),
    spcMonitor: keepServerPath(existing.spcMonitor, wizardItems.spcMonitor),
  };
  const exWpf = existing.wpfClient;
  const wzWpf = wizardItems.wpfClient;
  const sameVersion = existing.isNewVersion === wizardItems.isNewVersion;
  merged.wpfClient = {
    ...wzWpf,
    isCompress: exWpf?.isCompress ?? wzWpf.isCompress,
    generateDirJson: sameVersion && exWpf?.generateDirJson ? exWpf.generateDirJson : wzWpf.generateDirJson,
    compressFileJson: exWpf?.compressFileJson ? exWpf.compressFileJson : wzWpf.compressFileJson,
  };
  return merged;
}

const LINUX_SUBTREE_BLACKLIST = new Set([
  'usr', 'etc', 'bin', 'sbin', 'run', 'boot', 'dev', 'proc', 'sys', 'lib', 'lib64', 'snap',
]);
const WIN_ANCHOR_BLACKLIST = new Set(['windows', 'program files', 'program files (x86)', 'programdata']);

function normAnchorKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 系统目录子树判定：Windows 按二级段（c:/windows、c:/program files...），Linux 按一级段（/usr、/etc...）。
 *  服务枚举里的 svchost 宿主服务 exec_dir 恒为 C:\Windows\system32，匹配与锚点推导共用此过滤。 */
function isSystemSubtree(p: string): boolean {
  const parts = normAnchorKey(p).split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts[0].endsWith(':')) return WIN_ANCHOR_BLACKLIST.has(parts[1] ?? '');
  return LINUX_SUBTREE_BLACKLIST.has(parts[0]);
}

function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? '' : p.slice(0, idx);
}

/** 从已识别服务的 exec_dir/挂载路径推导 wpfClient 探测锚点（父目录+祖父目录）。
 *  系统目录按一级段整体子树拒绝（如 /usr/lib/svc 的父 /usr/lib 不可为锚点）；
 *  /var 不在子树黑名单（/var 本身被深度过滤，/var/www 等部署根保留）。 */
export function deriveAnchors(execDirs: string[], os: number, account?: string): string[] {
  const okAnchor = (p: string): boolean => {
    if (!p) return false;
    const n = normAnchorKey(p);
    if (!n || n === '/') return false;
    const parts = n.split('/').filter(Boolean);
    if (parts.length < 2) return false;
    return !isSystemSubtree(p);
  };
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!okAnchor(p)) return;
    const key = normAnchorKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const d of execDirs) {
    if (!d) continue;
    const p1 = parentDirOf(d);
    push(p1);
    push(parentDirOf(p1));
  }
  if (os === 2 && account && account.trim()) {
    push(`/home/${account.trim()}`);
  }
  return out;
}

export interface WizardSummaryRow {
  env: string;
  status: string;
  msg: string;
}

/** 草稿持久化结构（localStorage `wizard:draft:v1`，pwd 明文落盘为用户已确认决策）。
 *  结构对 draft 内部字段透明——draft 结构演进（如 d8979d0 的多节点 scanResults）无需改本函数。 */
export interface StoredWizardDraft {
  draft: WizardDraft;
  stepIndex: number;
  currentEnvIndex: number;
  isSummary: boolean;
  summaryRows: WizardSummaryRow[];
  savedAt: number;
}

export function serializeDraft(
  draft: WizardDraft,
  stepIndex: number,
  currentEnvIndex: number,
  isSummary: boolean,
  summaryRows: WizardSummaryRow[],
  now: number = Date.now()
): StoredWizardDraft {
  return { draft, stepIndex, currentEnvIndex, isSummary, summaryRows, savedAt: now };
}

/** 结构校验：draft 必须是对象且 servers/envs 为数组；任何不符返回 null（含版本失效语义——结构大变换时自然解析失败） */
export function restoreDraft(raw: unknown): StoredWizardDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StoredWizardDraft>;
  if (!s.draft || typeof s.draft !== 'object') return null;
  if (!Array.isArray((s.draft as WizardDraft).servers)) return null;
  if (!Array.isArray((s.draft as WizardDraft).envs)) return null;
  return s as StoredWizardDraft;
}
