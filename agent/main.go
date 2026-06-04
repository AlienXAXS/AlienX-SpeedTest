package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

const version = "1.0.0"

// 1 MB of random data reused for all download/WS-download responses
var randBuf [1024 * 1024]byte

func init() {
	if _, err := rand.Read(randBuf[:]); err != nil {
		log.Fatal("failed to seed random buffer:", err)
	}
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 * 1024,
	WriteBufferSize: 64 * 1024,
	// Allow all origins — the web UI may be hosted on a different domain
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ─── CORS middleware ──────────────────────────────────────────────────────────
func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, Cache-Control, Pragma")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// ─── HTTP endpoints ───────────────────────────────────────────────────────────

func handlePing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"timestamp": time.Now().UnixMilli(),
		"pong":      true,
	})
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	total := int64(25 * 1024 * 1024)
	if s := r.URL.Query().Get("bytes"); s != "" {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
			total = n
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(total, 10))

	bufLen := int64(len(randBuf))
	written := int64(0)
	for written < total {
		chunk := bufLen
		if rem := total - written; rem < chunk {
			chunk = rem
		}
		n, err := w.Write(randBuf[:chunk])
		written += int64(n)
		if err != nil {
			return
		}
	}
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	n, err := io.Copy(io.Discard, r.Body)
	elapsed := time.Since(start)
	if err != nil && err != io.EOF {
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"received":    n,
		"duration_ms": elapsed.Milliseconds(),
	})
}

func handleInfo(agentName string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"name":    agentName,
			"version": version,
		})
	}
}

// ─── WebSocket: download ──────────────────────────────────────────────────────
// Server streams binary frames continuously until the client disconnects.
func handleWSDownload(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// Ignore client messages (close frames handled automatically by gorilla)
	conn.SetReadLimit(512)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Target ~100 Mbps per connection by pacing frames.
	// Without pacing, loopback connections can push many Gbps, saturating the
	// browser's JS thread and causing other tabs to stutter.
	const targetBytesPerSec = 100 * 1024 * 1024 // 100 MB/s = ~800 Mbps
	frameSize := int64(len(randBuf))
	sleepPerFrame := time.Duration(float64(time.Second) * float64(frameSize) / float64(targetBytesPerSec))

	for {
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, randBuf[:]); err != nil {
			return
		}
		time.Sleep(sleepPerFrame)
	}
}

// ─── WebSocket: upload ────────────────────────────────────────────────────────
// Client sends binary frames; server ACKs every frame with {"received":N}.
// Measuring from ACKs gives the browser origin-accurate throughput, bypassing
// any reverse-proxy (e.g. Cloudflare) upload buffering.
func handleWSUpload(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	received := int64(0)
	ack := make([]byte, 0, 32)

	for {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType == websocket.BinaryMessage {
			received += int64(len(data))
			ack = fmt.Appendf(ack[:0], `{"received":%d}`, received)
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, ack); err != nil {
				return
			}
		}
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
func main() {
	agentName := os.Getenv("AGENT_NAME")
	if agentName == "" {
		agentName = "AlienX SpeedTest Agent"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	mux := http.NewServeMux()

	// HTTP endpoints (kept for non-WebSocket fallback / direct use)
	mux.HandleFunc("/ping", cors(handlePing))
	mux.HandleFunc("/download", cors(handleDownload))
	mux.HandleFunc("/upload", cors(handleUpload))
	mux.HandleFunc("/api/info", cors(handleInfo(agentName)))

	// WebSocket endpoints
	mux.HandleFunc("/ws/download", cors(handleWSDownload))
	mux.HandleFunc("/ws/upload", cors(handleWSUpload))

	addr := fmt.Sprintf(":%s", port)
	log.Printf("AlienX SpeedTest Agent [%s] v%s — listening on %s", agentName, version, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
