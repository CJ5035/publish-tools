/** 发布任务行类型（t_deploy_task） */
declare interface RowDeployTaskType {
	id?: number;                          // 新增时不传，由 RETURNING/lastInsertId 回填
	projectId?: number;
	projectName?: string;
	environment?: number;
	appconfigId?: number;
	runId?: string;
	triggerType?: DeployTriggerType;
	status?: DeployTaskStatus;
	operator?: string;
	source?: DeployTaskSource;
	selectedServices?: string | null;  // JSON 数组字符串
	startTime?: string;
	endTime?: string;
	rollbackTime?: string;
	rollbackReason?: string;
	createTime?: string;
}

/** 发布任务详情行类型（t_deploy_task_detail） */
declare interface RowDeployTaskDetailType {
	id?: number;                          // 新增时不传，由 RETURNING/lastInsertId 回填
	taskId?: number;
	runId?: string;
	serviceName?: string;
	serverId?: number;
	serverName?: string;
	serverIdentity?: string;
	remotePath?: string;
	status?: DeployDetailStatus;
	retryCount?: number;
	healthCheckResult?: string;
	backupPath?: string;
	errorMessage?: string;
	step?: DeployDetailStep;
	startTime?: string;
	endTime?: string;
	createTime?: string;
}

type DeployTriggerType = 'manual' | 'scheduled';
type DeployTaskStatus = 'running' | 'success' | 'failed' | 'partial';
type DeployTaskSource = 'home' | 'papersPublish' | 'restore' | 'generate';
type DeployDetailStatus = 'pending' | 'running' | 'success' | 'failed';
type DeployDetailStep = 'upload' | 'unzip' | 'switch' | 'health' | 'backup' | 'copy' | 'zip';
