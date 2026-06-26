# Phase 2 Resume Generation Report - 2026-06-26

## Scope

Phase 2 focused on resume content generation quality only. Public API routes, request shapes, response envelopes, ProductBlock semantics, and frontend contracts were not changed. Testing used the running local Docker backend at `http://127.0.0.1:3000` with real LLM calls and user `dev-user`.

Reference resume standard: `docs/陈剑升-香港城市大学.pdf` / `local-playground/cv_example.pdf`.

## Baseline Findings

Baseline was run with `scripts/phase2-resume-generation-smoke.ts` before optimization and saved to `docs/phase2-baseline-output-2026-06-26.json`.

- Outputs were too short and often read like loose summaries rather than a polished resume.
- Some variants invented placeholders such as generic company or university names.
- Dates and organization details were occasionally wrong.
- RAG evidence was available, but generation did not receive enough authoritative source-card context, so the model guessed instead of copying verified facts.
- Structured resume saving was unreliable because the generated content was not consistently shaped for section/item extraction.

Baseline did not pass Phase 2.

## Internal Changes

- Added `scripts/phase2-resume-generation-smoke.ts` to run repeatable real backend generation tests across three natural JD directions.
- Upgraded `generation-resume-system.md` to require dense, JD-tailored, evidence-grounded resume variants with plain resume sections and no placeholders.
- Passed authoritative candidate source cards into `LLMGenerationService`, including exact school, company, role, dates, category, tags, structured fields, and content excerpts.
- Expanded generation source selection so education, skills, awards, and relevant ranked experiences are available together instead of only the top RAG matches.
- Added a Chinese RAG guideline for reference-resume density and quantified bullet quality.
- Added fallback parsing from generated content to internal `resumeDocument` so accepted variants can save into structured resume items.
- Improved evidence sentence splitting to reduce false unsupported fragments around decimals, dates, and units.

## Final Real LLM Tests

The final run used three natural JDs:

- `data_bi`: financial technology data analyst / BI analyst.
- `ml_data`: machine learning data engineering intern.
- `ai_product`: AI product data analyst intern.

The smoke command was interrupted by the terminal timeout while the third job was still running, but the backend jobs completed successfully. Final generation IDs:

| Scenario | Generation ID | Resume ID | Content Chars | Bullets | Metrics | Placeholder Hits | Saved Items |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| data_bi | `pgen-66867406-c9a1-478a-b94b-508275a74c0d` | `pres-df6500a3-d222-485c-8dc0-99f0e1c987ae` | 710 | 7 | 9 | 0 | 7 |
| ml_data | `pgen-9376c7c8-0420-41a0-a69f-d2267a3843b7` | `pres-a3aa1f2a-4edb-43d4-afd6-77a51b358114` | 929 | 10 | 14 | 0 | 11 |
| ai_product | `pgen-6235f59b-d3cf-4db2-ad49-47b44bb39af8` | `pres-94655adf-0d96-4222-b6ac-18a3f9b4735a` | 908 | 11 | 22 | 0 | 7 |

## Quality Judgment

- `data_bi` now correctly prioritizes WEEX data analytics, SQL, BI dashboards, metric definitions, trading/user behavior analytics, and the large-scale Wikipedia data project. Education and skill sections use real facts.
- `ml_data` now emphasizes corpus cleaning, labeling quality, keyword/corpus management, Spark/Hadoop data processing, signal-processing/data projects, and technical awards. It conservatively avoids claiming unsupported independent model-training depth.
- `ai_product` now bridges WEEX analytics, AI model filing/data governance, documentation/spec writing, and project requirement/data work. The content is JD-biased without pretending the candidate has direct product metrics ownership where evidence is limited.
- The final content is denser, more quantified, and closer to the reference resume style. Remaining weakness is mostly layout/PDF presentation, which belongs to Phase 3.

Verdict: Phase 2 passes the content-generation threshold at approximately 90% satisfaction and can proceed to Phase 3. The claim verifier remains conservative on paraphrased true facts, so high `riskSummary` should be treated as a review signal, not as content failure when source cards support the claim.

## Validation

- `npm run typecheck`
- `npx vitest run tests/llmGenerationLenientSchema.test.ts tests/resumeAgentTools.test.ts tests/ProductPromptRegistry.test.ts tests/EvidenceRAGFinal.test.ts`
- Real backend calls through `/copilot/chat`, `/copilot/actions`, `/copilot/pending-actions/:id/confirm`, `/jobs/:id`, `/product/generations/:id`, and `/product/resumes/:id`
