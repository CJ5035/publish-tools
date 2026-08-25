<template>
  <el-dialog v-model="visible" fullscreen :close-on-click-modal="false" :show-close="false" width="100%">
    <template #header>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span>{{ t('message.appconfig.wizard.title') }}</span>
        <el-button @click="onCancel">{{ t('message.appconfig.wizard.cancel') }}</el-button>
      </div>
    </template>

    <el-steps :active="stepIndex" finish-status="success" style="margin-bottom:20px;">
      <el-step :title="t('message.appconfig.wizard.steps.project')" />
      <el-step :title="t('message.appconfig.wizard.steps.servers')" />
      <el-step :title="t('message.appconfig.wizard.steps.identify')" />
      <el-step :title="envStepTitle" />
    </el-steps>

    <div v-if="isSummary">
      <h3>{{ t('message.appconfig.wizard.summaryDone') }}</h3>
      <el-table :data="summaryRows" style="width:100%">
        <el-table-column prop="env" :label="t('message.appconfig.wizard.colEnv')" />
        <el-table-column prop="status" :label="t('message.appconfig.wizard.colStatus')" />
        <el-table-column prop="msg" :label="t('message.appconfig.wizard.colMsg')" />
      </el-table>
      <div style="margin-top:16px;text-align:right;">
        <el-button type="primary" @click="onFinish">{{ t('message.appconfig.wizard.finish') }}</el-button>
      </div>
    </div>

    <template v-else>
      <Step1Project v-if="stepIndex===0" ref="s1Ref" />
      <Step2Servers v-else-if="stepIndex===1" ref="s2Ref" />
      <Step3Identify v-else-if="stepIndex===2" ref="s3Ref" />
      <Step4EnvConfig v-else-if="stepIndex===3" ref="s4eRef" :current-env="currentEnv" @switch-env="onSwitchEnv" @submitted="onEnvSubmitted" />

      <div style="margin-top:20px;text-align:right;">
        <el-button @click="onPrev" :disabled="stepIndex===0">{{ t('message.appconfig.wizard.prev') }}</el-button>
        <el-button v-if="stepIndex!==3" type="primary" @click="onNext">{{ t('message.appconfig.wizard.next') }}</el-button>
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
import Step4EnvConfig from './Step4EnvConfig.vue';

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

const envStepTitle = computed(() => draft.envs.length ? `${t('message.appconfig.wizard.stepsEnv')} (${displayEnv(currentEnv.value)})` : t('message.appconfig.wizard.stepsEnv'));

const s1Ref = ref<any>(null);
const s2Ref = ref<any>(null);
const s3Ref = ref<any>(null);
const s4eRef = ref<any>(null);

function currentValidateRef(): any {
  const map: Record<number, any> = { 0: s1Ref.value, 1: s2Ref.value, 2: s3Ref.value };
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
      stepIndex.value = Math.min(Math.max(stored.stepIndex ?? 0, 0), 3);
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
  if (stepIndex.value < 3) stepIndex.value++;
  persistDraft();
}

function onPrev() {
  if (isSummary.value) {
    isSummary.value = false;
    persistDraft();
    return;
  }
  if (stepIndex.value === 3) {
    if (s4eRef.value?.handlePrev()) { persistDraft(); return; }
  }
  if (stepIndex.value > 0) stepIndex.value--;
  persistDraft();
}

function onSwitchEnv(env: number) {
  currentEnvIndex.value = draft.envs.indexOf(env);
  persistDraft();
}

function onEnvSubmitted(p: { env: number; mode: 'insert' | 'update' }) {
  summaryRows.value.push({
    env: displayEnv(p.env),
    status: t(`message.appconfig.wizard.${p.mode === 'update' ? 'summaryUpdate' : 'summaryInsert'}`),
    msg: '',
  });
  const nxt = s4eRef.value?.nextUnsubmittedEnv();
  if (nxt === null || nxt === undefined) {
    isSummary.value = true;
  } else {
    currentEnvIndex.value = draft.envs.indexOf(nxt);
  }
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
  }
}

function onFinish() {
  clearDraft();
  visible.value = false;
  emit('refresh');
}

defineExpose({ open });
</script>
