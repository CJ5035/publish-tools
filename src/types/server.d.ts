// serverTableParam
declare type GetServerTableParams = {
	skipCount: number;
	maxResultCount: number;
	projectId: number | null;
	name: string | null;
	sorting: string | null;
}

declare type SelectServerType = {
	id: number | null;
	name: string | null;
	serverPathArr: ServerOptionType[];
}

// server
declare type RowServerType = {
	id: number | null;
	projectId: number | null;
	projectName: string | null;
	name: string;
	os: number;
	ip: string;
	port: number;
	account: string;
	pwd: string;
	description: string | null;
	/** 环境标签集合（1=Dev/2=Uat/3=Pro）：配置向导维护并落库 t_server.env_tags；null=未指定 */
	envTags?: number[] | null;
	loading?: boolean | null;
};

interface ServerTableType extends TableType<GetServerTableParams> {
	data: RowServerType[];
}

declare interface ServerState {
	tableData: ServerTableType;
}
