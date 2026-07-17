// Mercado Pago - PIX. Access Token fica em process.env.MP_ACCESS_TOKEN (nunca no codigo).
const API = 'https://api.mercadopago.com';

async function criarPix({ valorCentavos, descricao, email, externalRef, notificationUrl }) {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) throw new Error('MP_ACCESS_TOKEN nao configurado.');
    const body = {
        transaction_amount: Number((valorCentavos / 100).toFixed(2)),
        description: descricao || 'Creditos',
        payment_method_id: 'pix',
        payer: { email: email || 'comprador@exemplo.com' },
    };
    if (externalRef) body.external_reference = String(externalRef);
    if (notificationUrl) body.notification_url = notificationUrl;

    const resp = await fetch(API + '/v1/payments', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            'X-Idempotency-Key': 'pix-' + (externalRef || Date.now()) + '-' + Math.random().toString(36).slice(2),
        },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data && data.message) || 'Falha ao criar pagamento PIX.');
    const tx = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
    return {
        id: String(data.id),
        status: data.status,
        qr_code: tx.qr_code || null,
        qr_base64: tx.qr_code_base64 || null,
    };
}

async function consultarPagamento(id) {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) throw new Error('MP_ACCESS_TOKEN nao configurado.');
    const resp = await fetch(API + '/v1/payments/' + id, {
        headers: { Authorization: 'Bearer ' + token },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data && data.message) || 'Falha ao consultar pagamento.');
    return { id: String(data.id), status: data.status, external_reference: data.external_reference };
}

module.exports = { criarPix, consultarPagamento };
