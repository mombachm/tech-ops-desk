import { useMemo, useState, useTransition } from "react";
import "./app.css";
import {
  buildDerivedCurl,
  buildRequestUrl,
  prettyJson,
  type ActionRuntimeState,
  type ExecutionPayload,
  type ExecutionResult,
  type HttpRequestDefinition,
  type TicketOutputStatus,
} from "./contracts";
import {
  type InputContract,
  type InputTicket,
  type InputAction as TicketAction,
  validateInputContract,
} from "./inputContract";
import {
  type ActionOutput,
  type OutputContract,
  type OutputTicket,
} from "./outputContract";
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

const toneClasses = {
  neutral: "text-ink",
  warning: "text-brand",
  success: "text-success",
  info: "text-info",
  danger: "text-danger",
  muted: "text-ink-soft",
} as const;

const filterOptions: Array<{ value: FilterKey; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "pending", label: "Pendentes" },
  { value: "ready", label: "Prontos" },
  { value: "manual", label: "Manuais" },
  { value: "failed", label: "Falhas" },
  { value: "no_action", label: "Sem ação" },
];

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
    <div className="relative overflow-hidden px-4 py-4 md:px-6 xl:px-8 xl:py-8">
      <div className="pointer-events-none fixed -left-20 -top-24 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,_rgba(228,108,162,0.55),_transparent_62%)] blur-3xl" />
      <div className="pointer-events-none fixed -right-24 top-28 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,_rgba(255,196,213,0.28),_transparent_62%)] blur-3xl" />

      <header className="relative z-10 mb-6 grid items-end gap-6 xl:grid-cols-[1.25fr_1fr]">
        <div>
          <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
            Tech Ops Desk
          </p>
          <h1 className="mb-3 text-5xl font-black leading-none text-white md:text-6xl">
            Tech OPS Desk
          </h1>
          <p className="m-0 max-w-3xl leading-7 text-ink-soft">
            Revise exatamente o que será executado, simule em{" "}
            <code className="rounded-md bg-white/6 px-1.5 py-0.5 text-brand-pale">
              dryRun
            </code>{" "}
            quando precisar e gere um JSON final pronto para o próximo agente.
          </p>
        </div>

        <div className="grid gap-4 justify-items-stretch xl:justify-items-end">
          <label
            className={cx(
              "grid w-full max-w-[32rem] grid-cols-[auto_auto_1fr] items-center gap-3 rounded-[1.35rem] border px-5 py-4 shadow-[0_24px_60px_rgba(251,43,140,0.12)]",
              state.dryRun
                ? "border-brand-soft/25 bg-[linear-gradient(135deg,rgba(217,31,121,0.92),rgba(150,16,81,0.9))]"
                : "border-danger/35 bg-[linear-gradient(180deg,rgba(82,16,28,0.92),rgba(52,12,20,0.94))]",
            )}
          >
            <input
              type="checkbox"
              className="hidden"
              checked={state.dryRun}
              onChange={handleToggleDryRun}
            />
            <span
              className={cx(
                "relative h-8 w-14 rounded-full border",
                state.dryRun
                  ? "border-white/18 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0.08))]"
                  : "border-white/12 bg-white/8",
              )}
            >
              <span
                className={cx(
                  "absolute left-[0.18rem] top-[0.18rem] h-[1.45rem] w-[1.45rem] rounded-full bg-[#ffe7f2] shadow-[0_6px_18px_rgba(0,0,0,0.25)] transition-transform duration-200",
                  state.dryRun && "translate-x-[1.45rem] bg-white",
                )}
              />
            </span>
            <span>
              <strong
                className={cx(
                  "font-sans",
                  state.dryRun ? "text-white" : "text-danger",
                )}
              >
                dryRun
              </strong>
              <small
                className={cx(
                  "mt-1 block text-sm leading-5",
                  state.dryRun ? "text-[#ffe0ec]" : "text-danger",
                )}
              >
                {state.dryRun
                  ? "Sucesso simulado. Nenhuma request real sai do app."
                  : "Aprovações em modo real vão afetar produção e disparar requests reais."}
              </small>
            </span>
          </label>

          <div className="flex flex-wrap justify-stretch gap-3 xl:justify-end">
            <label className="w-full cursor-pointer rounded-full border border-line bg-surface/90 px-4 py-3 text-center text-sm font-semibold text-ink transition duration-150 hover:-translate-y-0.5 sm:w-auto">
              Carregar JSON
              <input
                type="file"
                className="hidden"
                accept="application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  void handleUpload(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              className="w-full rounded-full border border-line bg-surface/90 px-4 py-3 text-sm font-semibold text-ink transition duration-150 hover:-translate-y-0.5 sm:w-auto"
              type="button"
              onClick={handleLoadMock}
            >
              Recarregar mock
            </button>
            <button
              className="w-full rounded-full border border-brand bg-brand px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_rgba(217,31,121,0.26)] transition duration-150 hover:-translate-y-0.5 sm:w-auto"
              type="button"
              onClick={handleDownloadOutput}
            >
              Baixar output
            </button>
          </div>
        </div>
      </header>

      {state.dryRun ? (
        <section className="relative z-10 mb-5 rounded-2xl border border-brand/20 bg-brand/12 px-4 py-4 text-ink shadow-[0_18px_40px_rgba(0,0,0,0.08)] backdrop-blur">
          <strong>Simulação ativa.</strong> Todas as aprovações serão tratadas
          como sucesso para gerar um JSON de saída de teste.
        </section>
      ) : null}

      {errorMessage ? (
        <section className="relative z-10 mb-5 rounded-2xl border border-danger/25 bg-danger-soft px-4 py-4 text-[#ffb8c0] shadow-[0_18px_40px_rgba(0,0,0,0.08)] backdrop-blur">
          {errorMessage}
        </section>
      ) : null}

      <section className="relative z-10 mb-5 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
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

      <section className="relative z-10 mb-5 rounded-[1.6rem] border border-line bg-surface/92 p-4 shadow-[0_18px_42px_rgba(0,0,0,0.18)] backdrop-blur">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
              Recorte da fila
            </p>
            <h2 className="mt-1 font-sans text-xl font-bold text-white">
              Filtros
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap justify-start gap-2">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cx(
                "rounded-full border px-4 py-3 text-sm font-semibold transition duration-150 hover:-translate-y-0.5",
                filter === option.value
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface/90 text-ink",
              )}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="relative z-10 grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-[1.8rem] border border-line bg-surface/92 p-4 shadow-[0_24px_48px_rgba(0,0,0,0.2)] backdrop-blur">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
                Fila operacional
              </p>
              <h2 className="mt-1 font-sans text-xl font-bold text-white">
                Aprovações
              </h2>
            </div>
            <p className="m-0 pt-1 text-sm text-ink-soft">
              {visibleTickets.length} tickets exibidos
            </p>
          </div>

          <div className="grid gap-4">
            {visibleTickets.map((item) => {
              const isSelected =
                selectedTicket?.ticket.ticketId === item.ticket.ticketId;
              return (
                <button
                  key={item.ticket.ticketId}
                  type="button"
                  className={cx(
                    "w-full rounded-[1.55rem] border p-4 text-left shadow-[0_24px_52px_rgba(0,0,0,0.2)] backdrop-blur transition hover:-translate-y-0.5",
                    isSelected
                      ? "border-brand bg-[linear-gradient(180deg,rgba(217,31,121,0.92),rgba(145,16,78,0.94))] shadow-[0_26px_54px_rgba(217,31,121,0.22)]"
                      : "border-line bg-surface/95 hover:border-brand/20 hover:bg-brand/8",
                  )}
                  onClick={() => handleSelectTicket(item.ticket.ticketId)}
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span
                      className={cx(
                        "text-sm font-semibold",
                        isSelected ? "text-[#ffe0ec]" : "text-brand",
                      )}
                    >
                      #{item.ticket.ticketId}
                    </span>
                    <StatusBadge status={item.status} selected={isSelected} />
                  </div>
                  <h3
                    className={cx(
                      "my-3 font-sans text-base font-bold",
                      isSelected ? "text-[#fff7fa]" : "text-ink",
                    )}
                  >
                    {item.ticket.title}
                  </h3>
                  <p
                    className={cx(
                      "m-0 leading-6",
                      isSelected ? "text-[#fff7fa]" : "text-ink-soft",
                    )}
                  >
                    {item.ticket.proposedResponse ??
                      item.ticket.noActionReason ??
                      "Sem resposta proposta."}
                  </p>
                  <div
                    className={cx(
                      "mt-3 flex flex-wrap items-center gap-2.5 text-sm",
                      isSelected ? "text-[#ffe0ec]" : "text-ink-soft",
                    )}
                  >
                    <span>{item.ticket.actions?.length ?? 0} ações</span>
                    <span>{pendingCount(item.runtime)} pendentes</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="relative min-w-0 rounded-[2rem] border border-brand-soft/18 bg-[linear-gradient(180deg,rgba(217,31,121,0.14),rgba(28,13,26,0.98))] p-5 shadow-[0_28px_60px_rgba(217,31,121,0.14)]">
          <div className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]" />
          {selectedTicket ? (
            <div className="relative z-10 grid gap-4">
              <section className="grid gap-4 rounded-[1.55rem] border border-line bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-5 shadow-[0_24px_52px_rgba(0,0,0,0.2)] xl:grid-cols-[1fr_minmax(240px,0.65fr)]">
                <div>
                  <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
                    Ticket selecionado
                  </p>
                  <h2 className="mb-3 mt-1 text-3xl font-black text-white">
                    {selectedTicket.ticket.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2.5">
                    {selectedTicket ? (
                      <span className="inline-flex items-center justify-center rounded-full border border-brand/20 bg-black/20 px-4 py-2 text-sm font-semibold tracking-[0.08em] text-brand-pale">
                        #{selectedTicket.ticket.ticketId}
                      </span>
                    ) : null}
                    <StatusBadge status={selectedTicket.status} />
                    <span
                      className={cx(
                        "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-white",
                        state.dryRun ? "bg-brand" : "bg-brand-dark",
                      )}
                    >
                      {state.dryRun ? "dryRun" : "live"}
                    </span>
                  </div>
                </div>
                <div className="rounded-[1.2rem] border border-brand/12 bg-brand/8 p-4">
                  <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
                    Resposta proposta
                  </p>
                  <p className="m-0 leading-6 text-ink-soft">
                    {selectedTicket.ticket.proposedResponse ??
                      "Sem resposta proposta."}
                  </p>
                </div>
              </section>

              {ticketHasNoActions(selectedTicket.ticket) ? (
                <section className="rounded-[1.55rem] border border-line bg-surface/95 p-5 text-center shadow-[0_24px_52px_rgba(0,0,0,0.2)]">
                  <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
                    Sem ação executável
                  </p>
                  <h3 className="mt-1 font-sans text-xl font-bold text-white">
                    Nenhuma automação ou revisão operacional possível para este
                    ticket
                  </h3>
                  <p className="mt-2 text-ink-soft">
                    {selectedTicket.ticket.noActionReason ??
                      "O contrato não trouxe ações para este ticket."}
                  </p>
                </section>
              ) : (
                <>
                  <section className="rounded-[1.55rem] border border-line bg-surface/95 p-5 shadow-[0_24px_52px_rgba(0,0,0,0.2)]">
                    <div className="mb-4 flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
                          Ações do ticket
                        </p>
                        <h3 className="mt-1 font-sans text-xl font-bold text-white">
                          Itens revisáveis
                        </h3>
                      </div>
                    </div>
                    <div className="flex gap-3 overflow-x-auto pb-1">
                      {selectedTicket.ticket.actions?.map((action) => {
                        const runtime = selectedTicket.runtime[action.actionId];
                        const isSelected =
                          selectedAction?.actionId === action.actionId;
                        return (
                          <button
                            key={action.actionId}
                            type="button"
                            className={cx(
                              "min-w-[220px] rounded-[1.55rem] border p-4 text-left shadow-[0_24px_52px_rgba(0,0,0,0.2)] transition hover:-translate-y-0.5",
                              isSelected
                                ? "border-brand bg-[linear-gradient(180deg,rgba(217,31,121,0.92),rgba(145,16,78,0.94))] shadow-[0_26px_54px_rgba(217,31,121,0.22)]"
                                : "border-line bg-surface/95",
                            )}
                            onClick={() => setSelectedActionId(action.actionId)}
                          >
                            <span
                              className={cx(
                                "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em]",
                                getActionTypeClass(action.type, isSelected),
                              )}
                            >
                              {action.type}
                            </span>
                            <strong
                              className={cx(
                                "my-2 block",
                                isSelected ? "text-[#fff7fa]" : "text-ink",
                              )}
                            >
                              {action.label}
                            </strong>
                            <small
                              className={cx(
                                "block text-sm",
                                isSelected ? "text-[#fff7fa]" : "text-ink-soft",
                              )}
                            >
                              {renderActionRuntime(runtime)}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {selectedAction ? (
                    <section className="rounded-[1.55rem] border border-line bg-surface/95 p-5 shadow-[0_24px_52px_rgba(0,0,0,0.2)]">
                      <div className="mb-4 flex items-start justify-between gap-4">
                        <div>
                          <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
                            Revisão detalhada
                          </p>
                          <h3 className="mt-1 font-sans text-xl font-bold text-white">
                            {selectedAction.label}
                          </h3>
                        </div>
                        <div className="flex gap-3">
                          <button
                            type="button"
                            className="rounded-full border border-line bg-surface/90 px-4 py-3 text-sm font-semibold text-ink transition duration-150 hover:-translate-y-0.5"
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
                            className="rounded-full border border-brand bg-brand px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_rgba(217,31,121,0.26)] transition duration-150 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
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

                      <p className="m-0 leading-6 text-ink-soft">
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
            </div>
          ) : (
            <section className="relative z-10 rounded-[1.55rem] border border-line bg-surface/95 p-5 text-center shadow-[0_24px_52px_rgba(0,0,0,0.2)]">
              <h2 className="text-xl font-bold text-white">
                Nenhum ticket disponível
              </h2>
              <p className="mt-2 text-ink-soft">
                Carregue um contrato JSON ou recarregue o mock para começar a
                revisão.
              </p>
            </section>
          )}
        </main>
      </section>

      <section className="relative z-10 mt-5">
        <section className="rounded-[1.55rem] border border-white/10 bg-[linear-gradient(180deg,rgba(51,51,51,0.98),rgba(43,43,43,0.98))] p-5 shadow-[0_24px_52px_rgba(0,0,0,0.24)]">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-[0.73rem] uppercase tracking-[0.14em] text-white/70">
                Output gerado
              </p>
              <h2 className="mt-1 font-sans text-xl font-bold text-white">
                JSON de saída
              </h2>
            </div>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2.5 text-white">
            <span>
              {outputContract.mode === "dry_run" ? "Simulado" : "Real"}
            </span>
            <span>{outputContract.tickets.length} tickets</span>
          </div>
          <pre className="max-h-[32rem] overflow-auto rounded-[1.2rem] border border-white/10 bg-black/25 p-4 text-sm leading-6 text-white">
            {JSON.stringify(outputContract, null, 2)}
          </pre>
        </section>
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
  tone: keyof typeof toneClasses;
}) {
  return (
    <article className="rounded-[1.4rem] border border-line bg-surface/92 p-5 shadow-[0_22px_44px_rgba(0,0,0,0.18)] backdrop-blur">
      <span className="mb-2 block text-sm text-ink-soft">{label}</span>
      <strong
        className={cx("font-sans text-3xl font-black", toneClasses[tone])}
      >
        {value}
      </strong>
    </article>
  );
}

function StatusBadge({
  status,
  selected = false,
}: {
  status: TicketOutputStatus;
  selected?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em]",
        getStatusBadgeClass(status),
      )}
    >
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
    <div className="mt-4 grid gap-3 rounded-[1.25rem] border border-line bg-white/4 p-4 xl:grid-cols-3">
      <div>
        <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
          Approval
        </p>
        <strong className="text-ink">
          {runtime?.approvalStatus ?? "pending"}
        </strong>
      </div>
      <div>
        <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
          Execution
        </p>
        <strong className="text-ink">
          {runtime?.executionStatus ?? "not_started"}
        </strong>
      </div>
      <div>
        <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
          Detalhe
        </p>
        <p className="m-0 leading-6 text-ink-soft">
          {runtime?.detail ?? "Aguardando decisão."}
        </p>
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
    <section className="mt-4 rounded-[1.2rem] border border-danger/20 bg-danger-soft p-4">
      <div className="mb-2 flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
            Erro HTTP retornado
          </p>
          <h4 className="mt-1 text-base font-bold text-danger">
            {runtime.httpError.status
              ? `${runtime.httpError.status}`
              : "Erro de execução"}
            {runtime.httpError.statusText
              ? ` · ${runtime.httpError.statusText}`
              : ""}
          </h4>
        </div>
        {runtime.httpError.finalUrl ? (
          <code className="max-w-[18rem] text-sm text-danger">
            {truncateText(runtime.httpError.finalUrl, 72)}
          </code>
        ) : null}
      </div>
      <p className="m-0 leading-6 text-danger">
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
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="rounded-[1.2rem] border border-line bg-black/12 p-4">
          <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
            Request final
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <span
              className={cx(
                "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em]",
                getMethodClass(action.request.method),
              )}
            >
              {action.request.method.toUpperCase()}
            </span>
            <code className="text-ink">{requestUrl}</code>
          </div>
        </section>
        <DataTable
          title="Query params"
          data={action.request.query ?? {}}
          emptyMessage="Sem query params."
          emphasizeSensitive
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
          emphasizeSensitive
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
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
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
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
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
  emphasizeSensitive = false,
}: {
  title: string;
  data: Record<string, unknown>;
  emptyMessage: string;
  emphasizeSensitive?: boolean;
}) {
  const entries = Object.entries(data);

  return (
    <section className="rounded-[1.2rem] border border-line bg-black/12 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
          {title}
        </p>
        {emphasizeSensitive && entries.length > 0 ? (
          <span className="rounded-full border border-brand/30 bg-brand/14 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-brand-pale">
            conferir com ticket
          </span>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-ink-soft">{emptyMessage}</p>
      ) : (
        <div className="mt-2 grid gap-2.5">
          {entries.map(([key, value]) => {
            const sensitive = emphasizeSensitive && isSensitiveKey(key);
            return (
              <div
                key={key}
                className={cx(
                  "grid gap-1.5 rounded-2xl border p-3",
                  sensitive
                    ? "border-brand/30 bg-brand/10 shadow-[0_0_0_1px_rgba(217,31,121,0.08)]"
                    : "border-line bg-white/4",
                )}
              >
                <span
                  className={cx(
                    "text-sm",
                    sensitive ? "font-semibold text-brand-pale" : "text-ink-soft",
                  )}
                >
                  {key}
                </span>
                <code
                  className={cx(
                    "break-words",
                    sensitive ? "text-base font-semibold text-white" : "text-ink",
                  )}
                >
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </code>
              </div>
            );
          })}
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
  emphasizeSensitive = false,
}: {
  title: string;
  value: unknown;
  emptyMessage: string;
  isCode?: boolean;
  emphasizeSensitive?: boolean;
}) {
  const content = prettyJson(value);
  return (
    <section className="rounded-[1.2rem] border border-line bg-black/12 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[0.73rem] uppercase tracking-[0.14em] text-ink-soft">
          {title}
        </p>
        {emphasizeSensitive && content ? (
          <span className="rounded-full border border-brand/30 bg-brand/14 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-brand-pale">
            revisar dados
          </span>
        ) : null}
      </div>
      {content ? (
        emphasizeSensitive ? (
          <SensitiveJsonView value={value} />
        ) : (
          <pre
            className={cx(
              "m-0 break-words whitespace-pre-wrap leading-6 text-ink",
              isCode && "font-mono",
            )}
          >
            {content}
          </pre>
        )
      ) : (
        <p className="mt-2 text-ink-soft">{emptyMessage}</p>
      )}
    </section>
  );
}

function SensitiveJsonView({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <p className="mt-2 text-ink-soft">Sem conteúdo.</p>;
  }

  if (Array.isArray(value)) {
    return (
      <div className="grid gap-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-xl border border-line bg-white/4 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.08em] text-ink-soft">
              item {index + 1}
            </p>
            <SensitiveJsonView value={item} />
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <div className="grid gap-2">
        {Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
          const sensitive = isSensitiveKey(key);
          const isNestedObject =
            nestedValue !== null && typeof nestedValue === "object";

          return (
            <div
              key={key}
              className={cx(
                "rounded-xl border p-3",
                sensitive
                  ? "border-brand/30 bg-brand/10 shadow-[0_0_0_1px_rgba(217,31,121,0.08)]"
                  : "border-line bg-white/4",
              )}
            >
              <p
                className={cx(
                  "mb-2 text-xs uppercase tracking-[0.08em]",
                  sensitive ? "font-semibold text-brand-pale" : "text-ink-soft",
                )}
              >
                {key}
              </p>
              {isNestedObject ? (
                <SensitiveJsonView value={nestedValue} />
              ) : (
                <code
                  className={cx(
                    "block break-words font-mono",
                    sensitive ? "text-base font-semibold text-white" : "text-ink",
                  )}
                >
                  {typeof nestedValue === "string"
                    ? nestedValue
                    : JSON.stringify(nestedValue)}
                </code>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <code className="block break-words font-mono text-ink">
      {String(value)}
    </code>
  );
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase();
  return [
    "cpf",
    "cnpj",
    "document",
    "documento",
    "email",
    "mail",
    "phone",
    "telefone",
    "celular",
    "msisdn",
    "user",
    "userid",
    "user_id",
    "ticket",
    "ticketid",
    "ticket_id",
    "externalid",
    "account",
    "customer",
    "client",
    "token",
    "invitation",
  ].some((needle) => normalized.includes(needle));
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

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getStatusBadgeClass(status: TicketOutputStatus) {
  switch (status) {
    case "pending_review":
      return "bg-amber-300 text-amber-950";
    case "ready_to_resolve":
      return "bg-emerald-400 text-emerald-950";
    case "manual_followup_required":
      return "bg-sky-400 text-sky-950";
    case "failed":
    case "rejected":
      return "bg-rose-400 text-rose-950";
    case "no_action_possible":
      return "bg-zinc-300 text-zinc-950";
  }
}

function getActionTypeClass(type: TicketAction["type"], selected: boolean) {
  if (selected) {
    return "bg-white/14 text-[#fff7fa]";
  }

  switch (type) {
    case "http_request":
      return "bg-brand/10 text-brand";
    case "slack_query":
      return "bg-brand-pale text-brand-dark";
    case "manual_note":
      return "bg-brand-pale/50 text-brand-dark";
  }
}

function getMethodClass(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-brand-pale text-brand-dark";
    case "DELETE":
      return "bg-brand-pale/50 text-brand-dark";
    default:
      return "bg-brand/10 text-brand";
  }
}

function ticketHasNoActions(ticket: InputTicket): boolean {
  return (ticket.actions?.length ?? 0) === 0;
}

export default App;
