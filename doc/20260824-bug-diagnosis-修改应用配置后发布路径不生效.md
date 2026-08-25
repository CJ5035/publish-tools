# Bug 诊断报告：修改应用配置后发布路径不生效

- **日期**：2026-08-24
- **状态**：已修复（2026-08-24，止血方案：弹窗保存回写 + 向导补写，发布链路未动）
- **严重级别**：P1 严重（发布到错误的服务器目录，可能覆盖错误环境文件）
- **报告人**：ZCode Agent（Bug Diagnosis Skill）

---

## 问题描述

用户在项目发布页点击「修改应用配置」弹窗，将 WpfClient 的发布路径改为 `/opt/smom/ftp/client/`（图2），
弹窗提示修改成功；但项目发布页上 WpfClient 的「服务端发布路径」仍显示旧值 `/opt/smom/server/TestDir`（图1）。
疑问：点击发布时到底以哪个路径为准？

**直接结论：点击发布时使用的是旧路径 `/opt/smom/server/TestDir`（即图1页面显示的值），
弹窗中修改的新路径 `/opt/smom/ftp/client/` 不会被发布链路读取。**

---

## 环境信息

- 分支：`feature/配置向导`（wpfClient 多服务器结构 serverIds/serverArr/serverPathArr 为本分支引入）
- 相关模块：
  - `src/views/appconfig/components/appconfigDialog.vue`（修改应用配置弹窗，图2）
  - `src/views/home/index.vue`（项目发布页 图1 + 发布执行链路）
  - `src/database/appconfig/index.ts`（t_app_config 表读写）
- 复现步骤：
  1. 项目发布页选择项目 + 环境（Dev）
  2. 点击「修改应用配置」→ WpfClient 标签 → 修改发布路径 → 点「修 改」
  3. 弹窗关闭、页面刷新后「服务端发布路径」仍为旧值
  4. 点击发布 → 实际发布到旧路径

---

## 可能原因分析

| # | 原因 | 概率 | 理由 |
|---|------|------|------|
| 1 | 弹窗编辑的是多服务器结构 `serverArr[].serverPathArr[].path`，保存时无"新→旧"回写；而发布页展示与发布执行读取的是旧单服务器字段 `serverPath`，两者脱节 | **高（已确认）** | 代码验证：`onSubmit` 仅序列化 configItems 整体存库；发布链路 `publishWpfClient`/`newPublishWpfClient` 均取 `wpfClientItem.serverPath` |
| 2 | 弹窗编辑的环境与页面展示的环境不是同一条记录 | 低 | `onOpenAppConfig`（home/index.vue:3693）按 `appconfigData.id` 取同一条记录；保存后 `emit("refresh")` 会以当前环境重查同一条数据 |
| 3 | 保存失败或未点「修 改」按钮 | 低 | 用户操作已触发"修改成功！"提示（保存走 `updateAppconfig` 成功分支），且页面数据确实刷新过（显示值来自重查结果） |
| 4 | 页面缓存未刷新 | 低 | `onSubmit` 成功后 `emit("refresh")` → `getPublishAppconfigs()` 重查 DB；显示的旧值就是库里 configItemsJson 中旧字段的真实值，不是缓存问题 |

---

## 验证动作

### 针对原因 1：新旧结构脱节（已执行，成立）

- **验证方式**：直接查询本地 SQLite 库（`%APPDATA%/com.smompublish.tool/smom.db`）
- **位置**：`src/database/appconfig/index.ts:94`（getPublishAppconfigs）、`src/views/home/index.vue:1785`
- **执行结果**（用户实际数据，appconfig id=4，project=4，environment=1/Dev，即截图对应记录）：
  ```
  [wpfClient] legacy serverPath='/opt/smom/server/TestDir'  serverId=4  serverName='华俊-测试'
  [wpfClient] serverArr id=4 name='华俊-测试' paths=[('', '/opt/smom/ftp/client/')]
  ```
  同一条记录的 `config_items_json` 内：旧字段 = 图1 显示的旧路径；`serverPathArr` = 图2 弹窗修改的新路径。
  两套字段精确对应两张截图，原因 1 成立。
- **补充验证**：点击发布观察日志面板，「正在获取远程服务文件：…」列表按 `serverPath`
  （home/index.vue:1809-1816）拼接，预期为 `/opt/smom/server/TestDir/Manifest.xml` 等旧路径文件。
- **全库扫描**：`grep` 全代码库，除「移除模块」时的置空操作
  （generatePublishDialog.vue:339 等新旧字段一起清空）外，**不存在任何**给旧字段
  `serverPath` 赋真实值的代码路径；appconfigDialog 内也无 `watch` 反向同步。

---

## 调用链与依赖分析

### 完整调用路径（编辑链路 vs 发布链路）

```
【编辑链路 — 写的是新结构，旧字段不更新】
项目发布页「修改应用配置」按钮                [src/views/home/index.vue:58]
  → onOpenAppConfig()                        [src/views/home/index.vue:3693]
    → getAppconfigById(id)                    （取当前页面同一条记录）
    → appconfigDialog.openDialog("edit", row) [src/views/appconfig/components/appconfigDialog.vue:1340]
      → normalizeWpfClientServer()            [appconfigDialog.vue:948]
          ※ 单向兼容：仅当 serverArr 为空且 serverId 有值时，
            把旧字段 serverId/serverName/serverPath 复制进 serverArr（旧→新）
      → 用户编辑「发布路径」输入框
          v-model 绑定 serverArr[i].serverPathArr[0].value[j].path   [appconfigDialog.vue:421-424]
  → 点击「修 改」→ onSubmit()                [appconfigDialog.vue:1404]
    → configItemsJson = JSON.stringify(configItems)   （serverPath 旧值原样带入）
    → updateAppconfig()                       [src/database/appconfig/index.ts:174]
          ※ 纯透传 UPDATE t_app_config ... config_items_json=$7，无任何字段同步
    → emit("refresh") → getPublishAppconfigs() 重新加载

【展示链路 — 读旧字段】
项目发布页 WpfClient「服务端发布路径」
  → {{ appconfigData.configItems.wpfClient.serverPath }}   [src/views/home/index.vue:489]

【发布链路 — 读旧字段（新旧两个版本分支均如此）】
点击发布 → serverPublish()
  → publishWpfClient()                        [src/views/home/index.vue:1750]（≤10.1 版本）
      serverId   = wpfClientItem.serverId     [index.vue:1784]
      serverPath = wpfClientItem.serverPath   [index.vue:1785]  ← 旧字段
      serverName = wpfClientItem.serverName   [index.vue:1786]
      → 下载/上传均以 serverPath 拼接远程路径  [index.vue:1809,1982,2024,2060]
  → newPublishWpfClient()                     [src/views/home/index.vue:1527]（10.2+ 版本）
      serverId/serverPath/serverName          [index.vue:1561-1563]  ← 同样读旧字段
```

### 关键依赖节点

- **上游写入方（关键发现：两个写入方产出互不兼容的数据形状）**：
  - 配置向导 `Step4EnvConfig.buildConfigItems`（Step4EnvConfig.vue:241-249）：wpfClient **只写旧字段**
    （serverId/serverName/serverPath），**不写** serverIds/serverArr；
    而其余四个模块（同文件 :236）只写新结构（serverIds/serverArr，serverPath 置空）
  - 修改应用配置弹窗 appconfigDialog：打开时 `normalizeWpfClientServer` 把旧字段复制进 serverArr
    （单向），编辑与保存只作用新结构，旧字段原样保留
- **下游消费方（三类，读取结构不一致）**：
  - 项目发布页展示（home/index.vue:481,489）：读**旧字段** serverName/serverPath
  - 发布执行 `publishWpfClient`（:1784-1786）/ `newPublishWpfClient`（:1561-1563）：读**旧字段**
  - 发布前备份 `loadBackupItems`（src/utils/backupAppconfig.ts:651-676）：读**新结构** serverArr
    （同样带单向归一化）
- **数据流**：向导产旧形状 → 弹窗编辑后变成"旧字段(旧值) + serverArr(新值)"混合形状 →
  发布读旧字段（旧路径），备份读 serverArr（新路径）

### 影响范围评估

- **wpfClient 是五个模块中唯一的掉队者**：webApiHost（home/index.vue:1245）、spcMonitor（:1278）、
  webClient（:1313）、scheduleServer（:1347）四个模块的发布函数均已遍历新结构 serverArr，
  弹窗中修改发布路径对它们**生效**。仅 wpfClient 的发布链路仍读旧字段。
- **换绑服务器同样失效**：弹窗「应用服务器」多选只维护 serverIds/serverArr
  （appconfigDialog.vue:908-945），旧字段 serverId/serverName 永不更新 ——
  若在弹窗中**换绑了服务器**，发布仍会发到旧服务器（serverId 不变，比路径错位更危险）。
- **备份与发布路径错位**：同一次发布若开启「发布前备份」，备份从 serverArr 新路径
  （`/opt/smom/ftp/client/`）下载备份，而发布上传到旧字段旧路径（`/opt/smom/server/TestDir`），
  两者操作的不是同一目录。
- 库中实测 5 条 appconfig：3 条纯旧形状（无 serverArr，中恒/新容项目）、1 条双结构同步
  （id=5，弹窗打开保存过但未改路径）、1 条双结构错位（id=4，本 Bug 记录）。

---

## 边缘情况检查

| 维度 | 场景 | 当前行为 | 是否有问题 | 建议 |
|------|------|----------|------------|------|
| 数据兼容 | 旧数据（仅 serverId/serverPath）首次打开弹窗 | normalizeWpfClientServer 旧→新补齐，可正常编辑 | 否 | 保留 |
| 数据兼容 | 已有 serverArr 的数据再次保存 | serverPath 保持首存值，永不更新 | **是（本 Bug）** | 保存前回写旧字段或发布改读新结构 |
| 多服务器 | 弹窗支持多服务器（serverIds 多选） | 发布仅支持单服务器（读单个 serverId/serverPath） | 是 | 向导方向的多服务器发布落地前，至少回写第一个服务器到旧字段 |
| 环境一致性 | 弹窗内切换环境 | emit("environment-change") 同步页面环境 | 否 | — |
| 空值 | serverArr 为空且 serverId 为空（纯向导新建数据） | normalize 跳过；发布时报「未选择服务」 | 不确定 | 结合向导产出数据回归验证 |
| 触发时机 | 保存成功后页面刷新 | refresh 重查 DB，但查回的旧字段未变 | 是（表现为"改了没生效"） | 同根因 |

---

## 总结与建议

**根因**：wpfClient 模块在"多服务器结构"迁移中掉队，形成三方错位 ——
向导产出只含旧字段（serverId/serverName/serverPath）的数据；编辑弹窗经单向归一化后只编辑/保存新结构
（serverIds/serverArr）；而发布链路（publishWpfClient/newPublishWpfClient）只读旧字段。
弹窗中修改的路径写入 serverArr 后，旧字段成为永不过期的"僵尸值"，页面展示与发布执行均以旧值为准。
其余四个模块（webApiHost/scheduleServer/webClient/spcMonitor）已整体迁移到新结构，不受影响。

**对用户问题的回答**：点击发布时以**旧路径 `/opt/smom/server/TestDir`**（图1 显示值）为准；
弹窗里的新路径不参与发布。同理，若在弹窗中更换了应用服务器，发布仍会指向旧服务器。
若开启发布前备份，还会出现"备份新路径、发布旧路径"的错位。

**推荐的下一步行动**（二选一，建议先做 1 作为止血）：
1. **止血**：在 `appconfigDialog.vue` 的 `onSubmit` 序列化前增加反向同步 ——
   `serverArr[0]` 回写 `serverId/serverName`，`serverArr[0].serverPathArr[0].value[0].path` 回写 `serverPath`
   （serverArr 为空时置空旧字段）；同时向导 `Step4EnvConfig.buildConfigItems` 为 wpfClient 补写
   serverIds/serverArr，消除两个写入方的形状分歧。
   推演验证：对当前错位记录（id=4）保存后展示/发布/备份三方一致；旧形状首次编辑、新增配置
   （顺带修复新增时 serverPath 恒空无法发布的问题）、wpfClient 停用等场景均闭环；
   局限：多服务器仍只发布第一台（与现状持平，不劣化）。
2. **根治**：wpfClient 发布链路（publishWpfClient/newPublishWpfClient/页面展示）改造为遍历
   `serverArr` 多服务器结构，与其余四个模块的发布实现对齐（webApiHost 等已是这种写法，
   home/index.vue:1245 可作参考模板），对齐后淘汰旧字段。
   ⚠️ 前置条件：库中现存 3 条纯旧形状记录（无 serverArr，实测 id=1/2/6），发布改造前必须
   迁移或运行时归一化（可复用 backupAppconfig.ts:651-668 的兼容写法），否则这些记录发布会
   因 serverArr 为空而失败。
> 修复落地：方案 1（止血）已实施，详见 `doc/20260824-wpfclient发布路径修复-实施计划.md` 执行记录；方案 2（根治，发布遍历 serverArr）另行立项.
