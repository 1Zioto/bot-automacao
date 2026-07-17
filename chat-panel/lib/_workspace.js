async function usuarioWorkspace(usuarioLogado) {
    // Isolamento obrigatorio: o workspace sempre pertence ao usuario
    // autenticado. Nunca redirecione uma conta para dados de outro usuario.
    return usuarioLogado || null;
}

module.exports = { usuarioWorkspace };
