export class JsonParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = "JsonParseError";
  }
}
