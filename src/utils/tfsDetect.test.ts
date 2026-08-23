import { describe, it, expect } from 'vitest';
import { defaultTfsName, findTfsDuplicate } from './tfsDetect';

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

describe('findTfsDuplicate', () => {
  const list: RowTfsType[] = [
    { id: 1, tfsName: '新容', tfsServerUrl: 'http://x:8081/tfs/smom.dev', tfsSourcePath: '$/SMOM.DEV.10.2/SMOM.NBXR', tfsLocalPath: 'F:\\a', tfvcPath: 'D:\\tf.exe', remark: null },
    { id: 2, tfsName: '中恒', tfsServerUrl: 'http://x:8081/tfs/smom.dev', tfsSourcePath: '$/SMOM.DEV.8.3/SMOM.EIS.Zhongheng', tfsLocalPath: 'F:\\b', tfvcPath: 'D:\\tf.exe', remark: null },
  ];

  it('serverUrl+sourcePath 均相同命中（同集合不同记录靠 sourcePath 区分）', () => {
    expect(findTfsDuplicate(list, { tfsServerUrl: 'http://x:8081/tfs/smom.dev', tfsSourcePath: '$/SMOM.DEV.8.3/SMOM.EIS.Zhongheng' })?.id).toBe(2);
  });
  it('同集合不同分支不命中', () => {
    expect(findTfsDuplicate(list, { tfsServerUrl: 'http://x:8081/tfs/smom.dev', tfsSourcePath: '$/SMOM.DEV.9.0/NEW' })).toBeUndefined();
  });
  it('存量记录 null 字段安全', () => {
    expect(findTfsDuplicate([{ ...list[0], tfsServerUrl: null, tfsSourcePath: null }], { tfsServerUrl: 'http://x', tfsSourcePath: '$/a' })).toBeUndefined();
  });
});
