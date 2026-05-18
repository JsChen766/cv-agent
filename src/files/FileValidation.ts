import { ApiError, ErrorCodes } from "../api/errors.js";
import { readPlatformConfig } from "../platform/config.js";

export function assertFileUploadEnabled(): void {
  if (!readPlatformConfig().fileUploadEnabled) {
    throw new ApiError(ErrorCodes.FORBIDDEN, "File upload is disabled.", 403);
  }
}

export function validateFile(input: { originalName: string; mimeType: string; sizeBytes: number }): void {
  const config = readPlatformConfig();
  const maxBytes = config.fileMaxSizeMb * 1024 * 1024;
  if (input.sizeBytes <= 0) throw new ApiError(ErrorCodes.INVALID_BODY, "Uploaded file is empty.", 400);
  if (input.sizeBytes > maxBytes) throw new ApiError(ErrorCodes.INVALID_BODY, "Uploaded file exceeds the size limit.", 400);
  if (!allowedMimeTypes(config).includes(input.mimeType)) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "Unsupported file type.", 400);
  }
  const extension = input.originalName.toLowerCase().split(".").pop() ?? "";
  if (input.mimeType === "application/pdf" && extension !== "pdf") throw new ApiError(ErrorCodes.INVALID_BODY, "PDF files must use .pdf extension.", 400);
  if (input.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && extension !== "docx") throw new ApiError(ErrorCodes.INVALID_BODY, "DOCX files must use .docx extension.", 400);
}

export function sourceTypeForMime(mimeType: string): "pdf" | "docx" | "text" {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  return "text";
}

function allowedMimeTypes(config: ReturnType<typeof readPlatformConfig>): string[] {
  return config.fileAllowedMimeTypes
    .split(",")
    .map((item: string) => item.trim())
    .filter(Boolean);
}
