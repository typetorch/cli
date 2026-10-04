import { $assert, $print, $warn } from "rbxts-transform-debug";
import { BUILD, SOURCES } from "./build";

export function describe(): string {
	// Debug macros: kept with their [src/...:line] prefix in dev builds, compiled away in prod builds.
	$print("fixture-debug-print", BUILD.channel);
	$assert(BUILD.channel !== undefined, "fixture-assert-message");
	if (BUILD.dirty) $warn("fixture-debug-warn");
	return `${BUILD.branch}@${BUILD.commit}${BUILD.dirty ? "*" : ""} (${BUILD.channel}, built ${BUILD.builtAt}, template ${SOURCES.template})`;
}
