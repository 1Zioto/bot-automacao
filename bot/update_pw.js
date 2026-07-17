require('dotenv').config(); 
const { query } = require('./vercel-panel/lib/_db.js'); 
const { hashSenha } = require('./vercel-panel/lib/_auth.js'); 
query('UPDATE usuarios SET senha_hash = $1 WHERE email = $2', [hashSenha('635241@Ab'), 'douglaszioto@gmail.com']).then(r => { console.log('Rows updated:', r.rowCount); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })
