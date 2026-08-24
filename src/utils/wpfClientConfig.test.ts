import { describe, it, expect } from 'vitest';
import { makeWpfServerArrEntry, normalizeWpfClientServer, syncWpfClientLegacyFields } from './wpfClientConfig';

// 旧形状数据（仅旧字段有值，无 serverArr）——对应库里实测的 id=1/2/6 记录
const legacyWpf = (): WpfClientConfigType => ({
  clientPath: 'F:/项目/华俊/C#/Projects/ELEC/WpfClient/bin/Debug',
  serverPath: '/opt/smom/server/TestDir',
  serverIds: [],
  serverArr: [],
  serverId: 4,
  serverName: '华俊-测试',
  isCompress: 0,
  generateDirJson: '["Domain","UI"]',
  compressFileJson: '',
});

describe('normalizeWpfClientServer（旧→新）', () => {
  it('旧形状：serverId/serverPath 复制进 serverArr，旧字段保留', () => {
    const w = legacyWpf();
    normalizeWpfClientServer(w);
    expect(w.serverIds).toEqual([4]);
    expect(w.serverArr).toEqual([
      { id: 4, name: '华俊-测试', serverPathArr: [{ label: '', value: [{ identity: '', path: '/opt/smom/server/TestDir' }] }] },
    ]);
    expect(w.serverId).toBe(4);
    expect(w.serverPath).toBe('/opt/smom/server/TestDir');
  });

  it('已是新形状：不改动既有 serverArr（幂等）', () => {
    const entry = makeWpfServerArrEntry(9, 'S9', '/opt/a');
    const w = { ...legacyWpf(), serverId: null, serverPath: '', serverArr: [entry] };
    normalizeWpfClientServer(w);
    expect(w.serverArr).toEqual([entry]);
    expect(w.serverIds).toEqual([]);
  });

  it('serverId 为 null 且 serverArr 为空：只补空数组不造条目；入参 null 安全', () => {
    const w = { ...legacyWpf(), serverId: null, serverPath: null };
    normalizeWpfClientServer(w);
    expect(w.serverArr).toEqual([]);
    expect(() => normalizeWpfClientServer(null as any)).not.toThrow();
  });
});

describe('makeWpfServerArrEntry', () => {
  it('产出与弹窗/向导一致的条目形状', () => {
    expect(makeWpfServerArrEntry(4, '华俊-测试', '/opt/new')).toEqual({
      id: 4,
      name: '华俊-测试',
      serverPathArr: [{ label: '', value: [{ identity: '', path: '/opt/new' }] }],
    });
  });
});

describe('syncWpfClientLegacyFields（新→旧，本修复核心）', () => {
  it('serverArr 首台回写旧字段', () => {
    const w = { ...legacyWpf(), serverArr: [makeWpfServerArrEntry(4, '华俊-测试', '/opt/smom/ftp/client/')] };
    syncWpfClientLegacyFields(w);
    expect(w.serverId).toBe(4);
    expect(w.serverName).toBe('华俊-测试');
    expect(w.serverPath).toBe('/opt/smom/ftp/client/');
  });

  it('serverArr 为空：清空旧字段（模块停用语义，对齐 clearWpfClient）', () => {
    const w = legacyWpf();
    w.serverArr = [];
    syncWpfClientLegacyFields(w);
    expect(w.serverId).toBeNull();
    expect(w.serverName).toBeNull();
    expect(w.serverPath).toBe('');
  });

  it('多台服务器取第一台（旧字段单服务器模型，与现状持平）', () => {
    const w = { ...legacyWpf(), serverArr: [makeWpfServerArrEntry(1, 'A', '/a'), makeWpfServerArrEntry(2, 'B', '/b')] };
    syncWpfClientLegacyFields(w);
    expect(w.serverId).toBe(1);
    expect(w.serverPath).toBe('/a');
  });

  it('嵌套 path 缺失回退空串；入参 null/undefined 安全', () => {
    const w = { ...legacyWpf(), serverArr: [{ id: 5, name: 'X', serverPathArr: [] }] };
    syncWpfClientLegacyFields(w);
    expect(w.serverPath).toBe('');
    expect(() => syncWpfClientLegacyFields(null)).not.toThrow();
    expect(() => syncWpfClientLegacyFields(undefined)).not.toThrow();
  });

  it('完整链路（诊断报告场景）：旧数据 → normalize → 弹窗改 serverArr 路径 → sync → 旧字段更新', () => {
    const w = legacyWpf();
    normalizeWpfClientServer(w);                       // 弹窗 openDialog 时发生
    // 注意 value 类型为 ServerPublishType[] | null（strict），索引前需非空断言
    w.serverArr[0]!.serverPathArr[0]!.value![0].path = '/opt/smom/ftp/client/';  // 用户在弹窗编辑
    syncWpfClientLegacyFields(w);                      // 保存时发生（本修复新增）
    expect(w.serverPath).toBe('/opt/smom/ftp/client/');
  });
});
