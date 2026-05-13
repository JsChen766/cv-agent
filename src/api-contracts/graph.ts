import type { GraphEdge, GraphNode, GraphView } from "../knowledge/types.js";

export type GetGraphViewResponse = {
  centerNodeId: string;
  graphView: GraphView;
};

export type GraphPanelData = {
  title: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};
