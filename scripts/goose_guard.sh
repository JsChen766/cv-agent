#!/bin/sh
# goose_guard.sh — prevent destructive dev-only migrations from touching
# staging/production databases. Invoked as the migrate service entrypoint so
# bypassing "make" alone is not sufficient.
set -eu

if [ "${GOOSE_MIGRATION_DIR:-migrations}" = "migrations-dev" ]; then
    env=${APP_ENV:-local}
    case "$env" in
        local|test) ;;
        *)
            echo "goose_guard: dev migrations are forbidden when APP_ENV='${env}'" >&2
            exit 1
            ;;
    esac

    dsn=${GOOSE_DBSTRING:-${DATABASE_URL:-}}
    if [ -z "$dsn" ]; then
        echo "goose_guard: DATABASE_URL is required" >&2
        exit 1
    fi
    host=$(printf '%s' "$dsn" | sed -n 's|.*@\([^:/]*\).*|\1|p')
    if [ -z "$host" ]; then
        echo "goose_guard: unable to parse database host from DSN" >&2
        exit 1
    fi
    case "$host" in
        postgres|localhost|127.0.0.1|::1) ;;
        *)
            echo "goose_guard: dev migrations refuse to run against host '${host}'" >&2
            exit 1
            ;;
    esac
fi

exec goose "$@"
