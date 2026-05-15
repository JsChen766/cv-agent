import type {
  EvidenceChainSnapshot,
  GraphViewSnapshot,
} from "../../persistence/repositories.js";

export type EvidenceChainQueryResult = {
  evidenceChains: EvidenceChainSnapshot[];
  summary: string;
};

export type GraphViewQueryResult = {
  graphViews: GraphViewSnapshot[];
  summary: string;
  warnings: string[];
};
