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

export type TicketAction = HttpAction | SlackQueryAction | ManualNoteAction;

export interface InputTicket {
  ticketId: string;
  title: string;
  proposedResponse?: string;
  noActionReason?: string;
  actions?: TicketAction[];
}

export interface InputContract {
  contractVersion: string;
  generatedAt: string;
  tickets: InputTicket[];
}

export interface ActionOutput {
  actionId: string;
  approvalStatus: Exclude<ApprovalStatus, "pending">;
  executionStatus: Exclude<ExecutionStatus, "not_started">;
}

export interface OutputTicket {
  ticketId: string;
  status: TicketOutputStatus;
  actions: ActionOutput[];
  reason?: string;
}

export interface OutputContract {
  contractVersion: string;
  processedAt: string;
  mode: "live" | "dry_run";
  tickets: OutputTicket[];
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

export function ticketHasNoActions(ticket: InputTicket): boolean {
  return (ticket.actions?.length ?? 0) === 0;
}

export function validateInputContract(raw: unknown): { ok: true; contract: InputContract } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: "O JSON precisa ser um objeto." };
  }

  if (typeof raw.contractVersion !== "string") {
    return { ok: false, error: "contractVersion é obrigatório e deve ser string." };
  }

  if (typeof raw.generatedAt !== "string") {
    return { ok: false, error: "generatedAt é obrigatório e deve ser string." };
  }

  if (!Array.isArray(raw.tickets)) {
    return { ok: false, error: "tickets é obrigatório e deve ser uma lista." };
  }

  for (const [ticketIndex, ticket] of raw.tickets.entries()) {
    if (!isRecord(ticket)) {
      return { ok: false, error: `Ticket #${ticketIndex + 1} é inválido.` };
    }

    if (typeof ticket.ticketId !== "string" || typeof ticket.title !== "string") {
      return { ok: false, error: `Ticket #${ticketIndex + 1} precisa ter ticketId e title.` };
    }

    if (ticket.actions !== undefined && !Array.isArray(ticket.actions)) {
      return { ok: false, error: `Ticket ${ticket.ticketId}: actions deve ser uma lista.` };
    }

    if (ticket.actions) {
      for (const [actionIndex, action] of ticket.actions.entries()) {
        if (!isRecord(action) || typeof action.actionId !== "string" || typeof action.label !== "string" || typeof action.type !== "string") {
          return { ok: false, error: `Ticket ${ticket.ticketId}: ação #${actionIndex + 1} é inválida.` };
        }

        if (action.type === "http_request") {
          if (!isRecord(action.request) || typeof action.request.method !== "string" || typeof action.request.url !== "string") {
            return { ok: false, error: `Ticket ${ticket.ticketId}: ação ${action.actionId} precisa de request estruturada.` };
          }
        }

        if (action.type === "slack_query" && typeof action.queryText !== "string") {
          return { ok: false, error: `Ticket ${ticket.ticketId}: ação ${action.actionId} precisa de queryText.` };
        }

        if (action.type === "manual_note" && typeof action.note !== "string") {
          return { ok: false, error: `Ticket ${ticket.ticketId}: ação ${action.actionId} precisa de note.` };
        }
      }
    }
  }

  return { ok: true, contract: raw as unknown as InputContract };
}
