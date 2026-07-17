import './styles.css';
import './onboarding.css';

const API = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, '');
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const badge = (value) => `<span class="badge ${esc(value)}">${esc(value)}</span>`;
const session = { access: localStorage.getItem('accessToken'), refresh: localStorage.getItem('refreshToken'), me: null };
let currentPage = 'dashboard';

function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.className = `show${error ? ' error' : ''}`;
  setTimeout(() => { node.className = ''; }, 3500);
}

function saveSession(data) {
  session.access = data.accessToken; session.refresh = data.refreshToken;
  localStorage.setItem('accessToken', session.access); localStorage.setItem('refreshToken', session.refresh);
}

function clearSession() {
  session.access = null; session.refresh = null; session.me = null;
  localStorage.removeItem('accessToken'); localStorage.removeItem('refreshToken');
}

async function refreshSession() {
  if (!session.refresh) return false;
  const response = await fetch(`${API}/api/v1/auth/refresh`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ refreshToken: session.refresh }) });
  if (!response.ok) return false;
  saveSession(await response.json()); return true;
}

async function api(path, options = {}, retry = true) {
  const headers = { ...(options.body ? {'content-type':'application/json'} : {}), ...(options.headers || {}) };
  if (session.access) headers.authorization = `Bearer ${session.access}`;
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (response.status === 401 && retry && await refreshSession()) return api(path, options, false);
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Falha HTTP ${response.status}`);
  return data;
}

async function boot() {
  if (!session.access) return showLogin();
  try {
    session.me = await api('/api/v1/auth/me');
    $('#identity').textContent = `${session.me.email} · ${session.me.role}`;
    $('#auth').classList.add('hidden'); $('#shell').classList.remove('hidden');
    $('#health').textContent = 'Online'; $('#health').className = 'status';
    await navigate(currentPage);
  } catch { clearSession(); showLogin(); }
}

function showLogin() { $('#auth').classList.remove('hidden'); $('#shell').classList.add('hidden'); }

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const message = $('#login-message'); message.textContent = '';
  try {
    const body = Object.fromEntries(form); if (!body.tenantSlug) delete body.tenantSlug;
    const data = await api('/api/v1/auth/login', { method:'POST', body:JSON.stringify(body) });
    saveSession(data); await boot();
  } catch (error) { message.textContent = error.message; }
});

document.querySelectorAll('[data-auth-view]').forEach((button) => button.addEventListener('click', () => {
  const target = button.dataset.authView;
  const forms = { login: '#login-form', register: '#register-form', invite: '#invite-form-auth' };
  Object.entries(forms).forEach(([name, selector]) => $(selector).classList.toggle('hidden', name !== target));
}));

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const output = event.currentTarget.querySelector('output'); output.textContent = '';
  try {
    const data = await api('/api/v1/auth/register', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    saveSession(data); await boot();
  } catch (error) { output.textContent = error.message; }
});

$('#invite-form-auth').addEventListener('submit', async (event) => {
  event.preventDefault(); const output = event.currentTarget.querySelector('output'); output.textContent = '';
  try {
    const data = await api('/api/v1/auth/accept-invitation', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    saveSession(data); await boot();
  } catch (error) { output.textContent = error.message; }
});

$('#logout').addEventListener('click', async () => {
  if (session.refresh) await api('/api/v1/auth/logout', { method:'POST', body:JSON.stringify({ refreshToken:session.refresh }) }).catch(() => {});
  clearSession(); showLogin();
});
$('#menu').addEventListener('click', () => $('.shell aside').classList.toggle('open'));
$('#nav').addEventListener('click', (event) => { const page = event.target.dataset.page; if (page) void navigate(page); });

async function navigate(page) {
  currentPage = page; $('.shell aside').classList.remove('open');
  document.querySelectorAll('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const titles = {dashboard:'Visao geral',instances:'Instancias',contacts:'Contatos',lists:'Listas',campaigns:'Campanhas',team:'Equipe',integrations:'Integracoes',billing:'Plano e cobranca'};
  $('#page-title').textContent = titles[page]; $('#content').innerHTML = '<div class="empty">Carregando...</div>';
  try { await pages[page](); } catch (error) { $('#content').innerHTML = `<div class="panel empty">${esc(error.message)}</div>`; toast(error.message, true); }
}

const head = (title, description, action = '') => `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
const rows = (items, render, columns) => items.length ? `<div class="table-wrap"><table><thead><tr>${columns.map((c)=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${items.map(render).join('')}</tbody></table></div>` : '<div class="empty">Nenhum registro ainda.</div>';

const pages = {
  async dashboard() {
    const [instances, campaigns, subscription] = await Promise.all([
      api('/api/v1/instances'), api('/api/v1/campaigns'), api('/api/v1/billing/subscription').catch(()=>null),
    ]);
    const sent = campaigns.data.reduce((sum, item) => sum + item.sent_count, 0);
    $('#content').innerHTML = `${head('Visao geral','Acompanhe a operacao em um unico lugar.')}
      <div class="cards"><div class="card"><span class="muted">Instancias prontas</span><div class="metric">${instances.data.filter(i=>i.status==='READY').length}</div></div>
      <div class="card"><span class="muted">Campanhas</span><div class="metric">${campaigns.data.length}</div></div>
      <div class="card"><span class="muted">Mensagens enviadas</span><div class="metric">${sent}</div></div>
      <div class="card"><span class="muted">Plano</span><div class="metric">${esc(subscription?.subscription?.plan_name || '—')}</div></div></div>
      <div class="panel"><h2>Campanhas recentes</h2>${rows(campaigns.data.slice(0,6), c=>`<tr><td>${esc(c.name)}</td><td>${badge(c.status)}</td><td>${c.total_recipients}</td><td>${c.sent_count}</td></tr>`,['Campanha','Estado','Destinatarios','Enviadas'])}</div>`;
  },
  async instances() {
    const data = await api('/api/v1/instances');
    $('#content').innerHTML = `${head('Instancias','Cada numero possui sessao, limite e janela proprios.')}
      <div class="panel"><h2>Nova instancia</h2><form id="instance-form" class="form-grid"><label>Nome<input name="name" required placeholder="Atendimento principal"></label><div class="form-actions"><button class="primary">Criar instancia</button></div></form></div>
      <div class="panel"><h2>Numeros conectados</h2>${rows(data.data,i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.phone_number||'Aguardando conexao')}</td><td>${badge(i.status)}</td><td>${i.last_heartbeat_at?new Date(i.last_heartbeat_at).toLocaleString('pt-BR'):'—'}</td><td class="actions"><button data-init="${i.id}">Inicializar</button><button data-qr="${i.id}">Ver QR</button></td></tr>`,['Nome','Numero','Estado','Ultimo sinal','Acoes'])}</div><div id="qr-panel"></div>`;
    $('#instance-form').addEventListener('submit', submitJson('/api/v1/instances', () => navigate('instances')));
    document.querySelectorAll('[data-init]').forEach(b=>b.onclick=async()=>{await api(`/api/v1/instances/${b.dataset.init}/initialize`,{method:'POST'});toast('Inicializacao solicitada.');});
    document.querySelectorAll('[data-qr]').forEach(b=>b.onclick=async()=>{const q=await api(`/api/v1/instances/${b.dataset.qr}/qr`);$('#qr-panel').innerHTML=`<div class="panel"><h2>Conexao por QR</h2>${q.qr?`<img class="qr" src="${q.qr}" alt="QR Code temporario">`:`<div class="empty">QR ainda nao disponivel. Estado: ${esc(q.status)}</div>`}</div>`;});
  },
  async contacts() {
    const data = await api('/api/v1/contacts?limit=200');
    $('#content').innerHTML = `${head('Contatos','Somente contatos com consentimento valido entram em envios.')}
      <div class="panel"><h2>Novo contato</h2><form id="contact-form" class="form-grid"><label>Nome<input name="name" required></label><label>WhatsApp<input name="phoneNumber" required placeholder="5511999999999"></label><label>Origem do consentimento<input name="consentSource" required placeholder="Formulario do site"></label><label>Data do consentimento<input name="consentAt" type="datetime-local" required></label><input type="hidden" name="consentStatus" value="GRANTED"><div class="form-actions"><button class="primary">Salvar contato</button></div></form></div>
      <div class="panel"><h2>Base de contatos</h2>${rows(data.data,c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.phone_number)}</td><td>${badge(c.consent_status)}</td><td>${esc(c.consent_source)}</td><td class="actions">${c.consent_status==='GRANTED'?`<button class="danger" data-optout="${c.id}">Remover consentimento</button>`:''}</td></tr>`,['Nome','WhatsApp','Consentimento','Origem','Acoes'])}</div>`;
    $('#contact-form').addEventListener('submit', async(event)=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));body.consentAt=new Date(body.consentAt).toISOString();body.customFields={};await api('/api/v1/contacts',{method:'POST',body:JSON.stringify(body)});toast('Contato salvo.');await navigate('contacts');});
    document.querySelectorAll('[data-optout]').forEach(b=>b.onclick=async()=>{if(confirm('Remover o consentimento deste contato?')){await api(`/api/v1/contacts/${b.dataset.optout}/opt-out`,{method:'POST'});await navigate('contacts');}});
  },
  async lists() {
    const [lists, contacts] = await Promise.all([api('/api/v1/lists'),api('/api/v1/contacts?limit=200')]);
    $('#content').innerHTML = `${head('Listas','Organize contatos autorizados para suas campanhas.')}
      <div class="panel"><h2>Nova lista</h2><form id="list-form" class="form-grid"><label>Nome<input name="name" required></label><label>Descricao<input name="description"></label><div class="wide checks">${contacts.data.map(c=>`<label><input type="checkbox" name="contactIds" value="${c.id}">${esc(c.name)}</label>`).join('')||'<span class="muted">Cadastre contatos primeiro.</span>'}</div><div class="form-actions"><button class="primary">Criar lista</button></div></form></div>
      <div class="panel"><h2>Listas ativas</h2>${rows(lists.data,l=>`<tr><td>${esc(l.name)}</td><td>${esc(l.description||'—')}</td><td>${l.contact_count}</td><td>${badge(l.status)}</td></tr>`,['Nome','Descricao','Contatos','Estado'])}</div>`;
    $('#list-form').addEventListener('submit',async(event)=>{event.preventDefault();const fd=new FormData(event.currentTarget);await api('/api/v1/lists',{method:'POST',body:JSON.stringify({name:fd.get('name'),description:fd.get('description')||undefined,contactIds:fd.getAll('contactIds')})});toast('Lista criada.');await navigate('lists');});
  },
  async campaigns() {
    const [campaigns,instances,lists] = await Promise.all([api('/api/v1/campaigns'),api('/api/v1/instances'),api('/api/v1/lists')]);
    $('#content').innerHTML = `${head('Campanhas','Prepare, revise e acompanhe cada envio.')}
      <div class="panel"><h2>Nova campanha</h2><form id="campaign-form" class="form-grid"><label>Nome<input name="name" required></label><label>Instancia<select name="instanceId" required>${instances.data.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></label><label class="wide">Lista<select name="listId" required>${lists.data.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label><label class="wide">Mensagem<textarea name="messageTemplate" required rows="5" placeholder="Ola, {{nome}}!"></textarea></label><div class="form-actions"><button class="primary">Criar rascunho</button></div></form></div>
      <div class="panel"><h2>Campanhas</h2>${rows(campaigns.data,c=>`<tr><td>${esc(c.name)}</td><td>${badge(c.status)}</td><td>${c.total_recipients}</td><td>${c.sent_count}</td><td>${c.failed_count}</td><td class="actions">${c.status==='DRAFT'?`<button data-start="${c.id}">Iniciar</button>`:''}${c.status==='RUNNING'?`<button data-action="pause" data-id="${c.id}">Pausar</button>`:''}${c.status==='PAUSED'?`<button data-action="resume" data-id="${c.id}">Retomar</button>`:''}${!['COMPLETED','CANCELED'].includes(c.status)?`<button class="danger" data-action="cancel" data-id="${c.id}">Cancelar</button>`:''}</td></tr>`,['Nome','Estado','Total','Enviadas','Falhas','Acoes'])}</div>`;
    $('#campaign-form').addEventListener('submit',async(event)=>{event.preventDefault();const fd=new FormData(event.currentTarget);await api('/api/v1/campaigns',{method:'POST',body:JSON.stringify({name:fd.get('name'),instanceId:fd.get('instanceId'),listIds:[fd.get('listId')],messageTemplate:fd.get('messageTemplate')})});toast('Rascunho criado.');await navigate('campaigns');});
    document.querySelectorAll('[data-start]').forEach(b=>b.onclick=async()=>{if(confirm('Confirmo que todos os destinatarios autorizaram este contato.')){await api(`/api/v1/campaigns/${b.dataset.start}/start`,{method:'POST',body:JSON.stringify({consentConfirmed:true})});await navigate('campaigns');}});
    document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{await api(`/api/v1/campaigns/${b.dataset.id}/${b.dataset.action}`,{method:'POST'});await navigate('campaigns');});
  },
  async team() {
    const data = await api('/api/v1/team');
    $('#content').innerHTML = `${head('Equipe','Controle funcoes e acesso de cada pessoa.')}
      <div class="panel"><h2>Convidar pessoa</h2><form id="invite-form" class="form-grid"><label>E-mail<input name="email" type="email" required></label><label>Funcao<select name="role"><option>OPERATOR</option><option>ANALYST</option><option>ADMIN</option><option>OWNER</option></select></label><div class="form-actions"><button class="primary">Gerar convite</button></div></form><div id="invite-result"></div></div>
      <div class="panel"><h2>Membros</h2>${rows(data.members,m=>`<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${badge(m.role)}</td><td>${badge(m.status)}</td></tr>`,['Nome','E-mail','Funcao','Estado'])}</div>
      <div class="panel"><h2>Convites pendentes</h2>${rows(data.invitations,i=>`<tr><td>${esc(i.email)}</td><td>${badge(i.role)}</td><td>${new Date(i.expires_at).toLocaleDateString('pt-BR')}</td></tr>`,['E-mail','Funcao','Expira em'])}</div>`;
    $('#invite-form').addEventListener('submit',async(event)=>{event.preventDefault();const result=await api('/api/v1/team/invitations',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});$('#invite-result').innerHTML=`<p class="muted">Envie este codigo por um canal seguro. Ele aparece apenas agora:</p><code>${esc(result.token)}</code>`;});
  },
  async integrations() {
    const [keys,hooks] = await Promise.all([api('/api/v1/api-keys'),api('/api/v1/webhooks').catch(()=>({data:[]}))]);
    $('#content').innerHTML = `${head('Integracoes','Use chaves com escopo minimo e webhooks assinados.')}
      <div class="panel"><h2>Nova chave</h2><form id="key-form" class="form-grid"><label>Nome<input name="name" required></label><div class="wide checks"><label><input type="checkbox" name="scopes" value="messages:write" checked>Enviar mensagens</label><label><input type="checkbox" name="scopes" value="messages:read" checked>Ler estados</label><label><input type="checkbox" name="scopes" value="contacts:read">Ler contatos</label></div><div class="form-actions"><button class="primary">Criar chave</button></div></form><div id="key-result"></div></div>
      <div class="panel"><h2>Chaves</h2>${rows(keys.data,k=>`<tr><td>${esc(k.name)}</td><td><code>${esc(k.key_prefix)}...</code></td><td>${k.scopes.map(esc).join(', ')}</td><td>${k.revoked_at?'Revogada':'Ativa'}</td></tr>`,['Nome','Prefixo','Escopos','Estado'])}</div>
      <div class="panel"><h2>Webhooks</h2>${rows(hooks.data,h=>`<tr><td>${esc(h.name)}</td><td>${esc(h.url)}</td><td>${badge(h.status)}</td><td>${h.consecutive_failures}</td></tr>`,['Nome','URL','Estado','Falhas'])}</div>`;
    $('#key-form').addEventListener('submit',async(event)=>{event.preventDefault();const fd=new FormData(event.currentTarget);const result=await api('/api/v1/api-keys',{method:'POST',body:JSON.stringify({name:fd.get('name'),scopes:fd.getAll('scopes')})});$('#key-result').innerHTML=`<p class="muted">Copie agora. A chave completa nao sera mostrada novamente:</p><code>${esc(result.key)}</code>`;});
  },
  async billing() {
    const [plans,current] = await Promise.all([api('/api/v1/plans'),api('/api/v1/billing/subscription')]);
    $('#content').innerHTML = `${head('Plano e cobranca','Beneficios mudam somente depois da confirmacao do provedor.')}
      <div class="cards">${plans.data.map(p=>`<div class="card"><strong>${esc(p.name)}</strong><div class="metric">R$ ${Number(p.monthly_price).toFixed(2).replace('.',',')}</div><p class="muted">${p.max_instances} instancia(s) · ${p.max_users} usuario(s)<br>${p.daily_messages_per_instance} mensagens/dia por instancia</p>${p.code!==current.subscription.plan_code?`<button class="secondary" data-plan="${p.code}">Solicitar mudanca</button>`:'<span class="badge ACTIVE">Plano atual</span>'}</div>`).join('')}</div>
      <div class="panel"><h2>Assinatura</h2><p><strong>${esc(current.subscription.plan_name)}</strong> ${badge(current.subscription.status)}</p><p class="muted">${current.pendingChange?`Mudanca pendente para ${esc(current.pendingChange.requested_plan_name)}.`:'Nenhuma mudanca pendente.'}</p></div>`;
    document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=async()=>{if(confirm(`Solicitar mudanca para ${b.dataset.plan}?`)){await api('/api/v1/billing/change-plan',{method:'POST',body:JSON.stringify({planCode:b.dataset.plan})});toast('Mudanca enviada para confirmacao.');await navigate('billing');}});
  },
};

function submitJson(path, after) { return async(event)=>{event.preventDefault();try{await api(path,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});toast('Salvo com sucesso.');await after();}catch(error){toast(error.message,true);}}; }

void boot();
