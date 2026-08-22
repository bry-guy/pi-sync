FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/pi-syncd ./cmd/pi-syncd

FROM alpine:3.22
RUN addgroup -S -g 1000 pi-sync && adduser -S -D -H -u 1000 -G pi-sync pi-sync
COPY --from=build /out/pi-syncd /usr/local/bin/pi-syncd
ENV PI_SYNC_LISTEN=0.0.0.0:8080 \
    PI_SYNC_DATA_DIR=/data
RUN mkdir -p /data && chown -R pi-sync:pi-sync /data
VOLUME ["/data"]
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/pi-syncd"]
