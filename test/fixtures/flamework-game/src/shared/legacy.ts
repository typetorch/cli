import { Players, MessagingService, DataStoreService } from "@rbxts/services";

let joined = 0;
const cooldowns = new Map<Player, number>();
const LIMIT = 5;

Players.PlayerAdded.Connect(() => {
	joined += 1;
});
_G.joined = joined;
loadstring("print(1)")();
task.delay(5, () => print(LIMIT));
while (true) {
	task.wait(1);
}
game.BindToClose(() => {});
MessagingService.SubscribeAsync("topic", () => {});
DataStoreService.GetDataStore("data");
const remote = new Instance("RemoteEvent");
export { cooldowns, remote };
declare const game: { BindToClose(fn: () => void): void };
declare function print(...args: unknown[]): void;
