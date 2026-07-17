const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const { Pool } = require('pg');

let DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('AVISO: DATABASE_URL nao definido no .env. As funcoes de banco ficarao indisponiveis.');
} else {
    // Garantir que a String nao produza aviso do pg sobre sslmode require
    DATABASE_URL = DATABASE_URL.replace('sslmode=require', 'sslmode=verify-full');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
});

pool.on('error', (err) => {
    console.error('Erro inesperado no pool do Postgres:', err.message);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contatos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  numero TEXT NOT NULL UNIQUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS envios (
  id SERIAL PRIMARY KEY,
  numero TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  agendar_para TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pendente',
  tentativas INT NOT NULL DEFAULT 0,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_envios_status ON envios (status, agendar_para);

`;

async function initSchema() {
    await pool.query(SCHEMA);
}



// ---------- Contatos ----------
async function listarContatos() {
    const r = await pool.query('SELECT * FROM contatos ORDER BY nome ASC');
    return r.rows;
}

async function criarContato(nome, numero) {
    const r = await pool.query(
        `INSERT INTO contatos (nome, numero) VALUES ($1, $2)
         ON CONFLICT (numero) DO UPDATE SET nome = EXCLUDED.nome
         RETURNING *`,
        [nome, numero]
    );
    return r.rows[0];
}

async function removerContato(id) {
    await pool.query('DELETE FROM contatos WHERE id = $1', [id]);
}

// ---------- Envios (fila / agendados / massa) ----------
async function criarEnvio(numero, mensagem, agendarPara = null) {
    const r = await pool.query(
        'INSERT INTO envios (numero, mensagem, agendar_para) VALUES ($1, $2, $3) RETURNING *',
        [numero, mensagem, agendarPara]
    );
    return r.rows[0];
}

async function listarEnvios(limite = 100) {
    const r = await pool.query(
        'SELECT * FROM envios ORDER BY criado_em DESC LIMIT $1',
        [limite]
    );
    return r.rows;
}

async function cancelarEnvio(id) {
    const r = await pool.query(
        "UPDATE envios SET status = 'cancelada' WHERE id = $1 AND status = 'pendente' RETURNING *",
        [id]
    );
    return r.rows[0];
}

// Pega ate N envios pendentes cujo horario ja chegou (ou sem agendamento).
async function proximosEnviosPendentes(limite = 5) {
    const r = await pool.query(
        `SELECT * FROM envios
         WHERE status = 'pendente'
           AND (agendar_para IS NULL OR agendar_para <= now())
         ORDER BY criado_em ASC
         LIMIT $1`,
        [limite]
    );
    return r.rows;
}

async function marcarEnvioEnviado(id) {
    await pool.query(
        "UPDATE envios SET status = 'enviada', enviado_em = now() WHERE id = $1",
        [id]
    );
}

async function marcarEnvioErro(id, erro) {
    await pool.query(
        "UPDATE envios SET status = 'erro', tentativas = tentativas + 1, erro = $2 WHERE id = $1",
        [id, String(erro).slice(0, 500)]
    );
}

module.exports = {
    pool,
    initSchema,

    listarContatos,
    criarContato,
    removerContato,
    criarEnvio,
    listarEnvios,
    cancelarEnvio,
    proximosEnviosPendentes,
    marcarEnvioEnviado,
    marcarEnvioErro,
};
