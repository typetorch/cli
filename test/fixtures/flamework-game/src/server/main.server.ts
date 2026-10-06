import { Flamework } from "@flamework/core";
import { Logger } from "../shared/logger";

const logger = new Logger("main");
Flamework.addPaths("src/server/services");
Flamework.ignite();
logger.log("ignited from", script.Name);
