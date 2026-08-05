/** 全局设置行类型（t_settings，id 恒 = 1） */
declare interface RowSettingsType {
	id: number;
	oneClickPublishEnabled: number;       // 0 关 / 1 开
	winServiceStopRetryCount: number;
	winServiceStopRetryInterval: number;  // 秒
	winCopyRetryCount: number;
	winCopyRetryInterval: number;         // 秒
	winUploadRetryCount: number;          // SSH upload 外层总调用次数，1-100
	winUploadRetryInterval: number;       // SSH upload 外层失败等待间隔（秒），1-60
	updateTime?: string;
}
