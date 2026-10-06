import { Controller } from "@flamework/core";
import { Component, BaseComponent } from "@flamework/components";

@Controller()
export class ShopController {}

@Component({ tag: "Door" })
export class Door extends BaseComponent {}
