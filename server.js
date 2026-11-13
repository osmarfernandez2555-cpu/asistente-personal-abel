// ABEL · Red Neuronal — asistente personal de Abel Fernández
// Monitorea todas las apps (Railway, GitHub Pages, webs, bots de WhatsApp, Claude)
// y responde por texto y voz.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('abel-red:' + APP_PASSWORD).digest('hex');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_USERS = (process.env.GITHUB_USERS || 'osmarfernandez2555-cpu,natirodriguez32-sketch')
  .split(',').map(s => s.trim()).filter(Boolean);
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const CHECK_EVERY_MIN = Math.max(1, Number(process.env.CHECK_EVERY_MIN || 5));

// alertas por WhatsApp
const ALERT_TO = (process.env.ALERT_WHATSAPP_TO || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
const ALERT_INSTANCE = process.env.ALERT_EVOLUTION_INSTANCE || '';
const ALERT_EVO_URL_ENV = process.env.ALERT_EVOLUTION_URL || '';
const ALERT_CONFIRM = Math.max(1, Number(process.env.ALERT_CONFIRM_CHECKS || 2));
const ALERT_REMIND_HOURS = Number(process.env.ALERT_REMIND_HOURS ?? 6);
const ALERT_DAILY_HOUR = (process.env.ALERT_DAILY_HOUR ?? '9').trim();
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');

const CONFIG_PATH = path.join(__dirname, 'projects.json');

// ---------- utilidades ----------
async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

const RANK = { down: 4, warn: 3, ok: 2, code: 1, unknown: 0 };
function worst(list) {
  let best = 'unknown';
  for (const s of list) if ((RANK[s] ?? 0) > RANK[best]) best = s;
  return best;
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  raw.projects = (raw.projects || []).map(p => ({
    urls: [], repos: [], railway: [], ...p,
  }));
  return raw;
}

// ---------- chequeo de URLs ----------
async function checkUrl(url) {
  const t0 = Date.now();
  try {
    const r = await fetchT(url, { redirect: 'follow', headers: { 'User-Agent': 'Abel-Monitor/1.0' } }, 15000);
    const ms = Date.now() - t0;
    let body = '';
    try { body = (await r.text()).slice(0, 4000); } catch {}
    const server = (r.headers.get('server') || '').toLowerCase();
    const railwayFallback = !!r.headers.get('x-railway-fallback') || /Application not found|Application failed to respond/i.test(body);
    let status, note;
    if (railwayFallback && (r.status === 404 || r.status >= 500)) {
      status = 'down';
      note = /failed to respond/i.test(body) ? 'Railway: la app no responde (crash o puerto mal)' : 'Railway: app no encontrada (servicio borrado o dominio viejo)';
    } else if (r.status < 400) {
      status = ms > 7000 ? 'warn' : 'ok';
      note = ms > 7000 ? `Responde lento (${(ms / 1000).toFixed(1)} s)` : 'Responde bien';
    } else if (r.status === 401 || r.status === 403) {
      status = 'ok'; note = 'En línea (protegida con login)';
    } else if (r.status === 404 && /Cannot GET \//.test(body)) {
      status = 'ok'; note = 'Servidor vivo (no tiene página de inicio)';
    } else if (r.status === 404) {
      status = 'down';
      note = server.includes('github') ? 'GitHub Pages: 404 (Pages no activado o falta index.html)' : 'Página no encontrada (404)';
    } else if (r.status === 429) {
      status = 'warn'; note = 'Bloqueó por muchas consultas (429)';
    } else if (r.status >= 500) {
      status = 'down'; note = `Error del servidor (${r.status})`;
    } else {
      status = 'warn'; note = `Respuesta rara (HTTP ${r.status})`;
    }
    return { url, status, code: r.status, ms, note };
  } catch (e) {
    return {
      url, status: 'down', code: 0, ms: Date.now() - t0,
      note: e.name === 'AbortError' ? 'No contesta (tardó más de 15 s)' : 'No se pudo conectar (dominio o servidor caído)',
    };
  }
}

// ---------- GitHub ----------
function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'abel-monitor' };
  if (GITHUB_TOKEN) h.Authorization = 'Bearer ' + GITHUB_TOKEN;
  return h;
}
function mapRepo(x) {
  const owner = x.owner.login;
  const isUserSite = x.name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  return {
    full: x.full_name, name: x.name, owner, url: x.html_url,
    pushedAt: x.pushed_at, private: x.private, archived: x.archived,
    pages: x.has_pages ? (isUserSite ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner.toLowerCase()}.github.io/${x.name}/`) : null,
    homepage: x.homepage || null,
  };
}
async function githubRepos() {
  const repos = new Map();
  const errors = [];
  let login = null;
  if (GITHUB_TOKEN) {
    try {
      const me = await fetchT('https://api.github.com/user', { headers: ghHeaders() });
      if (me.ok) login = (await me.json()).login.toLowerCase();
      for (let page = 1; page <= 3; page++) {
        const r = await fetchT(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner`, { headers: ghHeaders() });
        if (!r.ok) { errors.push(`GitHub token: HTTP ${r.status}`); break; }
        const arr = await r.json();
        arr.forEach(x => repos.set(x.full_name.toLowerCase(), mapRepo(x)));
        if (arr.length < 100) break;
      }
    } catch (e) { errors.push('GitHub token: ' + e.message); }
  }
  for (const u of GITHUB_USERS) {
    if (login && u.toLowerCase() === login) continue;
    try {
      const r = await fetchT(`https://api.github.com/users/${u}/repos?per_page=100&sort=pushed`, { headers: ghHeaders() });
      if (!r.ok) { errors.push(`GitHub ${u}: HTTP ${r.status}${r.status === 403 ? ' (límite de consultas, poné GITHUB_TOKEN)' : ''}`); continue; }
      (await r.json()).forEach(x => repos.set(x.full_name.toLowerCase(), mapRepo(x)));
    } catch (e) { errors.push(`GitHub ${u}: ${e.message}`); }
  }
  return { repos: [...repos.values()].filter(r => !r.archived), errors };
}

async function findHtml(full) {
  try {
    const r = await fetchT(`https://api.github.com/repos/${full}/contents/`, { headers: ghHeaders() });
    if (!r.ok) return null;
    const files = (await r.json()).filter(f => f.type === 'file' && /\.html?$/i.test(f.name)).map(f => f.name);
    return files.find(f => /^index\.html?$/i.test(f)) || files[0] || null;
  } catch { return null; }
}

// ---------- Railway ----------
const RW_SERVICES = `services { edges { node { id name serviceInstances { edges { node { environmentId domains { serviceDomains { domain } customDomains { domain } } latestDeployment { id status createdAt } } } } } } }`;
const RW_ENVS = `environments { edges { node { id name } } }`;
const RW_QUERIES = [
  `query { projects { edges { node { id name ${RW_ENVS} ${RW_SERVICES} } } } }`,
  `query { me { projects { edges { node { id name ${RW_ENVS} ${RW_SERVICES} } } } } }`,
  `query { me { workspaces { id name projects { edges { node { id name ${RW_ENVS} ${RW_SERVICES} } } } } } }`,
  `query { projects { edges { node { id name ${RW_SERVICES} } } } }`,
  `query { me { projects { edges { node { id name ${RW_SERVICES} } } } } }`,
  `query { me { workspaces { id name projects { edges { node { id name ${RW_SERVICES} } } } } } }`,
];
function rwStatus(s) {
  const st = String(s || '').toUpperCase();
  if (st === 'SUCCESS') return { status: 'ok', note: 'Deploy activo' };
  if (st === 'SLEEPING') return { status: 'warn', note: 'Dormido (app serverless)' };
  if (['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING'].includes(st)) return { status: 'warn', note: 'Desplegando una versión nueva…', transient: true };
  if (st === 'FAILED') return { status: 'down', note: 'El último deploy FALLÓ (revisá Build Logs)' };
  if (st === 'CRASHED') return { status: 'down', note: 'La app se CAYÓ (revisá Deploy Logs)' };
  if (st === 'REMOVED' || st === 'REMOVING') return { status: 'unknown', note: 'Deploy eliminado' };
  if (!st) return { status: 'unknown', note: 'Sin deploys' };
  return { status: 'warn', note: st };
}
async function railwayServices() {
  if (!RAILWAY_TOKEN) return { services: [], errors: ['Sin RAILWAY_TOKEN: Railway se revisa solo por los links'], enabled: false };
  const errors = [];
  for (const q of RW_QUERIES) {
    try {
      const r = await fetchT(process.env.RAILWAY_API_URL || 'https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RAILWAY_TOKEN },
        body: JSON.stringify({ query: q }),
      }, 20000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j.errors && !j.data)) { errors.push((j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`); continue; }
      const services = [];
      const seenProj = new Set();
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o.name && o.services && o.services.edges && !seenProj.has(o.id)) {
          seenProj.add(o.id);
          const envName = {};
          (o.environments?.edges || []).forEach(e => { envName[e.node.id] = e.node.name; });
          for (const se of o.services.edges) {
            const s = se.node;
            const insts = (s.serviceInstances?.edges || []).map(e => e.node).filter(Boolean);
            const newest = arr => [...arr].sort((a, b) => String(b.latestDeployment?.createdAt || '').localeCompare(String(a.latestDeployment?.createdAt || '')))[0];
            // solo el ambiente que usás: production, o el que tiene el último deploy bueno
            const inst = insts.find(i => /^prod/i.test(envName[i.environmentId] || ''))
              || newest(insts.filter(i => i.latestDeployment?.status === 'SUCCESS'))
              || newest(insts);
            const domains = [];
            if (inst) {
              (inst.domains?.customDomains || []).forEach(d => domains.push(d.domain));
              (inst.domains?.serviceDomains || []).forEach(d => domains.push(d.domain));
            }
            const dep = inst ? inst.latestDeployment : null;
            const st = rwStatus(dep && dep.status);
            services.push({
              id: s.id, name: s.name, project: o.name, projectId: o.id, env: inst ? (envName[inst.environmentId] || null) : null,
              domains: [...new Set(domains)], deployStatus: dep ? dep.status : null, transient: !!st.transient,
              deployedAt: dep ? dep.createdAt : null, status: st.status, note: st.note,
              link: `https://railway.com/project/${o.id}/service/${s.id}`,
            });
          }
          return;
        }
        Object.values(o).forEach(walk);
      })(j.data);
      return { services, errors: [], enabled: true };
    } catch (e) { errors.push(e.message); }
  }
  return { services: [], errors: ['Railway API: ' + errors.join(' | ')], enabled: true };
}

// ---------- WhatsApp (Evolution API) ----------
async function evolutionState(evo) {
  if (!EVOLUTION_API_KEY) return { status: 'unknown', note: 'Falta EVOLUTION_API_KEY para ver si WhatsApp está conectado' };
  try {
    const r = await fetchT(`${evo.url.replace(/\/$/, '')}/instance/connectionState/${encodeURIComponent(evo.instance)}`, { headers: { apikey: EVOLUTION_API_KEY } });
    if (!r.ok) return { status: 'down', note: `Evolution respondió ${r.status} para la instancia ${evo.instance}` };
    const j = await r.json();
    const state = (j.instance && j.instance.state) || j.state;
    if (state === 'open') return { status: 'ok', note: `WhatsApp ${evo.instance} conectado` };
    if (state === 'connecting') return { status: 'warn', note: `WhatsApp ${evo.instance} conectando…` };
    return { status: 'down', note: `WhatsApp ${evo.instance} DESCONECTADO: hay que escanear el QR` };
  } catch (e) { return { status: 'down', note: 'No se pudo consultar Evolution API' }; }
}

// ---------- Claude ----------
async function claudeState() {
  if (!ANTHROPIC_API_KEY) return { status: 'unknown', note: 'Falta ANTHROPIC_API_KEY (el chat no va a pensar)' };
  try {
    const r = await fetchT('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    if (r.ok) return { status: 'ok', note: 'API de Claude funcionando' };
    if (r.status === 401) return { status: 'down', note: 'La API key de Claude es inválida' };
    return { status: 'warn', note: `Claude respondió ${r.status}` };
  } catch { return { status: 'down', note: 'No se pudo conectar con Claude' }; }
}

// ---------- ciclo de chequeo ----------
let SNAPSHOT = { updatedAt: null, checking: false, projects: [], infra: {}, groups: [], summary: {} };
const HISTORY = new Map(); // id -> [{t, s}]

async function runChecks() {
  if (SNAPSHOT.checking) return SNAPSHOT;
  SNAPSHOT.checking = true;
  const started = Date.now();
  try {
    const cfg = loadConfig();
    const [gh, rw, claude] = await Promise.all([githubRepos(), railwayServices(), claudeState()]);

    const projects = cfg.projects.map(p => ({ ...p, _repos: [], _rail: [], urls: [...p.urls] }));
    const byId = Object.fromEntries(projects.map(p => [p.id, p]));

    // repos: primero coincidencia exacta, después por palabra clave
    const leftoverRepos = [];
    for (const repo of gh.repos) {
      const full = repo.full.toLowerCase();
      let p = projects.find(x => x.repos.some(r => r.toLowerCase() === full));
      if (!p) {
        const n = repo.name.toLowerCase();
        p = projects.find(x => [x.id, ...x.railway].some(k => k.length > 3 && n.includes(k.toLowerCase())));
      }
      if (p) p._repos.push(repo); else leftoverRepos.push(repo);
    }
    // servicios de Railway por palabra clave
    const leftoverRail = [];
    for (const s of rw.services) {
      const n = `${s.project}/${s.name}`.toLowerCase();
      const p = projects.find(x => x.railway.some(k => n.includes(k.toLowerCase())));
      if (p) p._rail.push(s); else leftoverRail.push(s);
    }
    // lo que no coincide aparece igual, como "descubierto"
    for (const repo of leftoverRepos) {
      const id = 'gh-' + slug(repo.full);
      byId[id] = { id, name: repo.name, group: 'descubiertos', auto: true, desc: `Repositorio ${repo.full} (no está en projects.json)`, urls: [], repos: [], railway: [], _repos: [repo], _rail: [] };
      projects.push(byId[id]);
    }
    for (const s of leftoverRail) {
      const id = 'rw-' + slug(s.project + '-' + s.name);
      byId[id] = { id, name: s.name, group: 'descubiertos', auto: true, desc: `Servicio de Railway ${s.project} / ${s.name} (no está en projects.json)`, urls: [], repos: [], railway: [], _repos: [], _rail: [s] };
      projects.push(byId[id]);
    }

    // armar lista de links a chequear, recordando de dónde sale cada uno
    const norm = u => u.toLowerCase().replace(/\/$/, '');
    for (const p of projects) {
      p._targets = p.urls.map(url => ({ url, src: 'config' }));
      const has = u => p._targets.some(t => norm(t.url) === norm(u) || norm(u).startsWith(norm(t.url)));
      for (const sv of p._rail) for (const d of sv.domains) { const u = 'https://' + d; if (!has(u)) p._targets.push({ url: u, src: 'railway', svc: sv.id }); }
      for (const r of p._repos) if (r.pages && !has(r.pages)) p._targets.push({ url: r.pages, src: 'pages', repo: r.full });
    }
    const allUrls = [...new Set(projects.flatMap(p => p._targets.map(t => t.url)))];
    const results = await pool(allUrls, 8, checkUrl);
    const urlMap = Object.fromEntries(results.map(r => [r.url, r]));

    // GitHub Pages sin index.html: buscar el .html que sí existe (ej. mis-finanzas.html)
    const pagesMiss = projects.flatMap(p => p._targets.filter(t => t.src === 'pages' && urlMap[t.url] && urlMap[t.url].code === 404));
    await pool(pagesMiss, 4, async t => {
      const file = await findHtml(t.repo);
      if (!file) { urlMap[t.url] = { ...urlMap[t.url], note: 'GitHub Pages activado pero el repo no tiene ninguna página .html' }; return; }
      const u = t.url.replace(/\/?$/, '/') + encodeURI(file);
      if (!urlMap[u]) urlMap[u] = await checkUrl(u);
      t.url = u;
    });

    // bots de WhatsApp
    await pool(projects.filter(p => p.evolution), 3, async p => { p._evo = await evolutionState(p.evolution); });

    const BEST = { ok: 3, warn: 2, down: 1, code: 0, unknown: 0 };
    const out = projects.map(p => {
      const checks = p._targets.map(t => urlMap[t.url] && ({ ...urlMap[t.url], src: t.src, svc: t.svc })).filter(Boolean);
      const counted = [];
      for (const c of checks.filter(c => c.src === 'config')) counted.push(c);
      // varios dominios del mismo servicio: alcanza con que uno ande
      for (const sv of p._rail) {
        const mine = checks.filter(c => c.src === 'railway' && c.svc === sv.id);
        if (!mine.length) continue;
        const best = mine.reduce((a, b) => (BEST[b.status] > BEST[a.status] ? b : a));
        counted.push(best);
        mine.filter(c => c !== best && c.status === 'down' && best.status !== 'down')
          .forEach(c => { c.ignored = true; c.note += ' · dominio sin uso, no cuenta (podés borrarlo en Railway)'; });
      }
      // las páginas de GitHub de repos secundarios solo cuentan si no hay nada mejor para revisar
      const pagesChecks = checks.filter(c => c.src === 'pages');
      if (!counted.length) counted.push(...pagesChecks);
      else pagesChecks.forEach(c => { c.ignored = true; c.note += ' · repo secundario, no cuenta'; });
      for (const c of checks) delete c.svc;

      const railway = p._rail.map(({ id, name, project, env, domains, deployStatus, deployedAt, status, note, link, transient }) => ({ id, name, project, env, domains, deployStatus, deployedAt, status, note, link, transient }));
      const anyOk = counted.some(c => c.status === 'ok');
      const statuses = [
        ...counted.map(c => c.status),
        // si la app responde, un deploy en curso no es un problema (la versión anterior sigue andando)
        ...railway.filter(sv => sv.status !== 'unknown' && !(sv.transient && anyOk)).map(sv => sv.status),
      ];
      if (p._evo && p._evo.status !== 'unknown') statuses.push(p._evo.status);
      let status = worst(statuses);
      if (status === 'unknown' && p._repos.length) status = 'code';
      const hist = HISTORY.get(p.id) || [];
      hist.push({ t: started, s: status });
      while (hist.length > 288) hist.shift(); // ~24 h si chequea cada 5 min
      HISTORY.set(p.id, hist);
      const considered = hist.filter(h => h.s !== 'unknown' && h.s !== 'code');
      const uptime = considered.length ? Math.round(100 * considered.filter(h => h.s !== 'down').length / considered.length) : null;
      return {
        id: p.id, name: p.name, group: p.group, desc: p.desc || '', auto: !!p.auto,
        status, checks, railway, whatsapp: p._evo || null,
        repos: p._repos.map(r => ({ full: r.full, url: r.url, pushedAt: r.pushedAt, pages: r.pages, private: r.private })),
        lastPush: p._repos.map(r => r.pushedAt).sort().pop() || null,
        open: (checks.find(c => c.status === 'ok') || checks[0] || {}).url || (p._repos[0] && p._repos[0].url) || null,
        uptime, history: hist.slice(-48).map(h => h.s),
      };
    });

    const summary = { ok: 0, warn: 0, down: 0, code: 0, unknown: 0 };
    out.forEach(p => { summary[p.status] = (summary[p.status] || 0) + 1; });

    SNAPSHOT = {
      updatedAt: new Date().toISOString(), tookMs: Date.now() - started, checking: false,
      groups: cfg.groups, projects: out, summary,
      infra: {
        github: { status: gh.errors.length ? (gh.repos.length ? 'warn' : 'down') : 'ok', note: gh.errors.length ? gh.errors.join(' · ') : `${gh.repos.length} repos leídos${GITHUB_TOKEN ? ' (con token, incluye privados)' : ''}` },
        railway: rw.enabled
          ? { status: rw.errors.length ? 'down' : 'ok', note: rw.errors.length ? rw.errors.join(' · ') : `${rw.services.length} servicios leídos` }
          : { status: 'unknown', note: rw.errors[0] },
        claude,
        whatsapp: (() => {
          const evo = out.filter(p => p.whatsapp);
          if (!evo.length) return { status: 'unknown', note: 'Sin instancias configuradas' };
          return { status: worst(evo.map(p => p.whatsapp.status)), note: evo.map(p => p.whatsapp.note).join(' · ') };
        })(),
      },
    };
    console.log(`[abel] chequeo listo en ${SNAPSHOT.tookMs} ms →`, JSON.stringify(summary));
    processAlerts(out).catch(e => console.error('[abel] alertas', e));
    SNAPSHOT.alerts = alertInfo();
  } catch (e) {
    console.error('[abel] error en chequeo', e);
    SNAPSHOT.checking = false;
    SNAPSHOT.error = e.message;
  }
  return SNAPSHOT;
}

// ---------- alertas por WhatsApp ----------
const ALERT = { state: new Map(), booted: false, lastSent: null, lastError: null, recheckTimer: null, lastDaily: null };
function alertEvoUrl() {
  if (ALERT_EVO_URL_ENV) return ALERT_EVO_URL_ENV.replace(/\/$/, '');
  try { const p = loadConfig().projects.find(x => x.evolution && x.evolution.url); return p ? p.evolution.url.replace(/\/$/, '') : ''; } catch { return ''; }
}
function alertMissing() {
  const m = [];
  if (!ALERT_TO.length) m.push('ALERT_WHATSAPP_TO');
  if (!ALERT_INSTANCE) m.push('ALERT_EVOLUTION_INSTANCE');
  if (!EVOLUTION_API_KEY) m.push('EVOLUTION_API_KEY');
  if (!alertEvoUrl()) m.push('ALERT_EVOLUTION_URL');
  return m;
}
function alertInfo() {
  const missing = alertMissing();
  return {
    enabled: !missing.length, missing, instance: ALERT_INSTANCE || null,
    to: ALERT_TO.map(n => '…' + n.slice(-4)), lastSent: ALERT.lastSent, lastError: ALERT.lastError,
    dailyHour: /^\d{1,2}$/.test(ALERT_DAILY_HOUR) ? Number(ALERT_DAILY_HOUR) : null, remindHours: ALERT_REMIND_HOURS || null,
  };
}
async function sendWhatsApp(text) {
  const missing = alertMissing();
  if (missing.length) throw new Error('Faltan variables: ' + missing.join(', '));
  const url = `${alertEvoUrl()}/message/sendText/${encodeURIComponent(ALERT_INSTANCE)}`;
  const headers = { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY };
  for (const number of ALERT_TO) {
    let r = await fetchT(url, { method: 'POST', headers, body: JSON.stringify({ number, text }) }, 20000);
    if (r.status === 400) { // Evolution v1 usa otro formato
      r = await fetchT(url, { method: 'POST', headers, body: JSON.stringify({ number, textMessage: { text } }) }, 20000);
    }
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 200);
      throw new Error(`Evolution respondió ${r.status}${r.status === 404 ? ' (¿la instancia existe y está conectada?)' : r.status === 401 ? ' (apikey incorrecta)' : ''}: ${body}`);
    }
  }
  ALERT.lastSent = new Date().toISOString(); ALERT.lastError = null;
}
async function safeSend(text) {
  try { await sendWhatsApp(text); console.log('[abel] alerta enviada'); }
  catch (e) { ALERT.lastError = e.message; console.error('[abel] no se pudo mandar la alerta:', e.message); }
  if (SNAPSHOT) SNAPSHOT.alerts = alertInfo();
}
function reasonText(p) {
  const c = p.checks.find(c => c.status === 'down' && !c.ignored) || p.railway.find(s => s.status === 'down') || (p.whatsapp && p.whatsapp.status === 'down' ? p.whatsapp : null);
  return c ? c.note : 'No responde';
}
function linkOf(p) { const c = p.checks.find(c => !c.ignored); return c ? c.url : (p.railway[0] ? p.railway[0].link : ''); }
function duration(fromMs) {
  const m = Math.max(1, Math.round((Date.now() - fromMs) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return h < 48 ? `${h} h${r ? ' ' + r + ' min' : ''}` : `${Math.round(h / 24)} días`;
}
const footer = () => PUBLIC_URL ? `\n\nAbrí ABEL: ${PUBLIC_URL}` : '';

async function processAlerts(projects) {
  if (alertMissing().length) { ALERT.booted = true; return; }
  const now = Date.now(), newDown = [], recovered = [], remind = [];
  let suspect = false;
  for (const p of projects) {
    if (p.status === 'code' || p.status === 'unknown') continue;
    const st = ALERT.state.get(p.id) || { status: null, streak: 0, alerted: false, downSince: null, lastRemind: 0 };
    if (p.status === 'down') {
      st.streak = st.status === 'down' ? st.streak + 1 : 1;
      if (!st.downSince) st.downSince = now;
      if (!ALERT.booted) { st.alerted = true; st.lastRemind = now; } // al arrancar no avisa lo que ya estaba caído
      else if (!st.alerted && st.streak >= ALERT_CONFIRM) { newDown.push(p); st.alerted = true; st.lastRemind = now; }
      else if (!st.alerted) suspect = true;
      else if (ALERT_REMIND_HOURS > 0 && now - st.lastRemind > ALERT_REMIND_HOURS * 3600e3) { remind.push({ p, since: st.downSince }); st.lastRemind = now; }
    } else {
      if (st.alerted && p.status === 'ok') recovered.push({ p, since: st.downSince });
      if (p.status === 'ok') { st.alerted = false; st.downSince = null; }
      st.streak = 0;
    }
    st.status = p.status;
    ALERT.state.set(p.id, st);
  }
  ALERT.booted = true;
  // algo parece caído: confirmarlo en 1 minuto en vez de esperar el próximo chequeo
  if (suspect && !ALERT.recheckTimer) ALERT.recheckTimer = setTimeout(() => { ALERT.recheckTimer = null; runChecks(); }, 60000);

  const parts = [];
  if (newDown.length) parts.push(newDown.length === 1
    ? `🔴 *Se cayó ${newDown[0].name}*\n${reasonText(newDown[0])}${linkOf(newDown[0]) ? '\n' + linkOf(newDown[0]) : ''}`
    : `🔴 *Se cayeron ${newDown.length} apps*\n` + newDown.map(p => `• *${p.name}*: ${reasonText(p)}`).join('\n'));
  if (recovered.length) parts.push(recovered.map(({ p, since }) => `🟢 *${p.name} volvió a funcionar*${since ? ` (estuvo caída ${duration(since)})` : ''}`).join('\n'));
  if (remind.length) parts.push(`⏰ *Siguen caídas*\n` + remind.map(({ p, since }) => `• *${p.name}* hace ${duration(since)}: ${reasonText(p)}`).join('\n'));
  if (parts.length) await safeSend(parts.join('\n\n') + footer());
}

function dailyReport() {
  const s = SNAPSHOT.summary || {};
  const down = SNAPSHOT.projects.filter(p => p.status === 'down');
  const warn = SNAPSHOT.projects.filter(p => p.status === 'warn');
  const fecha = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'numeric' });
  let t = `📋 *Reporte de ABEL* · ${fecha}\n✅ ${s.ok || 0} funcionan · ⚠️ ${s.warn || 0} con problemas · 🔴 ${s.down || 0} caídas`;
  if (down.length) t += `\n\n*Caídas*\n` + down.map(p => `• ${p.name}: ${reasonText(p)}`).join('\n');
  if (warn.length) t += `\n\n*Con problemas*\n` + warn.map(p => `• ${p.name}`).join('\n');
  if (!down.length && !warn.length) t += `\n\nTodo en orden 👌`;
  const inf = Object.entries(SNAPSHOT.infra || {}).filter(([, v]) => v.status === 'down' || v.status === 'warn');
  if (inf.length) t += `\n\n*Infraestructura*\n` + inf.map(([k, v]) => `• ${k}: ${v.note}`).join('\n');
  return t + footer();
}
setInterval(() => {
  if (!/^\d{1,2}$/.test(ALERT_DAILY_HOUR) || alertMissing().length || !SNAPSHOT.updatedAt) return;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) === Number(ALERT_DAILY_HOUR) && ALERT.lastDaily !== day) { ALERT.lastDaily = day; safeSend(dailyReport()); }
}, 60000);

// ---------- servidor ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

const TOKEN = crypto.createHmac('sha256', SECRET).update('abel-ok').digest('hex');
function auth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.get('x-abel-token') === TOKEN) return next();
  res.status(401).json({ error: 'login' });
}

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ token: 'open' });
  const ok = typeof req.body.password === 'string' && req.body.password.length === APP_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(req.body.password), Buffer.from(APP_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({ token: TOKEN });
});

app.get('/api/status', auth, (req, res) => res.json(SNAPSHOT));
app.post('/api/refresh', auth, async (req, res) => res.json(await runChecks()));
app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/api/alert-test', auth, async (req, res) => {
  try {
    await sendWhatsApp(`✅ *Prueba de ABEL*\nLas alertas por WhatsApp funcionan. Te aviso acá si se cae alguna app.${footer()}`);
    SNAPSHOT.alerts = alertInfo();
    res.json({ ok: true, alerts: SNAPSHOT.alerts });
  } catch (e) { ALERT.lastError = e.message; SNAPSHOT.alerts = alertInfo(); res.status(400).json({ ok: false, error: e.message, alerts: SNAPSHOT.alerts }); }
});
app.post('/api/alert-report', auth, async (req, res) => {
  try { await sendWhatsApp(dailyReport()); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

function snapshotText() {
  const S = { ok: 'FUNCIONA', warn: 'CON PROBLEMAS', down: 'CAÍDO', code: 'SOLO CÓDIGO (sin web para revisar)', unknown: 'SIN DATOS' };
  const lines = SNAPSHOT.projects.map(p => {
    const det = [
      ...p.checks.filter(c => c.status !== 'ok' && !c.ignored).map(c => `${c.url}: ${c.note}`),
      ...p.railway.filter(s => s.status !== 'ok').map(s => `Railway ${s.project}/${s.name}: ${s.note}`),
      p.whatsapp && p.whatsapp.status !== 'ok' ? p.whatsapp.note : '',
    ].filter(Boolean).join('; ');
    return `- [${p.id}] ${p.name} (${p.group}): ${S[p.status]}${det ? ' — ' + det : ''}${p.lastPush ? ` · último cambio en GitHub ${p.lastPush.slice(0, 10)}` : ''}${p.desc ? ' · ' + p.desc : ''}`;
  });
  const inf = Object.entries(SNAPSHOT.infra || {}).map(([k, v]) => `- ${k}: ${S[v.status] || v.status} — ${v.note}`);
  const al = SNAPSHOT.alerts || alertInfo();
  const alertLine = al.enabled ? `Alertas por WhatsApp: ACTIVADAS (instancia ${al.instance}${al.dailyHour != null ? ', reporte diario a las ' + al.dailyHour + ' h' : ''}${al.lastError ? ', último error: ' + al.lastError : ''}). El usuario puede mandar una prueba desde la chapita WhatsApp.` : `Alertas por WhatsApp: APAGADAS, faltan las variables ${al.missing.join(', ')} en Railway.`;
  return `${alertLine}\nÚltimo chequeo: ${SNAPSHOT.updatedAt || 'todavía no'}\nResumen: ${JSON.stringify(SNAPSHOT.summary)}\n\nINFRAESTRUCTURA\n${inf.join('\n')}\n\nPROYECTOS\n${lines.join('\n')}`;
}

app.post('/api/chat', auth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ reply: 'Todavía no tengo cerebro: falta cargar ANTHROPIC_API_KEY en las variables de Railway. Igual podés ver en la red qué funciona y qué no.' });
  let messages = (Array.isArray(req.body.messages) ? req.body.messages : [])
    .slice(-16)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
    .filter(m => m.content.trim());
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return res.status(400).json({ error: 'Mensaje vacío' });
  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const system = `Sos ABEL, el asistente personal de Abel Fernández (Tutu Automotores en Córdoba y su empresa AyN Servicios Digitales). Hablás en español rioplatense, cálido y directo.
Tus respuestas muchas veces se leen en VOZ ALTA: respondé corto (2 a 5 oraciones) salvo que te pida detalle, sin markdown, sin asteriscos, sin tablas ni emojis, y decí los links por su nombre, no la URL completa.
Conocés el estado EN VIVO de todos sus proyectos (abajo). Si algo está caído, decí qué falla y el primer paso concreto para arreglarlo: por ejemplo revisar Deploy Logs o hacer Redeploy en Railway, escanear el QR de la instancia en Evolution API, activar GitHub Pages en Settings > Pages, renovar el dominio, o revisar variables de entorno. No inventes estados que no figuran; si no hay datos, decilo.
Podés ejecutar acciones en la app poniendo al FINAL de tu respuesta estas etiquetas (no las leas ni las expliques): [[foco:ID]] resalta un proyecto en la red, [[abrir:ID]] abre su link, [[revisar]] vuelve a chequear todo. Usá solo IDs que aparecen entre corchetes en la lista.
Fecha y hora actual: ${now}.

${snapshotText()}`;
  try {
    const r = await fetchT('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 900, system, messages }),
    }, 60000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
      console.error('[abel] Claude error', msg);
      return res.json({ reply: `No pude pensar la respuesta: Claude devolvió "${msg}". Revisá ANTHROPIC_API_KEY y CLAUDE_MODEL en Railway.` });
    }
    const reply = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    res.json({ reply: reply || 'No tengo respuesta para eso.' });
  } catch (e) {
    res.json({ reply: 'Se cortó la conexión con Claude. Probá de nuevo en un ratito.' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`[abel] Red neuronal escuchando en puerto ${PORT}`);
  runChecks();
  setInterval(runChecks, CHECK_EVERY_MIN * 60 * 1000);
});
