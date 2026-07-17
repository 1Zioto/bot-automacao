const { query, json, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { usuarioWorkspace } = require('../_workspace');

module.exports = async (req, res) => {
    const usuarioLogado = usuarioDoReq(req);
    if (!usuarioLogado) return json(res, 401, { erro: 'Nao autorizado' });
    if (req.method !== 'GET') return json(res, 405, { erro: 'Metodo nao suportado.' });
    try {
        await initSchema();
        const u = await usuarioWorkspace(usuarioLogado);

        // Serve media on demand
        if (req.query.id && req.query.media === '1') {
            const r = await query(
                'SELECT media_mimetype, media_data, media_filename FROM mensagens WHERE id = $1 AND usuario_id = $2',
                [Number(req.query.id), u.id]
            );
            const msg = r.rows[0];
            if (!msg || !msg.media_data) {
                return json(res, 404, { erro: 'Midia nao encontrada.' });
            }
            const buffer = Buffer.from(msg.media_data, 'base64');
            res.setHeader('Content-Type', msg.media_mimetype);
            if (msg.media_filename) {
                res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(msg.media_filename)}"`);
            }
            return res.send(buffer);
        }

        const limite = Math.min(Number(req.query.limite) || 100, 3000);
        const numero = String(req.query.numero || '').trim();
        // Omitimos a coluna media_data da listagem geral para economizar banda/payload
        const filtros = ['m.usuario_id = $1'];
        const params = [u.id];
        if (numero) {
            params.push(numero);
            filtros.push(`m.numero = $${params.length}`);
        }
        params.push(limite);
        const r = await query(
            `SELECT m.id, m.usuario_id, m.sessao_id, m.direcao, m.numero, m.corpo, m.status, m.origem,
                    m.media_mimetype, m.media_filename, m.media_path,
                    c.nome AS contato_nome,
                    (m.media_data IS NOT NULL AND length(m.media_data) > 0) AS media_disponivel,
                    m.criado_em
             FROM mensagens m
             LEFT JOIN contatos c ON c.usuario_id = m.usuario_id AND c.numero = m.numero
             WHERE ${filtros.join(' AND ')}
             ORDER BY m.criado_em DESC LIMIT $${params.length}`,
            params
        );
        return json(res, 200, r.rows);
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
