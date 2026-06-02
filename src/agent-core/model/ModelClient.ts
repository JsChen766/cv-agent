import { AgentError } from "../runtime/AgentError.js";
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMMessage,
  LLMProvider,
  LLMStreamChunk,
  ModelClientChatRequest,
  ModelClientConfig,
} from "./types.js";

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_MESSAGES = 30;

export class ModelClient {
  private provider: LLMProvider;
  private readonly defaultModel: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxMessages: number;

  public constructor(config: ModelClientConfig) {
    this.provider = config.provider;
    this.defaultModel = config.defaultModel;
    this.maxRetries = config.maxRetries ?? DEFAULT_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  public async chat(request: ModelClientChatRequest): Promise<LLMChatResponse> {
    const chatRequest = this.prepareRequest(request);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.withTimeout(this.provider.chat(chatRequest), this.timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries) throw this.wrapError(error);
        await sleep(Math.min(2 ** attempt * 250, 4_000));
      }
    }

    throw this.wrapError(lastError);
  }

  public async *stream(request: ModelClientChatRequest): AsyncIterable<LLMStreamChunk> {
    if (!this.provider.stream) {
      throw new AgentError("MODEL_FAILED", `Provider "${this.provider.name}" does not support streaming.`);
    }
    const chatRequest = this.prepareRequest({ ...request, stream: true });
    for await (const chunk of this.provider.stream(chatRequest)) {
      yield chunk;
    }
  }

  private prepareRequest(request: ModelClientChatRequest): LLMChatRequest {
    return {
      ...request,
      model: request.model ?? this.defaultModel,
      messages: trimMessages(request.messages, this.maxMessages),
      stream: request.stream ?? false,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new AgentError("MODEL_FAILED", `Model request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private wrapError(error: unknown): AgentError {
    if (error instanceof AgentError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new AgentError("MODEL_FAILED", `Model provider request failed: ${message}`, { cause: error });
  }
}

function trimMessages(messages: LLMMessage[], maxMessages: number): LLMMessage[] {
  if (messages.length <= maxMessages) return messages;
  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  return [...systemMessages, ...nonSystemMessages.slice(-(maxMessages - systemMessages.length))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
