const { query, json, lerBody, normalizarNumero, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { usuarioWorkspace } = require('../_workspace');

module.exports = async (req, res) => {
    const usuarioLogado = usuarioDoReq(req);
    if (!usuarioLogado) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();
        const u = await usuarioWorkspace(usuarioLogado);

        if (req.method === 'GET') {
            const r = await query('SELECT * FROM contatos WHERE usuario_id = $1 ORDER BY nome ASC', [u.id]);
            return json(res, 200, r.rows);
        }

        // Importar em massa: POST ?acao=lote  { contatos:[{nome,numero}], lista_id? }
        if (req.method === 'POST' && req.query.acao === 'lote') {
            const body = await lerBody(req);
            const itens = Array.isArray(body.contatos) ? body.contatos : [];
            if (!itens.length) return json(res, 400, { erro: 'Nenhum contato recebido.' });

            let listaId = null;
            if (body.lista_id) {
                const l = await query('SELECT id FROM listas WHERE id = $1 AND usuario_id = $2', [Number(body.lista_id), u.id]);
                if (!l.rows[0]) return json(res, 400, { erro: 'Lista invalida.' });
                listaId = l.rows[0].id;
            }

            let importados = 0, ignorados = 0;
            for (const it of itens) {
                const nm = (it.nome || '').toString().trim();
                let num;
                try { num = normalizarNumero(it.numero); } catch { ignorados++; continue; }
                if (!nm) { ignorados++; continue; }
                const ri = await query(
                    `INSERT INTO contatos (usuario_id, nome, numero) VALUES ($1, $2, $3)
                     ON CONFLICT (usuario_id, numero) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
                    [u.id, nm, num]
                );
                if (listaId) {
                    await query('INSERT INTO lista_contatos (lista_id, contato_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [listaId, ri.rows[0].id]);
                }
                importados++;
            }
            return json(res, 200, { ok: true, importados, ignorados });
        }

        if (req.method === 'POST') {
            const body = await lerBody(req);
            const { nome, numero } = body;
            if (!nome || !numero) return json(res, 400, { erro: 'Informe nome e numero.' });
            const numeroLimpo = normalizarNumero(numero);
            const r = await query(
                `INSERT INTO contatos (usuario_id, nome, numero) VALUES ($1, $2, $3)
                 ON CONFLICT (usuario_id, numero) DO UPDATE SET nome = EXCLUDED.nome RETURNING *`,
                [u.id, nome, numeroLimpo]
            );
            return json(res, 200, r.rows[0]);
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query.id);
            if (!id) return json(res, 400, { erro: 'Informe o id.' });
            await query('DELETE FROM contatos WHERE id = $1 AND usuario_id = $2', [id, u.id]);
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
