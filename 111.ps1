$path = "src/product/services/index.ts"
$text = Get-Content $path -Raw

$start = $text.IndexOf("export type ProductServices = {")
if ($start -lt 0) {
  throw "Cannot find ProductServices start marker."
}

$tailMarker = "`r`n`r`n  ProductImportCandidate,"
$end = $text.IndexOf($tailMarker, $start)

if ($end -lt 0) {
  $tailMarker = "`n`n  ProductImportCandidate,"
  $end = $text.IndexOf($tailMarker, $start)
}

if ($end -lt 0) {
  $end = $text.Length
}

$body = $text.Substring($start, $end - $start)

$header = @'
import { randomUUID } from "node:crypto";
import type {
  ProductExperience,
  ProductExperienceCategory,
  ProductExperienceRevision,
  ProductExperienceVariant,
  ProductGeneration,
  ProductGeneratedVariant,
  ProductExperienceSummary,
  ProductImportCandidate,
  ProductImportJob,
  ProductJDRecord,
  ProductResume,
  ProductResumeDetail,
  ProductResumeItem,
} from "../types.js";
import { extractExperienceDraftFromText } from "../experienceDraft.js";
import type { LLMExperienceExtractor } from "../LLMExperienceExtractor.js";
import { extractedCandidateToDraft } from "../LLMExperienceExtractor.js";
import { LLMGenerationError, type LLMGenerationService } from "../LLMGenerationService.js";
import type { EvidenceRAGService, EvidencePack, ClaimGraphIndexer } from "../../rag/evidence/index.js";
import { isDeterministicFallbackAllowed } from "../deterministicFallbackGuard.js";
import type {
  ProductExperienceRepository,
  ProductGenerationRepository,
  ProductImportRepository,
  ProductJDRepository,
  ProductResumeRepository,
} from "../repositories/index.js";

'@

Set-Content -Path $path -Value ($header + $body) -Encoding utf8