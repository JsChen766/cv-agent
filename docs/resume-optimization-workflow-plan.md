# Resume Optimization Workflow Plan

## Background

The current backend already has JD matching, evidence retrieval, structured resume generation, critic review, PDF layout measurement, and export validation. The next step is not to replace those capabilities, but to organize them into a stable, observable resume optimization workflow that can support chat-driven preview, step-by-step progress, local change review, and selective accept or reject behavior.

This plan upgrades the backend output from "a generated resume result" to "a workflow with analyzable stages, previewable drafts, reviewable change sets, and recoverable failures".

## Non-Negotiable Principles

1. Do not delete, weaken, or bypass any existing capability.
   Existing RAG, self-evolution, preference learning, critic review, resume parsing, JD matching, structured generation, fit engine, layout oracle, PDF export, product persistence, and frontend-facing contracts must remain available. Improvements should be additive unless a later phase explicitly proves that a replacement is safer and fully compatible.

2. Reuse first, avoid duplicated or low-quality implementation.
   Prefer existing services, schemas, repositories, event projectors, ProductBlock shapes, layout tools, prompt infrastructure, and smoke scripts. Do not duplicate business logic, do not write throwaway glue code, do not create high-coupling shortcuts, and do not push workflow complexity into `AgentOrchestrator` when a focused service or adapter can own it.

3. Use mature existing libraries or platform functions when they clearly help.
   It is acceptable to introduce LangGraph, LangChain, state-machine helpers, JSON patch libraries, diff utilities, or other mature dependencies if they reduce complexity, improve testability, or provide reliable primitives. New dependencies must be hidden behind internal adapters/services, must not leak into public contracts, and must not replace simple existing code without a clear benefit.

4. Preserve public contracts unless explicitly planned.
   Do not change public API envelopes, request shapes, response semantics, ProductBlock meanings, export contracts, or frontend expectations without an explicit compatibility plan. New fields should be additive and optional by default.

5. Evidence and layout quality are hard gates.
   Resume optimization must remain evidence-backed. Do not invent companies, schools, roles, dates, projects, metrics, awards, or unsupported skills. PDF/layout quality must be verified through the existing browser/PDF measurement path instead of string or character-count guesses.

6. Real verification is required before calling a phase complete.
   Each implementation phase must include focused tests plus real Docker backend validation where the behavior depends on LLM output, PDF rendering, export, or end-to-end `/copilot/chat` flow.

## Target Workflow

```text
intake
  -> jd_analysis
  -> evidence_pack
  -> rewrite_plan
  -> draft_generation
  -> layout_check
  -> critic_review
  -> change_set_ready
  -> user_accept_or_reject
  -> export
```

Target backend artifacts:

- `workflowStatus`: stage, progress, status, current artifact ids, failure reason, and next action.
- `analysisReport`: JD, ATS, structure, evidence, risk, and delivery-quality analysis.
- `resumeDocumentDraft`: previewable structured resume at each meaningful stage.
- `resumeChangeSet`: section/item/bullet-level changes with before/after/reason/evidence/risk.
- `criticReviewItems`: actionable editorial findings and patch suggestions.
- `layoutPreviewReport`: A4 fit, page usage, overflow/underflow, bullet line width, and section completeness diagnostics.

## Phase 1: Workflow State Machine

Goal: make resume optimization a stable pipeline with explicit stage state.

Primary additions:

- `ResumeOptimizationWorkflowService`
- `ResumeOptimizationRun`
- `ResumeOptimizationStage`
- `ResumeWorkflowEventProjector`

Required stages:

- `intake`
- `jd_analysis`
- `evidence_pack`
- `rewrite_plan`
- `draft_generation`
- `layout_check`
- `critic_review`
- `change_set_ready`
- `accepted`
- `exported`
- `failed`
- `needs_input`

Implementation notes:

- Reuse existing `/copilot/chat`, `/copilot/chat/stream`, pending action, job, product generation, export, and AgentRoom event paths.
- Keep orchestration internals additive. Avoid large rewrites of `AgentOrchestrator`.
- Persist enough run state to resume or retry the current stage after an LLM timeout or process failure.
- Emit stage events that the frontend can render as a task checklist.

Acceptance criteria:

- A real resume optimization request produces ordered workflow stage events.
- Each stage exposes `pending | running | completed | failed | needs_input`.
- JD missing, company/role missing, LLM timeout, evidence shortage, and layout failure each produce a clear next action.
- Existing generation/export behavior still works when the new workflow is not used.

Validation:

- `npm run typecheck`
- Focused Vitest tests for workflow stage transitions and failure states.
- Real Docker `/copilot/chat` smoke for one JD-backed optimization request.

## Phase 1 Completion Status

Status as of 2026-07-02: complete.

Implementation summary:

- Added an internal `ResumeOptimizationWorkflowService` with `ResumeOptimizationRun`, `ResumeOptimizationStage`, ordered stage state, workflow events, next actions, failure classification, and snapshot hydration.
- Threaded workflow state through direct `generate_resume_from_jd`, queued pending-action confirmation, `long_generation` job completion/failure, product generation snapshots, workspace patches, and action metadata.
- Added `ResumeWorkflowEventProjector` so workflow state appears through the existing AgentRoom `agent_activity_timeline` special-info path without adding a new public endpoint or response envelope.
- Preserved the existing generation/export contracts by keeping all workflow fields optional and nested inside existing `data`, `workspacePatch`, `actionResult.metadata`, and generation snapshot metadata.

Changed files:

- `src/product/resumeOptimization/types.ts`
- `src/product/resumeOptimization/ResumeOptimizationWorkflowService.ts`
- `src/product/resumeOptimization/index.ts`
- `src/product/services/index.ts`
- `src/product/index.ts`
- `src/agent-core/events/ResumeWorkflowEventProjector.ts`
- `src/agent-core/events/AgentRoomEventProjector.ts`
- `src/agent-core/confirmation/PendingActionService.ts`
- `src/agent-tools/resume/generateResumeFromJD.tool.ts`
- `src/jobs/JobRunner.ts`
- `src/api/kernel/createKernel.ts`
- `tests/resumeOptimizationWorkflow.test.ts`
- `tests/resumeAgentTools.test.ts`
- `tests/CopilotRoutes.test.ts`
- `docs/resume-optimization-workflow-plan.md`

Contract impact assessment:

- Public API routes, request bodies, response envelopes, ProductBlock meanings, pending-action semantics, job routes, generation routes, and export routes are unchanged.
- Additive optional workflow metadata is now available to clients that opt into it: `workflowStatus` and `workflowEvents` under existing tool result data/workspace/action metadata surfaces.
- AgentRoom uses the existing `agent_activity_timeline` special-info kind; no new special-info kind is required for Phase 1.

Tests run:

- `npm run typecheck` - passed.
- `npx vitest run tests/resumeOptimizationWorkflow.test.ts tests/resumeAgentTools.test.ts` - passed, 8 tests.
- `npx vitest run tests/CopilotRoutes.test.ts` - passed, 23 tests.
- `npm test` - passed.

Real Docker/LLM/PDF validation:

- `docker compose ps` confirmed `coolto-agent-api` and `coolto-postgres` were running.
- Ran a real Docker-backed JD optimization smoke against `http://127.0.0.1:3000` with user `dev-user`.
- Covered `/health`, `/copilot/chat`, `/copilot/actions`, `/copilot/pending-actions/:id/confirm`, `/jobs/:id`, and `/product/generations/:id`.
- Verified the confirmation response included `workflowStatus.runId`, `currentStage=jd_analysis`, completed `intake`, running `jd_analysis`, and an AgentRoom `agent_activity_timeline` event.
- Verified the completed `long_generation` job preserved the same workflow run id, reached `currentStage=change_set_ready`, completed `intake`, `jd_analysis`, `evidence_pack`, `rewrite_plan`, `draft_generation`, and `change_set_ready`, and produced generation `pgen-53c6b1ad-1d92-45d2-b88a-3a0921cec3bd` with 2 variants.
- Verified `/product/generations/:id` persisted the matching `resumeOptimizationRun` snapshot.
- Smoke result marker: `PHASE1_WORKFLOW_SMOKE_PASS`.

Unresolved risks and Phase 2 handoff notes:

- Phase 1 exposes the state machine and checklist, but `layout_check`, `critic_review`, and item-level `change_set_ready` remain structural stage placeholders until later phases wire in their full artifacts.
- Workflow run state is persisted inside existing generation/job/pending-action metadata surfaces. If Phase 2 needs independent querying across runs, add a dedicated repository behind the same internal service without changing public contracts.
- Missing company/role and evidence shortage currently produce clear next actions while allowing conservative generation to continue; Phase 2 should convert those signals into rubric findings.

## Phase 2: Stable Rubric And Analysis Report

Goal: explain why the resume should change before generating changes.

Primary additions:

- `ResumeOptimizationRubricService`
- `JDResumeAnalysisService`
- `ATSKeywordCoverageService`

Rubric dimensions:

- ATS keyword coverage
- JD alignment
- evidence strength
- metric and quantification quality
- STAR closure
- professional expression quality
- structure completeness
- layout risk
- fabrication or exaggeration risk
- application readiness

Implementation notes:

- Reuse the existing JD requirement parser, match scoring, evidence services, and resume quality services where possible.
- Make the report section/item/bullet addressable. A total score alone is not enough.
- Store the rubric version in the report so future behavior is auditable.
- Keep deterministic rules separate from LLM semantic review.

Acceptance criteria:

- The same resume/JD pair produces stable report structure across runs.
- Report findings can identify target section/item/bullet ids where available.
- The analysis can feed Phase 3 rewrite planning without reparsing free text.

Validation:

- Unit tests for rubric scoring and report shape.
- Golden-shape tests for strong, partial, and weak JD matches.
- Real Docker smoke that stores the analysis report in the workflow output.

## Phase 2 Completion Status

Status as of 2026-07-02: complete.

Implementation summary:

- Added `JDResumeAnalysisService`, `ResumeOptimizationRubricService`, and `ATSKeywordCoverageService` under the internal resume optimization module.
- Reused the existing deterministic `JDRequirementParser` and `EvidencePack` shapes when available, with deterministic fallback matching against selected source experiences when evidence RAG is absent.
- Added a versioned `analysisReport` artifact with 10 rubric dimensions, ATS keyword coverage, addressable requirement findings, evidence/source ids, stable target paths, and `phase3Inputs` for rewrite planning.
- Threaded `analysisReport` through `GenerationProductService`, direct `generate_resume_from_jd` tool output, queued `long_generation` job output, pending-action completion metadata, workspace metadata, and generation input/output snapshots.
- Kept deterministic scoring separate from future LLM semantic review; Phase 2 does not add a new public route or require the frontend to consume the report.

Changed files:

- `src/product/resumeOptimization/types.ts`
- `src/product/resumeOptimization/ATSKeywordCoverageService.ts`
- `src/product/resumeOptimization/ResumeOptimizationRubricService.ts`
- `src/product/resumeOptimization/JDResumeAnalysisService.ts`
- `src/product/resumeOptimization/index.ts`
- `src/product/services/index.ts`
- `src/api/kernel/createKernel.ts`
- `src/agent-tools/resume/generateResumeFromJD.tool.ts`
- `src/jobs/JobRunner.ts`
- `src/copilot/types.ts`
- `tests/resumeOptimizationWorkflow.test.ts`
- `tests/resumeAgentTools.test.ts`
- `docs/resume-optimization-workflow-plan.md`

Contract impact assessment:

- Public route paths, request bodies, response envelopes, ProductBlock semantics, pending-action semantics, job routes, generation routes, and export routes are unchanged.
- New `analysisReport` data is additive and optional, carried only inside existing metadata/snapshot surfaces.
- `CopilotWorkspace.analysisReport` is optional `unknown` metadata for persisted workflow context; it does not alter workspace status or variant semantics.

Tests run:

- `npm run typecheck` - passed.
- `npx vitest run tests/resumeOptimizationWorkflow.test.ts tests/resumeAgentTools.test.ts tests/CopilotRoutes.test.ts` - passed, 33 tests.
- `npm test` - passed.

Real Docker/LLM validation:

- Rebuilt and restarted the Docker API with `docker compose up -d --build api`.
- Confirmed `/health` returned `mode=postgres`.
- Ran a real Docker-backed `/copilot/chat` flow through pending-action confirmation, `/jobs/:id` polling, and `/product/generations/:id`.
- Verified completed `long_generation` output included `analysisReport.rubricVersion=resume-optimization-rubric-v1`, 10 rubric dimensions, 13 requirement analysis entries, 28 findings, deduped `phase3Inputs.prioritizedRequirementIds`, and `workflowStatus.currentStage=change_set_ready`.
- Verified generation `pgen-6c835b43-4911-4f71-a3cc-08e46896a86e` persisted `analysisReport` in both `inputSnapshot` and `outputSnapshot`.
- Smoke result marker: `PHASE2_ANALYSIS_REPORT_SMOKE_PASS`.

Unresolved risks and Phase 3 handoff notes:

- Phase 2 ranks and explains requirements, but does not yet create user-reviewable local changes; Phase 3 should consume `analysisReport.phase3Inputs` instead of reparsing JD/free text.
- Item/bullet ids are populated when structured evidence or source ids are available; true bullet-level targets will become stronger once Phase 3 projects generated drafts into explicit change targets.
- Layout risk remains heuristic before Phase 4 layout preview artifacts wire in the browser/PDF measurement path.

## Phase 3: Local Change Set Protocol

Goal: expose "N changes waiting for review" instead of only returning a full generated variant.

Primary additions:

- `ResumeChangeSetService`
- `ResumeChangePlanner`
- `ResumeChangeApplyService`
- `ResumeChangeRejectService`

Change types:

- `replace_bullet`
- `add_bullet`
- `remove_bullet`
- `rewrite_headline`
- `rewrite_summary`
- `reorder_section`
- `add_skill_keyword`
- `remove_weak_item`
- `tighten_certificate`
- `layout_compact`

Each change must include:

- `changeId`
- `target`: section/item/bullet id or stable path
- `before`
- `after`
- `reason`
- `evidenceIds`
- `sourceExperienceId`
- `riskLevel`
- `rubricDimensions`
- `status`
- `acceptAction`
- `rejectAction`

Implementation notes:

- Prefer structured `resumeDocument` and `ProductResumeItem` ids over text matching.
- Use stable business keys for dedupe, not transient event ids.
- Store original and current draft snapshots so individual rejects do not require regenerating the whole resume.
- Keep change application deterministic and testable.

Acceptance criteria:

- Backend can output a change set with a count such as "16 changes waiting for review".
- A single change can be accepted without applying the rest.
- A single change can be rejected without mutating unrelated changes.
- "Accept all" and "reject all" are deterministic.
- The workflow can recover the original draft.

Validation:

- Unit tests for patch apply/reject/idempotency.
- Tests for duplicate change suppression.
- Real flow smoke covering single accept, single reject, and accept all.

## Phase 3 Completion Status

Status as of 2026-07-02: complete.

Implementation summary:

- Added a local change-set protocol with `ResumeChangeSet`, item/bullet-level `ResumeChange`, review status, accept/reject actions, original/current/proposed draft snapshots, and deterministic summary counts such as "13 changes waiting for review".
- Added `ResumeChangePlanner`, `ResumeChangeSetService`, `ResumeChangeApplyService`, and `ResumeChangeRejectService`.
- The planner consumes the Phase 2 `analysisReport.phase3Inputs` and generated `resumeDocument` where available, falls back to generated content when needed, prefers structured section/item/bullet/source ids, and suppresses duplicate changes using stable business content rather than transient bullet ids.
- Single-change accept, single-change reject, accept-all, and reject-all are pure deterministic operations over the stored change set. Reject-all recovers the original draft without regenerating the resume.
- Threaded `resumeChangeSet` through direct `generate_resume_from_jd`, queued `long_generation`, pending-action completion metadata, workspace metadata, job output, and generation input/output snapshots.
- Updated `change_set_ready` workflow status to point to `review_resume_change_set` with the real change-set id and pending review count.

Changed files:

- `src/product/resumeOptimization/types.ts`
- `src/product/resumeOptimization/ResumeChangePlanner.ts`
- `src/product/resumeOptimization/ResumeChangeSetService.ts`
- `src/product/resumeOptimization/ResumeChangeApplyService.ts`
- `src/product/resumeOptimization/ResumeChangeRejectService.ts`
- `src/product/resumeOptimization/index.ts`
- `src/product/services/index.ts`
- `src/api/kernel/createKernel.ts`
- `src/agent-tools/resume/generateResumeFromJD.tool.ts`
- `src/jobs/JobRunner.ts`
- `src/copilot/types.ts`
- `tests/resumeOptimizationWorkflow.test.ts`
- `tests/resumeAgentTools.test.ts`
- `docs/resume-optimization-workflow-plan.md`

Contract impact assessment:

- Public route paths, request bodies, response envelopes, ProductBlock meanings, pending-action semantics, job routes, generation routes, and export routes are unchanged.
- New `resumeChangeSet` and `resumeChangeSets` data is additive and optional, carried inside existing tool result data, workspace patch, job output, action metadata, and generation snapshot surfaces.
- `CopilotWorkspace.resumeChangeSet` is optional `unknown` metadata for persisted workflow context; it does not alter workspace status, variant semantics, or export behavior.

Tests run:

- `npm run typecheck` - passed.
- `npx vitest run tests/resumeOptimizationWorkflow.test.ts tests/resumeAgentTools.test.ts` - passed, 13 tests.
- `npx vitest run tests/CopilotRoutes.test.ts` - passed, 23 tests.
- `npm test` - passed.

Real Docker/LLM validation:

- Rebuilt and restarted the Docker API with `docker compose up -d --build api`.
- Confirmed `/health` returned `mode=postgres`.
- Ran a real Docker-backed `/copilot/chat` session through `/copilot/actions`, `/copilot/pending-actions/:id/confirm`, `/jobs/:id` polling, and `/product/generations/:id`.
- Verified completed `long_generation` output included `resumeChangeSet.changeSetId=rcs-69bdc74ff6b09d5c`, `pendingCount=13`, `totalChanges=13`, `workflowStatus.currentStage=change_set_ready`, and `workflowStatus.nextAction.type=review_resume_change_set`.
- Verified generation `pgen-2ce4379a-b698-4f2f-86d4-4ecc6cd32574` persisted the matching change set in both `inputSnapshot.resumeChangeSet` and `outputSnapshot.resumeChangeSet`.
- Smoke result marker: `PHASE3_CHANGE_SET_SMOKE_PASS`.

Unresolved risks and Phase 4 handoff notes:

- Phase 3 stores reviewable draft lineage, but does not yet expose a dedicated public apply/reject route. The deterministic services are ready for a route or existing action adapter when the frontend begins sending local review decisions.
- Fallback change sets can be produced from unstructured variant content, but the strongest target ids come from `resumeDocument`; Phase 4 should project all preview surfaces from structured draft lineage.
- Layout changes are represented as reviewable `layout_compact` proposals when detected heuristically. Phase 4 should replace that heuristic with preview layout diagnostics from the browser/PDF measurement path.

## Phase 4: Preview-Friendly Draft Artifacts

Goal: support a real-time resume preview canvas without waiting for final PDF export.

Primary additions:

- `ResumeDraftProjector`
- `ResumePreviewSnapshotService`
- `ResumePatchProjectionService`
- `LayoutPreviewReportProjector`

Preview stages:

- original parsed resume document
- problem markers from analysis
- rewrite plan
- patched draft
- layout-checked draft
- critic-repaired draft
- final accepted draft

Implementation notes:

- Reuse `resumeDocument`, product resume items, layout oracle, PageSpec, and existing export template semantics.
- Do not make PDF generation the only preview path. The frontend should be able to render the structured draft before export.
- Emit preview snapshots through existing special-info/product block/event mechanisms where possible.
- Keep layout preview diagnostics consistent with final export diagnostics.

Acceptance criteria:

- Each meaningful workflow stage can expose a renderable `resumeDocumentDraft`.
- Layout preview reports can flag overflow, underfill, excessive bullet lines, and missing sections before export.
- Final export uses the same draft lineage that the preview showed.

Validation:

- Tests for draft projection from original, change set, and accepted changes.
- Tests comparing preview layout report fields with export `qualityReport.layoutReport`.
- Real Docker/PDF smoke proving preview draft and exported PDF stay aligned.

## Phase 4 Completion Status

Status as of 2026-07-02: complete.

Implementation summary:

- Added internal preview artifact types for `resumeDocumentDraft`, `ResumePreviewSnapshot`, problem markers, rewrite-plan items, and layout preview diagnostics.
- Added `ResumeDraftProjector`, `ResumePatchProjectionService`, `ResumePreviewSnapshotService`, and `LayoutPreviewReportProjector`.
- Preview snapshots now expose original parsed resume, analysis problem markers, rewrite plan, and patched draft from the Phase 3 change-set lineage without requiring PDF generation.
- `LayoutPreviewReportProjector` reuses the export `ResumeLayoutReport` shape and projects overflow, underfill, excessive bullet lines, short bullet lines, and missing-section diagnostics.
- Threaded `resumePreviewSnapshots` and `resumeDocumentDraft` through direct `generate_resume_from_jd`, queued `long_generation` job output, pending-action completion metadata, workspace metadata, and generation input/output snapshots.
- Final accept/export path continues to use the same structured variant/draft lineage that preview snapshots expose, preserving existing export template semantics.

Changed files:

- `src/product/resumeOptimization/types.ts`
- `src/product/resumeOptimization/ResumeDraftProjector.ts`
- `src/product/resumeOptimization/ResumePatchProjectionService.ts`
- `src/product/resumeOptimization/ResumePreviewSnapshotService.ts`
- `src/product/resumeOptimization/LayoutPreviewReportProjector.ts`
- `src/product/resumeOptimization/index.ts`
- `src/product/services/index.ts`
- `src/api/kernel/createKernel.ts`
- `src/agent-tools/resume/generateResumeFromJD.tool.ts`
- `src/jobs/JobRunner.ts`
- `src/copilot/types.ts`
- `tests/resumeOptimizationWorkflow.test.ts`
- `tests/resumeAgentTools.test.ts`
- `docs/resume-optimization-workflow-plan.md`

Contract impact assessment:

- Public route paths, request bodies, response envelopes, ProductBlock meanings, pending-action semantics, job routes, generation routes, and export routes are unchanged.
- New `resumePreviewSnapshots` and `resumeDocumentDraft` data is additive and optional, carried only inside existing tool result data, workspace patch, action metadata, job output, and generation snapshot surfaces.
- `CopilotWorkspace.resumePreviewSnapshots` and `CopilotWorkspace.resumeDocumentDraft` are optional `unknown` metadata for persisted preview context; they do not alter workspace status, variant semantics, or export behavior.

Tests run:

- `npx vitest run tests/resumeOptimizationWorkflow.test.ts` - passed, 10 tests.
- `npx vitest run tests/resumeAgentTools.test.ts` - passed, 5 tests.
- `npm run typecheck` - passed.
- `npx vitest run tests/resumeOptimizationWorkflow.test.ts tests/resumeAgentTools.test.ts tests/CopilotRoutes.test.ts` - passed, 38 tests.
- `npm test` - passed, 873 tests.

Real Docker/LLM/PDF validation:

- Rebuilt and restarted the Docker API with `docker compose up -d --build api`.
- Confirmed `/health` returned `mode=postgres`.
- Ran a Docker-backed product flow through `/product/experiences`, `/product/generations/from-jd`, `/jobs/:id`, `/product/generations/:id`, `/product/generations/:id/accept-variant`, `/exports/resumes/:resumeId`, and `/exports/:id`.
- Verified completed generation `pgen-aaa67821-0332-4837-94a0-2186ad055ba2` exposed `resumePreviewSnapshots` and `resumeDocumentDraft` in job output and persisted generation snapshots.
- Verified accepted resume `pres-ed67dd50-cf02-41c5-842b-cef21af292e8` exported to PDF export `export-fee1c64e-c9fc-4626-8033-0997e1b76126` with completed export job `job-62b9cb86-68a3-4b2c-aad2-a8414f35f94a`.
- Verified exported PDF quality metadata included `qualityReport.layoutReport` with `fitsPage=true`, `overflowPx=0`, and layout diagnostics available for preview/export field comparison.
- Smoke result marker: `PHASE4_PREVIEW_DOCKER_PDF_SMOKE_PASS`.

Unresolved risks and Phase 5 handoff notes:

- Phase 4 exposes deterministic preview lineage and layout preview projection, but it does not yet run the browser layout oracle during generation; Phase 5/6 can attach measured `layout_checked_draft` snapshots when critic/layout repair stages execute.
- Dedicated public accept/reject routes are still not exposed; preview final accepted draft is available through internal deterministic services and existing variant acceptance, while item-level frontend review actions remain a future adapter task.
- Critic-repaired draft snapshots are structurally reserved but not populated until Phase 5 wires actionable critic items and patch suggestions.

## Phase 5: Editorial Critic And Auto Patch Suggestions

Goal: turn critic from a coarse pass/fail gate into an actionable editor.

Primary additions:

- `ResumeEditorialCriticService`
- `CriticReviewItemService`
- `CriticPatchSuggestionService`

Critic finding categories:

- unsupported claim
- inflated metric
- weak verb
- missing STAR closure
- poor JD alignment
- repeated wording
- structure mismatch
- bullet too short
- bullet too long
- layout risk
- tone or seniority mismatch

Each critic item should include:

- target section/item/bullet
- issue category
- severity
- explanation
- evidence references
- suggested fix
- whether auto-fix is allowed
- optional patch

Implementation notes:

- Reuse existing critic review, evidence tools, unsupported-claim checks, and `ResumeQualityService`.
- Do not let critic silently rewrite unrelated content.
- If auto patch is applied, rerun rubric and layout checks for affected parts.
- If critic cannot repair safely, return `needs_input` with a precise question.

Acceptance criteria:

- Critic can produce multiple item-level findings.
- Safe findings can create patch suggestions.
- Unsafe or evidence-missing findings ask the user for missing information.
- Critic results are visible as reviewable items, not hidden logs.

Validation:

- Unit tests for critic item schema and patch conversion.
- Tests for unsupported claim, weak STAR, and layout-risk cases.
- Real LLM smoke comparing before/after critic patch behavior.

## Phase 6: Graceful Failure And Recovery

Goal: make the workflow resilient and user-guiding.

Failure cases:

- missing JD
- missing company or role
- insufficient evidence
- weak JD/resume match
- LLM timeout
- LLM invalid JSON
- layout overflow
- layout underfill
- critic fail
- export failure

Required behavior:

- Preserve completed stages.
- Retry only the failed stage when possible.
- Return a clear next action.
- Keep partial drafts visible if safe.
- Mark risky or incomplete content instead of pretending success.
- Avoid user-facing raw provider payloads, secrets, prompts, internal tool arguments, or chain-of-thought.

Acceptance criteria:

- Missing JD enters `needs_input` with a structured request.
- Evidence shortage creates conservative changes and clear missing-evidence notes.
- LLM timeout preserves the current workflow run and allows retry.
- Layout overflow/underfill returns targeted layout remediation, not a full ungrounded rewrite.
- Export failure surfaces a safe, actionable error message.

Validation:

- Unit tests for each failure state.
- Integration tests for retry and resume.
- Real Docker smoke for at least missing JD, normal JD, and export path.

## Phase 7: Optional LangGraph Or Mature Workflow Runtime Evaluation

Goal: decide whether a mature workflow runtime is worth adopting after the domain workflow is understood.

Evaluation criteria:

- Does it reduce state transition complexity?
- Does it improve retries, branching, and resumability?
- Can it stay behind an internal adapter?
- Can it preserve current public contracts?
- Can it be tested deterministically?
- Does it avoid forcing high-coupling changes to agent internals?

Possible adapter:

- `WorkflowRuntimeAdapter`
- `NativeWorkflowRuntimeAdapter`
- `LangGraphWorkflowRuntimeAdapter`

Decision rule:

- Keep the native TypeScript workflow if it remains simple and testable.
- Adopt LangGraph only if Phase 1-6 reveal real branching/retry complexity that it handles better than the native implementation.

## Suggested Implementation Order

1. Phase 1: Workflow State Machine
2. Phase 2: Stable Rubric And Analysis Report
3. Phase 3: Local Change Set Protocol
4. Phase 4: Preview-Friendly Draft Artifacts
5. Phase 5: Editorial Critic And Auto Patch Suggestions
6. Phase 6: Graceful Failure And Recovery
7. Phase 7: Optional workflow runtime evaluation

## Definition Of Done For Each Phase

Each phase must end with:

- implementation summary appended to this file
- changed file list
- contract impact assessment
- tests run
- real Docker/LLM/PDF validation when applicable
- unresolved risks and next-phase handoff notes

## Phase Completion Log

No phases have been implemented under this plan yet.
