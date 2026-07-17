const OFFSET_MS = 3 * 60 * 60 * 1000; // BRT = UTC - 3h

function parseHorario(horario) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(horario || '').trim());
    if (!m) return null;
    const h = Number(m[1]); const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
}

function brtParaUtcMs(y, m, d, h, min) {
    return Date.UTC(y, m, d, h, min, 0) + OFFSET_MS;
}

function proximaExecucao(tipo, horario, diasSemana, agendarPara, base) {
    base = base || new Date();
    const baseMs = base.getTime();

    if (tipo === 'unico') {
        if (!agendarPara) return null;
        const d = new Date(agendarPara);
        return isNaN(d.getTime()) ? null : d;
    }

    const hm = parseHorario(horario);
    if (!hm) return null;

    const brt = new Date(baseMs - OFFSET_MS);
    const y = brt.getUTCFullYear();
    const mo = brt.getUTCMonth();
    const dia = brt.getUTCDate();

    if (tipo === 'diario') {
        let ms = brtParaUtcMs(y, mo, dia, hm.h, hm.min);
        if (ms <= baseMs) ms = brtParaUtcMs(y, mo, dia + 1, hm.h, hm.min);
        return new Date(ms);
    }

    if (tipo === 'semanal') {
        const dias = (diasSemana || []).map(Number);
        if (!dias.length) return null;
        for (let off = 0; off <= 7; off++) {
            const cand = new Date(Date.UTC(y, mo, dia + off));
            const wd = cand.getUTCDay();
            if (dias.indexOf(wd) >= 0) {
                const ms = brtParaUtcMs(y, mo, dia + off, hm.h, hm.min);
                if (ms > baseMs) return new Date(ms);
            }
        }
        return null;
    }

    if (tipo === 'quinzenal') {
        let ms = brtParaUtcMs(y, mo, dia, hm.h, hm.min);
        if (ms <= baseMs) ms = brtParaUtcMs(y, mo, dia + 15, hm.h, hm.min);
        return new Date(ms);
    }

    if (tipo === 'mensal') {
        const d = (diasSemana && diasSemana[0]) || dia;
        let ms = brtParaUtcMs(y, mo, d, hm.h, hm.min);
        if (ms <= baseMs) {
            ms = brtParaUtcMs(y, mo + 1, d, hm.h, hm.min);
        }
        return new Date(ms);
    }

    return null;
}

module.exports = { proximaExecucao, parseHorario };
