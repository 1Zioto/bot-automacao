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

## Arquitetura de execucao

- painel e API Express: Vercel;
- dados persistentes: PostgreSQL da Neon, no schema isolado `saas`;
- filas compartilhadas: Redis remoto, acessivel pela Vercel e pelo computador do motor;
- motor: `queue-worker` e `whatsapp-worker` executados localmente no Windows;
- Docker: nao e necessario para essa configuracao.

## Executar o motor local

1. Instale Node.js 20+ e execute `pnpm install`.
2. Copie `motor.env.example` para `.env.motor.local` e preencha a Neon, o Redis e os segredos compartilhados com a Vercel.
3. Execute as migrations uma unica vez com as mesmas variaveis de ambiente.
4. Inicie todo o motor com `pnpm motor:start`.

O computador precisa permanecer ligado para conectar as instancias e enviar mensagens. Se ele ficar desligado, os pedidos permanecem no Redis remoto e voltam a ser processados quando o motor for iniciado novamente.

Para desenvolvimento totalmente local, copie `.env.example` para `.env`, substitua os segredos e use `pnpm dev:api`, `pnpm dev:queue`, `pnpm dev:whatsapp` e `pnpm dev:web`.

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
