const { json } = require('../lib/_db');

const handlers = {
    auth: require('../lib/api/auth'),
    contatos: require('../lib/api/contatos'),
    envios: require('../lib/api/envios'),
    mensagens: require('../lib/api/mensagens'),
    sessao: require('../lib/api/sessao'),
};

module.exports = async (req, res) => {
    const dynamicPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
    const urlPath = String(req.url || '').split('?')[0].replace(/^\/api\//, '').replace(/^\/+/, '');
    const path = dynamicPath || urlPath;
    const handler = handlers[path];
    if (!handler) return json(res, 404, { erro: 'API nao encontrada.' });
    return handler(req, res);
};
