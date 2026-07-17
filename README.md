# AutoFlow SaaS WhatsApp

Nova base incremental do produto descrito na especificacao mestre. O sistema legado foi preservado nas pastas `bot`, `vercel-panel` e `chat-panel`; a evolucao principal vive em `apps` e `packages`.

## O que ja funciona

- empresas isoladas, usuarios, convites, papeis e permissoes;
- planos, limites, assinatura e solicitacao segura de mudanca de plano;
- varias instancias por empresa, QR temporario e sessao separada;
- contatos, consentimento, opt-out, listas e campanhas;
- filas Redis/BullMQ, trava distribuida por instancia e limite diario atomico;
- janelas de envio, repeticoes, idempotencia e recuperacao apos falha;
- API por token de usuario e por chave com escopos;
- webhooks assinados, auditaveis e com repeticao;
- mensagens protegidas com AES-256-GCM e logs estruturados sem segredos.

## Executar localmente

1. Copie `.env.example` para `.env` e substitua todos os segredos.
2. Execute `docker compose up --build`.
3. A API ficara em `http://localhost:3001`; verifique `GET /health/ready`.

Sem Docker, instale Node.js 20+, PostgreSQL 16 e Redis 7, rode `pnpm install`, `pnpm db:migrate` e inicie os tres processos com `pnpm dev:api`, `pnpm dev:queue` e `pnpm dev:whatsapp`.

Nunca reutilize no ambiente real os segredos ou senhas do exemplo local. A credencial antiga do banco, que chegou a existir no codigo legado, deve ser rotacionada antes da migracao de producao.

## Estrutura

- `apps/api`: API HTTP, autenticacao, RBAC e modulos do produto.
- `apps/queue-worker`: preparacao de campanhas e entregas de webhooks.
- `apps/whatsapp-worker`: ciclo de vida das instancias e envios.
- `packages/database`: banco e migrations no schema `saas`.
- `packages/queue`: contratos BullMQ, Redis e travas atomicas.
- `packages/security`: criptografia, chaves e assinaturas.
- `docs`: decisoes, operacao, API e plano de migracao.

## Validacao

`pnpm build`, `pnpm check` e `pnpm test` validam todos os pacotes. A automacao de CI tambem aplica as migrations em um PostgreSQL descartavel antes dos testes.
