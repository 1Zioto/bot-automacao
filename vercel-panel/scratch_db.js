// Diagnostico seguro: nunca grave credenciais ou conteudo de mensagens aqui.
// Execute com DATABASE_URL definido no ambiente.
const { Client } = require('pg');

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL nao definido.');
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: true },
    });

    try {
        await client.connect();
        const result = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        console.log(JSON.stringify({ connected: true, tables: result.rows.map((row) => row.table_name) }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
