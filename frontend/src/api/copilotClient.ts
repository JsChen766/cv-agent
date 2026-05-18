import type {
  AgentModesResponse,
  ApiResponse,
  CopilotActionInput,
  CopilotChatInput,
  CopilotChatResponse,
  CopilotSessionDetail,
  CopilotSessionSummary,
  CopilotSidebarResponse,
} from "../types/copilot";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const DEMO_USER_ID = import.meta.env.VITE_DEMO_USER_ID ?? "demo-user";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-user-id": DEMO_USER_ID,
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.json() as ApiResponse<T>;
  if (!response.ok || !body.ok) {
    const message = body.ok ? `Request failed: ${response.status}` : body.error?.message ?? "Request failed.";
    throw new Error(message);
  }
  return body.data;
}

export function getAgentModes(): Promise<AgentModesResponse> {
  return request<AgentModesResponse>("/debug/agent-modes", { method: "GET" });
}

export function sendCopilotChat(input: CopilotChatInput): Promise<CopilotChatResponse> {
  return request<CopilotChatResponse>("/copilot/chat", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function sendCopilotAction(input: CopilotActionInput): Promise<CopilotChatResponse> {
  return request<CopilotChatResponse>("/copilot/actions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getCopilotSessions(limit = 30): Promise<CopilotSessionSummary[]> {
  return request<CopilotSessionSummary[]>(`/copilot/sessions?limit=${limit}`, { method: "GET" });
}

export function getCopilotSession(id: string): Promise<CopilotSessionDetail> {
  return request<CopilotSessionDetail>(`/copilot/sessions/${id}`, { method: "GET" });
}

export function getCopilotSidebar(): Promise<CopilotSidebarResponse> {
  return request<CopilotSidebarResponse>("/copilot/sidebar", { method: "GET" });
}

export async function streamCopilotChat(
  input: CopilotChatInput,
  handlers: {
    onEvent?: (event: string, data: unknown) => void;
    onError?: (error: Error) => void;
    onDone?: () => void;
  },
): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/copilot/chat/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": DEMO_USER_ID,
      },
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Stream failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6);
        if (event && dataLine) {
          handlers.onEvent?.(event, JSON.parse(dataLine));
        }
      }
    }
    handlers.onDone?.();
  } catch (error) {
    handlers.onError?.(error instanceof Error ? error : new Error("Stream failed."));
  }
}
