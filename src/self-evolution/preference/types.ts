export type PreferenceDimension =
  | "writing_style"
  | "verbosity"
  | "packaging_strength"
  | "evidence_risk"
  | "experience_selection"
  | "section_order"
  | "technical_depth"
  | "metric_usage"
  | "role_focus"
  | "language_style";

export type PreferenceStatus = "candidate" | "active" | "stale" | "rejected" | "locked";

export type PreferenceScope = {
  roleFamily?: string;
  applicationType?: string;
  language?: "zh" | "en";
  section?: string;
  targetRole?: string;
  industry?: string;
};

export type PreferenceEventRecord = {
  id: string;
  dedupeKey?: string;
  userId: string;
  type: string;
  sessionId?: string;
  turnId?: string;
  source?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type PreferenceSignal = {
  id: string;
  eventId: string;
  dimension: PreferenceDimension;
  value: string;
  instruction: string;
  polarity: 1 | -1;
  confidence: number;
  explicit: boolean;
  scope: PreferenceScope;
  experienceId?: string;
  metadata: Record<string, unknown>;
};

export type UserPreference = {
  id: string;
  userId: string;
  identityKey: string;
  dimension: PreferenceDimension;
  value: string;
  instruction: string;
  scope: PreferenceScope;
  experienceId?: string;
  strength: number;
  confidence: number;
  supportCount: number;
  contradictionCount: number;
  status: PreferenceStatus;
  sourceTypes: string[];
  evidenceEventIds: string[];
  firstObservedAt: string;
  lastObservedAt: string;
  lastUsedAt?: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type PreferenceInstruction = {
  preferenceId: string;
  dimension: PreferenceDimension;
  instruction: string;
  strength: number;
  confidence: number;
  scope: PreferenceScope;
};

export type ExperienceAffinity = {
  preferenceId: string;
  experienceId: string;
  affinity: number;
  confidence: number;
  reason: string;
};

export type PersonalizationPack = {
  version: "preference-bank-v1";
  context: PreferenceScope;
  stablePreferences: PreferenceInstruction[];
  contextualPreferences: PreferenceInstruction[];
  negativePreferences: PreferenceInstruction[];
  experienceAffinities: ExperienceAffinity[];
  uncertainPreferences: PreferenceInstruction[];
  retrievalTrace: Array<{
    preferenceId: string;
    dimension: PreferenceDimension;
    score: number;
    effectiveStrength: number;
    scopeMatch: number;
    sourceEventIds: string[];
  }>;
  diagnostics: {
    totalStored: number;
    activeCandidates: number;
    appliedCount: number;
    staleCount: number;
    warnings: string[];
  };
};

export type PreferenceUpdateResult = {
  event: PreferenceEventRecord;
  inserted: boolean;
  signals: PreferenceSignal[];
  preferences: UserPreference[];
};
