<template>
  <el-dialog v-model="state.show" title="发布前确认" width="760px" :close-on-click-modal="false" draggable
    @close="onClose">
    <el-alert v-if="state.meta.environment === 3" type="error" show-icon :closable="false" class="mb15"
      :title="`高危操作：即将发布到生产环境【${state.meta.projectName} / Pro】`" />
    <div class="confirm-summary">
      项目：<b>{{ state.meta.projectName }}</b>　环境：<b>{{ envName }}</b><br />
      获取dll方式：<b>{{ state.meta.dllModeText }}</b><br />
      本次将发布 <b>{{ state.summary.items.length }}</b> 个服务，共 <b>{{ totalFiles }}</b> 个文件
      <template v-if="state.summary.scanFailed.length">
        <br /><span class="confirm-scan-failed">以下服务文件明细获取失败（不影响发布）：{{ state.summary.scanFailed.join("、") }}</span>
      </template>
    </div>
    <el-table :data="state.summary.items" size="small" border row-key="service">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="confirm-files">
            <el-table :data="row.files" size="small" border max-height="260">
              <el-table-column prop="name" label="文件名" min-width="220" show-overflow-tooltip />
              <el-table-column prop="modifiedTime" label="修改时间" width="170" />
              <el-table-column label="大小" width="100">
                <template #default="{ row: f }">{{ formatSize(f.size) }}</template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="service" label="服务" width="150" />
      <el-table-column prop="count" label="文件数" width="90" align="center" />
      <el-table-column prop="timeRange" label="文件修改时间范围" min-width="220" />
    </el-table>
    <template #footer>
      <el-button @click="onCancel">取 消</el-button>
      <el-button type="primary" @click="onConfirm">确认发布</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts" name="publishConfirmDialog">
import { computed, reactive } from "vue";
import type { PublishFileSummary } from "@/composables/publishFlowSupport";

// open() 返回 Promise：确认 resolve(true)，取消/关闭 resolve(false)——引擎确认点直接 await
let resolver: ((v: boolean) => void) | null = null;

const state = reactive<{
  show: boolean;
  summary: PublishFileSummary;
  meta: { projectName: string; environment: number; dllModeText: string };
}>({
  show: false,
  summary: { items: [], scanFailed: [] },
  meta: { projectName: "", environment: 1, dllModeText: "" },
});

const envName = computed(() => ({ 1: "Dev", 2: "Uat", 3: "Pro", 4: "Other" }[state.meta.environment] || "-"));
const totalFiles = computed(() => state.summary.items.reduce((n, i) => n + i.count, 0));

const formatSize = (size: number) => (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024).toFixed(0)} KB`);

const open = (
  summary: PublishFileSummary,
  meta: { projectName: string; environment: number; dllModeText: string }
): Promise<boolean> => {
  state.summary = summary;
  state.meta = meta;
  state.show = true;
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
};

const settle = (v: boolean) => {
  state.show = false;
  resolver?.(v);
  resolver = null;
};
const onConfirm = () => settle(true);
const onCancel = () => settle(false);
const onClose = () => settle(false); // 右上角 X / ESC 视为取消

defineExpose({ open });
</script>

<style lang="scss" scoped>
.confirm-summary {
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.9;
  margin-bottom: 12px;
}
.confirm-scan-failed {
  color: var(--el-color-warning);
}
.confirm-files {
  padding: 8px 16px;
}
</style>
