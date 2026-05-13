import type { EvidenceChain, GraphNode, GraphEdge, GraphView } from "./types.js";

export class GraphViewBuilder {
  build(chain: EvidenceChain): GraphView {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Experience node
    nodes.push({
      id: chain.experience.id,
      type: "experience",
      label: chain.experience.title,
      detail: `${chain.experience.company} | ${chain.experience.startDate} – ${chain.experience.endDate ?? "Present"}`,
    });

    // Artifact node (the generated bullet)
    nodes.push({
      id: chain.artifact.id,
      type: "artifact",
      label: "Generated Bullet",
      detail: chain.artifact.bulletText,
    });
    edges.push({
      from: chain.experience.id,
      to: chain.artifact.id,
      label: "generated from",
    });

    // Evidence nodes
    for (const e of chain.evidences) {
      nodes.push({
        id: e.id,
        type: "evidence",
        label: e.type,
        detail: e.content,
      });
      edges.push({
        from: chain.experience.id,
        to: e.id,
        label: "contains",
      });
      edges.push({
        from: e.id,
        to: chain.artifact.id,
        label: "supports",
      });
    }

    // Skill nodes
    for (const s of chain.skills) {
      nodes.push({
        id: s.id,
        type: "skill",
        label: s.name,
        detail: s.category,
      });
      edges.push({
        from: s.id,
        to: chain.artifact.id,
        label: "demonstrated by",
      });
      for (const eId of s.evidenceIds) {
        if (chain.evidences.some((e) => e.id === eId)) {
          edges.push({
            from: eId,
            to: s.id,
            label: "proves",
          });
        }
      }
    }

    // Requirement node
    nodes.push({
      id: chain.requirement.id,
      type: "requirement",
      label: "JD Requirement",
      detail: chain.requirement.description,
    });
    edges.push({
      from: chain.artifact.id,
      to: chain.requirement.id,
      label: "targets",
    });

    return { nodes, edges };
  }
}
