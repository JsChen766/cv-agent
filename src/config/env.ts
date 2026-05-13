import "dotenv/config";

export type RuntimeEnv = {
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  DEFAULT_PROVIDER: "mock" | "deepseek" | "openrouter";
  DEFAULT_MODEL: string;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): RuntimeEnv {
  const provider = source.DEFAULT_PROVIDER;

  return {
    DEEPSEEK_API_KEY: source.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY,
    DEFAULT_PROVIDER: provider === "deepseek" || provider === "openrouter" ? provider : "mock",
    DEFAULT_MODEL: source.DEFAULT_MODEL ?? "deepseek-v4-pro"
  };
}
