// Função "cobranca" do Amora: abre o pagamento (checkout), abre o portal de gestão da assinatura
// e recebe os avisos da Stripe (webhook). Usa só APIs padrão (fetch, crypto.subtle).
//
//   POST { acao: 'checkout', plano }  -> { url }   (precisa estar logada)
//   POST { acao: 'portal' }           -> { url }   (precisa estar logada)
//   POST (com cabeçalho Stripe-Signature) -> avisos da Stripe

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_VERSAO = '2024-06-20';
const PLANOS = ['essencial', 'profissional', 'avancado'];
const chavePreco = (plano) => `amora_${plano}_mensal`;
const MIN_TESTE_MS = 49 * 3600 * 1000; // a Stripe exige o fim do teste com pelo menos 48h de folga

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ---------- utilitários ---------- */
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const chave = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') formEncode(item, `${chave}[${i}]`, out);
        else out.push([`${chave}[${i}]`, String(item)]);
      });
    } else if (typeof v === 'object') formEncode(v, chave, out);
    else out.push([chave, String(v)]);
  }
  return out;
}
const corpoForm = (obj) => new URLSearchParams(formEncode(obj)).toString();

async function stripe(env, deps, metodo, caminho, dados) {
  let url = STRIPE_API + caminho;
  const init = { method: metodo, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_VERSAO } };
  if (dados) {
    if (metodo === 'GET') url += '?' + corpoForm(dados);
    else { init.body = corpoForm(dados); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  }
  const r = await deps.fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j && j.error && j.error.message) || 'Falha na Stripe');
    e.status = r.status; e.stripe = (j && j.error) || {};
    throw e;
  }
  return j;
}

async function db(env, deps, metodo, caminho, corpo) {
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
  if (metodo !== 'GET') headers.Prefer = 'return=minimal';
  const r = await deps.fetch(`${env.SUPABASE_URL}/rest/v1/${caminho}`, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  if (!r.ok) throw new Error(`banco ${metodo} ${caminho.split('?')[0]} -> ${r.status}`);
  return metodo === 'GET' ? r.json() : null;
}

async function usuarioDoToken(env, deps, req) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const r = await deps.fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

function origemSegura(env, req) {
  const cand = (env.SITE_URL || req.headers.get('origin') || '').replace(/\/$/, '');
  return /^https:\/\/[^\s/]+$/.test(cand) || /^http:\/\/localhost(:\d+)?$/.test(cand) ? cand : null;
}

const SALAO_CAMPOS = 'id,nome,stripe_customer_id,stripe_subscription_id,assinatura_status,trial_termina_em,plano';
async function salaoDaDona(env, deps, userId) {
  const linhas = await db(env, deps, 'GET', `saloes?owner_id=eq.${encodeURIComponent(userId)}&select=${SALAO_CAMPOS}&limit=1`);
  return linhas[0] || null;
}

/* ---------- checkout ---------- */
async function criarCheckout(req, corpo, env, deps) {
  const user = await usuarioDoToken(env, deps, req);
  if (!user) return json({ erro: 'nao_autenticado', mensagem: 'Faça login de novo para continuar.' }, 401);
  const plano = corpo.plano;
  if (!PLANOS.includes(plano)) return json({ erro: 'plano_invalido', mensagem: 'Plano inválido.' }, 400);
  const origem = origemSegura(env, req);
  if (!origem) return json({ erro: 'origem_invalida', mensagem: 'Endereço do site não reconhecido.' }, 400);

  const salao = await salaoDaDona(env, deps, user.id);
  if (!salao) return json({ erro: 'sem_salao', mensagem: 'Não encontramos o seu salão.' }, 404);
  if (salao.assinatura_status === 'ativa' && salao.stripe_subscription_id)
    return json({ erro: 'ja_assinante', mensagem: 'Você já tem uma assinatura. Use "Gerenciar assinatura" para trocar de plano.' }, 409);

  const precos = await stripe(env, deps, 'GET', '/prices', { lookup_keys: [chavePreco(plano)], active: true, limit: 1 });
  const preco = precos.data && precos.data[0];
  if (!preco) return json({ erro: 'preco_nao_encontrado', mensagem: 'Esse plano ainda não está disponível.' }, 500);

  const novoCliente = async () => {
    const c = await stripe(env, deps, 'POST', '/customers', { email: user.email, name: salao.nome, metadata: { salao_id: salao.id, user_id: user.id } });
    await db(env, deps, 'PATCH', `saloes?id=eq.${salao.id}`, { stripe_customer_id: c.id });
    return c.id;
  };
  let cliente = salao.stripe_customer_id || await novoCliente();

  const montar = (cus) => {
    const dados = {
      mode: 'subscription', customer: cus,
      line_items: [{ price: preco.id, quantity: 1 }],
      success_url: `${origem}/admin.html?assinatura=sucesso`,
      cancel_url: `${origem}/admin.html?assinatura=cancelada`,
      client_reference_id: salao.id, allow_promotion_codes: true,
      payment_method_types: ['card'], locale: 'pt-BR',
      metadata: { salao_id: salao.id, plano },
      subscription_data: { metadata: { salao_id: salao.id, plano } },
    };
    // se ainda sobra teste grátis, a cobrança só começa quando ele acabar
    const fim = salao.trial_termina_em ? Date.parse(salao.trial_termina_em) : 0;
    if (fim - deps.agora() >= MIN_TESTE_MS) dados.subscription_data.trial_end = Math.floor(fim / 1000);
    return dados;
  };
  let sessao;
  try { sessao = await stripe(env, deps, 'POST', '/checkout/sessions', montar(cliente)); }
  catch (e) {
    // cliente guardado não existe nesta conta/modo (ex.: criado no teste e agora no modo real): recria uma vez
    if (e.stripe && e.stripe.code === 'resource_missing' && e.stripe.param === 'customer') {
      cliente = await novoCliente();
      sessao = await stripe(env, deps, 'POST', '/checkout/sessions', montar(cliente));
    } else throw e;
  }
  return json({ url: sessao.url });
}

/* ---------- portal ---------- */
async function criarPortal(req, env, deps) {
  const user = await usuarioDoToken(env, deps, req);
  if (!user) return json({ erro: 'nao_autenticado', mensagem: 'Faça login de novo para continuar.' }, 401);
  const origem = origemSegura(env, req);
  if (!origem) return json({ erro: 'origem_invalida', mensagem: 'Endereço do site não reconhecido.' }, 400);
  const salao = await salaoDaDona(env, deps, user.id);
  if (!salao) return json({ erro: 'sem_salao', mensagem: 'Não encontramos o seu salão.' }, 404);
  if (!salao.stripe_customer_id) return json({ erro: 'sem_assinatura', mensagem: 'Você ainda não tem assinatura para gerenciar.' }, 400);

  let configuracao;
  try {
    const cfgs = await stripe(env, deps, 'GET', '/billing_portal/configurations', { active: true, limit: 20 });
    const nossa = (cfgs.data || []).find((c) => c.metadata && c.metadata.app === 'amora');
    if (nossa) configuracao = nossa.id;
  } catch (_) { /* sem permissão de leitura ou sem configuração nossa: usa a padrão */ }

  try {
    const s = await stripe(env, deps, 'POST', '/billing_portal/sessions', {
      customer: salao.stripe_customer_id, return_url: `${origem}/admin.html`, configuration: configuracao,
    });
    return json({ url: s.url });
  } catch (e) {
    if (e.stripe && /configuration/i.test(e.stripe.message || ''))
      return json({ erro: 'portal_nao_configurado', mensagem: 'O portal de assinatura ainda não foi configurado. Fale com o suporte.' }, 503);
    throw e;
  }
}

/* ---------- webhook ---------- */
function iguaisConstante(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function assinaturaValida(corpo, cabecalho, segredo, agoraMs, toleranciaS = 300) {
  let t = null; const v1 = [];
  for (const parte of String(cabecalho || '').split(',')) {
    const i = parte.indexOf('='); if (i < 0) continue;
    const k = parte.slice(0, i).trim(), v = parte.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') v1.push(v);
  }
  if (!t || !v1.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(agoraMs / 1000 - Number(t)) > toleranciaS) return false;
  const enc = new TextEncoder();
  const chave = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', chave, enc.encode(`${t}.${corpo}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return v1.some((s) => iguaisConstante(s, hex));
}

const ATIVOS = ['trialing', 'active', 'past_due', 'unpaid', 'paused'];
async function sincronizarAssinatura(subId, env, deps, dicaSalaoId) {
  // a fonte da verdade é a própria Stripe: busca a assinatura atual (não depende da ordem dos avisos)
  const sub = await stripe(env, deps, 'GET', `/subscriptions/${encodeURIComponent(subId)}`);
  let salao = null;
  if (sub.customer) salao = (await db(env, deps, 'GET', `saloes?stripe_customer_id=eq.${encodeURIComponent(sub.customer)}&select=id,stripe_customer_id,stripe_subscription_id&limit=1`))[0] || null;
  const salaoId = salao ? salao.id : ((sub.metadata && sub.metadata.salao_id) || dicaSalaoId);
  if (!salao && salaoId) salao = (await db(env, deps, 'GET', `saloes?id=eq.${encodeURIComponent(salaoId)}&select=id,stripe_customer_id,stripe_subscription_id&limit=1`))[0] || null;
  if (!salao) { console.warn('assinatura sem salão correspondente', subId); return; }

  // aviso atrasado de uma assinatura antiga não pode sobrescrever uma mais nova
  if (salao.stripe_subscription_id && salao.stripe_subscription_id !== sub.id && !ATIVOS.includes(sub.status)) return;

  const item = sub.items && sub.items.data && sub.items.data[0];
  const preco = (item && item.price) || {};
  const m = /^amora_(essencial|profissional|avancado)_mensal$/.exec(preco.lookup_key || '');
  const plano = (m && m[1]) || (preco.metadata && preco.metadata.plano) || null;
  const fim = sub.current_period_end != null ? sub.current_period_end : (item && item.current_period_end) || null;

  const novo = { stripe_subscription_id: sub.id };
  if (!salao.stripe_customer_id && sub.customer) novo.stripe_customer_id = sub.customer;
  if (sub.status === 'trialing' || sub.status === 'active') Object.assign(novo, { assinatura_status: 'ativa', pagamento_pendente: false });
  else if (sub.status === 'past_due') Object.assign(novo, { assinatura_status: 'ativa', pagamento_pendente: true });
  else if (sub.status === 'unpaid' || sub.status === 'paused') Object.assign(novo, { assinatura_status: 'vencida', pagamento_pendente: false });
  else if (sub.status === 'canceled') Object.assign(novo, { assinatura_status: 'cancelada', pagamento_pendente: false, plano: null, assinatura_renova_em: null });
  else return; // incomplete / incomplete_expired: espera a próxima atualização
  if (sub.status !== 'canceled') {
    if (plano) novo.plano = plano;
    novo.assinatura_renova_em = fim ? new Date(fim * 1000).toISOString() : null;
  }
  await db(env, deps, 'PATCH', `saloes?id=eq.${salao.id}`, novo);
}

async function receberEvento(texto, req, env, deps) {
  if (!env.STRIPE_WEBHOOK_SECRET) { console.error('STRIPE_WEBHOOK_SECRET ausente'); return json({ erro: 'webhook_sem_segredo' }, 500); }
  if (!(await assinaturaValida(texto, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, deps.agora())))
    return json({ erro: 'assinatura_invalida' }, 400);
  let ev; try { ev = JSON.parse(texto); } catch (_) { return json({ erro: 'json_invalido' }, 400); }
  const obj = (ev.data && ev.data.object) || {};
  let subId = null;
  switch (ev.type) {
    case 'checkout.session.completed': if (obj.mode === 'subscription') subId = obj.subscription; break;
    case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted': subId = obj.id; break;
    case 'invoice.paid': case 'invoice.payment_succeeded': case 'invoice.payment_failed':
      subId = obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null; break;
  }
  if (subId) await sincronizarAssinatura(subId, env, deps, obj.metadata && obj.metadata.salao_id);
  return json({ recebido: true });
}

/* ---------- entrada ---------- */
export async function tratar(req, env, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ erro: 'metodo_nao_permitido' }, 405);
  try {
    const texto = await req.text();
    if (req.headers.get('stripe-signature')) {
      if (!env.STRIPE_SECRET_KEY) { console.error('STRIPE_SECRET_KEY ausente'); return json({ erro: 'stripe_nao_configurado' }, 500); }
      return await receberEvento(texto, req, env, deps);
    }
    let corpo = {}; try { corpo = texto ? JSON.parse(texto) : {}; } catch (_) { return json({ erro: 'json_invalido' }, 400); }
    if (!env.STRIPE_SECRET_KEY)
      return json({ erro: 'stripe_nao_configurado', mensagem: 'A cobrança ainda não foi configurada. Fale com o suporte.' }, 503);
    if (corpo.acao === 'checkout') return await criarCheckout(req, corpo, env, deps);
    if (corpo.acao === 'portal') return await criarPortal(req, env, deps);
    return json({ erro: 'acao_invalida' }, 400);
  } catch (e) {
    console.error('cobranca falhou:', e && e.message, e && e.stripe ? JSON.stringify({ tipo: e.stripe.type, codigo: e.stripe.code, param: e.stripe.param }) : '');
    return json({ erro: 'falha', mensagem: 'Não foi possível concluir agora. Tente de novo em instantes.' }, 500);
  }
}

if (typeof Deno !== 'undefined') {
  const env = () => ({
    STRIPE_SECRET_KEY: Deno.env.get('STRIPE_SECRET_KEY'),
    STRIPE_WEBHOOK_SECRET: Deno.env.get('STRIPE_WEBHOOK_SECRET'),
    SITE_URL: Deno.env.get('SITE_URL'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  });
  Deno.serve((req) => tratar(req, env(), { fetch: (...a) => fetch(...a), agora: () => Date.now() }));
}
