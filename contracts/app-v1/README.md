# APP v1 access and asset migration fixtures

Status: migration reference snapshot extracted on 2026-07-26.

These files capture the wire contract consumed by the current desktop APP. They
are not examples for LLM, Agent, Prompt, Tool, conversation, rendering,
ResumeWorkspace or checkpoint APIs.

## Authority

The source of truth is the current APP runtime code, in this order:

1. `cv-agent-app/src/api/api-transport.ts` for envelopes, cookie transport and errors;
2. resource API adapters for paths, methods, query parameters and request bodies;
3. runtime normalizers for response required/null/enum behavior;
4. shared TypeScript types for nested persisted documents;
5. existing APP API tests for representative wire values.

`source-manifest.json` records the exact SHA-256 values used for this extraction.
`make contract-source-check` verifies them against `APP_REPO` (default:
`../cv-agent-app`) entirely inside Docker. When one changes, the OpenAPI diff and
fixtures require review.

## Current wire conventions

- request bodies for Experience and JD retain their existing snake_case fields;
- top-level response assets retain camelCase;
- Resume `structured`, score, evidence and observation nested conventions remain mixed;
- response envelopes remain `{success,data,request_id?}` or `{success:false,error?,request_id?}`;
- login must return an `access_token` cookie whose token matches `[A-Za-z0-9._~-]+`;
- changing these conventions requires updating the APP adapter at the same time;
- fixtures contain synthetic data only.

These fixtures are not a permanent compatibility gate and do not override the
four business capabilities defined in `docs/architecture/08-business-capability-baseline.md`.

## Coverage

- `auth/`: development login, session restore result and logout;
- `profile/`: the strict profile shape read by `normalizeUserProfile`;
- `experience/`: list, detail and snake_case create body;
- `jd/`: list, detail and snake_case create body;
- `resume/`: list, full detail, publication, rename and archive bodies;
- `error/`: the stable error envelope read by `CooltoApiError`.

The machine-readable contract entry point is `api/openapi/openapi.yaml`.
