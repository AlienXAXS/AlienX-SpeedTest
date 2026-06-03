FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
COPY main.go ./
# -mod=mod allows the build to fetch missing deps and write go.sum automatically
RUN CGO_ENABLED=0 GOOS=linux go build -mod=mod -ldflags="-s -w" -o agent .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=builder /app/agent .
EXPOSE 8081
ENV AGENT_NAME="AlienX SpeedTest Agent" \
    PORT="8081"
ENTRYPOINT ["./agent"]
