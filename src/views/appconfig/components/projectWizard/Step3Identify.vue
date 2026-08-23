<template>
  <div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <el-button type="primary" :loading="scanning" @click="doScan()">重新扫描</el-button>
      <el-button @click="keywordVisible=true">编辑关键词</el-button>
      <el-button v-if="showBatchDeep" type="warning" :loading="batchDeeping" @click="onDeepAll">{{ t('message.appconfig.wizard.deepScanAll') }}</el-button>
    </div>
    <template v-for="srv in draft.servers" :key="srv.ip+':'+srv.port">
      <el-card style="margin-bottom:12px;">
        <template #header>
          <div style="display:flex;align-items:center;gap:8px;">
            <span>{{ srv.name }} ({{ srv.ip }}:{{ srv.port }})</span>
            <el-tag v-if="statusOf(srv)" :type="statusOf(srv)!.type" size="small">{{ statusOf(srv)!.label }}</el-tag>
          </div>
        </template>
        <div v-for="b in blocksFor(srv)" :key="b.svc" style="border:1px solid #eee;padding:10px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span style="font-weight:600;width:130px;">{{ b.svc }}</span>
            <el-tag v-if="b.status==='matched'" type="success" size="small">已识别 {{ b.count }} 个节点</el-tag>
            <el-tag v-else-if="b.status==='candidate'" type="warning" size="small">候选</el-tag>
            <el-tag v-else type="info" size="small">未识别</el-tag>
          </div>
          <template v-if="b.svc==='wpfClient'">
            <div style="display:flex;gap:6px;">
              <el-select v-if="b.candidates.length>0" :model-value="b.paths[0] ?? ''" placeholder="选择候选" size="small" style="flex:1;" allow-create filterable :disabled="b.svc==='wpfClient' && !srv.isWpfServer" @change="onWpfPathChange(srv,$event)">
                <el-option v-for="c in b.candidates" :key="c" :label="c" :value="c" />
              </el-select>
              <el-input v-else :model-value="b.paths[0] ?? ''" placeholder="请填写路径" size="small" style="flex:1;" :disabled="b.svc==='wpfClient' && !srv.isWpfServer" @change="onWpfPathChange(srv,$event)" />
              <el-button v-if="srv.isWpfServer" size="small" :loading="deepScanning[srv.ip+':'+srv.port]" @click="deepScanWpf(srv)">深度扫描</el-button>
              <el-tag v-else size="small" type="info">{{ t('message.appconfig.wizard.wpfUnmarked') }}</el-tag>
            </div>
          </template>
          <template v-else>
            <div v-for="(p,idx) in b.displayPaths" :key="b.svc+'-'+idx" style="display:flex;gap:6px;margin-bottom:6px;">
              <el-input :model-value="p" placeholder="请填写路径" size="small" style="flex:1;" @change="onRowPathChange(srv,b.svc,idx,$event)" />
              <el-button size="small" type="danger" @click="removeRow(srv,b.svc,idx)">删除</el-button>
            </div>
            <el-button size="small" @click="addRow(srv,b.svc)">添加一行</el-button>
          </template>
        </div>
      </el-card>
    </template>

    <el-dialog v-model="keywordVisible" title="编辑关键词" width="520px" append-to-body>
      <div v-for="svc in serviceList" :key="svc" style="margin-bottom:10px;">
        <div style="font-weight:600;">{{ svc }}</div>
        <el-input v-model="keywordEdit[svc]" placeholder="逗号分隔" size="small" />
      </div>
      <template #footer>
        <el-button @click="keywordVisible=false">取消</el-button>
        <el-button type="primary" @click="onSaveKeywords">保存并重新匹配</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { ref, inject, onMounted, reactive, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { cmdInvoke } from '@/utils/command';
import { useI18n } from 'vue-i18n';
import { useScanConfigDb } from '@/database/scanConfig';
import { DEFAULT_SERVICE_KEYWORDS, matchServices, SERVICE_NAMES, deriveAnchors, diffScanTargets, rematchAll } from './wizardTypes';
import type { WizardDraft, RemoteServiceVo, ServiceName, ServerScanStatus, WizardServer } from './wizardTypes';

const { t } = useI18n();
const draft = inject<WizardDraft>('wizardDraft')!;
const scanDb = useScanConfigDb();
const scanning = ref(false);
const scanStatus = ref<Record<string, ServerScanStatus>>({});
const SCAN_CONCURRENCY = 4;
const STATUS_META: Record<ServerScanStatus, { label: string; type: 'info' | 'warning' | 'success' | 'danger' }> = {
  pending: { label: '待扫描', type: 'info' },
  scanning: { label: '扫描中', type: 'warning' },
  done: { label: '已完成', type: 'success' },
  failed: { label: '扫描失败', type: 'danger' },
};
function statusOf(srv: { ip: string; port: number }){
  const s = scanStatus.value[`${srv.ip}:${srv.port}`];
  return s ? STATUS_META[s] : null;
}
const keywordVisible = ref(false);
const keywords = ref<Record<ServiceName,string[]>>({ ...DEFAULT_SERVICE_KEYWORDS } as any);
const keywordEdit = reactive<Record<string,string>>({});
const serviceList = SERVICE_NAMES as string[];

function initKeywordEdit(){
  for(const s of SERVICE_NAMES){ keywordEdit[s] = (keywords.value[s] ?? []).join(','); }
}
async function loadKeywords(){
  try{
    const r = await scanDb.getDefaultScanConfig();
    if(r.data?.serviceKeywords){
      const obj = JSON.parse(r.data.serviceKeywords);
      for(const k of SERVICE_NAMES){ if(obj[k]) keywords.value[k]=obj[k]; }
    }
  }catch{}
  initKeywordEdit();
}
onMounted(async ()=>{
  await loadKeywords();
  const { toScan, toRemove } = diffScanTargets(draft.servers, Object.keys(draft.scanResults));
  for(const k of toRemove){
    delete draft.scanResults[k];
    delete draft.scanCandidates[k];
    delete draft.rawEnumerated[k];
    delete draft.probedWpf[k];
    delete scanStatus.value[k];
  }
  if(toScan.length>0) await doScan(toScan);
});

async function doScan(target?: WizardServer[]){
  const list = target ?? draft.servers;
  for(const s of list) scanStatus.value[`${s.ip}:${s.port}`] = 'pending';
  scanning.value = true;
  const queue = [...list];
  const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, queue.length) }, () => (async () => {
    while (queue.length > 0) {
      const s = queue.shift()!;
      const key = `${s.ip}:${s.port}`;
      scanStatus.value[key] = 'scanning';
      try {
        await scanOne(s);
        scanStatus.value[key] = 'done';
      } catch {
        scanStatus.value[key] = 'failed';
      }
    }
  })());
  await Promise.all(workers);
  scanning.value = false;
}

/** 单台服务器扫描：主扫描失败/为空时落兜底目录扫描；两者皆败时 throw（由调用方标记 failed） */
async function scanOne(s: WizardServer){
  const key = `${s.ip}:${s.port}`;
  let enumerated: RemoteServiceVo[] | null = null;
  try{
    const r = await cmdInvoke('scan_server_services', { username: s.account, password: s.pwd, server: key, serverOs: s.os });
    if(r.code===0 && Array.isArray(r.data)) enumerated = r.data as RemoteServiceVo[];
    else throw new Error(String(r.data));
  }catch{
    // 主扫描失败，落兜底目录扫描
  }
  if(!enumerated || enumerated.length===0){
    if (!s.scanRoot?.trim()) throw new Error('服务枚举失败且无扫描根路径');
    const cfg = await scanDb.getDefaultScanConfig();
    const excludePatterns = JSON.parse(cfg.data?.excludePatterns || '[]');
    const r2 = await cmdInvoke('scan_server_directories', { username: s.account, password: s.pwd, server: key, serverOs: s.os, scanRoot: s.scanRoot, excludePatterns });
    if(!(r2.code===0 && Array.isArray(r2.data))) throw new Error('目录扫描失败');
    const dirs = r2.data as { name:string; path:string }[];
    enumerated = dirs.map(d=>({ name:d.name, display_name:d.name, exec_dir:d.path, source:'service' }));
  }
  draft.rawEnumerated[key] = enumerated;
  const { matched, candidates } = matchServices(enumerated, keywords.value);
  draft.scanResults[key] = matched;
  draft.scanCandidates[key] = candidates as any;
  await probeWpfClient(s, key, enumerated);
}

/** wpfClient 锚点探测：从已识别服务 exec_dir/挂载推导锚点（含家目录），单次往返探测 Manifest.xml+zip。
 *  命中：首个进 matched、其余进候选；锚点为空或未命中则保持未识别（由用户决定是否手动深度扫描）。
 *  探测失败不影响服务器整体扫描状态（catch 静默，仅 console.warn）。 */
async function probeWpfClient(s: WizardServer, key: string, services: RemoteServiceVo[]){
  try{
    const execDirs: string[] = [];
    for(const svc of services){
      if(svc.exec_dir) execDirs.push(svc.exec_dir);
      for(const m of svc.mounts ?? []) if(m) execDirs.push(m);
    }
    const anchors = deriveAnchors(execDirs, s.os, s.account);
    if(anchors.length>0 && !s.scanRoot?.trim()) s.scanRoot = anchors[0]; // scanRoot 自愈回写
    if(anchors.length===0) return;
    // 项 13：网络探测仅对勾选的 wpfClient 服务器执行；锚点推导与 scanRoot 自愈（上行）保留给所有服务器
    if(!s.isWpfServer) return;
    const r = await cmdInvoke('scan_wpf_publish_dirs', { username: s.account, password: s.pwd, server: key, serverOs: s.os, anchors, fullScan: false });
    if(r.code!==0 || !Array.isArray(r.data)) return;
    const hits = r.data as string[];
    if(hits.length===0) return;
    draft.probedWpf[key] = hits[0];
    if(!draft.scanCandidates[key]) draft.scanCandidates[key] = {};
    (draft.scanResults[key] as any).wpfClient = [hits[0]];
    if(hits.length>1) (draft.scanCandidates[key] as any).wpfClient = hits.slice(1);
  }catch(e){
    console.warn('wpfClient 探测失败', key, e);
  }
}

/** 手动深度扫描：用户点击 wpfClient 行「深度扫描」按钮触发全盘探测（Linux 剪枝+timeout，Windows robocopy）。
 *  结果只进候选下拉，不自动拍板。禁自动调用——服务器无 wpfClient 是常态，全盘耗时 5~30s+。 */
const deepScanning = ref<Record<string, boolean>>({});
const batchDeeping = ref(false);
const showBatchDeep = computed(() => {
  const targets = draft.servers.filter((s) => s.isWpfServer);
  if (targets.length < 2) return false;
  return targets.every((s) => {
    const arr = (draft.scanResults[`${s.ip}:${s.port}`] as any)?.wpfClient ?? [];
    return !arr || arr.length === 0;
  });
});
async function onDeepAll() {
  batchDeeping.value = true;
  try {
    for (const s of draft.servers.filter((x) => x.isWpfServer)) {
      await deepScanWpf(s);
    }
  } finally { batchDeeping.value = false; }
}
async function deepScanWpf(s: WizardServer){
  const key = `${s.ip}:${s.port}`;
  deepScanning.value[key] = true;
  try{
    const r = await cmdInvoke('scan_wpf_publish_dirs', { username: s.account, password: s.pwd, server: key, serverOs: s.os, anchors: [], fullScan: true });
    if(r.code===0 && Array.isArray(r.data)){
      const hits = r.data as string[];
      if(hits.length===0){
        ElMessage.info('深度扫描未发现 wpfClient 发布目录');
        return;
      }
      if(!draft.scanCandidates[key]) draft.scanCandidates[key] = {};
      (draft.scanCandidates[key] as any).wpfClient = hits;
    }
  }catch(e){
    console.warn('深度扫描失败', key, e);
    ElMessage.warning('深度扫描失败，请查看控制台日志');
  }finally{
    deepScanning.value[key] = false;
  }
}

interface SvcBlock {
  svc: ServiceName;
  paths: string[];
  /** 无识别结果时也渲染一行空输入，便于手填 */
  displayPaths: string[];
  count: number;
  status: string;
  candidates: string[];
}
function blocksFor(srv:any): SvcBlock[]{
  const key = `${srv.ip}:${srv.port}`;
  const matched = draft.scanResults[key] ?? {};
  const cands = draft.scanCandidates[key] ?? {};
  return SERVICE_NAMES.map(svc=>{
    const paths = ((matched as any)[svc] ?? []) as string[];
    const candidates = ((cands as any)[svc] ?? []) as string[];
    const count = paths.filter((p)=>p.trim()).length;
    let status = 'unmatched';
    if(count>0) status='matched';
    else if(candidates.length>0) status='candidate';
    return { svc, paths, displayPaths: paths.length>0 ? paths : [''], count, status, candidates };
  });
}
/** 取（必要时初始化）某服务器某服务的节点路径数组，所有行级写操作经此入口保证父对象存在 */
function ensurePaths(srv:any, svc: ServiceName): string[]{
  const key = `${srv.ip}:${srv.port}`;
  if(!draft.scanResults[key]) draft.scanResults[key] = {} as any;
  const holder = draft.scanResults[key] as any;
  if(!Array.isArray(holder[svc])) holder[svc] = [];
  return holder[svc];
}
function markManual(srv:any, svc: ServiceName){
  const key = `${srv.ip}:${srv.port}`;
  const manual = draft.manualPaths[key] ?? (draft.manualPaths[key] = []);
  if(!manual.includes(svc)) manual.push(svc);
}
function onRowPathChange(srv:any, svc: ServiceName, idx:number, val:string){
  ensurePaths(srv, svc)[idx] = val ?? '';
  markManual(srv, svc);
}
function removeRow(srv:any, svc: ServiceName, idx:number){
  ensurePaths(srv, svc).splice(idx,1);
  markManual(srv, svc);
}
function addRow(srv:any, svc: ServiceName){
  ensurePaths(srv, svc).push('');
  markManual(srv, svc);
}
/** wpfClient 单目标：整组替换为选中值 */
function onWpfPathChange(srv:any, val:string){
  const arr = ensurePaths(srv, 'wpfClient');
  arr.splice(0, arr.length, val ?? '');
  markManual(srv, 'wpfClient');
}
async function onSaveKeywords(){
  const newKw: Record<ServiceName,string[]> = {} as Record<ServiceName,string[]>;
  for(const s of SERVICE_NAMES){ newKw[s] = keywordEdit[s].split(/[,，]/).map(x=>x.trim()).filter(Boolean); }
  keywords.value = newKw as any;
  try{
    const cfg = await scanDb.getDefaultScanConfig();
    const row = cfg.data;
    if(row && row.id){
      await scanDb.upsertScanConfig({ ...row, serviceKeywords: JSON.stringify(newKw) });
    } else {
      await scanDb.upsertScanConfig({ name:'default', excludePatterns:'[]', includePatterns:'[]', excludeSystemDirs:1, excludeHiddenDirs:1, isGlobal:1, projectId:null, serviceKeywords: JSON.stringify(newKw) } as any);
    }
  }catch(e){ console.warn(e); }
  keywordVisible.value=false;
  const { scanResults, scanCandidates } = rematchAll({
    rawEnumerated: draft.rawEnumerated,
    keywords: newKw,
    manualPaths: draft.manualPaths,
    probedWpf: draft.probedWpf,
    prevScanResults: draft.scanResults,
    prevScanCandidates: draft.scanCandidates,
  });
  draft.scanResults = scanResults;
  draft.scanCandidates = scanCandidates;
  ElMessage.success('已保存，已重新匹配');
}

async function validate(): Promise<boolean>{ return true; }
defineExpose({ validate });
</script>
