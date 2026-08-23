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
          <el-button type="primary" @click="onSelectSln" :loading="slnParsing">选择</el-button>
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
      <h4>SLN 解析结果 <el-tag v-if="slnParsing" size="small">解析中…</el-tag></h4>
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
    <el-divider v-if="draft.tfs || tfsDetectFailed" />
    <div v-if="draft.tfs || tfsDetectFailed">
      <h4>TFS 识别结果 <el-tag v-if="tfsDetecting" size="small">识别中…</el-tag></h4>
      <template v-if="draft.tfs">
        <el-form label-width="110px">
          <el-form-item label="TFS名称" required>
            <el-input v-model="draft.tfs.tfsName" maxlength="50" clearable placeholder="默认取源位置尾段，可改为客户名（如：新容）" style="max-width:360px;" />
          </el-form-item>
        </el-form>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="服务地址">{{ draft.tfs.tfsServerUrl }}</el-descriptions-item>
          <el-descriptions-item label="源位置">{{ draft.tfs.tfsSourcePath }}</el-descriptions-item>
          <el-descriptions-item label="本地根目录">{{ draft.tfs.tfsLocalPath }}</el-descriptions-item>
          <el-descriptions-item label="TFVC工具">{{ draft.tfs.tfvcPath }}</el-descriptions-item>
          <el-descriptions-item label="工作区">{{ draft.tfs.workspaceName }}</el-descriptions-item>
        </el-descriptions>
        <el-text type="info" size="small">提交时自动保存到 TFS 配置（已存在相同 服务地址+源位置 的记录则复用）</el-text>
      </template>
      <div v-else style="color:#E6A23C;">{{ tfsDetectFailed }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { open } from '@tauri-apps/plugin-dialog';
import { cmdInvoke } from '@/utils/command';
import { useProjectDb } from '@/database/project';
import { removeSlash } from '@/utils/other';
import type { WizardDraft, ServiceName } from './wizardTypes';
import { detectTfsForSln } from '@/utils/tfsDetect';

const draft = inject<WizardDraft>('wizardDraft')!;
const projectDb = useProjectDb();
const tfsDetectFailed = ref('');
const tfsDetecting = ref(false);

const projectMode = computed<'existing' | 'new'>({
  get: () => draft.s1Mode.projectMode,
  set: (v) => { draft.s1Mode.projectMode = v; },
});
const selectedProjectId = computed<number | null>({
  get: () => draft.s1Mode.selectedProjectId,
  set: (v) => { draft.s1Mode.selectedProjectId = v; },
});
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

const slnParsing = ref(false);
const lastParsedPath = ref('');
const PARSE_MODULES: Array<[string, ServiceName]> = [
  ['SIE.WebApiHost.csproj', 'webApiHost'],
  ['SIE.ScheduleServer.csproj', 'scheduleServer'],
  ['WebClient.csproj', 'webClient'],
  ['WpfClient.csproj', 'wpfClient'],
  ['SIE.SpcMonitor.csproj', 'spcMonitor'],
];

async function onSelectSln(){
  const sel = await open({ multiple:false, filters:[{ name:'解决方案文件', extensions:['sln'] }] });
  if(!sel) return;
  draft.project.slnPath = removeSlash(String(sel));
  // 项 12：即选即解析与 TFS 探测并行，互不阻塞
  await Promise.all([parseSlnNow(), detectTfs()]);
}

async function parseSlnNow(){
  slnParsing.value = true;
  try {
    await Promise.all(PARSE_MODULES.map(async ([moduleName, svc]) => {
      try {
        const r = await cmdInvoke('parse_sln_project', { moduleName, slnFilePath: draft.project.slnPath, isNewVersion: draft.project.isNewVersion, buildMode: draft.project.buildMode });
        if(r.code===0 && r.data) (draft.project.clientPaths as any)[svc] = r.data;
        else delete (draft.project.clientPaths as any)[svc];
      } catch(e) { console.warn('parse_sln_project fail', moduleName, e); delete (draft.project.clientPaths as any)[svc]; }
    }));
    lastParsedPath.value = draft.project.slnPath;
  } finally { slnParsing.value = false; }
}

// isNewVersion/buildMode 是解析参数：切换后既有结果陈旧，立即重解析（项 12 失效条件）
watch([() => draft.project.isNewVersion, () => draft.project.buildMode], () => {
  if(draft.project.slnPath && draft.project.slnPath === lastParsedPath.value) parseSlnNow();
});

/** SLN 的 TFS 工作区自动识别（共享工具）：失败仅提示不阻塞向导 */
async function detectTfs(){
  draft.tfs = null;
  tfsDetectFailed.value = '';
  if(!draft.project.slnPath) return;
  tfsDetecting.value = true;
  try {
    const info = await detectTfsForSln(draft.project.slnPath);
    if(info) draft.tfs = info;
    else tfsDetectFailed.value = '未识别到 TFS 工作区（可忽略，稍后在 TFS 管理页手动录入）';
  } finally {
    tfsDetecting.value = false;
  }
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
  if(draft.project.slnPath !== lastParsedPath.value) await parseSlnNow();
  return true;
}
defineExpose({ validate });
</script>
