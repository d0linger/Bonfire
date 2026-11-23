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
RUN CGO_ENABLED=0 go build -trimpath -o /bonfire .

FROM alpine:3.24
WORKDIR /app
COPY --from=server /bonfire /app/bonfire
COPY --from=assets /src/dist /app/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/bonfire"]
