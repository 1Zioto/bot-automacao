const { query, json, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'douglaszioto@gmail.com').toLowerCase();

module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    if (req.method !== 'GET') return json(res, 405, { erro: 'Metodo nao suportado.' });
    try {
        await initSchema();

        // ----- Painel admin: lista de contas cadastradas (somente admin) -----
        if (req.query.contas === '1') {
            if (String(u.email).toLowerCase() !== ADMIN_EMAIL) return json(res, 403, { erro: 'Acesso restrito.' });
            const r = await query(
                `SELECT u.id, u.email, u.nome, u.criado_em,
                        s.status AS sessao_status, s.numero_conectado,
                        (SELECT COUNT(*) FROM envios m WHERE m.usuario_id = u.id AND m.status='enviada')::int AS enviadas,
                        (SELECT COUNT(*) FROM contatos c WHERE c.usuario_id = u.id)::int AS contatos,
                        (SELECT COUNT(*) FROM agendamentos a WHERE a.usuario_id = u.id AND a.ativo=true)::int AS agendamentos_ativos
                 FROM usuarios u
                 LEFT JOIN sessoes s ON s.usuario_id = u.id
                 ORDER BY u.criado_em DESC`
            );
            return json(res, 200, { contas: r.rows });
        }

        // Totais de mensagens por direcao/status.
        const msg = await query(
            `SELECT
               COUNT(*) FILTER (WHERE status='enviada') ::int AS enviadas,
               0::int AS recebidas,
               COUNT(*) FILTER (WHERE status='enviada' AND enviado_em >= now() - interval '1 day')::int AS enviadas_24h,
               COUNT(*) FILTER (WHERE status='enviada' AND origem='api')::int AS enviadas_api,
               COUNT(*) FILTER (WHERE status='enviada' AND origem='agenda')::int AS enviadas_agenda
             FROM envios WHERE usuario_id = $1`,
            [u.id]
        );

        // Totais da fila por status.
        const fila = await query(
            `SELECT
               COUNT(*) FILTER (WHERE status='pendente') ::int AS pendentes,
               COUNT(*) FILTER (WHERE status='erro')     ::int AS erros,
               COUNT(*) FILTER (WHERE status='enviada')  ::int AS enviadas
             FROM envios WHERE usuario_id = $1`,
            [u.id]
        );

        // Enviadas por dia (ultimos 7 dias).
        const porDia = await query(
            `SELECT to_char(date_trunc('day', enviado_em), 'DD/MM') AS dia, COUNT(*)::int AS total
             FROM envios
             WHERE usuario_id = $1 AND status='enviada' AND enviado_em >= now() - interval '7 days'
             GROUP BY 1 ORDER BY MIN(enviado_em)`,
            [u.id]
        );

        // Contadores gerais.
        const gerais = await query(
            `SELECT
               (SELECT COUNT(*)::int FROM contatos WHERE usuario_id=$1) AS contatos,
               (SELECT COUNT(*)::int FROM listas WHERE usuario_id=$1) AS listas,
               (SELECT COUNT(*)::int FROM agendamentos WHERE usuario_id=$1 AND ativo=true) AS agendamentos_ativos`,
            [u.id]
        );

        return json(res, 200, {
            mensagens: msg.rows[0],
            fila: fila.rows[0],
            por_dia: porDia.rows,
            gerais: gerais.rows[0],
        });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
