package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// runOne POSTs a single task to the worker's /run endpoint.
//
// Return contract (this is the crux of the retry policy):
//   - (resp, nil)  → the worker produced a decodable verdict (SEMANTIC result). Trust it,
//     whether resp.OK is true or false. Never retried.
//   - (_, err)     → TRANSPORT failure: network error, context timeout/cancel, non-2xx
//     status, or an undecodable body. The agent never gave a verdict → eligible for retry.
func runOne(ctx context.Context, client *http.Client, workerURL, kind, task string, pass PassContext) (WorkerResponse, error) {
	body, err := json.Marshal(WorkerRequest{Kind: kind, Task: task, Context: pass})
	if err != nil {
		return WorkerResponse{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, workerURL+"/run", bytes.NewReader(body))
	if err != nil {
		return WorkerResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return WorkerResponse{}, err // network error / timeout / cancellation
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return WorkerResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return WorkerResponse{}, fmt.Errorf("worker status %d: %s", resp.StatusCode, string(raw))
	}

	var wr WorkerResponse
	if err := json.Unmarshal(raw, &wr); err != nil {
		return WorkerResponse{}, fmt.Errorf("decode worker response: %w", err)
	}
	return wr, nil
}
