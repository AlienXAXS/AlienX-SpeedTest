# AlienX SpeedTest

A self-hosted, open-source network speed test with a slick dark UI. Supports single and multi-threaded tests, multiple test server locations, and ships as two minimal Docker images published to GHCR.

## Features

- **Speedometer UI** — animated SVG gauge with real-time Mbps readout
- **Download & Upload** tests with live throughput display
- **Ping & Jitter** measurement (12-sample average)
- **1 / 2 / 4 / 8 / 16 threads** — user-selectable concurrency
- **Multi-location** — one web UI can point at many agents (London, NYC, etc.)
- **Results card** — copy-to-clipboard summary
- **Two Docker images** — `web` hosts the frontend, `agent` runs the test server

---

## Quick Start (Docker Compose)

```bash
git clone https://github.com/AlienXAXS/AlienX-SpeedTest.git
cd AlienX-SpeedTest
docker compose up
```

Open **http://localhost:8080** in your browser.  
The agent is exposed on **http://localhost:8081**.

---

## Pull from GHCR

Images are published automatically on every push to `main`.

```bash
# Agent
docker pull ghcr.io/alienxaxs/alienx-speedtest-agent:latest

# Web
docker pull ghcr.io/alienxaxs/alienx-speedtest-web:latest
```

---

## Configuration

### Web container environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_1_NAME` | `Agent 1` | Display name for agent 1 |
| `AGENT_1_URL` | `http://localhost:8081` | **Browser-reachable** URL for agent 1 |
| `AGENT_2_NAME` … `AGENT_5_NAME` | — | Additional agent display names |
| `AGENT_2_URL` … `AGENT_5_URL` | — | Additional agent URLs |

> **Important:** Agent URLs are fetched by the end-user's browser, not by the web container. They must be publicly reachable (or reachable from the user's network).

### Agent container environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_NAME` | `AlienX SpeedTest Agent` | Label returned by `/api/info` |
| `PORT` | `8081` | Listening port |

---

## Multi-Location Example

```yaml
# docker-compose.yml
services:
  agent-london:
    image: ghcr.io/alienxaxs/alienx-speedtest-agent:latest
    ports: ["8081:8081"]
    environment:
      AGENT_NAME: "London"

  agent-nyc:
    image: ghcr.io/alienxaxs/alienx-speedtest-agent:latest
    ports: ["8082:8081"]
    environment:
      AGENT_NAME: "New York"

  web:
    image: ghcr.io/alienxaxs/alienx-speedtest-web:latest
    ports: ["8080:80"]
    environment:
      AGENT_1_NAME: "London"
      AGENT_1_URL: "https://lon.speedtest.example.com"
      AGENT_2_NAME: "New York"
      AGENT_2_URL: "https://nyc.speedtest.example.com"
```

---

## Agent API

| Endpoint | Method | Description |
|---|---|---|
| `/ping` | GET | Returns JSON timestamp for latency measurement |
| `/download?bytes=N` | GET | Streams N bytes of random data (default 25 MB) |
| `/upload` | POST | Accepts body, returns bytes received + duration |
| `/api/info` | GET | Returns agent name and version |

All endpoints include `Access-Control-Allow-Origin: *` for cross-origin browser requests.

---

## Building Locally

```bash
# Agent
cd agent
go build -o agent .
./agent

# Web (static — serve with any HTTP server)
cd web
python3 -m http.server 8080
```

---

## License

MIT
