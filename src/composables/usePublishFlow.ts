// 发布引擎：原 src/views/home/index.vue 发布流程的 ctx 参数化搬运（等价重构，见方案 §4.3 3a）
// 纪律：除下方《替换映射》外逐字保留原判断分支/日志文案/执行顺序
import { cmdInvoke } from "@/utils/command";
import { path } from "@tauri-apps/api";
import { removeSlash, displayEnvironment, displayOs } from "@/utils/other";
import { formatDate } from "@/utils/formatTime";
import {
  outPublishContents, outDetaultPublishContents, outPublishContentByDates,
  outPublishContentByUsers, getDllFilesByChangedItems, getTfsChangedPath,
  type DllResolveOptions,
} from "@/utils/outPublishInfo";
import { createDeployRecorder } from "@/utils/deployTaskRecorder";
import { classifyWpfDlls } from "@/utils/wpfDllClassify";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { getRetryArgs } from "@/utils/publishSettings";
import { uploadServerFilesWithRetry } from "@/utils/uploadServerFilesWithRetry";
import { loadBackupItems, backupRemoteServer } from "@/utils/backupAppconfig";
import { safeJsonParse } from "@/utils/safeJsonParse";
import { collectActivePublishTargets, isTypeActive, APP_TYPE_ORDER } from "@/views/home/publishSections";
import { type PublishContext, type PublishFileSummary, type PublishFileItem } from "./publishFlowSupport";
import { useProjectDb } from "@/database/project/index";
import { useServerDb } from "@/database/servers/index";
import { useTfsDb } from "@/database/teamFoundationServer/index";
import { useGitDb } from "@/database/git/index";
import { useBackupDb } from "@/database/backups/index";

// 注意：①引擎不引入 loadPublishSettings（调用方负责预热缓存）；②appconfigDb 无引擎侧消费者
// （配置经 ctx.appconfig 快照传入），不得在此实例化，否则 noUnusedLocals 拦截构建。
const projectDb = useProjectDb();
const serverDb = useServerDb();
const tfsDb = useTfsDb();
const gitDb = useGitDb();
const backupDb = useBackupDb();

// 应用类型显示名（home 原为 ref("WebApiHost") 等页面常量，全仓无重新赋值，引擎内等价为字符串常量）
const webApiHostName = "WebApiHost";
const scheduleServerName = "ScheduleServer";
const webClientName = "WebClient";
const wpfClientName = "WpfClient";
const spcMonitorName = "SpcMonitor";

// 初始化日志
export const initLogs = (ctx: PublishContext) => {
  ctx.logger.print("项目名称：" + ctx.projectName);
  ctx.logger.print("项目环境：" + displayEnvironment(ctx.environment));
  ctx.generatePublishLog.data = "";
  ctx.generatePublishLog.logs = "";
};

// 验证TFS本地根目录
export const validateTfsLocalPath = async (ctx: PublishContext) => {
  if (ctx.appconfig.dllMode !== "TFS") return true;
  if (!ctx.appconfig.dllModeValue) {
    ctx.logger.print(`当前发布配置使用TFS获取dll，请先配置TFS获取程序集的相关信息.`, "log-error");
    return false;
  }

  // 解析失败走下方原有失败分支（与"未配置TFS"同路径），不再以异常中断校验
  const selectTfsItem = safeJsonParse<SelectTfsType | null>(
    ctx.appconfig.dllModeValue,
    null
  );
  if (!selectTfsItem) {
    ctx.logger.print(`当前发布配置使用TFS获取dll，但配置信息损坏无法解析，请重新选择.`, "log-error");
    return false;
  }
  const tfsItem = await getTfsDetail(ctx, Number(selectTfsItem.id));
  if (tfsItem?.tfsLocalPath) return true;

  ctx.logger.print(`当前发布配置使用TFS获取dll，请先在TFS配置中填写本地根目录.`, "log-error");
  return false;
};

// 获取项目配置信息（顺序 = APP_TYPE_ORDER，与原实现一致，影响编译顺序）
export const getConfigItemHosts = (ctx: PublishContext) => {
  return APP_TYPE_ORDER.filter(({ key }) =>
    isTypeActive((ctx.appconfig.configItems as any)[key]?.clientPath, ctx.status.map[key])
  ).map(({ key, csprojFile }) => ({
    hostItem: (ctx.appconfig.configItems as any)[key],
    csprojFile,
  }));
};

// 一键/手动发布检查点
export const checkCanContinueHome = async (ctx: PublishContext) => {
  if (ctx.signal.stopped) {
    throw new Error("PUBLISH_STOPPED");
  }
  // 定时发布无 UI，跳过暂停逻辑
  if (ctx.isScheduled) return;
  if (ctx.signal.paused) {
    ctx.logger.print("发布已暂停，等待恢复...", "log-warning");
    ctx.onPauseUi?.(true);
    await new Promise<void>((resolve) => {
      ctx.signal.resumeResolve = resolve;
    });
    ctx.signal.resumeResolve = null;
    ctx.onPauseUi?.(false);
    ctx.logger.print("发布已恢复.", "log-success");
    if (ctx.signal.stopped) {
      throw new Error("PUBLISH_STOPPED");
    }
  }
};

// 一健发布
export const oneClickPublishing = async (ctx: PublishContext) => {
  // 编译项目
  const buildProjectsResult = await buildProjects(ctx);
  if (!buildProjectsResult) return false;

  // 发布项目
  const publishResult = await projectPublish(ctx);
  if (!publishResult) return false;

  ctx.logger.print("");
  return true;
};

// 项目发布
export const projectPublish = async (ctx: PublishContext) => {
  if (!ctx.appconfig.id) return false;
  const configItems = ctx.appconfig.configItems;
  if (!configItems) {
    ctx.logger.print("发布配置无效，请检查应用配置后再发布。", "log-error");
    return false;
  }
  const targetCheck = collectActivePublishTargets(configItems, ctx.status.map);
  if (targetCheck.issues.length > 0) {
    const issueText = targetCheck.issues.map((issue) => {
      const appName = APP_TYPE_ORDER.find((item) => item.key === issue.key)?.pascal ?? issue.key;
      return `${appName}${issue.reason === "missing-target" ? "缺少服务器目标" : "存在非法服务器 ID"}`;
    });
    ctx.logger.print(`发布配置无效：${issueText.join("、")}。请到应用配置重新选择后再发布。`, "log-error");
    return false;
  }
  const targetsById = new Map<number, (typeof targetCheck.targets)[number]>();
  for (const target of targetCheck.targets) {
    if (!targetsById.has(target.id)) targetsById.set(target.id, target);
  }
  const invalidTargets: (typeof targetCheck.targets)[number][] = [];
  try {
    for (const [id, target] of targetsById) {
      if (!(await getServerDetail(ctx, id))) invalidTargets.push(target);
    }
  } catch (error) {
    console.error("服务器校验失败:", error);
    ctx.logger.print("服务器校验失败，请检查数据库连接后再发布。", "log-error");
    return false;
  }
  if (invalidTargets.length > 0) {
    const targetText = invalidTargets.map((target) => {
      const appName = APP_TYPE_ORDER.find((item) => item.key === target.key)?.pascal ?? target.key;
      return `${appName}/${target.name || "未命名服务器"}（ID: ${target.id}）`;
    });
    ctx.logger.print(`服务器校验未通过：${targetText.join("、")}。请到应用配置重新选择后再发布。`, "log-error");
    return false;
  }
  const publishStartTime = Date.now();
  const serviceNames = APP_TYPE_ORDER.filter(({ key }) =>
    isTypeActive((ctx.appconfig.configItems as any)[key]?.clientPath, ctx.status.map[key])
  ).map(({ pascal }) => pascal);
  ctx.deployRecorder = await createDeployRecorder({
    source: "home",
    triggerType: ctx.isScheduled ? "scheduled" : "manual",
    projectId: ctx.projectId ?? undefined,
    projectName: ctx.projectName,
    environment: ctx.environment,
    appconfigId: ctx.appconfig.id,
    selectedServices: serviceNames,
  });
  try {
    const getAppAssemblysResult = await getApplicationAssemblys(ctx);
    if (!getAppAssemblysResult) return false;

    // 发布前确认（手动/一键链路；定时 ctx 无钩子不弹，无人值守行为不变）
    if (ctx.confirmBeforeUpload) {
      const summary = await collectServiceFileSummary(ctx);
      const confirmed = await ctx.confirmBeforeUpload(summary);
      if (!confirmed) {
        ctx.logger.print("已取消发布：已获取的程序集保留，可打开输出目录核对后重试。", "log-warning");
        return false;
      }
    }

    // 发布前备份
    if (ctx.appconfig.configItems.isBackup == 1) {
      const backupResult = await publishBeforeBackup(ctx);
      if (!backupResult) return false;
    }

    await checkCanContinueHome(ctx);
    // 发布 WebApiHost
    ctx.status.markPublishing("webApiHost");
    const publishWebApiResult = await publishWebApiHost(ctx);
    if (!publishWebApiResult) {
      ctx.status.markFailed("webApiHost");
      return false;
    }
    ctx.status.markPublished("webApiHost");

    await checkCanContinueHome(ctx);
    // 发布 ScheduleServer
    ctx.status.markPublishing("scheduleServer");
    const publishScheduleResult = await publishScheduleServer(ctx);
    if (!publishScheduleResult) {
      ctx.status.markFailed("scheduleServer");
      return false;
    }
    ctx.status.markPublished("scheduleServer");

    await checkCanContinueHome(ctx);
    // 发布 WpfClient
    ctx.status.markPublishing("wpfClient");
    const wpfClientItem = ctx.appconfig.configItems.wpfClient;
    const wpfDetailId = isTypeActive(wpfClientItem.clientPath, ctx.status.map.wpfClient)
      ? ((await ctx.deployRecorder?.step("WpfClient", "upload", {
          serverId: wpfClientItem.serverId ?? undefined,
          serverName: wpfClientItem.serverName ?? undefined,
          remotePath: removeSlash(wpfClientItem.serverPath || ""),
        })) ?? null)
      : null;
    let publishWpfClientResult = false;
    if (ctx.appconfig.configItems.isNewVersion) {
      publishWpfClientResult = await newPublishWpfClient(ctx);
    } else {
      publishWpfClientResult = await publishWpfClient(ctx);
    }
    await ctx.deployRecorder?.done(wpfDetailId, publishWpfClientResult ? "success" : "failed");
    if (!publishWpfClientResult) {
      ctx.status.markFailed("wpfClient");
      return false;
    }
    ctx.status.markPublished("wpfClient");

    await checkCanContinueHome(ctx);
    // 发布 SpcMonitor
    ctx.status.markPublishing("spcMonitor");
    const publishSpcMonitorResult = await publishSpcMonitor(ctx);
    if (!publishSpcMonitorResult) {
      ctx.status.markFailed("spcMonitor");
      return false;
    }
    ctx.status.markPublished("spcMonitor");

    await checkCanContinueHome(ctx);
    // 发布 WebClient
    ctx.status.markPublishing("webClient");
    const publishWebClientResult = await publishWebClient(ctx);
    if (!publishWebClientResult) {
      ctx.status.markFailed("webClient");
      return false;
    }
    ctx.status.markPublished("webClient");
    try {
      // 发布结果摘要：成功/跳过统计 + 耗时（失败路径由既有错误日志覆盖，不输出摘要）
      const skippedCount = APP_TYPE_ORDER.length - serviceNames.length;
      ctx.logger.print(
        `发布完成摘要：成功 ${serviceNames.length} 个服务${skippedCount > 0 ? `（跳过 ${skippedCount} 个）` : ""}，耗时 ${((Date.now() - publishStartTime) / 1000).toFixed(1)}s。`,
        "log-success"
      );
      sendNotification({
        title: "发布完成",
        body: "SMOM项目发布完成！"
      });
    } catch (err) {
      console.error("发送通知失败:", err);
    }
    return true;
  } finally {
    await ctx.deployRecorder?.finish("发布未完成");
  }
};

// 发布前备份
export const publishBeforeBackup = async (ctx: PublishContext) => {
  var backupItem = await loadBackupItems(ctx.appconfig.id!, "发布前备份", false);
  if (!backupItem) return false;
  var backupData = backupItem as RowBackupType;
  ctx.logger.print("");

  // 备份[WebApiHost]
  if (backupData.backupItems.webApiHost && backupData.backupItems.webApiHost.length > 0) {
    const currLog = ctx.logger.print(`正在备份 ${webApiHostName}.`);
    const backupWebApiHostResult = await backupRemoteServer(
      "WebApiHost",
      backupData.backupItems.webApiHost,
      (uploadFile: UploadFileNumberType) => {
        currLog.content.uploadFile.prefix = uploadFile.prefix;
        currLog.content.uploadFile.currNumber =
          uploadFile.currNumber;
        currLog.content.uploadFile.totalNumber =
          uploadFile.totalNumber;
      }
    );
    if (backupWebApiHostResult.code !== 0) {
      ctx.logger.print(
        `备份 ${webApiHostName} 失败：${backupWebApiHostResult.msg}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`备份 ${webApiHostName} 成功.`, "log-success");
  }

  // 备份[ScheduleServer]
  if (
    backupData.backupItems.scheduleServer &&
    backupData.backupItems.scheduleServer.length > 0
  ) {
    const currLog = ctx.logger.print(`正在备份 ${scheduleServerName}.`);
    const backupScheduleServerResult = await backupRemoteServer(
      "ScheduleServer",
      backupData.backupItems.scheduleServer,
      (uploadFile: UploadFileNumberType) => {
        currLog.content.uploadFile.prefix = uploadFile.prefix;
        currLog.content.uploadFile.currNumber =
          uploadFile.currNumber;
        currLog.content.uploadFile.totalNumber =
          uploadFile.totalNumber;
      }
    );
    if (backupScheduleServerResult.code !== 0) {
      ctx.logger.print(
        `备份 ${scheduleServerName} 失败：${backupScheduleServerResult.msg}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`备份 ${scheduleServerName} 成功.`, "log-success");
  }

  // 备份[WebClient]
  if (backupData.backupItems.webClient && backupData.backupItems.webClient.length > 0) {
    const currLog = ctx.logger.print(`正在备份 ${webClientName}.`);
    const backupWebClientResult = await backupRemoteServer(
      "WebClient",
      backupData.backupItems.webClient,
      (uploadFile: UploadFileNumberType) => {
        currLog.content.uploadFile.prefix = uploadFile.prefix;
        currLog.content.uploadFile.currNumber =
          uploadFile.currNumber;
        currLog.content.uploadFile.totalNumber =
          uploadFile.totalNumber;
      }
    );
    if (backupWebClientResult.code !== 0) {
      ctx.logger.print(
        `备份 ${webClientName} 失败：${backupWebClientResult.msg}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`备份 ${webClientName} 成功.`, "log-success");
  }

  // 备份[WpfClient]
  if (backupData.backupItems.wpfClient && backupData.backupItems.wpfClient.length > 0) {
    const currLog = ctx.logger.print(`正在备份 ${wpfClientName}.`);
    const backupWpfClientResult = await backupRemoteServer(
      "WpfClient",
      backupData.backupItems.wpfClient,
      (uploadFile: UploadFileNumberType) => {
        currLog.content.uploadFile.prefix = uploadFile.prefix;
        currLog.content.uploadFile.currNumber =
          uploadFile.currNumber;
        currLog.content.uploadFile.totalNumber =
          uploadFile.totalNumber;
      },
      Boolean(ctx.appconfig.configItems.isNewVersion)
    );
    if (backupWpfClientResult.code !== 0) {
      ctx.logger.print(
        `备份 ${wpfClientName} 失败：${backupWpfClientResult.msg}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`备份 ${wpfClientName} 成功.`, "log-success");
  }

  // 备份[SpcMonitor]
  if (backupData.backupItems.spcMonitor && backupData.backupItems.spcMonitor.length > 0) {
    const currLog = ctx.logger.print(`正在备份 ${spcMonitorName}.`);
    const backupSpcMonitorResult = await backupRemoteServer(
      "SpcMonitor",
      backupData.backupItems.spcMonitor,
      (uploadFileNumber: UploadFileNumberType) => {
        currLog.content.uploadFile = uploadFileNumber;
      }
    );
    if (backupSpcMonitorResult.code !== 0) {
      ctx.logger.print(
        `备份 ${spcMonitorName} 失败：${backupSpcMonitorResult.msg}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`备份 ${spcMonitorName} 成功.`, "log-success");
  }

  let insertResult = await backupDb.insertBackup(backupData);
  if (insertResult.code !== 0) {
    ctx.logger.print(`备份失败：${insertResult.msg}.`, "log-error");
    return false;
  }
  return true;
};

// 发布[WebApiHost]服务
export const publishWebApiHost = async (ctx: PublishContext) => {
  const webApiHostItem = ctx.appconfig.configItems.webApiHost;
  if (!isTypeActive(webApiHostItem.clientPath, ctx.status.map.webApiHost)) return true;

  ctx.logger.print("");
  for (let i = 0; i < webApiHostItem.serverArr.length; i++) {
    const webApiServer = webApiHostItem.serverArr[i];
    if (!webApiServer.id) {
      ctx.logger.print(
        ` ${webApiHostName} 未选择服务或该服务器不存在，请检查.`,
        "log-error"
      );
      return false;
    }
    const serverInfo = await getServerDetail(ctx, webApiServer.id);
    if (!serverInfo) {
      ctx.logger.print(`服务[${webApiServer.name}]不存在，请检查.`, "log-error");
      return false;
    }

    // 发布服务
    ctx.logger.print(`发布 ${webApiHostName} 服务[${webApiServer.name}]中，请稍等！`);
    const publishResult = await serverPublish(
      ctx,
      serverInfo,
      webApiServer.serverPathArr,
      webApiHostName
    );
    if (!publishResult) return false;
  }
  return true;
};

// 发布[SpcMonitor]服务
export const publishSpcMonitor = async (ctx: PublishContext) => {
  const spcMonitorItem = ctx.appconfig.configItems.spcMonitor;
  if (!isTypeActive(spcMonitorItem.clientPath, ctx.status.map.spcMonitor)) return true;

  ctx.logger.print("");
  for (let i = 0; i < spcMonitorItem.serverArr.length; i++) {
    const spcMonitorServer = spcMonitorItem.serverArr[i];
    if (!spcMonitorServer.id) {
      ctx.logger.print(
        ` ${spcMonitorName} 未选择服务或该服务器不存在，请检查.`,
        "log-error"
      );
      return false;
    }
    const serverInfo = await getServerDetail(ctx, spcMonitorServer.id);
    if (!serverInfo) {
      ctx.logger.print(`服务[${spcMonitorServer.name}]不存在，请检查.`, "log-error");
      return false;
    }

    // 发布服务
    ctx.logger.print(
      `发布 ${spcMonitorName} 服务[${spcMonitorServer.name}]中，请稍等！`
    );
    const publishResult = await serverPublish(
      ctx,
      serverInfo,
      spcMonitorServer.serverPathArr,
      spcMonitorName
    );
    if (!publishResult) return false;
  }
  return true;
};

// 发布[WebClient]服务
export const publishWebClient = async (ctx: PublishContext) => {
  const webClientItem = ctx.appconfig.configItems.webClient;
  if (!isTypeActive(webClientItem.clientPath, ctx.status.map.webClient)) return true;

  ctx.logger.print("");
  for (let i = 0; i < webClientItem.serverArr.length; i++) {
    const webClientServer = webClientItem.serverArr[i];
    if (!webClientServer.id) {
      ctx.logger.print(
        ` ${webClientName} 未选择服务或该服务器不存在，请检查.`,
        "log-error"
      );
      return false;
    }
    const serverInfo = await getServerDetail(ctx, webClientServer.id);
    if (!serverInfo) {
      ctx.logger.print(`服务[${webClientServer.name}]不存在，请检查.`, "log-error");
      return false;
    }

    // 发布服务
    ctx.logger.print(`发布 ${webClientName} 服务[${webClientServer.name}]中，请稍等！`);
    const publishResult = await serverPublish(
      ctx,
      serverInfo,
      webClientServer.serverPathArr,
      webClientName
    );
    if (!publishResult) return false;
  }
  return true;
};

// 发布[ScheduleServer]服务
export const publishScheduleServer = async (ctx: PublishContext) => {
  const scheduleServerItem = ctx.appconfig.configItems.scheduleServer;
  if (!isTypeActive(scheduleServerItem.clientPath, ctx.status.map.scheduleServer)) return true;

  ctx.logger.print("");

  for (let i = 0; i < scheduleServerItem.serverArr.length; i++) {
    const scheduleServer = scheduleServerItem.serverArr[i];
    if (!scheduleServer.id) {
      ctx.logger.print(
        ` ${scheduleServerName} 未选择服务或该服务器不存在，请检查.`,
        "log-error"
      );
      return false;
    }
    const serverInfo = await getServerDetail(ctx, scheduleServer.id);
    if (!serverInfo) {
      ctx.logger.print(`服务[${scheduleServer.name}]不存在，请检查.`, "log-error");
      return false;
    }

    // 发布服务
    ctx.logger.print(`发布 ${scheduleServerName} 服务[${scheduleServer.name}]中，请稍等！`);

    for (let j = 0; j < scheduleServer.serverPathArr.length; j++) {
      const serverPath = scheduleServer.serverPathArr[j];
      if (!serverPath.value) {
        ctx.logger.print(`服务[${scheduleServer.name}]未配置，请检查.`, "log-error");
        return false;
      }

      for (let k = 0; k < serverPath.value.length; k++) {
        const serverPathVal = serverPath.value[k];
        if (!serverPathVal.identity) {
          ctx.logger.print(`服务[${scheduleServer.name}]未填写服务标识，请检查.`, "log-error");
          return false;
        }
        if (!serverPathVal.path) {
          ctx.logger.print(`服务[${scheduleServer.name}]未填写服务发布路径，请检查.`, "log-error");
          return false;
        }

        const uName = serverInfo.account;
        const uPwd = serverInfo.pwd;
        const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;

        const detailId = (await ctx.deployRecorder?.step(scheduleServerName, "switch", {
          serverId: serverInfo.id ?? undefined,
          serverName: serverInfo.name,
          serverIdentity: serverPathVal.identity,
          remotePath: removeSlash(serverPathVal.path),
        })) ?? null;

        /* 1.关闭服务 */
        ctx.logger.print(`正在关闭 ${scheduleServerName} 服务.`);
        let closeServiceResult;
        if (serverInfo.os === 1) {
          closeServiceResult = await switchWinService(
            ctx,
            uName,
            uPwd,
            serverAddress,
            serverPathVal.identity,
            "stop"
          );
        } else if (serverInfo.os === 2) {
          closeServiceResult = await switchDockerService(
            ctx,
            uName,
            uPwd,
            serverAddress,
            serverPathVal.identity,
            "stop"
          );
        } else {
          ctx.logger.print(
            `未找到 ${displayOs(Number(serverInfo.os))} 部署环境，请检查.`,
            "log-error"
          );
          await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: "未找到部署环境", step: "switch" });
          return false;
        }
        if (!closeServiceResult) {
          ctx.logger.print(`服务 ${scheduleServerName} 关闭失败.`, "log-error");
          await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: "关闭服务失败", step: "switch" });
          return false;
        }
        ctx.logger.print(`服务 ${scheduleServerName} 已关闭.`, "log-success");
        await ctx.deployRecorder?.done(detailId, "running", { step: "upload" });

        /* 上传文件到服务器 */
        const currLog = ctx.logger.print(`服务 ${scheduleServerName} 正在发布.`);

        // 获取项目输出路径
        let localPath = ctx.assemblyOutPath + "/" + scheduleServerName;
        const remotePath = removeSlash(serverPathVal.path);
        const projectFiles = await readDirFiles(ctx, localPath);
        if (projectFiles.length < 1) {
          ctx.logger.print(
            `未获取到 ${scheduleServerName} 项目的程序集文件，可点击【获取程序集】进行排查.`,
            "log-warning"
          );
          // return false;
        }
        let uploadFileNumber: UploadFileNumberType = {
          currNumber: 0,
          totalNumber: projectFiles.length,
          prefix: "已上传：",
        };
        // let localFiles = new Array();
        // let remoteFiles = new Array();
        for (let l = 0; l < projectFiles.length; l++) {
          await checkCanContinueHome(ctx);
          const projectFile = projectFiles[l];
          // localFiles.push(`${localPath}/${projectFile}`);
          // remoteFiles.push(`${remotePath}/${projectFile}`);
          const uploadServerFileResult = await uploadServerFilesWithRetry(
            {
              localPaths: [`${localPath}/${projectFile}`],
              remotePaths: [`${remotePath}/${projectFile}`],
              username: uName,
              password: uPwd,
              server: serverAddress,
            },
            {
              onRetry: (attempt, maxRetries, error) => {
                ctx.logger.print(
                  `文件上传失败，${getRetryArgs("upload").retry_interval_secs}s 后重试 (${attempt}/${maxRetries})：${error}`,
                  "log-warning"
                );
                ctx.deployRecorder?.done(detailId, "running", { step: "upload", retryCount: attempt });
              },
            }
          );
          if (uploadServerFileResult.code !== 0) {
            ctx.logger.print(
              `服务 ${scheduleServerName} 发布失败：${uploadServerFileResult.data}.`,
              "log-error"
            );
            await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: `服务 ${scheduleServerName} 发布失败：${uploadServerFileResult.data}`, step: "upload" });
            return false;
          }
          uploadFileNumber.currNumber++;
          currLog.content.uploadFile.prefix = uploadFileNumber.prefix;
          currLog.content.uploadFile.currNumber =
            uploadFileNumber.currNumber;
          currLog.content.uploadFile.totalNumber =
            uploadFileNumber.totalNumber;
        }

        ctx.logger.print(
          `已将 ${projectFiles.length} 个文件上传到 ${scheduleServerName} 服务器.`,
          "log-success"
        );
        await ctx.deployRecorder?.done(detailId, "running", { step: "switch" });
        ctx.logger.print(`服务 ${scheduleServerName} 正在启动.`);
        let startServiceResult;
        if (serverInfo.os === 1) {
          startServiceResult = await switchWinService(
            ctx,
            uName,
            uPwd,
            serverAddress,
            serverPathVal.identity,
            "start"
          );
        } else if (serverInfo.os === 2) {
          startServiceResult = await switchDockerService(
            ctx,
            uName,
            uPwd,
            serverAddress,
            serverPathVal.identity,
            "start"
          );
        }
        if (!startServiceResult) {
          ctx.logger.print(`服务 ${scheduleServerName} 启动失败.`, "log-error");
          await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: "启动服务失败", step: "switch" });
          return false;
        }
        ctx.logger.print(`服务 ${scheduleServerName} 发布成功.`, "log-success");
        await ctx.deployRecorder?.done(detailId, "success");
      }
    }
  }
  return true;
};

// [新]发布[WpfClient]服务
export const newPublishWpfClient = async (ctx: PublishContext) => {
  const wpfClientItem = ctx.appconfig.configItems.wpfClient;
  // 跳过判断统一走 isTypeActive（clientPath 空 / 已发布 / 已移除均跳过）
  if (!isTypeActive(wpfClientItem.clientPath, ctx.status.map.wpfClient)) return true;

  ctx.logger.print("");
  ctx.logger.print(
    `发布 ${wpfClientName} 服务[${wpfClientItem.serverName}]中，请稍等！`
  );

  // 获取[生成目录]
  if (!wpfClientItem.generateDirJson) {
    ctx.logger.print(`服务[${wpfClientName}]未配置[生成目录]，请检查.`, "log-error");
    return false;
  }
  const generateDirs = safeJsonParse<string[] | null>(wpfClientItem.generateDirJson, null);
  if (!generateDirs) {
    ctx.logger.print(`服务[${wpfClientName}]的[生成目录]配置损坏无法解析，请重新选择[生成的目录].`, "log-error");
    return false;
  }

  // 创建一个临时发布目录
  const tempPublishDir = `${ctx.assemblyOutPath}/${wpfClientName}/tempPublish`;
  const tempPublishDirExists = await cmdInvoke("exists", {
    path: tempPublishDir,
  });
  if (tempPublishDirExists.code === 0) {
    await cmdInvoke("delete_paths", {
      paths: [tempPublishDir],
    });
  }
  let createTempPathResult = await createDir(tempPublishDir);
  if (!createTempPathResult) {
    ctx.logger.print(`创建临时发布目录失败：${tempPublishDir}`, "log-error");
    return false;
  }

  // 获取[远程服务器]信息
  const serverId = wpfClientItem.serverId;
  const serverPath = wpfClientItem.serverPath;
  const serverName = wpfClientItem.serverName;
  if (!serverId) {
    ctx.logger.print(
      ` ${wpfClientName} 未选择服务或该服务器不存在，请检查.`,
      "log-error"
    );
    return false;
  }
  const serverInfo = await getServerDetail(ctx, serverId);
  if (!serverInfo) {
    ctx.logger.print(`服务[${wpfClientName}]不存在，请检查.`, "log-error");
    return false;
  }

  if (!serverPath) {
    ctx.logger.print(`服务[${wpfClientName}]未填写服务发布路径，请检查.`, "log-error");
    return false;
  }
  const uName = serverInfo.account;
  const uPwd = serverInfo.pwd;
  const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;

  // 从远程服务器下载文件到[临时缓存目录]
  let remoteFiles = [`${removeSlash(serverPath)}/Manifest.xml`];
  for (let i = 0; i < generateDirs.length; i++) {
    const generateDir = generateDirs[i];
    remoteFiles.push(`${removeSlash(serverPath)}/${generateDir}.zip`);
  }
  let localFiles = new Array<string>();
  let remoteFileNames = new Array<string>();
  for (let i = 0; i < remoteFiles.length; i++) {
    const remoteFile = remoteFiles[i];
    const subStartIndex = remoteFile.lastIndexOf("/");
    const remoteFileName = remoteFile.substring(subStartIndex + 1);
    remoteFileNames.push(remoteFileName);
    const localFile = `${tempPublishDir}/${remoteFileName}`;
    localFiles.push(localFile);
  }
  ctx.logger.print(`正在获取远程服务文件：${remoteFileNames.join("、")}`);
  const downloadServerFileResult = await cmdInvoke("download_server_files", {
    username: uName,
    password: uPwd,
    server: serverAddress,
    remotePaths: remoteFiles,
    localPaths: localFiles,
  });

  if (downloadServerFileResult.code !== 0) {
    ctx.logger.print(
      `获取远程服务文件失败：[${downloadServerFileResult.data}].`,
      "log-error"
    );
    return false;
  }
  ctx.logger.print(`获取远程服务文件成功.`, "log-success");

  // 处理下载文件
  for (let i = 0; i < localFiles.length; i++) {
    const localFile = localFiles[i];
    const lastIndex = localFile.lastIndexOf("/");
    // 判断是否为zip文件
    const fileName = `${localFile.substring(lastIndex + 1)}`;
    if (!fileName.endsWith(".zip")) continue;

    // 进行解压
    let unzipPath = removeSlash(`${localFile.substring(0, lastIndex + 1)}`);
    ctx.logger.print(`正在解压 ${fileName}.`);
    const dirName = fileName.replace(".zip", "");
    if (fileName == "Plugins.zip" || fileName == "Lib.zip") {
      unzipPath = `${unzipPath}/${dirName}`;
    }

    const unzipResult = await cmdInvoke("un_zip", {
      filePaths: [localFile],
      destination: unzipPath,
    });
    if (unzipResult.code !== 0) {
      ctx.logger.print(`解压 ${fileName} 失败：${unzipResult.data}.`, "log-error");
      return false;
    }
    ctx.logger.print(`解压 ${fileName} 成功.`, "log-success");

    // 将压缩文件删除
    await cmdInvoke("delete_paths", {
      paths: [localFile],
    });

    // 将生成的文件复制到[临时发布目录]
    let sourcePath = `${removeSlash(wpfClientItem.clientPath)}/${dirName}`;
    let destinationPath = `${removeSlash(tempPublishDir)}/${dirName}`;
    const copyResult = await cmdInvoke("copy_path", {
      source: sourcePath,
      destination: destinationPath,
      ...getRetryArgs("copy"),
    });
    if (copyResult.code !== 0) {
      ctx.logger.print(`复制文件目录 ${sourcePath} 失败.`, "log-error");
      return false;
    }

    // 重新打包压缩
    ctx.logger.print(
      `正在将 ${dirName}.zip 文件上传到 ${serverName?.replace("服务器", "")}服务器.`
    );

    let compresseResult;
    if (dirName == "Plugins" || dirName == "Lib") {
      compresseResult = await cmdInvoke("zip_dir", {
        srcDir: destinationPath,
        dstFile: `${removeSlash(tempPublishDir)}/${dirName}.zip`,
      });
    } else {
      compresseResult = await cmdInvoke("compress_zip", {
        filePaths: [destinationPath],
        dstFile: `${removeSlash(tempPublishDir)}/${dirName}.zip`,
      });
    }

    if (compresseResult.code !== 0) {
      ctx.logger.print(`压缩[${dirName}.zip]失败：${compresseResult.data}.`, "log-error");
      return false;
    }

    // 压缩成功后重新上传到服务器
    const uploadFileResult = await uploadServerFilesWithRetry({
      localPaths: [`${removeSlash(tempPublishDir)}/${dirName}.zip`],
      remotePaths: [`${removeSlash(serverPath)}/${dirName}.zip`],
      username: uName,
      password: uPwd,
      server: serverAddress,
    });
    if (uploadFileResult.code !== 0) {
      ctx.logger.print(`文件 ${dirName}.zip 上传失败.`, "log-error");
      return false;
    }
    ctx.logger.print(
      `已将 ${dirName}.zip 文件上传到 ${serverName?.replace("服务器", "")} 服务器.`,
      "log-success"
    );

    // 升级版本号
    ctx.logger.print(`正在更新 ${dirName}.zip 版本号.`);
    const localManifestFile =
      removeSlash(localFile.substring(0, lastIndex + 1)) + "/Manifest.xml";
    const upgradePluginsVersionResult = await cmdInvoke("upgrade_module_version", {
      filePath: localManifestFile,
      moduleName: dirName,
    });
    if (upgradePluginsVersionResult.code !== 0) {
      ctx.logger.print(
        `更新 ${dirName}.zip 版本号失败：${upgradePluginsVersionResult.data}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(
      `已将 ${dirName}.zip 版本号更新为 ${upgradePluginsVersionResult.data}.`,
      "log-success"
    );

    // 将本地 Manifest.xml 上传到服务器
    const remoteManifestPath = `${removeSlash(serverPath)}/Manifest.xml`;
    const uploadManifestFileResult = await uploadServerFilesWithRetry({
      localPaths: [localManifestFile],
      remotePaths: [remoteManifestPath],
      username: uName,
      password: uPwd,
      server: serverAddress,
    });
    if (uploadManifestFileResult.code !== 0) {
      ctx.logger.print(
        `文件 ${dirName}.zip 上传失败：${uploadManifestFileResult.data}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`已成功更新 ${dirName}.zip 版本号.`, "log-success");
  }

  // 发布成功，删除临时文件
  await cmdInvoke("delete_paths", {
    paths: [tempPublishDir],
  });
  return true;
};

// 发布[WpfClient]服务
export const publishWpfClient = async (ctx: PublishContext) => {
  const wpfClientItem = ctx.appconfig.configItems.wpfClient;
  // 跳过判断统一走 isTypeActive（clientPath 空 / 已发布 / 已移除均跳过）
  if (!isTypeActive(wpfClientItem.clientPath, ctx.status.map.wpfClient)) return true;

  ctx.logger.print("");
  ctx.logger.print(
    `发布 ${wpfClientName} 服务[${wpfClientItem.serverName}]中，请稍等！`
  );

  // 获取[生成目录]
  if (!wpfClientItem.generateDirJson) {
    ctx.logger.print(`服务[${wpfClientName}]未配置[生成目录]，请检查.`, "log-error");
    return false;
  }
  const generateDirs = safeJsonParse<string[] | null>(wpfClientItem.generateDirJson, null);
  if (!generateDirs) {
    ctx.logger.print(`服务[${wpfClientName}]的[生成目录]配置损坏无法解析，请重新选择[生成的目录].`, "log-error");
    return false;
  }

  // 创建一个临时发布目录
  const tempPublishDir = `${ctx.assemblyOutPath}/${wpfClientName}/tempPublish`;
  const tempPublishDirExists = await cmdInvoke("exists", {
    path: tempPublishDir,
  });
  if (tempPublishDirExists.code === 0) {
    await cmdInvoke("delete_paths", {
      paths: [tempPublishDir],
    });
  }
  let createTempPathResult = await createDir(tempPublishDir);
  if (!createTempPathResult) {
    ctx.logger.print(`创建临时发布目录失败：${tempPublishDir}`, "log-error");
    return false;
  }

  // 获取[远程服务器]信息
  const serverId = wpfClientItem.serverId;
  const serverPath = wpfClientItem.serverPath;
  const serverName = wpfClientItem.serverName;
  if (!serverId) {
    ctx.logger.print(
      ` ${wpfClientName} 未选择服务或该服务器不存在，请检查.`,
      "log-error"
    );
    return false;
  }
  const serverInfo = await getServerDetail(ctx, serverId);
  if (!serverInfo) {
    ctx.logger.print(`服务[${wpfClientName}]不存在，请检查.`, "log-error");
    return false;
  }

  if (!serverPath) {
    ctx.logger.print(`服务[${wpfClientName}]未填写服务发布路径，请检查.`, "log-error");
    return false;
  }
  const uName = serverInfo.account;
  const uPwd = serverInfo.pwd;
  const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;

  // 从远程服务器下载文件到[临时缓存目录]
  let remoteFiles = [`${removeSlash(serverPath)}/Manifest.xml`];
  if (generateDirs.includes("Domain") || generateDirs.includes("UI")) {
    remoteFiles.push(`${removeSlash(serverPath)}/Plugins.zip`);
  }
  for (let i = 0; i < generateDirs.length; i++) {
    const generateDir = generateDirs[i];
    if (generateDir == "Domain" || generateDir == "UI") continue;
    remoteFiles.push(`${removeSlash(serverPath)}/${generateDir}.zip`);
  }
  let localFiles = new Array<string>();
  let remoteFileNames = new Array<string>();
  for (let i = 0; i < remoteFiles.length; i++) {
    const remoteFile = remoteFiles[i];
    const subStartIndex = remoteFile.lastIndexOf("/");
    const remoteFileName = remoteFile.substring(subStartIndex + 1);
    remoteFileNames.push(remoteFileName);
    const localFile = `${tempPublishDir}/${remoteFileName}`;
    localFiles.push(localFile);
  }
  ctx.logger.print(`正在获取远程服务文件：${remoteFileNames.join("、")}`);
  const downloadServerFileResult = await cmdInvoke("download_server_files", {
    username: uName,
    password: uPwd,
    server: serverAddress,
    remotePaths: remoteFiles,
    localPaths: localFiles,
  });

  if (downloadServerFileResult.code !== 0) {
    ctx.logger.print(
      `获取远程服务文件失败：[${downloadServerFileResult.data}].`,
      "log-error"
    );
    return false;
  }
  ctx.logger.print(`获取远程服务文件成功.`, "log-success");

  // 处理下载文件
  for (let i = 0; i < localFiles.length; i++) {
    const localFile = localFiles[i];
    const lastIndex = localFile.lastIndexOf("/");
    // 判断是否为zip文件
    const fileName = `${localFile.substring(lastIndex + 1)}`;
    if (!fileName.endsWith(".zip")) continue;

    // 进行解压
    const unzipPath = removeSlash(`${localFile.substring(0, lastIndex + 1)}`);
    ctx.logger.print(`正在解压 ${fileName}.`);
    const unzipResult = await cmdInvoke("un_zip", {
      filePaths: [localFile],
      destination: unzipPath,
    });
    if (unzipResult.code !== 0) {
      ctx.logger.print(`解压 ${fileName} 失败：${unzipResult.data}.`, "log-error");
      return false;
    }
    ctx.logger.print(`解压 ${fileName} 成功.`, "log-success");

    // 将压缩文件删除
    await cmdInvoke("delete_paths", {
      paths: [localFile],
    });

    // 将生成的文件复制到[临时发布目录]
    const dirName = fileName.replace(".zip", "");
    if (dirName == "Plugins") {
      // --- 扁平兜底：按文件夹独立兜底（Domain/UI 各自检查），10.2+ 新版本不兜底 ---
      const isNewVersion = Boolean(ctx.appconfig.configItems.isNewVersion);
      const domainPath = `${removeSlash(wpfClientItem.clientPath)}/Domain`;
      const uiPath = `${removeSlash(wpfClientItem.clientPath)}/UI`;
      const domainExistsRes = await cmdInvoke("exists", { path: domainPath });
      const uiExistsRes = await cmdInvoke("exists", { path: uiPath });
      const domainExists = domainExistsRes.code === 0 && domainExistsRes.data === true;
      const uiExists = uiExistsRes.code === 0 && uiExistsRes.data === true;
      let flatGroups: { Domain: string[]; UI: string[]; skipped: string[] } | null = null;
      const ensureFlatGroups = async () => {
        if (flatGroups) return flatGroups;
        const readRes = await cmdInvoke("read_all_dlls", { dir: removeSlash(wpfClientItem.clientPath as string) });
        if (readRes.code !== 0 || !Array.isArray(readRes.data)) {
          ctx.logger.print(`读取目录顶层DLL失败：${readRes.data}，无法执行扁平分选兜底.`, "log-error");
          return null;
        }
        flatGroups = classifyWpfDlls(readRes.data as string[]);
        return flatGroups;
      };
      // Domain
      const destinationDomainPath = `${removeSlash(tempPublishDir)}/Domain`;
      if (domainExists) {
        const copyDomainResult = await cmdInvoke("copy_path", {
          source: domainPath,
          destination: destinationDomainPath,
          ...getRetryArgs("copy"),
        });
        if (copyDomainResult.code !== 0) {
          ctx.logger.print(`复制文件目录 ${domainPath} 失败.`, "log-error");
          return false;
        }
      } else if (!isNewVersion) {
        const groups = await ensureFlatGroups();
        if (!groups) return false;
        ctx.logger.print(
          `未检测到 Domain 文件夹，已按生成后事件规则从目录顶层分选 ${groups.Domain.length} 个DLL（跳过 ${groups.skipped.length} 个：第三方/WEB/壳程序集）`,
          "log-warning"
        );
        // 确保目标目录存在（copy_dll_files_by_names 会创建，但提前创建以保证后续 compress_zip 有目录）
        await cmdInvoke("create_dir", { path: destinationDomainPath });
        const copyDomainResult = await cmdInvoke("copy_dll_files_by_names", {
          source: removeSlash(wpfClientItem.clientPath as string),
          fileNames: groups.Domain,
          destination: destinationDomainPath,
        });
        if (copyDomainResult.code !== 0) {
          ctx.logger.print(`复制文件目录 ${domainPath} 失败.`, "log-error");
          return false;
        }
      } else {
        ctx.logger.print(`未检测到 Domain 文件夹，且当前为新版本模式，不执行扁平兜底.`, "log-error");
        return false;
      }

      // UI
      const destinationUiPath = `${removeSlash(tempPublishDir)}/UI`;
      if (uiExists) {
        const copyUiResult = await cmdInvoke("copy_path", {
          source: uiPath,
          destination: destinationUiPath,
          ...getRetryArgs("copy"),
        });
        if (copyUiResult.code !== 0) {
          ctx.logger.print(`复制文件目录 ${uiPath} 失败.`, "log-error");
          return false;
        }
      } else if (!isNewVersion) {
        const groups = await ensureFlatGroups();
        if (!groups) return false;
        ctx.logger.print(
          `未检测到 UI 文件夹，已按生成后事件规则从目录顶层分选 ${groups.UI.length} 个DLL（跳过 ${groups.skipped.length} 个：第三方/WEB/壳程序集）`,
          "log-warning"
        );
        await cmdInvoke("create_dir", { path: destinationUiPath });
        const copyUiResult = await cmdInvoke("copy_dll_files_by_names", {
          source: removeSlash(wpfClientItem.clientPath as string),
          fileNames: groups.UI,
          destination: destinationUiPath,
        });
        if (copyUiResult.code !== 0) {
          ctx.logger.print(`复制文件目录 ${uiPath} 失败.`, "log-error");
          return false;
        }
      } else {
        ctx.logger.print(`未检测到 UI 文件夹，且当前为新版本模式，不执行扁平兜底.`, "log-error");
        return false;
      }

      // 重新打包压缩
      const compressePluginsResult = await cmdInvoke("compress_zip", {
        filePaths: [destinationDomainPath, destinationUiPath],
        dstFile: `${removeSlash(tempPublishDir)}/Plugins.zip`,
      });
      if (compressePluginsResult.code !== 0) {
        ctx.logger.print(
          `压缩[Plugins.zip]失败：${compressePluginsResult.data}.`,
          "log-error"
        );
        return false;
      }

      // 压缩成功后重新上传到服务器
      ctx.logger.print(
        `正在将 Plugins.zip 文件上传到 ${serverName?.replace("服务器", "")}服务器.`
      );
      const uploadPluginsFileResult = await uploadServerFilesWithRetry({
        localPaths: [`${removeSlash(tempPublishDir)}/Plugins.zip`],
        remotePaths: [`${removeSlash(serverPath)}/Plugins.zip`],
        username: uName,
        password: uPwd,
        server: serverAddress,
      });
      if (uploadPluginsFileResult.code !== 0) {
        ctx.logger.print(`文件 Plugins.zip 上传失败.`, "log-error");
        return false;
      }
      ctx.logger.print(
        `已将 Plugins.zip 文件上传到 ${serverName?.replace("服务器", "")}服务器.`,
        "log-success"
      );
    } else {
      let sourcePath = `${removeSlash(wpfClientItem.clientPath)}/${dirName}`;
      let destinationPath = `${removeSlash(tempPublishDir)}/${dirName}`;
      const copyResult = await cmdInvoke("copy_path", {
        source: sourcePath,
        destination: destinationPath,
        ...getRetryArgs("copy"),
      });
      if (copyResult.code !== 0) {
        ctx.logger.print(`复制文件目录 ${sourcePath} 失败.`, "log-error");
        return false;
      }

      // 重新打包压缩
      ctx.logger.print(
        `正在将 ${dirName}.zip 文件上传到 ${serverName?.replace("服务器", "")}服务器.`
      );
      const compresseResult = await cmdInvoke("compress_zip", {
        filePaths: [destinationPath],
        dstFile: `${removeSlash(tempPublishDir)}/${dirName}.zip`,
      });
      if (compresseResult.code !== 0) {
        ctx.logger.print(`压缩[${dirName}.zip]失败：${compresseResult.data}.`, "log-error");
        return false;
      }

      // 压缩成功后重新上传到服务器
      const uploadFileResult = await uploadServerFilesWithRetry({
        localPaths: [`${removeSlash(tempPublishDir)}/${dirName}.zip`],
        remotePaths: [`${removeSlash(serverPath)}/${dirName}.zip`],
        username: uName,
        password: uPwd,
        server: serverAddress,
      });
      if (uploadFileResult.code !== 0) {
        ctx.logger.print(`文件 ${dirName}.zip 上传失败.`, "log-error");
        return false;
      }
      ctx.logger.print(
        `已将 ${dirName}.zip 文件上传到 ${serverName?.replace("服务器", "")} 服务器.`,
        "log-success"
      );
    }

    // 升级版本号
    ctx.logger.print(`正在更新 ${dirName}.zip 版本号.`);
    const localManifestFile =
      removeSlash(localFile.substring(0, lastIndex + 1)) + "/Manifest.xml";
    const upgradePluginsVersionResult = await cmdInvoke("upgrade_module_version", {
      filePath: localManifestFile,
      moduleName: dirName,
    });
    if (upgradePluginsVersionResult.code !== 0) {
      ctx.logger.print(
        `更新 ${dirName}.zip 版本号失败：${upgradePluginsVersionResult.data}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(
      `已将 ${dirName}.zip 版本号更新为 ${upgradePluginsVersionResult.data}.`,
      "log-success"
    );

    // 将本地 Manifest.xml 上传到服务器
    const remoteManifestPath = `${removeSlash(serverPath)}/Manifest.xml`;
    const uploadManifestFileResult = await uploadServerFilesWithRetry({
      localPaths: [localManifestFile],
      remotePaths: [remoteManifestPath],
      username: uName,
      password: uPwd,
      server: serverAddress,
    });
    if (uploadManifestFileResult.code !== 0) {
      ctx.logger.print(
        `文件 ${dirName}.zip 上传失败：${uploadManifestFileResult.data}.`,
        "log-error"
      );
      return false;
    }
    ctx.logger.print(`已成功更新 ${dirName}.zip 版本号.`, "log-success");
  }

  // 发布成功，删除临时文件
  await cmdInvoke("delete_paths", {
    paths: [tempPublishDir],
  });
  return true;
};

// 发布服务
export const serverPublish = async (
  ctx: PublishContext,
  server: RowServerType,
  serverPathArr: ServerOptionType[],
  serverName: string
) => {
  for (let j = 0; j < serverPathArr.length; j++) {
    const serverPath = serverPathArr[j];
    if (!serverPath.value) {
      ctx.logger.print(`服务[${server.name}]未配置，请检查.`, "log-error");
      return false;
    }
    for (let k = 0; k < serverPath.value.length; k++) {
      const serverPathVal = serverPath.value[k];
      if (!serverPathVal.identity) {
        ctx.logger.print(`服务[${server.name}]未填写服务标识，请检查.`, "log-error");
        return false;
      }
      if (!serverPathVal.path) {
        ctx.logger.print(`服务[${server.name}]未填写服务发布路径，请检查.`, "log-error");
        return false;
      }
      const uName = server.account;
      const uPwd = server.pwd;
      const serverAddress = `${server.ip}:${server.port}`;

      const detailId = (await ctx.deployRecorder?.step(serverName, "switch", {
        serverId: server.id ?? undefined,
        serverName: server.name,
        serverIdentity: serverPathVal.identity,
        remotePath: removeSlash(serverPathVal.path),
      })) ?? null;

      /* 1.关闭服务 */
      ctx.logger.print(`正在关闭 ${serverName} 服务.`);
      let closeServiceResult;
      if (server.os === 1) {
        closeServiceResult = await switchWinService(
          ctx,
          uName,
          uPwd,
          serverAddress,
          serverPathVal.identity,
          "stop"
        );
      } else if (server.os === 2) {
        closeServiceResult = await switchDockerService(
          ctx,
          uName,
          uPwd,
          serverAddress,
          serverPathVal.identity,
          "stop"
        );
      } else {
        ctx.logger.print(
          `未找到 ${displayOs(Number(server.os))} 部署环境，请检查.`,
          "log-error"
        );
        await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: "未找到部署环境", step: "switch" });
        return false;
      }
      if (!closeServiceResult) {
        ctx.logger.print(`服务 ${serverName} 关闭失败.`, "log-error");
        await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: "关闭服务失败", step: "switch" });
        return false;
      }
      ctx.logger.print(`服务 ${serverName} 已关闭.`, "log-success");
      await ctx.deployRecorder?.done(detailId, "running", { step: "upload" });

      /* 上传文件到服务器 */
      const currLog = ctx.logger.print(`服务 ${serverName} 正在发布.`);

      // 获取项目输出路径
      let localPath = ctx.assemblyOutPath + "/" + serverName;
      const remotePath = removeSlash(serverPathVal.path);
      const projectFiles = await readDirFiles(ctx, localPath);
      if (projectFiles.length < 1) {
        ctx.logger.print(
          `未获取到 ${serverName} 项目的程序集文件，可点击【获取程序集】排查.`,
          "log-warning"
        );
        // return;
      }
      let uploadFileNumber: UploadFileNumberType = {
        currNumber: 0,
        totalNumber: projectFiles.length,
        prefix: "已上传：",
      };
      for (let l = 0; l < projectFiles.length; l++) {
        await checkCanContinueHome(ctx);
        const projectFile = projectFiles[l];
        const uploadServerFileResult = await uploadServerFilesWithRetry(
          {
            localPaths: [`${localPath}/${projectFile}`],
            remotePaths: [`${remotePath}/${projectFile}`],
            username: uName,
            password: uPwd,
            server: serverAddress,
          },
          {
            onRetry: (attempt, maxRetries, error) => {
              ctx.logger.print(
                `文件上传失败，${getRetryArgs("upload").retry_interval_secs}s 后重试 (${attempt}/${maxRetries})：${error}`,
                "log-warning"
              );
              ctx.deployRecorder?.done(detailId, "running", { step: "upload", retryCount: attempt });
            },
          }
        );
        if (uploadServerFileResult.code !== 0) {
          ctx.logger.print(
            `服务 ${serverName} 发布失败：${uploadServerFileResult.data}.`,
            "log-error"
          );
          await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: `服务 ${serverName} 发布失败：${uploadServerFileResult.data}`, step: "upload" });
          return false;
        }
        uploadFileNumber.currNumber++;
        currLog.content.uploadFile.prefix =
          uploadFileNumber.prefix;
        currLog.content.uploadFile.currNumber =
          uploadFileNumber.currNumber;
        currLog.content.uploadFile.totalNumber =
          uploadFileNumber.totalNumber;
      }
      ctx.logger.print(
        `已将 ${projectFiles.length} 个文件上传到 ${serverName}服务器.`,
        "log-success"
      );
      await ctx.deployRecorder?.done(detailId, "running", { step: "switch" });
      ctx.logger.print(`服务 ${serverName} 正在启动.`);
      let startServiceResult;
      if (server.os === 1) {
        startServiceResult = await switchWinService(
          ctx,
          uName,
          uPwd,
          serverAddress,
          serverPathVal.identity,
          "start"
        );
      } else if (server.os === 2) {
        startServiceResult = await switchDockerService(
          ctx,
          uName,
          uPwd,
          serverAddress,
          serverPathVal.identity,
          "start"
        );
      }
      if (!startServiceResult) {
        ctx.logger.print(`服务 ${serverName} 启动失败.`, "log-error");
        await ctx.deployRecorder?.done(detailId, "failed", { errorMessage: "启动服务失败", step: "switch" });
        return false;
      }
      ctx.logger.print(`服务 ${serverName} 发布成功.`, "log-success");
      await ctx.deployRecorder?.done(detailId, "success");
    }
  }
  return true;
};

// 切换Windows服务
export const switchWinService = async (
  ctx: PublishContext,
  username: string,
  password: string,
  server: string,
  serviceName: string,
  action: "stop" | "start"
) => {
  const isStop = await isWinServiceStop(username, password, server, serviceName);
  if (action == "stop" && isStop) return true;
  if (action == "start" && !isStop) return true;

  // 使用 sc stop/start 代替 net stop/start，避免 SSH 会话中执行不彻底的问题
  const switchServerResult = await cmdInvoke("execute_remote_command", {
    username,
    password,
    server,
    command: `sc ${action} "${serviceName}"`,
    ...getRetryArgs("serviceStop"),
  });
  if (switchServerResult.code !== 0) {
    ctx.logger.print(switchServerResult.data, "log-error");
    return false;
  }

  // 轮询等待服务达到目标状态（sc 命令为非阻塞，需轮询确认），
  // 避免服务句柄未释放就复制文件导致文件锁定失败
  // 最多等待 5 分钟：150 次 × 2s = 300s
  const maxRetries = 150;
  const retryInterval = 2000;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((resolve) => setTimeout(resolve, retryInterval));
    const stopped = await isWinServiceStop(username, password, server, serviceName);
    if (action === "stop" && stopped) return true;
    if (action === "start" && !stopped) return true;
    // 每 10 次迭代（约每 20s）输出一次等待进度
    if ((i + 1) % 10 === 0) {
      ctx.logger.print(
        `等待服务${action === "stop" ? "停止" : "启动"}…已等待 ${
          (i + 1) * (retryInterval / 1000)
        } s（最长 300s）`
      );
    }
  }

  ctx.logger.print(
    `服务 ${serviceName} ${action === "stop" ? "关闭" : "启动"}超时，请手动检查.`,
    "log-warning"
  );
  return false;
};

// 切换Docker服务
export const switchDockerService = async (
  ctx: PublishContext,
  username: string,
  password: string,
  server: string,
  serviceName: string,
  action: "stop" | "start"
) => {
  const switchServerResult = await cmdInvoke("execute_remote_command", {
    username,
    password,
    server,
    command: `docker ${action} ${serviceName}`,
  });
  if (switchServerResult.code !== 0) ctx.logger.print(switchServerResult.data, "log-error");
  return switchServerResult.code === 0;
};

// 验证[Windows]服务是否已关闭
const isWinServiceStop = async (
  username: string,
  password: string,
  server: string,
  serviceName: string
) => {
  const invokeResult = await cmdInvoke<string>("execute_remote_command", {
    username,
    password,
    server,
    command: `sc query "${serviceName}"`,
  });
  if (invokeResult.data.includes("STOPPED")) {
    return true;
  }
  return false;
};

// 读取目录中的文件
const readDirFiles = async (ctx: PublishContext, dirPath: string) => {
  const readFilesResult = await cmdInvoke("read_files", { path: dirPath });
  if (readFilesResult.code !== 0) {
    ctx.logger.print(readFilesResult.data, "log-error");
    return [];
  }
  return readFilesResult.data as string[];
};

// 编译项目
export const buildProjects = async (ctx: PublishContext) => {
  // MSBuild编译
  let msBuildPath = removeSlash(String(ctx.appconfig.msBuildPath));
  let isRebuild = ctx.appconfig.configItems.isRebuild == 1;
  if (!msBuildPath) {
    ctx.logger.print("[MsBuild路径]不能为空，请检查.", "log-error");
    return false;
  }
  const msBuildPathExists = await cmdInvoke("exists", {
    path: msBuildPath,
  });
  if (msBuildPathExists.code !== 0) {
    ctx.logger.print(`"MsBuild路径[${msBuildPath}]不存在，请检查.`, "log-error");
    return false;
  }

  // 项目配置信息
  let projectHosts = getConfigItemHosts(ctx);
  let isSuccess = true;
  for (let i = 0; i < projectHosts.length; i++) {
    const projectHost = projectHosts[i];
    if (!projectHost.hostItem.clientPath) continue;

    // 删除生成目录
    const clientPathExists = await cmdInvoke("exists", {
      path: projectHost.hostItem.clientPath,
    });
    if (clientPathExists.code === 0) {
      await cmdInvoke("delete_paths", {
        paths: [projectHost.hostItem.clientPath],
      });
    }

    // 编译中
    ctx.logger.print(`正在编译 ${projectHost.csprojFile} 项目.`);
    let clientPath = projectHost.hostItem.clientPath.split("bin")[0];
    let webApiHostPath = `${removeSlash(clientPath)}/${projectHost.csprojFile}`;
    const buildResult = await cmdInvoke("build_project_release", {
      projectFilePath: webApiHostPath,
      msbuildPath: msBuildPath,
      isRebuild,
      buildMode: ctx.appconfig.buildMode || "Release",
    });

    // 编译结果
    if (buildResult.code === 0) {
      ctx.logger.print(`编译 ${projectHost.csprojFile} 成功.`, "log-success");
    } else {
      ctx.logger.print(
        `编译 ${projectHost.csprojFile} 失败：${buildResult.data}`,
        "log-error"
      );
      isSuccess = false;
    }
  }

  ctx.logger.print("编译项目结束。");

  return isSuccess;
};

// 解析程序集输出路径（原 getProjectOutPath：页面 projectList 兜底 → 此处按 id 查库，供调度器等无页面上下文场景）
export const resolveAssemblyOutPath = async (
  projectId: number | null,
  projectName: string,
  environment: number,
  logger: PublishContext["logger"]
): Promise<string> => {
  let assemblyOutPath = "";
  if (projectId != null) {
    const r = await projectDb.getProjectById(projectId);
    if (r.code === 0 && r.data.data?.assemblyOutPath) {
      assemblyOutPath = String(r.data.data.assemblyOutPath);
    }
  }
  if (!assemblyOutPath) {
    assemblyOutPath = `${await path.appLocalDataDir()}`;
    logger.print(`未配置程序集输出路径，将采用默认路径：${assemblyOutPath}`, "log-warning");
  }
  return `${removeSlash(assemblyOutPath)}/${projectName}/${displayEnvironment(environment)}`;
};

// 获取应用程序集
export const getApplicationAssemblys = async (ctx: PublishContext, isOpenDir: boolean = false) => {
  // 获取项目输出路径
  let projectOutPath = ctx.assemblyOutPath;
  let isSuccess = true;
  ctx.logger.print("");
  // 获取[WebApiHost]应用程序集
  if (isTypeActive(ctx.appconfig.configItems.webApiHost.clientPath, ctx.status.map.webApiHost)) {
    const copyWebApiResult = await copyAssemblyFile(
      ctx,
      "WebApiHost",
      projectOutPath,
      ctx.appconfig.configItems.webApiHost
    );
    isSuccess = copyWebApiResult;
  }

  // 获取[ScheduleServer]应用程序集
  if (isTypeActive(ctx.appconfig.configItems.scheduleServer.clientPath, ctx.status.map.scheduleServer)) {
    const copyScheduleServerResult = await copyAssemblyFile(
      ctx,
      "ScheduleServer",
      projectOutPath,
      ctx.appconfig.configItems.scheduleServer
    );
    if (!copyScheduleServerResult) isSuccess = false;
  }

  // 获取[WebClient]应用程序集
  if (isTypeActive(ctx.appconfig.configItems.webClient.clientPath, ctx.status.map.webClient)) {
    const copyWebClientResult = await copyAssemblyFile(
      ctx,
      "WebClient",
      projectOutPath,
      ctx.appconfig.configItems.webClient
    );
    if (!copyWebClientResult) isSuccess = false;
  }

  // 获取[SpcMonitor]应用程序集
  if (isTypeActive(ctx.appconfig.configItems.spcMonitor.clientPath, ctx.status.map.spcMonitor)) {
    const copySpcMonitorResult = await copyAssemblyFile(
      ctx,
      "SpcMonitor",
      projectOutPath,
      ctx.appconfig.configItems.spcMonitor
    );
    if (!copySpcMonitorResult) isSuccess = false;
  }

  // 获取[WpfClient]应用程序集
  if (isTypeActive(ctx.appconfig.configItems.wpfClient.clientPath, ctx.status.map.wpfClient)) {
    let copyWpfClientResult = false;
    if (ctx.appconfig.configItems.isNewVersion) {
      // 新版
      copyWpfClientResult = await newCopyWpfAssemblyFile(
        ctx,
        projectOutPath,
        ctx.appconfig.configItems.wpfClient
      );
    } else {
      // 旧版
      copyWpfClientResult = await copyWpfAssemblyFile(
        ctx,
        projectOutPath,
        ctx.appconfig.configItems.wpfClient
      );
    }

    if (!copyWpfClientResult) isSuccess = false;
  }

  ctx.logger.print("获取程序集结束。");

  // 获取结果汇总：各参与服务文件数与修改时间范围（防日期选错）
  const summary = await collectServiceFileSummary(ctx);
  if (summary.items.length > 0) {
    const parts = summary.items.map((i) => `${i.service} ${i.count} 个文件（修改时间 ${i.timeRange}）`);
    ctx.logger.print(`获取程序集完成：${parts.join("、")}。`, "log-success");
    const dateRange = getDllModeDateRange(ctx);
    if (dateRange.length === 2) {
      for (const item of summary.items) {
        const latest = item.files.map((f) => f.modifiedTime).filter(Boolean).sort().pop();
        if (latest && latest < dateRange[0]) {
          ctx.logger.print(`⚠ ${item.service} 命中文件的最新修改时间（${latest}）早于所选起始日期（${dateRange[0]}），请确认日期范围是否选错！`, "log-warning");
        }
      }
    }
  }

  // DLL名称模式下生成发布日志
  if (ctx.appconfig.dllMode == "DLL名称" && ctx.generatePublishLog.isEnable) {
    const patterns = getDllModePatterns(ctx);
    if (patterns) {
      const content = `DLL名称匹配模式：\n${patterns}`;
      const logFilePath = `${removeSlash(ctx.assemblyOutPath)}/SMOM发布日志_${formatDate(new Date(), "YYYYmmddHHMMSS")}.log`;
      const saveResult = await cmdInvoke("save_content_to_file", {
        content,
        filePath: logFilePath
      });
      if (saveResult.code === 0) {
        ctx.generatePublishLog.logs = `日志信息已保存到: ${logFilePath}`;
      }
    }
  }

  // 打开输出目录
  if (isOpenDir) await cmdInvoke("open_dir", { path: projectOutPath });
  return isSuccess;
};

// 收集各参与服务输出子目录的文件清单（确认弹窗数据源；目录结构与获取流程一致：{assemblyOutPath}/{Pascal名}）
export const collectServiceFileSummary = async (ctx: PublishContext): Promise<PublishFileSummary> => {
  const items: PublishFileItem[] = [];
  const scanFailed: string[] = [];
  for (const { key, pascal } of APP_TYPE_ORDER) {
    if (!isTypeActive((ctx.appconfig.configItems as any)[key]?.clientPath, ctx.status.map[key])) continue;
    const dirPath = `${removeSlash(ctx.assemblyOutPath)}/${pascal}`;
    const result = await cmdInvoke("list_files_with_meta", { path: dirPath });
    if (result.code !== 0 || !Array.isArray(result.data)) {
      scanFailed.push(pascal);
      continue;
    }
    const files = (result.data as any[]).map((f) => ({
      name: String(f.name ?? ""),
      modifiedTime: String(f.modifiedTime ?? ""),
      size: Number(f.size ?? 0),
    }));
    const times = files.map((f) => f.modifiedTime).filter(Boolean).sort();
    items.push({
      service: pascal,
      count: files.length,
      timeRange: times.length ? `${times[0]} ~ ${times[times.length - 1]}` : "-",
      files,
    });
  }
  return { items, scanFailed };
};

// 获取Dll日期范围
export const getDllModeDateRange = (ctx: PublishContext) => {
  let startDate = "";
  let endDate = "";
  if (ctx.appconfig.dllMode == "当天") {
    startDate = formatDate(new Date(), "YYYY-mm-dd 00:00:00");
    endDate = formatDate(new Date(), "YYYY-mm-dd 23:59:59");
  }
  if (ctx.appconfig.dllMode == "最近3天") {
    const threeDaysAgo = new Date(new Date().getTime() - 3 * 24 * 60 * 60 * 1000);
    startDate = formatDate(threeDaysAgo, "YYYY-mm-dd 00:00:00");
    endDate = formatDate(new Date(), "YYYY-mm-dd 23:59:59");
  }
  if (ctx.appconfig.dllMode == "日期范围") {
    // 解析失败保持 startDate/endDate 为空，走下方原有 `return []` 分支
    const modeDates = safeJsonParse<string[] | null>(
      ctx.appconfig.dllModeValue,
      null
    );
    if (modeDates) {
      startDate = modeDates[0];
      endDate = modeDates[1];
    }
  }
  if (!startDate || !endDate) return [];
  return [startDate, endDate];
};

// 获取DLL名称模式
export const getDllModePatterns = (ctx: PublishContext) => {
  if (ctx.appconfig.dllMode == "DLL名称") {
    return String(ctx.appconfig.dllModeValue || "");
  }
  return "";
};

// [新]复制Wpf应用程序集[文件]
export const newCopyWpfAssemblyFile = async (
  ctx: PublishContext,
  projectOutPath: string,
  appConfig: WpfClientConfigType
) => {
  ctx.logger.print(`正在获取 ${wpfClientName} 程序集.`);

  // 删除项目输出目录
  let outPath = `${projectOutPath}/${wpfClientName}`;
  const projectOutPathExists = await cmdInvoke("exists", {
    path: outPath,
  });
  if (projectOutPathExists.code === 0) {
    await cmdInvoke("delete_paths", {
      paths: [outPath],
    });
  }
  let createPathResult = await createDir(outPath);
  if (!createPathResult) {
    ctx.logger.print(`创建目录失败：${outPath}`, "log-error");
    return false;
  }
  if (!appConfig.clientPath) {
    ctx.logger.print(`${wpfClientName} 的[客户端生成路径]未配置，请检查.`, "log-error");
    return false;
  }
  if (!appConfig.generateDirJson) {
    ctx.logger.print(`${wpfClientName} 未选择[生成的目录]，请检查.`, "log-error");
    return false;
  }

  try {
    let dllModeDateRange = getDllModeDateRange(ctx);
    // 1.[生成目录]（上方已守卫非空；损坏无法解析时走失败分支，不再以异常中断）
    const generateDirArr = safeJsonParse<string[] | null>(appConfig.generateDirJson, null);
    if (!generateDirArr) {
      ctx.logger.print(`${wpfClientName} 的[生成目录]配置损坏无法解析，请重新选择[生成的目录].`, "log-error");
      return false;
    }
    for (let i = 0; i < generateDirArr.length; i++) {
      const generateDir = generateDirArr[i];
      // 验证目录是否存在
      const dirPath = `${removeSlash(appConfig.clientPath)}/${generateDir}`;
      if (generateDir == "Plugins" || generateDir == "Lib") {
        await cmdInvoke("delete_paths", {
          paths: [dirPath],
        });
        await createDir(dirPath);
        let cmdName = generateDir == "Plugins" ? "copy_sie_dlls" : "copy_non_sie_dlls";
        let copyDllFileResult = await cmdInvoke(cmdName, {
          srcDir: removeSlash(appConfig.clientPath),
          destDir: dirPath,
        });
        if (copyDllFileResult.code !== 0) {
          ctx.logger.print(
            `${generateDir}目录不存在，请检查路径或编译项目试试.`,
            "log-error"
          );
          return false;
        }
      }
      const dirPathExists = await cmdInvoke("exists", { path: dirPath });
      if (dirPathExists.code !== 0) {
        ctx.logger.print(`${generateDir}目录不存在，请检查路径或编译项目试试.`, "log-error");
        return false;
      }

      // 复制目录
      let copyResult = {
        code: 0,
        msg: "success",
        data: null,
      };
      const toGenerateDir = `${removeSlash(outPath)}/${generateDir}`;
      await createDir(toGenerateDir);

      if (ctx.appconfig.dllMode == "TFS") {
        if (!ctx.appconfig.dllModeValue) {
          ctx.logger.print(`未配置TFS获取程序集的相关信息，请检查.`, "log-error");
          return false;
        }
        const selectTfsItem = safeJsonParse<SelectTfsType | null>(
          ctx.appconfig.dllModeValue,
          null
        );
        if (!selectTfsItem) {
          ctx.logger.print(`TFS获取程序集的配置信息损坏无法解析，请重新选择.`, "log-error");
          return false;
        }
        const tfsDllFiles = await getTfsDllFiles(ctx, selectTfsItem);
        if (!tfsDllFiles || tfsDllFiles.length < 1) return false;

        for (let j = 0; j < tfsDllFiles.length; j++) {
          const tfsDllFile = tfsDllFiles[j];
          const clientPath = removeSlash(dirPath);
          copyResult = await cmdInvoke("copy_path", {
            source: `${clientPath}/${tfsDllFile}`,
            destination: `${toGenerateDir}/${tfsDllFile}`,
            ...getRetryArgs("copy"),
          });
          if (copyResult.code !== 0) break;
        }
      } else if (ctx.appconfig.dllMode == "DLL名称") {
        const patterns = getDllModePatterns(ctx);
        if (!patterns) {
          ctx.logger.print(`未配置DLL名称获取程序集的相关信息，请检查.`, "log-error");
          return false;
        }
        copyResult = await cmdInvoke("copy_dll_files_by_name", {
          source: dirPath,
          destination: `${outPath}/${generateDir}`,
          patterns: patterns,
        });
      } else {
        if (dllModeDateRange.length < 1) {
          copyResult = await cmdInvoke("copy_path", {
            source: dirPath,
            destination: `${outPath}/${generateDir}`,
            ...getRetryArgs("copy"),
          });
        } else {
          copyResult = await cmdInvoke("copy_path_by_time", {
            source: dirPath,
            destination: `${outPath}/${generateDir}`,
            startTime: dllModeDateRange[0],
            endTime: dllModeDateRange[1],
          });
        }
      }

      if (copyResult.code !== 0) {
        ctx.logger.print(`复制[${generateDir}]失败：${copyResult.data}`, "log-error");
        return false;
      }

      // 验证文件是否存在
      const isDirEmpty = await cmdInvoke("is_dir_empty", {
        path: `${outPath}/${generateDir}`,
      });
      if (isDirEmpty.code !== 0) {
        ctx.logger.print(`输出路径为空：${`${outPath}/${generateDir}`}.`, "log-warning");
      }
    }

    // 2.[打包(压缩)文件]
    if (appConfig.isCompress == 1) {
      if (!appConfig.compressFileJson) {
        ctx.logger.print(
          `${wpfClientName} 未选择要打包(压缩)文件，请检查.`,
          "log-error"
        );
        return false;
      }

      const compressFileArr = safeJsonParse<string[] | null>(appConfig.compressFileJson, null);
      if (!compressFileArr) {
        ctx.logger.print(`${wpfClientName} 的打包(压缩)文件配置损坏无法解析，请重新选择要打包(压缩)文件.`, "log-error");
        return false;
      }
      if (compressFileArr.includes("Plugins.zip")) {
        const pluginsPath = `${removeSlash(appConfig.clientPath)}/Plugins`;
        const pluginsZipResult = await cmdInvoke("zip_dir", {
          srcDir: pluginsPath,
          dstFile: `${outPath}/Plugins.zip`,
        });
        if (pluginsZipResult.code !== 0) {
          ctx.logger.print(`压缩[Plugins.zip]失败：${pluginsZipResult.data}.`, "log-error");
          return false;
        }
      }

      if (compressFileArr.includes("Lib.zip")) {
        const libPath = `${removeSlash(appConfig.clientPath)}/Lib`;
        const libZipResult = await cmdInvoke("zip_dir", {
          srcDir: libPath,
          dstFile: `${outPath}/Lib.zip`,
        });
        if (libZipResult.code !== 0) {
          ctx.logger.print(`压缩[Lib.zip]失败：${libZipResult.data}.`, "log-error");
          return false;
        }
      }

      if (compressFileArr.includes("runtimes.zip")) {
        const tempRuntimesPath = `${removeSlash(
          appConfig.clientPath
        )}/tmp_runtimes/runtimes`;
        await cmdInvoke("delete_paths", {
          paths: [tempRuntimesPath],
        });
        await createDir(tempRuntimesPath);

        const addRuntimesPath = `${removeSlash(appConfig.clientPath)}/runtimes`;
        await cmdInvoke("copy_path", {
          source: addRuntimesPath,
          destination: tempRuntimesPath,
          ...getRetryArgs("copy"),
        });

        const zipRuntimesResult = await cmdInvoke("zip_dir", {
          srcDir: `${removeSlash(appConfig.clientPath)}/tmp_runtimes`,
          dstFile: `${outPath}/runtimes.zip`,
        });
        if (zipRuntimesResult.code !== 0) {
          ctx.logger.print(`压缩[runtimes.zip]失败：${zipRuntimesResult.data}.`, "log-error");
          return false;
        }

        await cmdInvoke("delete_paths", {
          paths: [tempRuntimesPath],
        });
      }

      if (compressFileArr.includes("AddIns.zip")) {
        const addInsPath = `${removeSlash(appConfig.clientPath)}/AddIns`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [addInsPath],
          dstFile: `${outPath}/AddIns.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(
            `压缩[AddIns.zip]失败：${compresseAddInsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Localization.zip")) {
        const localizationPath = `${removeSlash(appConfig.clientPath)}/Localization`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [localizationPath],
          dstFile: `${outPath}/Localization.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(
            `压缩[Localization.zip]失败：${compresseAddInsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Templates.zip")) {
        const templatesPath = `${removeSlash(appConfig.clientPath)}/Templates`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [templatesPath],
          dstFile: `${outPath}/Templates.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(
            `压缩[Templates.zip]失败：${compresseAddInsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Config.zip")) {
        // 将log4net.config、SIE.MOM.deps.json、SIE.MOM.runtimeconfig.json、RazorTemplate.txt、appsettings.json打包 -->  Config.zip
        const log4netConfigFile = `${removeSlash(appConfig.clientPath)}/log4net.config`;
        const log4netConfigFileExists = await cmdInvoke("exists", {
          path: log4netConfigFile,
        });
        if (log4netConfigFileExists.code !== 0) {
          ctx.logger.print(
            "未找到log4net.config文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const sieMomDepsFile = `${removeSlash(appConfig.clientPath)}/SIE.MOM.deps.json`;
        const sieMomDepsFileExists = await cmdInvoke("exists", {
          path: sieMomDepsFile,
        });
        if (sieMomDepsFileExists.code !== 0) {
          ctx.logger.print(
            "未找到SIE.MOM.deps.json文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const sieMomRuntimeconfigFile = `${removeSlash(
          appConfig.clientPath
        )}/SIE.MOM.runtimeconfig.json`;
        const sieMomRuntimeconfigFileExists = await cmdInvoke("exists", {
          path: sieMomRuntimeconfigFile,
        });
        if (sieMomRuntimeconfigFileExists.code !== 0) {
          ctx.logger.print(
            "未找到SIE.MOM.runtimeconfig.json文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const sieMomRazorTemplateFile = `${removeSlash(
          appConfig.clientPath
        )}/RazorTemplate.txt`;
        const sieMomRazorTemplateFileExists = await cmdInvoke("exists", {
          path: sieMomRazorTemplateFile,
        });
        if (sieMomRazorTemplateFileExists.code !== 0) {
          ctx.logger.print(
            "未找到RazorTemplate.txt文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const appsettingsFile = `${removeSlash(appConfig.clientPath)}/appsettings.json`;
        const appsettingsFileExists = await cmdInvoke("exists", {
          path: appsettingsFile,
        });
        if (appsettingsFileExists.code !== 0) {
          ctx.logger.print(
            "未找到appsettings.json文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const compresseConfigResult = await cmdInvoke("compress_zip", {
          filePaths: [
            log4netConfigFile,
            sieMomDepsFile,
            sieMomRuntimeconfigFile,
            sieMomRazorTemplateFile,
            appsettingsFile,
          ],
          dstFile: `${outPath}/Config.zip`,
        });
        if (compresseConfigResult.code !== 0) {
          ctx.logger.print(
            `压缩[Config.zip]失败：${compresseConfigResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Main.zip")) {
        // 将SIE.dll、SIE.MOM.exe、SIE.Wpf.dll打包 -->  Main.zip
        const sieDllFile = `${removeSlash(appConfig.clientPath)}/SIE.dll`;
        const sieDllFileExists = await cmdInvoke("exists", { path: sieDllFile });
        if (sieDllFileExists.code !== 0) {
          ctx.logger.print("未找到SIE.dll文件，请检查路径或编译项目试试.", "log-error");
          return false;
        }

        const sieMomExeFile = `${removeSlash(appConfig.clientPath)}/SIE.MOM.exe`;
        const sieMomExeFileExists = await cmdInvoke("exists", { path: sieMomExeFile });
        if (sieMomExeFileExists.code !== 0) {
          ctx.logger.print("未找到SIE.MOM.exe文件，请检查路径或编译项目试试.", "log-error");
          return false;
        }

        const sieWpfDllFile = `${removeSlash(appConfig.clientPath)}/SIE.Wpf.dll`;
        const sieWpfDllFileExists = await cmdInvoke("exists", { path: sieWpfDllFile });
        if (sieWpfDllFileExists.code !== 0) {
          ctx.logger.print("未找到SIE.Wpf.dll文件，请检查路径或编译项目试试.", "log-error");
          return false;
        }

        const compresseMainResult = await cmdInvoke("compress_zip", {
          filePaths: [sieDllFile, sieMomExeFile, sieWpfDllFile],
          dstFile: `${outPath}/Main.zip`,
        });
        if (compresseMainResult.code !== 0) {
          ctx.logger.print(`压缩[Main.zip]失败：${compresseMainResult.data}.`, "log-error");
          return false;
        }
      }
    }
  } catch (error) {
    ctx.logger.print(
      `获取程序集 ${wpfClientName} 出错：${JSON.stringify(error)}`,
      "log-error"
    );
    return false;
  }
  ctx.logger.print(`获取程序集 ${wpfClientName} 成功.`, "log-success");
  return true;
};

// 复制Wpf应用程序集[文件]
export const copyWpfAssemblyFile = async (
  ctx: PublishContext,
  projectOutPath: string,
  appConfig: WpfClientConfigType
) => {
  ctx.logger.print(`正在获取 ${wpfClientName} 程序集.`);

  // 删除项目输出目录
  let outPath = `${projectOutPath}/${wpfClientName}`;
  const projectOutPathExists = await cmdInvoke("exists", {
    path: outPath,
  });
  if (projectOutPathExists.code === 0) {
    await cmdInvoke("delete_paths", {
      paths: [outPath],
    });
  }
  let createPathResult = await createDir(outPath);
  if (!createPathResult) {
    ctx.logger.print(`创建目录失败：${outPath}`, "log-error");
    return false;
  }
  if (!appConfig.clientPath) {
    ctx.logger.print(`${wpfClientName} 的[客户端生成路径]未配置，请检查.`, "log-error");
    return false;
  }
  if (!appConfig.generateDirJson) {
    ctx.logger.print(`${wpfClientName} 未选择[生成的目录]，请检查.`, "log-error");
    return false;
  }

  try {
    let dllModeDateRange = getDllModeDateRange(ctx);
    // --- 扁平自愈兜底：缺失的 Domain/UI 文件夹按生成后事件规则补建（copy 不动顶层原文件），10.2+ 新版本不兜底 ---
    // 自愈后：下方目录存在性检查、各 dllMode 的复制、Plugins.zip 压缩（直接取 clientPath/Domain、clientPath/UI）均无需改动。
    if (!Boolean(ctx.appconfig.configItems.isNewVersion)) {
      const clientRoot = removeSlash(appConfig.clientPath);
      let flatGroups: { Domain: string[]; UI: string[]; skipped: string[] } | null = null;
      const ensureFlatGroups = async () => {
        if (flatGroups) return flatGroups;
        const readRes = await cmdInvoke("read_all_dlls", { dir: clientRoot });
        if (readRes.code !== 0 || !Array.isArray(readRes.data)) {
          ctx.logger.print(`读取目录顶层DLL失败：${readRes.data}，无法执行扁平自愈兜底.`, "log-error");
          return null;
        }
        flatGroups = classifyWpfDlls(readRes.data as string[]);
        return flatGroups;
      };
      for (const healDir of ["Domain", "UI"] as const) {
        const healPath = `${clientRoot}/${healDir}`;
        const healExistsRes = await cmdInvoke("exists", { path: healPath });
        if (healExistsRes.code === 0) continue;
        const groups = await ensureFlatGroups();
        if (!groups) return false;
        await cmdInvoke("create_dir", { path: healPath });
        const healCopyRes = await cmdInvoke("copy_dll_files_by_names", {
          source: clientRoot,
          fileNames: groups[healDir],
          destination: healPath,
        });
        if (healCopyRes.code !== 0) {
          ctx.logger.print(`自愈补建 ${healDir} 文件夹失败：${healCopyRes.data}.`, "log-error");
          return false;
        }
        ctx.logger.print(
          `未检测到 ${healDir} 文件夹，已按生成后事件规则自愈补建（复制 ${groups[healDir].length} 个DLL，跳过 ${groups.skipped.length} 个：第三方/WEB/壳程序集）`,
          "log-warning"
        );
      }
    }
    // 1.[生成目录]（前方已守卫非空；损坏无法解析时走失败分支，不再以异常中断）
    const generateDirArr = safeJsonParse<string[] | null>(appConfig.generateDirJson, null);
    if (!generateDirArr) {
      ctx.logger.print(`${wpfClientName} 的[生成目录]配置损坏无法解析，请重新选择[生成的目录].`, "log-error");
      return false;
    }
    for (let i = 0; i < generateDirArr.length; i++) {
      const generateDir = generateDirArr[i];
      // 验证目录是否存在
      const dirPath = `${removeSlash(appConfig.clientPath)}/${generateDir}`;
      const dirPathExists = await cmdInvoke("exists", { path: dirPath });
      if (dirPathExists.code !== 0) {
        ctx.logger.print(`${generateDir}目录不存在，请检查路径或编译项目试试.`, "log-error");
        return false;
      }

      // 复制目录
      let copyResult = {
        code: 0,
        msg: "success",
        data: null,
      };
      const toGenerateDir = `${removeSlash(outPath)}/${generateDir}`;
      await createDir(toGenerateDir);

      if (ctx.appconfig.dllMode == "TFS") {
        if (!ctx.appconfig.dllModeValue) {
          ctx.logger.print(`未配置TFS获取程序集的相关信息，请检查.`, "log-error");
          return false;
        }
        const selectTfsItem = safeJsonParse<SelectTfsType | null>(
          ctx.appconfig.dllModeValue,
          null
        );
        if (!selectTfsItem) {
          ctx.logger.print(`TFS获取程序集的配置信息损坏无法解析，请重新选择.`, "log-error");
          return false;
        }
        const tfsDllFiles = await getTfsDllFiles(ctx, selectTfsItem);
        if (!tfsDllFiles || tfsDllFiles.length < 1) return false;

        for (let j = 0; j < tfsDllFiles.length; j++) {
          const tfsDllFile = tfsDllFiles[j];
          const clientPath = removeSlash(dirPath);
          copyResult = await cmdInvoke("copy_path", {
            source: `${clientPath}/${tfsDllFile}`,
            destination: `${toGenerateDir}/${tfsDllFile}`,
            ...getRetryArgs("copy"),
          });
          if (copyResult.code !== 0) break;
        }
      } else if (ctx.appconfig.dllMode == "DLL名称") {
        const patterns = getDllModePatterns(ctx);
        if (!patterns) {
          ctx.logger.print(`未配置DLL名称获取程序集的相关信息，请检查.`, "log-error");
          return false;
        }
        copyResult = await cmdInvoke("copy_dll_files_by_name", {
          source: dirPath,
          destination: `${outPath}/${generateDir}`,
          patterns: patterns,
        });
      } else {
        if (dllModeDateRange.length < 1) {
          copyResult = await cmdInvoke("copy_path", {
            source: dirPath,
            destination: `${outPath}/${generateDir}`,
            ...getRetryArgs("copy"),
          });
        } else {
          copyResult = await cmdInvoke("copy_path_by_time", {
            source: dirPath,
            destination: `${outPath}/${generateDir}`,
            startTime: dllModeDateRange[0],
            endTime: dllModeDateRange[1],
          });
        }
      }

      if (copyResult.code !== 0) {
        ctx.logger.print(`复制[${generateDir}]失败：${copyResult.data}`, "log-error");
        return false;
      }

      // 验证文件是否存在
      const isDirEmpty = await cmdInvoke("is_dir_empty", {
        path: `${outPath}/${generateDir}`,
      });
      if (isDirEmpty.code !== 0) {
        ctx.logger.print(`输出路径为空：${`${outPath}/${generateDir}`}.`, "log-warning");
      }
    }

    // 2.[打包(压缩)文件]
    if (appConfig.isCompress == 1) {
      if (!appConfig.compressFileJson) {
        ctx.logger.print(
          `${wpfClientName} 未选择要打包(压缩)文件，请检查.`,
          "log-error"
        );
        return false;
      }
      const compressFileArr = safeJsonParse<string[] | null>(appConfig.compressFileJson, null);
      if (!compressFileArr) {
        ctx.logger.print(`${wpfClientName} 的打包(压缩)文件配置损坏无法解析，请重新选择要打包(压缩)文件.`, "log-error");
        return false;
      }
      if (compressFileArr.includes("Plugins.zip")) {
        const domainPath = `${removeSlash(appConfig.clientPath)}/Domain`;
        const uiPath = `${removeSlash(appConfig.clientPath)}/UI`;
        const compressePluginsResult = await cmdInvoke("compress_zip", {
          filePaths: [domainPath, uiPath],
          dstFile: `${outPath}/Plugins.zip`,
        });
        if (compressePluginsResult.code !== 0) {
          ctx.logger.print(
            `压缩[Plugins.zip]失败：${compressePluginsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("AddIns.zip")) {
        const addInsPath = `${removeSlash(appConfig.clientPath)}/AddIns`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [addInsPath],
          dstFile: `${outPath}/AddIns.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(
            `压缩[AddIns.zip]失败：${compresseAddInsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Lib.zip")) {
        const libPath = `${removeSlash(appConfig.clientPath)}/Lib`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [libPath],
          dstFile: `${outPath}/Lib.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(`压缩[Lib.zip]失败：${compresseAddInsResult.data}.`, "log-error");
          return false;
        }
      }

      if (compressFileArr.includes("Localization.zip")) {
        const localizationPath = `${removeSlash(appConfig.clientPath)}/Localization`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [localizationPath],
          dstFile: `${outPath}/Localization.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(
            `压缩[Localization.zip]失败：${compresseAddInsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Templates.zip")) {
        const templatesPath = `${removeSlash(appConfig.clientPath)}/Templates`;
        const compresseAddInsResult = await cmdInvoke("compress_zip", {
          filePaths: [templatesPath],
          dstFile: `${outPath}/Templates.zip`,
        });
        if (compresseAddInsResult.code !== 0) {
          ctx.logger.print(
            `压缩[Templates.zip]失败：${compresseAddInsResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Config.zip")) {
        // 将log4net.config、SIE.MOM.exe.config、appsettings.json打包 -->  Config.zip
        const log4netConfigFile = `${removeSlash(appConfig.clientPath)}/log4net.config`;
        const log4netConfigFileExists = await cmdInvoke("exists", {
          path: log4netConfigFile,
        });
        if (log4netConfigFileExists.code !== 0) {
          ctx.logger.print(
            "未找到log4net.config文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const sieMomExeConfigFile = `${removeSlash(
          appConfig.clientPath
        )}/SIE.MOM.exe.config`;
        const sieMomExeConfigFileExists = await cmdInvoke("exists", {
          path: sieMomExeConfigFile,
        });
        if (sieMomExeConfigFileExists.code !== 0) {
          ctx.logger.print(
            "未找到SIE.MOM.exe.config文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const appsettingsFile = `${removeSlash(appConfig.clientPath)}/appsettings.json`;
        const appsettingsFileExists = await cmdInvoke("exists", {
          path: appsettingsFile,
        });
        if (appsettingsFileExists.code !== 0) {
          ctx.logger.print(
            "未找到appsettings.json文件，请检查路径或编译项目试试.",
            "log-error"
          );
          return false;
        }

        const compresseConfigResult = await cmdInvoke("compress_zip", {
          filePaths: [log4netConfigFile, sieMomExeConfigFile, appsettingsFile],
          dstFile: `${outPath}/Config.zip`,
        });
        if (compresseConfigResult.code !== 0) {
          ctx.logger.print(
            `压缩[Config.zip]失败：${compresseConfigResult.data}.`,
            "log-error"
          );
          return false;
        }
      }

      if (compressFileArr.includes("Main.zip")) {
        // 将SIE.dll、SIE.MOM.exe、SIE.Wpf.dll打包 -->  Main.zip
        const sieDllFile = `${removeSlash(appConfig.clientPath)}/SIE.dll`;
        const sieDllFileExists = await cmdInvoke("exists", { path: sieDllFile });
        if (sieDllFileExists.code !== 0) {
          ctx.logger.print("未找到SIE.dll文件，请检查路径或编译项目试试.", "log-error");
          return false;
        }

        const sieMomExeFile = `${removeSlash(appConfig.clientPath)}/SIE.MOM.exe`;
        const sieMomExeFileExists = await cmdInvoke("exists", { path: sieMomExeFile });
        if (sieMomExeFileExists.code !== 0) {
          ctx.logger.print("未找到SIE.MOM.exe文件，请检查路径或编译项目试试.", "log-error");
          return false;
        }

        const sieWpfDllFile = `${removeSlash(appConfig.clientPath)}/SIE.Wpf.dll`;
        const sieWpfDllFileExists = await cmdInvoke("exists", { path: sieWpfDllFile });
        if (sieWpfDllFileExists.code !== 0) {
          ctx.logger.print("未找到SIE.Wpf.dll文件，请检查路径或编译项目试试.", "log-error");
          return false;
        }

        const compresseMainResult = await cmdInvoke("compress_zip", {
          filePaths: [sieDllFile, sieMomExeFile, sieWpfDllFile],
          dstFile: `${outPath}/Main.zip`,
        });
        if (compresseMainResult.code !== 0) {
          ctx.logger.print(`压缩[Main.zip]失败：${compresseMainResult.data}.`, "log-error");
          return false;
        }
      }
    }
  } catch (error) {
    ctx.logger.print(
      `获取程序集 ${wpfClientName} 出错：${JSON.stringify(error)}`,
      "log-error"
    );
    return false;
  }
  ctx.logger.print(`获取程序集 ${wpfClientName} 成功.`, "log-success");
  return true;
};

// 复制应用程序集[文件]
export const copyAssemblyFile = async (
  ctx: PublishContext,
  appTypeName: "WebApiHost" | "ScheduleServer" | "WebClient" | "SpcMonitor",
  projectOutPath: string,
  appConfig:
    | WebApiHostConfigType
    | ScheduleServerConfigType
    | WebClientConfigType
    | SpcMonitorConfigType
) => {
  ctx.logger.print(`正在获取 ${appTypeName} 程序集.`);

  // 删除项目输出目录
  let outPath = `${projectOutPath}/${appTypeName}`;
  const projectOutPathExists = await cmdInvoke("exists", {
    path: outPath,
  });
  if (projectOutPathExists.code === 0) {
    await cmdInvoke("delete_paths", {
      paths: [outPath],
    });
  }
  let createPathResult = await createDir(outPath);
  if (!createPathResult) {
    ctx.logger.print(`创建目录失败：${outPath}`, "log-error");
    return false;
  }
  if (!appConfig.clientPath) {
    ctx.logger.print(`${appTypeName} 的[客户端生成路径]未配置，请检查.`, "log-error");
    return false;
  }
  try {
    let copyResult = {
      code: 0,
      msg: "success",
      data: null,
    };
    if (ctx.appconfig.dllMode == "TFS") {
      if (!ctx.appconfig.dllModeValue) {
        ctx.logger.print(`未配置TFS获取程序集的相关信息，请检查.`, "log-error");
        return false;
      }
      const selectTfsItem = safeJsonParse<SelectTfsType | null>(
        ctx.appconfig.dllModeValue,
        null
      );
      if (!selectTfsItem) {
        ctx.logger.print(`TFS获取程序集的配置信息损坏无法解析，请重新选择.`, "log-error");
        return false;
      }
      const tfsDllFiles = await getTfsDllFiles(ctx, selectTfsItem);
      if (!tfsDllFiles || tfsDllFiles.length < 1) return false;
      for (let o = 0; o < tfsDllFiles.length; o++) {
        const tfsDllFile = tfsDllFiles[o];
        const clientPath = removeSlash(appConfig.clientPath);
        copyResult = await cmdInvoke("copy_path", {
          source: `${clientPath}/${tfsDllFile}`,
          destination: `${removeSlash(outPath)}/${tfsDllFile}`,
          ...getRetryArgs("copy"),
        });
        if (copyResult.code !== 0) break;
      }
    } else if (ctx.appconfig.dllMode == "Git") {
      if (!ctx.appconfig.dllModeValue) {
        ctx.logger.print(`未配置Git获取程序集的相关信息，请检查.`, "log-error");
        return false;
      }
      const selectGitItem = safeJsonParse<SelectGitType | null>(
        ctx.appconfig.dllModeValue,
        null
      );
      if (!selectGitItem) {
        ctx.logger.print(`Git获取程序集的配置信息损坏无法解析，请重新选择.`, "log-error");
        return false;
      }
      const gitDllFiles = await getGitDllFiles(ctx, selectGitItem);
      console.log('gitDllFiles', gitDllFiles);
      if (!gitDllFiles || gitDllFiles.length < 1) return false;
      for (let o = 0; o < gitDllFiles.length; o++) {
        const gitDllFile = gitDllFiles[o];
        const clientPath = removeSlash(appConfig.clientPath);
        copyResult = await cmdInvoke("copy_path", {
          source: `${clientPath}/${gitDllFile}`,
          destination: `${removeSlash(outPath)}/${gitDllFile}`,
          ...getRetryArgs("copy"),
        });
        if (copyResult.code !== 0) break;
      }
    }
    else if (ctx.appconfig.dllMode == "DLL名称") {
      const patterns = getDllModePatterns(ctx);
      if (!patterns) {
        ctx.logger.print(`未配置DLL名称获取程序集的相关信息，请检查.`, "log-error");
        return false;
      }
      copyResult = await cmdInvoke("copy_dll_files_by_name", {
        source: appConfig.clientPath,
        destination: outPath,
        patterns: patterns,
      });
    }
    else {
      let dllModeDateRange = getDllModeDateRange(ctx);
      if (dllModeDateRange.length < 1) {
        copyResult = await cmdInvoke("copy_dll_files", {
          source: appConfig.clientPath,
          destination: outPath,
          delDestination: true,
        });
      } else {
        copyResult = await cmdInvoke("copy_dll_files_by_time", {
          source: appConfig.clientPath,
          destination: outPath,
          delDestination: true,
          startTime: dllModeDateRange[0],
          endTime: dllModeDateRange[1],
        });
      }
    }
    if (copyResult.code !== 0) {
      ctx.logger.print(`获取程序集 ${appTypeName} 失败：${copyResult.data}`, "log-error");
      return false;
    }
  } catch (error) {
    ctx.logger.print(`获取程序集 ${appTypeName} 出错：${JSON.stringify(error)}`, "log-error");
    return false;
  }
  // 验证是否为空文件夹
  const dirEmptyResult = await cmdInvoke("is_dir_empty", {
    path: outPath,
  });
  if (dirEmptyResult.code !== 0) {
    ctx.logger.print(`输出路径为空：${outPath}.`, "log-warning");
  } else {
    ctx.logger.print(`获取程序集 ${appTypeName} 成功.`, "log-success");
  }
  return true;
};

// 构造TFS命令
export const getTfsDllFiles = async (ctx: PublishContext, selectTfsItem: SelectTfsType) => {
  const tfsItem = await getTfsDetail(ctx, Number(selectTfsItem.id));
  if (!tfsItem) return null;
  if (!ctx.generatePublishLog.data) {
    // 构造命令行
    let execArgs = new Array<string>();
    execArgs.push("history");
    execArgs.push(`/collection:${tfsItem.tfsServerUrl}`);
    execArgs.push(`${tfsItem.tfsSourcePath}`);
    execArgs.push("/noprompt");
    if (selectTfsItem.selectModel === "日期") {
      const bDate = new Date(selectTfsItem.selectValue[0].value);
      const beginDate = formatDate(bDate, "DYYYY-mm-ddTHH:MM:SS");
      let endDate = "";
      if (selectTfsItem.selectValue[1].value) {
        const eDate = new Date(selectTfsItem.selectValue[1].value);
        endDate = formatDate(eDate, "DYYYY-mm-ddTHH:MM:SS");
      }
      execArgs.push(`-V:${beginDate}~${endDate}`);
    }
    if (selectTfsItem.selectModel === "变更集") {
      const beginChangeSets = `C${selectTfsItem.selectValue[0].value}`;
      let endChangeSets = "";
      if (selectTfsItem.selectValue[1].value) {
        endChangeSets = `C${selectTfsItem.selectValue[1].value}`;
      }
      execArgs.push(`-V:${beginChangeSets}~${endChangeSets}`);
    }
    execArgs.push("-R");
    execArgs.push("-F:detailed");
    console.log('execArgs',execArgs);
    const execResult = await cmdInvoke("execute_local_command", {
      command: tfsItem.tfvcPath,
      args: execArgs,
    });
    if (execResult.code !== 0) {
      ctx.logger.print(`TFS命令执行失败：${execResult.data}`, "log-error");
      return null;
    }
    ctx.generatePublishLog.data = execResult.data;
  }

  // 生成发布日志
  if (ctx.generatePublishLog.isEnable) {
    let generateResult: DataResultType = {
      code: 1,
      msg: "success",
      data: null,
    };
    const dllResolveOptions = await getPublishLogResolveOptions(ctx);
    switch (ctx.generatePublishLog.type) {
      case "仅发布内容":
        generateResult = await outPublishContents(
          ctx.generatePublishLog.data,
          ctx.assemblyOutPath
        );
        break;
      case "按日期":
        generateResult = await outPublishContentByDates(
          ctx.generatePublishLog.data,
          ctx.generatePublishLog.displayPublishField,
          ctx.assemblyOutPath,
          true,
          dllResolveOptions
        );
        break;
      case "按用户":
        generateResult = await outPublishContentByUsers(
          ctx.generatePublishLog.data,
          ctx.generatePublishLog.displayPublishField,
          ctx.assemblyOutPath,
          true,
          dllResolveOptions
        );
        break;
      default:
        generateResult = await outDetaultPublishContents(
          ctx.generatePublishLog.data,
          ctx.generatePublishLog.displayPublishField,
          ctx.assemblyOutPath,
          true,
          dllResolveOptions
        );
        break;
    }
    if (generateResult.code === 0) {
      ctx.generatePublishLog.logs = generateResult.msg;
    }
  }
  console.log('generatePublishLog.value.data', ctx.generatePublishLog.data);
  // 筛选变更项
  const lines = ctx.generatePublishLog.data.split("\n");
  const tfsItems = lines
    .map((line: string) => getTfsChangedPath(line, tfsItem.tfsSourcePath))
    .filter((item: string) => item);
  return await getDllFilesByChangedItems(tfsItems, {
    repositoryPath: tfsItem.tfsLocalPath,
    sourcePath: tfsItem.tfsSourcePath,
  });
};

// 构造Git命令
export const getGitDllFiles = async (ctx: PublishContext, selectGitItem: SelectGitType) => {
  const gitItem = await getGitDetail(ctx, Number(selectGitItem.id));
  // console.log('gitItem', gitItem)
  if (!gitItem) return null;
  if (!ctx.generatePublishLog.data) {
    // Git命令执行
    let execArgs = new Array<string | null>();
    execArgs.push("log");
    execArgs.push("--pretty=format:%H|%an|%ae|%ad|%s"); // 格式化输出
    execArgs.push("--name-status"); // 包含文件变更状态
    if (selectGitItem.selectModel === "日期") {
      const bDate = new Date(selectGitItem.selectValue[0].value);
      const beginDate = formatDate(bDate, "DYYYY-mm-ddTHH:MM:SS");
      let endDate = "";
      if (selectGitItem.selectValue[1].value) {
        const eDate = new Date(selectGitItem.selectValue[1].value);
        endDate = formatDate(eDate, "DYYYY-mm-ddTHH:MM:SS");
      }
      execArgs.push(`--since=${beginDate}`);
      execArgs.push(`--until=${endDate}`);
    }
    if (selectGitItem.selectModel === "commit") {

      const startSha = selectGitItem.selectValue[0].value;
      const endSha = selectGitItem.selectValue[1].value;

      // 如果只填写了起始SHA，则查询从该SHA到HEAD的所有提交（包含起始SHA）
      if (startSha && !endSha) {
        execArgs.push(`${startSha}..HEAD`);
      }
      // 如果填写了起始和结束SHA，则查询范围（包含起始SHA和结束SHA）
      else if (startSha && endSha) {
        execArgs.push(`${startSha}^..${endSha}`);
      }
      // 如果只填写了结束SHA（理论上不应该发生）
      else if (!startSha && endSha) {
        execArgs.push(endSha);
      }
    }
    // console.log('execArgs', execArgs)
    execArgs.push(gitItem.branchName);
    const execResult = await cmdInvoke("execute_local_command_with_working_dir", {
      command: gitItem.gitPath,
      args: execArgs,
      workingDir: gitItem.gitRepository
    });
    console.log('execResult', execResult)
    if (execResult.code !== 0) {
      ctx.logger.print(`Git命令执行失败：${execResult.data}`, "log-error");
      return null;
    }
    ctx.generatePublishLog.data = execResult.data;
  }

  // 生成发布日志
  if (ctx.generatePublishLog.isEnable) {
    let generateResult: DataResultType = {
      code: 1,
      msg: "success",
      data: null,
    };
    const dllResolveOptions = await getPublishLogResolveOptions(ctx);
    switch (ctx.generatePublishLog.type) {
      case "仅发布内容":
        generateResult = await outPublishContents(
          ctx.generatePublishLog.data,
          ctx.assemblyOutPath
        );
        break;
      case "按日期":
        generateResult = await outPublishContentByDates(
          ctx.generatePublishLog.data,
          ctx.generatePublishLog.displayPublishField,
          ctx.assemblyOutPath,
          true,
          dllResolveOptions
        );
        break;
      case "按用户":
        generateResult = await outPublishContentByUsers(
          ctx.generatePublishLog.data,
          ctx.generatePublishLog.displayPublishField,
          ctx.assemblyOutPath,
          true,
          dllResolveOptions
        );
        break;
      default:
        generateResult = await outDetaultPublishContents(
          ctx.generatePublishLog.data,
          ctx.generatePublishLog.displayPublishField,
          ctx.assemblyOutPath,
          true,
          dllResolveOptions
        );
        break;
    }
    if (generateResult.code === 0) {
      ctx.generatePublishLog.logs = generateResult.msg;
    }
  }
  // 筛选变更项
  const lines = ctx.generatePublishLog.data.split("\n");

  // 解析 Git 日志，提取文件变更部分
  let gitItems: string[] = [];
  // 根据提供的Git日志格式，解析包含提交信息和文件变更的格式
  let currentLineIndex = 0;
  while (currentLineIndex < lines.length) {
    const line = lines[currentLineIndex];
    // 匹配提交哈希、作者、邮箱、日期和提交信息的格式
    if (/^[a-f0-9]{40}\|/.test(line)) {
      // 这是包含提交信息的一行，跳过
    } else if (line.trim() && !line.startsWith('commit') && !line.startsWith('Author:') && !line.startsWith('Date:')) {
      // 这可能是文件变更行，格式如：M	Modules/Common/Items/SIE.Items/Items/ItemController.cs
      const fileChangeMatch = line.match(/^([MAD])\s+(.+)$/);
      if (fileChangeMatch) {
        gitItems.push(fileChangeMatch[2].trim());
      }
    }
    currentLineIndex++;
  }
  return await getDllFilesByChangedItems(gitItems, {
    repositoryPath: gitItem.gitRepository,
  });
};

export const getPublishLogResolveOptions = async (ctx: PublishContext): Promise<DllResolveOptions> => {
  if (!ctx.appconfig.dllModeValue) return {};
  if (ctx.appconfig.dllMode === "TFS") {
    // 解析失败走与"未配置 dllModeValue"相同的降级分支（返回空选项），safeJsonParse 已输出告警日志
    const selectTfsItem = safeJsonParse<SelectTfsType | null>(
      ctx.appconfig.dllModeValue,
      null
    );
    if (!selectTfsItem) return {};
    const tfsItem = await getTfsDetail(ctx, Number(selectTfsItem.id));
    return {
      repositoryPath: tfsItem?.tfsLocalPath,
      sourcePath: tfsItem?.tfsSourcePath,
    };
  }
  if (ctx.appconfig.dllMode === "Git") {
    const selectGitItem = safeJsonParse<SelectGitType | null>(
      ctx.appconfig.dllModeValue,
      null
    );
    if (!selectGitItem) return {};
    const gitItem = await getGitDetail(ctx, Number(selectGitItem.id));
    return { repositoryPath: gitItem?.gitRepository };
  }
  return {};
};

// 查询Tfs信息
const getTfsDetail = async (ctx: PublishContext, id: number) => {
  let dataResult = await tfsDb.getTfsById(id);
  if (dataResult.code !== 0) {
    ctx.logger.print(dataResult.msg, "log-error");
    return null;
  }
  return dataResult.data.data;
};

// 查询Git信息
const getGitDetail = async (ctx: PublishContext, id: number) => {
  let dataResult = await gitDb.getGitById(id);
  if (dataResult.code !== 0) {
    ctx.logger.print(dataResult.msg, "log-error");
    return null;
  }
  return dataResult.data.data;
};

// 创建目录
const createDir = async (path: string) => {
  const pathExists = await cmdInvoke("exists", { path });
  if (pathExists.code !== 0) {
    return await cmdInvoke("create_dir", { path });
  }
  return true;
};

// 查询服务信息
export const getServerDetail = async (ctx: PublishContext, id: number) => {
  let dataResult = await serverDb.getServerById(id);
  if (dataResult.code !== 0) {
    ctx.logger.print(dataResult.msg, "log-error");
    return null;
  }
  const serverInfo = dataResult.data?.data;
  if (!Number.isSafeInteger(id) || id <= 0 || !serverInfo || !Number.isSafeInteger(serverInfo.id) || serverInfo.id !== id) {
    return null;
  }
  return serverInfo;
};
