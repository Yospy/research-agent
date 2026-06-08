package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// streamEnvelope is one NDJSON line from the worker: either a progress "event" (a ping) or the
// final "result" (the verdict, mirroring AgentResult).
type streamEnvelope struct {
	Type  string `json:"type"` // "event" | "result"
	Event struct {
		Kind string `json:"kind"`
	} `json:"event"`
	Result json.RawMessage `json:"result"`
}

// runOneStreaming POSTs a task to the worker and consumes its NDJSON stream.
//
// Liveness: every line resets the idle timer. The task stays alive as long as it keeps emitting
// progress pings; it fails only on (a) idle timeout — went silent for idleTimeout, (b) ctx done —
// the absolute per-attempt deadline or a parent cancel, or (c) a transport error / stream that
// closes without a result line. The final {"type":"result"} line carries the verdict.
//
// Return contract (drives the retry policy):
//   - (resp, nil) → a decoded verdict (SEMANTIC, ok or !ok). Never retried.
//   - (_, err)    → transport / idle / cancel failure (no verdict). Eligible for retry.
//
// onPing is called for each progress line (for ping-counting / observability).
func runOneStreaming(
	ctx context.Context,
	client *http.Client,
	workerURL, kind, task string,
	pass PassContext,
	idleTimeout time.Duration,
	onPing func(kind string),
) (WorkerResponse, error) {
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
		return WorkerResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return WorkerResponse{}, fmt.Errorf("worker status %d: %s", resp.StatusCode, string(raw))
	}

	// Scan lines in a goroutine so the select loop can apply the idle timeout per line.
	// `done` lets the scanner abandon a blocked send when the loop returns early (idle/cancel),
	// otherwise it would park on `lines <- b` forever and leak the goroutine + body + buffer.
	lines := make(chan []byte)
	scanErr := make(chan error, 1)
	done := make(chan struct{})
	defer close(done)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // allow large event lines
		for sc.Scan() {
			b := make([]byte, len(sc.Bytes()))
			copy(b, sc.Bytes())
			select {
			case lines <- b:
			case <-done: // select loop has returned → stop instead of parking forever
				return
			}
		}
		scanErr <- sc.Err()
		close(lines)
	}()

	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()

	for {
		select {
		case <-ctx.Done():
			return WorkerResponse{}, ctx.Err() // absolute deadline or parent cancel

		case <-idle.C:
			return WorkerResponse{}, fmt.Errorf("idle timeout: no progress for %s", idleTimeout)

		case line, ok := <-lines:
			if !ok {
				if e := <-scanErr; e != nil {
					return WorkerResponse{}, e
				}
				return WorkerResponse{}, fmt.Errorf("worker closed stream without a result")
			}
			// A line arrived → reset the idle timer (drain first to avoid the timer footgun).
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(idleTimeout)

			var env streamEnvelope
			if json.Unmarshal(line, &env) != nil {
				continue // ignore an unparseable line
			}
			if env.Type == "result" {
				var wr WorkerResponse
				if err := json.Unmarshal(env.Result, &wr); err != nil {
					return WorkerResponse{}, fmt.Errorf("decode result: %w", err)
				}
				return wr, nil
			}
			if onPing != nil {
				onPing(env.Event.Kind) // a progress event
			}
		}
	}
}
