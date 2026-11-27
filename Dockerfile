FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS assets
WORKDIR /src
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY build.mjs ./
COPY web ./web
RUN npm run build

FROM golang:1.27.4-alpine3.24@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY migrations ./migrations
ARG BONFIRE_COVER=false
RUN CGO_ENABLED=0 go build -cover=$BONFIRE_COVER -trimpath -o /bonfire .

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS backup-worker
RUN apk add --no-cache postgresql18-client tzdata ca-certificates
WORKDIR /app
COPY --from=server /bonfire /app/bonfire
RUN mkdir -p /var/lib/bonfire-backup /var/lib/bonfire-key /run/bonfire-backup && chown -R 65532:65532 /var/lib/bonfire-backup /var/lib/bonfire-key /run/bonfire-backup
USER 65532:65532
ENTRYPOINT ["/app/bonfire", "backup-worker"]

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS app
WORKDIR /app
RUN apk add --no-cache libstdc++ libatomic
RUN install -d -m 0700 -o 65532 -g 65532 /run/bonfire-totp && mkdir -p /run/bonfire-backup && chown 65532:65532 /run/bonfire-backup
COPY --from=server /bonfire /app/bonfire
COPY --from=assets /src/dist /app/dist
COPY --from=assets /usr/local/bin/node /usr/local/bin/node
COPY --from=assets /src/render-original.cjs /app/render-original.cjs
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/bonfire"]
