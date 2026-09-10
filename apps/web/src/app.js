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
  if (response.status === 401) {
    if (retry && await refreshSession()) {
      return api(path, options, false);
    }
    clearSession();
    showLogin();
    throw new Error('Sessao expirada. Por favor, entre novamente.');
  }
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
    const body = Object.fromEntries(form);
    if (!body.tenantSlug || !String(body.tenantSlug).trim()) {
      delete body.tenantSlug;
    } else {
      body.tenantSlug = String(body.tenantSlug).trim();
    }
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
  const form = new FormData(event.currentTarget);
  const password = String(form.get('password') ?? '');
  if (password.length < 10) {
    output.textContent = 'A senha deve ter pelo menos 10 caracteres.';
    return;
  }
  try {
    const data = await api('/api/v1/auth/register', { method:'POST', body:JSON.stringify(Object.fromEntries(form)) });
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
const formatDateTime = (value) => value ? new Date(value).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' }) : 'Envio imediato';
const toDateTimeLocal = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const debounce = (callback, wait = 250) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), wait); }; };

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
    let qrTimer = null;
    const data = await api('/api/v1/instances');
    $('#content').innerHTML = `${head('Instancias', 'Cada numero possui sessao, limite e janela proprios.')}
      <div class="panel"><h2>Nova instancia</h2><form id="instance-form" class="form-grid"><label>Nome<input name="name" required placeholder="Atendimento principal"></label><div class="form-actions"><button class="primary">Criar instancia</button></div></form></div>
      <div class="panel"><h2>Numeros conectados</h2>${rows(data.data, i => `<tr><td><strong>${esc(i.name)}</strong></td><td>${esc(i.phone_number || 'Aguardando conexao')}</td><td>${badge(i.status)}</td><td>${i.last_heartbeat_at ? new Date(i.last_heartbeat_at).toLocaleString('pt-BR') : '—'}</td><td class="actions"><button data-init="${i.id}">Inicializar</button><button class="primary" data-qr="${i.id}">Ver QR</button></td></tr>`, ['Nome', 'Numero', 'Estado', 'Ultimo sinal', 'Acoes'])}</div>
      <div id="qr-panel"></div>`;
    $('#instance-form').addEventListener('submit', submitJson('/api/v1/instances', () => navigate('instances')));
    document.querySelectorAll('[data-init]').forEach(b => b.onclick = async () => {
      try {
        await api(`/api/v1/instances/${b.dataset.init}/initialize`, { method: 'POST' });
        toast('Inicializacao solicitada. Gerando QR Code...');
        const qrBtn = document.querySelector(`[data-qr="${b.dataset.init}"]`);
        if (qrBtn) qrBtn.click();
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.querySelectorAll('[data-qr]').forEach(b => b.onclick = async () => {
      if (qrTimer) clearInterval(qrTimer);
      const loadQr = async () => {
        try {
          const q = await api(`/api/v1/instances/${b.dataset.qr}/qr`);
          const panel = $('#qr-panel');
          if (!panel) { if (qrTimer) clearInterval(qrTimer); return; }
          if (q.status === 'READY') {
            panel.innerHTML = `<div class="panel" style="border-left: 4px solid #0b8f72; background: #f4fbf8;"><h2>WhatsApp Conectado!</h2><p class="muted">Esta instancia ja esta conectada e pronta para envios.</p></div>`;
            if (qrTimer) clearInterval(qrTimer);
            return;
          }
          panel.innerHTML = `<div class="panel" style="text-align: center; max-width: 480px; margin: 20px auto;">
            <h2>Conexao por QR Code</h2>
            <p class="muted" style="margin-bottom: 12px;">No seu celular, abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho e aponte para o codigo:</p>
            ${q.qr ? `<div style="padding: 12px; background: #fff; border-radius: 12px; display: inline-block; border: 1px solid #dfe7e4;"><img class="qr" src="${q.qr}" style="width: 280px; height: 280px; display: block; margin: 0 auto;" alt="QR Code WhatsApp"></div>` : `<div class="empty" style="padding: 24px;">Aguardando o motor gerar o QR Code...<br><small class="muted">Certifique-se de que o motor esta rodando no seu computador.</small><br><br>Estado: ${badge(q.status)}</div>`}
            <div style="margin-top: 12px;"><small class="muted">Atualizacao em tempo real ativa (a cada 3s).</small></div>
          </div>`;
        } catch (e) {
          toast(e.message, true);
        }
      };
      await loadQr();
      qrTimer = setInterval(loadQr, 3000);
    });
  },
  async contacts() {
    const instances = await api('/api/v1/instances');
    const readyInstances = instances.data.filter((instance) => instance.status === 'READY' && instance.connection_state === 'CONNECTED');
    $('#content').innerHTML = `${head('Contatos','Somente contatos com consentimento valido entram em envios.')}
      <div class="panel import-contacts-panel"><div class="panel-title"><div><h2>Importar contatos do celular</h2><p class="muted">Traz os contatos salvos na agenda do WhatsApp conectado. Eles entram como “consentimento não informado” e não serão usados em campanhas até a autorização ser registrada.</p></div></div>
        <div class="import-contacts-controls"><label>Número conectado<select id="contact-import-instance" ${readyInstances.length?'':'disabled'}>${readyInstances.map(instance=>`<option value="${instance.id}">${esc(instance.name)} · ${esc(instance.phone_number||'WhatsApp conectado')}</option>`).join('')||'<option>Nenhum WhatsApp pronto</option>'}</select></label><button id="contact-import-button" type="button" class="primary" ${readyInstances.length?'':'disabled'}>Importar contatos</button></div>
        <div id="contact-import-status" class="import-status muted">${readyInstances.length?'A importação não altera nomes ou consentimentos já cadastrados.':'Conecte um WhatsApp para liberar a importação.'}</div>
      </div>
      <div class="panel"><h2>Novo contato</h2><form id="contact-form" class="form-grid"><label>Nome<input name="name" required></label><label>WhatsApp<input name="phoneNumber" required placeholder="5511999999999"></label><label>Origem do consentimento<input name="consentSource" required placeholder="Formulario do site"></label><label>Data do consentimento<input name="consentAt" type="datetime-local" required></label><input type="hidden" name="consentStatus" value="GRANTED"><div class="form-actions"><button class="primary">Salvar contato</button></div></form></div>
      <div class="panel"><div class="panel-title"><div><h2>Base de contatos</h2><p class="muted">Busque por nome, telefone ou e-mail.</p></div><span id="contacts-total" class="result-count">0 contatos</span></div>
        <div class="filter-bar"><label class="search-field">Buscar contato<input id="contact-search" type="search" placeholder="Digite nome, telefone ou e-mail"></label><label>Consentimento<select id="contact-consent-filter"><option value="">Todos</option><option value="GRANTED">Autorizados</option><option value="UNKNOWN">Não informado</option><option value="REVOKED">Revogados</option></select></label><button id="contact-clear-filter" type="button" class="secondary">Limpar filtros</button></div>
        <div id="contact-results"><div class="empty">Carregando contatos...</div></div>
      </div>`;
    $('#contact-form').addEventListener('submit', async(event)=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));body.consentAt=new Date(body.consentAt).toISOString();body.customFields={};await api('/api/v1/contacts',{method:'POST',body:JSON.stringify(body)});toast('Contato salvo.');await navigate('contacts');});
    let offset = 0;
    const limit = 50;
    const loadContacts = async () => {
      const search = $('#contact-search').value.trim();
      const consentStatus = $('#contact-consent-filter').value;
      const params = new URLSearchParams({ limit:String(limit), offset:String(offset) });
      if (search) params.set('search', search);
      if (consentStatus) params.set('consentStatus', consentStatus);
      const data = await api(`/api/v1/contacts?${params}`);
      const total = Number(data.total ?? data.data.length);
      if (offset >= total && offset > 0) { offset = Math.max(0, Math.floor((total - 1) / limit) * limit); return loadContacts(); }
      const page = Math.floor(offset / limit) + 1;
      const pageCount = Math.max(1, Math.ceil(total / limit));
      $('#contacts-total').textContent = `${total} contato${total === 1 ? '' : 's'}`;
      $('#contact-results').innerHTML = `${rows(data.data,c=>`<tr><td><strong>${esc(c.name)}</strong>${c.email?`<small>${esc(c.email)}</small>`:''}</td><td>${esc(c.phone_number)}</td><td>${badge(c.consent_status)}</td><td>${esc(c.consent_source)}</td><td class="actions">${c.consent_status==='GRANTED'?`<button class="danger" data-optout="${c.id}">Remover consentimento</button>`:''}</td></tr>`,['Nome','WhatsApp','Consentimento','Origem','Acoes'])}
        <div class="pagination"><button id="contacts-prev" class="secondary" ${offset===0?'disabled':''}>Anterior</button><span>Página ${page} de ${pageCount}</span><button id="contacts-next" class="secondary" ${offset+limit>=total?'disabled':''}>Próxima</button></div>`;
      document.querySelectorAll('[data-optout]').forEach(b=>b.onclick=async()=>{if(confirm('Remover o consentimento deste contato?')){await api(`/api/v1/contacts/${b.dataset.optout}/opt-out`,{method:'POST'});toast('Consentimento removido.');await loadContacts();}});
      $('#contacts-prev').onclick=()=>{offset=Math.max(0,offset-limit);void loadContacts();};
      $('#contacts-next').onclick=()=>{offset+=limit;void loadContacts();};
    };
    $('#contact-search').addEventListener('input',debounce(()=>{offset=0;void loadContacts();}));
    $('#contact-consent-filter').addEventListener('change',()=>{offset=0;void loadContacts();});
    $('#contact-clear-filter').onclick=()=>{$('#contact-search').value='';$('#contact-consent-filter').value='';offset=0;void loadContacts();};
    if (readyInstances.length) {
      $('#contact-import-button').onclick = async () => {
        const button = $('#contact-import-button');
        const status = $('#contact-import-status');
        button.disabled = true;
        button.textContent = 'Iniciando...';
        try {
          const created = await api('/api/v1/contacts/import-whatsapp', { method:'POST', body:JSON.stringify({ instanceId:$('#contact-import-instance').value }) });
          const startedAt = Date.now();
          while (Date.now() - startedAt < 300000) {
            const current = await api(`/api/v1/contacts/import-whatsapp/${encodeURIComponent(created.jobId)}`);
            if (current.state === 'completed') {
              const result = current.result || {};
              status.textContent = `${result.imported||0} novos contatos importados, ${result.updated||0} já existentes e ${result.skipped||0} ignorados.`;
              toast(result.imported ? `${result.imported} contatos importados.` : 'Agenda verificada; nenhum contato novo.');
              offset = 0;
              await loadContacts();
              return;
            }
            if (current.state === 'failed') throw new Error(current.error || 'A importação não pôde ser concluída.');
            const progress = current.progress && typeof current.progress === 'object' ? current.progress : {};
            status.textContent = progress.phase === 'IMPORTING'
              ? `Importando ${progress.processed||0} de ${progress.total||0} contatos salvos...`
              : 'Lendo a agenda do WhatsApp conectado...';
            button.textContent = 'Importando...';
            await new Promise(resolve=>setTimeout(resolve,1500));
          }
          throw new Error('A importação continua em segundo plano. Atualize a página em alguns minutos para ver os contatos.');
        } catch (error) {
          status.textContent = error.message;
          toast(error.message, true);
        } finally {
          button.disabled = false;
          button.textContent = 'Importar contatos';
        }
      };
    }
    await loadContacts();
  },
  async lists() {
    const lists = await api('/api/v1/lists');
    $('#content').innerHTML = `${head('Listas','Organize contatos autorizados para suas campanhas.')}
      <div class="panel"><h2>Nova lista</h2><form id="list-form" class="form-grid"><label>Nome<input name="name" required placeholder="Ex.: Clientes de Vitória"></label><label>Descricao<input name="description" placeholder="Finalidade desta lista"></label>
        <div class="wide contact-picker"><div class="panel-title"><div><strong>Selecionar contatos</strong><p class="muted">A seleção permanece enquanto você pesquisa e troca de página.</p></div><span id="selected-count" class="result-count">0 selecionados</span></div>
          <div class="filter-bar"><label class="search-field">Buscar<input id="list-contact-search" type="search" placeholder="Nome, telefone ou e-mail"></label><label>Consentimento<select id="list-contact-consent"><option value="GRANTED">Autorizados</option><option value="">Todos</option><option value="UNKNOWN">Não informado</option><option value="REVOKED">Revogados</option></select></label><button id="select-visible" type="button" class="secondary">Selecionar página</button><button id="clear-selected" type="button" class="secondary">Limpar seleção</button></div>
          <div id="selected-preview" class="selected-preview"></div><div id="list-contact-results"><div class="empty">Carregando contatos...</div></div>
        </div><div class="form-actions"><button class="primary">Criar lista com os selecionados</button></div></form></div>
      <div class="panel"><h2>Listas ativas</h2>${rows(lists.data,l=>`<tr><td>${esc(l.name)}</td><td>${esc(l.description||'—')}</td><td>${l.contact_count}</td><td>${badge(l.status)}</td></tr>`,['Nome','Descricao','Contatos','Estado'])}</div>`;
    const selected = new Map();
    let visibleContacts = [];
    let offset = 0;
    const limit = 50;
    const refreshSelected = () => {
      const values = [...selected.values()];
      $('#selected-count').textContent = `${values.length} selecionado${values.length===1?'':'s'}`;
      $('#selected-preview').innerHTML = values.length ? `${values.slice(0,8).map(c=>`<span class="selection-chip">${esc(c.name)}<button type="button" data-remove-selected="${c.id}" aria-label="Remover ${esc(c.name)}">×</button></span>`).join('')}${values.length>8?`<span class="muted">+${values.length-8} outros</span>`:''}` : '<span class="muted">Nenhum contato selecionado.</span>';
      document.querySelectorAll('[data-remove-selected]').forEach(button=>button.onclick=()=>{selected.delete(button.dataset.removeSelected);refreshSelected();const checkbox=document.querySelector(`[data-contact-check="${button.dataset.removeSelected}"]`);if(checkbox)checkbox.checked=false;});
    };
    const loadPicker = async () => {
      const search = $('#list-contact-search').value.trim();
      const consentStatus = $('#list-contact-consent').value;
      const params = new URLSearchParams({ limit:String(limit), offset:String(offset) });
      if (search) params.set('search',search);
      if (consentStatus) params.set('consentStatus',consentStatus);
      const data = await api(`/api/v1/contacts?${params}`);
      visibleContacts = data.data;
      const total = Number(data.total ?? data.data.length);
      if (offset >= total && offset > 0) { offset=Math.max(0,Math.floor((total-1)/limit)*limit);return loadPicker(); }
      const page=Math.floor(offset/limit)+1;const pageCount=Math.max(1,Math.ceil(total/limit));
      $('#list-contact-results').innerHTML = data.data.length ? `<div class="contact-list">${data.data.map(c=>`<label class="contact-option"><input type="checkbox" data-contact-check="${c.id}" ${selected.has(c.id)?'checked':''}><span><strong>${esc(c.name)}</strong><small>${esc(c.phone_number)}${c.email?` · ${esc(c.email)}`:''}</small></span>${badge(c.consent_status)}</label>`).join('')}</div><div class="pagination"><button id="picker-prev" type="button" class="secondary" ${offset===0?'disabled':''}>Anterior</button><span>Página ${page} de ${pageCount} · ${total} contatos</span><button id="picker-next" type="button" class="secondary" ${offset+limit>=total?'disabled':''}>Próxima</button></div>` : '<div class="empty">Nenhum contato encontrado.</div>';
      document.querySelectorAll('[data-contact-check]').forEach(checkbox=>checkbox.onchange=()=>{const contact=visibleContacts.find(c=>c.id===checkbox.dataset.contactCheck);if(!contact)return;if(checkbox.checked)selected.set(contact.id,contact);else selected.delete(contact.id);refreshSelected();});
      const prev=$('#picker-prev');if(prev)prev.onclick=()=>{offset=Math.max(0,offset-limit);void loadPicker();};
      const next=$('#picker-next');if(next)next.onclick=()=>{offset+=limit;void loadPicker();};
    };
    $('#list-contact-search').addEventListener('input',debounce(()=>{offset=0;void loadPicker();}));
    $('#list-contact-consent').addEventListener('change',()=>{offset=0;void loadPicker();});
    $('#select-visible').onclick=()=>{visibleContacts.forEach(contact=>selected.set(contact.id,contact));refreshSelected();document.querySelectorAll('[data-contact-check]').forEach(c=>c.checked=true);};
    $('#clear-selected').onclick=()=>{selected.clear();refreshSelected();document.querySelectorAll('[data-contact-check]').forEach(c=>c.checked=false);};
    $('#list-form').addEventListener('submit',async(event)=>{event.preventDefault();if(selected.size===0){toast('Selecione pelo menos um contato para criar a lista.',true);return;}const fd=new FormData(event.currentTarget);try{await api('/api/v1/lists',{method:'POST',body:JSON.stringify({name:fd.get('name'),description:fd.get('description')||undefined,contactIds:[...selected.keys()]})});toast('Lista criada.');await navigate('lists');}catch(error){toast(error.message,true);}});
    refreshSelected();
    await loadPicker();
  },
  async campaigns() {
    const [campaigns,instances,lists] = await Promise.all([api('/api/v1/campaigns'),api('/api/v1/instances'),api('/api/v1/lists')]);
    $('#content').innerHTML = `${head('Campanhas','Envie agora ou escolha a data e o horario do disparo.')}
      <div class="panel"><h2>Nova campanha</h2><form id="campaign-form" class="form-grid"><label>Nome<input name="name" required placeholder="Ex.: Aviso de vencimento"></label><label>Instancia<select name="instanceId" required>${instances.data.map(i=>`<option value="${i.id}">${esc(i.name)} · ${esc(i.status)}</option>`).join('')}</select></label>
        <label>Como deseja salvar?<select name="sendMode" id="campaign-send-mode"><option value="draft">Salvar para revisar</option><option value="scheduled">Agendar envio</option></select></label><label id="campaign-schedule-field" class="hidden">Data e hora do envio<input name="scheduledAt" id="campaign-scheduled-at" type="datetime-local"></label>
        <div class="wide"><span class="field-label">Listas de contatos</span><div class="choice-grid">${lists.data.map(l=>`<label class="choice-option"><input type="checkbox" name="listIds" value="${l.id}"><span><strong>${esc(l.name)}</strong><small>${l.contact_count} contato${l.contact_count===1?'':'s'}</small></span></label>`).join('')||'<span class="muted">Crie uma lista de contatos antes de montar a campanha.</span>'}</div></div>
        <label class="wide">Mensagem<textarea name="messageTemplate" required rows="5" placeholder="Ola, {{nome}}!"></textarea><small>Use {{nome}} para personalizar cada mensagem.</small></label>
        <label id="campaign-consent-field" class="wide consent-confirm hidden"><input id="campaign-consent" type="checkbox"> Confirmo que os contatos selecionados autorizaram o recebimento desta mensagem.</label>
        <div class="form-actions"><button id="campaign-submit" class="primary">Salvar rascunho</button></div></form></div>
      <div class="panel"><h2>Campanhas</h2>${rows(campaigns.data,c=>`<tr><td><strong>${esc(c.name)}</strong><small>${esc(c.instance_name)}</small></td><td>${badge(c.status)}</td><td>${formatDateTime(c.scheduled_at)}</td><td>${c.total_recipients}</td><td>${c.sent_count}</td><td>${c.failed_count}</td><td class="actions">${c.status==='DRAFT'?`<button data-start="${c.id}" data-scheduled="${c.scheduled_at||''}">${c.scheduled_at?'Agendar':'Iniciar agora'}</button>`:''}${c.status==='RUNNING'?`<button data-action="pause" data-id="${c.id}">Pausar</button>`:''}${c.status==='PAUSED'?`<button data-action="resume" data-id="${c.id}">Retomar</button>`:''}${!['COMPLETED','CANCELED'].includes(c.status)?`<button class="danger" data-action="cancel" data-id="${c.id}">Cancelar</button>`:''}</td></tr>`,['Nome','Estado','Envio','Total','Enviadas','Falhas','Acoes'])}</div>`;
    const mode=$('#campaign-send-mode');const scheduleField=$('#campaign-schedule-field');const scheduledAt=$('#campaign-scheduled-at');const consentField=$('#campaign-consent-field');const consent=$('#campaign-consent');const submit=$('#campaign-submit');
    scheduledAt.min=toDateTimeLocal(new Date(Date.now()+60_000));
    const syncScheduleMode=()=>{const scheduling=mode.value==='scheduled';scheduleField.classList.toggle('hidden',!scheduling);consentField.classList.toggle('hidden',!scheduling);scheduledAt.required=scheduling;consent.required=scheduling;submit.textContent=scheduling?'Criar e agendar campanha':'Salvar rascunho';};
    mode.addEventListener('change',syncScheduleMode);syncScheduleMode();
    $('#campaign-form').addEventListener('submit',async(event)=>{event.preventDefault();const fd=new FormData(event.currentTarget);const listIds=fd.getAll('listIds');if(listIds.length===0){toast('Selecione pelo menos uma lista de contatos.',true);return;}const scheduling=fd.get('sendMode')==='scheduled';let scheduledIso;if(scheduling){const date=new Date(fd.get('scheduledAt'));if(Number.isNaN(date.getTime())||date.getTime()<=Date.now()){toast('Escolha uma data e hora futuras.',true);return;}scheduledIso=date.toISOString();}try{const campaign=await api('/api/v1/campaigns',{method:'POST',body:JSON.stringify({name:fd.get('name'),instanceId:fd.get('instanceId'),listIds,messageTemplate:fd.get('messageTemplate'),...(scheduledIso?{scheduledAt:scheduledIso}:{})})});if(scheduling){await api(`/api/v1/campaigns/${campaign.id}/start`,{method:'POST',body:JSON.stringify({consentConfirmed:true})});toast(`Campanha agendada para ${formatDateTime(scheduledIso)}.`);}else toast('Rascunho criado.');await navigate('campaigns');}catch(error){toast(error.message,true);}});
    document.querySelectorAll('[data-start]').forEach(b=>b.onclick=async()=>{const scheduled=b.dataset.scheduled;const question=scheduled?`Agendar esta campanha para ${formatDateTime(scheduled)}?`:'Enviar esta campanha agora?';if(confirm(`${question}\n\nConfirmo que todos os destinatarios autorizaram este contato.`)){await api(`/api/v1/campaigns/${b.dataset.start}/start`,{method:'POST',body:JSON.stringify({consentConfirmed:true})});toast(scheduled?'Campanha agendada.':'Campanha enviada para a fila.');await navigate('campaigns');}});
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
