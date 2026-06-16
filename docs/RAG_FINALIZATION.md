# Dual-RAG Backend Finalization

This backend finalizes the two retrieval-grounded modules used by CV Agent:

- **Guideline RAG v2** answers: *How should this resume be written for the target role?*
- **Evidence RAG v5** answers: *What can truthfully be written from the user's verified experience repository?*

The two packs are reconciled by `GroundingContextCoordinator` before resume generation.

## Guideline RAG v2

Key capabilities:

- AI/ML, software, data, product, research, consulting, finance, and general role taxonomy
- bilingual role analysis
- mandatory factual-safety guidelines
- diversified retrieval across rules, role templates, school templates, and safe exemplar patterns
- external guideline/example ingestion service
- conflict resolution where hard factual constraints override style preferences
- complete section strategy, section budgets, retrieval trace, and quality diagnostics

## Evidence RAG v5

Key capabilities:

- atomic JD requirement decomposition
- policy-aware query planning
- bilingual/domain alias expansion
- hybrid claim and experience scoring across exact phrases, structured fields, lexical signals, aliases, category fit, and historical effectiveness
- persistent experience-claim graph
- corrective retrieval when evidence coverage is weak
- evidence quality evaluation and missing-evidence routing
- source-span-grounded claim extraction
- post-generation sentence-to-claim verification
- actual claim and experience provenance per generated variant
- long-term usage/outcome memory without overwriting original generation events
- reindex/backfill support for legacy experiences

## Integrated grounding

`generation.inputSnapshot` now stores:

- `instructionPack`
- `evidencePack`
- `groundingContext`
- `sourceExperienceIds`

The generation model receives coordinated actions per JD requirement:

- `emphasize`
- `conservative_wording`
- `ask_user`
- `omit`
- `alternative_angle`

## Debug and verification APIs

### Preview both RAGs without generating a resume

`POST /product/rag/preview`

```json
{
  "jdText": "Develop LLM and RAG algorithms with Python and PyTorch.",
  "targetRole": "AI Algorithm Engineer Intern"
}
```

The response includes the Instruction Pack, Evidence Pack, coordinated grounding context, and a compact summary.

### Reindex old experiences

`POST /product/rag/evidence/reindex`

```json
{}
```

Use this once after upgrading if existing experiences were created before persistent claim indexing was enabled.

### Record application outcome feedback

`POST /product/rag/evidence/outcome`

```json
{
  "generationId": "pgen-...",
  "outcome": "interview",
  "relatedClaimIds": ["pclaim-..."],
  "relatedExperienceIds": ["pexp-..."]
}
```

## Database migration

Run the normal migration flow. The new migration is:

`src/persistence/postgres/migrations/0013_rag_finalization.sql`

It adds retrieval and analytics indexes only. It does not rewrite migration `0012`.

## Verification performed

- `npm run typecheck`: passed
- RAG, product route, prompt registry, and preview API test subset: **38 tests passed**
- A broad full-suite run showed no failures in all completed suites, but the container command exceeded its execution window before Vitest printed the final aggregate summary.

## Security cleanup

The packaged artifacts exclude:

- `.env`
- `.env.docker`
- `.git`
- `node_modules`

Use `.env.example` or `.env.docker.example` to create local environment files.
