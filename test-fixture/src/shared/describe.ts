import { BUILD } from "./build";

export function describe(): string {
	return `${BUILD.branch}@${BUILD.commit}${BUILD.dirty ? "*" : ""} (${BUILD.channel}, built ${BUILD.builtAt})`;
}
