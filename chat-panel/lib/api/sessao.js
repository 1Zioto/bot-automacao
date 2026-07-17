const { query, json, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { usuarioWorkspace } = require('../_workspace');

module.exports = async (req, res) => {
    const usuarioLogado = usuarioDoReq(req);
    if (!usuarioLogado) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();
        const u = await usuarioWorkspace(usuarioLogado);
        if (req.method !== 'GET') return json(res, 405, { erro: 'Metodo nao suportado.' });
        const r = await query(
            'SELECT id, status, numero_conectado, atualizado_em FROM sessoes WHERE usuario_id = $1 LIMIT 1',
            [u.id]
        );
        return json(res, 200, r.rows[0] || null);
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
