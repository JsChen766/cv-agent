import { ContextAssembler } from "../core/conversation/ContextAssembler.js";
import { ConversationSession } from "../core/conversation/ConversationSession.js";
import { TokenBudgetManager } from "../core/conversation/TokenBudgetManager.js";

const session = new ConversationSession({
  id: "conversation-runtime-demo",
  messages: [
    { role: "system", content: "You are a concise resume assistant." },
    { role: "user", content: "Draft a bullet for frontend performance work." },
    { role: "assistant", content: "I should inspect relevant experience evidence first." },
    {
      role: "tool",
      toolCallId: "call-read-experience",
      content: JSON.stringify({
        ok: true,
        toolName: "futureTextReader",
        result: {
          text: "Long extracted text: " + "frontend performance, accessibility, API integration. ".repeat(20)
        }
      })
    }
  ]
});

const originalMessageCount = session.getMessages().length;
const assembler = new ContextAssembler();
const assembled = assembler.assemble({
  session,
  injections: [
    {
      id: "fake-retrieval-context",
      content: "Relevant experience evidence: reduced initial load time by 38% through route-level code splitting.",
      priority: 10,
      metadata: { source: "demo" }
    }
  ],
  trimOptions: {
    maxApproxTokens: 80,
    preserveRecentMessages: 2
  }
});

const tokenBudgetManager = new TokenBudgetManager();
const trimResult = tokenBudgetManager.trimMessages(session.getMessages(), {
  maxApproxTokens: 80,
  preserveRecentMessages: 2
});

console.log("Conversation runtime demo:");
console.log(JSON.stringify({
  originalMessageCount,
  assembledMessageCount: assembled.messages.length,
  removedMessageIds: assembled.removedMessageIds,
  injectedMessageIds: assembled.injectedMessageIds,
  approxTokens: assembled.approxTokens,
  directTrimRemovedMessageIds: trimResult.removedMessages.map((message) => message.id),
  snapshot: session.snapshot()
}, null, 2));
