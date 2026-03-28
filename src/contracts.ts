export type QueryValue = string | number | boolean | null;
export type QueryRecord = Record<string, QueryValue | QueryValue[]>;

export type ActionType = "http_request" | "slack_query" | "manual_note";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ExecutionStatus =
  | "not_started"
  | "succeeded"
  | "failed"
  | "manual_pending"
  | "skipped";

export type TicketOutputStatus =
  | "pending_review"
  | "ready_to_resolve"
  | "manual_followup_required"
  | "failed"
  | "rejected"
  | "no_action_possible";

export interface HttpRequestDefinition {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: QueryRecord;
  body?: unknown;
}

export interface HttpAction {
  actionId: string;
  type: "http_request";
  label: string;
  description?: string;
  request: HttpRequestDefinition;
}

export interface SlackQueryAction {
  actionId: string;
  type: "slack_query";
  label: string;
  description?: string;
  queryText: string;
}

export interface ManualNoteAction {
  actionId: string;
  type: "manual_note";
  label: string;
  description?: string;
  note: string;
}

export interface ActionRuntimeState {
  approvalStatus: ApprovalStatus;
  executionStatus: ExecutionStatus;
  detail?: string;
  httpError?: {
    status?: number;
    statusText?: string;
    finalUrl?: string;
    preview?: string;
  };
}

export interface TicketRuntimeState {
  actions: Record<string, ActionRuntimeState>;
}

export interface ExecutionPayload {
  request: HttpRequestDefinition;
}

export interface ExecutionResult {
  ok: boolean;
  status: number;
  statusText: string;
  finalUrl: string;
  responseHeaders: Record<string, string>;
  responsePreview: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeQueryValue(value: QueryValue | QueryValue[]): string[] {
  return Array.isArray(value) ? value.map(item => stringifyQueryScalar(item)) : [stringifyQueryScalar(value)];
}

function stringifyQueryScalar(value: QueryValue): string {
  if (value === null) return "";
  return String(value);
}

export function buildRequestUrl(request: HttpRequestDefinition): string {
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    for (const item of normalizeQueryValue(value)) {
      url.searchParams.append(key, item);
    }
  }
  return url.toString();
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildDerivedCurl(request: HttpRequestDefinition): string {
  const segments = ["curl", "-X", quoteShell(request.method.toUpperCase()), quoteShell(buildRequestUrl(request))];
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    segments.push("-H", quoteShell(`${key}: ${value}`));
  }

  if (!["GET", "HEAD"].includes(request.method.toUpperCase()) && request.body !== undefined) {
    segments.push("--data-raw", quoteShell(prettyJson(request.body)));
  }

  return segments.join(" ");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
