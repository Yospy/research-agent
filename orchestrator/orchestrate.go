package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

// Opt-in: log every progress ping (with its event kind) as it arrives. Off by default so normal
// runs stay readable; set ORCH_LOG_PINGS=1 to watch the stream live.
var logPings = os.Getenv("ORCH_LOG_PINGS") != ""

const (
	defaultMaxConcurrency   = 3
	defaultPerTaskTimeoutMs = 300000 // absolute per-attempt backstop (5 min)
	defaultIdleTimeoutMs    = 60000  // max silence between progress pings
	defaultRetryBudget      = 1
)

// applyPolicyDefaults fills absent/invalid fields so the orchestrator behaves deterministically
// even when the caller sends a partial (or nil) policy.
func applyPolicyDefaults(p *Policy) Policy {
	out := Policy{
		MaxConcurrency:   defaultMaxConcurrency,
		PerTaskTimeoutMs: defaultPerTaskTimeoutMs,
		IdleTimeoutMs:    defaultIdleTimeoutMs,
		RetryBudget:      defaultRetryBudget,
	}
	if p != nil {
		if p.MaxConcurrency > 0 {
			out.MaxConcurrency = p.MaxConcurrency
		}
		if p.PerTaskTimeoutMs > 0 {
			out.PerTaskTimeoutMs = p.PerTaskTimeoutMs
		}
		if p.IdleTimeoutMs > 0 {
			out.IdleTimeoutMs = p.IdleTimeoutMs
		}
		if p.RetryBudget >= 0 {
			out.RetryBudget = p.RetryBudget
		}
	}
	return out
}

// Orchestrate is the deterministic control plane: fan out every task to the worker under
// bounded concurrency, give each attempt its own timeout, retry ONLY transport failures
// (up to RetryBudget), and collect results strictly in input order. No LLM here → the whole
// function is unit-testable against a fake worker.
func Orchestrate(parent context.Context, client *http.Client, workerURL string, req OrchestrateRequest) OrchestrateResponse {
	policy := applyPolicyDefaults(req.Policy)
	n := len(req.Tasks)
	results := make([]PerTaskResult, n)
	durations := make([]time.Duration, n) // each task's own wall time (disjoint indices → no lock)

	log.Printf("/orchestrate kind=%s tasks=%d policy={conc:%d idle:%dms maxTask:%dms retry:%d}",
		req.Kind, n, policy.MaxConcurrency, policy.IdleTimeoutMs, policy.PerTaskTimeoutMs, policy.RetryBudget)

	start := time.Now()
	sem := make(chan struct{}, policy.MaxConcurrency) // bounded concurrency
	var wg sync.WaitGroup

	for i, task := range req.Tasks {
		wg.Add(1)
		go func(i int, task string) {
			defer wg.Done()
			sem <- struct{}{} // blocks here until a slot frees → the sliding window
			defer func() { <-sem }()

			t0 := time.Now()
			log.Printf("  task[%d] → worker (slot acquired)", i)
			pings := 0
			results[i] = runTaskWithRetry(parent, client, workerURL, req.Kind, task, req.Context, policy, i, &pings)
			durations[i] = time.Since(t0)

			if results[i].OK {
				log.Printf("  task[%d] ✓ ok   agent=%s (%.1fs, %d pings)", i, short(results[i].AgentID), durations[i].Seconds(), pings)
			} else {
				log.Printf("  task[%d] ✗ fail retryable=%v (%.1fs, %d pings): %s",
					i, results[i].Error.Retryable, durations[i].Seconds(), pings, results[i].Error.Message)
			}
		}(i, task)
	}
	wg.Wait()

	// Concurrency efficiency: wall-clock vs serial-equivalent (sum of per-task durations =
	// roughly what the old sequential in-process path would have taken). speedup is the
	// concurrency gain, bounded by maxConcurrency and by the slowest single task (Amdahl).
	wall := time.Since(start)
	var serial, slowest time.Duration
	ok := 0
	for i := range durations {
		serial += durations[i]
		if durations[i] > slowest {
			slowest = durations[i]
		}
		if results[i].OK {
			ok++
		}
	}
	speedup := 0.0
	if wall > 0 {
		speedup = serial.Seconds() / wall.Seconds()
	}
	log.Printf("/orchestrate done: %d ok, %d failed | wall=%.1fs serial≈%.1fs speedup=%.2fx (cap=%d, slowest=%.1fs)",
		ok, n-ok, wall.Seconds(), serial.Seconds(), speedup, policy.MaxConcurrency, slowest.Seconds())

	return OrchestrateResponse{Results: results}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// runTaskWithRetry runs one task. Each attempt gets a fresh timeout. A decoded verdict
// (semantic) returns immediately — success or failure, never retried. A transport failure
// is retried up to RetryBudget times; if all attempts fail, it surfaces as a retryable error
// so the model can decide to try again with new args.
func runTaskWithRetry(parent context.Context, client *http.Client, workerURL, kind, task string, pass PassContext, policy Policy, idx int, pings *int) PerTaskResult {
	attempts := policy.RetryBudget + 1 // initial attempt + retries
	idle := time.Duration(policy.IdleTimeoutMs) * time.Millisecond
	var lastErr error

	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			log.Printf("  task[%d] ⟳ retry %d/%d (%v)", idx, attempt, policy.RetryBudget, lastErr)
		}
		// Per-attempt absolute backstop; the idle timeout (inside runOneStreaming) cuts sooner
		// if the task goes silent.
		taskCtx, cancel := context.WithTimeout(parent, time.Duration(policy.PerTaskTimeoutMs)*time.Millisecond)
		wr, err := runOneStreaming(taskCtx, client, workerURL, kind, task, pass, idle, func(evKind string) {
			(*pings)++
			if logPings {
				log.Printf("  task[%d] · ping %d (%s)", idx, *pings, evKind)
			}
		})
		cancel()

		if err == nil {
			// Semantic verdict — trust it, never retry.
			if wr.OK {
				return PerTaskResult{OK: true, AgentID: wr.AgentID, Summary: wr.Summary, Citations: wr.Citations}
			}
			return PerTaskResult{
				OK:      false,
				AgentID: wr.AgentID,
				Error:   &ErrorBody{Message: wr.Error, Retryable: wr.Retryable},
			}
		}

		// No verdict (transport / idle timeout / cancel) → eligible for another attempt.
		lastErr = err
	}

	msg := "worker failed"
	if lastErr != nil {
		msg = lastErr.Error()
	}
	return PerTaskResult{OK: false, Error: &ErrorBody{Message: msg, Retryable: true}}
}
