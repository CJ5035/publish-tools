/** 扫描规则行类型（t_scan_config） */
declare interface RowScanConfigType {
	id?: number;            // 新增时不传，由 RETURNING/lastInsertId 回填
	name: string;
	excludePatterns?: string;   // JSON 数组字符串
	includePatterns?: string;   // JSON 数组字符串
	excludeSystemDirs: number;  // 0/1
	excludeHiddenDirs: number;  // 0/1
	isGlobal: number;           // 0/1
	projectId?: number | null;
	createTime?: string;
	serviceKeywords?: string; // JSON 对象字符串 {"webApiHost":["webapi","api"],...}
}
