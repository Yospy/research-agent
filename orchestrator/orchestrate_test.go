package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWorker stands in for the Node /run endpoint so the control plane is testable with no
// network, no LLM, no DB — pure determinism checks.
func fakeWorker(handler func(WorkerRequest) (WorkerResponse, int)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req WorkerRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		resp, status := handler(req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

// Results must be input-ordered even when tasks finish out of order.
func TestOrdering(t *testing.T) {
	delays := map[string]time.Duration{"q0": 60 * time.Millisecond, "q1": 30 * time.Millisecond, "q2": 5 * time.Millisecond}
	srv := fakeWorker(func(req WorkerRequest) (WorkerResponse, int) {
		time.Sleep(delays[req.Task]) // q0 finishes last, q2 first
		return WorkerResponse{OK: true, AgentID: "a-" + req.Task, Summary: "ans:" + req.Task}, 200
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q0", "q1", "q2"}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	for i, want := range []string{"ans:q0", "ans:q1", "ans:q2"} {
		if resp.Results[i].Summary != want {
			t.Fatalf("result[%d] = %q, want %q", i, resp.Results[i].Summary, want)
		}
	}
}

// Concurrency must never exceed MaxConcurrency.
func TestConcurrencyCap(t *testing.T) {
	var inFlight, maxSeen int32
	srv := fakeWorker(func(req WorkerRequest) (WorkerResponse, int) {
		n := atomic.AddInt32(&inFlight, 1)
		for {
			old := atomic.LoadInt32(&maxSeen)
			if n <= old || atomic.CompareAndSwapInt32(&maxSeen, old, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&inFlight, -1)
		return WorkerResponse{OK: true, Summary: "x"}, 200
	})
	defer srv.Close()

	tasks := make([]string, 10)
	for i := range tasks {
		tasks[i] = "q"
	}
	req := OrchestrateRequest{Kind: "researcher", Tasks: tasks, Policy: &Policy{MaxConcurrency: 2, PerTaskTimeoutMs: 5000, RetryBudget: 0}}
	Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	if maxSeen > 2 {
		t.Fatalf("max concurrent = %d, want <= 2", maxSeen)
	}
}

// A per-task timeout surfaces as a retryable failure.
func TestTimeoutRetryable(t *testing.T) {
	srv := fakeWorker(func(req WorkerRequest) (WorkerResponse, int) {
		time.Sleep(200 * time.Millisecond) // longer than the deadline below
		return WorkerResponse{OK: true, Summary: "late"}, 200
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, PerTaskTimeoutMs: 30, RetryBudget: 0}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	r := resp.Results[0]
	if r.OK || r.Error == nil || !r.Error.Retryable {
		t.Fatalf("want failed+retryable, got %+v", r)
	}
}

// Transport failure (non-2xx) is retried; success on the retry wins.
func TestTransportRetriedThenSuccess(t *testing.T) {
	var calls int32
	srv := fakeWorker(func(req WorkerRequest) (WorkerResponse, int) {
		if atomic.AddInt32(&calls, 1) == 1 {
			return WorkerResponse{}, 500 // transport failure on first attempt
		}
		return WorkerResponse{OK: true, Summary: "ok"}, 200
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, PerTaskTimeoutMs: 5000, RetryBudget: 1}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	if !resp.Results[0].OK {
		t.Fatalf("want success after retry, got %+v", resp.Results[0])
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("want 2 calls (initial + 1 retry), got %d", got)
	}
}

// Transport failure on every attempt → exactly RetryBudget+1 calls, then retryable error.
func TestTransportAllFailRetryable(t *testing.T) {
	var calls int32
	srv := fakeWorker(func(req WorkerRequest) (WorkerResponse, int) {
		atomic.AddInt32(&calls, 1)
		return WorkerResponse{}, 503
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, PerTaskTimeoutMs: 5000, RetryBudget: 1}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	r := resp.Results[0]
	if r.OK || r.Error == nil || !r.Error.Retryable {
		t.Fatalf("want retryable failure, got %+v", r)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("want 2 calls (initial + 1 retry), got %d", got)
	}
}

// A semantic failure (worker said ok:false, retryable:false) must NOT be retried.
func TestSemanticNotRetried(t *testing.T) {
	var calls int32
	srv := fakeWorker(func(req WorkerRequest) (WorkerResponse, int) {
		atomic.AddInt32(&calls, 1)
		return WorkerResponse{OK: false, AgentID: "a", Error: "tool budget exceeded", Retryable: false}, 200
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, PerTaskTimeoutMs: 5000, RetryBudget: 1}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	r := resp.Results[0]
	if r.OK || r.Error == nil || r.Error.Retryable {
		t.Fatalf("want non-retryable failure, got %+v", r)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("semantic error must not retry; want 1 call, got %d", got)
	}
}
