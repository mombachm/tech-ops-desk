import { useMemo, useState, useTransition } from "react";
import "./app.css";
import {
  buildDerivedCurl,
  buildRequestUrl,
  prettyJson,
  ticketHasNoActions,
  type ActionOutput,
  type ActionRuntimeState,
  type ApprovalStatus,
  type ExecutionPayload,
  type ExecutionResult,
  type ExecutionStatus,
  type HttpAction,
  type HttpRequestDefinition,
  type InputContract,
  type InputTicket,
  type OutputContract,
  type OutputTicket,
  type TicketAction,
  type TicketOutputStatus,
  validateInputContract,
} from "./contracts";
import { mockContract } from "./mockData";

type FilterKey =
  | "all"
  | "pending"
  | "manual"
  | "failed"
  | "ready"
  | "no_action";

interface AppState {
  contract: InputContract;
  runtime: Record<string, Record<string, ActionRuntimeState>>;
  dryRun: boolean;
}

const initialState = createAppState(mockContract);

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [selectedTicketId, setSelectedTicketId] = useState(
    initialState.contract.tickets[0]?.ticketId ?? "",
  );
  const [selectedActionId, setSelectedActionId] = useState<string | null>(
    initialActionId(initialState.contract.tickets[0]),
  );
  const [filter, setFilter] = useState<FilterKey>("all");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const enrichedTickets = useMemo(() => {
    return state.contract.tickets.map((ticket) =>
      enrichTicket(ticket, state.runtime[ticket.ticketId] ?? {}),
    );
  }, [state.contract.tickets, state.runtime]);

  const visibleTickets = useMemo(() => {
    return enrichedTickets.filter((ticket) => {
      switch (filter) {
        case "pending":
          return ticket.status === "pending_review";
        case "manual":
          return ticket.status === "manual_followup_required";
        case "failed":
          return ticket.status === "failed";
        case "ready":
          return ticket.status === "ready_to_resolve";
        case "no_action":
          return ticket.status === "no_action_possible";
        default:
          return true;
      }
    });
  }, [enrichedTickets, filter]);

  const selectedTicket =
    visibleTickets.find(
      (ticket) => ticket.ticket.ticketId === selectedTicketId,
    ) ??
    enrichedTickets.find(
      (ticket) => ticket.ticket.ticketId === selectedTicketId,
    ) ??
    visibleTickets[0] ??
    enrichedTickets[0];

  const selectedAction =
    selectedTicket?.ticket.actions?.find(
      (action) => action.actionId === selectedActionId,
    ) ??
    selectedTicket?.ticket.actions?.[0] ??
    null;

  const outputContract = useMemo(
    () => createOutputContract(state.contract, state.runtime, state.dryRun),
    [state.contract, state.runtime, state.dryRun],
  );

  const totals = useMemo(() => {
    return enrichedTickets.reduce(
      (acc, ticket) => {
        acc.total += 1;
        acc[ticket.status] += 1;
        return acc;
      },
      {
        total: 0,
        pending_review: 0,
        ready_to_resolve: 0,
        manual_followup_required: 0,
        failed: 0,
        rejected: 0,
        no_action_possible: 0,
      } as Record<TicketOutputStatus | "total", number>,
    );
  }, [enrichedTickets]);

  const handleToggleDryRun = () => {
    setState((current) => ({
      ...current,
      dryRun: !current.dryRun,
    }));
  };

  const handleLoadMock = () => {
    const nextState = createAppState(mockContract);
    setState(nextState);
    setSelectedTicketId(nextState.contract.tickets[0]?.ticketId ?? "");
    setSelectedActionId(initialActionId(nextState.contract.tickets[0]));
    setErrorMessage(null);
  };

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();

    try {
      const raw = JSON.parse(text) as unknown;
      const validated = validateInputContract(raw);
      if (!validated.ok) {
        setErrorMessage(validated.error);
        return;
      }

      const nextState = createAppState(validated.contract, state.dryRun);
      setState(nextState);
      setSelectedTicketId(nextState.contract.tickets[0]?.ticketId ?? "");
      setSelectedActionId(initialActionId(nextState.contract.tickets[0]));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(`Falha ao ler o arquivo JSON: ${String(error)}`);
    }
  };

  const handleSelectTicket = (ticketId: string) => {
    setSelectedTicketId(ticketId);
    const ticket = state.contract.tickets.find(
      (item) => item.ticketId === ticketId,
    );
    setSelectedActionId(initialActionId(ticket));
  };

  const handleReject = (ticketId: string, actionId: string) => {
    updateActionState(ticketId, actionId, {
      approvalStatus: "rejected",
      executionStatus: "skipped",
      detail: "Ação rejeitada pelo aprovador.",
    });
  };

  const handleApprove = (ticket: InputTicket, action: TicketAction) => {
    startTransition(async () => {
      if (state.dryRun) {
        updateActionState(ticket.ticketId, action.actionId, {
          approvalStatus: "approved",
          executionStatus: "succeeded",
          detail: `Sucesso simulado em dryRun para ${action.type}.`,
          httpError: undefined,
        });
        return;
      }

      if (action.type === "http_request") {
        updateActionState(ticket.ticketId, action.actionId, {
          approvalStatus: "approved",
          executionStatus: "not_started",
          detail: "Executando request real via proxy local...",
          httpError: undefined,
        });

        try {
          const result = await executeHttpAction(action.request);
          updateActionState(ticket.ticketId, action.actionId, {
            approvalStatus: "approved",
            executionStatus: result.ok ? "succeeded" : "failed",
            detail: formatExecutionDetail(result),
            httpError: result.ok
              ? undefined
              : {
                  status: result.status,
                  statusText: result.statusText,
                  finalUrl: result.finalUrl,
                  preview: result.responsePreview,
                },
          });
        } catch (error) {
          updateActionState(ticket.ticketId, action.actionId, {
            approvalStatus: "approved",
            executionStatus: "failed",
            detail: `Falha ao executar request: ${String(error)}`,
            httpError: {
              preview: truncateText(String(error), 240),
            },
          });
        }
        return;
      }

      updateActionState(ticket.ticketId, action.actionId, {
        approvalStatus: "approved",
        executionStatus: "manual_pending",
        detail: `${action.type === "slack_query" ? "Consulta manual" : "Ação manual"} aprovada. Execução externa ainda é necessária.`,
        httpError: undefined,
      });
    });
  };

  function updateActionState(
    ticketId: string,
    actionId: string,
    next: ActionRuntimeState,
  ) {
    setState((current) => ({
      ...current,
      runtime: {
        ...current.runtime,
        [ticketId]: {
          ...current.runtime[ticketId],
          [actionId]: next,
        },
      },
    }));
  }

  const handleDownloadOutput = () => {
    const blob = new Blob([JSON.stringify(outputContract, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tech-ops-desk-output-${state.dryRun ? "dry-run" : "live"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Tech Ops Desk</p>
          <h1>Tech OPS Desk</h1>
          <p className="hero-text">
            Revise exatamente o que será executado, simule em{" "}
            <code>dryRun</code> quando precisar e gere um JSON final pronto para
            o próximo agente.
          </p>
        </div>
        <div className="hero-actions">
          <label className={`dryrun-toggle ${state.dryRun ? "active" : ""}`}>
            <input
              type="checkbox"
              checked={state.dryRun}
              onChange={handleToggleDryRun}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
            <span>
              <strong>dryRun</strong>
              <small>
                {state.dryRun
                  ? "Sucesso simulado. Nenhuma request real sai do app."
                  : "Aprovações em modo real vão afetar produção e disparar requests reais."}
              </small>
            </span>
          </label>
          <div className="input-actions">
            <label className="file-button">
              Carregar JSON
              <input
                type="file"
                accept="application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  void handleUpload(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              onClick={handleLoadMock}
            >
              Recarregar mock
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleDownloadOutput}
            >
              Baixar output
            </button>
          </div>
        </div>
      </header>

      {state.dryRun ? (
        <section className="dryrun-banner">
          <strong>Simulação ativa.</strong> Todas as aprovações serão tratadas
          como sucesso para gerar um JSON de saída de teste.
        </section>
      ) : null}

      {errorMessage ? (
        <section className="error-banner">{errorMessage}</section>
      ) : null}

      <section className="summary-grid">
        <SummaryCard
          label="Tickets"
          value={String(totals.total)}
          tone="neutral"
        />
        <SummaryCard
          label="Pendentes"
          value={String(totals.pending_review)}
          tone="warning"
        />
        <SummaryCard
          label="Prontos"
          value={String(totals.ready_to_resolve)}
          tone="success"
        />
        <SummaryCard
          label="Manuais"
          value={String(totals.manual_followup_required)}
          tone="info"
        />
        <SummaryCard
          label="Falhas"
          value={String(totals.failed)}
          tone="danger"
        />
        <SummaryCard
          label="Sem ação"
          value={String(totals.no_action_possible)}
          tone="muted"
        />
      </section>

      <section className="filter-row panel">
        <div className="panel-head compact">
          <div>
            <p className="panel-kicker">Recorte da fila</p>
            <h2>Filtros</h2>
          </div>
        </div>
        <div className="filter-group row">
          {[
            ["all", "Todos"],
            ["pending", "Pendentes"],
            ["ready", "Prontos"],
            ["manual", "Manuais"],
            ["failed", "Falhas"],
            ["no_action", "Sem ação"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`filter-pill ${filter === value ? "active" : ""}`}
              onClick={() => setFilter(value as FilterKey)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="workspace">
        <aside className="rail">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Fila operacional</p>
              <h2>Aprovações</h2>
            </div>
            <p className="rail-summary">
              {visibleTickets.length} tickets exibidos
            </p>
          </div>

          <div className="ticket-list">
            {visibleTickets.map((item) => (
              <button
                key={item.ticket.ticketId}
                type="button"
                className={`ticket-card ${selectedTicket?.ticket.ticketId === item.ticket.ticketId ? "selected" : ""}`}
                onClick={() => handleSelectTicket(item.ticket.ticketId)}
              >
                <div className="ticket-card-head">
                  <span className="ticket-id">#{item.ticket.ticketId}</span>
                  <StatusBadge status={item.status} />
                </div>
                <h3>{item.ticket.title}</h3>
                <p>
                  {item.ticket.proposedResponse ??
                    item.ticket.noActionReason ??
                    "Sem resposta proposta."}
                </p>
                <div className="ticket-meta">
                  <span>{item.ticket.actions?.length ?? 0} ações</span>
                  <span>{pendingCount(item.runtime)} pendentes</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="detail-column focus-column">
          <div className="focus-banner">
            <div>
              <p className="panel-kicker">Contexto ativo</p>
              <h2>Ticket em revisão</h2>
            </div>
            {selectedTicket ? (
              <span className="focus-ticket-id">
                #{selectedTicket.ticket.ticketId}
              </span>
            ) : null}
          </div>
          {selectedTicket ? (
            <>
              <section className="detail-hero panel">
                <div className="detail-hero-copy">
                  <p className="panel-kicker">Ticket selecionado</p>
                  <h2>{selectedTicket.ticket.title}</h2>
                  <div className="detail-tags">
                    <span className="ticket-id">
                      #{selectedTicket.ticket.ticketId}
                    </span>
                    <StatusBadge status={selectedTicket.status} />
                    <span
                      className={`mode-badge ${state.dryRun ? "dry" : "live"}`}
                    >
                      {state.dryRun ? "dryRun" : "live"}
                    </span>
                  </div>
                </div>
                <div className="proposal-panel">
                  <p className="muted-label">Resposta proposta</p>
                  <p>
                    {selectedTicket.ticket.proposedResponse ??
                      "Sem resposta proposta."}
                  </p>
                </div>
              </section>

              {ticketHasNoActions(selectedTicket.ticket) ? (
                <section className="panel empty-state">
                  <p className="panel-kicker">Sem ação executável</p>
                  <h3>
                    Nenhuma automação ou revisão operacional possível para este
                    ticket
                  </h3>
                  <p>
                    {selectedTicket.ticket.noActionReason ??
                      "O contrato não trouxe ações para este ticket."}
                  </p>
                </section>
              ) : (
                <>
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <p className="panel-kicker">Ações do ticket</p>
                        <h3>Itens revisáveis</h3>
                      </div>
                    </div>
                    <div className="action-strip">
                      {selectedTicket.ticket.actions?.map((action) => {
                        const runtime = selectedTicket.runtime[action.actionId];
                        return (
                          <button
                            key={action.actionId}
                            type="button"
                            className={`action-chip ${selectedAction?.actionId === action.actionId ? "selected" : ""}`}
                            onClick={() => setSelectedActionId(action.actionId)}
                          >
                            <span className={`action-type ${action.type}`}>
                              {action.type}
                            </span>
                            <strong>{action.label}</strong>
                            <small>{renderActionRuntime(runtime)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {selectedAction ? (
                    <section className="panel">
                      <div className="panel-head">
                        <div>
                          <p className="panel-kicker">Revisão detalhada</p>
                          <h3>{selectedAction.label}</h3>
                        </div>
                        <div className="review-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() =>
                              handleReject(
                                selectedTicket.ticket.ticketId,
                                selectedAction.actionId,
                              )
                            }
                          >
                            Rejeitar
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() =>
                              handleApprove(
                                selectedTicket.ticket,
                                selectedAction,
                              )
                            }
                            disabled={isPending}
                          >
                            {state.dryRun
                              ? "Aprovar (simular sucesso)"
                              : "Aprovar"}
                          </button>
                        </div>
                      </div>

                      <p className="description">
                        {selectedAction.description ??
                          "Sem descrição complementar."}
                      </p>

                      <ActionReview action={selectedAction} />

                      <ActionStatusPanel
                        runtime={
                          selectedTicket.runtime[selectedAction.actionId]
                        }
                      />
                      {selectedAction.type === "http_request" ? (
                        <HttpErrorCard
                          runtime={
                            selectedTicket.runtime[selectedAction.actionId]
                          }
                        />
                      ) : null}
                    </section>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <section className="panel empty-state">
              <h2>Nenhum ticket disponível</h2>
              <p>
                Carregue um contrato JSON ou recarregue o mock para começar a
                revisão.
              </p>
            </section>
          )}
        </main>

        <aside className="output-column">
          <section className="panel output-panel">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Output gerado</p>
                <h2>JSON de saída</h2>
              </div>
            </div>
            <div className="output-meta">
              <span>
                {outputContract.mode === "dry_run" ? "Simulado" : "Real"}
              </span>
              <span>{outputContract.tickets.length} tickets</span>
            </div>
            <pre>{JSON.stringify(outputContract, null, 2)}</pre>
          </section>
        </aside>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "warning" | "success" | "info" | "danger" | "muted";
}) {
  return (
    <article className={`summary-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function StatusBadge({ status }: { status: TicketOutputStatus }) {
  return (
    <span className={`status-badge ${status}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

function ActionStatusPanel({
  runtime,
}: {
  runtime: ActionRuntimeState | undefined;
}) {
  return (
    <div className="status-panel">
      <div>
        <p className="muted-label">Approval</p>
        <strong>{runtime?.approvalStatus ?? "pending"}</strong>
      </div>
      <div>
        <p className="muted-label">Execution</p>
        <strong>{runtime?.executionStatus ?? "not_started"}</strong>
      </div>
      <div className="status-detail">
        <p className="muted-label">Detalhe</p>
        <p>{runtime?.detail ?? "Aguardando decisão."}</p>
      </div>
    </div>
  );
}

function HttpErrorCard({
  runtime,
}: {
  runtime: ActionRuntimeState | undefined;
}) {
  if (!runtime?.httpError || runtime.executionStatus !== "failed") {
    return null;
  }

  return (
    <section className="http-error-card">
      <div className="http-error-head">
        <div>
          <p className="muted-label">Erro HTTP retornado</p>
          <h4>
            {runtime.httpError.status
              ? `${runtime.httpError.status}`
              : "Erro de execução"}
            {runtime.httpError.statusText
              ? ` · ${runtime.httpError.statusText}`
              : ""}
          </h4>
        </div>
        {runtime.httpError.finalUrl ? (
          <code>{truncateText(runtime.httpError.finalUrl, 72)}</code>
        ) : null}
      </div>
      <p>
        {truncateText(
          runtime.httpError.preview ?? "Sem corpo de erro retornado.",
          220,
        )}
      </p>
    </section>
  );
}

function ActionReview({ action }: { action: TicketAction }) {
  if (action.type === "http_request") {
    const requestUrl = buildRequestUrl(action.request);
    return (
      <div className="review-grid">
        <div className="review-card">
          <p className="muted-label">Request final</p>
          <div className="request-head">
            <span
              className={`method-pill ${action.request.method.toUpperCase()}`}
            >
              {action.request.method.toUpperCase()}
            </span>
            <code>{requestUrl}</code>
          </div>
        </div>
        <DataTable
          title="Query params"
          data={action.request.query ?? {}}
          emptyMessage="Sem query params."
        />
        <DataTable
          title="Headers"
          data={action.request.headers ?? {}}
          emptyMessage="Sem headers."
        />
        <JsonPanel
          title="Body"
          value={action.request.body}
          emptyMessage="Sem body."
        />
        <JsonPanel
          title="cURL derivado"
          value={buildDerivedCurl(action.request)}
          isCode
          emptyMessage="Sem curl derivado."
        />
      </div>
    );
  }

  if (action.type === "slack_query") {
    return (
      <div className="review-grid">
        <JsonPanel
          title="Query pronta para uso manual"
          value={action.queryText}
          isCode
          emptyMessage="Sem query."
        />
      </div>
    );
  }

  return (
    <div className="review-grid">
      <JsonPanel
        title="Instrução manual"
        value={action.note}
        emptyMessage="Sem instrução."
      />
    </div>
  );
}

function DataTable({
  title,
  data,
  emptyMessage,
}: {
  title: string;
  data: Record<string, unknown>;
  emptyMessage: string;
}) {
  const entries = Object.entries(data);

  return (
    <section className="review-card">
      <p className="muted-label">{title}</p>
      {entries.length === 0 ? (
        <p className="empty-copy">{emptyMessage}</p>
      ) : (
        <div className="key-value-list">
          {entries.map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <code>
                {typeof value === "string" ? value : JSON.stringify(value)}
              </code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function JsonPanel({
  title,
  value,
  emptyMessage,
  isCode = false,
}: {
  title: string;
  value: unknown;
  emptyMessage: string;
  isCode?: boolean;
}) {
  const content = prettyJson(value);
  return (
    <section className="review-card">
      <p className="muted-label">{title}</p>
      {content ? (
        <pre className={isCode ? "code-block" : ""}>{content}</pre>
      ) : (
        <p className="empty-copy">{emptyMessage}</p>
      )}
    </section>
  );
}

function createAppState(contract: InputContract, dryRun = true): AppState {
  return {
    contract,
    runtime: Object.fromEntries(
      contract.tickets.map((ticket) => [
        ticket.ticketId,
        Object.fromEntries(
          (ticket.actions ?? []).map((action) => [
            action.actionId,
            {
              approvalStatus: "pending",
              executionStatus: "not_started",
            } satisfies ActionRuntimeState,
          ]),
        ),
      ]),
    ),
    dryRun,
  };
}

function initialActionId(ticket: InputTicket | undefined): string | null {
  return ticket?.actions?.[0]?.actionId ?? null;
}

function pendingCount(runtime: Record<string, ActionRuntimeState>): number {
  return Object.values(runtime).filter(
    (item) => item.approvalStatus === "pending",
  ).length;
}

function renderActionRuntime(runtime: ActionRuntimeState | undefined): string {
  if (!runtime) return "pending / not_started";
  return `${runtime.approvalStatus} / ${runtime.executionStatus}`;
}

function enrichTicket(
  ticket: InputTicket,
  runtime: Record<string, ActionRuntimeState>,
) {
  const status = computeTicketStatus(ticket, runtime);
  return { ticket, runtime, status };
}

function computeTicketStatus(
  ticket: InputTicket,
  runtime: Record<string, ActionRuntimeState>,
): TicketOutputStatus {
  if (ticketHasNoActions(ticket)) {
    return "no_action_possible";
  }

  const actionStates = (ticket.actions ?? []).map(
    (action) => runtime[action.actionId],
  );

  if (actionStates.some((state) => state?.executionStatus === "failed")) {
    return "failed";
  }

  if (actionStates.some((state) => state?.approvalStatus === "rejected")) {
    return "rejected";
  }

  if (
    actionStates.some((state) => state?.executionStatus === "manual_pending")
  ) {
    return "manual_followup_required";
  }

  if (
    actionStates.length > 0 &&
    actionStates.every(
      (state) =>
        state?.approvalStatus === "approved" &&
        state.executionStatus === "succeeded",
    )
  ) {
    return "ready_to_resolve";
  }

  return "pending_review";
}

function createOutputContract(
  contract: InputContract,
  runtime: Record<string, Record<string, ActionRuntimeState>>,
  dryRun: boolean,
): OutputContract {
  return {
    contractVersion: contract.contractVersion,
    processedAt: new Date().toISOString(),
    mode: dryRun ? "dry_run" : "live",
    tickets: contract.tickets.map((ticket) =>
      createOutputTicket(ticket, runtime[ticket.ticketId] ?? {}),
    ),
  };
}

function createOutputTicket(
  ticket: InputTicket,
  runtime: Record<string, ActionRuntimeState>,
): OutputTicket {
  const status = computeTicketStatus(ticket, runtime);
  const actions: ActionOutput[] = (ticket.actions ?? [])
    .map((action) => {
      const state = runtime[action.actionId];
      if (
        !state ||
        state.approvalStatus === "pending" ||
        state.executionStatus === "not_started"
      ) {
        return null;
      }

      return {
        actionId: action.actionId,
        approvalStatus: state.approvalStatus,
        executionStatus: state.executionStatus,
      } satisfies ActionOutput;
    })
    .filter((value): value is ActionOutput => value !== null);

  return {
    ticketId: ticket.ticketId,
    status,
    actions,
    reason:
      status === "no_action_possible"
        ? (ticket.noActionReason ?? "Sem ação possível.")
        : undefined,
  };
}

async function executeHttpAction(
  request: HttpRequestDefinition,
): Promise<ExecutionResult> {
  const payload: ExecutionPayload = { request };
  const response = await fetch("/api/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<ExecutionResult>;
}

function formatExecutionDetail(result: ExecutionResult): string {
  return [
    `${result.status} ${result.statusText}`.trim(),
    result.finalUrl,
    result.responsePreview ? `Preview: ${result.responsePreview}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

export default App;
