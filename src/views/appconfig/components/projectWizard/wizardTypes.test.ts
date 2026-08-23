import { describe, it, expect } from 'vitest';
import { deriveAnchors, diffScanTargets, matchServices, rematchAll } from './wizardTypes';
import type { WizardServer, RemoteServiceVo } from './wizardTypes';

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
