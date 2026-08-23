# Task 4 Report — Step1Project SLN 即选即解析（与 TFS 探测并行）

## Status
DONE

## Brief Source
`实施文档合集/2026-08-24-配置向导三期实施计划.md` Task 4 + `.superpowers/sdd/task-4-brief.md`

## What Implemented
- `src/views/appconfig/components/projectWizard/Step1Project.vue:80` vue import 追加 `watch`（`import { ref, computed, inject, onMounted, watch } from 'vue'`），未重复导入 `ServiceName`（已在类型导入中，避免 TS2300）。
- `src/views/appconfig/components/projectWizard/Step1Project.vue:124-159` 新增 `slnParsing`/`lastParsedPath`/`PARSE_MODULES(5项)`，重写 `onSelectSln` 为 `Promise.all([parseSlnNow(), detectTfs()])` 并行，新增 `parseSlnNow`（`Promise.all` 并发 5× `parse_sln_project`，失败 `delete clientPaths[svc]` + `console.warn`，`finally slnParsing=false`，成功后更新 `lastParsedPath`），新增 `watch([isNewVersion, buildMode])` 在 `slnPath===lastParsedPath` 时自动 `parseSlnNow()`。
- `src/views/appconfig/components/projectWizard/Step1Project.vue:204` validate 移除 5 模块串行循环，替换为 `if(draft.project.slnPath !== lastParsedPath.value) await parseSlnNow();`，保留 `exists` 校验在前。
- `src/views/appconfig/components/projectWizard/Step1Project.vue:30,46` 模板：`<h4>SLN 解析结果 <el-tag v-if="slnParsing" size="small">解析中…</el-tag></h4>`；选择按钮加 `:loading="slnParsing"`。

## Global Constraints
- 仅修改 `src/views/appconfig/components/projectWizard/Step1Project.vue`，符合 `projectWizard/**` 允许范围。
- `noUnusedLocals: true` 满足（`watch`/`slnParsing`/`lastParsedPath`/`PARSE_MODULES`/`parseSlnNow` 均有使用）。
- 服务器键 `${ip}:${port}` 未触及。

## Verification
- `node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit` → `EXIT:0`
- `read Step1Project.vue:30,46,80,124-159,204` verbatim 校验与 brief 一致

## Files Changed
- `src/views/appconfig/components/projectWizard/Step1Project.vue`

## Commit
- `feat(wizard): S1 SLN 即选即解析（与 TFS 探测并行，版本/模式切换自动重解析）`
