import { describe, it, expect } from 'vitest';
import { deriveAnchors } from './wizardTypes';

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
