<template>
  <div>
    <el-radio-group v-model="projectMode" style="margin-bottom:16px;">
      <el-radio-button value="existing">{{ t('message.appconfig.wizard.s1.existing') }}</el-radio-button>
      <el-radio-button value="new">{{ t('message.appconfig.wizard.s1.new') }}</el-radio-button>
    </el-radio-group>

    <!-- 已有项目 -->
    <template v-if="projectMode==='existing'">
      <el-select v-model="selectedProjectId" filterable :placeholder="t('message.appconfig.wizard.s1.pickProject')" style="width:100%;" @change="onExistingProjectChange">
        <el-option v-for="p in projectList" :key="p.id" :label="`${p.name} (${p.code})`" :value="p.id!" />
      </el-select>
    </template>

    <!-- 新建项目 -->
    <template v-else>
      <el-form :model="draft.project" label-width="110px" style="margin-top:12px;">
        <el-form-item :label="t('message.appconfig.wizard.s1.name')"><el-input v-model="draft.project.name" :placeholder="t('message.appconfig.wizard.s1.namePh')" maxlength="100" clearable /></el-form-item>
        <el-form-item :label="t('message.appconfig.wizard.s1.code')"><el-input v-model="draft.project.code" :placeholder="t('message.appconfig.wizard.s1.codePh')" maxlength="100" clearable /></el-form-item>
        <el-form-item :label="t('message.appconfig.wizard.s1.assemblyOutPath')"><el-input v-model="draft.project.assemblyOutPath" :placeholder="t('message.appconfig.wizard.s1.assemblyPh')" clearable /></el-form-item>
      </el-form>
    </template>

    <el-divider />

    <el-form label-width="110px">
      <el-form-item :label="t('message.appconfig.wizard.s1.slnPath')">
        <div style="display:flex;gap:8px;width:100%;">
          <el-input v-model="draft.project.slnPath" :placeholder="t('message.appconfig.wizard.s1.slnPh')" readonly style="flex:1;" />
          <el-button type="primary" @click="onSelectSln" :loading="slnParsing">{{ t('message.appconfig.wizard.s1.select') }}</el-button>
        </div>
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="draft.project.isNewVersion" :label="t('message.appconfig.wizard.s1.isNewVersion')" />
      </el-form-item>
      <el-form-item :label="t('message.appconfig.wizard.s1.buildMode')">
        <el-radio-group v-model="draft.project.buildMode">
          <el-radio value="Debug">Debug</el-radio>
          <el-radio value="Release">Release</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <el-divider v-if="Object.keys(draft.project.clientPaths).length>0" />
    <div v-if="Object.keys(draft.project.clientPaths).length>0">
      <h4>{{ t('message.appconfig.wizard.s1.parseTitle') }} <el-tag v-if="slnParsing" size="small">{{ t('message.appconfig.wizard.s1.parsing') }}</el-tag></h4>
      <el-table :data="clientPathRows" border size="small">
        <el-table-column prop="service" :label="t('message.appconfig.wizard.s1.colService')" width="160" />
        <el-table-column prop="path" :label="t('message.appconfig.wizard.s1.clientPath')">
          <template #default="{ row }">
            <span v-if="row.path">{{ row.path }}</span>
            <span v-else style="color:#999;">{{ t('message.appconfig.wizard.s1.notFound') }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <el-divider v-if="draft.tfs || tfsDetectFailed" />
    <div v-if="draft.tfs || tfsDetectFailed">
      <h4>{{ t('message.appconfig.wizard.s1tfs.title') }} <el-tag v-if="tfsDetecting" size="small">{{ t('message.appconfig.wizard.s1tfs.detecting') }}</el-tag></h4>
      <template v-if="draft.tfs">
        <el-table :data="tfsRows" border size="small">
          <el-table-column prop="label" :label="t('message.appconfig.wizard.s1tfs.colItem')" width="160">
            <template #default="{ row }">
              <span v-if="row.key === 'tfsName'" style="color: var(--el-color-danger); margin-right: 4px;">*</span>{{ row.label }}
            </template>
          </el-table-column>
          <el-table-column prop="value" :label="t('message.appconfig.wizard.s1tfs.colValue')">
            <template #default="{ row }">
              <el-input v-if="row.key === 'tfsName'" v-model="draft.tfs.tfsName" maxlength="50" clearable
                :placeholder="t('message.appconfig.wizard.s1tfs.namePh')" size="small" style="max-width: 360px;" />
              <span v-else>{{ row.value }}</span>
            </template>
          </el-table-column>
        </el-table>
        <el-text type="info" size="small">{{ t('message.appconfig.wizard.s1tfs.saveHint') }}</el-text>
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
import { useI18n } from 'vue-i18n';
import type { WizardDraft, ServiceName } from './wizardTypes';
import { detectTfsForSln } from '@/utils/tfsDetect';

const { t } = useI18n();
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

// TFS 识别结果表格行；名称行在模板里渲染为可编辑输入框，其余只读
const tfsRows = computed(() => {
  if (!draft.tfs) return [];
  const w = 'message.appconfig.wizard.s1tfs.';
  return [
    { key: 'tfsName', label: t(w + 'name'), value: draft.tfs.tfsName },
    { key: 'tfsServerUrl', label: t(w + 'serverUrl'), value: draft.tfs.tfsServerUrl },
    { key: 'tfsSourcePath', label: t(w + 'sourcePath'), value: draft.tfs.tfsSourcePath },
    { key: 'tfsLocalPath', label: t(w + 'localPath'), value: draft.tfs.tfsLocalPath },
    { key: 'tfvcPath', label: t(w + 'tfvc'), value: draft.tfs.tfvcPath },
    { key: 'workspaceName', label: t(w + 'workspace'), value: draft.tfs.workspaceName },
  ];
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
    else tfsDetectFailed.value = t('message.appconfig.wizard.s1tfs.detectFail');
  } finally {
    tfsDetecting.value = false;
  }
}

async function validate(): Promise<boolean> {
  if(projectMode.value==='existing'){
    if(!selectedProjectId.value){
      ElMessage.warning(t('message.appconfig.wizard.s1.pickExisting'));
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
    if(!draft.project.name?.trim()){ ElMessage.warning(t('message.appconfig.wizard.s1.nameNeed')); return false; }
    if(!draft.project.code?.trim()){ ElMessage.warning(t('message.appconfig.wizard.s1.codeNeed')); return false; }
    draft.project.id = undefined;
  }
  if(!draft.project.slnPath?.trim()){
    ElMessage.warning(t('message.appconfig.wizard.s1.slnMissing'));
    return false;
  }
  // exists 校验：必须同时 code===0 && data===true
  const ex = await cmdInvoke('exists', { path: draft.project.slnPath });
  if(ex.code!==0 || ex.data!==true){
    ElMessage.warning(t('message.appconfig.wizard.s1.slnMissing'));
    return false;
  }
  if(draft.project.slnPath !== lastParsedPath.value) await parseSlnNow();
  return true;
}
defineExpose({ validate });
</script>
