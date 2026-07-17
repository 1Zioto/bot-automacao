const crypto = require('crypto');
const { query, json, lerBody, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

async function obterConfig(usuarioId) {
    const cols = 'intervalo_segundos, limite_diario, ia_variar, janela_inicio, janela_fim, aquecimento';
    let r = await query(`SELECT ${cols} FROM configuracoes WHERE usuario_id = $1`, [usuarioId]);
    if (!r.rows[0]) {
        await query('INSERT INTO configuracoes (usuario_id) VALUES ($1) ON CONFLICT DO NOTHING', [usuarioId]);
        r = await query(`SELECT ${cols} FROM configuracoes WHERE usuario_id = $1`, [usuarioId]);
    }
    return r.rows[0];
}

module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

        // ----- Token de API (aba API do painel) -----
        if (req.query.recurso === 'token') {
            if (req.method === 'GET') {
                const r = await query('SELECT api_token FROM usuarios WHERE id = $1', [u.id]);
                return json(res, 200, { api_token: r.rows[0] ? r.rows[0].api_token : null });
            }
            if (req.method === 'POST') {
                const novo = 'wa_' + crypto.randomBytes(24).toString('hex');
                await query('UPDATE usuarios SET api_token = $1 WHERE id = $2', [novo, u.id]);
                return json(res, 200, { api_token: novo });
            }
            return json(res, 405, { erro: 'Metodo nao suportado.' });
        }

        if (req.method === 'GET') {
            return json(res, 200, await obterConfig(u.id));
        }

        if (req.method === 'POST') {
            const b = await lerBody(req);
            let intervalo = Number(b.intervalo_segundos);
            let limite = Number(b.limite_diario);
            const iaVariar = !!b.ia_variar;
            const aquecimento = b.aquecimento !== undefined ? !!b.aquecimento : true;
            let ini = Number(b.janela_inicio);
            let fim = Number(b.janela_fim);
            if (!Number.isFinite(intervalo) || intervalo < 15) intervalo = 15; // minimo de seguranca
            if (intervalo > 3600) intervalo = 3600;
            if (!Number.isFinite(limite) || limite < 0) limite = 0;
            if (!Number.isFinite(ini) || ini < 0 || ini > 23) ini = 8;
            if (!Number.isFinite(fim) || fim < 1 || fim > 24) fim = 20;
            if (!aquecimento) {
                limite = 0;
                ini = 0;
                fim = 24;
            }
            await query(
                `INSERT INTO configuracoes (usuario_id, intervalo_segundos, limite_diario, ia_variar, janela_inicio, janela_fim, aquecimento, atualizado_em)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                 ON CONFLICT (usuario_id) DO UPDATE SET intervalo_segundos = $2, limite_diario = $3, ia_variar = $4, janela_inicio = $5, janela_fim = $6, aquecimento = $7, atualizado_em = now()`,
                [u.id, intervalo, limite, iaVariar, ini, fim, aquecimento]
            );
            return json(res, 200, { ok: true, intervalo_segundos: intervalo, limite_diario: limite, ia_variar: iaVariar, janela_inicio: ini, janela_fim: fim, aquecimento });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
