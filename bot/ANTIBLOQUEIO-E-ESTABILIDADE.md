# AutoFlow — Estratégia de Anti-bloqueio e Estabilidade

Pesquisa consolidada (fev/2026) + plano de implementação mapeado ao nosso sistema (painel Vercel + motor `engine.js` + Neon).

> Contexto honesto: usar whatsapp-web.js (WhatsApp Web não-oficial) **sempre** carrega risco de banimento — o WhatsApp bane cerca de 2 milhões de contas por mês por mensagens não solicitadas. O objetivo aqui é **reduzir** o risco ao máximo e manter o motor estável, não eliminar o risco (impossível por este canal). O canal sem risco é a API oficial (WhatsApp Cloud API).

---

## 1. Como o WhatsApp detecta e bane

- Denúncias/bloqueios de usuários (principal gatilho). Muitas denúncias = ban automático.
- Padrões de automação: intervalos fixos e curtos (ex.: 500 ms é "marcador claro de automação"), mensagens idênticas em massa, volume alto e constante.
- Número novo sem histórico, disparando muito cedo.
- Baixa taxa de resposta (ninguém responde = parece spam).
- Coleta/uso de contatos sem consentimento.

## 2. Regras quantitativas (o que seguir)

Número novo (primeiros ~10 dias = maior risco):
- Só começar a enviar **1 dia após** registrar o número; vincular ao WhatsApp Web só **24 h depois**.
- No máximo **~20 novos contatos/dia** nos primeiros 10 dias.
- Aquecimento ("warm-up"): começar com 30–50 msgs/dia e subir aos poucos.

Número já aquecido:
- Recomendação oficial: **≤ 200 mensagens/dia** por número.
- Distribuir bases grandes entre **vários números**.
- Intervalo entre mensagens **≥ 15 segundos**; nunca usar intervalos fixos curtos.
- No máximo ~1 mensagem por minuto em campanhas sensíveis.
- Não rodar disparo por **mais de 8 h/dia**, nem **mais de 3 dias seguidos**.
- Meta de engajamento: ~**50 respostas a cada 100 enviadas** (ratio alto reduz muito o risco).

## 3. Boas práticas de conteúdo

- **Consentimento (opt-in):** só enviar para quem aceitou receber.
- **Opt-out / STOP:** oferecer "responda SAIR para não receber mais" — reduz denúncias e melhora o ratio.
- **Personalização:** usar o nome ({nome}) e variar o texto (cada msg diferente). Mensagens idênticas em massa são marcadas.
- **Mensagens curtas:** várias curtas parecem conversa; uma longa parece máquina.
- **Pergunta na 1ª mensagem:** incentiva resposta (sobe o ratio) e identifica quem é receptivo.
- **Pedir para salvar o contato:** número salvo na agenda do cliente é mais confiável.
- Evitar links suspeitos e forwards de origem desconhecida.

## 4. Estabilidade técnica (whatsapp-web.js / motor)

- **Sessão:** `LocalAuth` é ok para 1 máquina; **`RemoteAuth`** é recomendado para produção/escala.
- **Vazamento de memória:** sessões longas e muitas sessões fazem a RAM crescer continuamente (relatos de ~20 GB com 70 sessões). Causas: listeners no contexto do browser não removidos + cache da sessão.
- **1 Chrome por número:** pesado. Dimensionar RAM (~300–500 MB por sessão ativa) e limitar nº de sessões por servidor.
- **Flags do Chrome:** usar `--no-sandbox --disable-setuid-sandbox` (já usamos) e **`--disable-dev-shm-usage`** (evita crash em pouca memória).
- **Versão do WhatsApp Web:** fixar via `webVersionCache` quando o `inject` falhar (já temos a opção `WEB_VERSION_REMOTE_PATH`).
- **Reinício programado:** reiniciar o motor periodicamente (ex.: 1x/dia de madrugada) para liberar memória.
- **Reconexão e tratamento de erros:** capturar `disconnected`/`auth_failure`, recriar sessão e nunca deixar o processo cair (pm2 com restart automático).
- **Monitoramento:** vigiar uso de RAM/CPU e estado das sessões.

---

## 5. Mapeamento para o AutoFlow

### Já implementado ✅
- Intervalo **aleatório e sempre > 10 s** entre envios (evita padrão fixo).
- **Limite diário por número** configurável (Configurações).
- **Variação de mensagem por IA** mantendo o sentido (cada envio diferente), preservando tags.
- **Variáveis/mala direta** ({nome}, {primeiro_nome}, {saudacao}, etc.) — personalização.
- QR só sob demanda + expira em 2 min (menos sessão ociosa/memória).
- `--no-sandbox`/`--disable-setuid-sandbox` e `webVersionCache` opcional.
- Sessão isolada por instância (`SESSION_PREFIX` / `WWEBJS_DATA_PATH`).

### Rápido de adicionar (alto impacto) 🔸
1. **Intervalo mínimo ≥ 15 s** como padrão (hoje o mínimo é 11 s) — alinhar à recomendação.
2. **Janela de horário de envio** (ex.: só 8h–20h) e **parar após 8 h** de campanha contínua.
3. **Opt-out automático:** detectar "SAIR/STOP/PARAR" em mensagens recebidas → marcar o contato como descadastrado e nunca mais enviar.
4. **Modo aquecimento:** para número novo, teto baixo automático (ex.: 20/dia subindo gradualmente nos primeiros 10 dias).
5. **`--disable-dev-shm-usage`** nas flags do Chrome.
6. **Reinício programado** do motor (cron/pm2) + log de uso de memória.
7. **Pausa maior a cada N envios** (ex.: a cada 20 mensagens, pausa de alguns minutos).

### Estrutural (médio prazo) 🔶
8. **RemoteAuth** (sessão no banco/storage) em vez de LocalAuth, para escalar e sobreviver a troca de servidor.
9. **Rodízio entre vários números** do mesmo usuário para diluir volume.
10. **Painel de saúde das sessões** (RAM, status, últimas falhas) e alerta de desconexão.
11. **Métrica de ratio de resposta** por campanha (mensagens recebidas ÷ enviadas) para avisar quando o engajamento está baixo.
12. Opção futura de migrar contas críticas para a **API oficial (Cloud API)**.

---

## 6. Prioridade sugerida
1ª onda (segurança imediata, baixo esforço): itens 1, 2, 3, 5.
2ª onda: 4, 6, 7, 11.
3ª onda (escala): 8, 9, 10, 12.

## Fontes
- GREEN-API — Reduce the risk of blocking in WhatsApp: key rules (regras quantitativas, intervalos, warm-up, STOP).
- whatsapp-web.js DeepWiki — Best Practices & Common Patterns (LocalAuth/RemoteAuth, eventos, erro/recuperação).
- Issues do whatsapp-web.js sobre memory leak / múltiplas sessões (consumo de RAM, cleanup).
- Guias de envio em massa sem ban (warm-up, ≤200/dia, consentimento, personalização).
