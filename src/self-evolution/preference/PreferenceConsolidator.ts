import { createHash, randomUUID } from "node:crypto";
import type { PreferenceRepository } from "./PreferenceRepository.js";
import type { PreferenceSignal, UserPreference } from "./types.js";

export class PreferenceConsolidator {
  public constructor(private readonly repository: PreferenceRepository) {}

  public async apply(userId: string, signal: PreferenceSignal, observedAt: string): Promise<UserPreference> {
    const identityKey = preferenceIdentityKey(signal);
    const existing = await this.repository.getPreferenceByIdentity(userId, identityKey);
    const delta = signalDelta(signal);
    const nextStrength = clamp(
      (existing?.strength ?? 0) + delta * (1 - Math.abs(existing?.strength ?? 0) * 0.35),
      -1,
      1,
    );
    const supportCount = (existing?.supportCount ?? 0) + (signal.polarity > 0 ? 1 : 0);
    const contradictionCount = (existing?.contradictionCount ?? 0) + (signal.polarity < 0 ? 1 : 0);
    const observationCount = supportCount + contradictionCount;
    const nextConfidence = clamp(
      Math.max(existing?.confidence ?? 0, signal.confidence * (signal.explicit ? 1 : 0.92))
        + Math.min(0.16, Math.max(0, observationCount - 1) * 0.04),
      0,
      1,
    );
    const status = deriveStatus(
      existing?.status,
      signal.dimension,
      signal.explicit,
      nextStrength,
      nextConfidence,
      observationCount,
    );
    const preference: UserPreference = {
      id: existing?.id ?? `pref-${randomUUID()}`,
      userId,
      identityKey,
      dimension: signal.dimension,
      value: signal.value,
      instruction: signal.instruction,
      scope: { ...signal.scope },
      experienceId: signal.experienceId,
      strength: Number(nextStrength.toFixed(4)),
      confidence: Number(nextConfidence.toFixed(4)),
      supportCount,
      contradictionCount,
      status,
      sourceTypes: unique([...(existing?.sourceTypes ?? []), String(signal.metadata.eventType ?? "unknown")]),
      evidenceEventIds: unique([...(existing?.evidenceEventIds ?? []), signal.eventId]).slice(-40),
      firstObservedAt: existing?.firstObservedAt ?? observedAt,
      lastObservedAt: observedAt,
      lastUsedAt: existing?.lastUsedAt,
      metadata: {
        ...(existing?.metadata ?? {}),
        explicit: Boolean(existing?.metadata.explicit) || signal.explicit,
        latestSignalId: signal.id,
        latestPolarity: signal.polarity,
      },
      updatedAt: observedAt,
    };
    return this.repository.upsertPreference(preference);
  }
}

function preferenceIdentityKey(signal: PreferenceSignal): string {
  const scope = Object.fromEntries(Object.entries(signal.scope).sort(([a], [b]) => a.localeCompare(b)));
  const raw = JSON.stringify({
    dimension: signal.dimension,
    value: signal.value,
    experienceId: signal.experienceId,
    scope,
  });
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function signalDelta(signal: PreferenceSignal): number {
  const magnitude = signal.explicit
    ? 0.78 + signal.confidence * 0.12
    : 0.18 + signal.confidence * 0.34;
  return signal.polarity * magnitude;
}

function deriveStatus(
  existing: UserPreference["status"] | undefined,
  dimension: PreferenceSignal["dimension"],
  explicit: boolean,
  strength: number,
  confidence: number,
  observations: number,
): UserPreference["status"] {
  if (existing === "locked") return "locked";
  if (explicit) return "active";
  if (dimension === "experience_selection" && Math.abs(strength) >= 0.35 && confidence >= 0.65) return "active";
  if (Math.abs(strength) < 0.12 && observations >= 3) return "stale";
  if (Math.abs(strength) >= 0.35 && confidence >= 0.55 && observations >= 2) return "active";
  return "candidate";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
