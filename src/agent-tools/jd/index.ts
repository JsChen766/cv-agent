import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { IdInputSchema, JDInputSchema, ListInputSchema, TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { computeJDHash } from "../../product/jdHash.js";
import { normalizeDraftContext } from "../../copilot/context/DraftContext.js";

export function createJDAgentTools(): ToolDefinition[] {
  return [
    {
      name: "list_jds",
      description: "List saved JD records.",
      ownerAgent: "strategist",
      inputSchema: ListInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const items = await context.kernel.productServices.jdService.listJDs(context.userId, typeof input.limit === "number" ? input.limit : 50);
        return { status: "success", message: `Found ${items.length} JD(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "jd_library", jds: items }, visibility: "internal" };
      },
    },
    {
      name: "get_jd",
      description: "Get a saved JD record.",
      ownerAgent: "strategist",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const jd = await context.kernel.productServices.jdService.getJD(context.userId, String(input.id));
        return jd
          ? { status: "success", message: `Loaded JD "${jd.title}".`, data: { jd }, workspacePatch: { activePanel: "jd_library", jdId: jd.id, active: { jdId: jd.id } }, visibility: "internal" }
          : { status: "failed", message: "JD not found.", data: { id: input.id }, visibility: "error_user_visible" };
      },
    },
    {
      name: "prepare_save_jd_from_text",
      description: "Preview saving JD text.",
      ownerAgent: "strategist",
      inputSchema: TextInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => ({ status: "success", message: "Prepared JD save for confirmation.", data: { preview: { rawText: input.text } }, visibility: "internal" }),
    },
    {
      name: "save_jd_from_text",
      description: "Save a JD record.",
      ownerAgent: "strategist",
      inputSchema: JDInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const rawText = String(input.text);
        const jdHash = computeJDHash(rawText);
        const now = new Date().toISOString();
        const normalizedDrafts = normalizeDraftContext(context.workspace?.drafts);
        const jdDraftsAfterSave = markSavedJDDrafts(normalizedDrafts.jdDrafts, jdHash, now);
        const existing = await context.kernel.productServices.jdService.listJDs(context.userId, 1000);
        const duplicate = existing.find((item) => computeJDHash(item.rawText) === jdHash);
        if (duplicate) {
          return {
            status: "success",
            message: "这份 JD 已在库中，已为你打开该 JD。",
            data: { jd: duplicate, jdId: duplicate.id, jdHash },
            workspacePatch: {
              activePanel: "jd_library",
              jdId: duplicate.id,
              active: { jdId: duplicate.id, jdDraftId: undefined },
              drafts: { ...normalizedDrafts, jdDrafts: jdDraftsAfterSave },
            },
            visibility: "user_summary",
            actionResult: {
              actionType: "save_jd_from_text",
              status: "success",
              metadata: {
                jdId: duplicate.id,
                duplicate: true,
                jdHash,
              },
            },
          };
        }
        const jd = await context.kernel.productServices.jdService.saveJD(context.userId, {
          rawText,
          title: typeof input.title === "string" ? input.title : undefined,
          company: typeof input.company === "string" ? input.company : undefined,
          targetRole: typeof input.targetRole === "string" ? input.targetRole : undefined,
        });
        return {
          status: "success",
          message: `Saved JD "${jd.title}".`,
          data: { jd, jdId: jd.id, jdHash },
          workspacePatch: {
            activePanel: "jd_library",
            jdId: jd.id,
            active: { jdId: jd.id, jdDraftId: undefined },
            drafts: { ...normalizedDrafts, jdDrafts: jdDraftsAfterSave },
          },
          visibility: "user_summary",
          actionResult: {
            actionType: "save_jd_from_text",
            status: "success",
            metadata: {
              jdId: jd.id,
              duplicate: false,
              jdHash,
            },
          },
        };
      },
    },
  ];
}

function markSavedJDDrafts(
  drafts: Array<{ rawText: string; status: string; updatedAt: string; lastReferencedAt: string }>,
  jdHash: string,
  now: string,
) {
  let matched = false;
  return drafts.map((draft) => {
    if (computeJDHash(draft.rawText || "") !== jdHash) return draft;
    matched = true;
    return {
      ...draft,
      status: "saved",
      updatedAt: now,
      lastReferencedAt: now,
    };
  }).filter((draft) => matched ? draft.status !== "saved" : true);
}
