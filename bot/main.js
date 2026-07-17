const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcodeImage = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
require('dotenv').config();

const db = require('./db');

const SESSION_CLIENT_ID = process.env.SESSION_CLIENT_ID || 'bot-automacao';
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';

// ── Caminhos auto-adaptaveis (independentes de usuario/maquina) ──
// Se o valor do .env nao existir nesta maquina, cai para um padrao portavel,
// permitindo transferir o bot para outro PC/usuario sem editar o .env.
function resolverChromePath() {
    const doEnv = (process.env.CHROME_PATH || '').trim();
    if (doEnv && fs.existsSync(doEnv)) return doEnv;
    const candidatos = process.platform === 'win32'
        ? [
            path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
        ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
    return candidatos.find((c) => c && fs.existsSync(c)) || null;
}
function resolverDataPath() {
    const doEnv = (process.env.WWEBJS_DATA_PATH || '').trim();
    if (doEnv && fs.existsSync(path.dirname(doEnv))) return doEnv;
    return path.join(__dirname, '.wwebjs_auth');
}
const WWEBJS_DATA_PATH = resolverDataPath();
const CHROME_PATH = resolverChromePath();
const PANEL_PORT = Number(process.env.PANEL_PORT || 3000);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'troque-essa-senha';
const PANEL_REMOTE_TOKEN = process.env.PANEL_REMOTE_TOKEN || PANEL_PASSWORD;
const WEB_VERSION_REMOTE_PATH = process.env.WEB_VERSION_REMOTE_PATH || null;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_MB || 16) * 1024 * 1024;
const JSON_BODY_LIMIT = `${Math.ceil((MAX_FILE_BYTES * 1.5) / 1024 / 1024)}mb`;

let statusBot = 'iniciando';
let ultimoQrDataUrl = null;
let ultimoErro = null;
const conexoesPainel = new Set();

const app = express();

const client = new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_CLIENT_ID, dataPath: WWEBJS_DATA_PATH }),
    ...(WEB_VERSION_REMOTE_PATH
        ? { webVersionCache: { type: 'remote', remotePath: WEB_VERSION_REMOTE_PATH } }
        : {}),
    puppeteer: {
        headless: HEADLESS,
        executablePath: CHROME_PATH,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

function painelAutenticado(req, res, next) {
    const auth = req.headers.authorization || '';
    const tokenEsperado = Buffer.from(`admin:${PANEL_PASSWORD}`).toString('base64');

    if (auth === `Basic ${tokenEsperado}`) return next();

    res.setHeader('WWW-Authenticate', 'Basic realm="Painel do Bot"');
    return res.status(401).send('Acesso restrito');
}

function estadoAtual() {
    return {
        status: statusBot,
        qr: ultimoQrDataUrl,
        erro: ultimoErro,
        sessao: SESSION_CLIENT_ID,
    };
}

function publicarEstado() {
    const payload = `data: ${JSON.stringify(estadoAtual())}\n\n`;
    for (const res of conexoesPainel) {
        res.write(payload);
    }
}


function remoteAutenticado(req) {
    const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return token && token === PANEL_REMOTE_TOKEN;
}

function normalizarNumero(numero) {
    let limpo = String(numero || '').replace(/\D/g, '');
    if (!limpo) {
        throw new Error('Informe um numero de telefone com DDD.');
    }
    // Se vier sem DDI (10 ou 11 digitos: DDD + numero), assume Brasil (55).
    if (limpo.length <= 11) {
        limpo = `55${limpo}`;
    }
    return `${limpo}@c.us`;
}

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

// Envia a mensagem (historico removido).
async function enviarERegistrar(numero, mensagem) {
    const chatId = String(numero).includes('@') ? numero : normalizarNumero(numero);
    try {
        const finalChatId = await obterChatIdValido(client, chatId);
        await client.sendMessage(finalChatId, String(mensagem));
        return { ok: true, para: finalChatId };
    } catch (erro) {
        throw erro;
    }
}

function limparBase64(valor) {
    return String(valor || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
}

function tamanhoBase64EmBytes(base64) {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
}

async function criarMidiaArquivo({ arquivo_base64, arquivo_url, mimetype, nome_arquivo }) {
    if (arquivo_base64) {
        const data = limparBase64(arquivo_base64);
        if (!mimetype) throw new Error('Informe o mimetype do arquivo.');
        if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('arquivo_base64 invalido.');
        const tamanho = tamanhoBase64EmBytes(data);
        if (tamanho <= 0) throw new Error('Arquivo vazio.');
        if (tamanho > MAX_FILE_BYTES) {
            throw new Error(`Arquivo maior que o limite de ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`);
        }
        return new MessageMedia(String(mimetype), data, nome_arquivo || 'arquivo');
    }

    if (arquivo_url) {
        return MessageMedia.fromUrl(String(arquivo_url), {
            unsafeMime: true,
            filename: nome_arquivo,
            client,
            reqOptions: { size: MAX_FILE_BYTES },
        });
    }

    throw new Error('Informe arquivo_base64 ou arquivo_url.');
}

async function enviarArquivoERegistrar(numero, arquivo) {
    const chatId = String(numero).includes('@') ? numero : normalizarNumero(numero);
    const finalChatId = await obterChatIdValido(client, chatId);
    const media = await criarMidiaArquivo(arquivo);
    const opcoes = {
        caption: arquivo.legenda || arquivo.mensagem || undefined,
        sendMediaAsDocument: Boolean(arquivo.como_documento),
    };
    await client.sendMessage(finalChatId, media, opcoes);
    return { ok: true, para: finalChatId, arquivo: media.filename || null, mimetype: media.mimetype };
}

// ---------------- Worker: processa fila de envios ----------------
let processandoFila = false;

async function processarFila() {
    if (processandoFila || statusBot !== 'pronto') return;
    processandoFila = true;
    try {
        const pendentes = await db.proximosEnviosPendentes(5);
        for (const envio of pendentes) {
            try {
                await enviarERegistrar(envio.numero, envio.mensagem);
                await db.marcarEnvioEnviado(envio.id);
                console.log(`[fila] envio #${envio.id} enviado para ${envio.numero}`);
            } catch (erro) {
                await db.marcarEnvioErro(envio.id, erro.message);
                console.error(`[fila] envio #${envio.id} falhou:`, erro.message);
            }
            // Pequeno intervalo entre mensagens para evitar bloqueio.
            await new Promise((r) => setTimeout(r, 1500));
        }
    } catch (e) {
        console.error('Erro ao processar fila:', e.message);
    } finally {
        processandoFila = false;
    }
}

function iniciarPainel() {
    app.use('/remote', (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        return next();
    });

    app.get('/remote/state', (req, res) => {
        if (!remoteAutenticado(req)) return res.status(401).json({ erro: 'Nao autorizado' });
        return res.json(estadoAtual());
    });

    app.get('/remote/events', (req, res) => {
        if (!remoteAutenticado(req)) return res.status(401).end('Nao autorizado');
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        conexoesPainel.add(res);
        res.write(`data: ${JSON.stringify(estadoAtual())}\n\n`);

        req.on('close', () => {
            conexoesPainel.delete(res);
        });
    });

    app.use(painelAutenticado);
    app.use(express.json({ limit: JSON_BODY_LIMIT }));

    app.get('/health', (_req, res) => {
        res.json({ ok: true, status: statusBot });
    });

    app.get('/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        conexoesPainel.add(res);
        res.write(`data: ${JSON.stringify(estadoAtual())}\n\n`);

        req.on('close', () => {
            conexoesPainel.delete(res);
        });
    });

    // ----- Estado -----
    app.get('/api/estado', (_req, res) => res.json(estadoAtual()));

    // ----- Envio imediato (teste rapido) -----
    app.post('/enviar', async (req, res) => {
        const { numero, mensagem } = req.body || {};
        if (statusBot !== 'pronto') {
            return res.status(409).json({ ok: false, erro: `Bot nao esta pronto (status: ${statusBot}).` });
        }
        if (!numero || !mensagem) {
            return res.status(400).json({ ok: false, erro: 'Informe numero e mensagem.' });
        }
        try {
            const r = await enviarERegistrar(numero, mensagem);
            return res.json({ ok: true, para: r.para, mensagem });
        } catch (erro) {
            return res.status(500).json({ ok: false, erro: erro.message });
        }
    });

    app.post('/enviar-arquivo', async (req, res) => {
        const { numero } = req.body || {};
        if (statusBot !== 'pronto') {
            return res.status(409).json({ ok: false, erro: `Bot nao esta pronto (status: ${statusBot}).` });
        }
        if (!numero) {
            return res.status(400).json({ ok: false, erro: 'Informe o numero.' });
        }
        try {
            const r = await enviarArquivoERegistrar(numero, req.body || {});
            return res.json(r);
        } catch (erro) {
            return res.status(500).json({ ok: false, erro: erro.message });
        }
    });

    // ----- Contatos -----
    app.get('/api/contatos', async (_req, res) => {
        try { res.json(await db.listarContatos()); }
        catch (e) { res.status(500).json({ erro: e.message }); }
    });

    app.post('/api/contatos', async (req, res) => {
        const { nome, numero } = req.body || {};
        if (!nome || !numero) return res.status(400).json({ erro: 'Informe nome e numero.' });
        try {
            const numeroLimpo = normalizarNumero(numero).replace('@c.us', '');
            res.json(await db.criarContato(nome, numeroLimpo));
        } catch (e) { res.status(500).json({ erro: e.message }); }
    });

    app.delete('/api/contatos/:id', async (req, res) => {
        try { await db.removerContato(Number(req.params.id)); res.json({ ok: true }); }
        catch (e) { res.status(500).json({ erro: e.message }); }
    });

    // ----- Envios (fila / agendados / massa) -----
    app.get('/api/envios', async (req, res) => {
        try { res.json(await db.listarEnvios(Number(req.query.limite) || 100)); }
        catch (e) { res.status(500).json({ erro: e.message }); }
    });

    app.post('/api/envios', async (req, res) => {
        let { numeros, numero, mensagem, agendar_para, todos_contatos } = req.body || {};
        if (!mensagem) return res.status(400).json({ erro: 'Informe a mensagem.' });

        let lista = [];
        if (todos_contatos) {
            const contatos = await db.listarContatos();
            lista = contatos.map((c) => c.numero);
        } else if (Array.isArray(numeros)) {
            lista = numeros;
        } else if (numero) {
            lista = [numero];
        }
        lista = lista.map((n) => String(n).trim()).filter(Boolean);
        if (!lista.length) return res.status(400).json({ erro: 'Informe ao menos um numero.' });

        const agendarPara = agendar_para ? new Date(agendar_para) : null;
        if (agendarPara && isNaN(agendarPara.getTime())) {
            return res.status(400).json({ erro: 'Data de agendamento invalida.' });
        }

        try {
            const criados = [];
            for (const n of lista) {
                const numeroLimpo = normalizarNumero(n).replace('@c.us', '');
                criados.push(await db.criarEnvio(numeroLimpo, mensagem, agendarPara));
            }
            // Dispara o worker imediatamente caso nao seja agendado.
            if (!agendarPara) setImmediate(processarFila);
            res.json({ ok: true, criados: criados.length });
        } catch (e) { res.status(500).json({ erro: e.message }); }
    });

    app.post('/api/envios/:id/cancelar', async (req, res) => {
        try {
            const r = await db.cancelarEnvio(Number(req.params.id));
            if (!r) return res.status(409).json({ erro: 'Envio nao pode ser cancelado (ja processado?).' });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ erro: e.message }); }
    });

    app.get('/', (_req, res) => {
        res.type('html').send(PAGINA_HTML);
    });

    app.listen(PANEL_PORT, () => {
        console.log(`Painel online em: http://localhost:${PANEL_PORT}`);
        console.log('Usuario do painel: admin');
        console.log('Senha do painel: definida em PANEL_PASSWORD');
    });
}

client.on('qr', async (qr) => {
    statusBot = 'qr';
    ultimoErro = null;
    ultimoQrDataUrl = await qrcodeImage.toDataURL(qr, { margin: 2, width: 320 });
    console.log('\nEscaneie o QR Code abaixo com o WhatsApp:\n');
    qrcodeTerminal.generate(qr, { small: true });
    publicarEstado();
});

client.on('authenticated', () => {
    statusBot = 'autenticado';
    ultimoQrDataUrl = null;
    ultimoErro = null;
    console.log('Sessao autenticada com sucesso.');
    publicarEstado();
});

client.on('ready', () => {
    statusBot = 'pronto';
    ultimoQrDataUrl = null;
    ultimoErro = null;
    console.log('Bot conectado e pronto para automatizar mensagens.');
    publicarEstado();
});

client.on('auth_failure', (message) => {
    statusBot = 'erro';
    ultimoQrDataUrl = null;
    ultimoErro = message;
    console.error('Falha na autenticacao:', message);
    publicarEstado();
});

client.on('disconnected', (reason) => {
    statusBot = 'desconectado';
    ultimoQrDataUrl = null;
    ultimoErro = reason;
    console.log('Bot desconectado:', reason);
    publicarEstado();
});

client.on('message_create', async (message) => {
    if (message.isGroupMsg || message.isStatus) return;
    const fromMe = message.fromMe;
    const numero = String(fromMe ? message.to : message.from).replace('@c.us', '');
    console.log(`[mensagem ${fromMe ? 'enviada' : 'recebida'}] ${numero}: ${message.body}`);
});

async function iniciar() {
    try {
        await db.initSchema();
        console.log('Banco de dados conectado e schema verificado.');
    } catch (e) {
        console.error('AVISO: falha ao inicializar o banco:', e.message);
    }
    iniciarPainel();
    setInterval(processarFila, 8000);
    client.initialize();
}

iniciar();

module.exports = { client, enviarERegistrar, enviarArquivoERegistrar, normalizarNumero };

// ===================== PAGINA HTML DO PAINEL =====================
const PAGINA_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Central do Bot WhatsApp</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0e14;
      --panel: #111b21;
      --panel-header: #202c33;
      --text: #e9edef;
      --muted: #8696a0;
      --line: #222e35;
      --accent: #00a884;
      --accent-hover: #008f72;
      --bubble-sent: #005c4b;
      --bubble-received: #202c33;
      --warning: #e0a904;
      --danger: #ea580c;
      --ok: #059669;
    }
    * { box-sizing: border-box; font-family: 'Outfit', sans-serif; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      padding: 20px;
    }
    main {
      width: min(1000px, 100%);
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      flex: 1;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 22px; font-weight: 600; color: var(--accent); }
    h2 { margin: 0 0 16px; font-size: 18px; font-weight: 500; }
    .status {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status.pronto, .status.autenticado { color: #fff; background: var(--ok); border-color: var(--ok); }
    .status.qr { color: #000; background: var(--warning); border-color: var(--warning); }
    .status.erro, .status.desconectado { color: #fff; background: var(--danger); border-color: var(--danger); }
    
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    nav button {
      background: #202c33;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 14px;
      cursor: pointer;
      color: var(--text);
      transition: background 0.2s, border-color 0.2s;
    }
    nav button:hover { background: #2a3942; }
    nav button.ativo { background: var(--accent); color: #fff; border-color: var(--accent); }
    
    section.aba { display: none; }
    section.aba.ativa { display: block; }
    
    label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); margin-bottom: 14px; }
    input, textarea, select {
      padding: 10px 14px;
      border: 1px solid var(--line);
      background: #2a3942;
      color: var(--text);
      border-radius: 8px;
      font-size: 15px;
      width: 100%;
      transition: border-color 0.2s;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--accent);
    }
    textarea { min-height: 90px; resize: vertical; }
    
    button.acao {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 20px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
    }
    button.acao:hover { background: var(--accent-hover); }
    button.acao:active { transform: scale(0.98); }
    button.acao:disabled { opacity: .6; cursor: not-allowed; }
    
    button.del { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 13px; font-weight: 500; }
    button.del:hover { text-decoration: underline; }
    
    .qr-box {
      min-height: 280px;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: #182229;
      padding: 24px;
      text-align: center;
    }
    .qr-box img { width: min(280px, 100%); image-rendering: pixelated; border-radius: 6px; }
    .muted { margin: 0; color: var(--muted); line-height: 1.5; font-size: 14px; }
    .msg { margin: 10px 0 0; font-size: 14px; min-height: 20px; }
    .msg.ok { color: var(--ok); } .msg.falha { color: var(--danger); }
    
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.5px; }
    
    .pill { font-size: 11px; padding: 3px 10px; border-radius: 999px; font-weight: 600; display: inline-block; }
    .pill.enviada { background: rgba(5, 150, 105, 0.15); color: #34d399; }
    .pill.recebida { background: rgba(134, 150, 160, 0.15); color: #cbd5e1; }
    .pill.pendente { background: rgba(224, 169, 4, 0.15); color: #fbbf24; }
    .pill.erro { background: rgba(234, 88, 12, 0.15); color: #f97316; }
    .pill.cancelada { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
    
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .scroll { max-height: 420px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    .session { font-family: monospace; font-size: 12px; color: var(--muted); margin-top: 16px; text-align: center; }

    /* Custom Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #4b5563; }

    /* ======================================================== */
    /* CHAT LAYOUT */
    /* ======================================================== */
    .chat-container {
      display: flex;
      height: 550px;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: #0b141a;
    }
    .chat-sidebar {
      width: 300px;
      border-right: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      flex-direction: column;
    }
    .chat-sidebar-header {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-header);
    }
    .chat-sidebar-header input {
      background: #2a3942;
      border: none;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13.5px;
    }
    .chat-list {
      flex: 1;
      overflow-y: auto;
    }
    .chat-item {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
      transition: background 0.2s;
    }
    .chat-item:hover { background: #202c33; }
    .chat-item.ativo { background: #2a3942; }
    
    .chat-item-name {
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14.5px;
    }
    .chat-item-time { font-size: 11px; color: var(--muted); font-weight: 400; }
    .chat-item-last {
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .chat-window {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .chat-no-selection {
      flex: 1;
      display: grid;
      place-items: center;
      text-align: center;
      background: #222e35;
    }
    .chat-header {
      padding: 12px 20px;
      background: var(--panel-header);
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 59px;
    }
    .chat-header-info h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .chat-header-info span { font-size: 12px; color: var(--muted); }
    
    .chat-messages {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background-image: url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png');
      background-color: #0b141a;
      background-blend-mode: overlay;
      opacity: 0.95;
    }
    .chat-bubble {
      max-width: 70%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14.5px;
      line-height: 1.4;
      position: relative;
      word-wrap: break-word;
      box-shadow: 0 1px 2px rgba(0,0,0,0.3);
    }
    .chat-bubble.sent {
      align-self: flex-end;
      background: var(--bubble-sent);
      color: #e9edef;
      border-top-right-radius: 2px;
    }
    .chat-bubble.received {
      align-self: flex-start;
      background: var(--bubble-received);
      color: #e9edef;
      border-top-left-radius: 2px;
    }
    .chat-bubble-time {
      font-size: 10px;
      color: rgba(255,255,255,0.5);
      text-align: right;
      margin-top: 4px;
    }
    .chat-bubble.received .chat-bubble-time { color: var(--muted); }
    
    .chat-img {
      max-width: 100%;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 4px;
      max-height: 220px;
      object-fit: cover;
      display: block;
    }
    
    .chat-input-area {
      padding: 10px 16px;
      background: var(--panel-header);
      display: flex;
      gap: 12px;
      align-items: center;
      border-top: 1px solid var(--line);
    }
    .chat-input-area textarea {
      flex: 1;
      background: #2a3942;
      border: none;
      color: var(--text);
      padding: 10px 14px;
      border-radius: 8px;
      resize: none;
      height: 40px;
      font-size: 14px;
      line-height: 1.4;
    }
    .chat-input-area textarea::placeholder { color: var(--muted); }
    .chat-input-area textarea:focus { outline: none; border: none; }
    
    .chat-input-area button {
      background: var(--accent);
      color: #fff;
      border: none;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: background 0.2s, transform 0.1s;
    }
    .chat-input-area button:hover { background: var(--accent-hover); }
    .chat-input-area button:active { transform: scale(0.95); }
    .chat-input-area button svg { margin-left: 2px; }

    /* Lightbox Modal */
    .modal {
      display: none;
      position: fixed;
      z-index: 9999;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.9);
      backdrop-filter: blur(5px);
      place-items: center;
    }
    .modal-content {
      margin: auto;
      display: block;
      max-width: 90%;
      max-height: 90%;
      border-radius: 8px;
      box-shadow: 0 4px 30px rgba(0,0,0,0.5);
      animation: zoom 0.2s;
    }
    @keyframes zoom {
      from {transform:scale(0.85); opacity: 0}
      to {transform:scale(1); opacity: 1}
    }
    .close-btn {
      position: absolute;
      top: 20px;
      right: 35px;
      color: #f1f1f1;
      font-size: 40px;
      font-weight: 700;
      cursor: pointer;
    }
    .close-btn:hover { color: #bbb; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Central do Bot WhatsApp</h1>
      <div id="status" class="status">iniciando</div>
    </header>

    <nav>
      <button data-aba="conexao" class="ativo">Conexão</button>
      <button data-aba="contatos">Contatos</button>
      <button data-aba="massa">Agendar / Massa</button>
      <button data-aba="fila">Fila</button>
    </nav>

    <section id="conexao" class="aba ativa">
      <div id="qrBox" class="qr-box"><p class="muted">Aguardando QR Code...</p></div>
      <p id="texto" class="muted" style="margin-top:12px; text-align:center">Abra o WhatsApp > Aparelhos conectados e escaneie o QR Code.</p>
    </section>

    <section id="enviar" class="aba">
      <h2>Enviar mensagem rápida</h2>
      <label>Número (com DDD e DDI)<input id="env_numero" type="text" value="5527981416770"></label>
      <label>Mensagem<input id="env_msg" type="text" value="Olá"></label>
      <button id="env_btn" class="acao">Enviar</button>
      <p id="env_res" class="msg"></p>
    </section>

    <section id="contatos" class="aba">
      <h2>Adicionar contato</h2>
      <div class="row">
        <input id="ct_nome" type="text" placeholder="Nome" style="flex:1">
        <input id="ct_num" type="text" placeholder="Número (com DDD)" style="flex:1">
        <button id="ct_btn" class="acao">Salvar</button>
      </div>
      <p id="ct_res" class="msg"></p>
      <div class="scroll" style="margin-top:12px">
        <table>
          <thead><tr><th>Nome</th><th>Número</th><th style="text-align:right">Ações</th></tr></thead>
          <tbody id="ct_lista"></tbody>
        </table>
      </div>
    </section>

    <section id="massa" class="aba">
      <h2>Agendar ou enviar em massa</h2>
      <label>Números (um por linha) ou marque a opção abaixo
        <textarea id="ms_nums" placeholder="5527981416770&#10;5511999998888"></textarea>
      </label>
      <label class="row" style="margin-bottom:12px; width:auto; cursor:pointer">
        <input id="ms_todos" type="checkbox" style="width:auto"> Enviar para todos os contatos cadastrados
      </label>
      <label>Mensagem<textarea id="ms_msg" placeholder="Sua mensagem..."></textarea></label>
      <label>Agendar para (opcional - deixe vazio para enviar agora)
        <input id="ms_quando" type="datetime-local">
      </label>
      <button id="ms_btn" class="acao">Criar envio</button>
      <p id="ms_res" class="msg"></p>
    </section>



    <section id="fila" class="aba">
      <h2>Fila e agendamentos</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Número</th><th>Mensagem</th><th>Agendado</th><th>Status</th><th style="text-align:right"></th></tr></thead>
          <tbody id="fila_lista"></tbody>
        </table>
      </div>
    </section>

    <div id="sessao" class="session"></div>
  </main>



  <script>
    function $(id){ return document.getElementById(id); }
    function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
    function fmt(d){ if(!d) return '-'; try { return new Date(d).toLocaleString('pt-BR'); } catch(e){ return d; } }

    let contatosCache = [];


    // ---- Abas ----
    document.querySelectorAll('nav button').forEach(function(b){
      b.addEventListener('click', function(){
        document.querySelectorAll('nav button').forEach(function(x){ x.classList.remove('ativo'); });
        document.querySelectorAll('section.aba').forEach(function(x){ x.classList.remove('ativa'); });
        b.classList.add('ativo');
        $(b.dataset.aba).classList.add('ativa');
        if (b.dataset.aba === 'contatos') carregarContatos();
        if (b.dataset.aba === 'fila') carregarFila();
      });
    });

    // ---- Status / QR (SSE) ----
    function renderEstado(e){
      $('status').textContent = e.status;
      $('status').className = 'status ' + e.status;
      $('sessao').textContent = 'Sessão: ' + e.sessao;
      if (e.qr && e.status === 'qr') {
        $('qrBox').innerHTML = '<img src="' + e.qr + '" alt="QR">';
        $('texto').textContent = 'Escaneie este QR Code no WhatsApp.';
      } else if (e.status === 'pronto') {
        $('qrBox').innerHTML = '<p class="muted">Bot conectado com sucesso.</p>';
        $('texto').textContent = 'Sessão ativa. O bot já envia e recebe mensagens.';
      } else if (e.status === 'autenticado') {
        $('qrBox').innerHTML = '<p class="muted">Sessão autenticada. Finalizando...</p>';
        $('texto').textContent = 'Aguarde alguns segundos.';
      } else {
        $('qrBox').innerHTML = '<p class="muted">Aguardando QR Code...</p>';
        $('texto').textContent = 'Mantenha esta página aberta enquanto o bot inicializa.';
      }
    }

    const sse = new EventSource('/events');
    sse.onmessage = function(ev){
      const data = JSON.parse(ev.data);
      if (data.event !== 'nova_mensagem') {
        renderEstado(data);
      }
    };

    async function api(url, opts){
      const r = await fetch(url, opts);
      const d = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(d.erro || 'Erro na requisição');
      return d;
    }



    // ========================================================
    // MANUAL SEND
    // ========================================================
    $('env_btn').addEventListener('click', async function(){
      const numero = $('env_numero').value.trim();
      const mensagem = $('env_msg').value.trim();
      $('env_res').className = 'msg'; $('env_res').textContent = 'Enviando...'; $('env_btn').disabled = true;
      try {
        const d = await api('/enviar', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ numero, mensagem }) });
        $('env_res').className = 'msg ok'; $('env_res').textContent = 'Enviado para ' + d.para;
      } catch(e){ $('env_res').className = 'msg falha'; $('env_res').textContent = 'Erro: ' + e.message; }
      finally { $('env_btn').disabled = false; }
    });

    // ========================================================
    // CONTACTS MANAGING
    // ========================================================
    async function carregarContatos(){
      try {
        const lista = await api('/api/contatos');
        contatosCache = lista;
        $('ct_lista').innerHTML = lista.map(function(c){
          return '<tr><td>'+esc(c.nome)+'</td><td>'+esc(c.numero)+'</td>'+
            '<td style="text-align:right">'+
              '<button class="del" data-id="'+c.id+'">remover</button>'+
            '</td></tr>';
        }).join('') || '<tr><td colspan="3" class="muted" style="text-align:center">Nenhum contato cadastrado.</td></tr>';
        
        $('ct_lista').querySelectorAll('.del').forEach(function(b){
          b.addEventListener('click', async function(){
            if(confirm('Deseja realmente remover este contato?')) {
              await api('/api/contatos/'+b.dataset.id, { method:'DELETE' });
              carregarContatos();
            }
          });
        });


      } catch(e){ $('ct_lista').innerHTML = '<tr><td colspan="3" class="falha">'+esc(e.message)+'</td></tr>'; }
    }

    $('ct_btn').addEventListener('click', async function(){
      const nome = $('ct_nome').value.trim(); const numero = $('ct_num').value.trim();
      $('ct_res').className='msg';
      try {
        await api('/api/contatos', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ nome, numero }) });
        $('ct_nome').value=''; $('ct_num').value='';
        $('ct_res').className='msg ok'; $('ct_res').textContent='Contato salvo.'; carregarContatos();
      } catch(e){ $('ct_res').className='msg falha'; $('ct_res').textContent='Erro: '+e.message; }
    });

    // ========================================================
    // BULK SEND & SCHEDULING
    // ========================================================
    $('ms_btn').addEventListener('click', async function(){
      const mensagem = $('ms_msg').value.trim();
      const todos = $('ms_todos').checked;
      const numeros = $('ms_nums').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean);
      const quando = $('ms_quando').value;
      $('ms_res').className='msg'; $('ms_res').textContent='Criando...'; $('ms_btn').disabled=true;
      try {
        const body = { mensagem: mensagem };
        if (todos) body.todos_contatos = true; else body.numeros = numeros;
        if (quando) body.agendar_para = quando;
        const d = await api('/api/envios', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body) });
        $('ms_res').className='msg ok';
        $('ms_res').textContent = d.criados + ' envio(s) criado(s)' + (quando ? ' (agendado)' : ' (na fila)') + '.';
        $('ms_msg').value=''; $('ms_nums').value=''; $('ms_quando').value=''; $('ms_todos').checked=false;
      } catch(e){ $('ms_res').className='msg falha'; $('ms_res').textContent='Erro: '+e.message; }
      finally { $('ms_btn').disabled=false; }
    });



    // ========================================================
    // QUEUE LOGS
    // ========================================================
    async function carregarFila(){
      try {
        const lista = await api('/api/envios?limite=100');
        $('fila_lista').innerHTML = lista.map(function(e){
          var btn = e.status === 'pendente' ? '<button class="del" data-id="'+e.id+'">cancelar</button>' : '';
          return '<tr><td>'+esc(e.numero)+'</td><td>'+esc(e.mensagem)+'</td>'+
            '<td>'+(e.agendar_para?fmt(e.agendar_para):'-')+'</td>'+
            '<td><span class="pill '+esc(e.status)+'">'+esc(e.status)+'</span>'+
            (e.erro?'<br><span class="muted">'+esc(e.erro)+'</span>':'')+'</td>'+
            '<td style="text-align:right">'+btn+'</td></tr>';
        }).join('') || '<tr><td colspan="5" class="muted" style="text-align:center">Fila de envios vazia.</td></tr>';
        $('fila_lista').querySelectorAll('.del').forEach(function(b){
          b.addEventListener('click', async function(){
            await api('/api/envios/'+b.dataset.id+'/cancelar', { method:'POST' });
            carregarFila();
          });
        });
      } catch(e){ $('fila_lista').innerHTML = '<tr><td colspan="5" class="falha">'+esc(e.message)+'</td></tr>'; }
    }


  </script>
</body>
</html>`;
