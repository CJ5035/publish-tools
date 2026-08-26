<template>
  <div class="publish-container layout-padding">
    <el-row :gutter="15" class="publish-card-box mb15">
      <el-col v-for="(fun, index) in visibleFunModule" :key="fun.title" :class="{
        'publish-media publish-media-lg': fun.origIndex > 1,
        'publish-media-sm': fun.origIndex === 1,
      }" class="publish-fun-col">
        <div class="publish-card-item flex"
          v-loading="fun.loading && !(fun.title === '一键发布' || fun.title === '手动发布')"
          :element-loading-text="fun.loadingText"
          @click="onFunModuleHandle(index)">
          <template v-if="fun.loading && (fun.title === '一键发布' || fun.title === '手动发布')">
            <div class="publish-controls" @click.stop>
              <el-button type="warning" plain :icon="VideoPause"
                v-if="!manualCtx?.signal.paused"
                @click="onPausePublish">暂停</el-button>
              <el-button type="success" plain :icon="VideoPlay"
                v-if="manualCtx?.signal.paused"
                @click="onResumePublish">继续</el-button>
              <el-button type="danger" plain :icon="Close"
                @click="onStopPublish">停止</el-button>
            </div>
          </template>
          <template v-else>
            <div class="flex-margin flex w100">
              <div class="flex-auto">
                <div class="card-item-title">{{ fun.title }}</div>
              </div>
              <div class="publish-card-item-icon flex" :style="{ background: `var(${fun.iconBgColor})` }">
                <svg-icon class="flex-margin" :size="32" :name="fun.iconFont" :class="fun.iconFont"
                  :color="`var(${fun.iconColor})`" />
              </div>
            </div>
          </template>
        </div>
      </el-col>
    </el-row>
    <el-row :gutter="15" class="publish-card-config">
      <el-col :xs="24" :sm="12" :md="12" :lg="12" :xl="12" class="publish-media">
        <div class="publish-card-item">
          <div class="card-item-box">
            <div class="card-title">
              <el-row>
                <el-col :span="12">
                  <span>发布信息</span>
                  <el-badge v-if="schedulerStore.runningCount > 0" :value="schedulerStore.runningCount"
                    class="ml5"><span class="t-cursor-pointer" title="查看定时任务"
                      @click="router.push('/schedule')">⏱ 定时任务</span></el-badge>
                </el-col>
                <el-col :span="12">
                  <div class="item-btn-box">
                    <el-button size="small" title="生成SMOM发布文件" text :disabled="uiLocked" @click="onGeneratePublish">
                      <svg-icon :size="32" color="#606266" title="生成SMOM发布文件" name="smom-icon smom-icon-shengchengqi" />
                    </el-button>
                    <el-button title="修改应用配置" size="small" text :icon="EditPen" :disabled="uiLocked ||
                      state.publishData.appconfigData.id == null ||
                      state.publishData.appconfigData.id <= 0
                      " @click="onOpenAppConfig"></el-button>
                    <el-button title="刷新|重置" size="small" text :icon="Refresh"
                      :disabled="uiLocked"
                      @click="getProjectDefault({ keepCurrentEnvironment: true })"></el-button>
                  </div>
                </el-col>
              </el-row>
            </div>
            <div class="card-item-content">
              <el-row>
                <el-col :span="24">
                  <el-select filterable placeholder="请选择要发布的项目" size="default" v-model="state.publishData.projectId"
                    class="mb15" :disabled="uiLocked" @change="onProjectChange">
                    <el-option v-for="project in projectList" :key="project.id" :label="project.name"
                      :value="project.id" />
                  </el-select>
                </el-col>
              </el-row>

              <div class="card-item-env" v-if="envOptions.length > 0">
                <el-radio-group size="default" @change="onEnvironmentChange" v-model="state.publishData.environment"
                  :disabled="uiLocked">
                  <el-radio v-for="env in envOptions" :key="env.value" border :value="env.value">{{ env.label }}</el-radio>
                </el-radio-group>
              </div>

              <el-collapse v-model="activeBaseConfig" class="base-config-collapse">
                <el-collapse-item name="base" title="基础配置（dll方式 · MsBuild · 备份）">
                  <div class="card-item-appconfig">
                    <table class="table-appconfig" cellpadding="0" cellspacing="0">
                      <tr>
                        <th>程序集输出路径</th>
                        <td>
                          <a class="t-link-path" href="javascript:void(0);" title="打开程序集输出路径"
                            @click="onOpenAssemblyOutPath(state.publishData.assemblyOutPath)"
                            v-if="state.publishData.assemblyOutPath">{{ state.publishData.assemblyOutPath }}</a>
                          <label v-else>未配置，将采用默认路径</label>
                        </td>
                      </tr>
                    </table>
                  </div>
                  <div class="card-item-appconfig" v-if="state.publishData.appconfigData.dllMode">
                    <table class="table-appconfig" cellpadding="0" cellspacing="0">
                      <tr>
                        <th>获取dll方式</th>
                        <td colspan="3">{{ showDllMode() }}</td>
                      </tr>
                      <tr
                        v-show="state.publishData.appconfigData.dllMode == 'TFS' || state.publishData.appconfigData.dllMode == 'Git'">
                        <th>生成发布日志</th>
                        <td>
                          <el-switch v-model="generatePublishLog.isEnable" :active-value="true" :inactive-value="false"
                            :disabled="uiLocked" inline-prompt active-text="开启"
                            inactive-text="关闭" size="default" />
                        </td>
                        <th v-show="generatePublishLog.isEnable">生成方式</th>
                        <td v-show="generatePublishLog.isEnable">
                          <el-select v-model="generatePublishLog.type"
                            :disabled="uiLocked" placeholder="请选择生成方式"
                            size="default" style="min-width: 50px">
                            <el-option label="默认" value="默认" />
                            <el-option label="仅发布内容" value="仅发布内容" />
                            <el-option label="按日期" value="按日期" />
                            <el-option label="按用户" value="按用户" />
                          </el-select>
                        </td>
                      </tr>
                      <tr v-show="(state.publishData.appconfigData.dllMode == 'TFS' || state.publishData.appconfigData.dllMode == 'Git') &&
                        generatePublishLog.type !== '仅发布内容' &&
                        generatePublishLog.isEnable
                        ">
                        <th>生成信息(包含)</th>
                        <td colspan="3">
                          <el-checkbox v-model="generatePublishLog.displayPublishField.isChangeSet"
                            :disabled="uiLocked" size="default" label="变更集" />
                          <el-checkbox v-model="generatePublishLog.displayPublishField.isDateTime"
                            :disabled="uiLocked" size="default" label="日期" />
                          <el-checkbox v-model="generatePublishLog.displayPublishField.isUser"
                            :disabled="uiLocked" size="default" label="用户" />
                          <el-checkbox v-model="generatePublishLog.displayPublishField.isDll"
                            :disabled="uiLocked" size="default" label="DLL" />
                        </td>
                      </tr>
                    </table>
                  </div>
                  <div class="card-item-appconfig" v-if="state.publishData.appconfigData.msBuildPath">
                    <table class="table-appconfig" cellpadding="0" cellspacing="0">
                      <tr>
                        <th>MsBuild路径</th>
                        <td colspan="3">{{ state.publishData.appconfigData.msBuildPath }}</td>
                      </tr>
                      <tr>
                        <th>强制重新生成</th>
                        <td>
                          {{
                            state.publishData.appconfigData.configItems.isRebuild == 1
                              ? "是"
                              : "否"
                          }}
                        </td>
                        <th>发布前备份</th>
                        <td>
                          <el-switch v-model="state.publishData.appconfigData.configItems.isBackup" :active-value="1"
                            :inactive-value="0" :disabled="uiLocked" inline-prompt
                            active-text="开启" inactive-text="关闭" size="default" />
                        </td>
                      </tr>
                      <tr>
                        <th>备份路径</th>
                        <td>
                          <el-input
                            v-model="state.publishData.appconfigData.configItems.backupBasePath"
                            placeholder="选填，如 /home/backups/smom"
                            :disabled="true"
                            size="default"
                          />
                        </td>
                      </tr>
                    </table>
                  </div>
                </el-collapse-item>
              </el-collapse>

              <el-collapse v-model="activeSections" class="app-sections-collapse">
                <el-collapse-item v-for="section in appSections" :key="section.key" :name="section.key"
                  :disabled="section.status === 'removed'">
                  <template #title>
                    <div class="app-section-title">
                      <el-tag :type="section.tagType" size="small" effect="dark">{{ section.name }}</el-tag>
                      <span class="app-section-summary">{{ section.summary }}</span>
                      <el-tag :type="sectionBadgeType(section.status)" size="small">{{ sectionBadgeText(section) }}</el-tag>
                      <el-popconfirm title="移除后该模块本次不参与编译/发布，刷新可恢复。确认移除？" width="240"
                        @confirm="onRemoveSection(section.key)">
                        <template #reference>
                          <el-button v-if="section.status !== 'removed'" class="app-section-remove" type="danger" plain size="small"
                            title="将该模块移除(让其不参与编译/发布)"
                            :disabled="uiLocked"
                            @click.stop>移除</el-button>
                        </template>
                      </el-popconfirm>
                    </div>
                  </template>
                  <div class="app-section-body">
                    <div class="app-section-row">
                      <span class="app-section-label">客户端生成路径</span>
                      <a class="t-link-path" href="javascript:void(0);" title="打开客户端生成路径"
                        @click="onOpenClientPath(section.clientPath)">{{ section.clientPath }}</a>
                    </div>
                    <template v-if="section.kind === 'wpf' && section.wpf">
                      <div class="app-section-row">
                        <span class="app-section-label">生成的目录</span>
                        <span>{{ section.wpf.generateDirs.join("、") || "-" }}</span>
                      </div>
                      <div class="app-section-row">
                        <span class="app-section-label">是否打包(压缩)</span>
                        <span>{{ section.wpf.isCompress ? "是" : "否" }}</span>
                      </div>
                      <div class="app-section-row" v-if="section.wpf.isCompress">
                        <span class="app-section-label">打包(压缩)文件</span>
                        <span>{{ section.wpf.compressFiles.join("、") || "-" }}</span>
                      </div>
                      <div class="app-section-row">
                        <span class="app-section-label">应用服务器</span>
                        <span>{{ section.wpf.serverName || "-" }}</span>
                      </div>
                      <div class="app-section-row">
                        <span class="app-section-label">服务端发布路径</span>
                        <span>{{ section.wpf.serverPath || "-" }}</span>
                      </div>
                    </template>
                    <template v-else>
                      <div v-for="server in section.servers" :key="server.name" class="app-section-server">
                        <div class="app-section-server-name">🖥 {{ server.name }}</div>
                        <div v-for="p in server.paths" :key="p.identity + p.path" class="app-section-path">
                          <el-tag size="small" type="info" effect="plain" class="app-section-identity">{{ p.identity || "-" }}</el-tag>
                          <el-tooltip :content="p.path" placement="top" :disabled="!p.path">
                            <span class="app-section-path-text">{{ p.path || "-" }}</span>
                          </el-tooltip>
                        </div>
                      </div>
                    </template>
                  </div>
                </el-collapse-item>
              </el-collapse>

              <el-empty v-if="!state.publishData.projectId" description="请先选择要发布的项目" :image-size="150" />
              <el-empty v-else-if="availableEnvironments.length > 0" description="无应用配置信息."
                v-show="showEmptyAppConfig" :image-size="150" />
              <el-empty v-else description="该项目尚未配置任何发布环境" :image-size="150">
                <el-button type="primary" @click="wizardRef?.open()">打开配置向导</el-button>
                <el-button @click="router.push('/appconfig')">前往应用配置</el-button>
              </el-empty>
            </div>
          </div>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="12" :lg="12" :xl="12">
        <div class="publish-card-item">
          <div class="card-item-box">
            <div class="card-title">
              <el-row>
                <el-col :span="12">日志信息</el-col>
                <el-col :span="12">
                  <div class="item-btn-box">
                    <el-button title="清空日志" size="small" text :icon="CircleClose" :disabled="uiLocked" @click="onRemoveLogs"></el-button>
                  </div>
                </el-col>
              </el-row>
            </div>
            <div class="log-toolbar" v-if="logPrintInfo.length > 0">
              <el-button size="small" :disabled="uiLocked" @click="copyLogs">复制日志</el-button>
            </div>
            <div ref="logContentRef" class="card-item-content log-content">
              <p v-for="log in logPrintInfo" :class="log.type">
                {{ log.content.value }}
                <el-text :type="log.content.uploadFile.currNumber >=
                  log.content.uploadFile.totalNumber
                  ? 'primary'
                  : 'warning'
                  " size="small" v-if="log.content.uploadFile && log.content.uploadFile.totalNumber > 0">{{
                    log.content.uploadFile.prefix
                  }}{{ log.content.uploadFile.currNumber }}/{{
                    log.content.uploadFile.totalNumber
                  }}
                  个文件。</el-text>
              </p>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
    <appconfig-dialog ref="appconfigDialogRef" @environment-change="onAppConfigEnvChange" @refresh="getPublishAppconfigs()" />
    <generate-publish-dialog :done="execApplicationAssemblyDone" @exec-application-assembly="onExecApplicationAssembly"
      @exec-done="onExecDone" @refresh="getPublishAppconfigs()" ref="generatePublishDialogRef" />
    <scheduled-publish-dialog ref="scheduledPublishDialogRef" @refresh="getPublishAppconfigs()" />
    <project-wizard ref="wizardRef" @refresh="onWizardRefresh" />
  </div>
</template>

<script setup lang="ts" name="home">
import {
  reactive,
  ref,
  computed,
  onBeforeMount,
  onMounted,
  onUnmounted,
  onActivated,
  defineAsyncComponent,
  nextTick,
  type Ref,
} from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, CircleClose, EditPen, VideoPause, VideoPlay, Close } from "@element-plus/icons-vue";
import { useRouter } from "vue-router";
import { useProjectDb } from "@/database/project/index";
import { useAppconfigDb } from "@/database/appconfig/index";
import {
  getDefaultSubObject,
} from "@/utils/other";
import { cmdInvoke } from "@/utils/command";
import { createLogStore } from "./publishLogStore";
import mittBus from "@/utils/mitt";
import { useSettingsDb } from "@/database/settings/index";
import { loadPublishSettings } from "@/utils/publishSettings";
import { safeJsonParse } from "@/utils/safeJsonParse";
import {
  buildAppSections,
  filterAppconfigForDialog,
  APP_TYPE_ORDER,
  type AppSection as AppSectionLike,
  type AppTypeKey,
  type PublishStatusMap,
} from "./publishSections";
import {
  oneClickPublishing,
  projectPublish,
  buildProjects,
  getApplicationAssemblys,
  validateTfsLocalPath,
  initLogs,
  resolveAssemblyOutPath,
} from "@/composables/usePublishFlow";
import {
  createPublishSignal,
  createStatusCtl,
  cloneAppconfig,
  type PublishContext,
} from "@/composables/publishFlowSupport";
import { usePublishSchedulerStore } from "@/stores/publishScheduler";

const SvgIcon = defineAsyncComponent(() => import("@/components/svgIcon/index.vue"));

// 引入应用配置数据库
const projectDb = useProjectDb();
const appconfigDb = useAppconfigDb();
// 全局定时发布调度器（App 挂载即启动；首页仅消费角标状态，不再持有页面级定时逻辑）
const schedulerStore = usePublishSchedulerStore();
const settingsDb = useSettingsDb();
const oneClickEnabled = ref(0); // 0 关 / 1 开

const reloadSettings = async () => {
  const r = await settingsDb.getSettings();
  if (r.code === 0 && r.data) oneClickEnabled.value = r.data.oneClickPublishEnabled;
  // 同步刷新 publishSettings 缓存（供调用点 getRetryArgs 使用）
  await loadPublishSettings();
};

// 引入组件
const appconfigDialogRef = ref();
const generatePublishDialogRef = ref();
const scheduledPublishDialogRef = ref();
const AppconfigDialog = defineAsyncComponent(
  () => import("@/views/appconfig/components/appconfigDialog.vue")
);
const GeneratePublishDialog = defineAsyncComponent(
  () => import("@/views/home/components/generatePublishDialog.vue")
);
const ScheduledPublishDialog = defineAsyncComponent(
  () => import("@/views/home/components/scheduledPublishDialog.vue")
);
const ProjectWizard = defineAsyncComponent(
  () => import("@/views/appconfig/components/projectWizard/index.vue")
);
const wizardRef = ref();
// 向导保存后的刷新：已选项目 → 对当前项目重探测（直接 getProjectDefault 会把选择重置回默认项目）
const onWizardRefresh = async () => {
  if (state.publishData.projectId) {
    await onProjectChange(state.publishData.projectId);
  } else {
    await getProjectDefault();
  }
};

// 定义变量内容
const projectList = ref<RowProjectType[]>();
const isRefreshingProjectDefault = ref(false);
const showEmptyAppConfig = ref(false);
// 环境显隐：仅展示当前项目已配置的环境（探测结果复用，替代 onProjectChange/getProjectDefault 里的重复循环）
const ENV_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Dev" },
  { value: 2, label: "Uat" },
  { value: 3, label: "Pro" },
  { value: 4, label: "Other" },
];
const availableEnvironments = ref<number[]>([]);
const envOptions = computed(() => ENV_LABELS.filter((e) => availableEnvironments.value.includes(e.value)));

const queryAvailableEnvironments = async (projectId: number): Promise<number[]> => {
  const envs: number[] = [];
  for (let env = 1; env <= 4; env++) {
    const result = await appconfigDb.getPublishAppconfigs(projectId, env);
    if (result.code === 0 && result.data.data && result.data.data.id) envs.push(env);
  }
  return envs;
};
const router = useRouter();
// 应用类型发布状态徽标（失败续发语义：published 跳过；重置收口在 getPublishAppconfigs）
const publishStatus = reactive<PublishStatusMap>({
  webApiHost: "pending",
  webClient: "pending",
  scheduleServer: "pending",
  wpfClient: "pending",
  spcMonitor: "pending",
});
const publishedAt = reactive<Record<AppTypeKey, string>>({
  webApiHost: "",
  webClient: "",
  scheduleServer: "",
  wpfClient: "",
  spcMonitor: "",
});
// 手动运行上下文：一次发布持有一份；徽标状态直接绑定页面既有的 publishStatus/publishedAt（保持第一批交互不变）
// （显式标注 Ref<PublishContext | null>：规避 ref() 对 logger.logs 的 UnwrapRef 深解包误报，同时保留深响应式供模板按钮联动）
const manualCtx: Ref<PublishContext | null> = ref(null);

const buildManualCtx = async (): Promise<PublishContext> => {
  const ctx: PublishContext = {
    projectId: state.publishData.projectId,
    projectName: state.publishData.projectName,
    environment: state.publishData.environment,
    isScheduled: false,
    appconfig: cloneAppconfig(state.publishData.appconfigData),
    assemblyOutPath: "", // 构建后再解析（保持原“先 validate 后取路径”的顺序）
    logger: logStore,
    signal: createPublishSignal(),
    status: createStatusCtl(publishStatus, publishedAt),
    generatePublishLog: generatePublishLog.value, // 共享页面响应式对象：基础配置区开关实时生效（与原行为一致）
    onPauseUi: (paused) => {
      state.funModule[currModuleIndex.value].loadingText = paused ? "已暂停" : "发布中";
    },
    deployRecorder: null,
  };
  manualCtx.value = ctx;
  return ctx;
};
const resetPublishStatus = () => {
  for (const { key } of APP_TYPE_ORDER) {
    publishStatus[key] = "pending";
    publishedAt[key] = "";
  }
};
// 移除模块：置空 clientPath（原模板 5 处内联赋值）+ 标记 removed 供面板禁用态展示
const onRemoveSection = (key: AppTypeKey) => {
  (state.publishData.appconfigData.configItems as any)[key].clientPath = "";
  publishStatus[key] = "removed";
};
// 折叠面板模型与展开状态（默认全部折叠）
const activeSections = ref<string[]>([]);
const activeBaseConfig = ref<string[]>([]);
const appSections = computed(() => buildAppSections(state.publishData.appconfigData.configItems, publishStatus));

const sectionBadgeType = (status: AppSectionLike["status"]): "success" | "danger" | "primary" | "info" =>
  status === "published" ? "success" : status === "failed" ? "danger" : status === "publishing" ? "primary" : "info";
const sectionBadgeText = (section: AppSectionLike): string => {
  switch (section.status) {
    case "published":
      return `✓ 已发布 ${publishedAt[section.key]}`;
    case "failed":
      return "✗ 发布失败";
    case "removed":
      return "⊘ 已移除";
    case "publishing":
      return "● 发布中";
    default:
      return "● 待发布";
  }
};
const logContentRef = ref();
const logStore = createLogStore(2000);
const logPrintInfo = logStore.logs;
const generatePublishLog = ref({
  isEnable: true,
  type: "默认",
  displayPublishField: {
    isChangeSet: true,
    isUser: true,
    isDateTime: true,
    isDll: true,
  } as DisplayPublishFieldType,
  data: "",
  logs: "",
});
// 定时发布相关：页面级检测器已退场，由全局调度器（stores/publishScheduler）接管
const state = reactive({
  funModule: [
    {
      title: "一键发布",
      iconBgColor: "--el-color-primary-light-9",
      iconFont: "smom-icon smom-icon-fabu",
      iconColor: "--el-color-primary",
      loading: false,
      loadingText: "一键发布中",
    },
    {
      title: "编译项目",
      iconBgColor: "--next-color-warning-lighter",
      iconFont: "smom-icon smom-icon-bianyigongcheng",
      iconColor: "--el-color-warning",
      loading: false,
      loadingText: "编译中",
    },
    {
      title: "获取程序集",
      iconBgColor: "--next-color-warning-lighter",
      iconFont: "smom-icon smom-icon-chengxuji",
      iconColor: "--el-color-warning",
      loading: false,
      loadingText: "获取中",
    },
    {
      title: "手动发布",
      iconBgColor: "--next-color-success-lighter",
      iconFont: "smom-icon smom-icon-shangchuanfabu",
      iconColor: "--el-color-success",
      loading: false,
      loadingText: "发布中",
    },
    {
      title: "定时发布",
      iconBgColor: "--next-color-danger-lighter",
      iconFont: "smom-icon smom-icon-duoyuanfabu",
      iconColor: "--el-color-danger",
      loading: false,
      loadingText: "定时发布",
    },
  ],
  // 项目发布信息
  publishData: {
    projectId: null as any,
    projectName: "",
    assemblyOutPath: "",
    environment: 1,
    appconfigData: {} as RowAppconfigType,
  },
});

// 可见功能模块（Task 9：一键发布开关关时过滤掉"一键发布"，origIndex 标记原始下标防止 class 漂移）
const visibleFunModule = computed(() => {
  const withOrig = state.funModule.map((item, origIndex) => ({ ...item, origIndex }));
  return oneClickEnabled.value === 1
    ? withOrig
    : withOrig.filter((f) => f.title !== "一键发布");
});

// UI 统一锁定（临时护栏，第三批调度中心上线后由架构根治取代）：
// 任一功能模块 loading 中，所有会写入/重载 state.publishData 的入口统一禁用
// （定时发布执行中一项已随页面级定时逻辑退场：调度器以独立 ctx 执行，不再读取页面 state）
const uiLocked = computed(
  () => state.funModule.some((m) => m.loading)
);

// 功能模块触发
const currModuleIndex = ref(0);
// 高危操作确认：仅 Pro（生产）环境的发布动作需要
const confirmProPublish = async (): Promise<boolean> => {
  if (state.publishData.environment !== 3) return true;
  try {
    await ElMessageBox.confirm(
      `即将发布到生产环境【${state.publishData.projectName} / Pro】，确认执行？`,
      "高危操作确认",
      { type: "warning", confirmButtonText: "确认发布", cancelButtonText: "取消" }
    );
    return true;
  } catch {
    return false;
  }
};
const onFunModuleHandle = async (index: number) => {
  // index 是 visibleFunModule 的渲染下标，反查原始下标，避免过滤后漂移
  const origIndex = state.funModule.findIndex(
    (f) => f.title === visibleFunModule.value[index].title
  );
  if (origIndex < 0) return;
  let title = state.funModule[origIndex].title;

  // 定时发布直接打开对话框，不需要其他逻辑
  if (title === "定时发布") {
    if (!state.publishData.appconfigData.id) {
      ElMessage.warning("请先选择项目和发布配置！");
      return;
    }
    if (!(await confirmProPublish())) return;
    scheduledPublishDialogRef.value.openDialog({
      projectId: state.publishData.projectId,
      projectName: state.publishData.projectName,
      environment: state.publishData.environment,
      appconfigId: state.publishData.appconfigData.id,
      oneClickEnabled: oneClickEnabled.value,
    });
    return;
  }

  if (showEmptyAppConfig.value) {
    ElMessage.warning("未获取到要发布的应用配置信息！");
    return;
  }
  let currModule = state.funModule.find((item) => item.loading);
  if (currModule) {
    ElMessage.info(`正在[${currModule.title}]中，请稍等！`);
    return;
  }
  if ((title === "一键发布" || title === "手动发布") && !(await confirmProPublish())) return;
  onRemoveLogs();
  state.funModule[origIndex].loading = true;
  // loading 复位收口到 finally：任一 await 抛异常（如编译项目/获取程序集无 try/catch 分支）
  // 都必须复位，否则 uiLocked 的 .some(m => m.loading) 会永久锁死整页
  // §4.4 第3条：一键/手动发布与同项目同环境的定时任务共用全局互斥表；heldKey 非空才在 finally 释放
  let heldKey: { projectId: number | null; environment: number | null } | null = null;
  try {
    currModuleIndex.value = origIndex;
    if (title === "一键发布" || title === "手动发布") {
      const { projectId, environment } = state.publishData;
      if (!schedulerStore.tryLock(projectId, environment)) {
        printInfoLog("当前项目该环境已有发布任务执行中，请稍后再试。", "log-warning");
        return;
      }
      heldKey = { projectId, environment };
    }
    const ctx = await buildManualCtx();
    initLogs(ctx);
    if (title === "一键发布" || title === "获取程序集" || title === "手动发布") {
      if (!(await validateTfsLocalPath(ctx))) {
        state.funModule[origIndex].loading = false;
        return;
      }
    }
    // 加载发布设置缓存（供后续 copy_path / 服务停止启动 调用点 getRetryArgs 使用）
    await loadPublishSettings();
    ctx.assemblyOutPath = await resolveAssemblyOutPath(ctx.projectId, ctx.projectName, ctx.environment, ctx.logger);
    switch (title) {
      case "一键发布":
        try {
          if (await oneClickPublishing(ctx)) printInfoLog("一键发布成功。");
        } catch (e: any) {
          if (e?.message === "PUBLISH_STOPPED") {
            printInfoLog("发布已停止.", "log-warning");
          }
        }
        break;
      case "编译项目":
        if (await buildProjects(ctx))
          printInfoLog("编译项目成功，可以尝试：获取程序集、手动发布。");
        break;
      case "获取程序集":
        if (await getApplicationAssemblys(ctx, true)) printInfoLog("获取程序集成功。");
        break;
      case "手动发布":
        try {
          if (await projectPublish(ctx)) {
            printInfoLog("手动发布成功。");
            await getProjectDefault();
          }
        } catch (e: any) {
          if (e?.message === "PUBLISH_STOPPED") {
            printInfoLog("发布已停止.", "log-warning");
          }
        }
        break;
    }
    printInfoLog("");
    printInfoLog(generatePublishLog.value.logs, "log-info");
  } finally {
    if (heldKey) schedulerStore.release(heldKey.projectId, heldKey.environment);
    state.funModule[origIndex].loading = false;
  }
  generatePublishLog.value.data = "";
  generatePublishLog.value.logs = "";
};

const onPausePublish = () => {
  if (manualCtx.value) manualCtx.value.signal.paused = true;
};

const onResumePublish = () => {
  if (!manualCtx.value) return;
  manualCtx.value.signal.paused = false;
  manualCtx.value.signal.resumeResolve?.();
};

const onStopPublish = () => {
  if (!manualCtx.value) return;
  manualCtx.value.signal.stopped = true;
  manualCtx.value.signal.resumeResolve?.();
};

// 执行获取程序集
const execApplicationAssemblyDone = ref(false);
const onExecApplicationAssembly = async () => {
  if (!state.publishData.appconfigData.id) return false;
  const ctx = await buildManualCtx();
  ctx.assemblyOutPath = await resolveAssemblyOutPath(ctx.projectId, ctx.projectName, ctx.environment, ctx.logger);
  if (!(await getApplicationAssemblys(ctx))) return false;
  execApplicationAssemblyDone.value = true;
  return true;
};

// 执行[获取程序集]完成
const onExecDone = () => {
  execApplicationAssemblyDone.value = false;
};

// 生成发布
const onGeneratePublish = async () => {
  if (!state.publishData.appconfigData.id) return;
  // const appConfigResult = await useAppconfigDb().getAppconfigById(
  //   state.publishData.appconfigData.id
  // );
  // if (appConfigResult.code !== 0) return;
  // generatePublishDialogRef.value.openDialog("edit", appConfigResult.data.data);
  // 已发布类型传过滤副本（clientPath 置空），保持对话框"已发布类型不出现"的原显隐行为
  generatePublishDialogRef.value.openDialog(
    "edit",
    filterAppconfigForDialog(state.publishData.appconfigData, publishStatus)
  );
};

// 打开程序集输出路径
const onOpenAssemblyOutPath = async (path: string) => {
  if (!path) return;
  await cmdInvoke("open_dir", { path });
};

// 打开客户端生成路径
const onOpenClientPath = async (path: string) => {
  if (!path) return;
  await cmdInvoke("open_dir", { path });
};

// 查询项目信息
const getProjectList = async () => {
  let dataResult = await projectDb.getProjectList({
    code: null,
    name: null,
    sorting: "id DESC",
    skipCount: 0,
    maxResultCount: 1000,
  });
  if (dataResult.code !== 0) {
    ElMessage.error(dataResult.msg);
    return;
  }
  projectList.value = dataResult.data.data;
};

// 编辑发布配置信息
const onOpenAppConfig = async () => {
  if (!state.publishData.appconfigData.id) return;
  const appConfigResult = await useAppconfigDb().getAppconfigById(
    state.publishData.appconfigData.id
  );
  if (appConfigResult.code !== 0) return;
  appconfigDialogRef.value.openDialog("edit", appConfigResult.data.data);
};

// 获取默认项目
// 获取默认项目并恢复环境
const getProjectDefault = async (options?: { keepCurrentEnvironment?: boolean }) => {
  if (isRefreshingProjectDefault.value) return;
  isRefreshingProjectDefault.value = true;
  try {
    await getProjectList();
    await nextTick();
    let dataResult = await projectDb.getProjectDefault();
    if (dataResult.code == 0 && dataResult.data.data?.id) {
      const projectId = dataResult.data.data.id;

      console.log('=== getProjectDefault 开始执行 ===');
      console.log('  - 默认项目ID:', projectId);

      // 更新项目信息
      state.publishData.projectId = projectId;
      state.publishData.projectName = String(dataResult.data.data.name);
      state.publishData.assemblyOutPath = dataResult.data.data.assemblyOutPath
        ? String(dataResult.data.data.assemblyOutPath)
        : "";

      // 查询该项目有哪些环境配置
      const detected = await queryAvailableEnvironments(projectId);
      availableEnvironments.value = detected;
      const detectedEnvironments = detected;

      console.log('  - 可用环境配置:', detectedEnvironments);

      // 决定使用哪个环境
      let targetEnvironment = 1; // 默认 Dev
      const currentEnvironment = state.publishData.environment;

      if (options?.keepCurrentEnvironment && detectedEnvironments.includes(currentEnvironment)) {
        targetEnvironment = currentEnvironment;
        console.log('  >>> 保持当前环境:', currentEnvironment);
      } else {
        // 1. 先尝试恢复 localStorage 中保存的环境
        const savedEnvironment = restoreEnvironmentFromStorage(projectId);
        if (savedEnvironment && detectedEnvironments.includes(savedEnvironment)) {
          // 保存的环境存在且有配置
          targetEnvironment = savedEnvironment;
          console.log('  >>> 恢复保存的环境:', savedEnvironment);
        } else if (detectedEnvironments.length > 0) {
          // 2. 如果保存的环境不可用，找第一个有配置的环境
          // 优先级：Dev(1) > Uat(2) > Pro(3) > Other(4)
          detectedEnvironments.sort((a, b) => a - b);
          targetEnvironment = detectedEnvironments[0];
          console.log('  >>> 保存的环境不可用，使用第一个有配置的环境:', targetEnvironment);
        } else {
          console.log('  >>> 该项目没有任何环境配置，使用默认 Dev');
        }
      }

      state.publishData.environment = targetEnvironment;

      console.log('=== getProjectDefault 执行完毕 ===');
      console.log('  - projectId:', state.publishData.projectId);
      console.log('  - environment:', state.publishData.environment);
    }
    await getPublishAppconfigs();
  } finally {
    isRefreshingProjectDefault.value = false;
  }
};

// 应用配置弹框环境变更
const onAppConfigEnvChange = (newEnv: number) => {
  console.log('=== 应用配置弹框环境变更 ===');
  console.log('  - 旧 environment:', state.publishData.environment);
  console.log('  - 新 environment:', newEnv);
  state.publishData.environment = newEnv;
  console.log('  - 已更新 environment:', state.publishData.environment);
};

// 获取发布的应用程序配置
const getPublishAppconfigs = async () => {
  let dataResult = await appconfigDb.getPublishAppconfigs(
    state.publishData.projectId,
    state.publishData.environment
  );
  showEmptyAppConfig.value = true;
  if (dataResult.code == 0 && dataResult.data.data && dataResult.data.data.id) {
    Object.assign(state.publishData.appconfigData, dataResult.data.data);
    showEmptyAppConfig.value = false;
  } else {
    state.publishData.appconfigData = getDefaultSubObject(
      state.publishData.appconfigData
    );
  }
  // 状态徽标重置唯一收口：所有配置重载路径（默认项目/刷新/切项目/切环境/对话框与向导 refresh）都经过这里
  resetPublishStatus();
};

// 保存环境选择到本地存储
const saveEnvironmentToStorage = (projectId: number, environment: number) => {
  try {
    const storageKey = `project_environment_${projectId}`;
    localStorage.setItem(storageKey, String(environment));
  } catch (error) {
    console.error('保存环境选择失败:', error);
  }
};

// 从本地存储恢复环境选择
const restoreEnvironmentFromStorage = (projectId: number): number | null => {
  try {
    const storageKey = `project_environment_${projectId}`;
    const savedEnv = localStorage.getItem(storageKey);
    return savedEnv ? Number(savedEnv) : null;
  } catch (error) {
    console.error('恢复环境选择失败:', error);
    return null;
  }
};

// 显示dll获取方式
const showDllMode = () => {
  let modelName = state.publishData.appconfigData.dllMode;
  if (modelName == "日期范围") {
    // 解析失败仅展示模式名（safeJsonParse 已输出告警日志），不再以异常打断渲染
    const dllModeArr = safeJsonParse<string[] | null>(
      state.publishData.appconfigData.dllModeValue,
      null
    );
    if (dllModeArr && dllModeArr.length >= 2) {
      modelName += `：${dllModeArr[0]} ~ ${dllModeArr[1]}`;
    }
  } else if (modelName == "TFS") {
    const selectTfsItem = safeJsonParse<SelectTfsType | null>(
      state.publishData.appconfigData.dllModeValue,
      null
    );
    if (selectTfsItem) {
      modelName += `：${selectTfsItem.tfsName}；${selectTfsItem.selectModel}：${selectTfsItem.selectValue[0].value} ~ `;
      if (selectTfsItem.selectValue[1].value) {
        modelName += `${selectTfsItem.selectValue[1].value}`;
      } else {
        modelName += "latest";
      }
    }
  }
  else if (modelName == "Git") {
    const selectGitItem = safeJsonParse<SelectGitType | null>(
      state.publishData.appconfigData.dllModeValue,
      null
    );
    if (selectGitItem) {
      modelName += `：${selectGitItem.gitName}；${selectGitItem.selectModel}：${selectGitItem.selectValue[0].value} ~ `;
      if (selectGitItem.selectValue[1].value) {
        modelName += `${selectGitItem.selectValue[1].value}`;
      } else {
        modelName += "latest";
      }
    }
  }
  else if (modelName == "DLL名称") {
    const lines = String(state.publishData.appconfigData.dllModeValue || "").split(/\n|、/);
    const firstLine = lines[0]?.trim() || "";
    const more = lines.length > 1 ? ` 等${lines.length}个` : "";
    modelName += `：${firstLine}${more}`;
  }
  return modelName;
};

// 项目切换
const onProjectChange = async (val: number) => {
  let projectObj = projectList.value?.find((item) => item.id === val);
  if (projectObj) {
    state.publishData.projectName = String(projectObj.name);
    state.publishData.assemblyOutPath = projectObj.assemblyOutPath
      ? String(projectObj.assemblyOutPath)
      : "";

    // 从数据库查该项目有哪些环境有配置
    const detectedEnvironments = await queryAvailableEnvironments(val);
    availableEnvironments.value = detectedEnvironments;

    // 恢复环境：优先用缓存（需有对应配置），否则取第一个有配置的环境
    const savedEnvironment = restoreEnvironmentFromStorage(val);
    if (savedEnvironment && detectedEnvironments.includes(savedEnvironment)) {
      state.publishData.environment = savedEnvironment;
    } else if (detectedEnvironments.length > 0) {
      detectedEnvironments.sort((a, b) => a - b);
      state.publishData.environment = detectedEnvironments[0];
    } else {
      state.publishData.environment = 1;
    }
  }
  await getPublishAppconfigs();
};

// 环境切换
const onEnvironmentChange = async (val: number) => {
  console.log('=== 环境切换事件触发 ===');
  console.log('  - 新项目ID:', state.publishData.projectId);
  console.log('  - 新环境值:', val);
  
  // 保存环境选择到本地存储
  saveEnvironmentToStorage(state.publishData.projectId, val);
  
  console.log('  - 环境已保存到 localStorage');
  
  await getPublishAppconfigs();
};

// 设置进度值
// const setProgressTextContent = (textVal: string, progressId: string = "progress") => {
//   const progress = document.getElementById(progressId) as HTMLLabelElement;
//   if (progress) progress.textContent = textVal;
// };

// 清空日志
const onRemoveLogs = () => {
  logStore.clear();
  generatePublishLog.value.data = "";
  generatePublishLog.value.logs = "";
};

/**
 * 打印日志信息
 * @param content 日志内容
 * @param type：log-info、log-warning、log-error、log-success
 */
const printInfoLog = (
  content: string,
  type: "log-info" | "log-warning" | "log-error" | "log-success" = "log-info",
  showDate: boolean = true
) => {
  const logInfo = logStore.print(content, type, showDate);
  nextTick(() => {
    logContentRef.value.scrollTop = logContentRef.value.scrollHeight;
  });
  return logInfo;
};

// 复制日志到剪贴板
const copyLogs = async () => {
  const text = logPrintInfo.value.map(log => log.content.value).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("日志已复制");
  } catch {
    ElMessage.warning("复制失败，请手动选择复制");
  }
};

// 页面加载完时
onBeforeMount(async () => {
  console.log('=== onBeforeMount 被调用 ===');
  await getProjectDefault();
});

onMounted(() => {
  reloadSettings();
  mittBus.on("settingsChanged", reloadSettings);
});

onUnmounted(() => {
  mittBus.off("settingsChanged", reloadSettings);
});

onActivated(async () => {
  console.log('=== onActivated 被调用 ===');
  // 每次进入页面都重新查询默认项目并恢复环境（定时任务已由全局调度器独立 ctx 执行，与页面状态解耦）
  await getProjectDefault();

  if (uiLocked.value) {
    console.log("当前模块正在加载中…");
    return;
  }

  reloadSettings();
});
</script>

<style scoped lang="scss">
$homeNavLengh: 8;

.publish-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  .publish-card-box,
  .publish-card-config {
    .publish-card-item {
      width: 100%;
      height: 130px;
      border-radius: 4px;
      transition: all ease 0.3s;
      overflow: hidden;
      position: relative;
      background: var(--el-color-white);
      color: var(--el-text-color-primary);
      border: 1px solid var(--next-border-color-light);

      .card-item-title {
        font-size: 20px;
        color: #506c88;
        text-align: center;
        height: 70px;
        line-height: 70px;
      }

      .card-title {
        padding: 12px 10px 10px 10px;
        height: 45px;
        font-size: 15px;
        border-bottom: 1px #dfdfdf dashed;
        align-content: flex-end;

        .item-btn-box {
          width: 100%;
          text-align: right;
        }
      }

      .card-item-content {
        overflow-y: auto;
        padding: 10px;

        .card-item-env {
          width: 100%;
          text-align: center;
          background-color: #fbfbfb;
          padding: 10px 0px;
        }

        .card-item-appconfig {
          width: 100%;
          margin-top: 15px;

          .table-appconfig {
            width: 100%;
            border-collapse: collapse;

            tr {
              th {
                background-color: #fbfbfb;
                font-weight: 500;
                text-align: right;
                font-size: 14px;
                width: 110px;
                padding: 10px 5px;
                border: 1px solid #eeeeee;
              }

              td {
                font-size: 14px;
                text-align: left;
                padding: 0px 5px;
                border: 1px solid #eeeeee;
                word-wrap: break-word;
                word-break: break-all;

                .t-link-path {
                  text-decoration: none;
                  color: #303133;
                }

                .t-link-path:hover {
                  text-decoration: underline;
                }
              }
            }
          }
        }

        .base-config-collapse,
        .app-sections-collapse {
          border-top: none;
        }

        .app-sections-collapse {
          :deep(.el-collapse-item__header) {
            height: auto;
            min-height: 48px;
            padding: 6px 0;
            line-height: normal;
          }

          :deep(.el-collapse-item.is-disabled .el-collapse-item__header) {
            color: var(--el-text-color-placeholder);
            cursor: not-allowed;
          }
        }

        .app-section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding-right: 10px;
          min-width: 0;
        }

        .app-section-summary {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          color: var(--el-text-color-secondary);
        }

        .app-section-remove {
          flex-shrink: 0;
        }

        .app-section-body {
          padding: 2px 0 8px 4px;
        }

        .app-section-row {
          display: flex;
          gap: 8px;
          padding: 4px 0;
          font-size: 14px;
          align-items: baseline;
          min-width: 0;
        }

        .app-section-label {
          flex: 0 0 110px;
          text-align: right;
          color: var(--el-text-color-secondary);
        }

        .app-section-server {
          margin: 8px 0 4px;
        }

        .app-section-server-name {
          font-weight: 600;
          font-size: 13px;
          color: var(--el-text-color-regular);
          padding: 2px 0;
        }

        .app-section-path {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 2px 0 2px 16px;
          min-width: 0;
        }

        .app-section-identity {
          flex-shrink: 0;
        }

        .app-section-path-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      &:hover {
        box-shadow: 0 2px 12px var(--next-color-dark-hover);
        transition: all ease 0.3s;
      }

      &-icon {
        width: 70px;
        height: 70px;
        border-radius: 100%;
        flex-shrink: 1;

        i {
          color: var(--el-text-color-placeholder);
        }
      }

      .log-toolbar {
        padding: 4px 10px;
        text-align: right;
        background: #545c64;
      }

      .log-content {
        box-sizing: border-box;
        background-color: #545c64;
        counter-reset: line-number;
        padding-right: 1em;
        text-align: left;
      }
    }

    /*
    .log-content p::before {
      counter-increment: line-number;
      content: counter(line-number) ".";
      display: inline-block;
      margin-right: 0.5em;
    }
    */
  }

  .publish-card-box {
    .publish-card-item {
      padding: 10px 12px;
      cursor: pointer;
      height: 80px;

      .card-item-title {
        font-size: 15px;
        height: 36px;
        line-height: 36px;
      }

      .publish-card-item-icon {
        width: 46px;
        height: 46px;
      }

      // loading 动画适配缩小后的按钮（高度 80px）：缩小 spinner 与文字，整体居中，避免被 overflow:hidden 裁剪
      :deep(.el-loading-spinner) {
        top: 50%;
        margin-top: 0;
        transform: translateY(-50%);

        svg {
          width: 24px;
          height: 24px;
        }

        .el-loading-text {
          font-size: 12px;
          margin: 4px 0 0 0;
        }
      }
    }

    .publish-fun-col {
      flex: 1 1 0%;
      max-width: none;
    }

    @for $i from 0 through 3 {
      .publish-animation#{$i} {
        opacity: 0;
        animation-name: error-num;
        animation-duration: 0.5s;
        animation-fill-mode: forwards;
        animation-delay: calc($i/4) + s;
      }
    }
  }

  .publish-card-config {
    flex: 1;
    min-height: 0;

    .publish-card-item {
      height: 100%;
      width: 100%;

      .card-item-box {
        height: 100%;
        display: flex;
        flex-direction: column;

        .card-item-content {
          flex: 1;
          min-height: 0;
        }
      }
    }
  }

  .t-align-c {
    text-align: center !important;
  }

  .mb0 {
    margin-bottom: 0px !important;
  }

  .t-border-none {
    border: 0px solid white !important;
  }

  .t-link-path {
    text-decoration: none;
    color: #409eff;
  }

  .t-link-path:hover {
    text-decoration: underline;
    cursor: pointer;
  }

  // 定时任务角标：可点击跳转任务页
  .t-cursor-pointer {
    cursor: pointer;
  }

  .ml5 {
    margin-left: 5px;
  }

  .publish-controls {
    width: 100%;
    height: 100%;
    display: flex;
    gap: 8px;
    padding: 20px;
    align-items: center;
    .el-button {
      flex: 1;
      height: 100%;
    }
  }
}
</style>
