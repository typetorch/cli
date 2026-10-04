import { describe } from "../shared/describe";

export function boot() {
	print(`[fixture] server ${describe()}`);
	return () => print("[fixture] server stopped");
}
