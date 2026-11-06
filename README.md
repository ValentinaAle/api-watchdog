# API Watchdog

Reliable API monitoring, beginning with a secure and testable local foundation.

## Prerequisites

- Docker Desktop (macOS/Windows) or Docker Engine with Compose plugin (Linux)
- Node.js 24+ and Corepack-enabled pnpm 11+

On Windows, use Docker Desktop with WSL 2 and run commands from a WSL terminal for best file-watching performance. Use `Copy-Item .env.example .env` instead of `cp` in PowerShell.

## Start locally

```sh
cp .env.example .env
corepack enable
pnpm install
docker compose up --build
```

The web app is at http://localhost:3000, its health endpoint is http://localhost:3000/api/health, and Mailpit is at http://localhost:8025.

In a separate terminal, apply the initial schema after Postgres is healthy:

```sh
docker compose exec app pnpm --filter @api-watchdog/database generate
docker compose exec app pnpm --filter @api-watchdog/database exec prisma migrate deploy --schema prisma/schema.prisma
```

## Test and stop

```sh
pnpm test
pnpm test:e2e
docker compose down
```

`docker compose down -v` also removes local Postgres data.

## Services

- `app`: Next.js development server with hot reload.
- `worker`: compiled BullMQ job consumer.
- `scheduler`: compiled BullMQ producer, independently scheduled.
- `postgres`, `redis`, and `mailpit`: local infrastructure.

## Security note

This foundation does not run user-supplied HTTP requests. Before monitors are implemented, the SSRF-safe transport design must be reviewed and tested.
