import type { LearningEvent } from "./LearningEvent.js";
import type { ReflectionSink } from "./ReflectionSink.js";

export type LearningEventRecordResult = {
  eventId: string;
  delivered: string[];
  failed: Array<{
    sinkId: string;
    reason: string;
  }>;
};

export class LearningEventRecorder {
  public constructor(private readonly sinks: readonly ReflectionSink[] = []) {}

  public async record(event: LearningEvent): Promise<LearningEventRecordResult> {
    const settled = await Promise.allSettled(this.sinks.map((sink) => sink.record(event)));
    const delivered: string[] = [];
    const failed: LearningEventRecordResult["failed"] = [];
    settled.forEach((result, index) => {
      const sinkId = this.sinks[index]?.id ?? `sink-${index}`;
      if (result.status === "fulfilled") {
        delivered.push(sinkId);
      } else {
        failed.push({ sinkId, reason: errorReason(result.reason) });
      }
    });
    return { eventId: event.id, delivered, failed };
  }
}

function errorReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
