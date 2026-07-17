const { query, json, lerBody, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { proximaExecucao, parseHorario } = require('../_agenda');

async function recursoDoUsuario(tabela, id, usuarioId) {
    const tabelasPermitidas = new Set(['listas', 'modelos']);
    if (!tabelasPermitidas.has(tabela)) return false;
    const r = await query(`SELECT id FROM ${tabela} WHERE id = $1 AND usuario_id = $2`, [Number(id), usuarioId]);
    return !!r.rows[0];
}

module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    try {
        await initSchema();

        if (req.method === 'GET') {
            const r = await query(
                `SELECT a.*, l.nome AS lista_nome, m.titulo AS modelo_titulo
                 FROM agendamentos a
                 LEFT JOIN listas l ON l.id = a.lista_id
                 LEFT JOIN modelos m ON m.id = a.modelo_id
                 WHERE a.usuario_id = $1 ORDER BY a.criado_em DESC`,
                [u.id]
            );
            return json(res, 200, r.rows);
        }

        if (req.method === 'POST' || req.method === 'PUT') {
            const editId = req.method === 'PUT' ? Number(req.query.id) : null;
            if (req.method === 'PUT' && !editId) return json(res, 400, { erro: 'Informe o id do agendamento.' });
            const b = await lerBody(req);
            const destino_tipo = b.destino_tipo === 'todos' ? 'todos' : 'lista';
            const conteudo_tipo = b.conteudo_tipo === 'modelo' ? 'modelo' : 'texto';
            const tipo = ['unico', 'diario', 'semanal', 'quinzenal', 'mensal'].indexOf(b.tipo) >= 0 ? b.tipo : 'unico';

            if (destino_tipo === 'lista' && (!b.lista_id || !(await recursoDoUsuario('listas', b.lista_id, u.id)))) {
                return json(res, 400, { erro: 'Selecione uma lista valida.' });
            }
            if (conteudo_tipo === 'modelo' && (!b.modelo_id || !(await recursoDoUsuario('modelos', b.modelo_id, u.id)))) {
                return json(res, 400, { erro: 'Selecione um modelo valido.' });
            }
            if (conteudo_tipo === 'texto' && !b.mensagem) return json(res, 400, { erro: 'Informe a mensagem.' });

            let dias = null;
            if (tipo === 'unico') {
                if (!b.agendar_para) return json(res, 400, { erro: 'Informe data e hora.' });
            } else {
                if (!parseHorario(b.horario)) return json(res, 400, { erro: 'Horario invalido (use HH:MM).' });
                if (tipo === 'semanal') {
                    dias = (b.dias_semana || []).map(Number).filter((n) => n >= 0 && n <= 6);
                    if (!dias.length) return json(res, 400, { erro: 'Selecione ao menos um dia da semana.' });
                }
                if (tipo === 'mensal') {
                    dias = (b.dias_semana || []).map(Number).filter((n) => n >= 1 && n <= 31);
                    if (!dias.length) return json(res, 400, { erro: 'Dia do mes invalido.' });
                }
            }

            const prox = proximaExecucao(tipo, b.horario, dias, b.agendar_para);
            if (!prox) return json(res, 400, { erro: 'Nao foi possivel calcular o horario.' });

            if (editId) {
                // Edicao: atualiza tudo, recalcula a proxima execucao e reativa.
                const r = await query(
                    `UPDATE agendamentos SET
                       nome=$3, destino_tipo=$4, lista_id=$5, conteudo_tipo=$6, modelo_id=$7,
                       mensagem=$8, tipo=$9, horario=$10, dias_semana=$11, proxima_execucao=$12, ativo=true
                     WHERE id=$1 AND usuario_id=$2 RETURNING *`,
                    [editId, u.id, b.nome || null, destino_tipo, b.lista_id || null, conteudo_tipo,
                     b.modelo_id || null, b.mensagem || null, tipo, b.horario || null, dias, prox]
                );
                if (!r.rows[0]) return json(res, 404, { erro: 'Agendamento nao encontrado.' });
                return json(res, 200, r.rows[0]);
            }

            const r = await query(
                `INSERT INTO agendamentos
                 (usuario_id, nome, destino_tipo, lista_id, conteudo_tipo, modelo_id, mensagem, tipo, horario, dias_semana, proxima_execucao)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
                [u.id, b.nome || null, destino_tipo, b.lista_id || null, conteudo_tipo, b.modelo_id || null,
                 b.mensagem || null, tipo, b.horario || null, dias, prox]
            );
            return json(res, 200, r.rows[0]);
        }

        // PATCH (via POST ?acao=toggle): liga/desliga
        if (req.method === 'PATCH') {
            const id = Number(req.query.id);
            if (!id) return json(res, 400, { erro: 'Informe o id.' });
            const r = await query(
                'UPDATE agendamentos SET ativo = NOT ativo WHERE id = $1 AND usuario_id = $2 RETURNING ativo',
                [id, u.id]
            );
            if (!r.rows[0]) return json(res, 404, { erro: 'Agendamento nao encontrado.' });
            return json(res, 200, { ok: true, ativo: r.rows[0].ativo });
        }

        if (req.method === 'DELETE') {
            const id = Number(req.query.id);
            if (!id) return json(res, 400, { erro: 'Informe o id.' });
            await query('DELETE FROM agendamentos WHERE id = $1 AND usuario_id = $2', [id, u.id]);
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { erro: 'Metodo nao suportado.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
