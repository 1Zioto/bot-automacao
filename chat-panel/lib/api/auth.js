const { query, json, lerBody, initSchema } = require('../_db');
const { hashSenha, verificarSenha, gerarToken } = require('../_auth');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { erro: 'Metodo nao suportado.' });
    try {
        await initSchema();
        const body = await lerBody(req);
        const acao = (body.acao || '').toLowerCase();
        const email = String(body.email || '').trim().toLowerCase();
        const senha = String(body.senha || '');

        if (!email || !senha) return json(res, 400, { erro: 'Informe email e senha.' });

        if (acao === 'registro') {
            if (senha.length < 6) return json(res, 400, { erro: 'A senha deve ter ao menos 6 caracteres.' });
            const existe = await query('SELECT id FROM usuarios WHERE email = $1', [email]);
            if (existe.rows[0]) return json(res, 409, { erro: 'Email ja cadastrado.' });
            const r = await query(
                'INSERT INTO usuarios (email, senha_hash, nome) VALUES ($1, $2, $3) RETURNING id, email, nome',
                [email, hashSenha(senha), body.nome || null]
            );
            const usuario = r.rows[0];
            // Cria a sessao do usuario (o motor vai detectar e gerar o QR).
            await query(
                "INSERT INTO sessoes (usuario_id, status) VALUES ($1, 'pendente') ON CONFLICT (usuario_id) DO NOTHING",
                [usuario.id]
            );
            return json(res, 200, { token: gerarToken(usuario), usuario });
        }

        if (acao === 'login') {
            const r = await query('SELECT id, email, nome, senha_hash FROM usuarios WHERE email = $1', [email]);
            const u = r.rows[0];
            if (!u || !verificarSenha(senha, u.senha_hash)) {
                return json(res, 401, { erro: 'Email ou senha incorretos.' });
            }
            const usuario = { id: u.id, email: u.email, nome: u.nome };
            return json(res, 200, { token: gerarToken(usuario), usuario });
        }

        return json(res, 400, { erro: 'Acao invalida (use registro ou login).' });
    } catch (e) {
        return json(res, 500, { erro: e.message });
    }
};
