import { describe, it, expect } from 'vitest';
import { createEmptyDraft, defaultTfsName, deriveAnchors, diffScanTargets, matchServices, rematchAll, mergeConfigItems, serializeDraft, restoreDraft } from './wizardTypes';
import type { WizardServer, RemoteServiceVo, WizardDraft, StoredWizardDraft } from './wizardTypes';
// satisfy noUnusedLocals (brief requires these type imports; reference them so vue-tsc passes)
const _typeCheck: WizardDraft | StoredWizardDraft | null = null;
void _typeCheck;

describe('deriveAnchors', () => {
  it('linux: 取父目录，多服务同父去重，仅 1 段的根被深度过滤', () => {
    expect(deriveAnchors(['/data/app/WebApiHost', '/data/app/WebClient'], 2)).toEqual(['/data/app']);
  });

  it('linux: 系统目录子树整体过滤（/usr/lib、/etc/svc 均拒绝）', () => {
    expect(deriveAnchors(['/usr/lib/svc', '/etc/svc/x', '/bin/svc'], 2)).toEqual([]);
  });

  it('linux: /var 不做子树拦截，/var/www 等部署根保留', () => {
    expect(deriveAnchors(['/var/www/app'], 2)).toEqual(['/var/www']);
  });

  it('linux: account 非空时追加家目录', () => {
    expect(deriveAnchors([], 2, 'deploy')).toEqual(['/home/deploy']);
  });

  it('windows: 盘符路径取父目录，Windows/Program Files 被过滤', () => {
    expect(deriveAnchors(['D:\\Smom\\WebApiHost', 'C:\\Windows\\svc'], 1)).toEqual(['D:\\Smom']);
  });

  it('windows: 盘符根（D:）与 account 家目录不产出', () => {
    expect(deriveAnchors(['D:\\x\\y'], 1, 'deploy')).toEqual(['D:\\x']);
  });

  it('空输入返回空数组', () => {
    expect(deriveAnchors([], 2)).toEqual([]);
  });
});

const srv = (ip: string): WizardServer => ({ name: ip, os: 2, ip, port: 22, account: 'a', pwd: 'p', scanRoot: '', isNew: true });

describe('diffScanTargets', () => {
  it('首次进入（无已扫描键）：全部待扫、无待清', () => {
    const r = diffScanTargets([srv('1.1.1.1'), srv('2.2.2.2')], []);
    expect(r.toScan.map((s) => s.ip)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(r.toRemove).toEqual([]);
  });

  it('已有键不动，新增服务器只补扫新增', () => {
    const r = diffScanTargets([srv('1.1.1.1'), srv('3.3.3.3')], ['1.1.1.1:22']);
    expect(r.toScan.map((s) => s.ip)).toEqual(['3.3.3.3']);
    expect(r.toRemove).toEqual([]);
  });

  it('已删除服务器的旧键进入待清', () => {
    const r = diffScanTargets([srv('1.1.1.1')], ['1.1.1.1:22', '9.9.9.9:22']);
    expect(r.toScan).toEqual([]);
    expect(r.toRemove).toEqual(['9.9.9.9:22']);
  });

  it('修改 IP 视为删旧增新', () => {
    const r = diffScanTargets([srv('2.2.2.2')], ['1.1.1.1:22']);
    expect(r.toScan.map((s) => s.ip)).toEqual(['2.2.2.2']);
    expect(r.toRemove).toEqual(['1.1.1.1:22']);
  });
});

const vo = (name: string, dir: string): RemoteServiceVo => ({ name, display_name: name, exec_dir: dir, source: 'service' });
const KW = { webApiHost: ['webapi'], webClient: ['webclient'], scheduleServer: ['schedule'], spcMonitor: ['spc'], wpfClient: ['wpf'] };

describe('matchServices', () => {
  it('同服务器多节点全部保留：按关键词命中长度排序，同分保持枚举序', () => {
    const raw = [
      vo('WebApiHost8032', 'D:/SMOM/Publish/WebApiHost8032'),
      vo('WebApiHost8031', 'D:/SMOM/Publish/WebApiHost8031'),
    ];
    const { matched } = matchServices(raw, KW);
    expect(matched.webApiHost).toEqual(['D:/SMOM/Publish/WebApiHost8032', 'D:/SMOM/Publish/WebApiHost8031']);
  });

  it('系统目录服务被排除：svchost 宿主（C:\\Windows\\system32）与 /usr 子树不参与匹配', () => {
    const raw = [
      vo('TapiSrv', 'C:\\Windows\\system32'),
      vo('WpcMonitorSvc', 'c:/windows/system32'),
      vo('systemd-apisvc', '/usr/lib/systemd'),
    ];
    const { matched } = matchServices(raw, { ...KW, webApiHost: ['webapi', 'api'], spcMonitor: ['spc', 'monitor'] });
    expect(matched.webApiHost).toBeUndefined();
    expect(matched.spcMonitor).toBeUndefined();
  });

  it('真实服务与系统服务并存时系统服务被过滤，真实服务胜出', () => {
    const raw = [
      vo('TapiSrv', 'C:\\Windows\\system32'),
      vo('SMOMWebApiHost8031', 'D:/SMOM/Publish/WebApiHost8031'),
    ];
    const { matched, candidates } = matchServices(raw, { ...KW, webApiHost: ['webapi', 'api'] });
    expect(matched.webApiHost).toEqual(['D:/SMOM/Publish/WebApiHost8031']);
    expect(candidates.webApiHost).toBeUndefined();
  });

  it('全部命中计入 used：落选节点不被后续服务类型重复认领', () => {
    const raw = [vo('webapi-monitor-svc', '/data/svc')];
    const { matched } = matchServices(raw, { ...KW, spcMonitor: ['monitor'] });
    expect(matched.webApiHost).toEqual(['/data/svc']);
    expect(matched.spcMonitor).toBeUndefined();
  });

  it('docker 挂载路径进 candidates，不与 exec_dir 重复', () => {
    const raw: RemoteServiceVo[] = [{ ...vo('webapi1', '/data/webapi1'), mounts: ['/vol/webapi1', '/data/webapi1'] }];
    const { matched, candidates } = matchServices(raw, KW);
    expect(matched.webApiHost).toEqual(['/data/webapi1']);
    expect(candidates.webApiHost).toEqual(['/vol/webapi1']);
  });
});

describe('rematchAll', () => {
  it('非手动行跟随新关键词重匹配（多节点数组）', () => {
    const raw = { '1.1.1.1:22': [vo('myapiHost', '/srv/api'), vo('myapiHost2', '/srv/api2')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: { ...KW, webApiHost: ['myapi'] }, manualPaths: {}, probedWpf: {},
      prevScanResults: {}, prevScanCandidates: {},
    });
    expect(r.scanResults['1.1.1.1:22']?.webApiHost).toEqual(['/srv/api', '/srv/api2']);
  });

  it('手动行保留用户已改节点列表（含删除），不被重匹配覆盖', () => {
    const raw = { '1.1.1.1:22': [vo('webapiHost', '/auto/path'), vo('webapiHost2', '/auto/path2')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: KW, manualPaths: { '1.1.1.1:22': ['webApiHost'] }, probedWpf: {},
      prevScanResults: { '1.1.1.1:22': { webApiHost: ['/my/manual/path'] } }, prevScanCandidates: {},
    });
    expect(r.scanResults['1.1.1.1:22']?.webApiHost).toEqual(['/my/manual/path']);
  });

  it('wpfClient 无现值时采用探测值，探测值优先于关键词结果', () => {
    const raw = { '1.1.1.1:22': [vo('wpf-svc', '/kw/wpf')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: KW, manualPaths: {}, probedWpf: { '1.1.1.1:22': '/probe/wpf' },
      prevScanResults: {}, prevScanCandidates: {},
    });
    expect(r.scanResults['1.1.1.1:22']?.wpfClient).toEqual(['/probe/wpf']);
  });

  it('wpfClient 已有值不被重匹配覆盖（现值 > 探测值 > 关键词）', () => {
    const raw = { '1.1.1.1:22': [vo('wpf-svc', '/kw/wpf')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: KW, manualPaths: {}, probedWpf: { '1.1.1.1:22': '/probe/wpf' },
      prevScanResults: { '1.1.1.1:22': { wpfClient: ['/keep/wpf'] } }, prevScanCandidates: {},
    });
    expect(r.scanResults['1.1.1.1:22']?.wpfClient).toEqual(['/keep/wpf']);
  });

  it('wpfClient 全无值时采用关键词结果', () => {
    const raw = { '1.1.1.1:22': [vo('wpf-svc', '/kw/wpf')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: KW, manualPaths: {}, probedWpf: {},
      prevScanResults: {}, prevScanCandidates: {},
    });
    expect(r.scanResults['1.1.1.1:22']?.wpfClient).toEqual(['/kw/wpf']);
  });

  it('wpfClient 既有候选（深度扫描产生）保留，不随重匹配丢弃', () => {
    const raw = { '1.1.1.1:22': [vo('wpf-svc', '/kw/wpf')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: KW, manualPaths: {}, probedWpf: {},
      prevScanResults: { '1.1.1.1:22': { wpfClient: ['/keep/wpf'] } },
      prevScanCandidates: { '1.1.1.1:22': { wpfClient: ['/deep/1', '/deep/2'] } },
    });
    expect(r.scanCandidates['1.1.1.1:22']?.wpfClient).toEqual(['/deep/1', '/deep/2']);
  });

  it('重匹配同样过滤系统目录：此前误匹配的 system32 被清除', () => {
    const raw = { '1.1.1.1:22': [vo('TapiSrv', 'C:\\Windows\\system32')] };
    const r = rematchAll({
      rawEnumerated: raw, keywords: { ...KW, webApiHost: ['webapi', 'api'] }, manualPaths: {}, probedWpf: {},
      prevScanResults: { '1.1.1.1:22': { webApiHost: ['C:\\Windows\\system32'] } }, prevScanCandidates: {},
    });
    expect(r.scanResults['1.1.1.1:22']?.webApiHost).toBeUndefined();
  });

  it('无原始数据的服务器（扫描失败后手填）原样透传', () => {
    const r = rematchAll({
      rawEnumerated: {}, keywords: KW, manualPaths: {}, probedWpf: {},
      prevScanResults: { '8.8.8.8:22': { webApiHost: ['/manual/only'] } }, prevScanCandidates: {},
    });
    expect(r.scanResults['8.8.8.8:22']?.webApiHost).toEqual(['/manual/only']);
  });
});

const wizItems = (): ConfigItemsType => ({
  webApiHost: { clientPath: 'C:/new/WebApiHost', serverPath: '', serverIds: [7], serverArr: [{ id: 7, name: 's7', serverPathArr: [{ label: '', value: [{ identity: '1.1.1.1:22', path: '/srv/api' }] }] }] },
  webClient: { clientPath: 'C:/new/WebClient', serverPath: '', serverIds: [], serverArr: [] },
  scheduleServer: { clientPath: 'C:/new/ScheduleServer', serverPath: '', serverIds: [], serverArr: [] },
  spcMonitor: { clientPath: 'C:/new/SpcMonitor', serverPath: '', serverIds: [], serverArr: [] },
  wpfClient: { clientPath: 'C:/new/WpfClient', serverPath: '', serverIds: [], serverArr: [], serverId: 7, serverName: 's7', isCompress: 1, generateDirJson: '["Plugins"]', compressFileJson: '' },
  isRebuild: 1,
  isBackup: 0,
  isNewVersion: true,
  backupBasePath: null,
});

const existItems = (): ConfigItemsType => ({
  webApiHost: { clientPath: 'C:/old/WebApiHost', serverPath: '/srv/api-old', serverIds: [9], serverArr: [{ id: 9, name: 's9', serverPathArr: [{ label: '', value: [{ identity: '9.9.9.9:22', path: '/old' }] }] }] },
  webClient: { clientPath: 'C:/old/WebClient', serverPath: '', serverIds: [], serverArr: [] },
  scheduleServer: { clientPath: 'C:/old/ScheduleServer', serverPath: '', serverIds: [], serverArr: [] },
  spcMonitor: { clientPath: 'C:/old/SpcMonitor', serverPath: '', serverIds: [], serverArr: [] },
  wpfClient: { clientPath: 'C:/old/WpfClient', serverPath: '/srv/wpf-old', serverIds: [], serverArr: [], serverId: 9, serverName: 's9', isCompress: 0, generateDirJson: '["Domain","UI"]', compressFileJson: '["a.zip"]' },
  isRebuild: 0,
  isBackup: 1,
  isNewVersion: false,
  backupBasePath: '/backup/base',
});

describe('mergeConfigItems', () => {
  it('existing 为空：原样返回向导 items', () => {
    const w = wizItems();
    expect(mergeConfigItems(null, w)).toBe(w);
    expect(mergeConfigItems(undefined, w)).toBe(w);
  });
  it('保留用户手工设置：isRebuild/isBackup/backupBasePath 取已有值', () => {
    const m = mergeConfigItems(existItems(), wizItems());
    expect(m.isRebuild).toBe(0);
    expect(m.isBackup).toBe(1);
    expect(m.backupBasePath).toBe('/backup/base');
  });
  it('覆盖向导管理项：isNewVersion、clientPath、serverIds/serverArr 用向导值', () => {
    const m = mergeConfigItems(existItems(), wizItems());
    expect(m.isNewVersion).toBe(true);
    expect(m.webApiHost.clientPath).toBe('C:/new/WebApiHost');
    expect(m.webApiHost.serverIds).toEqual([7]);
    expect(m.webApiHost.serverArr[0].id).toBe(7);
    expect(m.wpfClient.clientPath).toBe('C:/new/WpfClient');
  });
  it('普通服务 serverPath 已有非空保留，为空串则用向导值', () => {
    const m = mergeConfigItems(existItems(), wizItems());
    expect(m.webApiHost.serverPath).toBe('/srv/api-old');
    expect(m.webClient.serverPath).toBe('');
  });
  it('wpfClient：目标三项覆盖，isCompress/compressFileJson 保留已有', () => {
    const m = mergeConfigItems(existItems(), wizItems());
    expect(m.wpfClient.serverId).toBe(7);
    expect(m.wpfClient.serverName).toBe('s7');
    expect(m.wpfClient.serverPath).toBe('');
    expect(m.wpfClient.isCompress).toBe(0);
    expect(m.wpfClient.compressFileJson).toBe('["a.zip"]');
  });
  it('generateDirJson：版本一致且已有非空保留；版本变化用向导推导值', () => {
    const sameVer = mergeConfigItems({ ...existItems(), isNewVersion: true } as ConfigItemsType, wizItems());
    expect(sameVer.wpfClient.generateDirJson).toBe('["Domain","UI"]');
    const diffVer = mergeConfigItems(existItems(), wizItems());
    expect(diffVer.wpfClient.generateDirJson).toBe('["Plugins"]');
  });
  it('wpfClient 子字段缺失（存量数据）不抛错且回退向导默认', () => {
    const partial = { ...existItems(), wpfClient: { clientPath: 'C:/old/WpfClient' } as any } as ConfigItemsType;
    const m = mergeConfigItems(partial, wizItems());
    expect(m.wpfClient.isCompress).toBe(1);
    expect(m.wpfClient.generateDirJson).toBe('["Plugins"]');
  });
});

describe('draft 持久化', () => {
  it('createEmptyDraft 含 s1Mode 默认（新建模式、未选项目）', () => {
    expect(createEmptyDraft().s1Mode).toEqual({ projectMode: 'new', selectedProjectId: null });
  });

  it('serialize → restore 往返：字段逐一保留（含 pwd 明文与 savedAt）', () => {
    const d = createEmptyDraft();
    d.s1Mode = { projectMode: 'existing', selectedProjectId: 3 };
    d.project.slnPath = 'D:/repo/a.sln';
    d.servers.push({ name: 's1', os: 2, ip: '1.1.1.1', port: 22, account: 'root', pwd: 'secret', scanRoot: '', isNew: true });
    const stored = serializeDraft(d, 2, 0, false, [{ env: 'Dev', status: '新增成功', msg: '' }], 1724500000000);
    const restored = restoreDraft(JSON.parse(JSON.stringify(stored)));
    expect(restored).not.toBeNull();
    expect(restored!.savedAt).toBe(1724500000000);
    expect(restored!.stepIndex).toBe(2);
    expect(restored!.isSummary).toBe(false);
    expect(restored!.draft.s1Mode.projectMode).toBe('existing');
    expect(restored!.draft.servers[0].pwd).toBe('secret');
  });

  it('restoreDraft 对非法输入返回 null', () => {
    expect(restoreDraft(null)).toBeNull();
    expect(restoreDraft(undefined)).toBeNull();
    expect(restoreDraft('x')).toBeNull();
    expect(restoreDraft({})).toBeNull();
    expect(restoreDraft({ draft: {} })).toBeNull();
    expect(restoreDraft({ draft: { servers: 'no' } })).toBeNull();
  });

  it('isSummary 草稿：summaryRows 随草稿保留（恢复直达总结页）', () => {
    const stored = serializeDraft(createEmptyDraft(), 5, 1, true, [{ env: 'Uat', status: '更新成功', msg: '' }], 1);
    const restored = restoreDraft(stored);
    expect(restored!.isSummary).toBe(true);
    expect(restored!.summaryRows).toEqual([{ env: 'Uat', status: '更新成功', msg: '' }]);
  });
});

describe('defaultTfsName', () => {
  it('取源位置尾段（$/SMOM.DEV.10.2/SMOM.NBXR → SMOM.NBXR）', () => {
    expect(defaultTfsName('$/SMOM.DEV.10.2/SMOM.NBXR')).toBe('SMOM.NBXR');
  });
  it('尾部分隔符容错', () => {
    expect(defaultTfsName('$/a/b/')).toBe('b');
  });
  it('反斜杠容错', () => {
    expect(defaultTfsName('$/a\\b')).toBe('b');
  });
  it('无分隔符返回原串', () => {
    expect(defaultTfsName('SMOM')).toBe('SMOM');
  });
});

describe('createEmptyDraft tfs 字段', () => {
  it('初始无 TFS 识别结果且未落库', () => {
    const d = createEmptyDraft();
    expect(d.tfs).toBeNull();
    expect(d.tfsSaved).toBe(false);
  });
});
