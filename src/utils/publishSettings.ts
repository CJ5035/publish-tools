import { useSettingsDb } from '@/database/settings/index';

const _default: RowSettingsType = {
    id: 1,
    oneClickPublishEnabled: 0,
    winServiceRetryCount: 3,
    winServiceRetryInterval: 2,
    winCopyRetryCount: 3,
    winCopyRetryInterval: 2,
    winUploadRetryCount: 10,
    winUploadRetryInterval: 3,
    updateTime: '',
};

export function defaultSettings(): RowSettingsType {
    return { ..._default };
}

let cached: RowSettingsType | null = null;

let loadFailed = false;

/** 上一次 loadPublishSettings() 是否失败/字段非法（供共享 upload 工具判断是否已回退默认值） */
export function isSettingsLoadFailed(): boolean {
    return loadFailed;
}

/**
 * 查 DB 并刷新模块级缓存。
 * 设置页保存后经 mittBus 'settingsChanged' 触发重载；发布/还原流程入口也会调用。
 * 查询失败或上传重试字段非法时回退默认设置，并置 loadFailed 供共享工具告警。
 */
export async function loadPublishSettings(): Promise<RowSettingsType> {
    loadFailed = false;
    const r = await useSettingsDb().getSettings();
    if (r.code !== 0 || !r.data) {
        loadFailed = true;
        console.warn("读取发布设置失败，已回退默认值：" + r.msg);
        cached = defaultSettings();
        return cached;
    }
    const s = r.data;
    const okCount = Number.isInteger(s.winUploadRetryCount) && s.winUploadRetryCount >= 1 && s.winUploadRetryCount <= 100;
    const okInterval = Number.isInteger(s.winUploadRetryInterval) && s.winUploadRetryInterval >= 1 && s.winUploadRetryInterval <= 60;
    if (!okCount || !okInterval) {
        loadFailed = true;
        console.warn("上传重试字段非法，已回退默认 10/3", { count: s.winUploadRetryCount, interval: s.winUploadRetryInterval });
        cached = defaultSettings();
        return cached;
    }
    cached = s;
    return cached;
}

/**
 * 同步读缓存的重试参数。调用前应已 await loadPublishSettings()。
 * group='service'/'serviceStop' → 服务关闭/启动命令；group='copy' → copy_path；group='upload' → SSH upload。
 * 注意：返回键为 snake_case（retry_count / retry_interval_secs），与现网 30 处 spread 点保持一致；
 * Tauri 命令参数键须为 camelCase，故调用方（尤其共享 upload 工具）不得直接 spread 本返回值，
 * 须显式转成 { retryCount, retryIntervalSecs } 再传 cmdInvoke（见「共享 upload 工具接口」）。
 */
export function getRetryArgs(group: 'service' | 'serviceStop' | 'copy' | 'upload'): {
    retry_count: number;
    retry_interval_secs: number;
} {
    const s = cached ?? defaultSettings();
    if (group === 'service' || group === 'serviceStop') {
        return { retry_count: s.winServiceRetryCount, retry_interval_secs: s.winServiceRetryInterval };
    }
    if (group === 'upload') {
        return { retry_count: s.winUploadRetryCount, retry_interval_secs: s.winUploadRetryInterval };
    }
    return { retry_count: s.winCopyRetryCount, retry_interval_secs: s.winCopyRetryInterval };
}
