import { Modding, Service } from "@flamework/core";

/** @metadata flamework:parameters injectable */
export const Logged = Modding.createDecorator("Method", () => {});

@Service({})
export class PriceService {
	constructor() {}

	of(item: string) {
		return item.size();
	}
}
