import type { ApprovalStatus, ExecutionStatus, TicketOutputStatus } from "./contracts";

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
