/** 健康检查配置行类型（t_health_check） */
declare interface RowHealthCheckType {
	id?: number;                          // 新增时不传，由 RETURNING/lastInsertId 回填
	projectId: number;                    // 必填，与 environment/serviceName/serverId 构成唯一键
	environment: number;
	serviceName: string;
	serverId: number;
	checkUrl?: string;
	checkTimeout?: number;                // 秒，默认 30
	enabled: number;                      // 0/1
	createTime?: string;
}
