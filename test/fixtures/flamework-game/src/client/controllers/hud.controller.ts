import { Controller, Dependency, OnStart, Optional } from "@flamework/core";
import { Events, Functions } from "client/network";
import { ShopController } from "./shop.controller";

@Controller()
export class HudController implements OnStart {
	private readonly shop = Dependency<ShopController>();

	onStart() {
		Events.shop.bought.connect((item) => print(item));
		Events.notify.predict("local");
		Events.shop.buy.fire("sword");
		Events.ping();
		Functions.shop.price.invoke("sword").then((price) => print(price));
		Functions.shop.price("shield");
		Functions.shop.price.invokeWithTimeout(5, "bow");
	}
}
declare function print(...args: unknown[]): void;
