# Contract Security Matrix Test Results

- Test time: 2026-07-07 23:40 Asia/Hong_Kong
- Scope: contract and security matrix only. This is separate from the live interface availability mainline in `docs/backend-live-interface-test-results-2026-07-07.md`.
- Runtime for live matrix: temporary uvicorn on `http://127.0.0.1:8001`, current working tree, Docker PostgreSQL `cv-be-postgres-1`.
- LLM note: this matrix intentionally avoided LLM-generating success paths; it validates auth, ownership, request validation, and pagination contracts.

## Automated Pytest Matrix

| Check | Result | Evidence |
|---|---|---|
| Protected endpoints reject unauthenticated calls | PASS | Covered all authenticated route families: users, files, experiences, import candidates, JDs, resumes, artifacts, copilot, threads. |
| Cross-user product resource access | PASS | Foreign resources return `404` for product/file/preference resources. |
| Cross-user thread access | PASS | Foreign threads return `403`, including `discard`. |
| Field validation boundaries | PASS | Empty required strings, invalid enums, extra fields, negative numeric values, empty reorder lists, invalid action payloads, and invalid thread cursor return `422`. |
| Pagination cursor/limit combinations | PASS | Product list endpoints accept supported cursor strings; thread list accepts ISO datetime cursor; all list endpoints reject `limit=0` and `limit=101`. |

Command:

```powershell
.\.venv\Scripts\python.exe -m pytest tests\api\test_contract_security_matrix.py -q
```

Result: `111 passed, 1 existing Starlette/httpx deprecation warning`.

## Live HTTP / DB Matrix

| Check | Result | Evidence |
|---|---|---|
| Matrix setup | PASS | Created real users `user-d49e8d11-3447-4caf-b99d-531360af6a6f` and `user-57d42115-3740-44db-993b-b66e8512e0be`. |
| Protected endpoints unauthenticated | PASS | All protected endpoints returned `401`. |
| Cross-user access | PASS | Product/file/preference foreign resources returned `404`; thread foreign operations returned `403`. |
| Field validation | PASS | Invalid body/query cases returned `422`. |
| Pagination | PASS | Supported combinations returned `200`; invalid limits and invalid thread cursor returned `422`. |

Live matrix summary:

```json
{
  "base_url": "http://127.0.0.1:8001",
  "total": 111,
  "passed": 111,
  "failed": 0
}
```

## Static / Regression Checks

| Check | Result |
|---|---|
| Full mypy app | PASS: `Success: no issues found in 128 source files` |
| Full pytest | PASS: `172 passed, 1 existing Starlette/httpx deprecation warning` |
