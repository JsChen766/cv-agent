import type { FrontDeskDecision } from "../../agents/FrontDeskAgent.js";
import type {
  ArtifactCritiqueReport,
} from "../critique/types.js";
import type { CoverageGapReport } from "../coverage-gaps/types.js";
import type { ArtifactCoverageReport } from "../evaluation/types.js";
import type { DocumentInput, ExtractedTextDocument } from "../../tools/document/index.js";
import type {
  Evidence,
  EvidenceChain,
  Experience,
  GeneratedArtifact,
  GraphView,
  Skill,
} from "../../knowledge/types.js";
import type {
  EvidenceChainSnapshot,
  GraphViewSnapshot,
} from "../../persistence/repositories.js";

export type DocumentIngestionResult = {
  extractedDocument: ExtractedTextDocument;
  experience?: Experience;
  experiences: Experience[];
  evidences: Evidence[];
  skills: Skill[];
  warnings: string[];
};

export type FrontDeskRequest = {
  userId: string;
  message: string;
  documents?: DocumentInput[];
  jdText?: string;
  targetRole?: string;
  sessionId?: string;
  artifactId?: string;
  evidenceChainSnapshotId?: string;
  graphScopeType?: GraphViewSnapshot["scopeType"];
  graphScopeId?: string;
};

export type FrontDeskResponse = {
  decision: FrontDeskDecision;
  extractedDocument?: ExtractedTextDocument;
  extractedDocuments?: ExtractedTextDocument[];
  experience?: Experience;
  experiences?: Experience[];
  evidences?: Evidence[];
  skills?: Skill[];
  documentIngestionResults?: DocumentIngestionResult[];
  artifacts?: GeneratedArtifact[];
  evidenceChains?: EvidenceChain[];
  evidenceChainSnapshots?: EvidenceChainSnapshot[];
  explanation?: string;
  graphViews?: GraphView[];
  graphViewSnapshots?: GraphViewSnapshot[];
  graphExplanation?: string;
  coverageReport?: ArtifactCoverageReport;
  coverageGapReport?: CoverageGapReport;
  critiqueReport?: ArtifactCritiqueReport;
  warnings: string[];
};
