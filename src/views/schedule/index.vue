<template>
  <div class="schedule-container layout-padding">
    <el-card shadow="hover" class="mb15">
      <template #header><span>新建定时任务</span></template>
      <el-form ref="formRef" size="default" label-width="110px" :model="form" :rules="formRules">
        <el-row :gutter="15">
          <el-col :xs="24" :sm="12" :md="8">
            <el-form-item label="项目" prop="projectId">
              <el-select filterable v-model="form.projectId" placeholder="请选择项目" @change="onProjectChange" style="width:100%">
                <el-option v-for="p in projectList" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12" :md="6">
            <el-form-item label="环境" prop="environment">
              <el-select v-model="form.environment" placeholder="请选择环境" style="width:100%">
                <el-option v-for="env in availableEnvironments" :key="env" :label="envLabel(env)" :value="env" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12" :md="5">
            <el-form-item label="发布类型" prop="publishType">
              <el-radio-group v-model="form.publishType">
                <el-radio value="一键发布" border v-if="oneClickEnabled === 1">一键发布</el-radio>
                <el-radio value="手动发布" border>手动发布</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12" :md="5">
            <el-form-item label="计划时间" prop="scheduledTime">
              <el-date-picker v-model="form.scheduledTime" type="datetime" placeholder="选择时间"
                value-format="YYYY-MM-DD HH:mm:ss" :disabled-date="disabledDate" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <div style="text-align:right">
        <el-button type="primary" :loading="saving" @click="onSave">保 存</el-button>
      </div>
    </el-card>

    <el-card shadow="hover" class="layout-padding-auto">
      <template #header><span>定时任务列表</span></template>
      <el-table :data="scheduleList" style="width:100%" v-loading="listLoading">
        <el-table-column prop="projectName" label="项目名称" min-width="110" show-overflow-tooltip />
        <el-table-column prop="publishType" label="类型" width="90" />
        <el-table-column label="计划时间" width="160">
          <template #default="{ row }">
            <template v-if="editingId === row.id">
              <el-date-picker v-model="editTimeValue" type="datetime" placeholder="新时间"
                value-format="YYYY-MM-DD HH:mm:ss" :disabled-date="disabledDate" size="small" style="width:140px" />
            </template>
            <template v-else>{{ row.scheduledTime }}</template>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <template v-if="editingId === row.id">
                <el-button size="small" type="primary" link @click="onSaveEditTime(row)">确定</el-button>
                <el-button size="small" link @click="editingId = null">取消</el-button>
              </template>
              <template v-else>
                <el-button size="small" type="primary" plain @click="onStartEditTime(row)">修改时间</el-button>
                <el-button size="small" type="warning" @click="onCancelSchedule(row)">取消</el-button>
              </template>
            </template>
            <el-button v-if="row.status === 'executing'" size="small" type="primary" link @click="onViewLog(row)">实时日志</el-button>
            <el-button v-if="row.status === 'failed' || row.status === 'completed'" size="small" type="primary" link @click="onViewLog(row)">查看日志</el-button>
            <el-button size="small" type="danger" @click="onDeleteSchedule(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty description="暂无定时任务" :image-size="80" v-if="!listLoading && scheduleList.length < 1" />
    </el-card>

    <el-dialog v-model="logDialog.show" title="任务日志" width="720px">
      <el-input type="textarea" :model-value="logDialog.content" readonly :rows="18" />
      <template #footer><el-button type="primary" @click="logDialog.show = false">关 闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts" name="schedule">
import { reactive, ref, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { usePublishScheduleDb } from "@/database/publishSchedule/index";
import { useProjectDb } from "@/database/project/index";
import { useAppconfigDb } from "@/database/appconfig/index";
import { useSettingsDb } from "@/database/settings/index";
import { usePublishSchedulerStore } from "@/stores/publishScheduler";

const publishScheduleDb = usePublishScheduleDb();
const projectDb = useProjectDb();
const appconfigDb = useAppconfigDb();
const settingsDb = useSettingsDb();
const schedulerStore = usePublishSchedulerStore();
// 执行中任务每 30s 由调度器推进；页面轮询刷新列表即可看到状态变化
const refreshTimer = ref<ReturnType<typeof setInterval> | null>(null);

const projectList = ref<RowProjectType[]>([]);
const availableEnvironments = ref<number[]>([]);
const oneClickEnabled = ref(0);
const scheduleList = ref<RowPublishScheduleType[]>([]);
const listLoading = ref(false);
const saving = ref(false);
const editingId = ref<number | null>(null);
const editTimeValue = ref<string | null>(null);
const formRef = ref();

const form = reactive({
  projectId: null as number | null,
  environment: null as number | null,
  publishType: "手动发布" as PublishScheduleType,
  scheduledTime: "" as string | null,
});
const formRules = {
  projectId: [{ required: true, message: "请选择项目", trigger: "change" }],
  environment: [{ required: true, message: "请选择环境", trigger: "change" }],
  publishType: [{ required: true, message: "请选择发布类型", trigger: "change" }],
  scheduledTime: [{ required: true, message: "请选择计划时间", trigger: "change" }],
};

const ENV_LABELS: Record<number, string> = { 1: "Dev", 2: "Uat", 3: "Pro", 4: "Other" };
const envLabel = (v: number) => ENV_LABELS[v] ?? String(v);
const disabledDate = (time: Date) => time.getTime() < Date.now() - 8.64e7;

const statusTagType = (status: string) =>
  ({ pending: "warning", executing: "primary", completed: "success", cancelled: "info", failed: "danger" } as any)[status] ?? "info";
const statusText = (status: string) =>
  ({ pending: "待执行", executing: "执行中", completed: "已完成", cancelled: "已取消", failed: "失败" } as any)[status] ?? "未知";

const logDialog = reactive({ show: false, content: "" });

const loadProjects = async () => {
  const r = await projectDb.getProjectList({ code: null, name: null, sorting: "id DESC", skipCount: 0, maxResultCount: 1000 });
  if (r.code === 0) projectList.value = r.data.data;
};
const onProjectChange = async (projectId: number) => {
  form.environment = null;
  availableEnvironments.value = [];
  for (let env = 1; env <= 4; env++) {
    const r = await appconfigDb.getPublishAppconfigs(projectId, env);
    if (r.code === 0 && r.data.data?.id) availableEnvironments.value.push(env);
  }
  if (availableEnvironments.value.length > 0) form.environment = availableEnvironments.value[0];
  else ElMessage.warning("该项目尚未配置任何发布环境");
};
const loadScheduleList = async () => {
  listLoading.value = true;
  try {
    const r = await publishScheduleDb.getScheduleList({ skipCount: 0, maxResultCount: 100 });
    if (r.code === 0) scheduleList.value = r.data.data;
  } finally {
    listLoading.value = false;
  }
};
const onSave = async () => {
  await formRef.value.validate();
  saving.value = true;
  try {
    const projectName = projectList.value.find((p) => p.id === form.projectId)?.name ?? "";
    const appconfig = await appconfigDb.getPublishAppconfigs(form.projectId!, form.environment!);
    if (!(appconfig.code === 0 && appconfig.data.data?.id)) {
      ElMessage.warning("该项目该环境缺少发布配置");
      return;
    }
    const r = await publishScheduleDb.insertSchedule({
      id: 0, projectId: form.projectId!, projectName, environment: form.environment!,
      appconfigId: appconfig.data.data.id, publishType: form.publishType,
      scheduledTime: form.scheduledTime || "", status: "pending", createTime: "",
    });
    if (r.code === 0) {
      ElMessage.success("定时任务创建成功");
      form.scheduledTime = null;
      await loadScheduleList();
    } else ElMessage.error(r.msg);
  } finally {
    saving.value = false;
  }
};
const onStartEditTime = (row: RowPublishScheduleType) => { editingId.value = row.id; editTimeValue.value = row.scheduledTime; };
const onSaveEditTime = async (row: RowPublishScheduleType) => {
  if (!editTimeValue.value) return ElMessage.warning("请选择新的计划时间");
  const r = await publishScheduleDb.updateScheduleTime(row.id, editTimeValue.value);
  if (r.code === 0) { editingId.value = null; await loadScheduleList(); } else ElMessage.error(r.msg);
};
const onCancelSchedule = async (row: RowPublishScheduleType) => {
  try {
    await ElMessageBox.confirm(`确定要取消计划于 ${row.scheduledTime} 的定时发布任务吗？`, "提示", { type: "warning" });
    const r = await publishScheduleDb.updateScheduleStatus(row.id, "cancelled", "用户取消");
    if (r.code === 0) await loadScheduleList(); else ElMessage.error(r.msg);
  } catch { /* 取消确认框 */ }
};
const onDeleteSchedule = async (row: RowPublishScheduleType) => {
  try {
    await ElMessageBox.confirm("确定要删除该定时发布任务吗？", "提示", { type: "warning" });
    const r = await publishScheduleDb.deleteSchedule(row.id);
    if (r.code === 0) await loadScheduleList(); else ElMessage.error(r.msg);
  } catch { /* 删除确认框 */ }
};
const onViewLog = (row: RowPublishScheduleType) => {
  // 执行中 → 调度器内存实时日志；已结束 → resultLog 留档
  logDialog.content = row.status === "executing"
    ? schedulerStore.getTaskLogs(row.id).map((l) => l.content.value).join("\n")
    : row.resultLog || "暂无日志";
  logDialog.show = true;
};

onMounted(async () => {
  await Promise.all([loadProjects(), loadScheduleList()]);
  const s = await settingsDb.getSettings();
  if (s.code === 0 && s.data) oneClickEnabled.value = s.data.oneClickPublishEnabled;
});

// 轮询随激活态启停：路由 isKeepAlive 下 onUnmounted 在缓存期间不触发，改由 activated/deactivated 接管
const startRefreshTimer = () => {
  if (refreshTimer.value) return;
  refreshTimer.value = setInterval(() => loadScheduleList(), 30000);
};
const stopRefreshTimer = () => {
  if (!refreshTimer.value) return;
  clearInterval(refreshTimer.value);
  refreshTimer.value = null;
};
onActivated(() => {
  void loadScheduleList();
  startRefreshTimer();
});
onDeactivated(stopRefreshTimer);
// 兜底：非 keep-alive 卸载路径（deactivated 不触发）也能清表
onUnmounted(stopRefreshTimer);
</script>

<style scoped lang="scss">
.schedule-container {
  .el-card {
    width: 100%;
  }
}
</style>
