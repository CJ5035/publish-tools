<template>
  <div>
    <el-alert v-if="importedCount > 0" type="info" :closable="false" show-icon style="margin-bottom:12px;">
      {{ t('message.appconfig.wizard.importedHint', { n: importedCount }) }}
    </el-alert>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <el-button type="primary" @click="onAdd">添加服务器</el-button>
      <el-button @click="onImport">从已有导入</el-button>
    </div>
    <el-table :data="draft.servers" border size="small">
      <el-table-column label="名称" width="140">
        <template #default="{ row }"><el-input v-model="row.name" placeholder="名称" size="small" /></template>
      </el-table-column>
      <el-table-column label="系统" width="120">
        <template #default="{ row }">
          <el-select v-model="row.os" size="small" style="width:100%;">
            <el-option :value="1" label="Windows" /><el-option :value="2" label="Docker" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="IP" width="150">
        <template #default="{ row }"><el-input v-model="row.ip" placeholder="IP" size="small" /></template>
      </el-table-column>
      <el-table-column label="端口" width="90">
        <template #default="{ row }"><el-input-number v-model="row.port" :min="1" :max="65535" size="small" style="width:100%;" /></template>
      </el-table-column>
      <el-table-column label="账号" width="120">
        <template #default="{ row }"><el-input v-model="row.account" placeholder="账号" size="small" /></template>
      </el-table-column>
      <el-table-column label="密码" width="120">
        <template #default="{ row }"><el-input v-model="row.pwd" type="password" placeholder="密码" size="small" show-password /></template>
      </el-table-column>
      <el-table-column label="扫描根路径">
        <template #default="{ row }"><el-input v-model="row.scanRoot" placeholder="可选：服务枚举失败时兜底目录扫描用" size="small" /></template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row, $index }">
          <el-button size="small" @click="onTest(row)">测试连接</el-button>
          <el-button size="small" type="danger" @click="onRemove($index)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="importVisible" title="从已有导入" width="600px" append-to-body>
      <el-table :data="importList" @selection-change="onSelChange">
        <el-table-column type="selection" width="40" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="ip" label="IP" />
        <el-table-column prop="projectName" label="所属项目" />
        <el-table-column prop="port" label="端口" width="80" />
      </el-table>
      <template #footer>
        <el-button @click="importVisible=false">取消</el-button>
        <el-button type="primary" @click="onConfirmImport">确定</el-button>
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
import type { WizardDraft, WizardServer } from './wizardTypes';

const { t } = useI18n();

const draft = inject<WizardDraft>('wizardDraft')!;
const serverDb = useServerDb();

const importedCount = ref(0);

/** 项 6 续配：S1 选了已有项目且池为空时，自动带入该项目全部服务器（isNew:false 保留原 id，
 *  落库语义不变）；二期不含 isWpfServer 回勾（三期）。 */
onMounted(async () => {
  if (!draft.project.id || draft.servers.length > 0) return;
  try {
    const r = await serverDb.getServerList({ projectId: draft.project.id, name: null, sorting: 'ts.id DESC', skipCount: 0, maxResultCount: 1000 } as any);
    const rows = ((r.data as any)?.data ?? []) as RowServerType[];
    for (const s of rows) {
      const key = `${s.ip}:${s.port}`;
      if (draft.servers.some((x) => `${x.ip}:${x.port}` === key)) continue;
      draft.servers.push({ id: s.id!, name: s.name, os: s.os, ip: s.ip, port: s.port, account: s.account ?? '', pwd: s.pwd ?? '', scanRoot: '', isNew: false });
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
  draft.servers.push({ name:'', os:1, ip:'', port:22, account:'', pwd:'', scanRoot:'', isNew:true });
}
function onRemove(idx:number){
  draft.servers.splice(idx,1);
}
async function onTest(row:WizardServer){
  if(!row.ip || !row.port || !row.account){ ElMessage.warning('请先填写 IP/端口/账号'); return; }
  const r = await cmdInvoke('server_connection', { username: row.account, password: row.pwd, server: `${row.ip}:${row.port}` });
  if(r.code===0) ElMessage.success('连接成功');
  else ElMessageBox.alert(String(r.data ?? r.msg), '连接失败');
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
    draft.servers.push({ id:s.id!, name:s.name, os:s.os, ip:s.ip, port:s.port, account:s.account??'', pwd:s.pwd??'', scanRoot:'', isNew:false });
  }
  importVisible.value=false;
}

async function validate(): Promise<boolean>{
  if(draft.servers.length===0){ ElMessage.warning('至少需要 1 台服务器'); return false; }
  for(const r of draft.servers){
    if(!r.name?.trim()||!r.ip?.trim()||!r.port||!r.account?.trim()||!r.pwd?.trim()){
      ElMessage.warning(`服务器 [${r.name||r.ip||'未命名'}] 信息不完整`);
      return false;
    }
  }
  // 池内去重
  const keys = draft.servers.map(s=>`${s.ip}:${s.port}`);
  if(new Set(keys).size!==keys.length){ ElMessage.warning('服务器 ip:port 不能重复'); return false; }
  const names = draft.servers.map(s=>s.name);
  if(new Set(names).size!==names.length){ ElMessage.warning('服务器名称不能重复'); return false; }
  // 全局 name 冲突预检
  const needCheck = draft.servers.filter(s=>s.isNew);
  if(needCheck.length>0){
    const all = await serverDb.getServerList({ projectId:null, name:null, sorting:'ts.id DESC', skipCount:0, maxResultCount:1000 } as any);
    const existingNames = new Set((all.data?.data ?? []).map((x:RowServerType)=>x.name));
    for(const s of needCheck){
      if(existingNames.has(s.name)){ ElMessage.warning(`服务器名称 [${s.name}] 已存在，请改名`); return false; }
    }
  }
  return true;
}
defineExpose({ validate });
</script>
