const { query, json, lerBody, initSchema } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { criarPix, consultarPagamento } = require('../_mp');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'douglaszioto@gmail.com').toLowerCase();

// Credita o usuario quando um pagamento e aprovado (idempotente).
async function aplicarPagamentoAprovado(mpId) {
    const r = await query("SELECT * FROM pagamentos WHERE mp_payment_id = $1", [String(mpId)]);
    const pg = r.rows[0];
    if (!pg || pg.status === 'pago') return;
    await query("UPDATE pagamentos SET status='pago', pago_em=now() WHERE id=$1", [pg.id]);
    await query('UPDATE usuarios SET creditos = creditos + $1 WHERE id = $2', [pg.creditos, pg.usuario_id]);
}

module.exports = async (req, res) => {
    try {
        await initSchema();

        // ---- Webhook do Mercado Pago (publico, sem login) ----
        if (req.query.webhook === '1') {
            try {
                const body = await lerBody(req);
                const mpId = (body && body.data && body.data.id) || req.query.id || req.query['data.id'];
                const tipo = (body && body.type) || req.query.type || req.query.topic;
                if (mpId && (!tipo || tipo === 'payment')) {
                    const pay = await consultarPagamento(mpId);
                    if (pay.status === 'approved') await aplicarPagamentoAprovado(pay.id);
                }
            } catch (e) { /* responde 200 mesmo assim para o MP nao reenviar infinito */ }
            return json(res, 200, { ok: true });
        }

        const u = usuarioDoReq(req);
        if (!u) return json(res, 401, { erro: 'Nao autorizado' });
        const ehAdmin = String(u.email).toLowerCase() === ADMIN_EMAIL;
        const recurso = req.query.recurso || '';

        // ---- Planos ativos (qualquer usuario) ----
        if (recurso === 'planos' && req.method === 'GET') {
            const r = await query('SELECT id, nome, creditos, preco_centavos FROM planos WHERE ativo = true ORDER BY ordem ASC, preco_centavos ASC');
            return json(res, 200, r.rows);
        }

        // ---- Saldo do usuario + pagamentos recentes ----
        if (recurso === 'saldo' && req.method === 'GET') {
            const c = await query('SELECT creditos FROM usuarios WHERE id = $1', [u.id]);
            const pg = await query("SELECT id, creditos, valor_centavos, status, criado_em, pago_em FROM pagamentos WHERE usuario_id=$1 ORDER BY criado_em DESC LIMIT 20", [u.id]);
            return json(res, 200, { creditos: c.rows[0] ? c.rows[0].creditos : 0, pagamentos: pg.rows });
        }

        // ---- Comprar um plano: cria PIX ----
        if (recurso === 'comprar' && req.method === 'POST') {
            const b = await lerBody(req);
            const pl = (await query('SELECT * FROM planos WHERE id=$1 AND ativo=true', [Number(b.plano_id)])).rows[0];
            if (!pl) return json(res, 400, { erro: 'Plano invalido.' });
            const notificationUrl = `https://${req.headers.host}/api/billing?webhook=1`;
            const pix = await criarPix({
                valorCentavos: pl.preco_centavos,
                descricao: pl.nome,
                email: u.email,
                externalRef: 'u' + u.id + '-p' + pl.id + '-' + Date.now(),
                notificationUrl,
            });
            const r = await query(
                `INSERT INTO pagamentos (usuario_id, plano_id, creditos, valor_centavos, status, mp_payment_id, qr_code, qr_base64)
                 VALUES ($1,$2,$3,$4,'pendente',$5,$6,$7) RETURNING id`,
                [u.id, pl.id, pl.creditos, pl.preco_centavos, pix.id, pix.qr_code, pix.qr_base64]
            );
            return json(res, 200, { pagamento_id: r.rows[0].id, qr_code: pix.qr_code, qr_base64: pix.qr_base64 });
        }

        // ---- Status de um pagamento (poll) ----
        if (recurso === 'pagamento' && req.method === 'GET') {
            const id = Number(req.query.id);
            const r = await query('SELECT mp_payment_id, status FROM pagamentos WHERE id=$1 AND usuario_id=$2', [id, u.id]);
            const pg = r.rows[0];
            if (!pg) return json(res, 404, { erro: 'Pagamento nao encontrado.' });
            // confirma no MP (caso o webhook ainda nao tenha chegado)
            if (pg.status !== 'pago' && pg.mp_payment_id) {
                try { const pay = await consultarPagamento(pg.mp_payment_id); if (pay.status === 'approved') { await aplicarPagamentoAprovado(pay.id); pg.status = 'pago'; } } catch (e) {}
            }
            return json(res, 200, { status: pg.status });
        }

        // ================= ADMIN =================
        if (!ehAdmin) return json(res, 403, { erro: 'Acesso restrito.' });

        // listar todos os planos (admin)
        if (recurso === 'admin_planos' && req.method === 'GET') {
            const r = await query('SELECT * FROM planos ORDER BY ordem ASC, preco_centavos ASC');
            return json(res, 200, r.rows);
        }
        // criar/editar plano
        if (recurso === 'admin_planos' && req.method === 'POST') {
            const b = await lerBody(req);
            const nome = (b.nome || '').trim();
            const creditos = Number(b.creditos);
            const preco = Number(b.preco_centavos);
            const ativo = b.ativo === undefined ? true : !!b.ativo;
            const ordem = Number(b.ordem) || 0;
            if (!nome || !Number.isFinite(creditos) || creditos <= 0 || !Number.isFinite(preco) || preco <= 0) {
                return json(res, 400, { erro: 'Dados invalidos.' });
            }
            if (b.id) {
                await query('UPDATE planos SET nome=$1,creditos=$2,preco_centavos=$3,ativo=$4,ordem=$5 WHERE id=$6',
                    [nome, creditos, preco, ativo, ordem, Number(b.id)]);
                return json(res, 200, { ok: true, id: Number(b.id) });
            }
            const r = await query('INSERT INTO planos (nome,creditos,preco_centavos,ativo,ordem) VALUES ($1,$2,$3,$4,$5) RETURNING id',
                [nome, creditos, preco, ativo, ordem]);
            return json(res, 200, { ok: true, id: r.rows[0].id });
        }
        // excluir plano
        if (recurso === 'admin_planos' && req.method === 'DELETE') {
            await query('DELETE FROM planos WHERE id=$1', [Number(req.query.id)]);
            return json(res, 200, { ok: true });
        }
        // ajustar creditos de um usuario manualmente (admin)
        if (recurso === 'admin_creditos' && req.method === 'POST') {
            const b = await lerBody(req);
            await query('UPDATE usuarios SET creditos = creditos + $1 WHERE id = $2', [Number(b.delta) || 0, Number(b.usuario_id)]);
            return json(res, 200, { ok: true });
        }

        return json(res, 400, { erro: 'Recurso invalido.' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
