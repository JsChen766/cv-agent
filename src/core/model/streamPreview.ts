import type { ModelClient } from "./ModelClient.js";
import type { ModelClientChatRequest } from "./types.js";

/**
 * Experimental/future helper for safe model stream previews.
 * Structured agent workflows should still use chat() plus JSON parse,
 * schema validation, repair, post-validation, and fallback.
 * Do not expose raw reasoning by default.
 */
export type StreamPreviewDelta = {
  contentDelta?: string;
  reasoningDelta?: string;
};

export type CollectStreamPreviewInput = {
  modelClient: ModelClient;
  request: ModelClientChatRequest;
  onDelta?: (delta: StreamPreviewDelta) => Promise<void> | void;
  maxPreviewChars?: number;
  includeReasoning?: boolean;
};

export type StreamPreviewResult = {
  content: string;
  reasoningPreview?: string;
  truncated: boolean;
};

const DEFAULT_MAX_PREVIEW_CHARS = 2_000;

export async function collectStreamPreview(input: CollectStreamPreviewInput): Promise<StreamPreviewResult> {
  const maxPreviewChars = input.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS;
  let content = "";
  let reasoningPreview = "";
  let truncated = false;

  for await (const chunk of input.modelClient.stream(input.request)) {
    await input.onDelta?.({
      ...(chunk.contentDelta ? { contentDelta: chunk.contentDelta } : {}),
      ...(input.includeReasoning && chunk.reasoningDelta ? { reasoningDelta: chunk.reasoningDelta } : {}),
    });

    const contentResult = appendPreview(content, chunk.contentDelta, maxPreviewChars);
    content = contentResult.value;
    truncated = truncated || contentResult.truncated;

    if (input.includeReasoning) {
      const reasoningResult = appendPreview(reasoningPreview, chunk.reasoningDelta, maxPreviewChars);
      reasoningPreview = reasoningResult.value;
      truncated = truncated || reasoningResult.truncated;
    }
  }

  return {
    content,
    ...(input.includeReasoning ? { reasoningPreview } : {}),
    truncated,
  };
}

function appendPreview(current: string, delta: string | undefined, maxChars: number): {
  value: string;
  truncated: boolean;
} {
  if (!delta || current.length >= maxChars) {
    return {
      value: current,
      truncated: Boolean(delta),
    };
  }
  const remaining = maxChars - current.length;
  if (delta.length > remaining) {
    return {
      value: `${current}${delta.slice(0, remaining)}`,
      truncated: true,
    };
  }
  return {
    value: `${current}${delta}`,
    truncated: false,
  };
}
