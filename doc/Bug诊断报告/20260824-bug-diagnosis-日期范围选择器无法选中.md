# Bug 诊断报告：应用配置弹窗"日期范围"选择器无法选中起始/截止日期

- **日期**：2026-08-24
- **状态**：已修复（2026-08-24，修复方案见文末"修复验证记录"）
- **严重级别**：P1 严重（"日期范围"获取dll方式完全不可用，连带表单校验无法通过、无法保存）
- **报告人**：Codex Agent（Bug Diagnosis Skill）

---

## 问题描述

用户报告：在"修改应用配置"弹窗中，"获取dll方式"选中"日期范围"后，打开日历面板选择日期，**无法选中起始日期和截止日期**。

截图显示：弹窗可正常打开、日历面板可正常弹出（编辑回显场景下输入框能显示已保存的日期值）。

## 环境信息

- **分支**：`feature/配置向导`
- **涉及组件**：`src/views/appconfig/components/appconfigDialog.vue`（全项目唯一使用 `datetimerange` 的位置）
- **依赖版本**：element-plus `^2.7.5`（实际安装 2.7.6）、dayjs 1.x
- **复现步骤**：
  1. 打开"应用配置"页面 → 新增（或修改）应用配置
  2. "获取dll方式"下拉框切换到"日期范围"（此处触发 `@change="onDllModeChange"`）
  3. 点击日期范围输入框，日历面板弹出
  4. 点击任意日期 → 选不中；"确定"按钮不可用 → 起始/截止日期永远无法设置

---

## 可能原因分析

| # | 原因 | 概率 | 理由 |
|---|------|------|------|
| 1 | `onDllModeChange` 将 `dllModeDate` 赋值为 `[Object(null), Object(null)]`，即两个空对象 `{}`。Element Plus 将 `{}` 解析为 **Invalid Dayjs**（且对象为真值，绕过组件内部 `some(day => !day)` 的兜底清理），range 面板把 Invalid 值直接写入 `minDate/maxDate/leftDate`，导致日历渲染 NaN、点击日期产生 Invalid Date 永远无法选中、确定按钮永久禁用 | **高（已实证）** | `appconfigDialog.vue:795`；实测 `dayjs({}).isValid() === false`；element-plus 源码链路逐行核实（见下文） |
| 2 | `formReset()` 不重置 `dllModeDate`，弹窗跨会话残留脏值：编辑一条 `dllModeValue` 为空的"日期范围"记录时，选择器会显示上一次会话的残留日期 | 中 | `appconfigDialog.vue:1294-1335` 的重置清单中没有 `dllModeDate` |
| 3 | `datetimerange` 类型需点两下日期后再点"确定"才提交，被误解为"选不中" | 低 | 属交互特性而非缺陷；且原因 1 场景下"确定"按钮本身就是禁用的 |
| 4 | Tauri WebView2 下 popper 层级/点击穿透 | 低 | 截图中日历完整可见、无遮挡；同弹窗内 TFS/Git 的 datetime 选择器工作正常 |

---

## 调用链与依赖分析

### 完整调用路径（出错的链路）

```
用户在"获取dll方式"下拉选择"日期范围"
  → el-select @change → onDllModeChange()                    [appconfigDialog.vue:790]
    → dllModeDate.value = [Object(null), Object(null)]       [appconfigDialog.vue:795]  ← 出错点
      → v-model 传入 el-date-picker(type="datetimerange")     [appconfigDialog.vue:59]
        → picker.mjs parsedValue 计算属性                     [element-plus picker.mjs:213]
          → [{}, {}] 非空数组 → dayjs({}) × 2 = [Invalid, Invalid]
          → 兜底 `some(day => !day)` 不生效（dayjs 对象为真值）→ Invalid 值原样下发
          → panel-date-range watch(props.parsedValue)         [use-range-picker.mjs:66]
            → minDate = InvalidDayjs / maxDate = InvalidDayjs / leftDate = InvalidDayjs
              ├─ 日历标题 = "NaN 年 NaN 月"（leftDate.year() = NaN）
              ├─ 日期格子 = NaN（daysInMonth() = NaN）
              ├─ 点击格子 → getDateOfCell = Invalid → formatEmit = Invalid → 选中永远不生效
              └─ 确定按钮：isValidRange([Invalid, Invalid]) = false → btnDisabled 永久 true
```

### 与之对照的正常链路（编辑回显，可正常选择）

```
openDialog(type="edit")                                       [appconfigDialog.vue:1338]
  → dllModeValue 存在且 dllMode=="日期范围"                    [appconfigDialog.vue:1363]
    → dllModeDate.value = [new Date(json[0]), new Date(json[1])]  ← 合法 Date，选择器工作正常
```

这解释了截图现象：截图是"编辑回显"状态（输入框显示 2026-08-16/2026-08-24，日历正常）。**只要用户不碰"获取dll方式"下拉就能正常改日期；一旦切换过下拉（哪怕是切到"日期范围"本身），选择器即被毒化**。用户描述的"选中日期范围，然后选择日期，无法选中"正是切换下拉触发的路径。

### 关键依赖节点

- **上游**：`el-select @change`（appconfigDialog.vue:46）；`formReset`（appconfigDialog.vue:1294，打开弹窗时执行）
- **下游**：`dllModeDate` → `onDllModeDateChange`（appconfigDialog.vue:1142）→ `dllModeValue`（JSON 字符串）→ 表单校验（appconfigDialog.vue:1252，"日期范围"必填）→ 落库
- **数据流**：`[Date, Date]` ─JSON.stringify→ `["YYYY-mm-dd HH:MM:SS", ...]` 字符串。存储格式本身没问题，问题只出在选择器绑定值被写成 `{}`。

### 影响范围评估

- `grep -rn "Object(null)|datetimerange" src/` 全项目仅 `appconfigDialog.vue` 一处，**修改该行不影响其他模块**
- 配置向导（projectWizard/Step6）无日期范围选择器，不受影响
- `generatePublishDialog.vue` 只读取 `dllModeValue` 值用于展示/传参，不受影响
- 后果链：选不了日期 → `dllModeValue` 为空 → 校验"请选择日期范围！"不通过 → 该配置无法保存

---

## 运行时实证（Node 复现 element-plus 内部逻辑）

用项目实际依赖 dayjs 模拟 `[Object(null), Object(null)]` 进入选择器后的每一步：

```
[1] parsedValue = ["Invalid Date","Invalid Date"] | some(!day) 兜底捕获: false
[2] 日历头标题 leftLabel = NaN 年 NaN 月
[3] startOfMonthDay = 7 | dateCountOfMonth = NaN
[4] 第三~六行格子文本 = [null × 28]（NaN）
[5] 点击第10个格子的日期 = Invalid Date, isValid: false
[6] formatEmit(点击值) = Invalid Date, isValid: false
[7] 确定按钮可用性 isValidRange = false（=按钮永久置灰）
```

---

## 验证动作

### 针对原因 1（主因）

- **验证方式**：代码检查 / 运行时控制台
- **位置**：`src/views/appconfig/components/appconfigDialog.vue:795`
- **具体操作**：
  ```ts
  // 现状
  dllModeDate.value = [Object(null), Object(null)];
  // Node 控制台直接验证 Object(null) 的真面目
  console.log(typeof Object(null), Object(null)); // "object" {}  —— 不是 null，更不是 Date
  ```
- **预期结果**：把该行改为 `dllModeDate.value = undefined;` 后，切换到"日期范围"再打开日历，可正常点选起始/截止日期，"确定"按钮在选中两个日期后变为可用。
- **回归确认**：`dllModeDate` 声明类型为 `ref<[Date, Date]>()`（appconfigDialog.vue:565），`undefined` 本就是合法初始态（首次打开弹窗即为 undefined，此时选择器正常）。

### 针对原因 2（次要，建议一并修复）

- **验证方式**：手工操作复现
- **位置**：`src/views/appconfig/components/appconfigDialog.vue:1294`（formReset 函数体）
- **具体操作**：
  1. 编辑一条已保存"日期范围"值的配置 → 关闭弹窗
  2. 新增配置 → 切到"日期范围" → 观察输入框
  3. （修复 1 之后残留路径）编辑一条 `dllModeValue` 为空的"日期范围"记录 → 观察输入框
- **预期结果**：当前会出现上一次会话的残留日期；在 `formReset` 中补一行 `dllModeDate.value = undefined;` 后残留消失。

---

## 边缘情况检查

| 维度 | 场景 | 当前行为 | 是否有问题 | 建议 |
|------|------|----------|------------|------|
| 空值处理 | 下拉切到"日期范围"（v-model 被 `{}` 毒化） | 日历 NaN、无法选择、确定禁用 | **是（本 Bug）** | 原因 1 修复 |
| 状态残留 | formReset 不重置 dllModeDate | 跨弹窗残留旧值 | 是 | formReset 补重置 |
| 编辑回显 | dllModeValue 有值时 new Date 回显 | 正常可选 | 否 | — |
| 编辑回显 | dllModeValue 为空时打开 | 残留毒化/旧值（同上） | 是 | 同上 |
| 清空操作 | 用户点选择器清空按钮 | picker 置 null → onDllModeDateChange 置空字符串，正常 | 否 | — |
| 类型耦合 | datetimerange 需点"确定"提交 | 交互特性；面板底部有确定按钮 | 否（但易误解，可留意） | — |
| 其他入口 | 配置向导 / 生成发布弹窗 | 无同款选择器，仅读取 dllModeValue | 否 | — |
| 版本兼容 | element-plus 2.7.6 | 源码逐行核实：parsedValue 兜底只拦 falsy，拦不住 `{}` | 否（升级无济于事，属用法错误） | 修调用方 |

---

## 总结与建议

**根因**：`appconfigDialog.vue:795` 用 `Object(null)`（返回空对象 `{}`，并非 null/Date）给 `datetimerange` 选择器的 v-model 赋"空值"，产生两个 Invalid Dayjs 并绕过 element-plus 的空值兜底，导致日历渲染 NaN、点击永远产生 Invalid 日期、确定按钮永久禁用——即"无法选中起始日期和截止日期"。

**推荐修复**（两行）：

```ts
// 1) appconfigDialog.vue:795 —— onDllModeChange 内
dllModeDate.value = undefined;   // 原值：[Object(null), Object(null)]

// 2) appconfigDialog.vue:1294 formReset() 函数体内追加
dllModeDate.value = undefined;   // 消除跨弹窗残留
```

修复后回归：新增/编辑切换"日期范围" → 正常点选起止日期 → 确定提交 → 保存后在发布流程（getDllModeDateRange）取值正常。

---

## 修复验证记录（2026-08-24）

- 修复内容：`onDllModeChange` 毒化赋值改为 `undefined`（appconfigDialog.vue:795）；`formReset()` 补充 `dllModeDate` 重置。
- 验证方式：`npx vue-tsc --noEmit` 通过；`npm run test` 3 个测试文件通过；`npm run tauri dev` 手动验证矩阵 6 项全部通过（新增/编辑/切换下拉/跨会话残留/校验）。
