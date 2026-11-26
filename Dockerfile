FROM node:22-alpine AS assets
WORKDIR /src
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY build.mjs ./
COPY web ./web
RUN npm run build

FROM golang:1.27.4-alpine3.24 AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY migrations ./migrations
ARG BONFIRE_COVER=false
RUN CGO_ENABLED=0 go build -cover=$BONFIRE_COVER -trimpath -o /bonfire .

FROM alpine:3.24 AS backup-worker
RUN apk add --no-cache postgresql18-client tzdata ca-certificates
WORKDIR /app
COPY --from=server /bonfire /app/bonfire
RUN mkdir -p /var/lib/bonfire-backup /var/lib/bonfire-key /run/bonfire-backup && chown -R 65532:65532 /var/lib/bonfire-backup /var/lib/bonfire-key /run/bonfire-backup
USER 65532:65532
ENTRYPOINT ["/app/bonfire", "backup-worker"]

FROM alpine:3.24 AS app
WORKDIR /app
RUN mkdir -p /run/bonfire-backup && chown 65532:65532 /run/bonfire-backup
COPY --from=server /bonfire /app/bonfire
COPY --from=assets /src/dist /app/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/bonfire"]
