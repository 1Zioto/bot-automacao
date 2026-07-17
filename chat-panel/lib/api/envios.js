const { query, json, lerBody, normalizarNumero, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { usuarioWorkspace } = require('../_workspace');

function normalizarDestino(numero, origem) {
    const valor = String(numero || '').trim();
    if (origem === 'chat' && /@(c\.us|lid)$/.test(valor)) return valor;
    return normalizarNumero(valor);
}

module.exports = async (req, res) => {
    // ----- ENVIO PUBLICO VIA API (token de API, sem login) -----
    // POST /api/envios?api=1   body: { token, numero, mensagem }
    if (req.method === 'POST' && req.query.api === '1') {
        try {
            await initSchema();
            const body = await lerBody(req);
            const token = (body.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
            if (!token) return json(res, 401, { erro: 'Informe o token de API.' });
            const ur = await query('SELECT id FROM usuarios WHERE api_token = $1', [token]);
            if (!ur.rows[0]) return json(res, 401, { erro: 'Token de API invalido.' });
            const usuarioId = ur.rows[0].id;

            if (!body.numero || !body.mensagem) return json(res, 400, { erro: 'Informe numero e mensagem.' });
            const s = await query('SELECT id FROM sessoes WHERE usuario_id = $1', [usuarioId]);
            const sessao = s.rows[0];
            if (!sessao) return json(res, 400, { erro: 'Nenhum numero conectado nesta conta.' });

            const r = await query(
                "INSERT INTO envios (usuario_id, sessao_id, numero, mensagem, origem) VALUES ($1, $2, $3, $4, 'api') RETURNING id",
                [usuarioId, sessao.id, normalizarNumero(body.numero), String(body.mensagem)]
            );
            return json(res, 200, { ok: true, id: r.rows[0].id });
        } catch (e) {
            return json(res, 500, { erro: e.message });
        }
    }

    const usuarioLogado = usuarioDoReq(req);
    if (!usuarioLogado) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();
        const u = await usuarioWorkspace(usuarioLogado);

        if (req.method === 'GET') {
            const limite = Number(req.query.limite) || 100;
            const r = await query(
                'SELECT * FROM envios WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT $2',
                [u.id, limite]
            );
            return json(res, 200, r.rows);
        }

        // Cancelar um envio pendente: POST ?acao=cancelar&id=
        if (req.method === 'POST' && req.query.acao === 'cancelar') {
            const id = Number(req.query.id);
            if (!id) return json(res, 400, { erro: 'Informe o id.' });
            const rc = await query(
                "UPDATE envios SET status = 'cancelada' WHERE id = $1 AND usuario_id = $2 AND status = 'pendente' RETURNING *",
                [id, u.id]
            );
            if (!rc.rows[0]) return json(res, 409, { erro: 'Envio nao pode ser cancelado (ja processado?).' });
            return json(res, 200, { ok: true });
        }

        if (req.method === 'POST') {
            const body = await lerBody(req);
            const { numeros, numero, mensagem, agendar_para, todos_contatos, origem } = body;
            if (!mensagem) return json(res, 400, { erro: 'Informe a mensagem.' });

            // Sessao (numero) do usuario.
            const s = await query('SELECT id, status FROM sessoes WHERE usuario_id = $1', [u.id]);
            const sessao = s.rows[0];
            if (!sessao) return json(res, 400, { erro: 'Conecte um numero antes de enviar.' });

            let lista = [];
            if (todos_contatos) {
                const r = await query('SELECT numero FROM contatos WHERE usuario_id = $1', [u.id]);
                lista = r.rows.map((c) => c.numero);
            } else if (Array.isArray(numeros)) {
                lista = numeros;
            } else if (numero) {
                lista = [numero];
            }
            lista = lista.map((n) => String(n).trim()).filter(Boolean);
            if (!lista.length) return json(res, 400, { erro: 'Informe ao menos um numero.' });

            const agendarPara = agendar_para ? new Date(agendar_para) : null;
            if (agendarPara && isNaN(agendarPara.getTime())) {
                return json(res, 400, { erro: 'Data de agendamento invalida.' });
            }

            const origemEfetiva = origem || 'painel';
            if (origemEfetiva === 'chat' && sessao.status !== 'pronto') {
                return json(res, 409, { erro: 'WhatsApp nao esta conectado. Conecte o numero antes de responder pelo chat.' });
            }

            let criados = 0;
            const ids = [];
            for (const n of lista) {
                const criado = await query(
                    'INSERT INTO envios (usuario_id, sessao_id, numero, mensagem, agendar_para, origem) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                    [u.id, sessao.id, normalizarDestino(n, origemEfetiva), mensagem, agendarPara, origemEfetiva]
                );
                ids.push(criado.rows[0].id);
                criados++;
            }
            if (origemEfetiva === 'chat') {
                await query("SELECT pg_notify('chat_envio', $1)", [JSON.stringify({ usuarioId: u.id, ids })]);
            }
            return json(res, 200, { ok: true, criados, ids });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
