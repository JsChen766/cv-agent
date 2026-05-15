import type { DocumentInput, DocumentParser } from "./types.js";

export class DocumentParserRegistry {
  private readonly parsers: DocumentParser[] = [];

  public register(parser: DocumentParser): void {
    this.parsers.push(parser);
  }

  public findParser(input: DocumentInput): DocumentParser | null {
    return this.parsers.find((parser) => parser.canParse(input)) ?? null;
  }
}
