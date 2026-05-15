import type { GenerateResumeResult } from "../application/ResumeGenerationService.js";
import type { GenerationSession, GenerationSessionStatus } from "../application/sessions/types.js";
import type { ExtractedTextDocument } from "../tools/document/types.js";
import type { EvidenceChain, GraphView } from "../knowledge/types.js";

export type PersistedDocument = ExtractedTextDocument & {
  storageUri?: string;
  parserStatus: "parsed" | "failed" | "pending";
  parserName?: string;
  parserError?: string;
  updatedAt: string;
};

export interface DocumentRepository {
  save(document: ExtractedTextDocument | PersistedDocument): Promise<void>;
  getById(userId: string, id: string): Promise<PersistedDocument | null>;
  listByUserId(userId: string): Promise<PersistedDocument[]>;
  delete(userId: string, id: string): Promise<void>;
}

export type GenerationArtifactBundleRecord = {
  id: string;
  userId: string;
  sessionId: string;
  artifactId: string;
  evidenceChainSnapshotId?: string;
  graphViewSnapshotId?: string;
  decisionStatus: "undecided" | "accepted" | "rejected" | "needs_revision";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export interface PersistedGenerationSessionRepository {
  save(session: GenerationSession): Promise<void>;
  getById(userId: string, id: string): Promise<GenerationSession | null>;
  listByUserId(userId: string): Promise<GenerationSession[]>;
  updateStatus(userId: string, id: string, status: GenerationSessionStatus): Promise<void>;
}

export interface GenerationArtifactBundleRepository {
  save(bundle: GenerationArtifactBundleRecord): Promise<void>;
  listBySessionId(userId: string, sessionId: string): Promise<GenerationArtifactBundleRecord[]>;
}

export type EvidenceChainSnapshot = {
  id: string;
  userId: string;
  sessionId?: string;
  artifactId?: string;
  chain: EvidenceChain;
  createdAt: string;
  updatedAt: string;
};

export interface EvidenceChainSnapshotRepository {
  save(snapshot: EvidenceChainSnapshot): Promise<void>;
  getById(userId: string, id: string): Promise<EvidenceChainSnapshot | null>;
  listBySessionId(userId: string, sessionId: string): Promise<EvidenceChainSnapshot[]>;
  listByArtifactId(userId: string, artifactId: string): Promise<EvidenceChainSnapshot[]>;
}

export type GraphViewSnapshot = {
  id: string;
  userId: string;
  scopeType: "user" | "experience" | "generation" | "artifact";
  scopeId: string;
  graph: GraphView;
  createdAt: string;
  updatedAt: string;
};

export interface GraphViewSnapshotRepository {
  save(snapshot: GraphViewSnapshot): Promise<void>;
  getById(userId: string, id: string): Promise<GraphViewSnapshot | null>;
  listByScope(userId: string, scopeType: string, scopeId: string): Promise<GraphViewSnapshot[]>;
}

export type ArtifactDecisionRecord = {
  id: string;
  userId: string;
  sessionId: string;
  artifactId: string;
  status: "accepted" | "rejected" | "needs_revision";
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export interface ArtifactDecisionRepository {
  save(decision: ArtifactDecisionRecord): Promise<void>;
  listBySessionId(userId: string, sessionId: string): Promise<ArtifactDecisionRecord[]>;
}

export type CoverageGapDecisionRecord = {
  id: string;
  userId: string;
  sessionId: string;
  gapId: string;
  status: "generate_supplemental_artifact" | "request_more_evidence" | "ignore" | "mark_not_relevant";
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export interface CoverageGapDecisionRepository {
  save(decision: CoverageGapDecisionRecord): Promise<void>;
  listBySessionId(userId: string, sessionId: string): Promise<CoverageGapDecisionRecord[]>;
}

export type GenerationPersistenceResult = {
  session: GenerationSession;
  evidenceChainSnapshots: EvidenceChainSnapshot[];
  graphViewSnapshots: GraphViewSnapshot[];
  bundles: GenerationArtifactBundleRecord[];
};

export type GenerationPersistenceInput = {
  result: GenerateResumeResult;
  metadata?: Record<string, unknown>;
};
