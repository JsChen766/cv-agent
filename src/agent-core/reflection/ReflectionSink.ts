import type { LearningEvent } from "./LearningEvent.js";

export interface ReflectionSink {
  readonly id: string;
  record(event: LearningEvent): Promise<void>;
}
