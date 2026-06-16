# Changed and Added Files

This list is relative to the backend version uploaded as `cv-agent(2).zip`.

## Modified existing files

- `src/agent-core/prompts/prompts/product/evidence-claim-extraction-system.md`
- `src/agent-core/prompts/prompts/product/evidence-jd-requirement-system.md`
- `src/agent-core/prompts/prompts/product/guideline-instruction-system.md`
- `src/agent-core/prompts/prompts/product/guideline-role-analysis-system.md`
- `src/api/kernel/createKernel.ts`
- `src/api/routes/product.ts`
- `src/product/LLMGenerationService.ts`
- `src/product/services/index.ts`
- `src/product/types.ts`
- `src/rag/evidence/ClaimGraphRepository.ts`
- `src/rag/evidence/ClaimSupportVerifier.ts`
- `src/rag/evidence/EvidencePackBuilder.ts`
- `src/rag/evidence/EvidenceQualityScorer.ts`
- `src/rag/evidence/EvidenceRAGService.ts`
- `src/rag/evidence/EvidenceTraceBuilder.ts`
- `src/rag/evidence/ExperienceClaimExtractor.ts`
- `src/rag/evidence/ExperienceRetriever.ts`
- `src/rag/evidence/JDRequirementParser.ts`
- `src/rag/evidence/PersistentClaimRetriever.ts`
- `src/rag/evidence/PostgresClaimGraphRepository.ts`
- `src/rag/evidence/RequirementPolicyRouter.ts`
- `src/rag/evidence/index.ts`
- `src/rag/evidence/textUtils.ts`
- `src/rag/evidence/types.ts`
- `src/rag/guideline/GuidelineInstructionBuilder.ts`
- `src/rag/guideline/GuidelineRAGService.ts`
- `src/rag/guideline/GuidelineRetriever.ts`
- `src/rag/guideline/GuidelineRoleAnalyzer.ts`
- `src/rag/guideline/LLMGuidelineService.ts`
- `src/rag/guideline/PostgresGuidelineRepository.ts`
- `src/rag/guideline/defaultGuidelines.ts`
- `src/rag/guideline/index.ts`
- `src/rag/guideline/types.ts`
- `tests/EvidenceRAGPersistentClaimGraph.test.ts`
- `tests/EvidenceRAGV4Memory.test.ts`
- `tests/GuidelineRAGService.test.ts`

## Added files

- `src/api/routes/product/ragRoutes.ts`
- `src/persistence/postgres/migrations/0013_rag_finalization.sql`
- `src/rag/GroundingContextCoordinator.ts`
- `src/rag/index.ts`
- `src/rag/types.ts`
- `src/rag/evidence/EvidenceIndexMaintenanceService.ts`
- `src/rag/evidence/EvidenceScoring.ts`
- `src/rag/evidence/RequirementQueryPlanner.ts`
- `src/rag/evidence/RetrievalEvaluator.ts`
- `src/rag/guideline/GuidelineIngestionService.ts`
- `src/rag/guideline/GuidelineQueryPlanner.ts`
- `src/rag/guideline/InstructionPackQualityGate.ts`
- `tests/EvidenceRAGFinal.test.ts`
- `tests/GuidelineRAGFinal.test.ts`
- `tests/RAGPreviewRoutes.test.ts`
- `RAG_FINALIZATION.md`
- `CHANGED_FILES.md`

## Intentionally untouched

- Frontend code
- Agent routing and unrelated agent tools
- Existing migrations `0001` through `0012`
- Resume export implementation
- Authentication, file storage, and unrelated product services
