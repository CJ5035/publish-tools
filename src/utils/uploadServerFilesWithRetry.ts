import { cmdInvoke } from "@/utils/command";
import { getRetryArgs, isSettingsLoadFailed } from "@/utils/publishSettings";

/**
 * upload_server_files 命令入参（不含重试参数）。
 * username/password/server 允许为 null：原调用点变量（如 serverAccount）本身是 string | null，
 * 原代码经 cmdInvoke 宽松入参直接透传，null 时 Rust 反序列化失败并返回失败结果——这里保持原行为不变。
 */
export interface UploadServerFilesArgs {
    localPaths: string[];
    remotePaths: string[];
    username: string | null;
    password: string | null;
    server: string | null;
}

/** 共享上传工具的重试选项（maxRetries 为累计 Rust 上传调用总次数） */
export interface UploadRetryOptions {
    /** 累计 Rust upload 调用次数，最小 1，默认取发布设置 winUploadRetryCount（1-100） */
    maxRetries?: number;
    /** 相邻两次 Rust 调用之间的等待毫秒数，默认取 winUploadRetryInterval * 1000 */
    intervalMs?: number;
    /** 每次失败准备重试时回调（避免工具依赖某个页面的 printInfoLog） */
    onRetry?: (attempt: number, maxRetries: number, error: unknown) => void;
}

/**
 * 上传文件到服务器（带前端重试）。
 *
 * 重试语义：Rust 内层通过 retryCount=1 短路只执行一次且不等待（while attempts < max_attempts 守卫生效），
 * 因此"重试间隔"由前端在本工具内通过 intervalMs 控制，而不是依赖 Rust 的 retry_interval_secs。
 * 切勿把 intervalMs 传 0 期望 Rust 立即重试——那是 retryCount=1 的作用。
 *
 * 注意：getRetryArgs('upload') 返回 snake_case 键（retry_count/retry_interval_secs），
 * Tauri 命令参数键须为 camelCase，故此处显式构造 { retryCount, retryIntervalSecs }，不得 spread 返回值。
 */
export async function uploadServerFilesWithRetry(
    args: UploadServerFilesArgs,
    options?: UploadRetryOptions
): Promise<DataResultType<any>> {
    // 默认值来自发布设置缓存（调用前应已 await loadPublishSettings()）
    const retryArgs = getRetryArgs("upload");
    let maxRetries = options?.maxRetries ?? retryArgs.retry_count;
    let intervalMs = options?.intervalMs ?? retryArgs.retry_interval_secs * 1000;

    // 入口校验：maxRetries 整数 1-100；intervalMs 非负整数；非法时回退默认 10/3000ms，
    // 避免 NaN、0 或负数导致死循环或异常等待
    if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 100) {
        console.warn("uploadServerFilesWithRetry: maxRetries 非法，已回退默认 10", { maxRetries });
        maxRetries = 10;
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 0) {
        console.warn("uploadServerFilesWithRetry: intervalMs 非法，已回退默认 3000ms", { intervalMs });
        intervalMs = 3000;
    }

    // 发布设置加载失败/字段非法时已回退默认值，此处额外告警，不静默吞掉
    if (isSettingsLoadFailed()) {
        console.warn("uploadServerFilesWithRetry: 发布设置加载失败，上传重试使用默认 10/3000ms");
    }

    const onRetry = options?.onRetry;
    const invokeUpload = () =>
        cmdInvoke("upload_server_files", {
            ...args,
            retryCount: 1,
            retryIntervalSecs: 0,
        });

    let result = await invokeUpload();
    for (let attempt = 1; attempt < maxRetries; attempt++) {
        if (result.code === 0) return result;
        onRetry?.(attempt, maxRetries, result.data);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        result = await invokeUpload();
    }
    return result;
}
