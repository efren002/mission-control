import { applicationConfig } from "@/lib/config";

export interface Project { id: string; name: string; status: string; memory: string; test_command: string | null; app_command: string | null }
export interface Repository { id: string; project_id: string; name: string; path: string; host_path: string | null; default_branch: string }
export interface RepositoryDetail extends Repository { branch: string; commit_sha: string; clean: boolean; technology: string[] }
export interface Objective { id: string; project_id: string; title: string; description: string | null; status: string }
export interface ObjectiveAttachment { id: string; objective_id: string; filename: string; content_type: string; size_bytes: number; created_at: string }
export interface Run { id: string; objective_id: string; project_id: string; objective_title: string; repository_id: string | null; status: string; current_step: string | null; worktree_branch: string | null; worktree_status: "active" | "preserved" | "integrated" | "cleanup_pending" | null; baseline_sha: string | null; integration_sha: string | null; task_count: number; approval_status: string | null; created_at: string; updated_at: string }
export interface RunEvent { id: string; sequence: number; event_type: string; payload: Record<string, unknown>; created_at: string }
export interface RunInvocation { id: string; agent_id: string; agent_name: string; purpose: string; status: string; provider: string | null; model: string | null; attempt: number; fallback_from_provider: string | null; routing_reason: string | null; duration_ms: number | null; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; input_excerpt: string | null; output_excerpt: string | null; error: string | null; created_at: string; updated_at: string }
export interface RunApproval { id: string; task_id: string | null; kind: string; status: string; decision_reason: string | null; decided_at: string | null; created_at: string }
export interface VerificationCriterion { id: string; position: number; description: string; status: "pending" | "passed" | "failed"; evidence: string | null; verifier_agent_id: string | null; verified_at: string | null }
export interface VerificationEvidence { id: string; kind: "test"; status: "running" | "passed" | "failed" | "error" | "skipped"; command: string | null; exit_code: number | null; output_excerpt: string | null; error: string | null; started_at: string | null; finished_at: string | null }
export interface RunDetail extends Run { tasks: Task[]; events: RunEvent[]; invocations: RunInvocation[]; approvals: RunApproval[]; verification_criteria: VerificationCriterion[]; verification_evidence: VerificationEvidence[] }
export interface ResumeExecution { id: string; status: string; current_step: string | null; recovered_tasks: number }
export interface Task { id: string; objective_id?: string; run_id?: string | null; position: number; depends_on_positions: number[]; title: string; description: string | null; status: string; agent_role: string; assigned_agent_id: string | null; checkpoint_sha: string | null; worktree_branch: string | null; worktree_status: "active" | "preserved" | "integrated" | "cleanup_pending" | null; integration_sha: string | null; conflict_files: string[]; conflict_detail: string | null; conflict_detected_at: string | null }
export interface TaskDiff { task_id: string; commit_sha: string; diff: string; truncated: boolean }
export interface ConflictResolution { id: string; task_id: string; run_id: string; agent_id: string; agent_name: string; invocation_id: string | null; status: "queued" | "running" | "passed" | "failed"; instructions: string; source_head: string | null; branch_before_sha: string | null; resolution_sha: string | null; conflict_files: string[]; test_command: string | null; test_status: "pending" | "running" | "passed" | "failed" | "error" | "skipped"; test_exit_code: number | null; test_output_excerpt: string | null; error: string | null; started_at: string | null; finished_at: string | null; created_at: string; updated_at: string }
export interface TaskConflict { task_id: string; branch: string; workspace: string; source_head: string; branch_head: string; conflict_files: string[]; task_changes: string; mission_changes: string; diff: string; truncated: boolean; latest_resolution: ConflictResolution | null }
export interface Approval { id: string; run_id: string; task_id: string | null; objective_id: string; objective_title: string; kind: string; status: string; task_count: number; decision_reason: string | null; decided_at: string | null; created_at: string; updated_at: string }
export interface Agent { id: string; name: string; role: "planner" | "developer" | "qa" | "reviewer"; provider: string; model: string | null; instructions: string; enabled: boolean; status: string; provider_version: string | null; capabilities: string[]; assignment_count: number; invocation_count: number }
export interface AgentInput { name: string; role: Agent["role"]; provider: Agent["provider"]; model: string | null; instructions: string; enabled: boolean }
export interface AgentInvocation { id: string; agent_id: string; run_id: string | null; task_id: string | null; purpose: string; status: string; provider: string | null; model: string | null; attempt: number; fallback_from_provider: string | null; routing_reason: string | null; duration_ms: number | null; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; input_excerpt: string | null; output_excerpt: string | null; error: string | null; created_at: string }
export interface WorkflowSettings { planner_provider: Agent["provider"]; planner_model: string | null; require_plan_approval: boolean; require_execution_approval: boolean; auto_assign_tasks: boolean; max_planning_tasks: number; max_parallel_tasks: number; provider_timeout_seconds: number; enable_provider_fallback: boolean; allow_repository_writes: boolean; retain_invocation_output: boolean; enable_continuous_operations: boolean; scheduler_poll_seconds: number }
export type DetectorKind = "dependency_maintenance" | "failing_test_diagnosis" | "documentation_drift" | "issue_triage" | "security_health" | "repo_health" | "mission_template";
export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "proposed" | "dismissed" | "converting" | "converted" | "superseded";
export interface MaintenanceSchedule { id: string; project_id: string | null; name: string; detector_kind: DetectorKind; interval_seconds: number; enabled: boolean; config: Record<string, unknown>; last_run_at: string | null; next_run_at: string | null; last_status: string | null; last_finding_count: number | null }
export interface MaintenanceScheduleInput { project_id: string; name: string; detector_kind: DetectorKind; interval_seconds: number; config: Record<string, unknown>; enabled: boolean }
export interface ProposedObjective { title: string; description: string; test_hint?: string }
export interface MaintenanceFinding { id: string; schedule_id: string | null; project_id: string; repository_id: string | null; detector_kind: DetectorKind; severity: FindingSeverity; title: string; detail: string | null; evidence: Record<string, unknown>; proposed_objective: ProposedObjective | null; status: FindingStatus; objective_id: string | null; created_at: string; resolved_at: string | null }
export interface MaintenanceRun { id: string; schedule_id: string | null; detector_kind: DetectorKind; project_id: string | null; status: "running" | "succeeded" | "failed" | "skipped"; findings_created: number; error: string | null; started_at: string | null; finished_at: string | null }
export interface OperationsOverview { proposed_findings: number; proposed_by_severity: Record<string, number>; enabled_schedules: number }
export interface ProviderRequestUsage { label: string; model: string | null; promptChars: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number; durationMs: number; succeeded: boolean; completedAt: string }
export interface ProviderUsage { requests: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number; updatedAt: string | null; recentRequests?: ProviderRequestUsage[] }
export interface RateLimitWindow { usedPercent: number; resetsAt: number | null; windowDurationMins: number | null }
export interface RateLimitSnapshot { planType?: string | null; limitName?: string | null; primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null }
export interface ProviderStatus { available?: boolean; installed?: boolean; authenticated?: boolean; version?: string; error?: string; authDetail?: string; capabilities?: string[]; usage?: ProviderUsage; rateLimits?: RateLimitSnapshot; kind?: "cli" | "http"; format?: "openai" | "anthropic"; base_url?: string; model?: string | null; max_tokens?: number | null }
export interface CustomProviderInput {
  name: string;
  kind: "http";
  format: "openai" | "anthropic";
  base_url: string;
  model: string | null;
  api_key: string | null;
  max_tokens: number | null;
}
export interface ProviderPerformanceMetric { provider: string; role: Agent["role"] | null; invocations: number; completed: number; failed: number; success_rate: number; average_duration_ms: number | null; fallback_attempts: number; fallback_successes: number; token_coverage: number; input_tokens: number; cached_input_tokens: number; output_tokens: number; total_tokens: number }
export interface ProviderPerformance { generated_at: string; providers: ProviderPerformanceMetric[]; by_role: ProviderPerformanceMetric[] }
export interface SandboxStatus { status: "operational" | "unavailable" | "disabled"; required: boolean; executionIsolation?: string; dockerVersion?: string | null; limits?: { memory: string; cpus: string; pids: number }; activeSandboxes: { containerName: string; sandboxId: string; kind: "provider" | "command"; workspace: string; startedAt: string }[] }
export type ProviderLoginStatus = "starting" | "awaiting_browser" | "awaiting_input" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";
export interface ProviderLoginSession { provider: "codex" | "claude"; status: ProviderLoginStatus; url: string | null; userCode: string | null; needsInput: boolean; startedAt: string; error: string | null }
export interface CommandRun { id: string; project_id: string; repository_id: string | null; kind: string; command: string; status: "queued" | "running" | "passed" | "failed" | "error"; exit_code: number | null; output_excerpt: string | null; error: string | null; started_at: string | null; finished_at: string | null; created_at: string; updated_at: string }
export interface AppRuntime { status: "running" | "stopped" | "exited" | string; port: number; command: string; started_at: string; exit_code: number | null; log_tail: string; preview_url: string }
export interface ProjectRuntime { project_id: string; repository_id: string | null; configured_test_command: string | null; configured_app_command: string | null; detected_test_command: string | null; detected_app_command: string | null; effective_test_command: string | null; effective_app_command: string | null; test_run: CommandRun | null; app: AppRuntime | null; gateway_error: string | null }

function repositoryQuery(repositoryId: string | null): string {
  return repositoryId ? `?repository_id=${encodeURIComponent(repositoryId)}` : "";
}

const reusablePaths = new Set([
  "/projects",
  "/repositories",
  "/agents",
  "/settings/coding-standards",
  "/settings/workflow",
]);
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlightRequests = new Map<string, Promise<unknown>>();
const REUSABLE_RESPONSE_MS = 15_000;
let cacheVersion = 0;

function clearResponseCache() {
  cacheVersion += 1;
  responseCache.clear();
  inFlightRequests.clear();
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const cacheKey = `${token}\n${path}`;
  const reusable = method === "GET" && reusablePaths.has(path);
  const cached = reusable ? responseCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  if (method === "GET") {
    const pending = inFlightRequests.get(cacheKey);
    if (pending) return pending as Promise<T>;
  } else {
    clearResponseCache();
  }

  const requestCacheVersion = cacheVersion;
  const pending = (async () => {
    const response = await fetch(`${applicationConfig.apiUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `Request failed (${response.status})`);
    if (response.status === 204) return undefined as T;
    const value = await response.json() as T;
    if (reusable && requestCacheVersion === cacheVersion) {
      responseCache.set(cacheKey, {
        expiresAt: Date.now() + REUSABLE_RESPONSE_MS,
        value,
      });
    }
    return value;
  })();

  if (method === "GET") inFlightRequests.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightRequests.get(cacheKey) === pending) inFlightRequests.delete(cacheKey);
  }
}

// Image uploads send multipart form data, so the browser must set the boundary
// header itself instead of the JSON content type the shared helper applies.
async function uploadRequest<T>(path: string, token: string, file: File): Promise<T> {
  clearResponseCache();
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(`${applicationConfig.apiUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `Upload failed (${response.status})`);
  return await response.json() as T;
}

async function binaryRequest(path: string, token: string): Promise<Blob> {
  const response = await fetch(`${applicationConfig.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `Request failed (${response.status})`);
  return await response.blob();
}

// Login endpoints describe session state with 404/409 status codes whose bodies
// are still session payloads, so they need their own response handling.
async function loginRequest(path: string, token: string, init?: RequestInit): Promise<ProviderLoginSession | null> {
  const response = await fetch(`${applicationConfig.apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "provider" in payload && "status" in payload) return payload as ProviderLoginSession;
  if (response.status === 404) return null;
  throw new Error((payload as { detail?: string } | null)?.detail ?? `Request failed (${response.status})`);
}

export const catalogApi = {
  projects: (token: string) => request<Project[]>("/projects", token),
  createProject: (token: string, name: string) => request<Project>("/projects", token, { method: "POST", body: JSON.stringify({ name }) }),
  updateProject: (token: string, projectId: string, name: string) => request<Project>(`/projects/${projectId}`, token, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteProject: (token: string, projectId: string) => request<void>(`/projects/${projectId}`, token, { method: "DELETE" }),
  updateProjectMemory: (token: string, projectId: string, value: string) => request<Project>(`/projects/${projectId}/memory`, token, { method: "PUT", body: JSON.stringify({ value }) }),
  projectRuntime: (token: string, projectId: string, repositoryId: string | null = null) => request<ProjectRuntime>(`/projects/${projectId}/runtime${repositoryQuery(repositoryId)}`, token),
  updateRuntimeCommands: (token: string, projectId: string, input: { test_command: string | null; app_command: string | null }, repositoryId: string | null = null) => request<ProjectRuntime>(`/projects/${projectId}/runtime/commands${repositoryQuery(repositoryId)}`, token, { method: "PUT", body: JSON.stringify(input) }),
  runProjectTests: (token: string, projectId: string, repositoryId: string | null = null) => request<CommandRun>(`/projects/${projectId}/runtime/tests${repositoryQuery(repositoryId)}`, token, { method: "POST" }),
  startProjectApp: (token: string, projectId: string, repositoryId: string | null = null) => request<AppRuntime>(`/projects/${projectId}/runtime/app/start${repositoryQuery(repositoryId)}`, token, { method: "POST" }),
  stopProjectApp: (token: string, projectId: string, repositoryId: string | null = null) => request<AppRuntime>(`/projects/${projectId}/runtime/app/stop${repositoryQuery(repositoryId)}`, token, { method: "POST" }),
  codingStandards: (token: string) => request<{ value: string }>("/settings/coding-standards", token),
  updateCodingStandards: (token: string, value: string) => request<{ value: string }>("/settings/coding-standards", token, { method: "PUT", body: JSON.stringify({ value }) }),
  repositories: (token: string) => request<Repository[]>("/repositories", token),
  createRepository: (token: string, project_id: string, name: string) => request<RepositoryDetail>("/repositories/new", token, { method: "POST", body: JSON.stringify({ project_id, name }) }),
  registerRepository: (token: string, project_id: string, relative_path: string) => request<RepositoryDetail>("/repositories", token, { method: "POST", body: JSON.stringify({ project_id, relative_path }) }),
  updateRepository: (token: string, repositoryId: string, input: { name: string; default_branch: string }) => request<Repository>(`/repositories/${repositoryId}`, token, { method: "PUT", body: JSON.stringify(input) }),
  repositoryArchive: (token: string, repositoryId: string) => binaryRequest(`/repositories/${repositoryId}/archive`, token),
  deleteRepository: (token: string, repositoryId: string) => request<void>(`/repositories/${repositoryId}`, token, { method: "DELETE" }),
  objectives: (token: string) => request<Objective[]>("/objectives", token),
  createObjective: (token: string, project_id: string, title: string, description: string) => request<Objective>("/objectives", token, { method: "POST", body: JSON.stringify({ project_id, title, description }) }),
  updateObjective: (token: string, objectiveId: string, input: { title: string; description: string | null }) => request<Objective>(`/objectives/${objectiveId}`, token, { method: "PUT", body: JSON.stringify(input) }),
  deleteObjective: (token: string, objectiveId: string) => request<void>(`/objectives/${objectiveId}`, token, { method: "DELETE" }),
  attachments: (token: string, objectiveId: string) => request<ObjectiveAttachment[]>(`/objectives/${objectiveId}/attachments`, token),
  uploadAttachment: (token: string, objectiveId: string, file: File) => uploadRequest<ObjectiveAttachment>(`/objectives/${objectiveId}/attachments`, token, file),
  attachmentContent: (token: string, objectiveId: string, attachmentId: string) => binaryRequest(`/objectives/${objectiveId}/attachments/${attachmentId}/content`, token),
  deleteAttachment: (token: string, objectiveId: string, attachmentId: string) => request<void>(`/objectives/${objectiveId}/attachments/${attachmentId}`, token, { method: "DELETE" }),
  startPlanning: (token: string, objectiveId: string) => request<Run>(`/objectives/${objectiveId}/plan`, token, { method: "POST" }),
  runs: (token: string) => request<Run[]>("/runs", token),
  run: (token: string, runId: string) => request<RunDetail>(`/runs/${runId}`, token),
  startExecution: (token: string, runId: string, repository_id: string | null = null) => request<Run>(`/runs/${runId}/execute`, token, { method: "POST", body: JSON.stringify({ repository_id }) }),
  resumeExecution: (token: string, runId: string) => request<ResumeExecution>(`/runs/${runId}/resume`, token, { method: "POST" }),
  retryVerification: (token: string, runId: string) => request<ResumeExecution>(`/runs/${runId}/retry-verification`, token, { method: "POST" }),
  approvals: (token: string) => request<Approval[]>("/approvals", token),
  decideApproval: (token: string, approvalId: string, decision: "approve" | "reject", reason: string) => request<Approval>(`/approvals/${approvalId}/decision`, token, { method: "POST", body: JSON.stringify({ decision, reason: reason || null }) }),
  tasks: (token: string) => request<Task[]>("/tasks", token),
  taskDiff: (token: string, taskId: string) => request<TaskDiff>(`/tasks/${taskId}/diff`, token),
  taskConflict: (token: string, taskId: string) => request<TaskConflict>(`/tasks/${taskId}/conflict`, token),
  resolveTaskConflict: (token: string, taskId: string, agent_id: string, instructions: string) => request<ConflictResolution>(`/tasks/${taskId}/conflict/resolve`, token, { method: "POST", body: JSON.stringify({ agent_id, instructions }) }),
  revertTask: (token: string, taskId: string) => request<Task>(`/tasks/${taskId}/revert`, token, { method: "POST" }),
  retryTask: (token: string, taskId: string) => request<Task>(`/tasks/${taskId}/retry`, token, { method: "POST" }),
  assignTask: (token: string, taskId: string, agent_id: string | null) => request<Task>(`/tasks/${taskId}/assignment`, token, { method: "PUT", body: JSON.stringify({ agent_id }) }),
  agents: (token: string) => request<Agent[]>("/agents", token),
  createAgent: (token: string, input: AgentInput) => request<Agent>("/agents", token, { method: "POST", body: JSON.stringify(input) }),
  updateAgent: (token: string, agentId: string, input: Partial<AgentInput>) => request<Agent>(`/agents/${agentId}`, token, { method: "PUT", body: JSON.stringify(input) }),
  deleteAgent: (token: string, agentId: string) => request<void>(`/agents/${agentId}`, token, { method: "DELETE" }),
  agentInvocations: (token: string, agentId: string) => request<AgentInvocation[]>(`/agents/${agentId}/invocations`, token),
  testAgent: (token: string, agentId: string) => request<AgentInvocation>(`/agents/${agentId}/test`, token, { method: "POST" }),
  workflowSettings: (token: string) => request<WorkflowSettings>("/settings/workflow", token),
  updateWorkflowSettings: (token: string, input: WorkflowSettings) => request<WorkflowSettings>("/settings/workflow", token, { method: "PUT", body: JSON.stringify(input) }),
  providers: (token: string) => request<{ providers: Record<string, ProviderStatus> }>("/providers", token),
  createCustomProvider: (token: string, input: CustomProviderInput) => request<{ providers: Record<string, ProviderStatus> }>("/providers/custom", token, { method: "POST", body: JSON.stringify(input) }),
  updateCustomProvider: (token: string, name: string, input: CustomProviderInput) => request<{ providers: Record<string, ProviderStatus> }>(`/providers/custom/${encodeURIComponent(name)}`, token, { method: "PUT", body: JSON.stringify(input) }),
  deleteCustomProvider: (token: string, name: string) => request<{ providers: Record<string, ProviderStatus> }>(`/providers/custom/${encodeURIComponent(name)}`, token, { method: "DELETE" }),
  testCustomProvider: (token: string, name: string) => request<{ ok: boolean; url?: string; models?: string[]; error?: string }>(`/providers/custom/${encodeURIComponent(name)}/models`, token),
  providerPerformance: (token: string) => request<ProviderPerformance>("/providers/performance", token),
  sandboxes: (token: string) => request<SandboxStatus>("/providers/sandboxes", token),
  startProviderLogin: (token: string, provider: "codex" | "claude") => loginRequest(`/providers/${provider}/login`, token, { method: "POST" }),
  providerLoginStatus: (token: string, provider: "codex" | "claude") => loginRequest(`/providers/${provider}/login`, token),
  submitProviderLoginCode: (token: string, provider: "codex" | "claude", code: string) => loginRequest(`/providers/${provider}/login/input`, token, { method: "POST", body: JSON.stringify({ code }) }),
  cancelProviderLogin: (token: string, provider: "codex" | "claude") => loginRequest(`/providers/${provider}/login`, token, { method: "DELETE" }),
  operationsOverview: (token: string) => request<OperationsOverview>("/operations/overview", token),
  detectorKinds: (token: string) => request<DetectorKind[]>("/operations/detector-kinds", token),
  maintenanceSchedules: (token: string) => request<MaintenanceSchedule[]>("/operations/schedules", token),
  createMaintenanceSchedule: (token: string, input: MaintenanceScheduleInput) => request<MaintenanceSchedule>("/operations/schedules", token, { method: "POST", body: JSON.stringify(input) }),
  updateMaintenanceSchedule: (token: string, scheduleId: string, input: Partial<Pick<MaintenanceScheduleInput, "name" | "interval_seconds" | "config" | "enabled">>) => request<MaintenanceSchedule>(`/operations/schedules/${scheduleId}`, token, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMaintenanceSchedule: (token: string, scheduleId: string) => request<void>(`/operations/schedules/${scheduleId}`, token, { method: "DELETE" }),
  runMaintenanceScheduleNow: (token: string, scheduleId: string) => request<MaintenanceRun>(`/operations/schedules/${scheduleId}/run-now`, token, { method: "POST" }),
  maintenanceFindings: (token: string, status?: FindingStatus) => request<MaintenanceFinding[]>(`/operations/findings${status ? `?status=${status}` : ""}`, token),
  approveMaintenanceFinding: (token: string, findingId: string) => request<{ objective_id: string; finding_id: string }>(`/operations/findings/${findingId}/approve`, token, { method: "POST" }),
  dismissMaintenanceFinding: (token: string, findingId: string) => request<MaintenanceFinding>(`/operations/findings/${findingId}/dismiss`, token, { method: "POST" }),
  maintenanceRuns: (token: string) => request<MaintenanceRun[]>("/operations/runs", token),
};
