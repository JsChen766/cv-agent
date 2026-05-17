import type { CopilotChatRequest } from "./types.js";

export type ProductIntent =
  | "add_experience"
  | "edit_experience"
  | "list_experiences"
  | "import_resume"
  | "confirm_import_candidate"
  | "save_jd"
  | "list_jds"
  | "generate_resume_for_jd"
  | "save_variant_to_resume"
  | "list_resumes"
  | "open_resume"
  | "update_resume_item"
  | "export_resume_pdf"
  | "unknown";

export type ProductIntentDecision = {
  intent: ProductIntent;
  confidence: number;
};

export class ProductIntentRouter {
  public route(body: CopilotChatRequest): ProductIntentDecision {
    const message = body.message.toLowerCase();
    const original = body.message;

    if (contains(original, ["查看经历库", "我的经历", "经历列表"]) || message.includes("experiences")) {
      return { intent: "list_experiences", confidence: 0.95 };
    }
    if (contains(original, ["保存这段经历", "加入经历库", "添加经历"]) || message.includes("add experience")) {
      return { intent: "add_experience", confidence: 0.9 };
    }
    if (contains(original, ["这是我的简历", "导入简历"]) || message.includes("import resume") || (body.resumeText && body.resumeText.length > 120 && !body.jdText)) {
      return { intent: "import_resume", confidence: 0.85 };
    }
    const asksToGenerate = contains(original, ["生成简历", "根据JD", "根据 JD", "投递", "改写"]) || message.includes("generate");
    if (!asksToGenerate && (contains(original, ["保存JD", "保存 JD", "这个JD", "这个 JD", "岗位描述"]) || message.includes("save jd"))) {
      return { intent: "save_jd", confidence: 0.85 };
    }
    if (contains(original, ["历史简历", "之前生成", "简历列表"]) || message.includes("resumes")) {
      return { intent: "list_resumes", confidence: 0.95 };
    }
    if ((contains(original, ["保存这个版本", "采用这个版本"]) || message.includes("save this version")) && body.clientState?.activeVariantId) {
      return { intent: "save_variant_to_resume", confidence: 0.8 };
    }
    if (asksToGenerate) {
      return { intent: "generate_resume_for_jd", confidence: 0.95 };
    }
    if (contains(original, ["查看 JD", "JD 列表", "历史 JD"]) || message.includes("list jds")) {
      return { intent: "list_jds", confidence: 0.8 };
    }
    return { intent: "unknown", confidence: 0 };
  }
}

function contains(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}
