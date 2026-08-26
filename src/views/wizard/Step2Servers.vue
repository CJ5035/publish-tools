<template>
  <div>
    <el-alert v-if="importedCount > 0" type="info" :closable="false" show-icon style="margin-bottom:12px;">
      {{ t('message.appconfig.wizard.importedHint', { n: importedCount }) }}
    </el-alert>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <el-button type="primary" @click="onAdd">{{ t('message.appconfig.wizard.s2.add') }}</el-button>
      <el-button @click="onImport">{{ t('message.appconfig.wizard.s2.import') }}</el-button>
      <el-button @click="onTestAll">{{ t('message.appconfig.wizard.testAll') }}</el-button>
    </div>
    <el-table :data="draft.servers" border size="small">
      <el-table-column :label="t('message.appconfig.wizard.s2.name')" width="140">
        <template #default="{ row }"><el-input v-model="row.name" :placeholder="t('message.appconfig.wizard.s2.namePh')" size="small" @change="onNameChange(row)" /></template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.os')" width="120">
        <template #default="{ row }">
          <el-select v-model="row.os" size="small" style="width:100%;">
            <el-option :value="1" label="Windows" /><el-option :value="2" label="Docker" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.ip')" width="150">
        <template #default="{ row }"><el-input v-model="row.ip" :placeholder="t('message.appconfig.wizard.s2.ipPh')" size="small" /></template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.port')" width="90">
        <template #default="{ row }"><el-input-number v-model="row.port" :min="1" :max="65535" size="small" style="width:100%;" /></template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.account')" width="120">
        <template #default="{ row }"><el-input v-model="row.account" :placeholder="t('message.appconfig.wizard.s2.accountPh')" size="small" /></template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.pwd')" width="120">
        <template #default="{ row }"><el-input v-model="row.pwd" type="password" :placeholder="t('message.appconfig.wizard.s2.pwdPh')" size="small" show-password /></template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.envCol')" width="180">
        <template #default="{ row }">
          <el-select v-model="row.envTags" multiple size="small" style="width:100%;" :placeholder="t('message.appconfig.wizard.envCol')">
            <el-option :value="1" label="Dev" /><el-option :value="2" label="Uat" /><el-option :value="3" label="Pro" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.wpfServerCol')" width="70">
        <template #default="{ row }">
          <el-checkbox v-model="row.isWpfServer" />
        </template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.scanRoot')">
        <template #default="{ row }"><el-input v-model="row.scanRoot" :placeholder="t('message.appconfig.wizard.s2.scanRootPh')" size="small" /></template>
      </el-table-column>
      <el-table-column :label="t('message.appconfig.wizard.s2.op')" width="220" class-name="op-col">
        <template #default="{ row, $index }">
          <el-button size="small" @click="onCopyRow(row)">{{ t('message.appconfig.wizard.copyRow') }}</el-button>
          <el-button size="small"
            :loading="testStatus[`${row.ip}:${row.port}`] === 'testing'"
            :type="testStatus[`${row.ip}:${row.port}`] === 'ok' ? 'success' : testStatus[`${row.ip}:${row.port}`] === 'fail' ? 'danger' : undefined"
            @click="onTest(row)">{{ testBtnLabel(row) }}</el-button>
          <el-button size="small" type="danger" @click="onRemove($index)">{{ t('message.appconfig.wizard.s2.del') }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="importVisible" :title="t('message.appconfig.wizard.s2.importTitle')" width="600px" append-to-body>
      <el-table :data="importList" @selection-change="onSelChange">
        <el-table-column type="selection" width="40" />
        <el-table-column prop="name" :label="t('message.appconfig.wizard.s2.name')" />
        <el-table-column prop="ip" :label="t('message.appconfig.wizard.s2.ip')" />
        <el-table-column prop="projectName" :label="t('message.appconfig.wizard.s2.colProject')" />
        <el-table-column prop="port" :label="t('message.appconfig.wizard.s2.port')" width="80" />
      </el-table>
      <template #footer>
        <el-button @click="importVisible=false">{{ t('message.appconfig.wizard.cancel') }}</el-button>
        <el-button type="primary" @click="onConfirmImport">{{ t('message.appconfig.wizard.s2.confirm') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { ref, inject, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { cmdInvoke } from '@/utils/command';
import { useServerDb } from '@/database/servers';
import { useAppconfigDb } from '@/database/appconfig';
import type { WizardDraft, WizardServer } from './wizardTypes';
import { deriveServerEnvTags } from './wizardTypes';

const { t } = useI18n();

const draft = inject<WizardDraft>('wizardDraft')!;
const serverDb = useServerDb();

const importedCount = ref(0);

const testStatus = ref<Record<string, 'ok' | 'fail' | 'testing'>>({});

function onNameChange(row: WizardServer) {
  if (!row.envTags || row.envTags.length === 0) row.envTags = deriveServerEnvTags(row.name ?? '');
}

/** 复制该行为新行：保留账密/端口/系统/扫描根/环境标签/isWpfServer，清空名称/IP（项 15） */
function onCopyRow(row: WizardServer) {
  const { id, name, ip, ...rest } = row;
  draft.servers.push({ ...rest, envTags: [...(rest.envTags ?? [])], name: '', ip: '', isNew: true });
}

/** 批量测试连接（项 15）：并发上限 4，结果落行内 tag */
async function onTestAll() {
  const queue = draft.servers.filter((s) => s.ip && s.port && s.account);
  const workers = Array.from({ length: Math.min(4, queue.length) }, () => (async () => {
    while (queue.length > 0) {
      const s = queue.shift()!;
      await testOne(s);
    }
  })());
  await Promise.all(workers);
}

async function testOne(row: WizardServer) {
  const key = `${row.ip}:${row.port}`;
  testStatus.value[key] = 'testing';
  try {
    const r = await cmdInvoke('server_connection', { username: row.account, password: row.pwd, server: key });
    testStatus.value[key] = r.code === 0 ? 'ok' : 'fail';
  } catch {
    testStatus.value[key] = 'fail';
  }
}

/** 测试按钮文案：有结果时按钮本身兼作状态展示（替代原行内 tag，避免窄操作列内换行） */
function testBtnLabel(row: WizardServer): string {
  const s = testStatus.value[`${row.ip}:${row.port}`];
  if (s === 'ok') return t('message.appconfig.wizard.testOk');
  if (s === 'fail') return t('message.appconfig.wizard.testFail');
  if (s === 'testing') return t('message.appconfig.wizard.testTesting');
  return t('message.appconfig.wizard.s2.test');
}

onMounted(async () => {
  if (!draft.project.id || draft.servers.length > 0) return;
  try {
    const r = await serverDb.getServerList({ projectId: draft.project.id, name: null, sorting: 'ts.id DESC', skipCount: 0, maxResultCount: 1000 } as any);
    const rows = ((r.data as any)?.data ?? []) as RowServerType[];
    // 续配回勾：项目已有配置的 wpfClient.serverId 集合 → 命中服务器自动勾选 wpfClient
    const wpfServerIds = new Set<number>();
    if (rows.length > 0) {
      const appconfigDb = useAppconfigDb();
      for (const env of [1, 2, 3, 4]) {
        try {
          const cr = await appconfigDb.getPublishAppconfigs(draft.project.id!, env);
          const row = (cr.data as any)?.data;
          if (row?.id && row.configItemsJson) {
            const wpfId = (JSON.parse(row.configItemsJson) as any)?.wpfClient?.serverId;
            if (typeof wpfId === 'number') wpfServerIds.add(wpfId);
          }
        } catch {}
      }
    }
    for (const s of rows) {
      const key = `${s.ip}:${s.port}`;
      if (draft.servers.some((x) => `${x.ip}:${x.port}` === key)) continue;
      // 环境标签以库中持久化的为准（向导提交时落库），无库值才按名称推导
      draft.servers.push({ id: s.id!, name: s.name, os: s.os, ip: s.ip, port: s.port, account: s.account ?? '', pwd: s.pwd ?? '', scanRoot: '', isNew: false, envTags: (s.envTags?.length ?? 0) > 0 ? [...s.envTags!] : deriveServerEnvTags(s.name), isWpfServer: wpfServerIds.has(s.id!) });
    }
    importedCount.value = draft.servers.length;
  } catch (e) {
    console.warn('自动带入服务器失败', e);
  }
});

const importVisible = ref(false);
const importList = ref<RowServerType[]>([]);
const importSelected = ref<RowServerType[]>([]);

function onAdd(){
  draft.servers.push({ name:'', os:1, ip:'', port:22, account:'', pwd:'', scanRoot:'', isNew:true, envTags: [], isWpfServer: false });
}
function onRemove(idx:number){
  draft.servers.splice(idx,1);
}
async function onTest(row:WizardServer){
  if(!row.ip || !row.port || !row.account){ ElMessage.warning(t('message.appconfig.wizard.s2.testNeed')); return; }
  await testOne(row);
  if(testStatus.value[`${row.ip}:${row.port}`]==='ok') ElMessage.success(t('message.appconfig.wizard.s2.connOk'));
  else ElMessageBox.alert(t('message.appconfig.wizard.s2.connFail'));
}
async function onImport(){
  const r = await serverDb.getServerList({ projectId:null, name:null, sorting:'ts.id DESC', skipCount:0, maxResultCount:1000 } as any);
  importList.value = (r.data?.data ?? []) as any;
  importVisible.value = true;
}
function onSelChange(vals:RowServerType[]){ importSelected.value = vals; }
function onConfirmImport(){
  for(const s of importSelected.value){
    const key = `${s.ip}:${s.port}`;
    if(draft.servers.some(x=>`${x.ip}:${x.port}`===key)) continue;
    // 环境标签以库中持久化的为准（向导提交时落库），无库值才按名称推导
    draft.servers.push({ id:s.id!, name:s.name, os:s.os, ip:s.ip, port:s.port, account:s.account??'', pwd:s.pwd??'', scanRoot:'', isNew:false, envTags: (s.envTags?.length ?? 0) > 0 ? [...s.envTags!] : deriveServerEnvTags(s.name), isWpfServer: false });
  }
  importVisible.value=false;
}

async function validate(): Promise<boolean>{
  if(draft.servers.length===0){ ElMessage.warning(t('message.appconfig.wizard.s2.atLeast1')); return false; }
  for(const r of draft.servers){
    if(!r.name?.trim()||!r.ip?.trim()||!r.port||!r.account?.trim()||!r.pwd?.trim()){
      ElMessage.warning(t('message.appconfig.wizard.s2.incomplete', { name: r.name || r.ip || t('message.appconfig.wizard.s2.unnamed') }));
      return false;
    }
  }
  // 池内去重
  const keys = draft.servers.map(s=>`${s.ip}:${s.port}`);
  if(new Set(keys).size!==keys.length){ ElMessage.warning(t('message.appconfig.wizard.s2.dupKey')); return false; }
  const names = draft.servers.map(s=>s.name);
  if(new Set(names).size!==names.length){ ElMessage.warning(t('message.appconfig.wizard.s2.dupName')); return false; }
  // 全局 name 冲突预检
  const needCheck = draft.servers.filter(s=>s.isNew);
  if(needCheck.length>0){
    const all = await serverDb.getServerList({ projectId:null, name:null, sorting:'ts.id DESC', skipCount:0, maxResultCount:1000 } as any);
    const existingNames = new Set((all.data?.data ?? []).map((x:RowServerType)=>x.name));
    for(const s of needCheck){
      if(existingNames.has(s.name)){ ElMessage.warning(t('message.appconfig.wizard.s2.nameExists', { name: s.name })); return false; }
    }
  }
  return true;
}
defineExpose({ validate });
</script>

<style scoped lang="scss">
// 操作列 220px：Element 默认按钮间距 12px 时三按钮放不下会换行，压缩为 6px
.el-table :deep(.op-col .el-button + .el-button) {
  margin-left: 6px;
}
</style>
