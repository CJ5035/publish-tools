<template>
  <div>
    <h3>确认 ({{ currentEnvLabel }})</h3>
    <el-table :data="summary" border size="small">
      <el-table-column prop="service" label="服务" width="150" />
      <el-table-column prop="server" label="服务器" />
      <el-table-column prop="path" label="路径" />
    </el-table>
    <div v-if="dupMsg" style="color:#F56C6C;margin-top:12px;">{{ dupMsg }}</div>
  </div>
</template>
<script setup lang="ts">
import { inject, ref, computed, onMounted } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useProjectDb } from '@/database/project';
import { useServerDb } from '@/database/servers';
import { useAppconfigDb } from '@/database/appconfig';
import type { WizardDraft } from './wizardTypes';
import { NORMAL_SERVICES, displayEnv } from './wizardTypes';

const props = defineProps<{ currentEnv: number }>();
const draft = inject<WizardDraft>('wizardDraft')!;
const projectDb = useProjectDb();
const serverDb = useServerDb();
const appconfigDb = useAppconfigDb();
const dupMsg = ref('');

const currentEnvLabel = computed(()=> displayEnv(props.currentEnv));
const summary = computed(()=>{
  const cfg = draft.envConfig[props.currentEnv];
  if(!cfg) return [];
  const rows:any[]=[];
  for(const svc of cfg.services){
    if(!svc.enabled) continue;
    for(const t of svc.targets){
      const srv = draft.servers.find(x=>`${x.ip}:${x.port}`===t.serverKey);
      rows.push({ service: svc.name, server: srv?.name ?? t.serverKey, path: t.path });
    }
  }
  return rows;
});

onMounted(async ()=>{
  dupMsg.value='';
  // duplicate check: projectId must be known or new project will be checked after creation; for existing project check now
  if(draft.project.id){
    try{
      const r = await appconfigDb.getPublishAppconfigs(draft.project.id, props.currentEnv);
      if(r.code===0 && (r.data as any)?.data?.id){
        dupMsg.value = `该环境已有配置，请使用编辑功能`;
        await ElMessageBox.alert(dupMsg.value, '提示');
      }
    }catch{}
  }
});

function buildConfigItems(env:number): RowAppconfigType {
  const cfg = draft.envConfig[env];
  const items:any = { isRebuild:1, isBackup:0, isNewVersion: draft.project.isNewVersion, backupBasePath:null };
  for(const name of NORMAL_SERVICES){
    const svc = cfg.services.find(s=>s.name===name)!;
    const arr = svc.enabled ? svc.targets.map(t=>{
      const srv = draft.servers.find(x=>`${x.ip}:${x.port}`===t.serverKey)!;
      return { id: srv.id, name: srv.name, serverPathArr:[{ label:'', value:[{ identity: t.serverKey, path: t.path }] }] };
    }) : [];
    items[name]={ clientPath: (draft.project.clientPaths as any)?.[name] ?? '', serverPath:'', serverIds: arr.map((a:any)=>a.id), serverArr: arr };
  }
  const wpf = cfg.services.find(s=>s.name==='wpfClient')!;
  const wpfTarget = wpf.enabled ? wpf.targets[0] : null;
  const wpfSrv = wpfTarget ? draft.servers.find(x=>`${x.ip}:${x.port}`===wpfTarget.serverKey) : null;
  items.wpfClient={
    clientPath: (draft.project.clientPaths as any)?.wpfClient ?? '',
    serverId: wpfSrv?.id ?? null,
    serverName: wpfSrv?.name ?? null,
    serverPath: wpfTarget?.path ?? '',
    isCompress:1,
    generateDirJson: draft.project.isNewVersion ? '["Plugins"]' : '["Domain","UI"]',
    compressFileJson:'',
  };
  return {
    id:null, projectId: draft.project.id!, projectName: draft.project.name, environment: env,
    msBuildPath:null, dllMode:'全部', dllModeValue:null, buildMode: draft.project.buildMode,
    configItemsJson: JSON.stringify(items), configItems: items,
  } as any;
}

async function validate(): Promise<boolean>{
  if(dupMsg.value) return false;
  // duplicate re-check
  if(draft.project.id){
    const r = await appconfigDb.getPublishAppconfigs(draft.project.id, props.currentEnv);
    if(r.code===0 && (r.data as any)?.data?.id){
      await ElMessageBox.alert('该环境已有配置，请使用编辑功能','提示');
      return false;
    }
  }
  try{
    // 0) project
    let projectId = draft.project.id;
    if(!projectId){
      const pr = await projectDb.insertProject({ id:null, code: draft.project.code, name: draft.project.name, description:null, isDefault:0, assemblyOutPath: draft.project.assemblyOutPath ?? null } as any);
      if(pr.code!==0) throw new Error(pr.msg);
      projectId = pr.data;
      draft.project.id = pr.data;
    }
    // 1) servers (first env only)
    if(draft.servers.some(x=>x.isNew)){
      const existing = await serverDb.getServerList({ projectId, name:null, sorting:'id DESC', skipCount:0, maxResultCount:1000 } as any);
      const existingKeys = new Set(((existing.data as any)?.data ?? []).map((x:RowServerType)=>`${x.ip}:${x.port}`));
      for(const s of draft.servers.filter(x=>x.isNew)){
        const key = `${s.ip}:${s.port}`;
        if(existingKeys.has(key)){
          const found = ((existing.data as any).data as RowServerType[]).find(x=>`${x.ip}:${x.port}`===key)!;
          s.id = found.id!; s.isNew=false; continue;
        }
        const r = await serverDb.insertServer({ id:null, projectId, projectName:null, name:s.name, os:s.os, ip:s.ip, port:s.port, account:s.account, pwd:s.pwd, description:null } as any);
        if(r.code!==0) throw new Error(r.msg);
        s.id = r.data; s.isNew=false;
      }
    }
    // 2) appconfig
    const row = buildConfigItems(props.currentEnv);
    row.projectId = draft.project.id!;
    const ins = await appconfigDb.insertAppconfig(row as any);
    if(ins.code!==0) throw new Error(ins.msg);
    return true;
  }catch(e:any){
    await ElMessageBox.alert(String(e.message ?? e), '落库失败');
    return false;
  }
}
defineExpose({ validate });
</script>
