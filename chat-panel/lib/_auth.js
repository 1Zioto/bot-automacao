const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'troque-este-segredo';
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function hashSenha(senha) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(String(senha), salt, 64).toString('hex');
    return `${salt}:${key}`;
}

function verificarSenha(senha, armazenado) {
    try {
        const [salt, key] = String(armazenado).split(':');
        const calc = crypto.scryptSync(String(senha), salt, 64);
        const orig = Buffer.from(key, 'hex');
        return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
    } catch {
        return false;
    }
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(s, 'base64').toString();
}
function assinar(parte) {
    return b64url(crypto.createHmac('sha256', SECRET).update(parte).digest());
}

function gerarToken(usuario) {
    const payload = { id: usuario.id, email: usuario.email, exp: Date.now() + VALIDADE_MS };
    const corpo = b64url(JSON.stringify(payload));
    return `${corpo}.${assinar(corpo)}`;
}

function verificarToken(token) {
    if (!token || token.indexOf('.') < 0) return null;
    const [corpo, sig] = token.split('.');
    if (assinar(corpo) !== sig) return null;
    try {
        const payload = JSON.parse(deB64url(corpo));
        if (!payload.exp || payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

function usuarioDoReq(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '') || req.headers['x-token'] || (req.query && req.query.token) || '';
    return verificarToken(token);
}

module.exports = { hashSenha, verificarSenha, gerarToken, verificarToken, usuarioDoReq };
