<template>
  <div>
    <el-radio-group v-model="projectMode" style="margin-bottom:16px;">
      <el-radio-button value="existing">选择已有项目</el-radio-button>
      <el-radio-button value="new">新建项目</el-radio-button>
    </el-radio-group>

    <!-- 已有项目 -->
    <template v-if="projectMode==='existing'">
      <el-select v-model="selectedProjectId" filterable placeholder="请选择项目" style="width:100%;" @change="onExistingProjectChange">
        <el-option v-for="p in projectList" :key="p.id" :label="`${p.name} (${p.code})`" :value="p.id!" />
      </el-select>
    </template>

    <!-- 新建项目 -->
    <template v-else>
      <el-form :model="draft.project" label-width="110px" style="margin-top:12px;">
        <el-form-item label="项目名称"><el-input v-model="draft.project.name" placeholder="请输入项目名称" maxlength="100" clearable /></el-form-item>
        <el-form-item label="项目编码"><el-input v-model="draft.project.code" placeholder="请输入项目编码" maxlength="100" clearable /></el-form-item>
        <el-form-item label="Assembly输出"><el-input v-model="draft.project.assemblyOutPath" placeholder="留空使用默认路径" clearable /></el-form-item>
      </el-form>
    </template>

    <el-divider />

    <el-form label-width="110px">
      <el-form-item label="SLN 路径">
        <div style="display:flex;gap:8px;width:100%;">
          <el-input v-model="draft.project.slnPath" placeholder="请选择 .sln 文件" readonly style="flex:1;" />
          <el-button type="primary" @click="onSelectSln">选择</el-button>
        </div>
      </el-form-item>
      <el-form-item label="版本">
        <el-checkbox v-model="draft.project.isNewVersion" label="10.2+ 版本" />
      </el-form-item>
      <el-form-item label="构建模式">
        <el-radio-group v-model="draft.project.buildMode">
          <el-radio value="Debug">Debug</el-radio>
          <el-radio value="Release">Release</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <el-divider v-if="Object.keys(draft.project.clientPaths).length>0" />
    <div v-if="Object.keys(draft.project.clientPaths).length>0">
      <h4>SLN 解析结果</h4>
      <el-table :data="clientPathRows" border size="small">
        <el-table-column prop="service" label="服务" width="160" />
        <el-table-column prop="path" label="ClientPath">
          <template #default="{ row }">
            <span v-if="row.path">{{ row.path }}</span>
            <span v-else style="color:#999;">未找到，可稍后在编辑中补</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { open } from '@tauri-apps/plugin-dialog';
import { cmdInvoke } from '@/utils/command';
import { useProjectDb } from '@/database/project';
import { removeSlash } from '@/utils/other';
import type { WizardDraft, ServiceName } from './wizardTypes';

const draft = inject<WizardDraft>('wizardDraft')!;
const projectDb = useProjectDb();

const projectMode = ref<'existing' | 'new'>('existing');
const selectedProjectId = ref<number | null>(null);
const projectList = ref<RowProjectType[]>([]);

const clientPathRows = computed(() => {
  const map: Record<string,string> = { webApiHost:'WebApiHost', webClient:'WebClient', scheduleServer:'ScheduleServer', spcMonitor:'SpcMonitor', wpfClient:'WpfClient' };
  return Object.entries(map).map(([k,label]) => ({ service: label, path: (draft.project.clientPaths as any)[k] || '' }));
});

async function loadProjects() {
  const r = await projectDb.getProjectList({ code:null, name:null, sorting:'id DESC', skipCount:0, maxResultCount:1000 } as any);
  projectList.value = r.data?.data ?? [];
}
onMounted(loadProjects);

function onExistingProjectChange(val:number){
  const p = projectList.value.find(x=>x.id===val);
  if(!p) return;
  draft.project.id = p.id ?? undefined;
  draft.project.name = p.name ?? '';
  draft.project.code = p.code ?? '';
  draft.project.assemblyOutPath = (p as any).assemblyOutPath ?? '';
}

async function onSelectSln(){
  const sel = await open({ multiple:false, filters:[{ name:'解决方案文件', extensions:['sln'] }] });
  if(!sel) return;
  draft.project.slnPath = removeSlash(String(sel));
}

async function validate(): Promise<boolean> {
  if(projectMode.value==='existing'){
    if(!selectedProjectId.value){
      ElMessage.warning('请选择已有项目');
      return false;
    }
    const p = projectList.value.find(x=>x.id===selectedProjectId.value);
    if(p){
      draft.project.id = p.id ?? undefined;
      draft.project.name = p.name ?? '';
      draft.project.code = p.code ?? '';
      draft.project.assemblyOutPath = (p as any).assemblyOutPath ?? '';
    }
  } else {
    if(!draft.project.name?.trim()){ ElMessage.warning('请输入项目名称'); return false; }
    if(!draft.project.code?.trim()){ ElMessage.warning('请输入项目编码'); return false; }
    draft.project.id = undefined;
  }
  if(!draft.project.slnPath?.trim()){
    ElMessage.warning('请选择 SLN 文件');
    return false;
  }
  // exists 校验：必须同时 code===0 && data===true
  const ex = await cmdInvoke('exists', { path: draft.project.slnPath });
  if(ex.code!==0 || ex.data!==true){
    ElMessage.warning('SLN 文件不存在，请重新选择');
    return false;
  }
  // SLN 解析
  const modules: Array<[string, ServiceName]> = [
    ['SIE.WebApiHost.csproj', 'webApiHost'],
    ['SIE.ScheduleServer.csproj', 'scheduleServer'],
    ['WebClient.csproj', 'webClient'],
    ['WpfClient.csproj', 'wpfClient'],
    ['SIE.SpcMonitor.csproj', 'spcMonitor'],
  ];
  for(const [moduleName, svc] of modules){
    try{
      const r = await cmdInvoke('parse_sln_project', { moduleName, slnFilePath: draft.project.slnPath, isNewVersion: draft.project.isNewVersion, buildMode: draft.project.buildMode });
      if(r.code===0 && r.data){
        (draft.project.clientPaths as any)[svc] = r.data;
      }
    } catch(e){
      console.warn('parse_sln_project fail', moduleName, e);
    }
  }
  return true;
}
defineExpose({ validate });
</script>
