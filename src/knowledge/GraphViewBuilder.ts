import type { EvidenceChain, GraphEdge, GraphNode, GraphView } from "./types.js";

export class GraphViewBuilder {
  build(chain: EvidenceChain): GraphView {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    nodes.set(chain.artifact.id, {
      id: chain.artifact.id,
      type: "artifact",
      label: artifactLabel(chain.artifact.type),
      detail: chain.artifact.content,
      score: chain.artifact.scores.overall,
      metadata: {
        status: chain.artifact.status,
        targetRole: chain.artifact.targetRole,
        targetJDId: chain.artifact.targetJDId,
      },
    });

    for (const experience of chain.sourceExperiences) {
      nodes.set(experience.id, {
        id: experience.id,
        type: "experience",
        label: `${experience.role} @ ${experience.organization}`,
        detail: experience.summary,
        score: experience.confidence,
        metadata: {
          type: experience.type,
          timeRange: experience.timeRange,
        },
      });
      edges.push({
        source: experience.id,
        target: chain.artifact.id,
        type: "generated_from",
        label: "generated from",
        weight: chain.artifact.scores.requirementMatch,
      });
    }

    for (const evidence of chain.sourceEvidences) {
      nodes.set(evidence.id, {
        id: evidence.id,
        type: "evidence",
        label: evidence.evidenceType,
        detail: evidence.excerpt,
        score: evidence.confidence,
        metadata: {
          sourceType: evidence.sourceType,
          sourceRef: evidence.sourceRef,
        },
      });
      edges.push({
        source: evidence.experienceId,
        target: evidence.id,
        type: "contains",
        label: "contains",
        weight: evidence.confidence,
      });
      edges.push({
        source: evidence.id,
        target: chain.artifact.id,
        type: "supported_by",
        label: "supports",
        weight: evidence.confidence,
      });
    }

    for (const skill of chain.sourceSkills) {
      nodes.set(skill.id, {
        id: skill.id,
        type: "skill",
        label: skill.name,
        detail: skill.category,
        metadata: {
          evidenceIds: skill.evidenceIds,
        },
      });
      edges.push({
        source: skill.id,
        target: chain.artifact.id,
        type: "demonstrates",
        label: "demonstrates",
        weight: chain.artifact.matchedSkillIds.includes(skill.id) ? 1 : 0.5,
      });

      for (const evidenceId of skill.evidenceIds) {
        if (chain.sourceEvidences.some((evidence) => evidence.id === evidenceId)) {
          edges.push({
            source: evidenceId,
            target: skill.id,
            type: "demonstrates",
            label: "proves",
            weight: 0.8,
          });
        }
      }
    }

    for (const requirementMatch of chain.requirementMatches) {
      const requirement = requirementMatch.requirement;
      nodes.set(requirement.id, {
        id: requirement.id,
        type: "requirement",
        label: "JD Requirement",
        detail: requirement.description,
        score: requirementMatch.matchScore,
        metadata: {
          jdId: requirement.jdId,
          requiredSkillIds: requirement.requiredSkillIds,
          matchReason: requirementMatch.matchReason,
        },
      });
      edges.push({
        source: chain.artifact.id,
        target: requirement.id,
        type: "targets",
        label: "targets",
        weight: requirement.weight,
      });

      for (const skillId of requirement.requiredSkillIds) {
        if (nodes.has(skillId)) {
          edges.push({
            source: requirement.id,
            target: skillId,
            type: "requires",
            label: "requires",
            weight: requirement.weight,
          });
        }
      }
    }

    return {
      nodes: Array.from(nodes.values()),
      edges,
    };
  }
}

function artifactLabel(type: string): string {
  return type
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
