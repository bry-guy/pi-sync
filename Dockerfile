FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/pi-syncd ./cmd/pi-syncd

FROM alpine:3.22
RUN addgroup -S -g 10001 pi-sync && adduser -S -D -H -u 10001 -G pi-sync pi-sync
COPY --from=build /out/pi-syncd /usr/local/bin/pi-syncd
ENV PI_SYNC_LISTEN=0.0.0.0:8787 \
    PI_SYNC_DATA_DIR=/var/lib/pi-sync
RUN mkdir -p /var/lib/pi-sync && chown -R pi-sync:pi-sync /var/lib/pi-sync
VOLUME ["/var/lib/pi-sync"]
USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/pi-syncd"]
