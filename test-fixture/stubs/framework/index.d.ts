export type Channel = "prod" | "dev";
export interface BuildInfo {
	readonly branch?: string;
	readonly commit?: string;
	readonly dirty?: boolean;
	readonly channel?: Channel;
	readonly builtAt?: number;
}
