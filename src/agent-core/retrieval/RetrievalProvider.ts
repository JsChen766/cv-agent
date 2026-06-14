import type { RetrievalQuery } from "./RetrievalQuery.js";
import type { RetrievalResult } from "./RetrievalResult.js";
import type { RetrievalScope } from "./RetrievalScope.js";

export interface RetrievalProvider {
  readonly id: string;
  supports(scope: RetrievalScope): boolean;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
