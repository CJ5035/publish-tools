# Bug 诊断报告：配置向导未自动识别 SLN 的 TFS 信息并保存

- **日期**：2026-08-23
- **状态**：已修复
- **验收日期**：2026-08-24（向导+弹窗双入口验收通过）
- **严重级别**：P2 一般（向导功能不完整，需用户去 TFS 管理页手动录入）
- **报告人**：ZCode Agent（Bug Diagnosis Skill）

---

## 问题描述

配置向导（projectWizard）选择 SLN 文件后，没有自动识别该 SLN 所属的 TFS 工作区信息（服务地址、源位置、本地根目录等），也没有将其保存到 TFS 配置表（t_team_foundation_server）。用户期望：选完 SLN 后自动探测 TFS 信息，提交时随向导一并落库。

用户提问：
1. 目前有自动识别的方式吗？
2. 如果没有，参考 F:\Others\Mcp_TfsTools 项目的识别方式。

## 环境信息

- 分支：feature/配置向导
- 相关模块：`src/views/appconfig/components/projectWizard/`（向导）、`src/views/teamFoundationServer/`（TFS 管理页）、`src/database/teamFoundationServer/index.ts`（TFS DB）
- 参考项目①：F:\Others\Mcp_TfsTools（codegraph 已索引）
- 参考项目②：F:\Others\PublishTools\PublishTool（老版发布工具，codegraph 已索引，**含"识别+保存"完整范式**）
- 复现步骤：打开配置向导 → 选择 .sln → 走完 6 步提交 → 到 TFS 管理页查看，无新增记录

---

## 结论（先答用户两问）

1. **目前没有任何自动识别方式。** 对 `src/views/appconfig/components/projectWizard/` 全目录 grep `tfs`（不区分大小写）为 0 命中；整个前端与 Rust 端也没有任何 `tf.exe` / `workfold` 调用逻辑（仅 tfsDialog.vue 的提示文案和建表语句出现 "TF.exe" 字样）。TFS 记录目前只能通过「TFS 管理页 → 新增TFS」弹窗纯手填（tfsDialog.vue）。
2. **推荐以 PublishTool 的 `ResolveWorkspaceAsync` 为主范式、Mcp_TfsTools 的 `WorkspaceDiscoverer` 为解析内核**：调用 `tf.exe workfold "<路径>"` 解析输出获得 Collection URL、工作区名、本地↔服务器映射；失败则向上遍历父目录重试；解析成功后回写数据库。详见下文「参考实现分析」。

## 可能原因分析

| # | 原因 | 概率 | 理由 |
|---|------|------|------|
| 1 | 功能从未实现：向导从设计上就没有 TFS 环节 | 高（已确认） | wizardTypes.ts 的 WizardDraft 无 TFS 字段；Step1Project.vue 只调 parse_sln_project 解析 clientPaths；Step6Confirm.vue 落库仅写 project/servers/appconfig 三张表 |
| 2 | 有识别逻辑但未被触发 | 已排除 | 全项目无 tf.exe/workfold 调用代码 |
| 3 | 识别成功但保存被跳过/失败 | 已排除 | Step6Confirm.validate() 中无 useTfsDb 引用，保存链路根本不涉及 TFS 表 |
| 4 | 向导与 TFS 表之间有隐式关联（如 appconfig 携带 tfsId） | 已排除 | RowAppconfigType 的 configItemsJson 中无 tfs 相关字段；t_team_foundation_server 为独立配置表 |

## 验证动作

### 针对原因 1：功能缺失（已直接确认，无需运行验证）

- **验证方式**：静态检索
- **位置**：
  - `src/views/appconfig/components/projectWizard/Step1Project.vue:95-148`（onSelectSln 只存路径；validate 只做 exists 校验 + parse_sln_project）
  - `src/views/appconfig/components/projectWizard/Step6Confirm.vue:97-131`（validate 落库三步：insertProject → insertServer → insertAppconfig，无 TFS）
  - `src/views/appconfig/components/projectWizard/wizardTypes.ts:43-53`（WizardDraft 无 TFS 数据结构）
- **具体操作**：
  ```bash
  grep -rn -i "tfs" src/views/appconfig/components/projectWizard/   # 0 命中
  grep -rn -iE "workfold|tf\.exe" src src-tauri/src                  # 仅提示文案与建表语句
  ```
- **预期结果**：全部 0 命中（已执行，结果为空），确认链路中无任何 TFS 处理。

## 调用链与依赖分析

### 现状调用路径（SLN 识别与落库）

```
Step1Project.onSelectSln()                     [Step1Project.vue:95]
  → tauri open dialog → draft.project.slnPath = 路径   ← 到此为止，无 TFS 探测
Step1Project.validate()                        [Step1Project.vue:101]
  → cmdInvoke('exists') → cmdInvoke('parse_sln_project') ×5  ← 仅解析 clientPaths
...
Step6Confirm.validate()                        [Step6Confirm.vue:87]
  → projectDb.insertProject()                  [Step6Confirm.vue:101]
  → serverDb.insertServer()（仅新服务器）       [Step6Confirm.vue:116]
  → appconfigDb.insertAppconfig()              [Step6Confirm.vue:124]
  → return true（结束，t_team_foundation_server 无写入）
```

### 现状 TFS 录入链路（纯手动，与向导零交集）

```
teamFoundationServer/index.vue「新增TFS」
  → tfsDialog.vue（手填 tfsName/tfsServerUrl/tfsSourcePath/tfsLocalPath/tfvcPath）
  → useTfsDb.insertTfs() → t_team_foundation_server
```

### 参考实现分析（Mcp_TfsTools 的自动识别方式）

核心类 `WorkspaceDiscoverer`（src/McpTfsTools/Services/WorkspaceDiscoverer.cs）：

```
DiscoverAsync(localPath)
  → tf.exe workfold "<localPath>"              [DiscoverInternalAsync:43]
    ├─ 解析输出 ParseWorkfoldOutput()           [64]
    │   ├─ 集合/Collection: <url>   → ServerUrl（正则兼容中英文输出）
    │   ├─ 工作区/Workspace: name (owner) → WorkspaceName/OwnerName
    │   └─ 映射行 "$/xxx: D:\local" → Mappings{local→server}
    └─ 失败 → dir = Path.GetDirectoryName(dir) 向上遍历父目录重试  [49-59]
       （sln 通常位于工作区根的子目录，必须向上回溯）
```

`WorkspaceInfo.GetServerPath(localPath)`（WorkspaceInfo.cs:15）：对 Mappings 做最长前缀匹配，把本地路径换算成 `$/...` 服务器路径。

### 参考实现分析（PublishTool：识别 + 保存的完整范式）

PublishTool（老版发布工具，同样内置 WorkspaceDiscoverer）额外提供了三个关键环节，恰好补齐新工具所需：

**① tf.exe 自动查找 `TfCliRunner.FindTfExe()`**（Tools/Tfs/TfCliRunner.cs:19）——解决 tfvcPath 来源：
```
1. PATH 环境变量逐目录找 tf.exe
2. 兜底：所有固定磁盘 × {Program Files, Program Files (x86)}
   × Microsoft Visual Studio × {版本} × {Edition}
   × Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\tf.exe
```
找到的 tf.exe 绝对路径可直接填入 t_team_foundation_server.tfvc_path（该字段在 tfsDialog.vue 中本是必填手填项）。

**② 输出多编码解码 `TfCliRunner.DecodeOutput()`**（TfCliRunner.cs:125）——解决 tf.exe 中文输出乱码：
按 UTF-8（严格模式）→ ANSI 代码页（当前 locale，即 GBK）→ OEM 代码页 依次尝试，全部失败再回退 UTF-8。Rust 侧移植时可用 `encoding_rs` 以相同顺序解码 stdout 字节。

**③ 自动识别 + 持久化 `TfsService.ResolveWorkspaceAsync()`**（Services/TfsService.cs:272）——正是"识别并保存"的样板：
```
入参仅需一个本地路径（project.TfsWorkspacePath，即用户选的 sln/工作区目录）
  → FindTfExe() 找不到 tf.exe → 抛"未找到 tf.exe"
  → WorkspaceDiscoverer.DiscoverAsync(path) 解析失败/无映射 → 抛"工作区路径未映射到 TFS"
  → collectionUrl = ws.ServerUrl
    serverPath  = ws.GetServerPath(path)            ← $/... 源位置
    localRoot   = 命中的最长前缀映射的本地根
  → DB.Update<Project>().Set(三项缓存).Where(Id)     ← 直接回写数据库
```

**④ 配套 UX 与缓存策略**（Forms/Clients/ProjectPage.cs:136-216 保存流程）：
- 三个解析结果（CollectionUrl/ServerPath/LocalRoot）在 UI 上是**只读展示**，用户只选工作区目录；
- 保存时若工作区路径变化 → 先清空三项缓存再重新解析（避免旧值残留）；
- 解析期间显示等待窗，失败弹错但**不阻塞主流程保存**；
- 懒自愈：后续用 TFS 功能时若三项缓存为空则自动重新 ResolveWorkspaceAsync；
- 另有「重新解析」按钮：手动清空三项缓存，下次触发重解析。

**数据模型差异（需注意）**：PublishTool 把 TFS 字段直接挂在 Project 实体上（TfsWorkspacePath/TfsCollectionUrl/TfsServerPath/TfsLocalRoot 四字段）；新工具是独立的 `t_team_foundation_server` 共享配置表，因此移植时需增加"查重复用"逻辑（见总结），且 tfsName 仍需用户确认。

### 映射到本项目的 t_team_foundation_server 字段

| 目标字段 | 语义（tfsDialog.vue 表单） | 自动识别来源 |
|---|---|---|
| tfsServerUrl（必填） | TFS 服务/集合地址 | workfold 输出的 `集合:` 行 |
| tfsSourcePath（必填） | `$/...` 源位置 | GetServerPath(slnPath) 推导（如 `$/SMOM.DEV.10.2/SMOM`） |
| tfsLocalPath（必填） | 本地根目录 | 命中的映射行的本地路径 |
| tfvcPath（必填） | TF.exe 工具路径 | PublishTool 的 FindTfExe() 自动查找结果（PATH → 全盘 VS 安装目录兜底）；已有 TFS 记录的 tfvcPath 可优先复用 |
| tfsName（必填） | 用户自定义名称 | **无法可靠自动推导**，需用户确认/输入（可默认取 Collection 名） |

### 影响范围评估（若实施该功能）

- `src-tauri/src/cmd_module/`：新增 Rust 命令（如 `detect_tfs_workspace`），模式与 `scan_wpf_publish_dirs`（file_module.rs:647）一致，需在 main.rs:94 generate_handler 注册
- `wizardTypes.ts`：WizardDraft 增加 tfs 草稿字段 + createEmptyDraft 初始化
- `Step1Project.vue`：选完 sln 后调用探测命令并展示结果（并入现有「SLN 解析结果」区块）
- `Step6Confirm.vue`：validate 中增加按 tfsServerUrl+tfsSourcePath 查重后 insertTfs
- 纯增量改动，不触碰既有 project/servers/appconfig 落库逻辑

## 边缘情况检查

| 维度 | 场景 | 当前行为 | 是否有问题 | 建议 |
|------|------|----------|------------|------|
| 未映射 | sln 不在任何 TFS 工作区 | — | 是（新功能需处理） | 探测失败提示「未识别到 TFS 工作区，可跳过或手动录入」，不阻塞向导（PublishTool 同样不阻塞主流程保存） |
| 工具缺失 | tf.exe 不存在/未装 VS | — | 是 | 移植 FindTfExe（PATH + 全盘 VS 目录兜底）；仍找不到时提示用户在 TFS 管理页录入 tfvcPath 后重试 |
| 输出编码 | tf.exe 中文输出为 GBK | — | 是（Rust 侧需注意） | 移植 PublishTool 的多编码解码：UTF-8(严格) → ANSI(GBK) → OEM 依次尝试（可用 encoding_rs） |
| 中英文输出 | workfold 输出「集合/Collection」「工作区/Workspace」 | 两个参考项目均已兼容 | 否 | 直接移植双语言正则 |
| 子目录 sln | sln 在工作区深层子目录 | 两个参考项目均已处理 | 否 | 移植向上遍历逻辑 |
| 缓存失效 | 工作区重新映射/换目录后旧识别结果残留 | PublishTool 已处理 | 是 | 移植其策略：slnPath 变化时清空已识别的 TFS 草稿字段并重新探测 |
| 重复保存 | 同一 TFS 每跑一次向导插一行 | 现有 insertTfs 仅按 tfsName 查重 | 是 | 向导侧按 tfsServerUrl+tfsSourcePath 查重，存在则复用不插入 |
| 名称推导 | tfsName 无法从 workfold 推导 | — | 是 | 默认取 Collection 尾段（如 SMOM.DEV），让用户在向导中确认/修改 |
| 多工作区叠加 | 同一目录映射多条 | GetServerPath 用最长前缀匹配 | 否 | 移植该匹配策略 |
| 旧数据兼容 | 已有手填记录（截图 2 条） | — | 是 | 查重命中时以已有记录为准，避免产生重复行 |

## 总结与建议

**这不是逻辑 Bug，而是向导从未包含 TFS 识别环节**：向导代码中 0 处 TFS 引用，落库链路只写 project/servers/appconfig 三张表，TFS 信息目前只能去 TFS 管理页手填。

## 方案 Review（2026-08-23 复核）

对上述实施路径逐项核验（消费方代码 + DB schema 实证），结论：**方向正确，但有 2 个实质性缺陷必须修正、2 个实施细节需补充**。

### 已验证成立的部分

| 方案要点 | 验证依据 | 结论 |
|---|---|---|
| 保存目标 = t_team_foundation_server | sqlite.ts 建表：t_project 无任何 TFS 字段 | ✅ 正确 |
| tfsServerUrl 格式 = Collection URL | 消费方均以 `tf.exe /collection:${tfsServerUrl}` 使用（backupAppconfig.ts:29、historyDialog.vue:182、home/index.vue:3347），workfold `集合:` 行输出的正是该格式 | ✅ 吻合 |
| tfvcPath = tf.exe 绝对路径 | 消费方把 tfvcPath 直接作为 command 执行（backupAppconfig.ts:55、historyDialog.vue:208）；FindTfExe 返回值可用 | ✅ 吻合 |
| workfold 探测离线可用 | workfold 读本地工作区缓存，无需凭证/网络 | ✅ |
| 新增 Rust 命令而非复用 execute_local_command | FindTfExe 需全盘目录枚举（前端无此能力），且解析+解码逻辑放 Rust 与 parse_sln_project 模式一致 | ✅ 合理 |

### 缺陷 1：tfsSourcePath 与 tfsLocalPath 必须成对同层级（原方案会导致 DLL 反推错位）

消费方 `getDllFilesByChangedItems(tfsItems, { repositoryPath: tfsLocalPath, sourcePath: tfsSourcePath })`（backupAppconfig.ts:68-71、home/index.vue 同构）的映射逻辑是：**服务器路径剥掉 tfsSourcePath 前缀 → 拼到 tfsLocalPath 下找 csproj/DLL**。因此二者必须指向同一层级的 server↔local 对应，否则所有变更文件映射全错。

原方案"tfsSourcePath ← GetServerPath(slnPath)"有两处错误：
- GetServerPath 传入的应是 sln **所在目录**，传 sln 文件路径会得到以 `.sln` 结尾的服务器路径；
- 即使改为 sln 目录，它与"最长前缀映射的本地根"也可能不同层级（映射 `$/SMOM.DEV.10.2` → `D:\ws`、sln 在 `D:\ws\SMOM\` 下时，sln 目录 server path 是 `$/SMOM.DEV.10.2/SMOM/...`，而映射本地根是 `D:\ws`——错位）。

**修正**：成对取值，默认取**最长前缀映射根的成对值**（`mapping[$/root]` 的 server + local），粒度与已有手工记录（`$/SMOM.DEV.10.2/SMO...` 分支根）一致；sln 目录层级作为参考值展示，允许用户在向导中调整（调整时同样成对切换）。

### 缺陷 2：多环境循环下 TFS 落库会重复执行（原方案遗漏）

向导段2循环中 Step6Confirm.validate **每个环境执行一次**（index.vue:113-124）。原方案未加守卫：第一环境插入成功后，第二环境再次 insertTfs 会撞 tfsName 查重返回"TFS名称已存在"→ validate 抛异常 → 整个落库失败。现有 servers 用 `isNew` 标志守卫（Step6Confirm.vue:107-120），TFS 落库需同样机制（如 draft.tfs.saved 标志或插入前先按对查重跳过）。

### 需补充的实施细节

1. **查重接口缺口**：getTfsList 仅支持 tfsName/tfsSourcePath 的 `LIKE '%x%'` 模糊过滤，无 tfsServerUrl 条件且模糊匹配无法精确查重。实施时需新增精确查询方法，或拉全量（maxResultCount 1000）在前端比对。
2. **tfsName 重名兜底**：默认取 Collection 尾段（如 SMOM.DEV）可能与既有记录（"新容/中恒"式命名）撞名，insertTfs 的名称查重会报错；查重命中 serverUrl+sourcePath 时直接复用，未命中但撞名时提示用户改名再提交。
3. **解码一致性**：实施前先确认现有 `execute_local_command`/`exec_local_command_spawn`（Rust 端）的输出解码方式，新命令保持同一套多编码策略，避免行为不一致。

### 次要备注

- workfold 输出中的 cloaked 映射行（`$/path: (已隐藏)`）会被映射正则收进 Mappings，无害（真实路径不以 `(` 开头，不影响最长前缀匹配），移植时顺手过滤更干净。
- 可选增强（超出本次需求）：向导保存 TFS 记录后，可将 appconfig 的 dllMode 默认设为 "TFS" 并把新记录 id 写入 dllModeValue，免去发布前手动关联。

### 二轮 Review（2026-08-23 实证复核）

在本机用真实 TF.exe 与真实工作区验证了方案的全部核心假设，发现 v2 修正案仍有 **1 个继承自参考项目的隐藏缺陷 + 1 个新发现的粒度问题**。

#### 实证环境与本机验证结果

- **TF.exe 实际位置**：`D:\Program Files\Microsoft Visual Studio\18\Professional\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe`（VS 2026）。FindTfExe 的目录模式 `{盘}\Program Files\Microsoft Visual Studio\{版本}\{Edition}\...` 能命中（版本目录"18"）✅
- **真实 Collection URL**：`http://218.13.91.106:8081/tfs/smom.dev`——与截图存量记录、消费方 `/collection:` 用法三方吻合 ✅
- **输出编码**：重定向字节实测为 GBK（`工作区` = B9 A4 D7 F7 C7 F8）；"工作区"行首字节 B9 不是合法 UTF-8 引导字节，严格 UTF-8 解码必失败 → 落到 GBK。方案的 UTF-8(严格)→GBK 顺序可行 ✅
- **正则实测**：对真实输出（含全角空格 `集合  :`、中文工作区名 `CJ_服务器工作区2 (成骏)`）三类行全部命中 ✅
- **存量记录实证**：映射 `$/SMOM.DEV.10.2/SMOM.NBXR: F:\项目\新容\C#`，sln 就在映射根（`F:\项目\新容\C#\SMOM.NBXR.sln`）——截图"新容"记录的 sourcePath 即映射根，v2 的"默认映射根层级"与存量数据一致 ✅

#### workfold 四种输入的真实行为（关键）

| 输入 | 输出 | 对方案的影响 |
|---|---|---|
| `workfold <sln文件路径>` | 映射行为**文件级**：`$/SMOM.DEV.10.2/SMOM.NBXR/SMOM.NBXR.sln: F:\...\SMOM.NBXR.sln` | ❌ 不能直接传 slnPath，必须传 dirname |
| `workfold <映射根目录>` | 4 行：分隔线+工作区+集合+**1 条**映射行（该分支根） | ✅ 正确的 (sourcePath, localPath) 来源 |
| `workfold <映射内子目录>` | 同上结构，但映射行是**子目录级**：`$/SMOM.DEV.10.2/SMOM.NBXR/Common: F:\...\Common` | ⚠️ 缺陷 B 见下 |
| `workfold <未映射目录>`（含映射根的父目录） | 错误文本"无法确定工作区…"，**退出码 0** | ⚠️ 缺陷 A 见下 |

#### 缺陷 A（继承自两个参考项目）：向上遍历是死代码

未映射路径 → exit=0 + 错误文本 → PublishTool 的 `if(!string.IsNullOrEmpty(output)) return ParseWorkfoldOutput(output)` 解析错误文本得 null 后**直接返回**，向上遍历分支永不执行（Mcp_TfsTools 按 exit==0 判 Success 同样问题）。对向导场景影响小（sln 在映射树内时一次直接命中），但 Rust 移植必须改为：**以"解析结果为 null"作为失败判据并触发向上遍历**，不能依赖退出码。

#### 缺陷 B（新发现）：`workfold <dir>` 返回最紧包含映射，不是映射根

v2 说"默认映射根层级"但未定义如何取得映射根：workfold 对子目录返回子目录级 pair（`$/…/SMOM.NBXR/Common ↔ F:\...\Common`），直接采用会把 tfsSourcePath 范围切窄到 sln 所在子目录，history 查询漏掉兄弟目录改动。新容场景（sln 恰在映射根）会掩盖此问题。

**修正**：从 dirname(slnPath) 开始逐级向上调 workfold，直到「返回的映射本地路径 == 查询目录」即为映射根，取该 pair（SMOM 的 sln 均在映射根，通常 1 次调用即命中）；向上遍历同时天然覆盖缺陷 A 的未映射场景（到盘符仍未命中则报"未识别到工作区"）。

#### 实施细节补充（实证新增）

- 输出为 **CRLF** 行尾（`cat -A` 实测 `^M$`），Rust 捕获组必须 trim `\r`（参考 C# 的 `.Trim()` 已处理，移植勿丢）；
- `workfold <dir>` 仅返回 1 条映射行，**无需**移植参考项目的多映射最长前缀匹配（那是 `/workspace:` 全表模式的配套逻辑），解析更简单；
- tf.exe workfold 走本地工作区缓存，实测瞬时返回、无需网络凭证 ✅（此前推断获得实证）。

#### 编码修复方案（照搬两个参考项目的修复方式）

两个参考项目的 TfCliRunner 采用**同一套修复策略**，且已在本机实证有效（workfold 输出实测为 GBK）：

**共同策略：字节级捕获 + 严格解码链**
1. **字节级捕获**：不使用运行时默认编码的 StreamReader，而是读 `StandardOutput.BaseStream` 原始字节（McpTfsTools TfCliRunner.cs:178-179、PublishTool TfCliRunner.cs:90-91）——避免框架默认编码在读取阶段就污染数据；
2. **严格解码链，逐级尝试**（解码异常即换下一个）：
   - UTF-8（严格，`throwOnInvalidBytes`）
   - **ANSI 代码页**（`CultureInfo.CurrentCulture.TextInfo.ANSICodePage`，中文系统 = 936/GBK）——动态取系统代码页，非硬编码
   - **OEM 代码页**（`TextInfo.OEMCodePage`，中文系统 = 936）
   - 最终兜底：宽松 UTF-8（McpTfsTools TfCliRunner.cs:223-256、PublishTool TfCliRunner.cs:125-155）
3. **严格判定的实现差异**：McpTfsTools（现代 .NET）用 `EncoderFallback/DecoderFallback.ExceptionFallback` + catch `DecoderFallbackException`；PublishTool（.NET Framework 4.7.2）同理但无需注册 Provider。McpTfsTools 额外有一步 **`Encoding.RegisterProvider(CodePagesEncodingProvider.Instance)`**（TfCliRunner.cs:12-15）——现代 .NET 默认不含代码页编码，必须注册后 `GetEncoding(936)` 才可用（.NET Framework 内置故 PublishTool 无此步）。

**Rust 移植对照表**（发布工具已依赖 `encoding_rs = "0.8"`，无需新增 crate）：

| 参考项目（C#） | Rust 等价实现 |
|---|---|
| BaseStream 字节级读取 | `std::process::Command` + `Stdio::piped()` 天然产出 `Vec<u8>` 原始字节 |
| UTF-8 严格 + DecoderFallbackException | `std::str::from_utf8(&bytes)` 返回 `Err` 即失败 |
| ANSI 代码页（动态 ANNICodePage） | `windows-sys` 取 `GetACP()`；ACP=936 时用 `encoding_rs::GBK`（或直接 GBK，见下注） |
| OEM 代码页（动态 OEMCodePage） | `GetOEMCP()`，同上映射 |
| 严格解码失败换下一个 | `encoding_rs` 的 `decode_without_bom_handling` 返回 `(String, had_errors)`，`had_errors==true` 即视为失败换下一级 |
| 宽松 UTF-8 兜底 | `String::from_utf8_lossy` |

> 注：本工具用户均为中文 locale（ANSI=936），若不想为此引入 `windows-sys`，可将 ANSI/OEM 两级简化为 `encoding_rs::GBK` → `encoding_rs::GB18030`（超集，更宽松）；但推荐按参考方式动态取代码页，跨 locale 用户也不会坏。

**顺带移植 McpTfsTools 的 FindTfExe 改进**：VS 版本目录按 `LastWriteTime` **降序**排序后再扫（TfCliRunner.cs:103-124），多 VS 共存时优先用最新版的 TF.exe（PublishTool 按目录枚举顺序，无此保证；本机 VS2026 装在 D 盘，多版本场景真实存在）。

### 三轮 Review（2026-08-23）

#### 缺陷 C（v3 遗留）：tfsName 默认取 Collection 尾段必然撞名

实证：两条存量记录**共享同一 Collection**（`http://218.13.91.106:8081/tfs/smom.dev`），仅 sourcePath 不同。v3 的"tfsName 默认 Collection 尾段（smom.dev）"会对**同集合的每个项目生成相同默认名**——第二个项目起必撞名，且首条记录会被命名为 smom.dev 而非客户名风格。

存量命名规律：客户名 ↔ 分支一一对应（新容 ↔ `$/SMOM.DEV.10.2/SMOM.NBXR`、中恒 ↔ `$/SMOM.DEV.8.3/SMOM.EIS.Zhongheng`）。客户名无法自动推导，但**分支尾段可以**且天然唯一（不同分支尾段不同；同分支已被 serverUrl+sourcePath 查重拦截不会二次插入）。

**修正**：tfsName 默认取 **tfsSourcePath 尾段**（如 SMOM.NBXR），用户可改成客户名。

#### 补充实证：映射根判定 1 次命中具有普遍性

中恒工作区 7 个 sln 全部直接位于映射根 `F:\项目\中恒MES\SMOM.EIS.Zhongheng`，workfold 返回 `$/SMOM.DEV.8.3/SMOM.EIS.Zhongheng: F:\项目\中恒MES\SMOM.EIS.Zhongheng`（映射本地路径 == 查询目录，1 次命中）。与新容一致——SMOM 项目 sln 均置于映射根，向上遍历仅作兜底。另：同根多 sln 任选其一，识别结果相同，无影响。

#### 实施细节补充（v3 遗漏）

1. **路径比较必须归一化**：「映射本地路径 == 查询目录」判定需先统一反斜杠、去尾部分隔符、ASCII 大小写折叠——tf.exe 回显的盘符大小写/斜杠风格不保证与查询串一致。
2. **tfvcPath 优先复用存量**：调用探测命令前先 getTfsList 取任一存量记录的 tfvcPath 作为入参，避免每次向导都触发全盘 VS 目录扫描；find_tf_exe 仅兜底。
3. **workfold 超时收紧**：单次调用建议 10-15s（参考项目的 120s 是为可能联网的命令设计的；workfold 实测本地缓存瞬时返回，且向上遍历会多次调用）。



### 修正后的实施路径（v3.1）

1. Rust 端 `detect_tfs_workspace(slnPath, tfvcPath?)`：find_tf_exe（PATH → 全盘 VS 目录，版本目录按修改时间降序优先最新）→ 对 **dirname(slnPath)** 及其祖先目录逐级执行 `tf workfold`（编码按「编码修复方案」章节：字节级捕获 + UTF-8严格→ANSI→OEM 严格解码链 + 宽松兜底；行尾 trim \r；中英双语正则；单次超时 10-15s）→ 以「映射本地路径 == 查询目录」（**归一化后比较**：统一反斜杠/去尾分隔符/ASCII 大小写折叠）判定映射根 → 返回 `{ tfsServerUrl, tfsSourcePath, tfsLocalPath, tfvcPath }`（映射根成对值）+ `workspaceName`；到盘符未命中返回明确错误码。
2. Step1Project 选完 sln 自动探测（slnPath 变化时重置重探），只读展示于「SLN 解析结果」区块（注意该区块现有 `v-if` 挂在 clientPaths 非空上，TFS 结果需独立展示条件）；**tfsName 默认取 tfsSourcePath 尾段**（如 SMOM.NBXR，用户可改客户名）供确认；探测命令的 tfvcPath 入参优先取存量 TFS 记录，避免全盘扫描；失败提示不阻塞。
3. Step6Confirm **仅首个环境**执行 TFS 落库（守卫标志）：按 tfsServerUrl+tfsSourcePath 精确查重（新增查询或全量比对），命中复用，未命中（且 tfsName 不撞名）insertTfs。
