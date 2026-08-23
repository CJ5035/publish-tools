<template>
  <el-dialog v-model="visible" fullscreen :close-on-click-modal="false" :show-close="false" width="100%">
    <template #header>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span>配置向导</span>
        <el-button @click="onCancel">取消</el-button>
      </div>
    </template>

    <el-steps :active="stepIndex" finish-status="success" style="margin-bottom:20px;">
      <el-step title="项目信息" />
      <el-step title="服务器" />
      <el-step title="服务识别" />
      <el-step title="环境选择" />
      <el-step :title="step5Title" />
      <el-step :title="step6Title" />
    </el-steps>

    <div v-if="isSummary">
      <h3>配置完成</h3>
      <el-table :data="summaryRows" style="width:100%">
        <el-table-column prop="env" label="环境" />
        <el-table-column prop="status" label="状态" />
        <el-table-column prop="msg" label="说明" />
      </el-table>
      <div style="margin-top:16px;text-align:right;">
        <el-button type="primary" @click="onFinish">完成</el-button>
      </div>
    </div>

    <template v-else>
      <Step1Project v-if="stepIndex===0" ref="s1Ref" />
      <Step2Servers v-else-if="stepIndex===1" ref="s2Ref" />
      <Step3Identify v-else-if="stepIndex===2" ref="s3Ref" />
      <Step4EnvSelect v-else-if="stepIndex===3" ref="s4Ref" />
      <Step5ServiceAssign v-else-if="stepIndex===4" ref="s5Ref" :current-env="currentEnv" />
      <Step6Confirm v-else-if="stepIndex===5" ref="s6Ref" :current-env="currentEnv" />

      <div style="margin-top:20px;text-align:right;">
        <el-button @click="onPrev" :disabled="stepIndex===0">上一步</el-button>
        <el-button type="primary" @click="onNext">{{ stepIndex===5 ? (hasNextEnv ? '下一步环境' : '提交') : '下一步' }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, provide, reactive } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { Local } from '@/utils/storage';
import { createEmptyDraft, displayEnv, serializeDraft, restoreDraft } from './wizardTypes';
import type { WizardDraft, StoredWizardDraft } from './wizardTypes';
import Step1Project from './Step1Project.vue';
import Step2Servers from './Step2Servers.vue';
import Step3Identify from './Step3Identify.vue';
import Step4EnvSelect from './Step4EnvSelect.vue';
import Step5ServiceAssign from './Step5ServiceAssign.vue';
import Step6Confirm from './Step6Confirm.vue';

const emit = defineEmits<{ (e: 'refresh'): void }>();
const { t } = useI18n();

const visible = ref(false);
const stepIndex = ref(0);
const currentEnvIndex = ref(0);
const isSummary = ref(false);
const summaryRows = ref<{ env: string; status: string; msg: string }[]>([]);

const draft = reactive<WizardDraft>(createEmptyDraft());
provide('wizardDraft', draft);

const currentEnv = computed(() => draft.envs[currentEnvIndex.value] ?? 1);
const hasNextEnv = computed(() => currentEnvIndex.value < draft.envs.length - 1);
const hasProgress = computed(() =>
  draft.servers.length > 0 ||
  Object.keys(draft.scanResults).length > 0 ||
  !!draft.project.slnPath ||
  !!draft.project.id ||
  draft.envs.length > 0
);

const DRAFT_KEY = 'wizard:draft:v1';

function persistDraft() {
  if (!hasProgress.value) return;
  try {
    Local.set(DRAFT_KEY, serializeDraft(draft, stepIndex.value, currentEnvIndex.value, isSummary.value, summaryRows.value));
  } catch (e) { console.warn('草稿写入失败', e); }
}

function clearDraft() {
  try { Local.remove(DRAFT_KEY); } catch {}
}

const step5Title = computed(() => draft.envs.length ? `服务分配 (${displayEnv(currentEnv.value)})` : '服务分配');
const step6Title = computed(() => draft.envs.length ? `确认 (${displayEnv(currentEnv.value)})` : '确认');

const s1Ref = ref<any>(null);
const s2Ref = ref<any>(null);
const s3Ref = ref<any>(null);
const s4Ref = ref<any>(null);
const s5Ref = ref<any>(null);
const s6Ref = ref<any>(null);

function currentValidateRef(): any {
  const map: Record<number, any> = { 0: s1Ref.value, 1: s2Ref.value, 2: s3Ref.value, 3: s4Ref.value, 4: s5Ref.value, 5: s6Ref.value };
  return map[stepIndex.value];
}

async function open() {
  let stored: StoredWizardDraft | null = null;
  try { stored = restoreDraft(Local.get(DRAFT_KEY)); } catch { stored = null; }
  if (stored) {
    try {
      await ElMessageBox.confirm(
        t('message.appconfig.wizard.resumeMsg', { time: new Date(stored.savedAt).toLocaleString() }),
        t('message.appconfig.wizard.resumeTitle'),
        {
          type: 'info',
          confirmButtonText: t('message.appconfig.wizard.resumeOk'),
          cancelButtonText: t('message.appconfig.wizard.resumeRestart'),
        }
      );
      Object.assign(draft, stored.draft);
      stepIndex.value = stored.stepIndex;
      currentEnvIndex.value = stored.currentEnvIndex;
      isSummary.value = stored.isSummary;
      summaryRows.value = stored.summaryRows ?? [];
      visible.value = true;
      return;
    } catch {
      clearDraft();
    }
  }
  Object.assign(draft, createEmptyDraft());
  stepIndex.value = 0;
  currentEnvIndex.value = 0;
  isSummary.value = false;
  summaryRows.value = [];
  visible.value = true;
}

async function onNext() {
  const v = currentValidateRef();
  if (v && typeof v.validate === 'function') {
    const ok = await v.validate();
    if (!ok) return;
  }
  // 段2循环：S6提交后要么进入下一环境S5，要么到总结
  if (stepIndex.value === 5) {
    // 记录本环境结果（由 Step6Confirm.validate 内落库，失败会返回 false 已拦截）
    const mode = (s6Ref.value?.saveMode ?? 'insert') as 'insert' | 'update';
    summaryRows.value.push({
      env: displayEnv(currentEnv.value),
      status: t(`message.appconfig.wizard.${mode === 'update' ? 'summaryUpdate' : 'summaryInsert'}`),
      msg: '',
    });
    if (hasNextEnv.value) {
      currentEnvIndex.value++;
      stepIndex.value = 4;
      persistDraft();
      return;
    } else {
      isSummary.value = true;
      persistDraft();
      return;
    }
  }
  if (stepIndex.value < 5) stepIndex.value++;
  persistDraft();
}

function onPrev() {
  if (isSummary.value) {
    isSummary.value = false;
    persistDraft();
    return;
  }
  if (stepIndex.value === 4 && currentEnvIndex.value > 0) {
    // 在 S5 且不是首个环境：回退到上一环境的 S6
    currentEnvIndex.value--;
    stepIndex.value = 5;
    persistDraft();
    return;
  }
  if (stepIndex.value > 0) stepIndex.value--;
  persistDraft();
}

async function onCancel() {
  if (!hasProgress.value) { visible.value = false; return; }
  try {
    await ElMessageBox.confirm(
      t('message.appconfig.wizard.cancelExitMsg'),
      t('message.appconfig.wizard.cancelConfirmTitle'),
      {
        type: 'warning',
        distinguishCancelAndClose: true,
        confirmButtonText: t('message.appconfig.wizard.cancelSaveExit'),
        cancelButtonText: t('message.appconfig.wizard.cancelAbandon'),
      }
    );
    persistDraft();
    visible.value = false;
  } catch (action) {
    if (action === 'cancel') { clearDraft(); visible.value = false; }
    // 'close'（右上角 × / Esc）→ 继续编辑，不关闭向导
  }
}

function onFinish() {
  clearDraft();
  visible.value = false;
  emit('refresh');
}

defineExpose({ open });
</script>
