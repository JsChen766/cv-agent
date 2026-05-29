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

## Useful Commands

View API logs:

```bash
docker compose logs -f api
```

Enter the API container:

```bash
docker compose exec api sh
```

Restart only backend API:

```bash
docker compose restart api
```

Reset all data (including PostgreSQL volume):

```bash
docker compose down -v
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
- Register server settings:
- Host: `postgres`
- Port: `5432`

## Why These Settings

Why `HOST=0.0.0.0` is required:

- In Docker, the process must listen on all interfaces so traffic from host-to-container port mapping can reach the API.
- `127.0.0.1` inside container only binds loopback in that container, so host requests cannot reach it.

Why container `DATABASE_URL` uses host `postgres` instead of `localhost`:

- In Compose networking, services resolve each other by service name.
- Inside the API container, `localhost` means the API container itself, not the PostgreSQL container.
- `postgres` points to the `postgres` service on the same Compose network.

## Confirm It Is Using PostgreSQL

You can verify API is running in postgres mode via either method:

- Startup log contains `"mode":"postgres"`.
- Health or other API responses include `meta.mode` as `postgres`.
