import { randomUUID } from "node:crypto";
import type { AgentName } from "../validation/AgentOutputSchemas.js";
import type { AgentMessage, AgentMessageParticipant } from "./AgentMessage.js";

export class AgentMessageBus {
  private readonly messages: AgentMessage[] = [];

  public constructor(
    private readonly runId: string,
    private readonly turnId: string,
  ) {}

  public add(message: Omit<AgentMessage, "id" | "runId" | "turnId" | "createdAt"> & Partial<Pick<AgentMessage, "id" | "runId" | "turnId" | "createdAt">>): AgentMessage {
    const item: AgentMessage = {
      id: message.id ?? `amsg-${randomUUID()}`,
      runId: message.runId ?? this.runId,
      turnId: message.turnId ?? this.turnId,
      from: message.from,
      to: message.to,
      type: message.type,
      content: message.content,
      payload: message.payload,
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    this.messages.push(item);
    return item;
  }

  public list(): AgentMessage[] {
    return [...this.messages];
  }

  public listFor(agentName: AgentName): AgentMessage[] {
    return this.messages.filter((message) =>
      message.to === agentName ||
      message.from === agentName ||
      (message.from === "orchestrator" && message.to === agentName)
    );
  }

  public requestReview(fromAgent: AgentName, toAgent: AgentName, payload: unknown): AgentMessage {
    return this.add({
      from: fromAgent,
      to: toAgent,
      type: "review_request",
      content: "Please review the recent generated or modified output for evidence and safety risks.",
      payload,
    });
  }

  public requestRevision(fromAgent: AgentMessageParticipant, toAgent: AgentName, payload: unknown): AgentMessage {
    return this.add({
      from: fromAgent,
      to: toAgent,
      type: "revision_request",
      content: "Please revise the previous output using the critic feedback.",
      payload,
    });
  }
}
