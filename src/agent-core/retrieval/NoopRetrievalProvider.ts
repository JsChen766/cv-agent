import type { RetrievalProvider } from "./RetrievalProvider.js";
import type { RetrievalQuery } from "./RetrievalQuery.js";
import type { RetrievalResult } from "./RetrievalResult.js";
import type { RetrievalScope } from "./RetrievalScope.js";

export class NoopRetrievalProvider implements RetrievalProvider {
  public readonly id = "core.noop.retrieval";

  public supports(_scope: RetrievalScope): boolean {
    return false;
  }

  public async retrieve(_query: RetrievalQuery): Promise<RetrievalResult[]> {
    return [];
  }
}
