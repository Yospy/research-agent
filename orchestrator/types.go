package main

// The generic orchestration envelope. The same shape serves any "kind" of fan-out job;
// only `kind` and the per-task string change. No LLM or domain logic lives here.

// Policy is the deterministic control surface. Zero/absent fields fall back to defaults
// (see applyPolicyDefaults) so the tool can send a partial or no policy.
//   - IdleTimeoutMs : max silence between progress pings before a task is judged hung (Phase 2).
//   - PerTaskTimeoutMs : absolute per-attempt backstop (catches busy-but-never-finishing).
type Policy struct {
	MaxConcurrency   int `json:"maxConcurrency"`
	PerTaskTimeoutMs int `json:"perTaskTimeoutMs"`
	IdleTimeoutMs    int `json:"idleTimeoutMs"`
	RetryBudget      int `json:"retryBudget"`
}

// PassContext is opaque to the orchestrator — it is forwarded verbatim to the worker,
// which needs it to create the child agent row (runId, parent, depth, bounds).
type PassContext struct {
	RunID         string `json:"runId"`
	ParentAgentID string `json:"parentAgentId"`
	Depth         int    `json:"depth"`
	MaxDepth      int    `json:"maxDepth"`
	ToolBudget    int    `json:"toolBudget"`
}

// OrchestrateRequest — Tool → Orchestrator (POST /orchestrate).
type OrchestrateRequest struct {
	Kind    string      `json:"kind"`
	Tasks   []string    `json:"tasks"`
	Policy  *Policy     `json:"policy"`
	Context PassContext `json:"context"`
}

type Citation struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// WorkerRequest — Orchestrator → Worker (POST /run), one per task.
type WorkerRequest struct {
	Kind    string      `json:"kind"`
	Task    string      `json:"task"`
	Context PassContext `json:"context"`
}

// WorkerResponse mirrors the TS AgentResult: a decoded reply is a *semantic* verdict
// (the agent ran and decided), regardless of ok/!ok. Only a missing/undecodable reply
// counts as a transport failure (see runOneStreaming).
type WorkerResponse struct {
	OK        bool       `json:"ok"`
	AgentID   string     `json:"agentId"`
	Summary   string     `json:"summary"`
	Error     string     `json:"error"`
	Citations []Citation `json:"citations"`
	Retryable bool       `json:"retryable"`
}

type ErrorBody struct {
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// PerTaskResult — Orchestrator → Tool, one per input task, in input order.
type PerTaskResult struct {
	OK        bool       `json:"ok"`
	AgentID   string     `json:"agentId,omitempty"`
	Summary   string     `json:"summary,omitempty"`
	Citations []Citation `json:"citations,omitempty"`
	Error     *ErrorBody `json:"error,omitempty"`
}

type OrchestrateResponse struct {
	Results []PerTaskResult `json:"results"`
}
