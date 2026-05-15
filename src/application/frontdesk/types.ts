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

export type FrontDeskRequest = {
  userId: string;
  message: string;
  documents?: DocumentInput[];
  jdText?: string;
  targetRole?: string;
};

export type FrontDeskResponse = {
  decision: FrontDeskDecision;
  extractedDocument?: ExtractedTextDocument;
  experience?: Experience;
  evidences?: Evidence[];
  skills?: Skill[];
  artifacts?: GeneratedArtifact[];
  evidenceChains?: EvidenceChain[];
  graphViews?: GraphView[];
  coverageReport?: ArtifactCoverageReport;
  coverageGapReport?: CoverageGapReport;
  critiqueReport?: ArtifactCritiqueReport;
  warnings: string[];
};
