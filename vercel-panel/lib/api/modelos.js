const { query, json, lerBody, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

        if (req.method === 'GET') {
            const r = await query('SELECT * FROM modelos WHERE usuario_id = $1 ORDER BY titulo ASC', [u.id]);
            return json(res, 200, r.rows);
        }

        if (req.method === 'POST') {
            const body = await lerBody(req);
            if (!body.titulo || !body.corpo) return json(res, 400, { erro: 'Informe titulo e corpo.' });
            const r = await query(
                'INSERT INTO modelos (usuario_id, titulo, corpo) VALUES ($1, $2, $3) RETURNING *',
                [u.id, body.titulo, body.corpo]
            );
            return json(res, 200, r.rows[0]);
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query.id);
            if (!id) return json(res, 400, { erro: 'Informe o id.' });
            await query('DELETE FROM modelos WHERE id = $1 AND usuario_id = $2', [id, u.id]);
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
