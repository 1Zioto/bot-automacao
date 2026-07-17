const { json, lerBody } = require('../_db');
const { usuarioDoReq } = require('../_auth');
const { variarMensagem } = require('../_ia');

// POST { texto } -> { texto: <reescrito pela IA> }
module.exports = async (req, res) => {
    const u = usuarioDoReq(req);
    if (!u) return json(res, 401, { erro: 'Nao autorizado' });
    if (req.method !== 'POST') return json(res, 405, { erro: 'Metodo nao suportado.' });
    try {
        const body = await lerBody(req);
        const texto = (body.texto || '').toString();
        if (!texto.trim()) return json(res, 400, { erro: 'Informe o texto base.' });
        if (!process.env.OPENAI_API_KEY) return json(res, 503, { erro: 'IA nao configurada (defina OPENAI_API_KEY).' });
        const variado = await variarMensagem(texto);
        return json(res, 200, { texto: variado });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
