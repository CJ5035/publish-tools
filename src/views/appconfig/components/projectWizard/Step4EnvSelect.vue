<template>
  <div>
    <h3>环境选择</h3>
    <el-checkbox-group v-model="checked">
      <el-checkbox :value="1">Dev <el-tag v-if="configured[1]" size="small" type="info" style="margin-left:4px;">{{ t('message.appconfig.wizard.envConfigured') }}</el-tag></el-checkbox>
      <el-checkbox :value="2">Uat <el-tag v-if="configured[2]" size="small" type="info" style="margin-left:4px;">{{ t('message.appconfig.wizard.envConfigured') }}</el-tag></el-checkbox>
      <el-checkbox :value="3">Pro <el-tag v-if="configured[3]" size="small" type="info" style="margin-left:4px;">{{ t('message.appconfig.wizard.envConfigured') }}</el-tag></el-checkbox>
      <el-checkbox :value="4">Other <el-tag v-if="configured[4]" size="small" type="info" style="margin-left:4px;">{{ t('message.appconfig.wizard.envConfigured') }}</el-tag></el-checkbox>
    </el-checkbox-group>
  </div>
</template>
<script setup lang="ts">
import { ref, inject, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppconfigDb } from '@/database/appconfig';
import type { WizardDraft, EnvConfig } from './wizardTypes';
import { SERVICE_NAMES } from './wizardTypes';

const { t } = useI18n();
const appconfigDb = useAppconfigDb();
const configured = ref<Record<number, boolean>>({});

const draft = inject<WizardDraft>('wizardDraft')!;
const checked = ref<number[]>([1]);

/** 项 7 查重前移：仅已有项目预查（新建项目不可能有配置）；
 *  tag 仅提示，仍允许手动勾选——提交时走 20260824 的合并更新确认。 */
onMounted(async () => {
  if (draft.envs.length > 0) { checked.value = [...draft.envs]; return; }
  if (draft.project.id) {
    for (const env of [1, 2, 3, 4]) {
      try {
        const r = await appconfigDb.getPublishAppconfigs(draft.project.id!, env);
        if (r.code === 0 && (r.data as any)?.data?.id) configured.value[env] = true;
      } catch {}
    }
  }
  checked.value = [1].filter((e) => !configured.value[e]);
});
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
