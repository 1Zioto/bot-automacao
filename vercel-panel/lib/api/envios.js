const { query, json, lerBody, normalizarNumero, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

function normalizarDestino(numero, origem) {
    const valor = String(numero || '').trim();
    if (origem === 'chat' && /@(c\.us|lid)$/.test(valor)) return valor;
    return normalizarNumero(valor);
}

function limparBase64(valor) {
    return String(valor || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
}

function dadosMidia(body) {
    const mediaData = body.arquivo_base64 ? limparBase64(body.arquivo_base64) : null;
    const mediaUrl = body.arquivo_url ? String(body.arquivo_url).trim() : null;
    if (!mediaData && !mediaUrl) return null;
    if (mediaData && !body.mimetype) throw new Error('Informe o mimetype do arquivo.');
    if (mediaData && !/^[A-Za-z0-9+/=]+$/.test(mediaData)) throw new Error('arquivo_base64 invalido.');
    return {
        mimetype: body.mimetype ? String(body.mimetype) : null,
        data: mediaData,
        filename: body.nome_arquivo ? String(body.nome_arquivo) : null,
        url: mediaUrl,
        asDocument: Boolean(body.como_documento),
    };
}

function tokenDoReq(req, body = {}) {
    return String(body.token || req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
}

module.exports = async (req, res) => {
    // ----- ENVIO PUBLICO VIA API (token de API, sem login) -----
    // POST /api/envios?api=1   body: { token, numero, mensagem, arquivo_url|arquivo_base64? }
    // GET  /api/envios?api=1&token=...   lista envios da conta
    if (req.method === 'POST' && req.query.api === '1') {
        try {
            await initSchema();
            const body = await lerBody(req);
            const token = tokenDoReq(req, body);
            if (!token) return json(res, 401, { erro: 'Informe o token de API.' });
            const ur = await query('SELECT id FROM usuarios WHERE api_token = $1', [token]);
            if (!ur.rows[0]) return json(res, 401, { erro: 'Token de API invalido.' });
            const usuarioId = ur.rows[0].id;

            const media = dadosMidia(body);
            const mensagem = String(body.mensagem || body.legenda || '');
            if (!body.numero || (!mensagem && !media)) return json(res, 400, { erro: 'Informe numero e mensagem ou arquivo.' });
            const s = await query('SELECT id FROM sessoes WHERE usuario_id = $1', [usuarioId]);
            const sessao = s.rows[0];
            if (!sessao) return json(res, 400, { erro: 'Nenhum numero conectado nesta conta.' });

            const r = await query(
                `INSERT INTO envios
                 (usuario_id, sessao_id, numero, mensagem, origem, media_mimetype, media_data, media_filename, media_url, media_as_document)
                 VALUES ($1, $2, $3, $4, 'api', $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    usuarioId,
                    sessao.id,
                    normalizarNumero(body.numero),
                    mensagem,
                    media && media.mimetype,
                    media && media.data,
                    media && media.filename,
                    media && media.url,
                    media ? media.asDocument : false,
                ]
            );
            return json(res, 200, { ok: true, id: r.rows[0].id });
        } catch (e) {
            return json(res, 500, { erro: e.message });
        }
    }

    if (req.method === 'GET' && req.query.api === '1') {
        try {
            await initSchema();
            const token = tokenDoReq(req);
            if (!token) return json(res, 401, { erro: 'Informe o token de API.' });
            const ur = await query('SELECT id FROM usuarios WHERE api_token = $1', [token]);
            if (!ur.rows[0]) return json(res, 401, { erro: 'Token de API invalido.' });
            const limite = Math.min(Number(req.query.limite) || 50, 200);
            const r = await query(
                `SELECT id, numero, mensagem, status, origem, media_mimetype, media_filename, media_url,
                        media_as_document, agendar_para, tentativas, erro, criado_em, enviado_em
                 FROM envios
                 WHERE usuario_id = $1
                 ORDER BY criado_em DESC
                 LIMIT $2`,
                [ur.rows[0].id, limite]
            );
            return json(res, 200, r.rows);
        } catch (e) {
            return json(res, 500, { erro: e.message });
        }
    }

    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

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
            const { numeros, numero, agendar_para, todos_contatos, origem } = body;
            const media = dadosMidia(body);
            const mensagem = String(body.mensagem || body.legenda || '');
            if (!mensagem && !media) return json(res, 400, { erro: 'Informe a mensagem ou arquivo.' });

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
            let criados = 0;
            for (const n of lista) {
                await query(
                    `INSERT INTO envios
                     (usuario_id, sessao_id, numero, mensagem, agendar_para, origem, media_mimetype, media_data, media_filename, media_url, media_as_document)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        u.id,
                        sessao.id,
                        normalizarDestino(n, origemEfetiva),
                        mensagem,
                        agendarPara,
                        origemEfetiva,
                        media && media.mimetype,
                        media && media.data,
                        media && media.filename,
                        media && media.url,
                        media ? media.asDocument : false,
                    ]
                );
                criados++;
            }
            return json(res, 200, { ok: true, criados });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
