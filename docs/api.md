# API v1

As rotas de painel usam `Authorization: Bearer <accessToken>`. Integracoes usam uma chave `wa_live_...` no mesmo cabecalho ou em `X-API-Key`. A chave completa aparece somente na criacao.

## Fluxo principal

1. `POST /api/v1/auth/register` cria empresa, proprietario e trial.
2. `POST /api/v1/instances` cria uma instancia; `POST /instances/{id}/initialize` inicia o QR.
3. Cadastre contatos com consentimento em `POST /contacts` e organize-os em `POST /lists`.
4. Crie uma campanha, visualize e inicie com confirmacao explicita de consentimento.
5. Para integracoes, crie uma chave em `/api-keys` e envie em `POST /messages` com `Idempotency-Key`.

## Idempotencia

O envio direto exige uma chave de pelo menos oito caracteres. Repetir a mesma requisicao retorna a mensagem ja criada e nao produz novo envio. Uma chave reutilizada com outra instancia gera conflito.

## Webhooks

Cada entrega envia `X-Webhook-Id`, `X-Webhook-Timestamp` e `X-Webhook-Signature`. A assinatura e HMAC-SHA256 de `<timestamp>.<corpo-json>`. Valide a assinatura antes de processar e rejeite timestamps antigos.

## Erros

Erros seguem `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Use `requestId` para correlacionar logs sem expor conteudo ou telefone completo.
