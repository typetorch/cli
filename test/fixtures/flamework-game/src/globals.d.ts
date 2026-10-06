// Stand-ins for the Roblox types the fixture uses (the codemod needs only Player vs Player[]).
declare class Player {
	Name: string;
	UserId: number;
}
declare class Instance {
	static new(className: string): Instance;
}
declare const _G: Record<string, unknown>;
declare function loadstring(source: string): () => void;
declare const task: {
	spawn(fn: () => void): void;
	delay(seconds: number, fn: () => void): void;
	defer(fn: () => void): void;
	wait(seconds?: number): number;
};
