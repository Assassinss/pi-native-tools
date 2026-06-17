import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./extensions/read.ts";
import { registerEditTool } from "./extensions/edit.ts";
import { registerWriteTool } from "./extensions/write.ts";

export default function (pi: ExtensionAPI) {
  registerReadTool(pi);
  registerEditTool(pi);
  registerWriteTool(pi);
}
