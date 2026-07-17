const { query, json, lerBody, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

        if (req.method === 'GET') {
            const r = await query(
                `SELECT l.*, COUNT(lc.contato_id)::int AS total
                 FROM listas l
                 LEFT JOIN lista_contatos lc ON lc.lista_id = l.id
                 WHERE l.usuario_id = $1
                 GROUP BY l.id ORDER BY l.nome ASC`,
                [u.id]
            );
            return json(res, 200, r.rows);
        }

        if (req.method === 'POST') {
            const body = await lerBody(req);
            if (!body.nome) return json(res, 400, { erro: 'Informe o nome da lista.' });
            const r = await query(
                'INSERT INTO listas (usuario_id, nome) VALUES ($1, $2) RETURNING *',
                [u.id, body.nome]
            );
            return json(res, 200, r.rows[0]);
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query.id);
            if (!id) return json(res, 400, { erro: 'Informe o id.' });
            await query('DELETE FROM listas WHERE id = $1 AND usuario_id = $2', [id, u.id]);
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
