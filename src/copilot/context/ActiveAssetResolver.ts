import type { ActiveAssetContext } from "../ActiveAssetContextBuilder.js";

export function activeJDText(activeAssetContext: ActiveAssetContext | undefined): string | undefined {
  return text(activeAssetContext?.activeJD?.rawTextPreview);
}

export function activeExperienceText(activeAssetContext: ActiveAssetContext | undefined): string | undefined {
  return text(activeAssetContext?.activeExperience?.contentPreview);
}

export function activeResumeItemText(activeAssetContext: ActiveAssetContext | undefined): string | undefined {
  return text(activeAssetContext?.activeResume?.selectedItem?.contentPreview);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
