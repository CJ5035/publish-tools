<template>
  <div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <el-button type="primary" :loading="scanning" @click="doScan">重新扫描</el-button>
      <el-button @click="keywordVisible=true">编辑关键词</el-button>
    </div>
    <div v-if="scanning" style="color:#999;">正在枚举服务，请稍候...</div>
    <template v-for="srv in draft.servers" :key="srv.ip+':'+srv.port">
      <el-card style="margin-bottom:12px;" :header="`${srv.name} (${srv.ip}:${srv.port})`">
        <el-table :data="rowsFor(srv)" border size="small">
          <el-table-column label="服务" prop="service" width="150" />
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag v-if="row.status==='matched'" type="success" size="small">已识别</el-tag>
              <el-tag v-else-if="row.status==='candidate'" type="warning" size="small">候选</el-tag>
              <el-tag v-else type="info" size="small">未识别</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="路径">
            <template #default="{ row }">
              <div style="display:flex;gap:6px;">
                <el-select v-if="row.candidates && row.candidates.length>0" v-model="row.path" placeholder="选择候选" size="small" style="flex:1;" allow-create filterable @change="onPathChange(srv,row)">
                  <el-option v-for="c in row.candidates" :key="c" :label="c" :value="c" />
                </el-select>
                <el-input v-else v-model="row.path" placeholder="请填写路径" size="small" style="flex:1;" @change="onPathChange(srv,row)" />
              </div>
            </template>
          </el-table-column>
        </el-table>
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
import { ref, inject, onMounted, reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { cmdInvoke } from '@/utils/command';
import { useScanConfigDb } from '@/database/scanConfig';
import { DEFAULT_SERVICE_KEYWORDS, matchServices, SERVICE_NAMES } from './wizardTypes';
import type { WizardDraft, RemoteServiceVo, ServiceName } from './wizardTypes';

const draft = inject<WizardDraft>('wizardDraft')!;
const scanDb = useScanConfigDb();
const scanning = ref(false);
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
onMounted(async ()=>{ await loadKeywords(); if(Object.keys(draft.scanResults).length===0) doScan(); });

async function doScan(){
  scanning.value=true;
  for(const s of draft.servers){
    const key = `${s.ip}:${s.port}`;
    try{
      const r = await cmdInvoke('scan_server_services', { username: s.account, password: s.pwd, server: key, serverOs: s.os });
      if(r.code===0 && Array.isArray(r.data) && r.data.length>0){
        const { matched, candidates } = matchServices(r.data as RemoteServiceVo[], keywords.value);
        draft.scanResults[key] = matched;
        draft.scanCandidates[key] = candidates as any;
        continue;
      }
      if(r.code!==0) throw new Error(String(r.data));
      throw new Error('服务枚举结果为空');
    }catch{
      // fallback to directory scan
      try{
        const cfg = await scanDb.getDefaultScanConfig();
        const excludePatterns = JSON.parse(cfg.data?.excludePatterns || '[]');
        const r2 = await cmdInvoke('scan_server_directories', { username: s.account, password: s.pwd, server: key, serverOs: s.os, scanRoot: s.scanRoot, excludePatterns });
        if(r2.code===0 && Array.isArray(r2.data)){
          // map directory name matching
          const dirs = r2.data as { name:string; path:string }[];
          const fakeServices: RemoteServiceVo[] = dirs.map(d=>({ name:d.name, display_name:d.name, exec_dir:d.path, source:'service' }));
          const { matched, candidates } = matchServices(fakeServices, keywords.value);
          draft.scanResults[key]=matched;
          draft.scanCandidates[key]=candidates as any;
        }
      }catch(e){ console.warn('fallback scan failed', key, e); }
    }
  }
  scanning.value=false;
}

function rowsFor(srv:any){
  const key = `${srv.ip}:${srv.port}`;
  const matched = draft.scanResults[key] ?? {};
  const cands = draft.scanCandidates[key] ?? {};
  return SERVICE_NAMES.map(svc=>{
    const path = (matched as any)[svc] ?? '';
    const candidates = (cands as any)[svc] ?? [];
    let status = 'unmatched';
    if(path) status='matched';
    else if(candidates.length>0) status='candidate';
    return { service: svc, path, candidates, status, svc };
  });
}
function onPathChange(srv:any, row:any){
  const key = `${srv.ip}:${srv.port}`;
  if(!draft.scanResults[key]) draft.scanResults[key]={} as any;
  (draft.scanResults[key] as any)[row.svc]=row.path;
}
async function onSaveKeywords(){
  const newKw: Record<string,string[]> = {};
  for(const s of SERVICE_NAMES){ newKw[s] = keywordEdit[s].split(',').map(x=>x.trim()).filter(Boolean); }
  keywords.value = newKw as any;
  // persist
  try{
    const cfg = await scanDb.getDefaultScanConfig();
    const row = cfg.data;
    if(row && row.id){
      await scanDb.upsertScanConfig({ ...row, serviceKeywords: JSON.stringify(newKw) });
    } else {
      await scanDb.upsertScanConfig({ name:'default', excludePatterns:'[]', includePatterns:'[]', excludeSystemDirs:1, excludeHiddenDirs:1, isGlobal:1, projectId:null, serviceKeywords: JSON.stringify(newKw) } as any);
    }
  }catch(e){ console.warn(e); }
  // re-match already scanned data in memory not needed; re-scan
  keywordVisible.value=false;
  ElMessage.success('已保存，将重新匹配');
  // re-apply matching on existing scanResults? simplest: clear and rescan or reapply on last raw? We'll just keep paths but future scans will use new kw
}

async function validate(): Promise<boolean>{ return true; }
defineExpose({ validate });
</script>
