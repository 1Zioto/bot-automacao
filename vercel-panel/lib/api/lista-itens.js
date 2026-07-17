const { query, json, lerBody, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

// Confirma que a lista pertence ao usuario.
async function listaDoUsuario(listaId, usuarioId) {
    const r = await query('SELECT id FROM listas WHERE id = $1 AND usuario_id = $2', [listaId, usuarioId]);
    return !!r.rows[0];
}

async function contatoDoUsuario(contatoId, usuarioId) {
    const r = await query('SELECT id FROM contatos WHERE id = $1 AND usuario_id = $2', [contatoId, usuarioId]);
    return !!r.rows[0];
}

module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

        // GET ?lista_id=  -> contatos na lista + contatos disponiveis
        if (req.method === 'GET') {
            const listaId = Number(req.query.lista_id);
            if (!listaId || !(await listaDoUsuario(listaId, u.id))) return json(res, 400, { erro: 'Lista invalida.' });
            const dentro = await query(
                `SELECT c.id, c.nome, c.numero FROM lista_contatos lc
                 JOIN contatos c ON c.id = lc.contato_id
                 WHERE lc.lista_id = $1 ORDER BY c.nome ASC`,
                [listaId]
            );
            const fora = await query(
                `SELECT id, nome, numero FROM contatos
                 WHERE usuario_id = $1 AND id NOT IN (SELECT contato_id FROM lista_contatos WHERE lista_id = $2)
                 ORDER BY nome ASC`,
                [u.id, listaId]
            );
            return json(res, 200, { dentro: dentro.rows, fora: fora.rows });
        }

        // POST {lista_id, contato_id}  -> adiciona
        if (req.method === 'POST') {
            const body = await lerBody(req);
            const listaId = Number(body.lista_id); const contatoId = Number(body.contato_id);
            if (!listaId || !contatoId || !(await listaDoUsuario(listaId, u.id)) || !(await contatoDoUsuario(contatoId, u.id))) {
                return json(res, 400, { erro: 'Dados invalidos.' });
            }
            await query(
                'INSERT INTO lista_contatos (lista_id, contato_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [listaId, contatoId]
            );
            return json(res, 200, { ok: true });
        }

        // DELETE ?lista_id=&contato_id=  -> remove
        if (req.method === 'DELETE') {
            const listaId = Number(req.query.lista_id); const contatoId = Number(req.query.contato_id);
            if (!listaId || !contatoId || !(await listaDoUsuario(listaId, u.id)) || !(await contatoDoUsuario(contatoId, u.id))) {
                return json(res, 400, { erro: 'Dados invalidos.' });
            }
            await query('DELETE FROM lista_contatos WHERE lista_id = $1 AND contato_id = $2', [listaId, contatoId]);
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
