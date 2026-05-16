export type ArtifactDecisionType =
  | "accept"
  | "reject"
  | "request_revision"
  | "confirm_metric"
  | "mark_unsafe"
  | "prefer_variant";

export type ArtifactMetricConfirmation = {
  metric?: string;
  value?: string;
  explanation?: string;
};

export type ArtifactDecisionInput = {
  userId: string;
  artifactId: string;
  sessionId?: string;
  decision: ArtifactDecisionType;
  reason?: string;
  selectedVariantId?: string;
  confirmation?: ArtifactMetricConfirmation;
};

export type ArtifactDecisionRecord = {
  id: string;
  userId: string;
  artifactId: string;
  sessionId?: string;
  decision: ArtifactDecisionType;
  reason?: string;
  selectedVariantId?: string;
  confirmation?: ArtifactMetricConfirmation;
  createdAt: string;
};

export interface ArtifactDecisionRepository {
  save(record: ArtifactDecisionRecord): Promise<void>;
  listByArtifactId(userId: string, artifactId: string): Promise<ArtifactDecisionRecord[]>;
  listBySessionId(userId: string, sessionId: string): Promise<ArtifactDecisionRecord[]>;
}
