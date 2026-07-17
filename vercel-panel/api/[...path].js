const { json } = require('../lib/_db');

const handlers = {
    agendamentos: require('../lib/api/agendamentos'),
    auth: require('../lib/api/auth'),
    billing: require('../lib/api/billing'),
    config: require('../lib/api/config'),
    contatos: require('../lib/api/contatos'),
    envios: require('../lib/api/envios'),
    ia: require('../lib/api/ia'),
    'lista-itens': require('../lib/api/lista-itens'),
    listas: require('../lib/api/listas'),
    modelos: require('../lib/api/modelos'),
    relatorio: require('../lib/api/relatorio'),
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
