import { cmdInvoke } from '@/utils/command';
import { useTfsDb } from '@/database/teamFoundationServer';

/** TFS 自动识别结果（向导与应用配置弹窗共用） */
export interface TfsDetectInfo {
  tfsName: string;
  tfsServerUrl: string;
  tfsSourcePath: string;
  tfsLocalPath: string;
  tfvcPath: string;
  workspaceName: string;
}

/** tfsName 默认值：取源位置尾段（如 $/SMOM.DEV.10.2/SMOM.NBXR → SMOM.NBXR）。
 *  不用 Collection 尾段——存量记录共享同一集合，同集合多项目会生成相同默认名，必撞唯一性查重。 */
export function defaultTfsName(tfsSourcePath: string): string {
  const p = tfsSourcePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.substring(idx + 1) : p;
}

/** 纯函数：按 服务地址+源位置 找存量重复记录（精确比较；getTfsList 的 LIKE 过滤是子串匹配，不可用于查重） */
export function findTfsDuplicate(
  list: RowTfsType[],
  info: Pick<TfsDetectInfo, 'tfsServerUrl' | 'tfsSourcePath'>
): RowTfsType | undefined {
  return list.find((x) => (x.tfsServerUrl ?? '') === info.tfsServerUrl && (x.tfsSourcePath ?? '') === info.tfsSourcePath);
}

/** SLN 的 TFS 工作区自动识别：tfvcPath 优先复用存量记录（避免全盘扫描）；失败返回 null 不抛错 */
export async function detectTfsForSln(slnPath: string): Promise<TfsDetectInfo | null> {
  if (!slnPath) return null;
  let tfvcPath: string | null = null;
  try {
    const tr = await useTfsDb().getTfsList({ tfsName: null, tfsSourcePath: null, sorting: 'id DESC', skipCount: 0, maxResultCount: 1000 });
    tfvcPath = (tr.data?.data ?? []).find((x) => x.tfvcPath)?.tfvcPath ?? null;
  } catch { /* 查询失败走 Rust 端 find_tf_exe 兜底 */ }
  const r = await cmdInvoke<any>('detect_tfs_workspace', { slnPath, tfvcPath });
  if (r.code !== 0 || !r.data) return null;
  return {
    tfsName: defaultTfsName(r.data.tfsSourcePath),
    tfsServerUrl: r.data.tfsServerUrl,
    tfsSourcePath: r.data.tfsSourcePath,
    tfsLocalPath: r.data.tfsLocalPath,
    tfvcPath: r.data.tfvcPath,
    workspaceName: r.data.workspaceName,
  };
}

/** 查重落库：命中 服务地址+源位置 复用存量（reused=true 返回其 id）；未命中校验名称唯一后插入。
 *  撞名抛 Error（中文提示），调用方决定呈现方式。 */
export async function saveTfsRecord(info: TfsDetectInfo): Promise<{ id: number | null; reused: boolean }> {
  const name = info.tfsName.trim();
  if (!name) throw new Error('TFS 名称不能为空');
  const tfsDb = useTfsDb();
  const tr = await tfsDb.getTfsList({ tfsName: null, tfsSourcePath: null, sorting: 'id DESC', skipCount: 0, maxResultCount: 1000 });
  if (tr.code !== 0) throw new Error(tr.msg);
  const all = tr.data?.data ?? [];
  const dup = findTfsDuplicate(all, info);
  if (dup) return { id: dup.id ?? null, reused: true };
  if (all.some((x) => x.tfsName === name)) throw new Error(`TFS名称[${name}]已存在，请修改名称`);
  const ir = await tfsDb.insertTfs({
    id: null, tfsName: name, tfsServerUrl: info.tfsServerUrl, tfsSourcePath: info.tfsSourcePath,
    tfsLocalPath: info.tfsLocalPath, tfvcPath: info.tfvcPath, remark: '自动识别',
  } as RowTfsType);
  if (ir.code !== 0) throw new Error(ir.msg);
  return { id: ir.data ?? null, reused: false };
}
