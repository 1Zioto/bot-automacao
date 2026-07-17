# ADR 0001 - Monolito modular com workers separados

## Status

Aceita em 17/07/2026.

## Contexto

O produto existente usa JavaScript, funcoes serverless, PostgreSQL e um motor Node.js com `whatsapp-web.js`. Uma troca simultanea de banco, framework, painel e motor aumentaria o risco de perda de sessao e duplicacao de envios.

## Decisao

O novo nucleo sera um monolito modular em TypeScript, com API, worker de WhatsApp e worker de filas executados como processos separados. PostgreSQL continua como fonte duravel; Redis e BullMQ entram para locks, contadores e jobs. O acesso ao banco permanece em SQL versionado durante a migracao, evitando introduzir um ORM e uma mudanca de modelo ao mesmo tempo.

## Consequencias

- O painel e o motor antigos permanecem disponiveis ate a migracao de cada fluxo.
- Toda mudanca de esquema nasce em migration versionada.
- Os modulos compartilham contratos, configuracao e logger, mas nao estado em memoria.
- A migracao para outro ORM continua possivel porque os repositorios isolam SQL da regra de negocio.

