const { Pool } = require('pg');

let pool;
function getPool() {
    if (!pool) {
        let dbUrl = process.env.DATABASE_URL;
        if (dbUrl) {
            dbUrl = dbUrl.replace('sslmode=require', 'sslmode=verify-full');
        }
        pool = new Pool({
            connectionString: dbUrl,
            ssl: { rejectUnauthorized: false },
            max: 3,
        });
        pool.on('error', (err) => {
            console.error('Erro inesperado no pool do Postgres (vercel-panel):', err.message);
        });
    }
    return pool;
}

async function query(text, params) {
    return getPool().query(text, params);
}

function normalizarNumero(numero) {
    let limpo = String(numero || '').replace(/\D/g, '');
    if (!limpo) throw new Error('Numero invalido.');
    if (limpo.length <= 11) limpo = '55' + limpo;
    return limpo;
}

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json');
    res.status(status).send(JSON.stringify(body));
}

async function lerBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

async function initSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      nome TEXT,
      api_token TEXT UNIQUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      id SERIAL PRIMARY KEY,
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      nome TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      qr TEXT,
      numero_conectado TEXT,
      importar_contatos BOOLEAN NOT NULL DEFAULT false,
      importar_resultado TEXT,
      conectado_em TIMESTAMPTZ,
      aquecimento BOOLEAN NOT NULL DEFAULT true,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (usuario_id)
    );
    CREATE TABLE IF NOT EXISTS contatos (
      id SERIAL PRIMARY KEY,
      usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      numero TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mensagens (
      id SERIAL PRIMARY KEY,
      usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE,
      sessao_id INT REFERENCES sessoes(id) ON DELETE SET NULL,
      direcao TEXT NOT NULL,
      numero TEXT NOT NULL,
      corpo TEXT,
      status TEXT,
      origem TEXT,
      media_mimetype TEXT,
      media_data TEXT,
      media_filename TEXT,
      media_path TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS envios (
      id SERIAL PRIMARY KEY,
      usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE,
      sessao_id INT REFERENCES sessoes(id) ON DELETE SET NULL,
      numero TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      agendar_para TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pendente',
      origem TEXT NOT NULL DEFAULT 'painel',
      tentativas INT NOT NULL DEFAULT 0,
      erro TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      enviado_em TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS configuracoes (
      usuario_id INT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      intervalo_segundos INT NOT NULL DEFAULT 15,
      limite_diario INT NOT NULL DEFAULT 0,
      ia_variar BOOLEAN NOT NULL DEFAULT false,
      janela_inicio INT NOT NULL DEFAULT 8,
      janela_fim INT NOT NULL DEFAULT 20,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS optout (
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      numero TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (usuario_id, numero)
    );
  `);
    await query(`
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS media_mimetype TEXT;
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS media_data TEXT;
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS media_filename TEXT;
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS media_path TEXT;
      ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS conectado_em TIMESTAMPTZ;
      ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS aquecimento BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS aquecimento BOOLEAN NOT NULL DEFAULT true;
    `);
}

module.exports = { getPool, query, normalizarNumero, json, lerBody, initSchema };
