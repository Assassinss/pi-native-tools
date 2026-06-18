import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashTool } from "./extensions/bash.ts";
import { registerReadTool } from "./extensions/read.ts";
import { registerEditTool } from "./extensions/edit.ts";
import { registerWriteTool } from "./extensions/write.ts";
import { registerFindTool } from "./extensions/find.ts";
import { registerGrepTool } from "./extensions/grep.ts";

export default function (pi: ExtensionAPI) {
	registerBashTool(pi);
	registerReadTool(pi);
	registerEditTool(pi);
	registerWriteTool(pi);
	registerFindTool(pi);
	registerGrepTool(pi);
}
