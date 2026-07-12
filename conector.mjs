#!/usr/bin/env node
/**
 * conector.mjs — capa de ingesta (§11) de Empleos Presenciales Chile
 *
 * Esto es lo que el HTML NO puede hacer: el navegador tiene CORS y no puede
 * leer sitios de terceros. La agregación es, por definición, server-side.
 *
 * Corre en Node 18+ sin dependencias:
 *     node conector.mjs
 * Deja un jobs.json junto al HTML. Levanta el sitio y ese archivo manda:
 *     python3 -m http.server 8080
 *
 * Jerarquía §11.1 respetada: solo mecanismos de nivel 1–4.
 *   - APIs públicas de lectura de ATS (Greenhouse, Lever, SmartRecruiters):
 *     documentadas y pensadas para ser consumidas por terceros.
 *   - JSON-LD JobPosting en páginas de carrera: marcado que el propio sitio
 *     publica para que lo lean máquinas. Se respeta robots.txt.
 * NO hay adaptador de Computrabajo/Laborum/Indeed/LinkedIn: sus términos lo
 * prohíben y ADR-006 del PRD también. Si consigues un feed contractual, se
 * agrega como un adaptador más de 20 líneas.
 */

import { writeFileSync } from 'node:fs';

const UA = 'EmpleosPresencialesChileBot/1.0 (+contacto@tudominio.cl)';
const PAUSE = 1200;                       // §11.4 límite de frecuencia
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ════════════════════════════════════════════════════════════
   1. FUENTES — edita solo esto
   ════════════════════════════════════════════════════════════ */

// Las 16 regiones. Careerjet/Jooble buscan por ubicación, así que barremos el país.
const REGIONES = [
  'Arica y Parinacota', 'Tarapacá', 'Antofagasta', 'Atacama', 'Coquimbo',
  'Valparaíso', 'Región Metropolitana', "O'Higgins", 'Maule', 'Ñuble',
  'Biobío', 'La Araucanía', 'Los Ríos', 'Los Lagos', 'Aysén', 'Magallanes'
];

const CJ_KEY = process.env.CAREERJET_KEY || process.env.CAREERJET_AFFID || '';
const JB_KEY = process.env.JOOBLE_KEY || '';

const FUENTES = [
  // Vía rápida al volumen real: agregadores que YA licenciaron los portales.
  ...(CJ_KEY ? REGIONES.map(r => ({ tipo: 'careerjet', key: CJ_KEY, region: r, paginas: 10, empresa: 'Careerjet' })) : []),
  ...(JB_KEY ? REGIONES.map(r => ({ tipo: 'jooble', key: JB_KEY, region: r, paginas: 5, empresa: 'Jooble' })) : []),

  // Vía lenta pero propia: empleadores y ATS directos. Aquí está tu foso.
  // { tipo:'greenhouse',     token:'nombre-empresa', empresa:'Nombre Empresa' },
  // { tipo:'lever',          token:'nombre-empresa', empresa:'Nombre Empresa' },
  // { tipo:'smartrecruiters',token:'NombreEmpresa',  empresa:'Nombre Empresa' },
  // { tipo:'jsonld', url:'https://empresa.cl/trabaja-con-nosotros', empresa:'Empresa' },
];

/* ════════════════════════════════════════════════════════════
   2. ADAPTADORES (contrato JobSourceConnector §11.3)
   ════════════════════════════════════════════════════════════ */
const get = async (url, json = true) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': json ? 'application/json' : 'text/html' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return json ? r.json() : r.text();
};

const strip = h => (h || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/* Careerjet entrega el salario en su periodicidad original (Y/M/W/D/H).
   Nuestro esquema §12 guarda CLP mensual: convertimos o descartamos. */
const FACTOR = { M: 1, Y: 1 / 12, W: 4.33, D: 22, H: 180 };
const mensual = (v, tipo, moneda) => {
  if (!v || !FACTOR[tipo]) return null;
  if (moneda && moneda !== 'CLP') return null;   // no inventamos tipos de cambio
  return Math.round(+v * FACTOR[tipo]);
};

const ADAPTERS = {
  /* ─────────────────────────────────────────────────────────
     CAREERJET — Job Search API v4
     Docs:     https://www.careerjet.com/partners/api
     API key:  https://www.careerjet.com/partners/register/as-publisher
     Auth Basic: usuario = API key, contraseña = vacía.
     Careerjet YA tiene los acuerdos con los portales. Tú no copias a nadie:
     consumes a un agregador que licenció el inventario.
     ───────────────────────────────────────────────────────── */
  async careerjet(f) {
    const auth = 'Basic ' + Buffer.from(f.key + ':').toString('base64');
    const out = [];
    const MAX_PAGE = 10;                        // límite duro de la API

    for (let page = 1; page <= Math.min(f.paginas || 10, MAX_PAGE); page++) {
      const u = new URL('https://search.api.careerjet.net/v4/query');
      u.search = new URLSearchParams({
        locale_code: 'es_CL',
        location: f.region,
        keywords: f.keywords || '',
        sort: 'date',
        page: String(page),
        page_size: '100',                       // máximo permitido
        fragment_size: '600',                   // descripción más larga que los 120 por defecto
        user_ip: f.ip || '1.1.1.1',
        user_agent: UA
      });

      const r = await fetch(u, { headers: { Authorization: auth, 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 120));
      const d = await r.json();

      if (d.type === 'LOCATIONS') {             // ubicación ambigua o inexistente
        console.warn(`    ubicación "${f.region}" → ${d.message}`);
        break;
      }
      if (d.type !== 'JOBS' || !d.jobs?.length) break;

      for (const j of d.jobs) out.push({
        src: 'careerjet',
        ext: (j.url.match(/[a-z0-9]{8,}/i) || [j.title + j.company])[0],
        title: j.title,
        company: j.company || 'No informada',
        location: j.locations || f.region,
        description: strip(j.description),
        smin: mensual(j.salary_min, j.salary_type, j.salary_currency_code),
        smax: mensual(j.salary_max, j.salary_type, j.salary_currency_code),
        pub: new Date(j.date).toISOString(),
        apply: j.url,                           // tracking de Careerjet: NO lo cambies
        portal_origen: j.site,                  // computrabajo.cl, laborum.com, etc.
        workplace_type: null
      });

      if (page >= (d.pages || 1)) break;
      await sleep(PAUSE);
    }
    return out;
  },

  /* JOOBLE — https://jooble.org/api/about — mismo modelo, opera cl.jooble.org */
  async jooble(f) {
    const out = [];
    for (let page = 1; page <= (f.paginas || 5); page++) {
      const r = await fetch(`https://cl.jooble.org/api/${f.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ keywords: f.keywords || '', location: f.region, page: String(page) })
      });
      if (!r.ok) throw new Error(`${r.status} jooble`);
      const d = await r.json();
      if (!d.jobs?.length) break;
      for (const j of d.jobs) out.push({
        src: 'jooble', ext: String(j.id),
        title: j.title, company: j.company || 'No informada',
        location: j.location || f.region,
        description: strip(j.snippet),
        pub: j.updated, apply: j.link,
        portal_origen: j.source,
        workplace_type: null
      });
      await sleep(PAUSE);
    }
    return out;
  },

  // https://developers.greenhouse.io/job-board.html  — API pública de lectura
  async greenhouse(f) {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${f.token}/jobs?content=true`);
    return (d.jobs || []).map(j => ({
      src: `greenhouse:${f.token}`, ext: String(j.id),
      title: j.title, company: f.empresa,
      location: j.location?.name || '',
      description: strip(j.content),
      pub: j.updated_at, apply: j.absolute_url,
      workplace_type: null
    }));
  },

  // https://api.lever.co/v0/postings/{token}?mode=json — API pública de lectura
  async lever(f) {
    const d = await get(`https://api.lever.co/v0/postings/${f.token}?mode=json`);
    return d.map(j => ({
      src: `lever:${f.token}`, ext: j.id,
      title: j.text, company: f.empresa,
      location: j.categories?.location || '',
      description: strip(j.descriptionPlain || j.description),
      pub: new Date(j.createdAt).toISOString(), apply: j.hostedUrl,
      employment: ({ 'Full-time': 'FULL_TIME', 'Part-time': 'PART_TIME', 'Intern': 'INTERNSHIP' })[j.categories?.commitment] || null,
      workplace_type: /remote/i.test(j.workplaceType || '') ? 'REMOTE'
        : /hybrid/i.test(j.workplaceType || '') ? 'HYBRID'
        : /on-?site/i.test(j.workplaceType || '') ? 'ONSITE' : null
    }));
  },

  async smartrecruiters(f) {
    const d = await get(`https://api.smartrecruiters.com/v1/companies/${f.token}/postings?limit=100`);
    return (d.content || []).map(j => ({
      src: `smartrecruiters:${f.token}`, ext: j.id,
      title: j.name, company: f.empresa,
      location: [j.location?.city, j.location?.region].filter(Boolean).join(', '),
      description: strip(j.jobAd?.sections?.jobDescription?.text || ''),
      pub: j.releasedDate, apply: j.applyUrl || j.ref,
      workplace_type: j.location?.remote ? 'REMOTE' : 'ONSITE'
    }));
  },

  // Páginas de carrera que ya emiten schema.org/JobPosting (§17.2, EXT-001).
  // Es el mismo marcado que el sitio publica para que Google lo indexe.
  async jsonld(f) {
    if (!(await robotsPermite(f.url))) { console.warn(`  robots.txt bloquea ${f.url} — omitida`); return []; }
    const html = await get(f.url, false);
    const out = [];
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
      for (const node of flatten(data)) {
        if (node['@type'] !== 'JobPosting') continue;
        const loc = node.jobLocation?.address || node.jobLocation?.[0]?.address || {};
        const sal = node.baseSalary?.value || {};
        out.push({
          src: `jsonld:${new URL(f.url).hostname}`,
          ext: String(node.identifier?.value || node.identifier || node.title),
          title: node.title,
          company: node.hiringOrganization?.name || f.empresa,
          location: loc.addressLocality || loc.addressRegion || '',
          description: strip(node.description),
          employment: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
          smin: +sal.minValue || +sal.value || null,
          smax: +sal.maxValue || null,
          pub: node.datePosted, exp_at: node.validThrough,
          apply: node.url || f.url,
          workplace_type: node.jobLocationType === 'TELECOMMUTE' ? 'REMOTE' : null
        });
      }
    }
    return out;
  }
};

const flatten = d => Array.isArray(d) ? d.flatMap(flatten) : d?.['@graph'] ? flatten(d['@graph']) : [d];

async function robotsPermite(url) {
  try {
    const u = new URL(url);
    const txt = await get(`${u.origin}/robots.txt`, false);
    let aplica = false;
    for (const raw of txt.split('\n')) {
      const l = raw.split('#')[0].trim();
      if (/^user-agent:/i.test(l)) aplica = /\*|bot/i.test(l.split(':')[1]);
      else if (aplica && /^disallow:/i.test(l)) {
        const p = l.split(':')[1].trim();
        if (p && u.pathname.startsWith(p)) return false;
      }
    }
  } catch { /* sin robots.txt = permitido */ }
  return true;
}

/* ════════════════════════════════════════════════════════════
   3. EJECUCIÓN — un connector_run por fuente (§11.3)
   ════════════════════════════════════════════════════════════ */
const CHILE = /chile|santiago|valpara|concep|antofagasta|temuco|iquique|puerto montt|la serena|rancagua|talca|calama|viña|arica|punta arenas|coquimbo|chill[aá]n|osorno|valdivia|copiap|curic|los [aá]ngeles|quilpu|melipilla|maip|providencia|las condes|[uñ]n?oa|pudahuel|quilicura/i;

const DEFAULTS = { employment: 'FULL_TIME', seniority: null, exp: null, smin: null, smax: null };
const en30dias = () => new Date(Date.now() + 30 * 864e5).toISOString();

const crudos = [];
const sources = {};
const runs = [];

for (const f of FUENTES) {
  const t0 = Date.now();
  const run = { fuente: f.tipo + ':' + (f.token || f.url), inicio: new Date().toISOString(), obtenidos: 0, chile: 0, errores: 0 };
  try {
    const rows = await ADAPTERS[f.tipo](f);
    run.obtenidos = rows.length;
    for (const r of rows) {
      // Solo Chile: el ATS es global, el producto no.
      if (!CHILE.test(`${r.location} ${r.description.slice(0, 400)}`)) continue;
      run.chile++;
      crudos.push({ ...DEFAULTS, exp_at: en30dias(), ...r });
      sources[r.src] ||= {
        id: r.src,
        name: f.empresa || r.src,
        mech: f.tipo === 'jsonld' ? 'JSON-LD público (nivel 4-5)' : `API pública de ${f.tipo} (nivel 1)`,
        legal: 'API de lectura documentada / marcado público',
        prio: f.tipo === 'jsonld' ? 2 : 1,
        status: 'ok'
      };
    }
  } catch (e) { run.errores++; run.error = e.message; console.error(`  ✗ ${run.fuente}: ${e.message}`); }
  run.ms = Date.now() - t0;
  runs.push(run);
  console.log(`  ${run.errores ? '✗' : '✓'} ${run.fuente.padEnd(38)} ${String(run.obtenidos).padStart(4)} avisos → ${String(run.chile).padStart(4)} en Chile`);
  await sleep(PAUSE);
}

if (!FUENTES.length) {
  console.log('\n  Sin fuentes configuradas. Para tener datos REALES:\n' +
              '    1. API key gratis: https://www.careerjet.com/partners/register/as-publisher\n' +
              '    2. Guárdala como secret CAREERJET_KEY y corre el workflow.\n' +
              '  El sitio seguirá mostrando los 25 avisos de ejemplo hasta entonces.\n');
}

writeFileSync('jobs.json', JSON.stringify({ generado: new Date().toISOString(), runs, sources, jobs: crudos }, null, 1));
console.log(`\n  jobs.json escrito — ${crudos.length} avisos crudos de ${Object.keys(sources).length} fuentes.`);
console.log('  El clasificador §8.3 y el dedup §13 corren en el HTML: sirve la carpeta y recarga.\n');
