/**
 * `typetorch migrate --from flamework`: the mechanical part of moving a Flamework 1.x game to TypeTorch, done with the
 * TypeScript compiler API (the game's own `typescript`, loaded from its node_modules), plus a list of what needs
 * judgment. Nothing here is specific to one game: it works from Flamework's API and the game's own tsconfig.
 *
 * Rewrites:
 *   - imports from @flamework/core -> @typetorch/framework (Service, Controller, OnInit, OnStart, OnTick, OnPhysics,
 *     OnRender, Modding, Reflect, Dependency); unsupported names are dropped when unused, else kept and flagged;
 *   - @Service / @Controller classes `extends Module` (a local base class gets it instead), `super()` in constructors;
 *   - `@metadata flamework:parameters` / `flamework:implements` JSDoc tags -> typetorch:*;
 *   - ignite files (`*.server.ts` / `*.client.ts` with Flamework.ignite) -> `<realm>/boot.ts`; other top-level code
 *     moves into a generated module in the first module folder (reported);
 *   - networking: `--net compat` (default) swaps Networking.createEvent / createFunction for createFlameworkCompat,
 *     so every call site stays; `--net native` rewrites call sites to createNetwork (connect -> on in the trove, ...).
 * Flags (not rewritten): module-level state, Players.PlayerAdded.Connect, _G, loops / task.* / connections outside a
 * trove, @flamework/components, Dependency<T>() before construction, loadstring, remotes, MessagingService,
 * DataStore / ProfileService code, BindToClose, toolchain leftovers.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type * as TS from "typescript";

type TypeScript = typeof TS;

export type NetMode = "compat" | "native";

export type FlagKind =
	| "module-state"
	| "player-added"
	| "global"
	| "loop"
	| "task"
	| "connection"
	| "components"
	| "dependency"
	| "loadstring"
	| "remotes"
	| "messaging"
	| "data"
	| "bind-to-close"
	| "flamework"
	| "networking"
	| "moved"
	| "toolchain";

/** Report sections, in order: title and the one-line fix shown under it. */
export const FLAG_KINDS: Record<FlagKind, { title: string; hint: string }> = {
	flamework: {
		title: "Flamework API without a TypeTorch equivalent",
		hint: "Rewrite by hand (migrate guide section 4; transformer README \"Migrating from Flamework\").",
	},
	networking: {
		title: "Networking features the rewrite doesn't carry",
		hint: "See guides/from-flamework.md (middleware, server -> client requests, Unreliable).",
	},
	moved: {
		title: "Code moved out of an ignite file",
		hint: "It now runs in a module's onStart, once per generation: put its connections and threads in this.trove.",
	},
	dependency: {
		title: "Dependency<T>() before every module is constructed",
		hint: "It throws there: call it from onInit/onStart or a method, or use constructor injection / Lazy<T>.",
	},
	"module-state": {
		title: "Module-level state",
		hint: "It starts over on every swap: keep it on the module instance, or in this.ctx.persist / playerState (rule 2).",
	},
	"player-added": {
		title: "Players.PlayerAdded.Connect",
		hint: "A new generation misses players already in the server: use onPlayerAdded or observePlayers (rule 3).",
	},
	connection: {
		title: "Connections outside a trove",
		hint: "A connection nobody disconnects keeps an old generation running: this.trove.connect(...) / this.trove.add(...) (rule 1).",
	},
	task: {
		title: "task.spawn / delay / defer outside a trove",
		hint: "The thread outlives its generation: this.trove.add(task.delay(...)) (rule 7).",
	},
	loop: {
		title: "Loops outside onStart",
		hint: "The loop keeps running after a swap: run it in onStart, or this.trove.add(task.spawn(...)) (rule 5).",
	},
	global: {
		title: "_G",
		hint: "It outlives generations: share through modules, or keep the value in persist (rule 6).",
	},
	components: {
		title: "@flamework/components",
		hint: "No components in TypeTorch: a module with observeElement or @rbxts/observers (rule 4).",
	},
	loadstring: { title: "loadstring", hint: "loadstring is off in live games: remove it." },
	remotes: {
		title: "RemoteEvents / RemoteFunctions",
		hint: "A generation never creates remotes: declare a leaf in the network instead (section 6).",
	},
	messaging: {
		title: "MessagingService",
		hint: "Topics share Roblox's 5-subscription budget with the kernel: keep it to one topic.",
	},
	data: {
		title: "Player data (DataStore / ProfileService)",
		hint: "The library lives outside the payload, its handles in persist: guides/player-data.md.",
	},
	"bind-to-close": {
		title: "BindToClose",
		hint: "It can't be unbound: use onStop, or bind once per server behind a persisted flag (rule 8).",
	},
	toolchain: {
		title: "Toolchain leftovers",
		hint: "Migrate guide step 2 (package.json, tsconfig.json, the payload project).",
	},
};

export interface Flag {
	kind: FlagKind;
	/** Project-relative, forward slashes. */
	file: string;
	line: number;
	message: string;
	/** The source line, trimmed. */
	code?: string;
}

/** One file's new text: `before` undefined = created, `after` undefined = deleted. */
export interface FileChange {
	path: string;
	before?: string;
	after?: string;
}

export interface MigrateResult {
	changes: FileChange[];
	flags: Flag[];
	/** What was rewritten, one line each ("src/server/x.ts: extends Module"). */
	notes: string[];
	stats: Record<string, number>;
	typescriptVersion: string;
}

export interface MigrateOptions {
	projectDir: string;
	net: NetMode;
	/** A TypeScript module to use instead of the game's (tests). */
	typescript?: TypeScript;
}

/** Names @flamework/core exports that @typetorch/framework has too. */
const CORE_NAMES = new Set(["Service", "Controller", "OnInit", "OnStart", "OnTick", "OnPhysics", "OnRender", "Modding", "Reflect", "Dependency"]);
const FRAMEWORK = "@typetorch/framework";
const CORE = "@flamework/core";
const NETWORKING = "@flamework/networking";
const COMPONENTS = "@flamework/components";

/**
 * The game's own TypeScript (rbxtsc compiles with it), else the copy next to this CLI (development). Only a JS compiler
 * API counts: Bun may auto-install some other `typescript` for a folder without node_modules (7.x has no JS API).
 */
export function loadTypeScript(projectDir: string): TypeScript {
	const attempts = [join(projectDir, "package.json"), import.meta.url];
	for (const from of attempts) {
		try {
			const candidate = createRequire(from)("typescript") as Partial<TypeScript>;
			if (typeof candidate.createProgram === "function" && candidate.sys !== undefined) return candidate as TypeScript;
		} catch {
			// next
		}
	}
	throw new Error(`no "typescript" in ${join(projectDir, "node_modules")}: run bun install (roblox-ts needs it too)`);
}

const slash = (path: string) => path.replace(/\\/g, "/");

// Text edits -----------------------------------------------------------------------------------------------------------

interface Edit {
	start: number;
	end: number;
	text: string;
	order: number;
}

class FileEdits {
	readonly edits: Edit[] = [];
	private order = 0;
	constructor(readonly text: string) {}
	replace(start: number, end: number, text: string) {
		this.edits.push({ start, end, text, order: this.order++ });
	}
	insert(at: number, text: string) {
		this.replace(at, at, text);
	}
	/** Whether [start, end) overlaps an edit already made (insertions only clash strictly inside a replaced range). */
	overlaps(start: number, end: number) {
		return this.edits.some((edit) => edit.end > start && edit.start < end && edit.end > edit.start && end > start);
	}
	apply(): string {
		const sorted = [...this.edits].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) || a.order - b.order);
		let out = "";
		let at = 0;
		for (const edit of sorted) {
			if (edit.start < at) throw new Error(`overlapping edits at ${edit.start}`);
			out += this.text.slice(at, edit.start) + edit.text;
			at = edit.end;
		}
		return out + this.text.slice(at);
	}
}

// The codemod ----------------------------------------------------------------------------------------------------------

interface ImportedName {
	/** The name in the module. */
	name: string;
	/** The local name. */
	local: string;
	typeOnly: boolean;
}

interface FlameworkImport {
	decl: TS.ImportDeclaration;
	module: string;
	named: ImportedName[];
	/** `import X from` / `import * as X from`: not rewritten. */
	other?: string;
}

interface FileState {
	source: TS.SourceFile;
	path: string;
	edits: FileEdits;
	imports: FlameworkImport[];
	/** Names to import from @typetorch/framework (value imports). */
	need: Set<string>;
	/** Local names whose every use was rewritten (their import goes). */
	dropLocals: Set<string>;
	/** A deleted file. */
	deleted?: boolean;
	quote: string;
	indentUnit: string | undefined;
	moduleName: string;
}

interface NetDecl {
	file: FileState;
	kind: "events" | "functions";
	statement: TS.VariableStatement;
	declaration: TS.VariableDeclaration;
	c2s: string;
	s2c: string;
	s2cHasLeaves: boolean;
}

interface HandlerDecl {
	file: FileState;
	declaration: TS.VariableDeclaration;
	statement: TS.VariableStatement;
	side: "server" | "client";
	kind: "events" | "functions";
	net: NetDecl;
}

export function migrateFlamework(options: MigrateOptions): MigrateResult {
	const ts = options.typescript ?? loadTypeScript(options.projectDir);
	return new Codemod(ts, resolve(options.projectDir), options.net).run();
}

class Codemod {
	private readonly program: TS.Program;
	private readonly checker: TS.TypeChecker;
	private readonly rootDir: string;
	private readonly files = new Map<string, FileState>();
	private readonly created = new Map<string, string>();
	private readonly flags: Flag[] = [];
	private readonly flagKeys = new Set<string>();
	private readonly notes: string[] = [];
	private readonly stats: Record<string, number> = {};
	/** Classes already given `extends Module` (directly or as a base). */
	private readonly moduleClasses = new Set<TS.ClassLikeDeclaration>();

	constructor(
		private readonly ts: TypeScript,
		private readonly projectDir: string,
		private readonly net: NetMode,
	) {
		const configPath = ts.findConfigFile(projectDir, ts.sys.fileExists, "tsconfig.json");
		if (!configPath || resolve(dirname(configPath)) !== projectDir) throw new Error(`no tsconfig.json in ${projectDir}`);
		const config = ts.readConfigFile(configPath, ts.sys.readFile);
		if (config.error) throw new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectDir);
		this.rootDir = resolve(parsed.options.rootDir ?? join(projectDir, "src"));
		const options = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined };
		const names = parsed.fileNames.filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"));
		this.program = ts.createProgram(parsed.fileNames.filter((name) => /\.tsx?$/.test(name)), options);
		this.checker = this.program.getTypeChecker();
		for (const name of names) {
			const source = this.program.getSourceFile(name);
			if (!source) continue;
			const path = slash(relative(projectDir, name));
			if (path.startsWith("..") || path.includes("node_modules/")) continue;
			this.files.set(source.fileName, this.fileState(source, path));
		}
		// Files with no indented line (an ignite file) and generated ones use the project's usual indent.
		const units = [...this.files.values()].map((file) => file.indentUnit).filter((unit): unit is string => unit !== undefined);
		const tabs = units.filter((unit) => unit === "\t").length;
		this.projectIndent = units.length === 0 || tabs * 2 >= units.length ? "\t" : (units.find((unit) => unit !== "\t") ?? "\t");
		for (const file of this.files.values()) file.indentUnit ??= this.projectIndent;
	}

	private projectIndent = "\t";

	private fileState(source: TS.SourceFile, path: string): FileState {
		const text = source.text;
		const tabbed = /^\t/m.test(text);
		const spaced = /^( +)\S/m.exec(text)?.[1].length;
		const state: FileState = {
			source,
			path,
			edits: new FileEdits(text),
			imports: [],
			need: new Set(),
			dropLocals: new Set(),
			quote: /from '/.test(text) && !/from "/.test(text) ? "'" : '"',
			indentUnit: tabbed ? "\t" : spaced !== undefined ? " ".repeat(Math.min(spaced, 4)) : undefined,
			moduleName: "Module",
		};
		for (const statement of source.statements) {
			if (!this.ts.isImportDeclaration(statement) || !this.ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const module = statement.moduleSpecifier.text;
			const clause = statement.importClause;
			// A local `Module` from somewhere else: ours gets another name.
			if (module !== FRAMEWORK && clause?.namedBindings && this.ts.isNamedImports(clause.namedBindings)) {
				if (clause.namedBindings.elements.some((e) => e.name.text === "Module")) state.moduleName = "TypeTorchModule";
			}
			if (module !== CORE && module !== NETWORKING && module !== COMPONENTS) continue;
			const entry: FlameworkImport = { decl: statement, module, named: [] };
			if (clause?.name) entry.other = clause.name.text;
			const bindings = clause?.namedBindings;
			if (bindings && this.ts.isNamespaceImport(bindings)) entry.other = bindings.name.text;
			if (bindings && this.ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					entry.named.push({
						name: (element.propertyName ?? element.name).text,
						local: element.name.text,
						typeOnly: clause!.isTypeOnly || element.isTypeOnly,
					});
				}
			}
			state.imports.push(entry);
		}
		if (state.moduleName === "Module") {
			for (const statement of source.statements) {
				if ((this.ts.isClassDeclaration(statement) || this.ts.isInterfaceDeclaration(statement)) && statement.name?.text === "Module") {
					state.moduleName = "TypeTorchModule";
				}
			}
		}
		return state;
	}

	run(): MigrateResult {
		this.rewriteModuleClasses();
		this.rewriteMetadataTags();
		if (this.net === "native") this.rewriteNetworkingNative();
		else this.rewriteNetworkingCompat();
		this.migrateIgniteFiles();
		this.rewriteImports();
		this.scanFlags();
		this.checkToolchain();
		return this.result();
	}

	// Helpers ------------------------------------------------------------------------------------------------------

	private count(stat: string, by = 1) {
		this.stats[stat] = (this.stats[stat] ?? 0) + by;
	}

	private note(file: FileState | string, text: string) {
		this.notes.push(`${typeof file === "string" ? file : file.path}: ${text}`);
	}

	private flag(kind: FlagKind, file: FileState, node: TS.Node | number, message: string) {
		const position = typeof node === "number" ? node : node.getStart(file.source);
		const { line } = file.source.getLineAndCharacterOfPosition(position);
		const key = `${kind}|${file.path}|${line}|${message}`;
		if (this.flagKeys.has(key)) return;
		this.flagKeys.add(key);
		const code = file.source.text.split(/\r?\n/)[line]?.trim();
		this.flags.push({ kind, file: file.path, line: line + 1, message, code: code && code.length > 140 ? `${code.slice(0, 137)}...` : code });
	}

	private flagPath(kind: FlagKind, path: string, message: string) {
		const key = `${kind}|${path}|0|${message}`;
		if (this.flagKeys.has(key)) return;
		this.flagKeys.add(key);
		this.flags.push({ kind, file: path, line: 0, message });
	}

	private lineIndent(file: FileState, position: number): string {
		const text = file.source.text;
		const start = text.lastIndexOf("\n", position - 1) + 1;
		return /^[ \t]*/.exec(text.slice(start))![0];
	}

	/** The local names a file imports from a Flamework module, by their name there. */
	private importedFrom(file: FileState, module: string): Map<string, string> {
		const map = new Map<string, string>();
		for (const entry of file.imports) if (entry.module === module) for (const named of entry.named) map.set(named.local, named.name);
		return map;
	}

	private walk(node: TS.Node, visit: (node: TS.Node) => void) {
		visit(node);
		this.ts.forEachChild(node, (child) => this.walk(child, visit));
	}

	/** The declaration an identifier or expression refers to, through import aliases. */
	private declarationOf(node: TS.Node): TS.Declaration | undefined {
		let symbol = this.checker.getSymbolAtLocation(node);
		if (symbol && symbol.flags & this.ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
		return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
	}

	private stateOf(node: TS.Node): FileState | undefined {
		return this.files.get(node.getSourceFile().fileName);
	}

	/** The class a node is a member of, when the node sits in a method (only arrow functions in between). */
	private enclosingMethod(node: TS.Node): TS.MethodDeclaration | TS.ConstructorDeclaration | undefined {
		let current = node.parent;
		while (current) {
			if (this.ts.isMethodDeclaration(current) || this.ts.isConstructorDeclaration(current)) return current;
			if (this.ts.isFunctionLike(current) && !this.ts.isArrowFunction(current)) return undefined;
			if (this.ts.isClassLike(current) || this.ts.isSourceFile(current)) return undefined;
			current = current.parent;
		}
		return undefined;
	}

	// Modules: @Service / @Controller extends Module ---------------------------------------------------------------

	private decoratorName(file: FileState, cls: TS.ClassLikeDeclaration): string | undefined {
		const core = this.importedFrom(file, CORE);
		for (const decorator of this.ts.getDecorators(cls) ?? []) {
			const expression = this.ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
			if (!this.ts.isIdentifier(expression)) continue;
			const name = core.get(expression.text);
			if (name === "Service" || name === "Controller") return name;
		}
		return undefined;
	}

	private rewriteModuleClasses() {
		for (const file of this.files.values()) {
			this.walk(file.source, (node) => {
				if (!this.ts.isClassDeclaration(node) && !this.ts.isClassExpression(node)) return;
				if (!this.decoratorName(file, node)) return;
				this.count("modules");
				this.makeModule(file, node, node);
				this.fixModuleMembers(file, node);
			});
		}
	}

	/** Gives `cls` (or the local base class it extends) `extends Module`; `origin` is the decorated class. */
	private makeModule(file: FileState, cls: TS.ClassLikeDeclaration, origin: TS.ClassLikeDeclaration, depth = 0): void {
		if (this.moduleClasses.has(cls)) return;
		const extendsClause = cls.heritageClauses?.find((clause) => clause.token === this.ts.SyntaxKind.ExtendsKeyword);
		if (!extendsClause) {
			const implementsClause = cls.heritageClauses?.find((clause) => clause.token === this.ts.SyntaxKind.ImplementsKeyword);
			const brace = cls.members.pos - 1;
			const at = implementsClause ? implementsClause.getStart(file.source) : brace;
			const before = file.source.text[at - 1];
			file.edits.insert(at, `${before === " " || before === "\t" ? "" : " "}extends ${file.moduleName} `);
			file.need.add(file.moduleName === "Module" ? "Module" : "Module as TypeTorchModule");
			this.moduleClasses.add(cls);
			this.ensureSuper(file, cls);
			if (cls !== origin) this.fixModuleMembers(file, cls);
			const name = cls.name?.text ?? "(class)";
			this.note(file, cls === origin ? `${name} extends Module` : `${name} extends Module (base of ${origin.name?.text})`);
			return;
		}
		const base = extendsClause.types[0]?.expression;
		if (!base) return;
		if (this.ts.isIdentifier(base) && base.text === file.moduleName) return;
		const declaration = this.declarationOf(base);
		if (declaration && (this.ts.isClassDeclaration(declaration) || this.ts.isClassExpression(declaration))) {
			const baseFile = this.stateOf(declaration);
			if (baseFile && depth < 8) {
				this.makeModule(baseFile, declaration, origin, depth + 1);
				return;
			}
			// A class from a package (BaseComponent, ...): nothing to do here.
			const from = declaration.getSourceFile().fileName;
			if (/[\\/]@typetorch[\\/]framework[\\/]/.test(from)) return;
		}
		this.flag(
			"flamework",
			this.stateOf(origin) ?? file,
			origin.name ?? origin,
			`${origin.name?.text ?? "class"} extends ${base.getText(file.source)}, which isn't a class of this project: make its base class extend Module`,
		);
	}

	/**
	 * A module's own `trove` / `ctx` member would shadow Module's (the framework sets both right after the constructor,
	 * replacing whatever a field initializer put there). A plain `trove = new Trove()` the class never cleans itself is
	 * removed: `this.trove` is then the module's trove, cleaned when the generation stops. Anything else is renamed
	 * (`ownTrove`, `ownCtx`) with its uses, and flagged.
	 */
	private fixModuleMembers(file: FileState, cls: TS.ClassLikeDeclaration) {
		const ts = this.ts;
		for (const reserved of ["trove", "ctx"]) {
			let declaration: TS.PropertyDeclaration | TS.ParameterDeclaration | TS.MethodDeclaration | undefined;
			for (const member of cls.members) {
				if ((ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member)) && member.name.getText(file.source) === reserved) declaration = member;
				if (ts.isConstructorDeclaration(member)) {
					for (const parameter of member.parameters) {
						if (ts.isParameterPropertyDeclaration(parameter, member) && parameter.name.getText(file.source) === reserved) declaration = parameter;
					}
				}
			}
			if (!declaration) continue;
			const uses: TS.PropertyAccessExpression[] = [];
			this.walk(cls, (node) => {
				if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === reserved) uses.push(node);
			});
			const cleansItself = uses.some((use) => ts.isPropertyAccessExpression(use.parent) && ["clean", "destroy", "Destroy"].includes(use.parent.name.text));
			const init = ts.isPropertyDeclaration(declaration) ? declaration.initializer : undefined;
			const plainTrove = reserved === "trove" && init !== undefined && ts.isNewExpression(init) && init.expression.getText(file.source) === "Trove" && (init.arguments?.length ?? 0) === 0;
			const className = cls.name?.text ?? "class";
			if (plainTrove && !cleansItself) {
				this.removeStatement(file, declaration);
				this.note(file, `${className}: its own \`trove = new Trove()\` removed; this.trove is the module's trove now (cleaned when the generation stops)`);
				continue;
			}
			const renamed = `own${reserved[0].toUpperCase()}${reserved.slice(1)}`;
			file.edits.replace(declaration.name.getStart(file.source), declaration.name.end, renamed);
			for (const use of uses) file.edits.replace(use.name.getStart(file.source), use.name.end, renamed);
			this.flag(
				"flamework",
				file,
				declaration,
				`${className}.${reserved} shadowed Module's ${reserved}: renamed to ${renamed}${reserved === "trove" ? "; add it to this.trove (this.trove.add(this.ownTrove)) so a swap cleans it" : ""}`,
			);
		}
	}

	private ensureSuper(file: FileState, cls: TS.ClassLikeDeclaration) {
		const ctor = cls.members.find((member): member is TS.ConstructorDeclaration => this.ts.isConstructorDeclaration(member) && member.body !== undefined);
		if (!ctor?.body) return;
		const hasSuper = ctor.body.statements.some(
			(statement) =>
				this.ts.isExpressionStatement(statement) &&
				this.ts.isCallExpression(statement.expression) &&
				statement.expression.expression.kind === this.ts.SyntaxKind.SuperKeyword,
		);
		if (hasSuper) return;
		const indent = this.lineIndent(file, ctor.getStart(file.source));
		const first = ctor.body.statements[0];
		if (first) {
			file.edits.insert(first.getStart(file.source), `super();\n${this.lineIndent(file, first.getStart(file.source))}`);
		} else {
			file.edits.replace(ctor.body.getStart(file.source), ctor.body.end, `{\n${indent}${file.indentUnit}super();\n${indent}}`);
		}
	}

	// JSDoc metadata ---------------------------------------------------------------------------------------------------

	private rewriteMetadataTags() {
		for (const file of this.files.values()) {
			const text = file.source.text;
			const pattern = /@metadata[^\n]*/g;
			for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
				const line = match[0];
				const keys = /flamework:(parameters|implements|decorators)/g;
				for (let key = keys.exec(line); key; key = keys.exec(line)) {
					const start = match.index + key.index;
					file.edits.replace(start, start + "flamework:".length, "typetorch:");
					this.note(file, `@metadata ${key[0]} -> typetorch:${key[1]}`);
				}
			}
			for (const match of text.matchAll(/["'`]flamework:(parameters|implements|decorators)["'`]/g)) {
				this.flag("flamework", file, match.index!, `metadata key ${match[0]}: TypeTorch's is "typetorch:${match[1]}"`);
			}
		}
	}

	// Networking ---------------------------------------------------------------------------------------------------------

	/** Networking.createEvent / createFunction calls (and the rest of the Networking namespace) in one file. */
	private networkingUses(file: FileState) {
		const networking = this.importedFrom(file, NETWORKING);
		const local = [...networking].find(([, name]) => name === "Networking")?.[0];
		const uses: { node: TS.Identifier; access?: TS.PropertyAccessExpression | TS.QualifiedName }[] = [];
		if (!local) return { local, uses };
		this.walk(file.source, (node) => {
			if (!this.ts.isIdentifier(node) || node.text !== local) return;
			const parent = node.parent;
			if (this.ts.isImportSpecifier(parent)) return;
			if (this.ts.isPropertyAccessExpression(parent) && parent.expression === node) uses.push({ node, access: parent });
			else if (this.ts.isQualifiedName(parent) && parent.left === node) uses.push({ node, access: parent });
			else uses.push({ node });
		});
		return { local, uses };
	}

	/** Leaf paths of a network interface (dotted), from its type. */
	private leafPaths(type: TS.Type, prefix = "", depth = 0, into = new Set<string>()): Set<string> {
		if (depth > 6) return into;
		for (const property of type.getProperties()) {
			const declaration = property.valueDeclaration ?? property.declarations?.[0];
			if (!declaration) continue;
			const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration);
			const path = prefix === "" ? property.name : `${prefix}.${property.name}`;
			if (propertyType.getCallSignatures().length > 0) into.add(path);
			else this.leafPaths(propertyType, path, depth + 1, into);
		}
		return into;
	}

	private collectNetDecls(): NetDecl[] {
		const decls: NetDecl[] = [];
		for (const file of this.files.values()) {
			const { local, uses } = this.networkingUses(file);
			if (!local) continue;
			for (const { access } of uses) {
				if (!access || !this.ts.isPropertyAccessExpression(access)) continue;
				const call = access.parent;
				const method = access.name.text;
				if ((method !== "createEvent" && method !== "createFunction") || !this.ts.isCallExpression(call) || call.expression !== access) continue;
				const declaration = call.parent;
				const statement = declaration?.parent?.parent;
				const types = call.typeArguments;
				if (!types || types.length !== 2) {
					this.flag("networking", file, call, `${local}.${method} without its two interfaces: add <ClientToServer, ServerToClient>`);
					continue;
				}
				if (!this.ts.isVariableDeclaration(declaration) || !statement || !this.ts.isVariableStatement(statement)) {
					this.flag("networking", file, call, `${local}.${method}(...) isn't a plain \`const X = ...\` declaration: rewrite it by hand`);
					continue;
				}
				const s2cType = this.checker.getTypeFromTypeNode(types[1]);
				decls.push({
					file,
					kind: method === "createEvent" ? "events" : "functions",
					statement,
					declaration,
					c2s: types[0].getText(file.source),
					s2c: types[1].getText(file.source),
					s2cHasLeaves: s2cType.getProperties().length > 0,
				});
			}
		}
		// An event and a function at the same path would be checked with one guard: the compat layer refuses that.
		const events = decls.filter((decl) => decl.kind === "events");
		const functions = decls.filter((decl) => decl.kind === "functions");
		for (const fn of functions) {
			const fnPaths = this.leafPaths(this.checker.getTypeFromTypeNode(this.typeArgument(fn, 0)));
			for (const ev of events) {
				const evPaths = this.leafPaths(this.checker.getTypeFromTypeNode(this.typeArgument(ev, 0)));
				for (const path of fnPaths) {
					if (evPaths.has(path)) {
						this.flag("networking", fn.file, fn.declaration, `"${path}" is both a client -> server event and a function: rename one (one path, one guard)`);
					}
				}
			}
		}
		for (const decl of decls) {
			if (decl.kind === "functions" && decl.s2cHasLeaves) {
				this.flag(
					"networking",
					decl.file,
					decl.declaration,
					`${decl.s2c} has server -> client requests: TypeTorch has none (a client can't be trusted to answer); use an event each way`,
				);
			}
		}
		return decls;
	}

	private typeArgument(decl: NetDecl, index: number): TS.TypeNode {
		const call = decl.declaration.initializer as TS.CallExpression;
		return call.typeArguments![index];
	}

	/** Flags createServer / createClient configs the compat layer ignores, and Networking uses that aren't rewritten. */
	private flagNetworkingLeftovers(file: FileState, rewritten: Set<TS.Node>) {
		const { local, uses } = this.networkingUses(file);
		if (!local) return;
		let left = 0;
		for (const { node, access } of uses) {
			if (rewritten.has(node)) continue;
			if (access && this.ts.isQualifiedName(access) && access.right.text === "Unreliable") {
				const reference = access.parent;
				if (this.ts.isTypeReferenceNode(reference) && reference.typeArguments?.length === 1) {
					file.edits.replace(reference.getStart(file.source), reference.end, reference.typeArguments[0].getText(file.source));
					this.note(file, `${local}.Unreliable<...> removed (sent reliably; native: fireUnreliable)`);
					continue;
				}
			}
			left++;
			const what = access ? access.getText(file.source) : local;
			this.flag("networking", file, node, `${what} has no TypeTorch equivalent`);
		}
		if (left === 0) file.dropLocals.add(local);
	}

	private flagConfigs() {
		for (const file of this.files.values()) {
			this.walk(file.source, (node) => {
				if (!this.ts.isCallExpression(node) || !this.ts.isPropertyAccessExpression(node.expression)) return;
				const method = node.expression.name.text;
				if (method !== "createServer" && method !== "createClient") return;
				const config = node.arguments[0];
				if (!config || !this.ts.isObjectLiteralExpression(config)) return;
				for (const property of config.properties) {
					const name = property.name && this.ts.isIdentifier(property.name) ? property.name.text : "";
					if (name === "middleware" || name === "disableIncomingGuards") {
						this.flag("networking", file, property, `${method}({ ${name} }) isn't supported: guards always run; tune leaves with setNetworkLimits`);
					}
				}
			});
		}
	}

	private rewriteNetworkingCompat() {
		const decls = this.collectNetDecls();
		const rewritten = new Set<TS.Node>();
		for (const decl of decls) {
			const call = decl.declaration.initializer as TS.CallExpression;
			const file = decl.file;
			const text =
				decl.kind === "events"
					? `createFlameworkCompat<${decl.c2s}, ${decl.s2c}>().GlobalEvents`
					: `createFlameworkCompat<{}, {}, ${decl.c2s}, ${decl.s2c}>().GlobalFunctions`;
			file.edits.replace(call.getStart(file.source), call.end, text);
			file.need.add("createFlameworkCompat");
			rewritten.add((call.expression as TS.PropertyAccessExpression).expression);
			this.count("networks");
			this.note(file, `${decl.declaration.name.getText(file.source)}: Networking.${decl.kind === "events" ? "createEvent" : "createFunction"} -> createFlameworkCompat`);
			if (call.arguments.length > 0) this.note(file, `${decl.declaration.name.getText(file.source)}: the name argument is dropped (not needed)`);
		}
		for (const file of this.files.values()) this.flagNetworkingLeftovers(file, rewritten);
		this.flagConfigs();
	}

	// Native networking ----------------------------------------------------------------------------------------------------

	private rewriteNetworkingNative() {
		const decls = this.collectNetDecls();
		const rewritten = new Set<TS.Node>();
		const byFile = new Map<FileState, NetDecl[]>();
		for (const decl of decls) byFile.set(decl.file, [...(byFile.get(decl.file) ?? []), decl]);
		const native = new Set<NetDecl>();
		const netVar = new Map<FileState, string>();
		for (const [file, list] of byFile) {
			const events = list.filter((decl) => decl.kind === "events");
			const functions = list.filter((decl) => decl.kind === "functions");
			if (events.length > 1 || functions.length > 1) {
				for (const decl of list) this.flag("networking", file, decl.declaration, "several networks in one file: --net native merges one createEvent and one createFunction per file; rewrite by hand or use --net compat");
				continue;
			}
			for (const decl of list) native.add(decl);
			const name = this.freeName(file, "network");
			netVar.set(file, name);
			const c2s = [events[0]?.c2s, functions[0]?.c2s].filter((x): x is string => x !== undefined);
			// Server -> client requests have no native form (flagged by collectNetDecls): their interface stays out.
			const s2c = [events[0]?.s2c].filter((x): x is string => x !== undefined);
			const typeText = (parts: string[]) => (parts.length === 0 ? "{}" : parts.join(" & "));
			const first = [...list].sort((a, b) => a.statement.pos - b.statement.pos)[0];
			const exported = first.statement.modifiers?.some((modifier) => modifier.kind === this.ts.SyntaxKind.ExportKeyword) ?? false;
			file.edits.replace(
				first.statement.getStart(file.source),
				first.statement.end,
				`${exported ? "export " : ""}const ${name} = createNetwork<${typeText(c2s)}, ${typeText(s2c)}>();`,
			);
			for (const decl of list) {
				if (decl !== first) this.removeStatement(file, decl.statement);
				rewritten.add((((decl.declaration.initializer as TS.CallExpression).expression) as TS.PropertyAccessExpression).expression);
			}
			file.need.add("createNetwork");
			this.count("networks");
			this.note(file, `${list.map((decl) => decl.declaration.name.getText(file.source)).join(" + ")} -> ${exported ? "export " : ""}const ${name} = createNetwork<...>()`);
		}

		// The handlers: `const ServerEvents = GlobalEvents.createServer({})` (any file).
		const handlers = new Map<TS.Declaration, HandlerDecl>();
		for (const file of this.files.values()) {
			this.walk(file.source, (node) => {
				if (!this.ts.isVariableDeclaration(node) || !node.initializer || !this.ts.isCallExpression(node.initializer)) return;
				const callee = node.initializer.expression;
				if (!this.ts.isPropertyAccessExpression(callee)) return;
				const side = callee.name.text === "createServer" ? "server" : callee.name.text === "createClient" ? "client" : undefined;
				if (!side) return;
				const target = this.declarationOf(callee.expression);
				const net = decls.find((decl) => decl.declaration === target);
				if (!net) return;
				const statement = node.parent.parent;
				if (!native.has(net) || !this.ts.isVariableStatement(statement) || !this.ts.isVariableDeclarationList(node.parent) || node.parent.declarations.length !== 1) {
					this.flag("networking", file, node, `${node.name.getText(file.source)}: left as is (its network wasn't rewritten)`);
					return;
				}
				handlers.set(node, { file, declaration: node, statement, side, kind: net.kind, net });
				this.removeStatement(file, statement);
			});
		}
		// Each handler's call sites.
		const users = new Map<FileState, Set<HandlerDecl>>();
		for (const file of this.files.values()) {
			this.walk(file.source, (node) => {
				if (!this.ts.isIdentifier(node)) return;
				const parent = node.parent;
				if (this.ts.isImportSpecifier(parent) || this.ts.isExportSpecifier(parent) || this.ts.isVariableDeclaration(parent)) return;
				const target = this.declarationOf(node);
				const handler = target && handlers.get(target);
				if (!handler) {
					// A Global (createEvent / createFunction result) used for something else than createServer/createClient.
					const net = target && decls.find((decl) => decl.declaration === target && native.has(decl));
					if (net && !(this.ts.isPropertyAccessExpression(parent) && ["createServer", "createClient"].includes(parent.name.text))) {
						this.flag("networking", file, node, `${node.text} (a Flamework network object) is used directly: rewrite by hand`);
					}
					return;
				}
				this.rewriteCallSite(file, node, handler, netVar.get(handler.net.file)!);
				users.set(file, (users.get(file) ?? new Set()).add(handler));
			});
		}
		// Imports: handler names -> the network, in the files that use them; every import of a handler goes (some files
		// import one without using it), and so does an import of a rewritten Global the file doesn't otherwise use.
		const nativeGlobals = new Set<TS.Declaration>([...native].map((decl) => decl.declaration));
		for (const file of this.files.values()) {
			if (file.deleted) continue;
			const used = users.get(file);
			const networkFiles = new Set([...(used ?? [])].map((handler) => handler.net.file));
			for (const networkFile of networkFiles) {
				const name = netVar.get(networkFile)!;
				if (networkFile === file) continue;
				this.addNamedImport(file, this.moduleSpecifier(file, networkFile), name);
			}
			for (const statement of file.source.statements) {
				if (!this.ts.isImportDeclaration(statement)) continue;
				const bindings = statement.importClause?.namedBindings;
				if (!bindings || !this.ts.isNamedImports(bindings)) continue;
				const remove = bindings.elements.filter((element) => {
					const target = this.declarationOf(element.name);
					if (target === undefined) return false;
					if (handlers.has(target)) return true;
					return nativeGlobals.has(target) && !this.usesLocal(file, element.name.text, statement);
				});
				if (remove.length > 0) this.removeImportElements(file, statement, remove);
			}
		}
		// Files left with nothing but imports (the Flamework template's server/network.ts): deleted.
		for (const handler of handlers.values()) {
			const file = handler.file;
			if (file.deleted || netVar.has(file)) continue;
			const rest = file.source.statements.filter(
				(statement) => !this.ts.isImportDeclaration(statement) && ![...handlers.values()].some((h) => h.statement === statement),
			);
			if (rest.length === 0) {
				file.deleted = true;
				this.note(file, "deleted (it only created Flamework handlers)");
			}
		}
		for (const file of this.files.values()) this.flagNetworkingLeftovers(file, rewritten);
		this.flagConfigs();
	}

	private freeName(file: FileState, wanted: string): string {
		const taken = (name: string) => file.source.statements.some((statement) => statement.getText(file.source).match(new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`)));
		let name = wanted;
		for (let n = 2; taken(name); n++) name = `${wanted}${n}`;
		return name;
	}

	/** Removes a statement or member, with the comments right above it and its line when it has one to itself. */
	private removeStatement(file: FileState, node: TS.Node) {
		const text = file.source.text;
		let start = node.getStart(file.source);
		const comments = this.ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
		for (let index = comments.length - 1; index >= 0; index--) {
			if (/\n[ \t]*\r?\n/.test(text.slice(comments[index].end, start))) break;
			start = comments[index].pos;
		}
		const lineStart = text.lastIndexOf("\n", start - 1) + 1;
		if (/^[ \t]*$/.test(text.slice(lineStart, start))) start = lineStart;
		let end = node.end;
		while (text[end] === " " || text[end] === "\t") end++;
		if (text[end] === "\r") end++;
		if (text[end] === "\n") end++;
		// The first member of a block: a blank line after it would now open the block.
		if (/\{[ \t]*\r?\n$/.test(text.slice(Math.max(0, start - 4), start))) {
			const blank = /^[ \t]*\r?\n/.exec(text.slice(end));
			if (blank) end += blank[0].length;
		}
		if (file.edits.overlaps(start, end)) return;
		file.edits.replace(start, end, "");
	}

	private moduleSpecifier(from: FileState, to: FileState): string {
		let path = slash(relative(dirname(from.source.fileName), to.source.fileName)).replace(/\.tsx?$/, "").replace(/\/index$/, "");
		if (!path.startsWith(".")) path = `./${path}`;
		return path;
	}

	private extraImports = new Map<FileState, Map<string, Set<string>>>();
	private addNamedImport(file: FileState, module: string, name: string) {
		const modules = this.extraImports.get(file) ?? new Map<string, Set<string>>();
		modules.set(module, (modules.get(module) ?? new Set()).add(name));
		this.extraImports.set(file, modules);
	}

	private removeImportElements(file: FileState, statement: TS.ImportDeclaration, remove: TS.ImportSpecifier[]) {
		const bindings = statement.importClause!.namedBindings as TS.NamedImports;
		const keep = bindings.elements.filter((element) => !remove.includes(element));
		if (keep.length === 0 && !statement.importClause!.name) {
			this.removeStatement(file, statement);
			return;
		}
		const quote = file.quote;
		const text = `{ ${keep.map((element) => element.getText(file.source)).join(", ")} }`;
		if (keep.length === 0) {
			file.edits.replace(statement.getStart(file.source), statement.end, `import ${statement.importClause!.name!.text} from ${quote}${(statement.moduleSpecifier as TS.StringLiteral).text}${quote};`);
		} else {
			file.edits.replace(bindings.getStart(file.source), bindings.end, text);
		}
	}

	/** One reference to a Flamework handler (`ServerEvents.a.b.fire(...)`), rewritten to the native network. */
	private rewriteCallSite(file: FileState, id: TS.Identifier, handler: HandlerDecl, networkName: string) {
		const ts = this.ts;
		const path: string[] = [];
		let access: TS.Expression = id;
		while (ts.isPropertyAccessExpression(access.parent) && access.parent.expression === access) {
			path.push(access.parent.name.text);
			access = access.parent;
		}
		const call = ts.isCallExpression(access.parent) && access.parent.expression === access ? access.parent : undefined;
		const METHODS = ["connect", "fire", "broadcast", "except", "predict", "setCallback", "invoke", "invokeWithTimeout"];
		const method = call && path.length > 1 && METHODS.includes(path[path.length - 1]) ? path[path.length - 1] : call ? "call" : "value";
		const methodName = method === "call" || method === "value" ? undefined : (access as TS.PropertyAccessExpression).name;
		const leaf = (method === "call" || method === "value" ? path : path.slice(0, -1)).join(".");
		file.edits.replace(id.getStart(file.source), id.end, `${networkName}.${handler.side}`);
		this.count("callSites");
		const rename = (to: string) => {
			if (method === "call") file.edits.insert(access.end, `.${to}`);
			else if (methodName) file.edits.replace(methodName.getStart(file.source), methodName.end, to);
		};
		const where = `${handler.side === "server" ? "Server" : "Client"}${handler.kind === "events" ? "Events" : "Functions"}.${leaf}`;
		const inTrove = (what: string) => {
			const statement = call!.parent;
			if (!ts.isExpressionStatement(statement)) {
				this.flag("connection", file, call!, `${where}: ${what} returns a function now (call it to disconnect, or this.trove.add it)`);
				return;
			}
			const owner = this.enclosingMethod(call!);
			const cls = owner?.parent;
			if (owner && !ts.isConstructorDeclaration(owner) && cls && ts.isClassLike(cls) && (this.moduleClasses.has(cls) || this.decoratorName(file, cls))) {
				file.edits.insert(call!.getStart(file.source), "this.trove.add(");
				file.edits.insert(call!.end, ")");
			} else {
				this.flag("connection", file, call!, `${where}: ${what} outside a module method: put the function it returns in a trove`);
			}
		};
		const firstArgKind = (): "player" | "list" | "unknown" => {
			const arg = call?.arguments[0];
			if (!arg) return "unknown";
			if (ts.isArrayLiteralExpression(arg)) return "list";
			const type = this.checker.getTypeAtLocation(arg);
			if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
				// Flamework's types are gone once it is uninstalled, so a listener's parameters are `any`: the first
				// parameter of a server connect / setCallback callback is the sending Player.
				const declaration = ts.isIdentifier(arg) ? this.declarationOf(arg) : undefined;
				if (declaration && ts.isParameter(declaration) && declaration.parent.parameters[0] === declaration) {
					const listener = declaration.parent;
					const registration = listener.parent;
					if (
						ts.isCallExpression(registration) &&
						registration.arguments[0] === listener &&
						ts.isPropertyAccessExpression(registration.expression) &&
						["connect", "setCallback", "on", "handle"].includes(registration.expression.name.text)
					) {
						return "player";
					}
				}
				return "unknown";
			}
			const parts = type.isUnion() ? type.types : [type];
			const lists = parts.filter((part) => this.checker.isArrayType(part) || this.checker.isTupleType(part)).length;
			if (lists === parts.length) return "list";
			if (lists === 0) return "player";
			return "unknown";
		};
		if (handler.kind === "events" && handler.side === "server") {
			if (method === "call" || method === "fire") {
				const kind = firstArgKind();
				if (kind === "list") rename("fireList");
				else {
					if (method === "call") rename("fire");
					if (kind === "unknown") this.flag("networking", file, call!, `${where}: fire(player | players): use fire(player) or fireList(players)`);
				}
			} else if (method === "broadcast") rename("fireAll");
			else if (method === "except") {
				if (firstArgKind() === "player") rename("fireExcept");
				else this.flag("networking", file, call!, `${where}: except(players) has no native form for a list: loop with fire`);
			} else if (method === "connect") {
				rename("on");
				inTrove("connect");
			} else if (method === "predict") rename("emit");
			else this.flag("networking", file, id, `${where}: used as a value; check the native API (network.server)`);
		} else if (handler.kind === "events") {
			if (method === "call") rename("fire");
			else if (method === "connect") {
				rename("on");
				inTrove("connect");
			} else if (method === "predict") rename("emit");
			else if (method !== "fire") this.flag("networking", file, id, `${where}: used as a value; check the native API (network.client)`);
		} else if (handler.side === "server") {
			if (method === "setCallback") {
				rename("handle");
				inTrove("setCallback");
			} else if (method === "predict") this.flag("networking", file, call!, `${where}: predict on a request has no native form: call the handler's method directly`);
			else this.flag("networking", file, id, `${where}: used as a value; check the native API (network.server)`);
		} else {
			if (method === "call") rename("invoke");
			else if (method !== "invoke" && method !== "invokeWithTimeout") this.flag("networking", file, id, `${where}: used as a value; check the native API (network.client)`);
		}
	}

	// Ignite files -> boot.ts ------------------------------------------------------------------------------------------

	private migrateIgniteFiles() {
		const ts = this.ts;
		for (const file of [...this.files.values()]) {
			const match = /\.(server|client)\.tsx?$/.exec(file.path);
			if (!match) continue;
			const realm = match[1] as "server" | "client";
			const flamework = [...this.importedFrom(file, CORE)].find(([, name]) => name === "Flamework")?.[0];
			if (!flamework) continue;
			const isFlameworkCall = (statement: TS.Statement, name?: string) =>
				ts.isExpressionStatement(statement) &&
				ts.isCallExpression(statement.expression) &&
				ts.isPropertyAccessExpression(statement.expression.expression) &&
				ts.isIdentifier(statement.expression.expression.expression) &&
				statement.expression.expression.expression.text === flamework &&
				(name === undefined || statement.expression.expression.name.text === name);
			if (!file.source.statements.some((statement) => isFlameworkCall(statement, "ignite"))) continue;

			// The realm's root folder: the first folder under rootDir on the way to this file (src/server).
			const fromRoot = slash(relative(this.rootDir, file.source.fileName)).split("/");
			const realmDir = fromRoot.length > 1 ? join(this.rootDir, fromRoot[0]) : this.rootDir;
			const bootPath = join(realmDir, "boot.ts");
			const bootRel = slash(relative(this.projectDir, bootPath));
			if (existsSync(bootPath) || this.created.has(bootRel)) {
				this.flag("moved", file, 0, `${bootRel} already exists: merge ${file.path} into it by hand`);
				continue;
			}
			// Module folders from Flamework.addPaths("src/server/services", ...).
			const folders: string[] = [];
			for (const statement of file.source.statements) {
				if (!isFlameworkCall(statement, "addPaths")) continue;
				for (const arg of ((statement as TS.ExpressionStatement).expression as TS.CallExpression).arguments) {
					if (!ts.isStringLiteralLike(arg)) {
						this.flag("moved", file, arg, `Flamework.addPaths(${arg.getText(file.source)}): only string paths are converted; add the folder to boot.ts by hand`);
						continue;
					}
					const absolute = resolve(this.projectDir, arg.text.replace(/\/\*\*?.*$/, ""));
					const inRealm = slash(relative(realmDir, absolute));
					if (inRealm === "" || inRealm.startsWith("..") || isAbsolute(inRealm)) {
						this.flag("moved", file, arg, `Flamework.addPaths("${arg.text}") is outside ${slash(relative(this.projectDir, realmDir))}: add that folder to boot.ts by hand`);
						continue;
					}
					folders.push(inRealm);
				}
			}
			const expression = (folder: string) =>
				`script.Parent!${folder
					.split("/")
					.map((part) => `.FindFirstChild(${JSON.stringify(part)})!`)
					.join("")}`;
			const Start = realm === "server" ? "startServer" : "startClient";
			const Kernel = realm === "server" ? "ServerKernel" : "ClientKernel";
			const buildFile = join(this.rootDir, "shared", "build.ts");
			let buildImport = slash(relative(realmDir, buildFile)).replace(/\.ts$/, "");
			if (!buildImport.startsWith(".")) buildImport = `./${buildImport}`;
			const indent = file.indentUnit;
			const boot = [
				`import { ${Start}, type ${Kernel} } from "${FRAMEWORK}";`,
				`import { BUILD } from "${buildImport}";`,
				"",
				`/** Called by the kernel for every ${realm} generation (was ${basename(file.path)}). Returns the soft-stop function. */`,
				`export function boot(kernel: ${Kernel}) {`,
				`${indent}return ${Start}(kernel, { modules: [${folders.map(expression).join(", ")}], build: BUILD });`,
				"}",
				"",
			].join("\n");
			this.created.set(bootRel, boot);
			this.count("bootFiles");
			this.note(bootRel, `created from ${file.path} (modules: ${folders.length > 0 ? folders.join(", ") : "none"})`);
			if (folders.length === 0) this.flag("moved", file, 0, `no Flamework.addPaths folder: list the module folders in ${bootRel}`);
			if (!existsSync(buildFile)) {
				this.flagPath("toolchain", slash(relative(this.projectDir, buildFile)), "boot.ts imports BUILD from it: it is generated before every compile (copy scripts/build-info.ts from the template; `typetorch build` writes it too)");
			}

			// Everything else at the top level moves into a generated module.
			const rest = file.source.statements.filter(
				(statement) => !ts.isImportDeclaration(statement) && !isFlameworkCall(statement, "ignite") && !isFlameworkCall(statement, "addPaths"),
			);
			file.deleted = true;
			this.note(file, `deleted (now ${bootRel})`);
			if (rest.length === 0) continue;
			if (folders.length === 0) {
				this.flag("moved", file, rest[0], `${rest.length} top-level statements were not moved (no module folder): move them into a module by hand`);
				continue;
			}
			this.moveTopLevelCode(file, realm, join(realmDir, folders[0]), rest, flamework);
		}
	}

	private moveTopLevelCode(file: FileState, realm: "server" | "client", folder: string, statements: TS.Statement[], flamework: string) {
		const ts = this.ts;
		const stem = basename(file.path).replace(/\.(server|client)\.tsx?$/, "");
		const pascal = stem
			.split(/[^A-Za-z0-9]+/)
			.filter(Boolean)
			.map((part) => part[0].toUpperCase() + part.slice(1))
			.join("");
		const kind = realm === "server" ? "Service" : "Controller";
		const className = `${/^[A-Za-z]/.test(pascal) ? pascal : `Boot${pascal}`}${kind}`;
		let target = join(folder, `${stem}.${kind.toLowerCase()}.ts`);
		if (existsSync(target) || this.created.has(slash(relative(this.projectDir, target)))) target = join(folder, `${stem}-boot.${kind.toLowerCase()}.ts`);
		const targetRel = slash(relative(this.projectDir, target));
		const indent = file.indentUnit;
		const imports: string[] = [];
		for (const statement of file.source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const module = statement.moduleSpecifier.text;
			if (module === CORE) {
				// Flamework's own import: only what isn't Flamework (rare), through the framework import below.
				continue;
			}
			let specifier = module;
			if (module.startsWith(".")) {
				specifier = slash(relative(dirname(target), resolve(dirname(file.source.fileName), module)));
				if (!specifier.startsWith(".")) specifier = `./${specifier}`;
			}
			const text = statement.getText(file.source);
			imports.push(text.replace(statement.moduleSpecifier.getText(file.source), `${file.quote}${specifier}${file.quote}`));
		}
		const coreNames = [...this.importedFrom(file, CORE)].filter(([local, name]) => local !== flamework && CORE_NAMES.has(name)).map(([, name]) => name);
		const frameworkNames = [...new Set([...coreNames, "Module", kind, coreNames.includes("OnStart") ? "OnStart" : "type OnStart"])];
		const body: string[] = [];
		for (const statement of statements) {
			let text = statement.getText(file.source);
			if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
				text = text.replace(/^export\s+(default\s+)?/, "");
				this.flag("moved", file, statement, "an export moved into onStart: nothing can import it any more");
			}
			// Leading comments travel with their statement.
			const comments = file.source.text.slice(statement.getFullStart(), statement.getStart(file.source)).trim();
			for (const line of `${comments ? `${comments}\n` : ""}${text}`.split(/\r?\n/)) {
				body.push(line.trim() === "" ? "" : `${indent}${indent}${line}`);
			}
		}
		const source = [
			...imports,
			`import { ${frameworkNames.join(", ")} } from "${FRAMEWORK}";`,
			"",
			"/**",
			` * The top-level code of ${file.path}, moved here by \`typetorch migrate --from flamework\`: it now runs in onStart,`,
			" * once per generation. Review it: connections and threads go in this.trove, `script` is this module now.",
			" */",
			`@${kind}()`,
			`export class ${className} extends Module implements OnStart {`,
			`${indent}onStart() {`,
			...body,
			`${indent}}`,
			"}",
			"",
		].join("\n");
		this.created.set(targetRel, source);
		this.count("movedStatements", statements.length);
		this.note(targetRel, `created: ${statements.length} top-level statements of ${file.path}, run in onStart`);
		this.flag("moved", file, statements[0], `${statements.length} top-level statements moved into ${targetRel} (onStart of ${className}): review them`);
		for (const statement of statements) {
			this.walk(statement, (node) => {
				if (ts.isIdentifier(node) && node.text === "script" && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
					this.flag("moved", file, node, "`script` was the ignite Script; in the generated module it is that ModuleScript");
				}
			});
		}
	}

	// Imports --------------------------------------------------------------------------------------------------------------

	private usesLocal(file: FileState, local: string, except: TS.Node): boolean {
		let used = false;
		this.walk(file.source, (node) => {
			if (used || !this.ts.isIdentifier(node) || node.text !== local) return;
			if (node.parent === except || this.ts.isImportSpecifier(node.parent) || this.ts.isImportClause(node.parent)) return;
			used = true;
		});
		return used;
	}

	private rewriteImports() {
		for (const file of this.files.values()) {
			if (file.deleted) continue;
			const values: string[] = [];
			const types: string[] = [];
			const add = (name: string, typeOnly: boolean) => {
				if (typeOnly) {
					if (!values.includes(name) && !types.includes(name)) types.push(name);
				} else {
					if (!values.includes(name)) values.push(name);
					const index = types.indexOf(name);
					if (index !== -1) types.splice(index, 1);
				}
			};
			let anchor: TS.ImportDeclaration | undefined;
			const remove: TS.ImportDeclaration[] = [];
			const leftovers: string[] = [];
			for (const entry of file.imports) {
				anchor ??= entry.decl;
				const kept: ImportedName[] = [];
				for (const named of entry.named) {
					const alias = named.local !== named.name ? `${named.name} as ${named.local}` : named.name;
					if (entry.module === CORE && CORE_NAMES.has(named.name)) {
						add(alias, named.typeOnly);
						continue;
					}
					if (file.dropLocals.has(named.local)) continue;
					if (!this.usesLocal(file, named.local, entry.decl)) {
						this.note(file, `dropped the unused import ${named.name} from ${entry.module}`);
						continue;
					}
					kept.push(named);
					if (entry.module === CORE) {
						const hint =
							named.name === "Flamework"
								? "Flamework.* (id, createGuard, implements, ...) has no TypeTorch equivalent"
								: named.name === "Optional"
									? "@Optional() doesn't exist: every TypeTorch module starts; remove it"
									: `${named.name} has no TypeTorch equivalent`;
						this.flag("flamework", file, entry.decl, hint);
					} else if (entry.module === COMPONENTS) {
						this.flag("components", file, entry.decl, `${named.name} from @flamework/components`);
					} else {
						this.flag("networking", file, entry.decl, `${named.name} from @flamework/networking has no TypeTorch equivalent`);
					}
				}
				if (entry.other) {
					this.flag("flamework", file, entry.decl, `import ${entry.other} from "${entry.module}": rewrite by hand`);
					continue;
				}
				remove.push(entry.decl);
				if (kept.length > 0) {
					const names = kept.map((named) => `${named.typeOnly ? "type " : ""}${named.name === named.local ? named.name : `${named.name} as ${named.local}`}`);
					leftovers.push(`import { ${names.join(", ")} } from ${file.quote}${entry.module}${file.quote};`);
				}
			}
			for (const name of file.need) add(name, false);
			const extra = this.extraImports.get(file);
			if (values.length === 0 && types.length === 0 && remove.length === 0 && !extra) continue;
			// Merge into an existing @typetorch/framework import.
			const existing = file.source.statements.find(
				(statement): statement is TS.ImportDeclaration =>
					this.ts.isImportDeclaration(statement) &&
					this.ts.isStringLiteral(statement.moduleSpecifier) &&
					statement.moduleSpecifier.text === FRAMEWORK &&
					!!statement.importClause?.namedBindings &&
					this.ts.isNamedImports(statement.importClause.namedBindings) &&
					!statement.importClause.isTypeOnly,
			);
			if (existing) {
				for (const element of (existing.importClause!.namedBindings as TS.NamedImports).elements) {
					const alias = element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text;
					add(alias, element.isTypeOnly);
				}
			}
			const specifiers = [...values, ...types.map((name) => `type ${name}`)];
			const frameworkImport = specifiers.length > 0 ? `import { ${specifiers.join(", ")} } from ${file.quote}${FRAMEWORK}${file.quote};` : "";
			const lines = [frameworkImport, ...leftovers].filter((line) => line !== "");
			if (extra) {
				for (const [module, names] of extra) lines.push(`import { ${[...names].join(", ")} } from ${file.quote}${module}${file.quote};`);
			}
			if (existing) {
				file.edits.replace(existing.getStart(file.source), existing.end, lines.join("\n"));
				for (const decl of remove) this.removeStatement(file, decl);
			} else if (anchor) {
				file.edits.replace(anchor.getStart(file.source), anchor.end, lines.join("\n"));
				for (const decl of remove) if (decl !== anchor) this.removeStatement(file, decl);
			} else {
				const firstImport = file.source.statements.find((statement) => this.ts.isImportDeclaration(statement));
				const at = firstImport ? firstImport.getStart(file.source) : 0;
				// Above the other imports; a file without imports gets a blank line before its code.
				file.edits.insert(at, `${lines.join("\n")}\n${firstImport ? "" : "\n"}`);
			}
			if (remove.length > 0) this.count("importFiles");
		}
	}

	// Flags ----------------------------------------------------------------------------------------------------------------

	private scanFlags() {
		const ts = this.ts;
		for (const file of this.files.values()) {
			if (file.deleted) continue;
			const services = this.servicesImport(file);
			const dependency = new Set(
				[...this.importedFrom(file, CORE)].filter(([, name]) => name === "Dependency").map(([local]) => local),
			);
			const observers = new Set<string>();
			for (const statement of file.source.statements) {
				if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
				const module = statement.moduleSpecifier.text;
				if (module === "@rbxts/observers" && statement.importClause?.name) observers.add(statement.importClause.name.text);
				if (module === FRAMEWORK) {
					const bindings = statement.importClause?.namedBindings;
					if (bindings && ts.isNamedImports(bindings)) {
						for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "Dependency") dependency.add(element.name.text);
					}
				}
				if (/^@rbxts\/(profileservice|profile-store|profilestore|datastore2|lapis|suphi-datastore)/i.test(module)) {
					this.flag("data", file, statement, `${module}`);
				}
			}
			// Module-level state.
			for (const statement of file.source.statements) {
				if (!ts.isVariableStatement(statement)) continue;
				const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
				for (const declaration of statement.declarationList.declarations) {
					const name = declaration.name.getText(file.source);
					const init = declaration.initializer;
					if (!isConst) {
						this.flag("module-state", file, declaration, `top-level let ${name}`);
						continue;
					}
					if (!init) continue;
					const container =
						(ts.isNewExpression(init) && ts.isIdentifier(init.expression) && /^(Map|Set|WeakMap|WeakSet|Array)$/.test(init.expression.text)) ||
						(ts.isArrayLiteralExpression(init) && init.elements.length === 0) ||
						(ts.isObjectLiteralExpression(init) && init.properties.length === 0);
					if (container) this.flag("module-state", file, declaration, `top-level ${name} = ${init.getText(file.source).slice(0, 40)}`);
				}
			}
			this.walk(file.source, (node) => {
				if (ts.isIdentifier(node) && node.text === "_G") this.flag("global", file, node, "_G");
				if ((ts.isWhileStatement(node) && node.expression.kind === ts.SyntaxKind.TrueKeyword) || (ts.isForStatement(node) && !node.condition)) {
					const owner = this.nearestFunction(node);
					const isOnStart = owner && ts.isMethodDeclaration(owner) && owner.name.getText(file.source) === "onStart";
					if (!isOnStart) this.flag("loop", file, node, owner ? "an endless loop outside onStart" : "an endless loop at the top level");
				}
				if (ts.isCallExpression(node)) this.flagCall(file, node, services, dependency, observers);
				if (ts.isNewExpression(node)) this.flagNew(file, node);
			});
		}
	}

	private servicesImport(file: FileState): Map<string, string> {
		const map = new Map<string, string>();
		for (const statement of file.source.statements) {
			if (!this.ts.isImportDeclaration(statement) || !this.ts.isStringLiteral(statement.moduleSpecifier)) continue;
			if (statement.moduleSpecifier.text !== "@rbxts/services") continue;
			const bindings = statement.importClause?.namedBindings;
			if (bindings && this.ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) map.set(element.name.text, (element.propertyName ?? element.name).text);
			}
		}
		return map;
	}

	private nearestFunction(node: TS.Node): TS.SignatureDeclaration | undefined {
		let current = node.parent;
		while (current && !this.ts.isSourceFile(current)) {
			if (this.ts.isFunctionLike(current)) return current;
			current = current.parent;
		}
		return undefined;
	}

	private flagCall(file: FileState, call: TS.CallExpression, services: Map<string, string>, dependency: Set<string>, observers: Set<string>) {
		const ts = this.ts;
		const callee = call.expression;
		const discarded = ts.isExpressionStatement(call.parent);
		const text = (node: TS.Node) => node.getText(file.source);
		const service = (expression: TS.Expression, name: string) =>
			(ts.isIdentifier(expression) && services.get(expression.text) === name) ||
			(ts.isCallExpression(expression) && /GetService\(\s*["']/.test(text(expression)) && text(expression).includes(`"${name}"`));
		if (ts.isIdentifier(callee)) {
			if (callee.text === "loadstring") this.flag("loadstring", file, call, "loadstring(...)");
			if ((callee.text === "spawn" || callee.text === "delay" || callee.text === "wait") && !this.isLocal(callee)) {
				this.flag("task", file, call, `${callee.text}() is deprecated and outside a trove: task.${callee.text === "wait" ? "wait" : callee.text}`);
			}
			if (dependency.has(callee.text)) this.flagDependency(file, call);
			return;
		}
		if (!ts.isPropertyAccessExpression(callee)) return;
		const method = callee.name.text;
		const object = callee.expression;
		if (ts.isIdentifier(object) && object.text === "task" && (method === "spawn" || method === "delay" || method === "defer") && discarded) {
			this.flag("task", file, call, `task.${method}(...) result not in a trove`);
		}
		if (method === "Connect" || method === "ConnectParallel") {
			const signal = text(object);
			if (ts.isPropertyAccessExpression(object) && object.name.text === "PlayerAdded" && service(object.expression, "Players")) {
				this.flag("player-added", file, call, `${signal}.Connect`);
			} else if (discarded) {
				this.flag("connection", file, call, `${signal.length > 60 ? `${signal.slice(0, 57)}...` : signal}.${method}(...) result not in a trove`);
			}
		}
		if (ts.isIdentifier(object) && observers.has(object.text) && method.startsWith("observe") && discarded) {
			this.flag("connection", file, call, `${object.text}.${method}(...): its stop function isn't kept`);
		}
		if (method === "BindToClose") this.flag("bind-to-close", file, call, `${text(object)}.BindToClose`);
		if (["SubscribeAsync", "PublishAsync"].includes(method) && service(object, "MessagingService")) {
			this.flag("messaging", file, call, `MessagingService.${method}`);
		}
		if (["GetDataStore", "GetOrderedDataStore", "GetGlobalDataStore"].includes(method) && service(object, "DataStoreService")) {
			this.flag("data", file, call, `DataStoreService.${method}`);
		}
		if (["FireServer", "FireClient", "FireAllClients", "InvokeServer", "InvokeClient"].includes(method)) {
			this.flag("remotes", file, call, `${text(object).slice(0, 60)}.${method}`);
		}
		if (["OnServerEvent", "OnClientEvent"].includes(ts.isPropertyAccessExpression(object) ? object.name.text : "")) {
			this.flag("remotes", file, call, `${text(object).slice(0, 60)}.${method}`);
		}
	}

	/** `new Instance("RemoteEvent")` and friends. */
	private flagNew(file: FileState, node: TS.NewExpression) {
		const ts = this.ts;
		if (!ts.isIdentifier(node.expression) || node.expression.text !== "Instance") return;
		const className = node.arguments?.[0];
		if (className && ts.isStringLiteralLike(className) && /^(RemoteEvent|RemoteFunction|UnreliableRemoteEvent)$/.test(className.text)) {
			this.flag("remotes", file, node, `new Instance("${className.text}")`);
		}
	}

	private isLocal(id: TS.Identifier): boolean {
		const declaration = this.declarationOf(id);
		return declaration !== undefined && this.files.has(declaration.getSourceFile().fileName);
	}

	private flagDependency(file: FileState, call: TS.CallExpression) {
		const ts = this.ts;
		let current: TS.Node = call;
		while (current.parent && !ts.isSourceFile(current.parent)) {
			const parent = current.parent;
			if (ts.isPropertyDeclaration(parent) && parent.initializer === current) {
				this.flag("dependency", file, call, `${call.getText(file.source)} in a field initializer`);
				return;
			}
			if (ts.isConstructorDeclaration(parent)) {
				this.flag("dependency", file, call, `${call.getText(file.source)} in a constructor`);
				return;
			}
			if (ts.isFunctionLike(parent)) return;
			current = parent;
		}
		this.flag("dependency", file, call, `${call.getText(file.source)} at the top level of a module`);
	}

	// Toolchain ------------------------------------------------------------------------------------------------------------

	private checkToolchain() {
		const read = (name: string) => {
			try {
				return readFileSync(join(this.projectDir, name), "utf8");
			} catch {
				return undefined;
			}
		};
		const tsconfig = read("tsconfig.json") ?? "";
		if (/node_modules\/@flamework/.test(tsconfig)) this.flagPath("toolchain", "tsconfig.json", "typeRoots: node_modules/@flamework -> node_modules/@typetorch");
		if (/rbxts-transformer-flamework/.test(tsconfig)) this.flagPath("toolchain", "tsconfig.json", "plugins: replace rbxts-transformer-flamework with rbxts-transform-debug, then @typetorch/transformer");
		else if (!/@typetorch\/transformer/.test(tsconfig)) this.flagPath("toolchain", "tsconfig.json", "plugins: add { \"transform\": \"@typetorch/transformer\" } (guards and DI ids)");
		const pkg = read("package.json") ?? "";
		for (const name of ["@flamework/core", "@flamework/networking", "@flamework/components", "rbxts-transformer-flamework"]) {
			if (pkg.includes(`"${name}"`)) this.flagPath("toolchain", "package.json", `remove ${name}`);
		}
		if (!pkg.includes('"@typetorch/framework"')) this.flagPath("toolchain", "package.json", "add @typetorch/framework (and @typetorch/transformer, @typetorch/cli as dev dependencies)");
		for (const name of ["flamework.build", "flamework.json", "include/flamework"]) {
			if (existsSync(join(this.projectDir, name))) this.flagPath("toolchain", name, "delete it");
		}
		// Scripts left in the source tree: a payload holds only ModuleScripts (typetorch build refuses the rest).
		const scripts: string[] = [];
		const walkDir = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === "node_modules") continue;
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walkDir(path);
				else if (/\.(server|client)\.(tsx?|luau?)$/.test(entry.name)) scripts.push(slash(relative(this.projectDir, path)));
			}
		};
		if (existsSync(this.rootDir)) walkDir(this.rootDir);
		const deleted = new Set([...this.files.values()].filter((file) => file.deleted).map((file) => file.path));
		for (const script of scripts) {
			if (deleted.has(script)) continue;
			this.flagPath("toolchain", script, "a Script/LocalScript: the payload holds only ModuleScripts. Move its code into a module, or keep it in the place (outside default.project.json)");
		}
		const project = read("default.project.json") ?? "";
		if (/@flamework/.test(project)) this.flagPath("toolchain", "default.project.json", "the payload project maps @rbxts and @typetorch/framework only (copy the template's)");
	}

	// Result ---------------------------------------------------------------------------------------------------------------

	private result(): MigrateResult {
		const changes: FileChange[] = [];
		for (const file of this.files.values()) {
			if (file.deleted) {
				changes.push({ path: file.path, before: file.source.text });
				continue;
			}
			if (file.edits.edits.length === 0) continue;
			const after = file.edits.apply();
			if (after !== file.source.text) changes.push({ path: file.path, before: file.source.text, after });
		}
		for (const [path, text] of this.created) changes.push({ path, after: text });
		changes.sort((a, b) => a.path.localeCompare(b.path));
		this.stats.filesChanged = changes.length;
		this.stats.flags = this.flags.length;
		return { changes, flags: this.flags, notes: this.notes, stats: this.stats, typescriptVersion: this.ts.version };
	}
}

/** The Markdown report. */
export function migrationReport(result: MigrateResult, options: { net: NetMode; dryRun: boolean; project: string }): string {
	const lines: string[] = [];
	const count = (kind: FlagKind) => result.flags.filter((flag) => flag.kind === kind).length;
	lines.push("# TypeTorch migration report (from Flamework)", "");
	lines.push(
		`\`typetorch migrate --from flamework --net ${options.net}${options.dryRun ? " --dry-run" : ""}\` on ${options.project} (TypeScript ${result.typescriptVersion}).`,
		"",
	);
	lines.push("## Summary", "");
	lines.push(`- Files changed: ${result.changes.filter((c) => c.before !== undefined && c.after !== undefined).length}, created: ${result.changes.filter((c) => c.before === undefined).length}, deleted: ${result.changes.filter((c) => c.after === undefined).length}`);
	lines.push(`- Modules (@Service / @Controller): ${result.stats.modules ?? 0}; networks rewritten: ${result.stats.networks ?? 0}${options.net === "native" ? `; call sites: ${result.stats.callSites ?? 0}` : " (call sites unchanged: createFlameworkCompat)"}`);
	lines.push(`- Flagged for review: ${result.flags.length}`, "");
	const kinds = (Object.keys(FLAG_KINDS) as FlagKind[]).filter((kind) => count(kind) > 0);
	if (kinds.length > 0) {
		lines.push("| What | Count |", "|---|---|");
		for (const kind of kinds) lines.push(`| [${FLAG_KINDS[kind].title}](#${anchor(FLAG_KINDS[kind].title)}) | ${count(kind)} |`);
		lines.push("");
	}
	lines.push("## Next steps", "");
	lines.push("1. `bun run build`: what still fails is in the flagged list below.");
	lines.push("2. Go through the flagged items (each links the migrate guide's rule).");
	if (options.net === "compat") {
		lines.push("3. Networking runs through `createFlameworkCompat`; move to `createNetwork` over time (`--net native`, guides/from-flamework.md).");
	}
	lines.push("");
	for (const kind of kinds) {
		lines.push(`## ${FLAG_KINDS[kind].title}`, "", FLAG_KINDS[kind].hint, "");
		for (const flag of result.flags.filter((f) => f.kind === kind)) {
			const where = flag.line > 0 ? `${flag.file}:${flag.line}` : flag.file;
			lines.push(`- \`${where}\`: ${flag.message}${flag.code ? `  \n  \`${flag.code.replace(/`/g, "'")}\`` : ""}`);
		}
		lines.push("");
	}
	lines.push("## Rewritten", "");
	for (const note of result.notes) lines.push(`- ${note}`);
	lines.push("");
	return lines.join("\n");
}

function anchor(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, "")
		.trim()
		.replace(/ /g, "-");
}
