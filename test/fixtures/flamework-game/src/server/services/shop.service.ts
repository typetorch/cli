import { OnStart, Service } from "@flamework/core";
import { Trove } from "@rbxts/trove";
import { Events, Functions } from "server/network";
import { BaseService } from "./base";
import { PriceService } from "./price.service";

@Service()
export class ShopService extends BaseService implements OnStart {
	private readonly trove = new Trove();

	constructor(private readonly prices: PriceService) {
		super();
	}

	onStart() {
		Events.shop.buy.connect((player, item) => {
			Events.shop.bought.fire(player, item);
			Events.shop.bought.fire([player], item);
			Events.notify.except(player, `${player.Name} bought ${item}`);
		});
		Functions.shop.price.setCallback((_, item) => this.prices.of(item));
		const connection = Events.ping.connect(() => {});
		connection.Disconnect();
		Events.notify.broadcast("open");
		Events.notify(new Player(), "hi");
	}
}
