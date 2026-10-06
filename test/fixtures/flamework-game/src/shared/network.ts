import { Networking, NetworkingFunctionError } from "@flamework/networking";

interface ClientToServerEvents {
	shop: {
		buy(item: string): void;
	};
	ping(): void;
	aim: Networking.Unreliable<(x: number) => void>;
}

interface ServerToClientEvents {
	shop: {
		bought(item: string): void;
	};
	notify(message: string): void;
}

interface ClientToServerFunctions {
	shop: {
		price(item: string): number;
	};
}

interface ServerToClientFunctions {}

export const GlobalEvents = Networking.createEvent<ClientToServerEvents, ServerToClientEvents>();
export const GlobalFunctions = Networking.createFunction<ClientToServerFunctions, ServerToClientFunctions>();

export function isTimeout(value: unknown) {
	return value === NetworkingFunctionError.Timeout;
}
