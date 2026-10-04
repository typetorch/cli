import { describe } from "../shared/describe";

export function boot() {
	print(`[fixture] client ${describe()}`);
	return () => print("[fixture] client stopped");
}
