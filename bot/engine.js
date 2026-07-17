// ============================================================
//  MOTOR MULTI-SESSAO (rodar na VPS, sempre ligado)
//  - 1 cliente WhatsApp por usuario (sessoes.usuario_id)
//  - grava o QR no banco (a Vercel le e mostra na web)
//  - processa a fila de envios de cada sessao
// ============================================================
const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}
const fs = require('fs');
const path = require('path');

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Pool } = require('pg');
const { proximaExecucao } = require('./_agenda');
const { aplicarVariaveis } = require('./_texto');
const { variarMensagem } = require('./_ia');
require('dotenv').config();

async function obterChatIdValido(client, chatId) {
    try {
        const numId = await client.getNumberId(chatId);
        if (numId && numId._serialized) {
            return numId._serialized;
        }
        await client.getContactById(chatId);
    } catch (e) {}
    
    try {
        if (client.pupPage && !client.pupPage.isClosed()) {
            await client.pupPage.evaluate(async (id) => {
                if (window.WWebJS && window.WWebJS.enforceLidAndPnRetrieval) {
                    await window.WWebJS.enforceLidAndPnRetrieval(id);
                }
            }, chatId);
        }
    } catch (e) {}

    return chatId;
}

const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const WEB_VERSION_REMOTE_PATH = process.env.WEB_VERSION_REMOTE_PATH || null;
// Isolamento: prefixo do clientId e pasta de sessao proprios deste motor,
// para nao colidir com outro projeto de WhatsApp na mesma maquina.
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'wa';

// ── Caminhos auto-adaptaveis (independentes de usuario/maquina) ─────────────
// Se o valor do .env nao existir nesta maquina, cai para um padrao portavel.
// Assim o bot funciona ao ser transferido para outro PC/usuario sem editar env.

function resolverChromePath() {
    const doEnv = (process.env.CHROME_PATH || '').trim();
    if (doEnv && fs.existsSync(doEnv)) return doEnv;

    // Locais comuns por sistema operacional.
    const candidatos = process.platform === 'win32'
        ? [
            path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
        ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ];
    const achado = candidatos.find((c) => c && fs.existsSync(c));
    // undefined = deixa o whatsapp-web.js/puppeteer usar o Chromium proprio.
    if (doEnv && !fs.existsSync(doEnv)) {
        console.warn(`[chrome] CHROME_PATH do .env nao existe (${doEnv}). Usando ${achado || 'Chromium do puppeteer'}.`);
    }
    return achado || undefined;
}

function resolverDataPath() {
    const doEnv = (process.env.WWEBJS_DATA_PATH || '').trim();
    // So aceita o caminho do .env se a pasta-pai existir nesta maquina;
    // caso contrario usa a pasta local do proprio bot (portavel).
    if (doEnv && fs.existsSync(path.dirname(doEnv))) return doEnv;
    if (doEnv) {
        console.warn(`[sessao] WWEBJS_DATA_PATH do .env nao existe (${doEnv}). Usando pasta local do bot.`);
    }
    return path.join(__dirname, '.wwebjs_auth');
}

const CHROME_PATH = resolverChromePath();
const WWEBJS_DATA_PATH = resolverDataPath();
const MOTOR_USUARIO_IDS = new Set(
    String(process.env.MOTOR_USUARIO_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
);
// Reinicio programado (horas). 0 = desligado. Use com pm2 para liberar memoria.
const REINICIAR_HORAS = Number(process.env.REINICIAR_HORAS || 0);
// Conta admin (super admin) = creditos ilimitados.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'douglaszioto@gmail.com').toLowerCase();
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_MB || 16) * 1024 * 1024;

let dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
    dbUrl = dbUrl.replace('sslmode=require', 'sslmode=verify-full');
}

const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
});

pool.on('error', (err) => {
    console.error('Erro inesperado no pool do Postgres (engine):', err.message);
});
const q = (text, params) => pool.query(text, params);

// usuario_id -> { client, status }
const clientes = new Map();

function usuarioPermitido(usuarioId) {
    return MOTOR_USUARIO_IDS.size === 0 || MOTOR_USUARIO_IDS.has(String(usuarioId));
}

function normalizarChatId(numero) {
    const valor = String(numero || '').trim();
    if (/@(c\.us|lid)$/.test(valor)) return valor;
    let limpo = valor.replace(/\D/g, '');
    if (limpo.length <= 11) limpo = '55' + limpo;
    return `${limpo}@c.us`;
}

async function criarMidiaDoEnvio(client, envio) {
    if (envio.media_data) {
        if (!envio.media_mimetype) throw new Error('Envio com media_data sem media_mimetype.');
        return new MessageMedia(envio.media_mimetype, envio.media_data, envio.media_filename || 'arquivo');
    }
    if (envio.media_url) {
        return MessageMedia.fromUrl(String(envio.media_url), {
            unsafeMime: true,
            filename: envio.media_filename || undefined,
            client,
            reqOptions: { size: MAX_FILE_BYTES },
        });
    }
    return null;
}

async function enviarConteudo(client, chatId, envio, texto) {
    const finalChatId = await obterChatIdValido(client, chatId);
    const media = await criarMidiaDoEnvio(client, envio);
    if (media) {
        await client.sendMessage(finalChatId, media, {
            caption: texto || undefined,
            sendMediaAsDocument: Boolean(envio.media_as_document),
        });
    } else {
        await client.sendMessage(finalChatId, texto);
    }
}

function numeroDoWid(wid) {
    if (!wid) return null;
    const serializado = typeof wid === 'string' ? wid : (wid._serialized || '');
    if (serializado.endsWith('@c.us')) return serializado.replace('@c.us', '');
    if (serializado.endsWith('@lid')) return serializado;
    return null;
}

function chatIdDaMensagem(message) {
    return String(message && (message.fromMe ? message.to : message.from) || '').trim();
}

function deveIgnorarMensagem(message) {
    const chatId = chatIdDaMensagem(message);
    return !chatId || chatId.endsWith('@g.us') || chatId.endsWith('@newsletter') || message.isStatus || message.isGroupMsg;
}

async function resolverNumeroMensagem(client, message) {
    const bruto = String(message.fromMe ? message.to : message.from || '').trim();
    if (!bruto.endsWith('@lid')) return bruto.replace('@c.us', '');

    try {
        const resolvido = await client.pupPage.evaluate(async (userId) => {
            if (!window.WWebJS || !window.WWebJS.enforceLidAndPnRetrieval) return null;
            const r = await window.WWebJS.enforceLidAndPnRetrieval(userId);
            return {
                phone: r && r.phone ? r.phone._serialized : null,
                lid: r && r.lid ? r.lid._serialized : null,
            };
        }, bruto);
        const phone = numeroDoWid(resolvido && resolvido.phone);
        if (phone) return phone;
    } catch (e) {
        console.error('Falha ao resolver LID para telefone:', e.message);
    }

    try {
        const contato = await message.getContact();
        if (contato && contato.number && !String(contato.number).endsWith('@lid')) {
            const n = String(contato.number).replace(/\D/g, '');
            if (n.length >= 10) return n;
        }
    } catch {}

    return bruto;
}

function nomeDoContato(contato, message) {
    return String(
        (contato && (contato.name || contato.pushname || contato.shortName || contato.verifiedName)) ||
        (message && message._data && (
            message._data.notifyName ||
            message._data.pushname ||
            (message._data.sender && (message._data.sender.pushname || message._data.sender.name))
        )) ||
        ''
    ).trim();
}

async function salvarContatoAlias(usuarioId, numero, nome) {
    if (!numero || !nome) return;
    await q(
        `INSERT INTO contatos (usuario_id, nome, numero) VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, numero) DO UPDATE SET nome = EXCLUDED.nome`,
        [usuarioId, nome, numero]
    );
}

async function salvarContatoDaMensagem(usuarioId, numero, message, aliasNumero = null) {
    try {
        const contato = await message.getContact();
        const nome = nomeDoContato(contato, message);
        if (!nome) return;
        await salvarContatoAlias(usuarioId, numero, nome);
        if (aliasNumero && aliasNumero !== numero) await salvarContatoAlias(usuarioId, aliasNumero, nome);
    } catch {}
}

async function setStatus(usuarioId, status, extra = {}) {
    const campos = ['status = $2', 'atualizado_em = now()'];
    const vals = [usuarioId, status];
    let i = 3;
    if ('qr' in extra) { campos.push(`qr = $${i++}`); vals.push(extra.qr); }
    if ('numero_conectado' in extra) { campos.push(`numero_conectado = $${i++}`); vals.push(extra.numero_conectado); }
    await q(`UPDATE sessoes SET ${campos.join(', ')} WHERE usuario_id = $1`, vals);
}

function criarCliente(usuarioId, sessaoId) {
    console.log(`[sessao ${usuarioId}] criando cliente...`);
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `${SESSION_PREFIX}-${usuarioId}`, dataPath: WWEBJS_DATA_PATH }),
        ...(WEB_VERSION_REMOTE_PATH
            ? { webVersionCache: { type: 'remote', remotePath: WEB_VERSION_REMOTE_PATH } }
            : {}),
        puppeteer: {
            headless: HEADLESS,
            executablePath: CHROME_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
    });

    clientes.set(usuarioId, { client, status: 'iniciando', sessaoId, qrInicio: null });

    client.on('qr', async (qr) => {
        try {
            const reg0 = clientes.get(usuarioId); if (reg0 && !reg0.qrInicio) reg0.qrInicio = Date.now();
            const dataUrl = await qrcode.toDataURL(qr, { margin: 2, width: 320 });
            await setStatus(usuarioId, 'qr', { qr: dataUrl });
            const reg = clientes.get(usuarioId); if (reg) reg.status = 'qr';
            console.log(`[sessao ${usuarioId}] QR gerado.`);
        } catch (e) { console.error('Erro QR:', e.message); }
    });

    client.on('authenticated', () => { setStatus(usuarioId, 'autenticado').catch(() => {}); });

    client.on('ready', async () => {
        const numero = (client.info && client.info.wid && client.info.wid.user) || null;
        await setStatus(usuarioId, 'pronto', { qr: null, numero_conectado: numero }).catch(() => {});
        // marca a data de conexao (1a vez) para o aquecimento gradual
        await q('UPDATE sessoes SET conectado_em = COALESCE(conectado_em, now()) WHERE usuario_id = $1', [usuarioId]).catch(() => {});
        const reg = clientes.get(usuarioId); if (reg) reg.status = 'pronto';
        console.log(`[sessao ${usuarioId}] pronto. Numero: ${numero}`);
    });

    client.on('auth_failure', (m) => { setStatus(usuarioId, 'erro').catch(() => {}); console.error(`[sessao ${usuarioId}] auth_failure:`, m); });

    client.on('disconnected', async (reason) => {
        console.log(`[sessao ${usuarioId}] desconectado:`, reason);
        await setStatus(usuarioId, 'desconectado', { qr: null }).catch(() => {});
        try { await client.destroy(); } catch {}
        clientes.delete(usuarioId);
    });

    client.on('message_create', async (message) => {
        if (deveIgnorarMensagem(message)) return;
        const fromMe = message.fromMe;
        const numeroOriginal = chatIdDaMensagem(message);
        const numero = await resolverNumeroMensagem(client, message);
        
        try {
            if (!fromMe) await salvarContatoDaMensagem(usuarioId, numero, message, numeroOriginal);
        } catch (e) { console.error('Erro ao salvar contato no message_create:', e.message); }

        // Opt-out automatico: SAIR / PARAR / STOP / CANCELAR
        if (!fromMe) {
            const txt = String(message.body || '').trim().toLowerCase();
            if (/^(sair|parar|stop|cancelar|descadastrar|remover)\b/.test(txt)) {
                try {
                    await q(
                        'INSERT INTO optout (usuario_id, numero) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                        [usuarioId, numero]
                    );
                    // cancela envios pendentes para esse numero
                    await q("UPDATE envios SET status='cancelada', erro='opt-out' WHERE usuario_id=$1 AND numero=$2 AND status='pendente'", [usuarioId, numero]);
                    try { await client.sendMessage(message.from, 'Voce foi removido da nossa lista e nao recebera mais mensagens. Obrigado!'); } catch {}
                    console.log(`[sessao ${usuarioId}] opt-out registrado: ${numero}`);
                } catch (e) { console.error('Erro no opt-out:', e.message); }
            }
        }
    });

    client.initialize().catch((e) => {
        console.error(`[sessao ${usuarioId}] falha no initialize:`, e.message);
        setStatus(usuarioId, 'erro', { qr: null }).catch(() => {});
        clientes.delete(usuarioId);
    });
}

async function destruirCliente(usuarioId, logout) {
    const reg = clientes.get(usuarioId);
    if (!reg) return;
    try {
        if (logout) { try { await reg.client.logout(); } catch {} }
        await reg.client.destroy();
    } catch (e) { /* ignora */ }
    clientes.delete(usuarioId);
}

// Tempo maximo aguardando o scan do QR antes de expirar (2 minutos).
const QR_TIMEOUT_MS = 120000;

// Sincroniza o mapa de clientes com a tabela sessoes.
// REGRA: o QR so e gerado quando o usuario PEDE (status 'reconectar').
// Contas ja conectadas antes ('pronto'/'autenticado') reconectam sozinhas (sem QR).
// Contas novas/ociosas ('pendente', 'qr', 'desconectado') NAO geram QR automaticamente.
async function sincronizarSessoes() {
    const r = await q('SELECT id, usuario_id, status, numero_conectado FROM sessoes');
    for (const s of r.rows) {
        if (!usuarioPermitido(s.usuario_id)) continue;
        const reg = clientes.get(s.usuario_id);

        // Expira o QR se ninguem escaneou dentro do tempo limite.
        if (reg && reg.status === 'qr' && reg.qrInicio && (Date.now() - reg.qrInicio) > QR_TIMEOUT_MS) {
            console.log(`[sessao ${s.usuario_id}] QR expirou sem leitura; parando.`);
            await destruirCliente(s.usuario_id, false);
            await setStatus(s.usuario_id, 'pendente', { qr: null }).catch(() => {});
            continue;
        }

        if (s.status === 'desconectar') {
            await destruirCliente(s.usuario_id, true);
            await setStatus(s.usuario_id, 'desconectado', { qr: null, numero_conectado: null }).catch(() => {});
        } else if (s.status === 'reconectar') {
            // unico caso que gera QR: pedido explicito do usuario
            await destruirCliente(s.usuario_id, true);
            await setStatus(s.usuario_id, 'conectando', { qr: null }).catch(() => {});
            criarCliente(s.usuario_id, s.id);
        } else if (!reg && (s.status === 'erro' || s.status === 'pronto' || s.status === 'autenticado' || s.status === 'conectando')) {
            // reconecta silenciosamente sessoes que ja estavam ativas (usa sessao salva; so gera QR se a sessao tiver expirado)
            if (s.status === 'erro') {
                await setStatus(s.usuario_id, 'conectando', { qr: null }).catch(() => {});
            }
            criarCliente(s.usuario_id, s.id);
        }
    }
}

// Processa a fila de envios de cada sessao pronta.
let processando = false;
async function processarFilas() {
    if (processando) return;
    processando = true;
    try {
        for (const [usuarioId, reg] of clientes) {
            if (reg.status !== 'pronto') continue;

            // Configuracao anti-bloqueio do usuario.
            const cfg = (await q('SELECT intervalo_segundos, limite_diario, ia_variar, janela_inicio, janela_fim, aquecimento FROM configuracoes WHERE usuario_id = $1', [usuarioId])).rows[0]
                || { intervalo_segundos: 15, limite_diario: 0, ia_variar: false, janela_inicio: 8, janela_fim: 20, aquecimento: true };
            // Intervalo SEMPRE aleatorio e >= 15s, para nao criar sequencias previsiveis.
            const baseS = Math.max(15, Number(cfg.intervalo_segundos) || 15);
            const limite = Number(cfg.limite_diario) || 0;

            // Janela de horario permitido (fuso BRT). Fora dela, nao envia agora.
            const ini = Number(cfg.janela_inicio); const fim = Number(cfg.janela_fim);
            if (Number.isFinite(ini) && Number.isFinite(fim) && !(ini === 0 && fim === 24)) {
                const horaBRT = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
                const dentro = ini <= fim ? (horaBRT >= ini && horaBRT < fim) : (horaBRT >= ini || horaBRT < fim);
                if (!dentro) continue; // fora do horario permitido
            }

            // Interpretacao robusta do flag (evita string 'f'/'false' vinda do banco ser tratada como true).
            const aquecimentoOn = !(cfg.aquecimento === false || cfg.aquecimento === 'f' || cfg.aquecimento === 'false' || cfg.aquecimento === 0);

            // Teto diario efetivo = limite do usuario + aquecimento gradual de numero novo.
            // MODO QUENTE (aquecimento OFF): SEM teto — o usuario assume a responsabilidade
            // e todas as mensagens da fila sao distribuidas ao longo de 8 horas.
            let tetoDia = limite > 0 ? limite : Infinity;
            if (aquecimentoOn) {
                const sr = await q('SELECT conectado_em, criado_em FROM sessoes WHERE usuario_id = $1', [usuarioId]);
                // Usa conectado_em se disponivel; fallback para criado_em; nunca usa new Date() (isso causaria dias=1 sempre).
                const dataRef = (sr.rows[0] && sr.rows[0].conectado_em)
                    ? new Date(sr.rows[0].conectado_em)
                    : (sr.rows[0] && sr.rows[0].criado_em)
                        ? new Date(sr.rows[0].criado_em)
                        : null;
                if (dataRef) {
                    const dias = Math.max(1, Math.floor((Date.now() - dataRef.getTime()) / 86400000) + 1);
                    const tetoAquecimento = Math.min(200, 20 * dias); // dia1=20, dia2=40 ... ate 200
                    tetoDia = Math.min(tetoDia, tetoAquecimento);
                }
                // Se dataRef for null (sem sessao no banco), nao aplica teto de aquecimento.
            }

            // Quantas ja foram enviadas hoje (fuso BRT)?
            const hoje = await q(
                `SELECT COUNT(*)::int AS n FROM envios
                 WHERE sessao_id = $1 AND status = 'enviada'
                   AND enviado_em >= date_trunc('day', (now() AT TIME ZONE 'America/Sao_Paulo')) AT TIME ZONE 'America/Sao_Paulo'`,
                [reg.sessaoId]
            );
            let enviadasHoje = hoje.rows[0].n;
            let restante = 5;
            if (Number.isFinite(tetoDia)) {
                restante = Math.min(5, tetoDia - enviadasHoje);
                if (restante <= 0) continue; // teto diario (limite/aquecimento) atingido
            }

            // MODO QUENTE: calcula o espacamento para distribuir TODA a fila do dia em 8 horas.
            // Ex.: 80 mensagens -> 1 a cada ~6 min. Fila muito grande nunca fica mais rapida que o intervalo minimo.
            let esperaQuenteMs = null;
            if (!aquecimentoOn) {
                const pc = await q(
                    `SELECT COUNT(*)::int AS n FROM envios
                     WHERE sessao_id = $1 AND status = 'pendente' AND (origem IS NULL OR origem != 'chat')
                       AND (agendar_para IS NULL OR agendar_para <= now())`,
                    [reg.sessaoId]
                );
                const totalPlanejado = pc.rows[0].n + enviadasHoje;
                if (totalPlanejado > 0) {
                    const JANELA_QUENTE_MS = 8 * 3600 * 1000; // 8 horas
                    const MAX_ESPERA_MS = 360 * 1000; // teto de 6 min: fila pequena nao fica esperando horas
                    esperaQuenteMs = Math.min(MAX_ESPERA_MS, Math.max(baseS * 1000, Math.floor(JANELA_QUENTE_MS / totalPlanejado)));
                    console.log(`[sessao ${usuarioId}] MODO QUENTE: ${pc.rows[0].n} na fila, espacamento ~${Math.round(esperaQuenteMs / 1000)}s (distribuindo em 8h; sem teto diario).`);
                }
            }

            const pend = await q(
                `SELECT * FROM envios
                 WHERE sessao_id = $1 AND status = 'pendente' AND (origem IS NULL OR origem != 'chat')
                   AND (agendar_para IS NULL OR agendar_para <= now())
                   AND numero NOT IN (SELECT numero FROM optout WHERE usuario_id = $3)
                 ORDER BY criado_em ASC LIMIT $2`,
                [reg.sessaoId, restante, usuarioId]
            );
            for (const envio of pend.rows) {
                try {
                    const chatId = normalizarChatId(envio.numero);
                    // Variacao por IA (anti-bloqueio), se ativada nas configuracoes.
                    let texto = envio.mensagem;
                    if (cfg.ia_variar) texto = await variarMensagem(texto);
                    
                    await enviarConteudo(reg.client, chatId, envio, texto);
                    await q("UPDATE envios SET status='enviada', enviado_em=now() WHERE id=$1", [envio.id]);
                    enviadasHoje++;
                    console.log(`[sessao ${usuarioId}] envio #${envio.id} -> ${envio.numero} (hoje: ${enviadasHoje})`);
                } catch (e) {
                    await q("UPDATE envios SET status='erro', tentativas=tentativas+1, erro=$2 WHERE id=$1",
                        [envio.id, String(e.message).slice(0, 500)]).catch(() => {});
                    console.error(`[sessao ${usuarioId}] envio #${envio.id} falhou:`, e.message);
                }
                if (esperaQuenteMs !== null) {
                    // MODO QUENTE: espacamento calculado para caber tudo em 8h, com variacao de +-20%
                    // (nao usa a pausa de 20 em 20 — o proprio espacamento ja e humano e imprevisivel).
                    const jitter = 0.8 + Math.random() * 0.4;
                    const esperaMs = Math.max(15000, Math.floor(esperaQuenteMs * jitter));
                    await new Promise((r) => setTimeout(r, esperaMs));
                } else if (enviadasHoje > 0 && enviadasHoje % 20 === 0) {
                    // Pausa longa a cada 20 envios do dia (parece comportamento humano).
                    const pausaMs = (120 + Math.floor(Math.random() * 180)) * 1000; // 2 a 5 min
                    console.log(`[sessao ${usuarioId}] pausa de descanso (${Math.round(pausaMs / 1000)}s) apos ${enviadasHoje} envios.`);
                    await new Promise((r) => setTimeout(r, pausaMs));
                } else {
                    // espera aleatoria: entre baseS e baseS+15s (sempre >= 15s)
                    const esperaMs = (baseS + Math.floor(Math.random() * 16)) * 1000;
                    await new Promise((r) => setTimeout(r, esperaMs));
                }
            }
        }
    } catch (e) {
        console.error('Erro ao processar filas:', e.message);
    } finally {
        processando = false;
    }
}

let processandoChat = false;
async function processarChatImediato() {
    if (processandoChat) return;
    processandoChat = true;
    try {
        const pend = await q(
            `SELECT * FROM envios
             WHERE status = 'pendente' AND origem = 'chat' AND (agendar_para IS NULL OR agendar_para <= now())
             ORDER BY criado_em ASC`
        );
        for (const envio of pend.rows) {
            if (!usuarioPermitido(envio.usuario_id)) continue;
            const reg = clientes.get(envio.usuario_id);
            if (!reg || reg.status !== 'pronto') {
                continue;
            }
            try {
                const chatId = normalizarChatId(envio.numero);
                await enviarConteudo(reg.client, chatId, envio, envio.mensagem);
                await q("UPDATE envios SET status='enviada', enviado_em=now() WHERE id=$1", [envio.id]);
                console.log(`[chat imediato] sessao ${envio.usuario_id} envio #${envio.id} -> ${envio.numero}`);
            } catch (e) {
                await q("UPDATE envios SET status='erro', tentativas=tentativas+1, erro=$2 WHERE id=$1",
                    [envio.id, String(e.message).slice(0, 500)]).catch(() => {});
                console.error(`[chat imediato] sessao ${envio.usuario_id} envio #${envio.id} falhou:`, e.message);
            }
        }
    } catch (e) {
        console.error('Erro ao processar chat imediato:', e.message);
    } finally {
        processandoChat = false;
    }
}

async function escutarEnviosChat() {
    const listener = await pool.connect();
    listener.on('notification', (msg) => {
        if (msg.channel === 'chat_envio') {
            processarChatImediato().catch((e) => console.error('chat notify:', e.message));
        }
    });
    listener.on('error', (e) => {
        console.error('Listener chat_envio caiu:', e.message);
        try { listener.release(); } catch {}
        setTimeout(() => escutarEnviosChat().catch((err) => console.error('listen chat:', err.message)), 5000);
    });
    await listener.query('LISTEN chat_envio');
    console.log('Listener chat_envio ativo.');
}

// Expande agendamentos vencidos em envios e reagenda.
let processandoAgenda = false;
async function processarAgendamentos() {
    if (processandoAgenda) return;
    processandoAgenda = true;
    try {
        const r = await q(
            'SELECT * FROM agendamentos WHERE ativo = true AND proxima_execucao IS NOT NULL AND proxima_execucao <= now()'
        );
        for (const a of r.rows) {
            if (!usuarioPermitido(a.usuario_id)) continue;
            // sessao do usuario
            const s = await q('SELECT id FROM sessoes WHERE usuario_id = $1', [a.usuario_id]);
            const sessaoId = s.rows[0] ? s.rows[0].id : null;

            // mensagem (modelo ou texto)
            let mensagem = a.mensagem;
            if (a.conteudo_tipo === 'modelo' && a.modelo_id) {
                const m = await q('SELECT corpo FROM modelos WHERE id = $1', [a.modelo_id]);
                if (m.rows[0]) mensagem = m.rows[0].corpo;
            }

            // destinatarios (lista ou todos) com nome para personalizacao
            let destinatarios = [];
            if (a.destino_tipo === 'todos') {
                const c = await q('SELECT numero, nome FROM contatos WHERE usuario_id = $1', [a.usuario_id]);
                destinatarios = c.rows;
            } else if (a.lista_id) {
                const c = await q(
                    'SELECT c.numero, c.nome FROM lista_contatos lc JOIN contatos c ON c.id = lc.contato_id WHERE lc.lista_id = $1',
                    [a.lista_id]
                );
                destinatarios = c.rows;
            }

            // Remove quem fez opt-out.
            const opt = await q('SELECT numero FROM optout WHERE usuario_id = $1', [a.usuario_id]);
            const bloqueados = new Set(opt.rows.map((x) => x.numero));
            destinatarios = destinatarios.filter((ct) => !bloqueados.has(ct.numero));

            if (mensagem && destinatarios.length && sessaoId) {
                for (const ct of destinatarios) {
                    const texto = aplicarVariaveis(mensagem, ct); // {nome}, {primeiro_nome}, {numero}
                    await q(
                        "INSERT INTO envios (usuario_id, sessao_id, numero, mensagem, origem) VALUES ($1, $2, $3, $4, 'agenda')",
                        [a.usuario_id, sessaoId, ct.numero, texto]
                    );
                }
                console.log(`[agenda #${a.id}] gerou ${destinatarios.length} envio(s).`);
            }

            // reagenda (ou desativa, se unico)
            let prox = null;
            if (a.tipo !== 'unico') {
                prox = proximaExecucao(a.tipo, a.horario, a.dias_semana, null, new Date(Date.now() + 60000));
            }
            if (prox) {
                await q('UPDATE agendamentos SET ultima_execucao = now(), proxima_execucao = $2 WHERE id = $1', [a.id, prox]);
            } else {
                await q('UPDATE agendamentos SET ultima_execucao = now(), ativo = false, proxima_execucao = NULL WHERE id = $1', [a.id]);
            }
        }
    } catch (e) {
        console.error('Erro ao processar agendamentos:', e.message);
    } finally {
        processandoAgenda = false;
    }
}

// Importa os contatos do WhatsApp para a agenda do sistema, quando solicitado pelo painel.
let processandoImport = false;
async function processarImportacoes() {
    if (processandoImport) return;
    processandoImport = true;
    try {
        const r = await q('SELECT usuario_id FROM sessoes WHERE importar_contatos = true');
        for (const row of r.rows) {
            if (!usuarioPermitido(row.usuario_id)) continue;
            const reg = clientes.get(row.usuario_id);
            if (!reg || reg.status !== 'pronto') continue; // aguarda o numero conectar
            try {
                const contatos = await reg.client.getContacts();
                let n = 0;
                for (const c of contatos) {
                    if (!c || c.isGroup || !c.isMyContact) continue;
                    // SO contatos reais do tipo telefone (@c.us). Exclui @lid/@g.us/@broadcast.
                    const ser = (c.id && c.id._serialized) || '';
                    if (!ser.endsWith('@c.us')) continue;
                    // numero vem do id (@c.us), NAO de c.number (que pode retornar o LID).
                    const numero = String((c.id && c.id.user) || '').replace(/\D/g, '');
                    // telefone plausivel (E.164): 10 a 15 digitos.
                    if (numero.length < 10 || numero.length > 15) continue;
                    const nome = c.name || c.pushname || numero;
                    await q(
                        `INSERT INTO contatos (usuario_id, nome, numero) VALUES ($1, $2, $3)
                         ON CONFLICT (usuario_id, numero) DO UPDATE SET nome = EXCLUDED.nome`,
                        [row.usuario_id, nome, numero]
                    );
                    n++;
                }
                await q("UPDATE sessoes SET importar_contatos=false, importar_resultado=$2 WHERE usuario_id=$1",
                    [row.usuario_id, n + ' contato(s) importado(s).']);
                console.log(`[import ${row.usuario_id}] ${n} contatos importados`);
            } catch (e) {
                await q("UPDATE sessoes SET importar_contatos=false, importar_resultado=$2 WHERE usuario_id=$1",
                    [row.usuario_id, 'Erro: ' + String(e.message).slice(0, 200)]).catch(() => {});
                console.error(`[import ${row.usuario_id}] falhou:`, e.message);
            }
        }
    } catch (e) {
        console.error('Erro ao processar importacoes:', e.message);
    } finally {
        processandoImport = false;
    }
}

async function principal() {
    console.log('Motor multi-sessao iniciando...');
    try { await q('SELECT 1'); console.log('Banco conectado.'); }
    catch (e) { console.error('Falha ao conectar no banco:', e.message); process.exit(1); }

    // Garante que colunas adicionadas posteriormente existam no banco.
    try {
        await q(`
            ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS conectado_em TIMESTAMPTZ;
            ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS aquecimento BOOLEAN NOT NULL DEFAULT true;
            ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS aquecimento BOOLEAN NOT NULL DEFAULT true;
            ALTER TABLE envios ADD COLUMN IF NOT EXISTS media_mimetype TEXT;
            ALTER TABLE envios ADD COLUMN IF NOT EXISTS media_data TEXT;
            ALTER TABLE envios ADD COLUMN IF NOT EXISTS media_filename TEXT;
            ALTER TABLE envios ADD COLUMN IF NOT EXISTS media_url TEXT;
            ALTER TABLE envios ADD COLUMN IF NOT EXISTS media_as_document BOOLEAN NOT NULL DEFAULT false;
        `);
    } catch (e) { console.warn('Migracao incremental (aviso):', e.message); }

    await escutarEnviosChat().catch((e) => console.error('listen chat:', e.message));
    setInterval(() => sincronizarSessoes().catch((e) => console.error('sync:', e.message)), 5000);
    setInterval(() => processarFilas().catch((e) => console.error('fila:', e.message)), 5000);
    setInterval(() => processarChatImediato().catch((e) => console.error('chat:', e.message)), 1000);
    setInterval(() => processarAgendamentos().catch((e) => console.error('agenda:', e.message)), 30000);
    setInterval(() => processarImportacoes().catch((e) => console.error('import:', e.message)), 5000);

    // Heartbeat de saude a cada 60s: loga e grava no banco (o painel mostra se o motor esta online).
    const heartbeat = async () => {
        const mb = Math.round(process.memoryUsage().rss / 1048576);
        const up = Math.round(process.uptime() / 60);
        try {
            await q(
                `INSERT INTO motor_saude (chave, ram_mb, sessoes, uptime_min, atualizado_em)
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (chave) DO UPDATE SET ram_mb=$2, sessoes=$3, uptime_min=$4, atualizado_em=now()`,
                [SESSION_PREFIX, mb, clientes.size, up]
            );
        } catch (e) { /* nao derruba o motor por causa do heartbeat */ }
    };
    heartbeat();
    setInterval(heartbeat, 60 * 1000);

    // Reinicio programado (se REINICIAR_HORAS > 0): sai limpo quando nao ha envio em andamento.
    if (REINICIAR_HORAS > 0) {
        setInterval(() => {
            if (process.uptime() > REINICIAR_HORAS * 3600 && !processando) {
                console.log('[saude] reinicio programado: encerrando para liberar memoria (pm2 reinicia).');
                process.exit(0);
            }
        }, 60 * 1000);
    }
}

principal();
