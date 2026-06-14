import type { LearningEvent } from "./LearningEvent.js";
import type { ReflectionSink } from "./ReflectionSink.js";

export class NoopReflectionSink implements ReflectionSink {
  public readonly id = "core.noop.reflection";

  public async record(_event: LearningEvent): Promise<void> {}
}
