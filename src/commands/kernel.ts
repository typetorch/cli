/**
 * `typetorch kernel deploy`: build the kernel place (`<kernel>/place.project.json`) and publish it as the live place
 * version. This REPLACES THE WHOLE PLACE; servers pick it up when they restart (Creator Hub version history can
 * revert it).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { rojoBinary, OUT_DIR } from "../build";
import type { Project } from "../config";
import { bold, emitJson, formatBytes, formatSeconds, info, isJson, Stopwatch, warn } from "../log";
import { run } from "../proc";
import { openCloud, project } from "./common";

export const kernelFlags = { kernel: "string", "dry-run": "boolean" } as const;
export const PLACE_FILE = `${OUT_DIR}/place.rbxl`;

/** --kernel, else typetorch.json "kernel", else node_modules/@typetorch/kernel, else ../kernel (sibling checkout). */
export function resolveKernelDir(proj: Project, flag?: string): string {
	const candidates = flag
		? [flag]
		: proj.config.kernel
			? [proj.config.kernel]
			: ["node_modules/@typetorch/kernel", "../kernel"];
	for (const candidate of candidates) {
		const dir = resolve(proj.root, candidate);
		if (existsSync(join(dir, "place.project.json"))) return dir;
	}
	throw new UsageError(
		`no kernel place project found (looked for place.project.json in ${candidates.join(", ")}); pass --kernel <dir>`,
	);
}

export async function kernelCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub !== "deploy") throw new UsageError(`unknown kernel subcommand "${sub ?? ""}" (only "deploy")`);
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const kernelDir = resolveKernelDir(proj, flagString(args, "kernel"));
	const oc = dryRun ? undefined : openCloud()!;
	const watch = new Stopwatch();

	let kernelVersion: string | undefined;
	try {
		kernelVersion = JSON.parse(readFileSync(join(kernelDir, "package.json"), "utf8"))?.version;
	} catch {}
	mkdirSync(join(proj.root, OUT_DIR), { recursive: true });
	const placeProject = join(kernelDir, "place.project.json");
	await watch.stage("build", () => run([rojoBinary(), "build", placeProject, "-o", PLACE_FILE], proj.root));
	const bytes = new Uint8Array(readFileSync(join(proj.root, PLACE_FILE)));
	const where = `universe ${proj.config.universeId}, place ${proj.config.placeId}`;
	info(`  build    ${formatSeconds(watch.timings.build)}  ${relative(proj.root, placeProject)} -> ${PLACE_FILE}  ${formatBytes(bytes.length)}${kernelVersion ? `  (kernel ${kernelVersion})` : ""}`);
	warn(`kernel deploy REPLACES THE WHOLE PLACE (${where}) with the kernel place; revert from the place's version history in Creator Hub if needed`);

	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, kernelDir, kernelVersion, file: PLACE_FILE, bytes: bytes.length, universeId: proj.config.universeId, placeId: proj.config.placeId });
		info(bold(`dry run: would publish ${PLACE_FILE} to ${where}`));
		return;
	}
	const response = await watch.stage("publish", () => oc!.publishPlace(proj.config.universeId, proj.config.placeId, bytes));
	const timings = watch.total();
	if (isJson()) return emitJson({ kernelDir, kernelVersion, bytes: bytes.length, response, timings });
	info(`  publish  ${formatSeconds(timings.publish)}  ${JSON.stringify(response)}`);
	info(bold(`published place version ${response?.versionNumber ?? "?"} (${where}); servers run it after they restart`));
}
