import type { ProductResumeDetail } from "../product/types.js";
import type { ResumeTemplate } from "./templates/defaultTemplate.js";
import { defaultTemplate } from "./templates/defaultTemplate.js";

export class ResumeHtmlRenderer {
  private readonly templates = new Map<string, ResumeTemplate>();

  public constructor() {
    this.register(defaultTemplate());
  }

  public register(template: ResumeTemplate): void {
    this.templates.set(template.id, template);
  }

  public render(resume: ProductResumeDetail, templateId?: string): string {
    const template = this.templates.get(templateId ?? "default") ?? this.templates.get("default");
    if (!template) throw new Error("No resume template available.");
    return template.render({ resume });
  }

  public listTemplateIds(): string[] {
    return Array.from(this.templates.keys());
  }
}
