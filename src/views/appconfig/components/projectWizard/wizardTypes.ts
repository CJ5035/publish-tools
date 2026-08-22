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
  scanResults: Record<string, Partial<Record<ServiceName, string>>>;
  scanCandidates: Record<string, Partial<Record<ServiceName, string[]>>>;
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
    envs: [],
    envConfig: {},
  };
}

export function matchServices(
  services: RemoteServiceVo[],
  keywords: Record<ServiceName, string[]>
): { matched: Partial<Record<ServiceName, string>>; candidates: Partial<Record<ServiceName, string[]>> } {
  const matched: Partial<Record<ServiceName, string>> = {};
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
    );
    if (hits.length === 0) continue;
    hits.sort((a, b) => bestKwLen(b, svc) - bestKwLen(a, svc));
    matched[svc] = hits[0].exec_dir;
    used.add(hits[0].name);
    const extra = [
      ...hits.slice(1).map((h) => h.exec_dir),
      ...(hits[0].mounts ?? []),
    ].filter((p) => p && p !== matched[svc]);
    const uniq = [...new Set(extra)];
    if (uniq.length > 0) candidates[svc] = uniq;
  }
  return { matched, candidates };
}

export function displayEnv(env: number): string {
  const map: Record<number, string> = { 1: 'Dev', 2: 'Uat', 3: 'Pro', 4: 'Other' };
  return map[env] ?? String(env);
}

export type ServerScanStatus = 'pending' | 'scanning' | 'done' | 'failed';

const LINUX_SUBTREE_BLACKLIST = new Set([
  'usr', 'etc', 'bin', 'sbin', 'run', 'boot', 'dev', 'proc', 'sys', 'lib', 'lib64', 'snap',
]);
const WIN_ANCHOR_BLACKLIST = new Set(['windows', 'program files', 'program files (x86)', 'programdata']);

function normAnchorKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
    if (parts[0].endsWith(':')) {
      return !WIN_ANCHOR_BLACKLIST.has(parts[1]);
    }
    return !LINUX_SUBTREE_BLACKLIST.has(parts[0]);
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
