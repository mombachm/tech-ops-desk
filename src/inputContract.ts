import {
  isRecord,
  type HttpAction,
  type ManualNoteAction,
  type SlackQueryAction,
} from "./contracts";

export type InputAction = HttpAction | SlackQueryAction | ManualNoteAction;

export interface InputTicket {
  ticketId: string;
  title: string;
  proposedResponse?: string;
  noActionReason?: string;
  actions?: InputAction[];
}

export interface InputContract {
  contractVersion: string;
  generatedAt: string;
  tickets: InputTicket[];
}

export function validateInputContract(
  raw: unknown,
): { ok: true; contract: InputContract } | { ok: false; error: string } {
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
        if (
          !isRecord(action) ||
          typeof action.actionId !== "string" ||
          typeof action.label !== "string" ||
          typeof action.type !== "string"
        ) {
          return { ok: false, error: `Ticket ${ticket.ticketId}: ação #${actionIndex + 1} é inválida.` };
        }

        if (action.type === "http_request") {
          if (
            !isRecord(action.request) ||
            typeof action.request.method !== "string" ||
            typeof action.request.url !== "string"
          ) {
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
