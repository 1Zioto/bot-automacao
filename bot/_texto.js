// Substitui variaveis (mala direta) pelos dados do contato e data/hora (fuso BRT).
// Tags: {nome}, {primeiro_nome}, {numero}, {data}, {hora}, {saudacao}
const OFFSET_MS = 3 * 60 * 60 * 1000; // BRT = UTC - 3h

function aplicarVariaveis(texto, contato, agora) {
    if (!texto) return texto;
    const nome = (contato && contato.nome) ? String(contato.nome) : '';
    const numero = (contato && contato.numero) ? String(contato.numero) : '';
    const primeiro = nome.trim().split(/\s+/)[0] || '';

    const brt = new Date((agora ? agora.getTime() : Date.now()) - OFFSET_MS);
    const dd = String(brt.getUTCDate()).padStart(2, '0');
    const mm = String(brt.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = brt.getUTCFullYear();
    const hh = String(brt.getUTCHours()).padStart(2, '0');
    const min = String(brt.getUTCMinutes()).padStart(2, '0');
    const data = `${dd}/${mm}/${yyyy}`;
    const hora = `${hh}:${min}`;
    const h = brt.getUTCHours();
    const saudacao = h < 12 ? 'Bom dia' : (h < 18 ? 'Boa tarde' : 'Boa noite');

    return String(texto)
        .replace(/\{primeiro_nome\}/gi, primeiro)
        .replace(/\{nome\}/gi, nome)
        .replace(/\{numero\}/gi, numero)
        .replace(/\{data\}/gi, data)
        .replace(/\{hora\}/gi, hora)
        .replace(/\{saudacao\}/gi, saudacao);
}

module.exports = { aplicarVariaveis };
