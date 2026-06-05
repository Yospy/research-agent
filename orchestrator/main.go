package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

// Orchestrator: a small, stateless control plane that fans sub-agent work out to the Node
// worker. Two processes by design — run this binary, configure its address as ORCHESTRATOR_URL
// on the Node side. No LLM, no DB, no domain logic.
func main() {
	port := getenv("PORT", "8787")
	workerURL := getenv("WORKER_URL", "http://localhost:8788")

	// No client-level timeout: each task gets its own per-attempt deadline via context.
	client := &http.Client{}

	mux := http.NewServeMux()

	mux.HandleFunc("/orchestrate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req OrchestrateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
			return
		}
		resp := Orchestrate(r.Context(), client, workerURL, req)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			log.Printf("encode response: %v", err)
		}
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("orchestrator listening on :%s (worker=%s)", port, workerURL)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
