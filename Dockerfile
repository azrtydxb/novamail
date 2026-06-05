# Multi-stage, multi-arch (arm64 on kw, amd64 supported), distroless, non-root.
# Build a single data-plane service via the SERVICE build-arg:
#   docker build --build-arg SERVICE=ingress .
ARG GO_VERSION=1.23

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION} AS build
ARG SERVICE=ingress
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO off for a static binary that runs on distroless.
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /out/app ./cmd/${SERVICE}

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/app /app
# Default body-store mount point (overridden by Helm to the RWX volume path).
USER nonroot:nonroot
EXPOSE 2525 8080
ENTRYPOINT ["/app"]
