import { AgentToolRunner } from "../core/agent/AgentToolRunner.js";
import { BaseAgent } from "../core/agent/BaseAgent.js";
import { TokenBudgetManager } from "../core/conversation/TokenBudgetManager.js";
import { ModelClient } from "../core/model/ModelClient.js";
import type { LLMProvider } from "../core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../core/model/types.js";
import { ToolExecutor } from "../core/tool/ToolExecutor.js";
import type { ToolCall } from "../core/tool/types.js";
import { echoTool } from "../tools/echoTool.js";
import { getCurrentTimeTool } from "../tools/getCurrentTimeTool.js";

class FakeToolCallingProvider implements LLMProvider {
  public readonly name = "fake-tool-calling";
  private calls = 0;

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls += 1;

    if (this.calls === 1) {
      return {
        content: "",
        reasoning: request.thinking ? "I should call the available tools before answering." : undefined,
        toolCalls: [
          this.toolCall("call-echo", "echo", { message: "hello from AgentToolRunner" }),
          this.toolCall("call-time", "getCurrentTime", {})
        ],
        raw: { provider: this.name, request }
      };
    }

    const toolMessages = request.messages.filter((message) => message.role === "tool");

    return {
      content: `Final answer after ${toolMessages.length} tool result(s).`,
      raw: { provider: this.name, request }
    };
  }

  private toolCall(id: string, name: string, args: unknown): ToolCall {
    return {
      id,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    };
  }
}

class TestAgent extends BaseAgent {
  public constructor(modelClient: ModelClient) {
    super({
      name: "tool-runner-demo-agent",
      role: "Demonstrate automatic tool calling.",
      systemPrompt: "Use tools when useful, then answer clearly.",
      modelClient,
      tools: [echoTool, getCurrentTimeTool]
    });
  }
}

const provider = new FakeToolCallingProvider();
const modelClient = new ModelClient({
  provider,
  defaultModel: "fake-tool-model",
  maxRetries: 0
});

const agent = new TestAgent(modelClient);
const toolExecutor = new ToolExecutor();
toolExecutor.register(echoTool);
toolExecutor.register(getCurrentTimeTool);

const runner = new AgentToolRunner({
  agent,
  toolExecutor
});

const output = await runner.run({
  content: "Use tools if needed, then answer.",
  toolChoice: "auto",
  thinking: true
});

const finalUserMessages = output.finalMessages.filter((message) => message.role === "user");
const hasDuplicateUserMessages = new Set(finalUserMessages.map((message) => message.content)).size !== finalUserMessages.length;
const hasPersistedContinuePrompt = output.finalMessages.some((message) => (
  message.content.includes("Continue using the tool results above")
));

console.log("Final content:");
console.log(output.content);
console.log("\nConversation session id:");
console.log(output.conversationSession.id);
console.log("\nFinal messages count:");
console.log(output.finalMessages.length);
console.log("\nFinal user message contents:");
console.log(JSON.stringify(finalUserMessages.map((message) => message.content), null, 2));
console.log("\nHas duplicate user messages:");
console.log(hasDuplicateUserMessages);
console.log("\nHas persisted continue prompt:");
console.log(hasPersistedContinuePrompt);
console.log("\nSession snapshot:");
console.log(JSON.stringify(output.conversationSession.snapshot(), null, 2));
console.log("\nSteps:");
console.log(JSON.stringify(output.steps, null, 2));
console.log("\nFinal messages:");
console.log(JSON.stringify(output.finalMessages, null, 2));
console.log("\nApprox token estimate:");
console.log(new TokenBudgetManager().estimateMessagesTokens(output.conversationSession.getMessages()));
