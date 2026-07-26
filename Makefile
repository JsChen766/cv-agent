COMPOSE := docker compose
API_RUN := $(COMPOSE) run --rm --no-deps api
REDOCLY_IMAGE := redocly/cli:2.31.6
APP_REPO ?= ../cv-agent-app

.PHONY: dev up down logs config tidy fmt vet test build check
.PHONY: contract-lint contract-source-check
.PHONY: migrate-status migrate-up migrate-down psql redis-cli

dev:
	$(COMPOSE) up --build

up:
	$(COMPOSE) up --build --detach

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs --follow api

config:
	$(COMPOSE) config --quiet

tidy:
	$(API_RUN) go mod tidy

fmt:
	$(API_RUN) gofmt -w ./cmd ./internal

vet:
	$(API_RUN) go vet ./...

test:
	$(API_RUN) go test -race ./...

build:
	docker build --target production --tag cv-agent-app-be:local .

contract-lint:
	docker run --rm --network none \
		--volume "$(CURDIR):/spec:ro" \
		--workdir /spec \
		$(REDOCLY_IMAGE) lint api/openapi/openapi.yaml

contract-source-check:
	$(COMPOSE) run --rm --no-deps \
		--volume "$(abspath $(APP_REPO)):/app:ro" \
		--volume "$(CURDIR)/contracts/app-v1/source-manifest.sha256:/contract-source.sha256:ro" \
		--workdir /app \
		--entrypoint sha256sum \
		api --check /contract-source.sha256

check:
	$(MAKE) contract-lint
	$(API_RUN) sh -ec 'test -z "$$(gofmt -l ./cmd ./internal)"'
	$(API_RUN) go vet ./...
	$(API_RUN) go build ./...
	$(API_RUN) ./scripts/check-file-lines.sh
	$(COMPOSE) config --quiet

migrate-status:
	$(COMPOSE) run --rm migrate status

migrate-up:
	$(COMPOSE) run --rm migrate up

migrate-down:
	$(COMPOSE) run --rm migrate down

psql:
	$(COMPOSE) exec postgres psql -U "$${POSTGRES_USER:-cv_agent}" -d "$${POSTGRES_DB:-cv_agent}"

redis-cli:
	$(COMPOSE) exec redis redis-cli
