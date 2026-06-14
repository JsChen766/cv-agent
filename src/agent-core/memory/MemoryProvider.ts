import type { MemoryRecord } from "./MemoryRecord.js";

export type MemoryRetrieveInput = {
  userId: string;
  query: string;
  limit?: number;
};

export interface MemoryProvider {
  readonly id: string;
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRecord[]>;
  remember?(record: MemoryRecord): Promise<void>;
}
