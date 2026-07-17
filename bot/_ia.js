// Reescreve uma mensagem mantendo o sentido (anti-bloqueio). Chave em process.env.OPENAI_API_KEY.
async function variarMensagem(texto, opcoes) {
    opcoes = opcoes || {};
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !texto) return texto;

    const sistema =
        'Voce reescreve mensagens de WhatsApp mantendo EXATAMENTE o mesmo sentido e o mesmo idioma. ' +
        'Mude palavras e a estrutura para que cada versao fique diferente e natural, sem alterar a informacao. ' +
        'REGRA CRITICA: NAO altere, traduza, remova nem mova os marcadores entre chaves (ex.: {nome}, {primeiro_nome}, {numero}, {data}, {hora}, {saudacao}). ' +
        'Eles sao padrao do sistema e devem aparecer no texto final escritos identicamente, inclusive as chaves. ' +
        'Responda APENAS com a mensagem reescrita, sem aspas e sem explicacoes.';

    try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
            body: JSON.stringify({
                model: opcoes.model || 'gpt-4o-mini',
                temperature: 0.9,
                messages: [
                    { role: 'system', content: sistema },
                    { role: 'user', content: String(texto) },
                ],
            }),
        });
        if (!resp.ok) return texto;
        const data = await resp.json();
        const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!out || !out.trim()) return texto;
        const limpo = out.trim();
        // As tags {..} da saida devem ser exatamente as mesmas da entrada (sem perder nem injetar).
        const norm = (s) => ((String(s).match(/\{[a-z_]+\}/gi) || []).map((t) => t.toLowerCase()).sort().join(','));
        if (norm(limpo) !== norm(texto)) return texto;
        return limpo;
    } catch (e) {
        return texto;
    }
}

module.exports = { variarMensagem };
