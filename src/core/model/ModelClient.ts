import { AgentRuntimeError } from "../errors/AgentRuntimeError.js";
import type { LLMProvider } from "./LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse, LLMMessage, LLMStreamChunk, ModelClientChatRequest, ModelClientConfig } from "./types.js";

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_MESSAGES = 30;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

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

  public setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  public getProviderName(): string {
    return this.provider.name;
  }

  public async chat(request: ModelClientChatRequest): Promise<LLMChatResponse> {
    const chatRequest = this.prepareRequest(request);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.withTimeout(this.provider.chat(chatRequest), this.timeoutMs);
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryable(error);
        if (!retryable || attempt >= this.maxRetries) {
          throw this.wrapError(error);
        }
        await this.sleep(this.backoffMs(attempt));
      }
    }

    throw this.wrapError(lastError);
  }

  public async *stream(request: ModelClientChatRequest): AsyncIterable<LLMStreamChunk> {
    if (!this.provider.stream) {
      throw new AgentRuntimeError(`Provider "${this.provider.name}" does not support streaming.`, {
        code: "STREAM_NOT_SUPPORTED"
      });
    }

    try {
      const chatRequest = this.prepareRequest({ ...request, stream: true });
      for await (const chunk of this.provider.stream(chatRequest)) {
        yield chunk;
      }
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  private prepareRequest(request: ModelClientChatRequest): LLMChatRequest {
    return {
      ...request,
      model: request.model ?? this.defaultModel,
      messages: this.trimMessages(request.messages),
      stream: request.stream ?? false
    };
  }

  private trimMessages(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length <= this.maxMessages) {
      return messages;
    }

    const systemMessages = messages.filter((message) => message.role === "system");
    const nonSystemMessages = messages.filter((message) => message.role !== "system");
    const keepCount = Math.max(0, this.maxMessages - systemMessages.length);
    return [...systemMessages, ...nonSystemMessages.slice(-keepCount)];
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new AgentRuntimeError(`Model request timed out after ${timeoutMs}ms.`, {
          code: "MODEL_TIMEOUT",
          retryable: true
        }));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof AgentRuntimeError) {
      if (error.retryable) {
        return true;
      }
      return error.statusCode === undefined ? false : RETRYABLE_STATUS_CODES.has(error.statusCode);
    }
    return true;
  }

  private wrapError(error: unknown): AgentRuntimeError {
    if (error instanceof AgentRuntimeError) {
      return error;
    }
    return new AgentRuntimeError(`Model provider "${this.provider.name}" failed: ${error instanceof Error ? error.message : String(error)}`, {
      code: "MODEL_PROVIDER_ERROR",
      cause: error,
      retryable: this.isRetryable(error)
    });
  }

  private backoffMs(attempt: number): number {
    return Math.min(2 ** attempt * 250, 4_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
