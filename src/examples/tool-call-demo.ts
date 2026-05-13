import { ToolExecutor } from "../core/tool/ToolExecutor.js";
import type { ToolCall } from "../core/tool/types.js";
import { echoTool } from "../tools/echoTool.js";
import { getCurrentTimeTool } from "../tools/getCurrentTimeTool.js";

const executor = new ToolExecutor();
executor.register(echoTool);
executor.register(getCurrentTimeTool);

const echoCall: ToolCall = {
  id: "demo-call-1",
  type: "function",
  function: {
    name: "echo",
    arguments: JSON.stringify({ message: "hello from tool calling" })
  }
};

const timeCall: ToolCall = {
  id: "demo-call-2",
  type: "function",
  function: {
    name: "getCurrentTime",
    arguments: "{}"
  }
};

console.log(JSON.stringify(await executor.executeToolCall(echoCall), null, 2));
console.log(JSON.stringify(await executor.executeToolCall(timeCall), null, 2));
