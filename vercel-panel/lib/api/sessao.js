const { query, json, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

module.exports = async (req, res) => {
    if (req.method === 'GET' && req.query.api === '1') {
        try {
            await initSchema();
            const token = String(req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
            if (!token) return json(res, 401, { erro: 'Informe o token de API.' });
            const r = await query(
                `SELECT s.status, s.numero_conectado, s.atualizado_em
                 FROM usuarios u
                 LEFT JOIN sessoes s ON s.usuario_id = u.id
                 WHERE u.api_token = $1`,
                [token]
            );
            if (!r.rows[0]) return json(res, 401, { erro: 'Token de API invalido.' });
            return json(res, 200, {
                status: r.rows[0].status || 'pendente',
                numero_conectado: r.rows[0].numero_conectado || null,
                atualizado_em: r.rows[0].atualizado_em || null,
            });
        } catch (e) {
            return json(res, 500, { erro: e.message });
        }
    }

    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

        // GET: retorna status + QR da sessao do usuario.
        if (req.method === 'GET') {
            let r = await query(
                'SELECT id, status, qr, numero_conectado, atualizado_em, importar_contatos, importar_resultado FROM sessoes WHERE usuario_id = $1',
                [u.id]
            );
            if (!r.rows[0]) {
                await query("INSERT INTO sessoes (usuario_id, status) VALUES ($1, 'pendente') ON CONFLICT (usuario_id) DO NOTHING", [u.id]);
                r = await query('SELECT id, status, qr, numero_conectado, atualizado_em, importar_contatos, importar_resultado FROM sessoes WHERE usuario_id = $1', [u.id]);
            }
            return json(res, 200, r.rows[0]);
        }

        // POST ?acao=importar: pede ao motor para importar os contatos do WhatsApp.
        if (req.method === 'POST' && req.query.acao === 'importar') {
            await query(
                "UPDATE sessoes SET importar_contatos = true, importar_resultado = 'Solicitado...' WHERE usuario_id = $1",
                [u.id]
            );
            return json(res, 200, { ok: true });
        }

        // POST ?acao=desconectar: derruba o servico (logout do WhatsApp).
        if (req.method === 'POST' && req.query.acao === 'desconectar') {
            await query(
                "UPDATE sessoes SET status = 'desconectar', qr = NULL, numero_conectado = NULL, atualizado_em = now() WHERE usuario_id = $1",
                [u.id]
            );
            return json(res, 200, { ok: true });
        }

        // POST: reconectar/reset (pede novo QR). O motor vai reiniciar a sessao.
        if (req.method === 'POST') {
            await query(
                "UPDATE sessoes SET status = 'reconectar', qr = NULL, atualizado_em = now() WHERE usuario_id = $1",
                [u.id]
            );
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
