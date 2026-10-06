export class Logger {
	constructor(private readonly prefix: string) {}
	log(...args: unknown[]) {
		print(this.prefix, ...args);
	}
}
declare function print(...args: unknown[]): void;
