# Docker Local Dev

## Quick Start

First-time setup:

```bash
cp .env.docker.example .env.docker
docker compose up --build
```

Later starts:

```bash
docker compose up
```

Run in background:

```bash
docker compose up -d
```

If you also want pgAdmin (it is in the `tools` profile), run:

```bash
docker compose --profile tools up -d
```

## Hot Reload And Restart Rules

What happens after changes:

- Change TypeScript source (`src/**/*.ts`): API auto-restarts inside container via `tsx watch` (`npm run dev:api:watch`).
- Compose sets `CHOKIDAR_USEPOLLING=true` for Docker Desktop bind mounts, so file changes are detected more reliably.
- Change `.env.docker`: Docker does not hot-reload env files. You must recreate API container with `docker compose up -d --force-recreate api`.
- Change `docker-compose.yml`: recreate service with `docker compose up -d --force-recreate api`.
- Change `Dockerfile.dev` or package dependencies (`package.json` / lockfile): rebuild service with `docker compose up -d --build api`.
- If rebuild cache causes issues: run `docker compose build --no-cache api` then `docker compose up -d api`.
- Avoid duplicate env keys (for example two `AUTH_MODE=` lines). The later value can override earlier values and cause confusing auth behavior.

## Dev Auth (`AUTH_MODE=dev_header`)

Default Docker local auth mode is `dev_header`. Requests must include header:

```http
x-user-id: dev-user
```

Without this header, API returns `401 UNAUTHORIZED` with a clear JSON error (not a 500).

`curl` with header:

```bash
curl -H "x-user-id: dev-user" http://localhost:3000/product/experiences
```

`curl` without header (expected auth error):

```bash
curl http://localhost:3000/product/experiences
```

### Frontend Integration (Recommended)

For frontend local dev (H5), set these in `cv_agent_frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:3000
VITE_AUTH_MODE=dev_header
VITE_AUTH_HEADER_NAME=x-user-id
VITE_AUTH_HEADER_VALUE=dev-user
VITE_ENABLE_DEV_LOGIN=false
```

With these settings:
- Every API request automatically includes `x-user-id: dev-user` header.
- The `/auth/dev-login` endpoint is **not** called — authentication happens via the header on every request.
- No cookies or CORS `withCredentials` needed.

### Troubleshooting Cookie / dev-login Mismatches

If the frontend repeatedly shows "Dev login" button or you see `ERR_EMPTY_RESPONSE`:

1. **Check API container logs**: `docker compose logs --tail=50 api`
2. **Verify the API is listening**: `curl -i http://localhost:3000/health`
3. **Verify auth mode**: Check `.env.docker` has `AUTH_MODE=dev_header`
4. **Verify frontend config**: Check `.env` has `VITE_AUTH_MODE=dev_header` and `VITE_AUTH_HEADER_VALUE=dev-user`
5. **Restart API after config changes**: `docker compose up -d --force-recreate api`

### Common Pitfalls

| Symptom | Likely Cause | Fix |
|---|---|---|
| `ERR_EMPTY_RESPONSE` | Backend container crashed on startup (e.g., migration error) | Check `docker compose logs api` for startup errors |
| `401` on every request | `x-user-id` header not sent | Verify frontend `.env` has `VITE_AUTH_HEADER_VALUE=dev-user` |
| Infinite "Dev login" redirect | Frontend in cookie mode but backend in dev_header mode | Set `VITE_AUTH_MODE=dev_header` and `VITE_ENABLE_DEV_LOGIN=false` in frontend |
| Preflight OPTIONS fails with ERR_EMPTY_RESPONSE | Same as above — container not responding | Fix container startup first |

## Self-Check Commands

Start:

```bash
docker compose up -d --build
```

View API logs:

```bash
docker compose logs -f api
```

Verify Postgres mode:

- API startup logs should contain `"mode":"postgres"`.

Test API with dev header:

```bash
curl -H "x-user-id: dev-user" http://localhost:3000/product/experiences
```

Test API without dev header (should return auth error):

```bash
curl http://localhost:3000/product/experiences
```

Enter PostgreSQL shell:

```bash
docker compose exec postgres psql -U coolto -d coolto_agent
```

Reset database and volumes:

```bash
docker compose down -v
```

## Useful Commands

Enter API container:

```bash
docker compose exec api sh
```

Restart only backend API:

```bash
docker compose restart api
```

## Connection Info

PostgreSQL:

- Host: `localhost`
- Port: `5432`
- Database: `coolto_agent`
- User: `coolto`
- Password: `coolto_dev_password`

API:

- `http://localhost:3000`

pgAdmin:

- URL: `http://localhost:5050`
- Login: `admin@coolto.local` / `admin`
- Register server host: `postgres`
- Register server port: `5432`

## Why These Settings

Why `HOST=0.0.0.0` is required:

- In Docker, the process must listen on all interfaces so host-to-container port mapping can reach the API.
- `127.0.0.1` inside container only binds loopback inside that container.

Why container `DATABASE_URL` uses `postgres` instead of `localhost`:

- Compose services resolve each other by service name.
- Inside API container, `localhost` points to the API container itself, not PostgreSQL.
- `postgres` points to the PostgreSQL service on the Compose network.
