import type { ContextInjection } from "./ContextAssembler.js";

export type ContextProviderInput = {
  userId?: string;
  sessionId?: string;
  task?: string;
  metadata?: Record<string, unknown>;
};

export interface ContextProvider {
  getContext(input: ContextProviderInput): Promise<ContextInjection[]>;
}

export class NoopContextProvider implements ContextProvider {
  public async getContext(): Promise<ContextInjection[]> {
    return [];
  }
}
