import type { InputContract } from "./inputContract";

export const mockContract: InputContract = {
  contractVersion: "1.0",
  generatedAt: "2026-03-27T20:00:00Z",
  tickets: [
    {
      ticketId: "43732890547",
      title: "Habilitar token e link de primeiro acesso via WhatsApp",
      proposedResponse: "Habilitamos o envio via WhatsApp e reenviamos o fluxo de primeiro acesso.",
      actions: [
        {
          actionId: "a1",
          type: "http_request",
          label: "Habilitar WhatsApp para primeiro acesso",
          description: "Ativa o canal WhatsApp no fluxo de onboarding para o CNPJ informado.",
          request: {
            method: "POST",
            url: "https://internal-api/actions/enable-whatsapp",
            headers: {
              "Content-Type": "application/json",
              "X-Source": "tech-ops-desk",
            },
            query: {
              tenant: "mobile-techops",
              dryRunHint: false,
            },
            body: {
              cnpj: "42548856000146",
              flow: "first_access",
              actor: {
                source: "codex",
                correlationId: "req-001-whatsapp",
              },
            },
          },
        },
        {
          actionId: "a2",
          type: "http_request",
          label: "Reenviar convite",
          description: "Reenvia o link de primeiro acesso para o ticket relacionado.",
          request: {
            method: "POST",
            url: "https://internal-api/actions/resend-invite",
            headers: {
              "Content-Type": "application/json",
            },
            body: {
              ticketId: "43732890547",
              channels: ["whatsapp", "email"],
              metadata: {
                reason: "canal_ajustado",
              },
            },
          },
        },
      ],
    },
    {
      ticketId: "42932822406",
      title: "Código não chega",
      proposedResponse: "Validamos o contato, corrigimos o método de verificação e reenviamos o código.",
      actions: [
        {
          actionId: "b1",
          type: "slack_query",
          label: "Consultar vínculo antigo de telefone",
          description: "Verificar no Slack/DB se existe vínculo legado associado ao número informado.",
          queryText: "SELECT * FROM users WHERE phone = '11975190775';",
        },
        {
          actionId: "b2",
          type: "manual_note",
          label: "Anotar evidência de conferência",
          description: "Após a consulta, registrar evidência na thread operacional.",
          note: "Confirmar se o telefone antigo ainda está preso ao usuário antes de orientar o cliente.",
        },
      ],
    },
    {
      ticketId: "43800011223",
      title: "Cliente sem ação possível no momento",
      proposedResponse: "Identificamos que o caso depende de retorno do cliente com documentação adicional.",
      noActionReason: "Nenhuma ação operacional é possível agora porque falta o documento de validação enviado pelo cliente.",
      actions: [],
    },
  ],
};
