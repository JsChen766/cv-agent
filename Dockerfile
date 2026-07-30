# syntax=docker/dockerfile:1.7

ARG GO_VERSION=1.26.5

FROM golang:${GO_VERSION}-bookworm AS dev

ARG AIR_VERSION=v1.65.1
ARG GOOSE_VERSION=v3.27.3

ENV GOPROXY=https://goproxy.cn,direct

RUN GOBIN=/usr/local/bin go install github.com/air-verse/air@${AIR_VERSION} \
    && GOBIN=/usr/local/bin go install github.com/pressly/goose/v3/cmd/goose@${GOOSE_VERSION}

WORKDIR /workspace
COPY . .

CMD ["air", "-c", ".air.toml"]

FROM golang:${GO_VERSION}-bookworm AS build

ENV GOPROXY=https://goproxy.cn,direct

WORKDIR /src
COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/cv-agent-app-be \
    ./cmd/api

FROM scratch AS production

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/cv-agent-app-be /cv-agent-app-be

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["/cv-agent-app-be"]
