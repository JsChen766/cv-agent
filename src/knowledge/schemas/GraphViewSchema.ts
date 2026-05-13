import { z } from "zod";
import type {
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
  GraphView,
} from "../types.js";

export const GraphNodeTypeSchema = z.enum([
  "artifact",
  "experience",
  "evidence",
  "skill",
  "requirement",
]) satisfies z.ZodType<GraphNodeType>;

export const GraphEdgeTypeSchema = z.enum([
  "generated_from",
  "supported_by",
  "demonstrates",
  "targets",
  "requires",
  "contains",
]) satisfies z.ZodType<GraphEdgeType>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  type: GraphNodeTypeSchema,
  label: z.string(),
  detail: z.string(),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<GraphNode>;

export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: GraphEdgeTypeSchema,
  label: z.string(),
  weight: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<GraphEdge>;

export const GraphViewSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
}) satisfies z.ZodType<GraphView>;
