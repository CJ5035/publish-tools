<template>
  <div>
    <h3>确认 ({{ currentEnvLabel }})</h3>
    <el-table :data="summary" border size="small">
      <el-table-column prop="service" label="服务" width="150" />
      <el-table-column prop="server" label="服务器" />
      <el-table-column prop="path" label="路径" />
    </el-table>
    <el-alert
      v-if="existingRow"
      type="warning"
      :closable="false"
      show-icon
      style="margin-top:12px;"
    >{{ t('message.appconfig.wizard.confirm.dupHint') }}</el-alert>
  </div>
</template>
<script setup lang="ts">
import { inject, ref, computed, onMounted } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useProjectDb } from '@/database/project';
import { useServerDb } from '@/database/servers';
import { useAppconfigDb } from '@/database/appconfig';
import { useSettingsDb } from '@/database/settings/index';
import type { WizardDraft } from './wizardTypes';
import { NORMAL_SERVICES, displayEnv, mergeConfigItems } from './wizardTypes';
import { saveTfsRecord } from '@/utils/tfsDetect';

const { t } = useI18n();

const props = defineProps<{ currentEnv: number }>();
const draft = inject<WizardDraft>('wizardDraft')!;
const projectDb = useProjectDb();
const serverDb = useServerDb();
const appconfigDb = useAppconfigDb();
// 已有配置行（仅用于提示展示；落库前 validate 内重新权威查询）
const existingRow = ref<RowAppconfigType | null>(null);
// 本环境本次提交模式，供 index.vue 总结页展示
const saveMode = ref<'insert' | 'update'>('insert');

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

onMounted(async () => {
  existingRow.value = null;
  if (draft.project.id) {
    try {
      const r = await appconfigDb.getPublishAppconfigs(draft.project.id, props.currentEnv);
      if (r.code === 0 && (r.data as any)?.data?.id) {
        existingRow.value = (r.data as any).data as RowAppconfigType;
      }
    } catch {}
  }
});

async function findExisting(): Promise<RowAppconfigType | null> {
  if (!draft.project.id) return null;
  try {
    const r = await appconfigDb.getPublishAppconfigs(draft.project.id, props.currentEnv);
    if (r.code === 0 && (r.data as any)?.data?.id) return (r.data as any).data as RowAppconfigType;
  } catch {}
  return null;
}

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

async function validate(): Promise<boolean> {
  try {
    // 0) 已有配置确认（在任何写库之前，取消零副作用；新建项目不可能命中，天然跳过）
    const existing = await findExisting();
    if (existing) {
      existingRow.value = existing;
      const ok = await ElMessageBox.confirm(
        t('message.appconfig.wizard.confirm.dupConfirmMsg'),
        t('message.appconfig.wizard.confirm.dupConfirmTitle'),
        {
          type: 'warning',
          confirmButtonText: t('message.appconfig.wizard.confirm.dupConfirmOk'),
          cancelButtonText: t('message.appconfig.wizard.cancel'),
        }
      ).then(() => true).catch(() => false);
      if (!ok) return false;
    }
    // 1) project
    let projectId = draft.project.id;
    if (!projectId) {
      const pr = await projectDb.insertProject({ id: null, code: draft.project.code, name: draft.project.name, description: null, isDefault: 0, assemblyOutPath: draft.project.assemblyOutPath ?? null } as any);
      if (pr.code !== 0) throw new Error(pr.msg);
      projectId = pr.data;
      draft.project.id = pr.data;
    }
    // 2) servers (first env only)
    if (draft.servers.some((x) => x.isNew)) {
      const exServers = await serverDb.getServerList({ projectId, name: null, sorting: 'id DESC', skipCount: 0, maxResultCount: 1000 } as any);
      const existingKeys = new Set(((exServers.data as any)?.data ?? []).map((x: RowServerType) => `${x.ip}:${x.port}`));
      for (const s of draft.servers.filter((x) => x.isNew)) {
        const key = `${s.ip}:${s.port}`;
        if (existingKeys.has(key)) {
          const found = ((exServers.data as any).data as RowServerType[]).find((x) => `${x.ip}:${x.port}` === key)!;
          s.id = found.id!; s.isNew = false; continue;
        }
        const r = await serverDb.insertServer({ id: null, projectId, projectName: null, name: s.name, os: s.os, ip: s.ip, port: s.port, account: s.account, pwd: s.pwd, description: null } as any);
        if (r.code !== 0) throw new Error(r.msg);
        s.id = r.data; s.isNew = false;
      }
    }
    // 2) tfs（仅首个环境执行一次：serverUrl+sourcePath 查重复用/插入由共享工具完成）
    if (draft.tfs && !draft.tfsSaved) {
      try {
        await saveTfsRecord(draft.tfs);
      } catch (e: any) {
        throw new Error(`TFS 保存失败（请返回第1步调整）：${e.message ?? e}`);
      }
      draft.tfsSaved = true;
    }
    // 3) appconfig：已有 → 合并更新；没有 → 新增
    const row = buildConfigItems(props.currentEnv);
    row.projectId = draft.project.id!;
    if (!existing) {
      try {
        const gr = await useSettingsDb().getSettings();
        if (gr.code === 0 && gr.data?.msBuildPath) {
          const v = String(gr.data.msBuildPath).trim();
          if (v) row.msBuildPath = v;
        }
      } catch {}
    }
    if (existing) {
      row.id = existing.id!;
      row.msBuildPath = existing.msBuildPath ?? null;
      row.dllMode = existing.dllMode ?? '全部';
      row.dllModeValue = existing.dllModeValue ?? null;
      row.configItems = mergeConfigItems(existing.configItems, row.configItems);
      row.configItemsJson = JSON.stringify(row.configItems);
      const upd = await appconfigDb.updateAppconfig(row as any);
      if (upd.code !== 0) throw new Error(upd.msg);
      saveMode.value = 'update';
      return true;
    }
    const ins = await appconfigDb.insertAppconfig(row as any);
    if (ins.code !== 0) throw new Error(ins.msg);
    saveMode.value = 'insert';
    return true;
  } catch (e: any) {
    await ElMessageBox.alert(String(e.message ?? e), '落库失败');
    return false;
  }
}
defineExpose({ validate, saveMode });
</script>

