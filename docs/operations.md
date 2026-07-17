# Operacao segura

## Processos obrigatorios

A API, o worker de filas e o worker do WhatsApp sao processos independentes. PostgreSQL guarda o estado duravel; Redis guarda filas, travas, QR temporario e contadores atomicos. Nunca escale o worker do WhatsApp sem Redis, pois a trava `wa:instance:{id}:owner` impede duas sessoes simultaneas da mesma instancia.

## Segredos

Use um gerenciador de segredos. `ACCESS_TOKEN_SECRET` e `REFRESH_TOKEN_SECRET` precisam ter pelo menos 32 caracteres distintos. `ENCRYPTION_KEY` deve ser uma chave aleatoria de 32 bytes em base64. Rotacione a URL antiga do Neon antes do corte de producao.

## Banco

As migrations usam o schema `saas` e nao alteram as tabelas legadas de `public`. Antes de cada deploy execute `node packages/database/dist/migrate.js`; uma migration aplicada nunca deve ser editada. O checksum interrompe o deploy se isso ocorrer.

## Sessoes WhatsApp

O volume de `WHATSAPP_SESSION_PATH` contem credenciais sensiveis. Restrinja acesso, criptografe o disco e inclua o volume na politica de backup. O QR fica apenas no Redis por 120 segundos e nunca deve aparecer em logs.

## Incidentes

Em suspeita de vazamento: suspenda a empresa ou usuario, revogue sessoes e chaves, rotacione segredos, preserve `audit_logs` e revise entregas de webhook. Um endpoint de webhook e desabilitado automaticamente apos dez falhas finais consecutivas.

## Corte incremental

1. Suba a nova base sem apontar trafego real.
2. Aplique migrations no schema `saas` e valide saude.
3. Migre uma empresa piloto e uma instancia por vez.
4. Compare contatos, listas, consentimentos e historico.
5. Pare o motor legado daquela instancia antes de inicializa-la no novo worker.
6. Mantenha rollback para o legado ate concluir a verificacao funcional.

## Administracao global

O primeiro administrador da plataforma deve ser promovido manualmente, depois de criar e verificar sua conta: `INSERT INTO saas.platform_admins (user_id) SELECT id FROM saas.users WHERE email = 'email-verificado';`. Nao existe administrador padrao nem senha mestre. As demais operacoes globais passam por `/api/v1/admin` e ficam na auditoria da empresa afetada.
