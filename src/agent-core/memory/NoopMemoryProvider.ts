import type { MemoryProvider, MemoryRetrieveInput } from "./MemoryProvider.js";
import type { MemoryRecord } from "./MemoryRecord.js";

export class NoopMemoryProvider implements MemoryProvider {
  public readonly id = "core.noop.memory";

  public async retrieve(_input: MemoryRetrieveInput): Promise<MemoryRecord[]> {
    return [];
  }

  public async remember(_record: MemoryRecord): Promise<void> {}
}
