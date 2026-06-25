# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript backend for the Coolto/CV agent runtime. Core code lives under `src/`: API entrypoints are in `src/api`, agent runtime/domain logic is in `src/agent-core`, `src/agent-domains`, and `src/agent-tools`, and product persistence/services are under `src/product`, `src/persistence`, and `src/infrastructure`. Tests live in `tests/**/*.test.ts`, with shared helpers such as `tests/p12Helpers.ts`. Scripts are in `scripts/`, architecture notes are in `docs/`, and local runtime data may be stored in `.data/`. The Vite React client in `frontend/` is a nested project with its own `package.json`.

## Build, Test, and Development Commands

- `npm run dev:api` starts the API from `src/api/server.ts`.
- `npm run dev:api:watch` runs the API in watch mode.
- `npm run typecheck` runs `tsc --noEmit` for `src`, `tests`, and config files.
- `npm test` runs the Vitest suite once.
- `npm run debug:flow` runs `scripts/debug-generate-export-flow.ts`.
- `docker compose up -d --build api` starts the local API and Postgres stack.
- `cd frontend && npm run dev` starts the nested Vite client; `npm run build` typechecks and builds it.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and `.js` import suffixes for local TS files, matching the `NodeNext` setup. Prefer two-space indentation, `const` by default, explicit exported types, and narrow interfaces at API/tool boundaries. File names are generally PascalCase for classes/services and camelCase for helpers. Keep public route schemas, product block shapes, and agent/tool contracts additive unless explicitly changed.

## Testing Guidelines

Vitest is the test framework; tests should be named `*.test.ts` and placed in `tests/`. Add focused tests for changed `/copilot/*`, product service, routing, persistence, or schema behavior. Run `npm run typecheck` and `npm test` before reporting backend changes as complete. Tests should not require real Postgres or real LLM credentials by default.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, often Conventional Commit style such as `feat: ...` or `feat(phase 8): ...`; follow that pattern and keep the scope clear. PRs should include behavior changes, validation commands, linked issue or phase doc when relevant, and screenshots or API examples for frontend/API contract changes.

## Security & Configuration Tips

Copy from `.env.example` or `.env.docker.example`; do not commit secrets from `.env`. Keep debug routes, raw provider payloads, system prompts, chain-of-thought, API keys, and internal tool arguments out of user-facing responses and logs. User identity must come through `AuthResolver`, not request body fields.

## Agent Capability Optimization Principles

For capability-quality work, keep changes inside agent internals: prompts, tools, RAG/evidence, preference/self-evolution, generation, critic, fit, and export services. Do not change public API contracts, response envelopes, ProductBlock semantics, or frontend expectations unless explicitly requested. Preserve existing RAG, self-evolution, critic, and resume parsing capabilities while improving quality; prefer existing extension points over adding logic to `AgentOrchestrator`.

Quality phases must be gated by real Docker backend calls with a configured LLM. For JD matching, resume generation, and PDF export work, run the real `/copilot/chat` or export flow, inspect the output strictly, and continue iterating in the current phase until the result is good enough. Use `docs/agent-quality-optimization-plan.md` as the standing roadmap.
