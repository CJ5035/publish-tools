<template>
  <div>
    <h3>服务分配 ({{ currentEnv }})</h3>
    <div v-for="svc in envServices" :key="svc.name" style="border:1px solid #eee;padding:12px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <el-checkbox v-model="svc.enabled" :label="svc.name" />
        <el-tag size="small">Env {{ currentEnv }}</el-tag>
      </div>
      <template v-if="svc.enabled">
        <template v-if="svc.name==='wpfClient'">
          <div style="display:flex;gap:8px;">
            <el-select :model-value="svc.targets[0]?.serverKey" placeholder="选择服务器" style="width:200px;" @change="onWpfServerChange($event, svc)">
              <el-option v-for="srv in draft.servers" :key="srv.ip+':'+srv.port" :label="srv.name" :value="srv.ip+':'+srv.port" />
            </el-select>
            <el-input :model-value="svc.targets[0]?.path" placeholder="发布路径" style="flex:1;" @update:model-value="onWpfPathChange($event, svc)" />
          </div>
        </template>
        <template v-else>
          <div v-for="(t,idx) in svc.targets" :key="idx" style="display:flex;gap:8px;margin-bottom:6px;">
            <el-select v-model="t.serverKey" placeholder="选择服务器" style="width:200px;" @change="onServerChange(t, svc)">
              <el-option v-for="srv in draft.servers" :key="srv.ip+':'+srv.port" :label="srv.name" :value="srv.ip+':'+srv.port" />
            </el-select>
            <el-input v-model="t.path" placeholder="发布路径" style="flex:1;" />
            <el-button size="small" type="danger" @click="svc.targets.splice(idx,1)">删除</el-button>
          </div>
          <el-button size="small" @click="svc.targets.push({ serverKey:'', path:'' })">添加一行</el-button>
        </template>
      </template>
    </div>
  </div>
</template>
<script setup lang="ts">
import { inject, computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { WizardDraft } from './wizardTypes';
const props = defineProps<{ currentEnv: number }>();
const draft = inject<WizardDraft>('wizardDraft')!;
const envServices = computed(()=> draft.envConfig[props.currentEnv]?.services ?? []);
/** 选定服务器后自动带入该服务器的全部识别节点：当前行（路径为空时）填首个未占用节点，
 *  其余节点按识别顺序追加新行；已存在的路径跨行去重不重复带入，用户手填的行不覆盖；
 *  改选服务器时同样适用（旧路径保留，新服务器节点多退少补） */
function onServerChange(t:any, svc:any){
  const paths = ((draft.scanResults[t.serverKey] as any)?.[svc.name] ?? []) as string[];
  if(paths.length===0) return;
  if(!t.path){
    const used = new Set(svc.targets.map((x:any)=>x.path).filter(Boolean));
    const next = paths.find(p=>p && !used.has(p));
    if(next) t.path=next;
  }
  const used = new Set(svc.targets.map((x:any)=>x.path).filter(Boolean));
  for(const p of paths){
    if(p && !used.has(p)) svc.targets.push({ serverKey: t.serverKey, path: p });
  }
}
function onWpfServerChange(val:string, svc:any){
  if(!svc.targets[0]) svc.targets=[{ serverKey:val, path:'' }];
  else svc.targets[0].serverKey=val;
  if(!svc.targets[0].path){
    const p = (((draft.scanResults[val] as any)?.[svc.name] ?? []) as string[])[0];
    if(p) svc.targets[0].path=p;
  }
}
function onWpfPathChange(val:string, svc:any){
  if(!svc.targets[0]) svc.targets=[{ serverKey:'', path:val }];
  else svc.targets[0].path=val;
}
async function validate(): Promise<boolean>{
  const cfg = draft.envConfig[props.currentEnv];
  if(!cfg){ ElMessage.warning('环境配置缺失'); return false; }
  for(const svc of cfg.services){
    if(!svc.enabled) continue;
    if(svc.targets.length===0){ ElMessage.warning(`服务 ${svc.name} 至少需要 1 个目标`); return false; }
    for(const t of svc.targets){
      if(!t.serverKey || !t.path?.trim()){ ElMessage.warning(`服务 ${svc.name} 的服务器/路径不能为空`); return false; }
    }
    if(svc.name==='wpfClient' && svc.targets.length>1){ ElMessage.warning('wpfClient 仅允许 1 个目标'); return false; }
  }
  return true;
}
defineExpose({ validate });
</script>
