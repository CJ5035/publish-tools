<template>
  <div>
    <h3>环境选择</h3>
    <el-checkbox-group v-model="checked">
      <el-checkbox :value="1" label="Dev" />
      <el-checkbox :value="2" label="Uat" />
      <el-checkbox :value="3" label="Pro" />
      <el-checkbox :value="4" label="Other" />
    </el-checkbox-group>
  </div>
</template>
<script setup lang="ts">
import { ref, inject, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { WizardDraft, EnvConfig } from './wizardTypes';
import { SERVICE_NAMES } from './wizardTypes';
const draft = inject<WizardDraft>('wizardDraft')!;
const checked = ref<number[]>([1]);
onMounted(()=>{ if(draft.envs.length>0) checked.value=[...draft.envs]; });
async function validate(): Promise<boolean>{
  if(checked.value.length===0){ ElMessage.warning('至少选择 1 个环境'); return false; }
  const sorted = [...checked.value].sort((a,b)=>a-b);
  draft.envs = sorted;
  for(const env of sorted){
    if(!draft.envConfig[env]){
      const services = SERVICE_NAMES.map(name=>({ name, enabled:true, targets:[] as any[] }));
      draft.envConfig[env] = { services } as EnvConfig;
    }
  }
  // remove deselected
  for(const k of Object.keys(draft.envConfig).map(Number)){
    if(!sorted.includes(k)) delete draft.envConfig[k];
  }
  return true;
}
defineExpose({ validate });
</script>
