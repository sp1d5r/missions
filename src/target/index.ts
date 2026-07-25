import { genericTarget } from "./generic.js";
import { nadineTarget } from "./nadine.js";
import type { Target } from "./types.js";

export type { Target, BehavioralResult } from "./types.js";

export function getTarget(name: "generic" | "nadine"): Target {
	return name === "nadine" ? nadineTarget : genericTarget;
}
