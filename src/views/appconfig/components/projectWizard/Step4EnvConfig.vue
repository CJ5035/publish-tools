<template>
  <div>
    <el-checkbox-group v-model="checkedEnvs" @change="onEnvsChange">
      <el-checkbox v-for="e in ENV_LIST" :key="e" :value="e" :disabled="submitted.has(e)">
        {{ displayEnv(e) }}
        <el-tag v-if="configured.has(e) || submitted.has(e)" size="small" type="info" style="margin-left:4px;">{{ t('message.appconfig.wizard.envConfigured') }}</el-tag>
      </el-checkbox>
    </el-checkbox-group>

    <el-divider />

    <template v-if="cfg && activeEnvInChecked">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">{{ t('message.appconfig.wizard.assignTitle') }} ({{ displayEnv(activeEnv) }})</h3>
        <el-tag v-if="submitted.has(activeEnv)" type="success" size="small">{{ t('message.appconfig.wizard.submittedTag') }}</el-tag>
      </div>

      <el-alert v-if="submitted.has(activeEnv)" type="info" :closable="false" show-icon style="margin-bottom:12px;">
        {{ t('message.appconfig.wizard.lockedHint') }}
      </el-alert>

      <template v-else>
        <div v-for="svc in cfg.services" :key="svc.name" style="border:1px solid #eee;padding:12px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <el-checkbox v-model="svc.enabled" :label="svc.name" :disabled="svc.name==='wpfClient' && !wpfSrv" />
            <el-tag size="small">Env {{ activeEnv }}</el-tag>
          </div>
          <template v-if="svc.enabled">
            <template v-if="svc.name==='wpfClient'">
              <div v-if="wpfSrv" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <el-tag>{{ wpfSrv.name }}（{{ wpfSrv.ip }}）</el-tag>
                <el-input :model-value="wpfPath" :placeholder="t('message.appconfig.wizard.s4.pathPh')" style="flex:1;min-width:260px;" @update:model-value="onWpfPathChange" />
                <el-tag v-if="wpfCheckedCount > 1" type="warning" size="small">
                  {{ t('message.appconfig.wizard.wpfMultiHint', { n: wpfCheckedCount, x: wpfSrv.name }) }}
                </el-tag>
              </div>
              <el-alert v-else type="warning" :closable="false" show-icon>
                {{ t('message.appconfig.wizard.wpfNoServer') }}
              </el-alert>
            </template>
            <template v-else>
              <div v-for="(trow, idx) in svc.targets" :key="idx" style="display:flex;gap:8px;margin-bottom:6px;">
                <el-select v-model="trow.serverKey" :placeholder="t('message.appconfig.wizard.s4.pickServer')" style="width:220px;" @change="onServerChange(trow, svc)">
                  <el-option-group :label="t('message.appconfig.wizard.matchGroup')">
                    <el-option v-for="srv in matchedServers" :key="srv.ip+':'+srv.port" :label="srv.name" :value="srv.ip+':'+srv.port" />
                  </el-option-group>
                  <el-option-group v-if="otherServers.length > 0" :label="t('message.appconfig.wizard.otherGroup')">
                    <el-option v-for="srv in otherServers" :key="srv.ip+':'+srv.port" :label="srv.name" :value="srv.ip+':'+srv.port" />
                  </el-option-group>
                </el-select>
                <el-input v-model="trow.path" :placeholder="t('message.appconfig.wizard.s4.pathPh')" style="flex:1;" />
                <el-button size="small" type="danger" @click="svc.targets.splice(idx,1)">{{ t('message.appconfig.wizard.s4.delRow') }}</el-button>
              </div>
              <el-button size="small" @click="svc.targets.push({ serverKey:'', path:'' })">{{ t('message.appconfig.wizard.s4.addRow') }}</el-button>
            </template>
          </template>
        </div>
        <div style="text-align:right;">
          <el-button type="primary" :loading="submitting" @click="submitEnv">{{ t('message.appconfig.wizard.submitEnv') }}</el-button>
        </div>
      </template>
    </template>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { h } from 'vue';
import { useProjectDb } from '@/database/project';
import { useServerDb } from '@/database/servers';
import { useAppconfigDb } from '@/database/appconfig';
import { useSettingsDb } from '@/database/settings/index';
import { useTfsDb } from '@/database/teamFoundationServer';
import type { WizardDraft, EnvConfig } from './wizardTypes';
import { SERVICE_NAMES, NORMAL_SERVICES, displayEnv, mergeConfigItems, resolveWpfServer } from './wizardTypes';

const ENV_LIST = [1, 2, 3, 4];
const emit = defineEmits<{ (e: 'switchEnv', env: number): void; (e: 'submitted', p: { env: number; mode: 'insert' | 'update' }): void }>();
const props = defineProps<{ currentEnv: number }>();

const { t } = useI18n();
const draft = inject<WizardDraft>('wizardDraft')!;
const projectDb = useProjectDb();
const serverDb = useServerDb();
const appconfigDb = useAppconfigDb();
const tfsDb = useTfsDb();

/** 库中已有配置（挂载时预查，项 7 语义）：打"已配置" tag、默认不勾，但**允许手动勾选**——提交走合并更新 */
const configured = ref<Set<number>>(new Set());
/** 本会话已提交（项 11）：checkbox 禁用 + 表单锁定 + 推进跳过；提交成功时同时并入 configured */
const submitted = ref<Set<number>>(new Set());
const checkedEnvs = ref<number[]>([]);
const submitting = ref(false);
const saveMode = ref<'insert' | 'update'>('insert');

const activeEnv = computed(() => props.currentEnv);
const cfg = computed(() => draft.envConfig[activeEnv.value]);
const activeEnvInChecked = computed(() => checkedEnvs.value.includes(activeEnv.value));
const wpfSrv = computed(() => resolveWpfServer(draft.servers, activeEnv.value));
const wpfCheckedCount = computed(() => draft.servers.filter((s) => s.isWpfServer).length);
const wpfPath = computed(() => cfg.value?.services.find((s) => s.name === 'wpfClient')?.targets[0]?.path ?? '');
const matchedServers = computed(() => draft.servers.filter((s) => s.envTags.length === 0 || s.envTags.includes(activeEnv.value)));
const otherServers = computed(() => draft.servers.filter((s) => !(s.envTags.length === 0 || s.envTags.includes(activeEnv.value))));

/** 零台勾选自动置未勾选（项 13）；有勾选时回填 serverKey 与首个识别路径（immediate：进入环境即自动带出，不等变化） */
watch(wpfSrv, (v) => {
  const wpf = cfg.value?.services.find((s) => s.name === 'wpfClient');
  if (wpf && !v) wpf.enabled = false;
  if (wpf && v && wpf.targets[0]?.serverKey === '') {
    wpf.targets[0].serverKey = `${v.ip}:${v.port}`;
    if (!wpf.targets[0].path) {
      const p = ((draft.scanResults[`${v.ip}:${v.port}`] as any)?.wpfClient ?? [])[0];
      if (p) wpf.targets[0].path = p;
    }
  }
}, { immediate: true });

/** 已提交环境以库为准（项 11"以库判定"含会话新增）：configured 挂载预查（tag/默认不勾/可勾选走更新），submitted 会话提交（禁勾/锁定/推进跳过） */
onMounted(async () => {
  if (draft.project.id) {
    for (const env of ENV_LIST) {
      try {
        const r = await appconfigDb.getPublishAppconfigs(draft.project.id!, env);
        if (r.code === 0 && (r.data as any)?.data?.id) configured.value.add(env);
      } catch {}
    }
  }
  if (draft.envs.length > 0) {
    checkedEnvs.value = [...draft.envs];
  } else {
    checkedEnvs.value = [1].filter((e) => !configured.value.has(e));
  }
  syncEnvsToDraft();
  // 恢复/推进落在已提交环境时自动切到首个未提交
  if (submitted.value.has(activeEnv.value) || !checkedEnvs.value.includes(activeEnv.value)) {
    const nxt = nextUnsubmittedEnv();
    if (nxt !== null) emit('switchEnv', nxt);
  }
});

function syncEnvsToDraft() {
  const sorted = [...checkedEnvs.value].sort((a, b) => a - b);
  draft.envs = sorted;
  for (const env of sorted) {
    if (!draft.envConfig[env]) {
      const services = SERVICE_NAMES.map((name) => ({ name, enabled: true, targets: [] as any[] }));
      draft.envConfig[env] = { services } as EnvConfig;
    }
    const wpf = draft.envConfig[env].services.find((s) => s.name === 'wpfClient');
    if (wpf && wpf.targets.length === 0) wpf.targets = [{ serverKey: '', path: '' }];
  }
  for (const k of Object.keys(draft.envConfig).map(Number)) {
    if (!sorted.includes(k)) delete draft.envConfig[k];
  }
}

function onEnvsChange() { syncEnvsToDraft(); }

function onServerChange(trow: any, svc: any) {
  // 迁自 Step5ServiceAssign（多节点自动带入：当前行填首个未占用节点，其余按识别顺序追加）
  const paths = ((draft.scanResults[trow.serverKey] as any)?.[svc.name] ?? []) as string[];
  if (paths.length === 0) return;
  if (!trow.path) {
    const used = new Set(svc.targets.map((x: any) => x.path).filter(Boolean));
    const next = paths.find((p) => p && !used.has(p));
    if (next) trow.path = next;
  }
  const used = new Set(svc.targets.map((x: any) => x.path).filter(Boolean));
  for (const p of paths) {
    if (p && !used.has(p)) svc.targets.push({ serverKey: trow.serverKey, path: p });
  }
}

function onWpfPathChange(val: string) {
  const wpf = cfg.value?.services.find((s) => s.name === 'wpfClient');
  if (!wpf) return;
  if (!wpf.targets[0]) wpf.targets = [{ serverKey: '', path: val }];
  else wpf.targets[0].path = val;
}

/** 反向提醒（项 10）：envTags 非空且不含当前环境，或名称含异环境关键词 */
function mismatchWarnings(): string[] {
  const warns: string[] = [];
  for (const svc of cfg.value?.services ?? []) {
    if (!svc.enabled) continue;
    const keys = svc.name === 'wpfClient' ? (wpfSrv.value ? [`${wpfSrv.value.ip}:${wpfSrv.value.port}`] : []) : svc.targets.map((x: any) => x.serverKey).filter(Boolean);
    for (const key of keys) {
      const srv = draft.servers.find((x) => `${x.ip}:${x.port}` === key);
      if (!srv) continue;
      const n = srv.name.toLowerCase();
      const kw = (activeEnv.value === 3 && /测试|uat/.test(n)) || (activeEnv.value !== 3 && /正式|生产/.test(n));
      if ((srv.envTags.length > 0 && !srv.envTags.includes(activeEnv.value)) || kw) {
        warns.push(t('message.appconfig.wizard.envMismatchWarn', { server: srv.name, env: displayEnv(activeEnv.value) }));
      }
    }
  }
  return warns;
}

async function findExisting(): Promise<RowAppconfigType | null> {
  if (!draft.project.id) return null;
  try {
    const r = await appconfigDb.getPublishAppconfigs(draft.project.id, activeEnv.value);
    if (r.code === 0 && (r.data as any)?.data?.id) return (r.data as any).data as RowAppconfigType;
  } catch {}
  return null;
}

function buildSummaryRows(): { service: string; server: string; path: string }[] {
  const rows: { service: string; server: string; path: string }[] = [];
  for (const svc of cfg.value?.services ?? []) {
    if (!svc.enabled) continue;
    if (svc.name === 'wpfClient') {
      if (wpfSrv.value) rows.push({ service: svc.name, server: wpfSrv.value.name, path: wpfPath.value });
      continue;
    }
    for (const trow of svc.targets) {
      const srv = draft.servers.find((x) => `${x.ip}:${x.port}` === trow.serverKey);
      rows.push({ service: svc.name, server: srv?.name ?? trow.serverKey, path: trow.path });
    }
  }
  return rows;
}

function buildConfigItems(env: number): RowAppconfigType {
  // 迁自 Step6Confirm.buildConfigItems（MsBuild 快照语义不变：insert 分支在 submitEnv 内处理）
  const c = draft.envConfig[env];
  const items: any = { isRebuild: 1, isBackup: 0, isNewVersion: draft.project.isNewVersion, backupBasePath: null };
  for (const name of NORMAL_SERVICES) {
    const svc = c.services.find((s) => s.name === name)!;
    const arr = svc.enabled ? svc.targets.map((trow: any) => {
      const srv = draft.servers.find((x) => `${x.ip}:${x.port}` === trow.serverKey)!;
      return { id: srv.id, name: srv.name, serverPathArr: [{ label: '', value: [{ identity: trow.serverKey, path: trow.path }] }] };
    }) : [];
    items[name] = { clientPath: (draft.project.clientPaths as any)?.[name] ?? '', serverPath: '', serverIds: arr.map((a: any) => a.id), serverArr: arr };
  }
  const wpf = c.services.find((s) => s.name === 'wpfClient')!;
  const wpfTarget = wpf.enabled ? wpf.targets[0] : null;
  const wpfSrv2 = wpfTarget ? draft.servers.find((x) => `${x.ip}:${x.port}` === wpfTarget.serverKey) : null;
  items.wpfClient = {
    clientPath: (draft.project.clientPaths as any)?.wpfClient ?? '',
    serverId: wpfSrv2?.id ?? null,
    serverName: wpfSrv2?.name ?? null,
    serverPath: wpfTarget?.path ?? '',
    isCompress: 1,
    generateDirJson: draft.project.isNewVersion ? '["Plugins"]' : '["Domain","UI"]',
    compressFileJson: '',
  };
  return {
    id: null, projectId: draft.project.id!, projectName: draft.project.name, environment: env,
    msBuildPath: null, dllMode: '全部', dllModeValue: null, buildMode: draft.project.buildMode,
    configItemsJson: JSON.stringify(items), configItems: items,
  } as any;
}

function validateForm(): boolean {
  // 迁自 Step5ServiceAssign.validate
  const c = cfg.value;
  if (!c) { ElMessage.warning(t('message.appconfig.wizard.envCfgMissing')); return false; }
  for (const svc of c.services) {
    if (!svc.enabled) continue;
    if (svc.name === 'wpfClient') continue; // 目标由 resolveWpfServer 提交时解析
    if (svc.targets.length === 0) { ElMessage.warning(t('message.appconfig.wizard.needOneTarget', { name: svc.name })); return false; }
    for (const trow of svc.targets) {
      if (!trow.serverKey || !trow.path?.trim()) { ElMessage.warning(t('message.appconfig.wizard.targetRequired', { name: svc.name })); return false; }
    }
  }
  return true;
}

async function submitEnv(): Promise<boolean> {
  if (submitted.value.has(activeEnv.value)) return false;
  // wpfClient 目标提交时解析（项 13：S2 勾选变化后无需回改）；启用时路径必填（对齐原 S5 校验）
  const wpf = cfg.value?.services.find((s) => s.name === 'wpfClient');
  if (wpf?.enabled) {
    if (!wpfSrv.value) { wpf.enabled = false; }
    else {
      wpf.targets = [{ serverKey: `${wpfSrv.value.ip}:${wpfSrv.value.port}`, path: wpf.targets[0]?.path ?? '' }];
      if (!wpf.targets[0].path?.trim()) {
        ElMessage.warning(t('message.appconfig.wizard.targetRequired', { name: 'wpfClient' }));
        return false;
      }
    }
  }
  if (!validateForm()) return false;
  try {
    // 0) 摘要 + 反向提醒 + 已有配置确认（先于任何写库，取消零副作用）
    const existing = await findExisting();
    const warns = mismatchWarnings();
    const ok = await ElMessageBox.confirm(
      h('div', null, [
        h('ul', { style: 'padding-left:18px;margin:0 0 8px;' }, buildSummaryRows().map((r) => h('li', `${r.service} → ${r.server} : ${r.path}`))),
        ...(warns.length > 0 ? [h('div', { style: 'color:#E6A23C;margin-bottom:8px;' }, warns.join('；'))] : []),
        ...(existing ? [h('div', null, t('message.appconfig.wizard.confirm.dupConfirmMsg'))] : []),
      ]),
      t('message.appconfig.wizard.confirm.dupConfirmTitle'),
      {
        type: existing ? 'warning' : 'info',
        confirmButtonText: existing ? t('message.appconfig.wizard.confirm.dupConfirmOk') : t('message.appconfig.wizard.submitEnv'),
        cancelButtonText: t('message.appconfig.wizard.cancel'),
      }
    ).then(() => true).catch(() => false);
    if (!ok) return false;
    // 1) project（迁自 Step6Confirm，原样）
    let projectId = draft.project.id;
    if (!projectId) {
      const pr = await projectDb.insertProject({ id: null, code: draft.project.code, name: draft.project.name, description: null, isDefault: 0, assemblyOutPath: draft.project.assemblyOutPath ?? null } as any);
      if (pr.code !== 0) throw new Error(pr.msg);
      projectId = pr.data;
      draft.project.id = pr.data;
    }
    // 2) servers（首环境，ip:port 幂等，原样）
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
    // 3) tfs（首环境一次，tfsSaved 守卫，原样迁入）
    if (draft.tfs && !draft.tfsSaved) {
      const name = draft.tfs.tfsName.trim();
      if (!name) throw new Error(t('message.appconfig.wizard.s1tfs.nameNeed'));
      const tr = await tfsDb.getTfsList({ tfsName: null, tfsSourcePath: null, sorting: 'id DESC', skipCount: 0, maxResultCount: 1000 });
      if (tr.code !== 0) throw new Error(tr.msg);
      const all = tr.data?.data ?? [];
      const dup = all.find((x: RowTfsType) => x.tfsServerUrl === draft.tfs!.tfsServerUrl && x.tfsSourcePath === draft.tfs!.tfsSourcePath);
      if (!dup) {
        if (all.some((x: RowTfsType) => x.tfsName === name)) {
          throw new Error(t('message.appconfig.wizard.s1tfs.dupName', { name }));
        }
        const ir = await tfsDb.insertTfs({ id: null, tfsName: name, tfsServerUrl: draft.tfs.tfsServerUrl, tfsSourcePath: draft.tfs.tfsSourcePath, tfsLocalPath: draft.tfs.tfsLocalPath, tfvcPath: draft.tfs.tfvcPath, remark: '配置向导自动识别' } as RowTfsType);
        if (ir.code !== 0) throw new Error(ir.msg);
      }
      draft.tfsSaved = true;
    }
    // 4) appconfig：已有 → 合并更新；没有 → 新增（MsBuild 快照仅 insert 分支）
    const row = buildConfigItems(activeEnv.value);
    row.projectId = draft.project.id!;
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
    } else {
      try {
        const gr = await useSettingsDb().getSettings();
        if (gr.code === 0 && gr.data?.msBuildPath) {
          const v = String(gr.data.msBuildPath).trim();
          if (v) row.msBuildPath = v;
        }
      } catch {}
      const ins = await appconfigDb.insertAppconfig(row as any);
      if (ins.code !== 0) throw new Error(ins.msg);
      saveMode.value = 'insert';
    }
    submitted.value.add(activeEnv.value);
    configured.value.add(activeEnv.value);
    emit('submitted', { env: activeEnv.value, mode: saveMode.value });
    return true;
  } catch (e: any) {
    await ElMessageBox.alert(String(e.message ?? e), t('message.appconfig.wizard.s4.saveFail'));
    return false;
  }
}

/** 步内导航（项 11）：有上一环境 → 切上一环境表单（已提交显示锁定态）并返回 true；否则 false（index 回 S3） */
function handlePrev(): boolean {
  const idx = draft.envs.indexOf(activeEnv.value);
  if (idx > 0) {
    emit('switchEnv', draft.envs[idx - 1]);
    return true;
  }
  return false;
}

function nextUnsubmittedEnv(): number | null {
  return draft.envs.find((e) => !submitted.value.has(e)) ?? null;
}

defineExpose({ submitEnv, handlePrev, nextUnsubmittedEnv });
</script>