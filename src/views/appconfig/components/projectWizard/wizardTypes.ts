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
    if (hits.length > 1) candidates[svc] = hits.slice(1).map((h) => h.exec_dir);
  }
  return { matched, candidates };
}

export function displayEnv(env: number): string {
  const map: Record<number, string> = { 1: 'Dev', 2: 'Uat', 3: 'Pro', 4: 'Other' };
  return map[env] ?? String(env);
}
