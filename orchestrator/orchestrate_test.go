package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// streamWorker stands in for the Node /run endpoint, which streams NDJSON: zero or more
// "event" (ping) lines, then one "result" line. Pure determinism checks — no LLM, no DB.
func streamWorker(handler func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req WorkerRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/x-ndjson")
		fl, _ := w.(http.Flusher)
		handler(r.Context(), w, fl, req)
	}))
}

func writeEvent(w http.ResponseWriter, fl http.Flusher) {
	fmt.Fprint(w, `{"type":"event","event":{"kind":"tool_call","name":"web_search"}}`+"\n")
	if fl != nil {
		fl.Flush()
	}
}

func writeResult(w http.ResponseWriter, fl http.Flusher, wr WorkerResponse) {
	b, _ := json.Marshal(wr)
	fmt.Fprintf(w, `{"type":"result","result":%s}`+"\n", b)
	if fl != nil {
		fl.Flush()
	}
}

// Results must be input-ordered even when tasks finish out of order.
func TestOrdering(t *testing.T) {
	delays := map[string]time.Duration{"q0": 60 * time.Millisecond, "q1": 30 * time.Millisecond, "q2": 5 * time.Millisecond}
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		time.Sleep(delays[req.Task]) // q0 finishes last, q2 first
		writeResult(w, fl, WorkerResponse{OK: true, AgentID: "a-" + req.Task, Summary: "ans:" + req.Task})
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
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		n := atomic.AddInt32(&inFlight, 1)
		for {
			old := atomic.LoadInt32(&maxSeen)
			if n <= old || atomic.CompareAndSwapInt32(&maxSeen, old, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&inFlight, -1)
		writeResult(w, fl, WorkerResponse{OK: true, Summary: "x"})
	})
	defer srv.Close()

	tasks := make([]string, 10)
	for i := range tasks {
		tasks[i] = "q"
	}
	req := OrchestrateRequest{Kind: "researcher", Tasks: tasks, Policy: &Policy{MaxConcurrency: 2, IdleTimeoutMs: 5000, PerTaskTimeoutMs: 5000, RetryBudget: 0}}
	Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	if maxSeen > 2 {
		t.Fatalf("max concurrent = %d, want <= 2", maxSeen)
	}
}

// THE Phase-2 feature: a task that keeps pinging stays alive far past the idle window and succeeds.
func TestPingsKeepAlive(t *testing.T) {
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		// 500ms of work total, a ping every 50ms — each gap (50ms) < idle (200ms), so it must NOT
		// be idle-killed even though total (500ms) far exceeds idle.
		for i := 0; i < 10; i++ {
			writeEvent(w, fl)
			time.Sleep(50 * time.Millisecond)
		}
		writeResult(w, fl, WorkerResponse{OK: true, AgentID: "alive", Summary: "done"})
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, IdleTimeoutMs: 200, PerTaskTimeoutMs: 10000, RetryBudget: 0}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	if !resp.Results[0].OK {
		t.Fatalf("pinging task should stay alive and succeed, got %+v", resp.Results[0])
	}
}

// A task that goes SILENT (no pings) longer than the idle window is judged hung → retryable failure.
func TestIdleTimeout(t *testing.T) {
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		w.WriteHeader(http.StatusOK)
		fl.Flush()                         // headers out now → idle clock starts immediately
		time.Sleep(500 * time.Millisecond) // then silent > idle; would have succeeded if not killed
		writeResult(w, fl, WorkerResponse{OK: true, Summary: "late"})
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, IdleTimeoutMs: 150, PerTaskTimeoutMs: 10000, RetryBudget: 0}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	r := resp.Results[0]
	if r.OK || r.Error == nil || !r.Error.Retryable {
		t.Fatalf("silent task should idle-timeout (retryable), got %+v", r)
	}
}

// A busy-but-never-finishing task (pings forever, no result) is cut by the absolute backstop.
func TestAbsoluteTimeout(t *testing.T) {
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			writeEvent(w, fl) // keeps pinging → idle never fires, but it never sends a result
			time.Sleep(40 * time.Millisecond)
		}
	})
	defer srv.Close()

	// idle large so it can't fire; absolute backstop is the only thing that can stop this.
	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, IdleTimeoutMs: 10000, PerTaskTimeoutMs: 400, RetryBudget: 0}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	r := resp.Results[0]
	if r.OK || r.Error == nil || !r.Error.Retryable {
		t.Fatalf("never-finishing task should hit the absolute backstop (retryable), got %+v", r)
	}
}

// Transport failure (non-2xx) is retried; success on the retry wins.
func TestTransportRetriedThenSuccess(t *testing.T) {
	var calls int32
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.WriteHeader(500) // transport failure on first attempt
			return
		}
		writeResult(w, fl, WorkerResponse{OK: true, Summary: "ok"})
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, IdleTimeoutMs: 5000, PerTaskTimeoutMs: 5000, RetryBudget: 1}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	if !resp.Results[0].OK {
		t.Fatalf("want success after retry, got %+v", resp.Results[0])
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("want 2 calls (initial + 1 retry), got %d", got)
	}
}

// Cancelling many tasks (idle timeout) must not leak the per-task scanner goroutine.
func TestNoGoroutineLeakOnCancel(t *testing.T) {
	// Worker flushes headers then stays silent → every task idle-times-out (the cancel path),
	// hitting the window where the scanner could be parked on its send.
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		w.WriteHeader(http.StatusOK)
		fl.Flush()
		<-ctx.Done() // silent until the orchestrator cancels
	})
	defer srv.Close()

	base := runtime.NumGoroutine()
	for i := 0; i < 200; i++ {
		req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, IdleTimeoutMs: 20, PerTaskTimeoutMs: 5000, RetryBudget: 0}}
		resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)
		if resp.Results[0].OK {
			t.Fatalf("expected idle-timeout failure, got ok")
		}
	}

	// Let the scanner goroutines observe `done` and exit.
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > base+10 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > base+10 {
		t.Fatalf("goroutine leak after 200 cancelled tasks: baseline ~%d, now %d", base, n)
	}
}

// A semantic failure (worker streamed a result with ok:false, retryable:false) must NOT be retried.
func TestSemanticNotRetried(t *testing.T) {
	var calls int32
	srv := streamWorker(func(ctx context.Context, w http.ResponseWriter, fl http.Flusher, req WorkerRequest) {
		atomic.AddInt32(&calls, 1)
		writeResult(w, fl, WorkerResponse{OK: false, AgentID: "a", Error: "tool budget exceeded", Retryable: false})
	})
	defer srv.Close()

	req := OrchestrateRequest{Kind: "researcher", Tasks: []string{"q"}, Policy: &Policy{MaxConcurrency: 1, IdleTimeoutMs: 5000, PerTaskTimeoutMs: 5000, RetryBudget: 1}}
	resp := Orchestrate(context.Background(), srv.Client(), srv.URL, req)

	r := resp.Results[0]
	if r.OK || r.Error == nil || r.Error.Retryable {
		t.Fatalf("want non-retryable failure, got %+v", r)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("semantic error must not retry; want 1 call, got %d", got)
	}
}
