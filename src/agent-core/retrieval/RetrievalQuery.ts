import type { RetrievalScope } from "./RetrievalScope.js";

export type RetrievalQuery = {
  userId: string;
  sessionId?: string;
  turnId?: string;
  query: string;
  scopes: RetrievalScope[];
  limit?: number;
  constraints?: Record<string, unknown>;
};
