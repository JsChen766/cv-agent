import type {
  ArtifactCritiqueReport,
} from "../application/critique/types.js";
import type {
  CoverageGapReport,
} from "../application/coverage-gaps/types.js";
import type {
  ArtifactCoverageReport,
} from "../application/evaluation/types.js";
import type {
  EvidenceChainQueryResult,
  GraphViewQueryResult,
} from "../application/query/index.js";
import type {
  ArtifactRevisionResult,
  RevisionInstruction,
  RevisionTone,
  UserConfirmation,
} from "../application/revision/index.js";
import type {
  ArtifactCritiqueItem,
} from "../application/critique/types.js";
import type {
  Evidence,
  EvidenceChain,
  Experience,
  GeneratedArtifact,
  GraphView,
  Skill,
} from "../knowledge/types.js";
import type {
  DocumentInput,
  ExtractedTextDocument,
} from "../tools/document/index.js";
import type { KernelRequestContext } from "./context.js";

export type KernelMode = "postgres" | "in_memory";

export type IngestDocumentInput = {
  documents: DocumentInput[];
  message?: string;
};

export type IngestDocumentResult = {
  extractedDocuments: ExtractedTextDocument[];
  experience?: Experience;
  experiences: Experience[];
  evidences: Evidence[];
  skills: Skill[];
  warnings: string[];
};

export type CreateGenerationInput = {
  jdText: string;
  targetRole: string;
};

export type CreateGenerationResult = {
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
  graphViews: GraphView[];
  coverageReport: ArtifactCoverageReport;
  coverageGapReport: CoverageGapReport;
  critiqueReport: ArtifactCritiqueReport;
  persistedGeneration?: {
    sessionId: string;
    evidenceChainSnapshotCount: number;
    graphViewSnapshotCount: number;
    bundleCount: number;
  };
};

export type EvidenceChainQuery = {
  sessionId?: string;
  artifactId?: string;
  snapshotId?: string;
};

export type GraphQuery = {
  scopeType: "user" | "experience" | "generation" | "artifact";
  scopeId: string;
};

export type ReviseArtifactInput = {
  artifact: GeneratedArtifact;
  critiqueItem?: ArtifactCritiqueItem;
  evidenceChain?: EvidenceChain;
  instruction: RevisionInstruction;
  customInstruction?: string;
  targetRequirementIds?: string[];
  userConfirmations?: UserConfirmation[];
  tone?: RevisionTone;
};

export type KernelHealth = {
  ok: true;
  mode: KernelMode;
  warnings: string[];
};

export type CvAgentKernel = {
  mode: KernelMode;
  documents: {
    ingest(ctx: KernelRequestContext, input: IngestDocumentInput): Promise<IngestDocumentResult>;
  };
  generations: {
    create(ctx: KernelRequestContext, input: CreateGenerationInput): Promise<CreateGenerationResult>;
    getEvidenceChains(ctx: KernelRequestContext, query: EvidenceChainQuery): Promise<EvidenceChainQueryResult>;
    getGraph(ctx: KernelRequestContext, query: GraphQuery): Promise<GraphViewQueryResult>;
    reviseArtifact(ctx: KernelRequestContext, input: ReviseArtifactInput): Promise<ArtifactRevisionResult>;
  };
  health(): Promise<KernelHealth>;
  close(): Promise<void>;
};
