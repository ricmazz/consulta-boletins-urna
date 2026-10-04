#!/usr/bin/env node
// Coletor de Boletins de Urna (BU) das Eleições 2026 - 1º turno
// Lê os arquivos públicos do TSE (resultados.tse.jus.br), baixa os BUs que já foram
// publicados, decodifica (ASN.1/DER) e gera CSVs por seção, por voto, por bairro e um resumo.
// Sem --uf, coleta Araçatuba (SP). Com dados/locais-<município>.json, liga cada seção ao
// local de votação e bairro e mostra o mapa de calor no painel.
//
// Uso:  node coletar-bus.mjs --web                      (Araçatuba, com painel em http://localhost:3000)
//       node coletar-bus.mjs                            (Araçatuba, uma passada, só CSV)
//       node coletar-bus.mjs --uf zz --web              (exterior)
//       node coletar-bus.mjs --help
//
// Requer Node 18+ e nenhuma dependência.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

// ---------------------------------------------------------------- configuração
const AMBIENTES = {
  oficial: { base: "https://resultados.tse.jus.br/oficial/ele2026", pleito: "3220", fed: "6257", est: "6259" },
  simulado: { base: "https://resultados-sim.tse.jus.br/simulado/simulado2026/ele2026", pleito: "17801", fed: "21270", est: "21272" },
};
const CARGOS = { 1: "Presidente", 3: "Governador", 5: "Senador", 6: "Deputado Federal", 7: "Deputado Estadual", 8: "Deputado Distrital", 25: "Conselheiro Distrital" };
const TIPO_VOTO = { 1: "nominal", 2: "branco", 3: "nulo", 4: "legenda" };

const AJUDA = `
Coletor de Boletins de Urna - Eleições 2026

  --uf <sigla>          UF a coletar (ex.: sp, rj, zz para exterior). Padrão: sp com --mun 61557 (Araçatuba).
  --mun <códigos>       Códigos TSE de município/cidade separados por vírgula (ex.: 61557).
  --zona <zonas>        Zonas separadas por vírgula (ex.: 11,299).
  --loop <segundos>     Repete a coleta a cada N segundos (mínimo 60). Sem isso, faz uma passada.
  --concorrencia <n>    Requisições simultâneas (padrão 3, máximo 8).
  --reintentar <min>    Minutos até tentar de novo uma seção que ainda não publicou (padrão 15).
  --out <pasta>         Pasta de saída (padrão ./saida/<uf>-<município>).
  --sem-bu              Não guarda os arquivos .bu.dat originais (só os CSVs).
  --ambiente <nome>     oficial (padrão) ou simulado.
  --web                 Abre um painel no navegador (http://localhost:3000) e repete a coleta a cada 2 min.
  --porta <n>           Porta do painel (padrão 3000).
`;

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2), nx = a[i + 1];
    if (nx && !nx.startsWith("--")) { o[k] = nx; i++; } else o[k] = true;
  }
  return o;
}
const opt = args();
if (opt.help) { console.log(AJUDA); process.exit(0); }
if (!opt.uf) { opt.uf = "sp"; opt.mun ??= "61557"; } // padrão: Araçatuba

const UF = String(opt.uf).toLowerCase();
const AMB = AMBIENTES[opt.ambiente || "oficial"];
if (!AMB) { console.error("Ambiente inválido. Use oficial ou simulado."); process.exit(1); }
const FILTRO_MUN = opt.mun ? new Set(String(opt.mun).split(",").map(s => s.trim().padStart(5, "0"))) : null;
const FILTRO_ZONA = opt.zona ? new Set(String(opt.zona).split(",").map(s => s.trim().padStart(4, "0"))) : null;
const WEB = !!opt.web;
const PORTA = Number(opt.porta) || 3000;
const LOOP = opt.loop ? Math.max(60, Number(opt.loop)) : (WEB ? 120 : 0); // com --web, repete a cada 2 min por padrão
const CONC = Math.min(8, Math.max(1, Number(opt.concorrencia) || 3));
const REINTENTAR_MS = (Number(opt.reintentar) || 15) * 60_000;
const OUT = opt.out || join("saida", FILTRO_MUN ? `${UF}-${[...FILTRO_MUN].join("_")}` : UF);
const SALVAR_BU = !opt["sem-bu"];

const pad = (s, n) => String(s).padStart(n, "0");
const P6 = pad(AMB.pleito, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const agora = () => new Date().toLocaleTimeString("pt-BR");

// ---------------------------------------------------------------- HTTP com proteção contra bloqueio
// O TSE bloqueia o IP por 10 min acima de 100 req/s ou com muitos 404. Aqui: poucas requisições
// simultâneas, intervalo mínimo entre elas e pausa automática se vier 403/429 em sequência.
let pausaAte = 0, seq403 = 0, ultimaReq = 0;
const INTERVALO_MIN_MS = 60; // no máximo ~16 req/s somando todas as filas

async function baixar(url, tipo = "json") {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    while (Date.now() < pausaAte) await sleep(1000);
    const espera = ultimaReq + INTERVALO_MIN_MS - Date.now();
    ultimaReq = Math.max(Date.now(), ultimaReq + INTERVALO_MIN_MS);
    if (espera > 0) await sleep(espera);
    let r;
    try { r = await fetch(url, { headers: { "user-agent": "coletor-bu/1.0" } }); }
    catch (e) { await sleep(2000 * (tentativa + 1)); continue; }
    if (r.status === 404) return { status: 404 };
    if (r.status === 403 || r.status === 429) {
      seq403++;
      if (seq403 >= 5) {
        pausaAte = Date.now() + 11 * 60_000;
        console.warn(`[${agora()}] Vários 403/429 seguidos: possível bloqueio do TSE. Pausando 11 minutos.`);
        seq403 = 0;
      }
      return { status: r.status };
    }
    seq403 = 0;
    if (!r.ok) { await sleep(2000 * (tentativa + 1)); continue; }
    return { status: 200, data: tipo === "json" ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  }
  return { status: 0 };
}

// ---------------------------------------------------------------- decodificador do BU (ASN.1 DER)
function derParse(b, i, end) {
  const out = [];
  while (i < end) {
    const t = b[i++]; let tag = t & 0x1f;
    if (tag === 0x1f) { tag = 0; let x; do { x = b[i++]; tag = tag * 128 + (x & 0x7f); } while (x & 0x80); }
    let l = b[i++];
    if (l & 0x80) { const n = l & 0x7f; l = 0; for (let j = 0; j < n; j++) l = l * 256 + b[i++]; }
    const node = { c: t >> 6, co: !!(t & 0x20), t: tag };
    if (node.co) node.k = derParse(b, i, i + l); else node.v = b.subarray(i, i + l);
    out.push(node); i += l;
  }
  return out;
}
const derInt = n => { let v = 0; for (const x of n.v) v = v * 256 + x; if (n.v.length && n.v[0] & 0x80) v -= 256 ** n.v.length; return v; };
const derStr = n => String.fromCharCode(...n.v);

export function parseBU(u8) {
  const envl = derParse(u8, 0, u8.length)[0].k;
  const oct = [...envl].reverse().find(n => !n.co && n.c === 0 && n.t === 4);
  const T = derParse(oct.v, 0, oct.v.length)[0].k;
  const sec = T[3];
  const info = { municipio: derInt(sec.k[0].k[0]), zona: derInt(sec.k[0].k[1]), local: derInt(sec.k[1]), secao: derInt(sec.k[2]),
    emissao: !T[4].co ? derStr(T[4]) : "" };
  const sa = T.find(n => n.c === 2 && n.t === 0 && n.co && n.k.length >= 2 && !n.k[0].co && n.k[0].t === 27);
  if (sa) { info.abertura = derStr(sa.k[0]); info.encerramento = derStr(sa.k[1]); }
  const rpe = T.find(n => n.co && n.c === 0 && n.t === 16 && n.k.length && n.k[0].co &&
    n.k[0].k.length && !n.k[0].k[0].co && n.k[0].k[0].t === 2 && n.k[0].k.some(x => x.co && x.t === 16));
  const eleicoes = [];
  for (const ele of rpe.k) {
    const ints = ele.k.filter(x => !x.co && x.t === 2);
    const rv = ele.k.find(x => x.co);
    const e = { id: derInt(ints[0]), aptos: ints[1] ? derInt(ints[1]) : null, cargos: [] };
    for (const r of rv.k) {
      const comp = derInt(r.k[1]);
      for (const tvc of r.k[2].k) {
        const cargo = derInt(tvc.k[0].co ? tvc.k[0].k[0] : tvc.k[0]);
        const votos = tvc.k.find(x => x.co && x.t === 16).k.map(v => {
          const f = {}; for (const x of v.k) if (x.c === 2) f[x.t] = x;
          return { tipo: derInt(f[1]), qtd: derInt(f[2]), id: f[3] ? f[3].k.map(derInt) : null };
        });
        e.cargos.push({ cargo, comparecimento: comp, votos });
      }
    }
    eleicoes.push(e);
  }
  return { info, eleicoes };
}

// ---------------------------------------------------------------- dados de apoio (nomes)
const nomesMun = {};
const nomesCand = {}; // cargo -> { cand: {n: {nm, sg}}, part: {n: sg} }

async function carregarNomesMunicipios() {
  const r = await baixar(`${AMB.base}/${AMB.fed}/config/mun-e${pad(AMB.fed, 6)}-cm.json`);
  if (r.status !== 200) return;
  for (const a of r.data.abr) if (a.cd === UF) for (const m of a.mu) nomesMun[m.cd] = m.nm;
}
async function nomesDoCargo(cargo) {
  if (nomesCand[cargo] !== undefined) return nomesCand[cargo];
  nomesCand[cargo] = null;
  const ele = cargo === 1 ? AMB.fed : AMB.est;
  const r = await baixar(`${AMB.base}/${ele}/dados/${UF}/${UF}-c${pad(cargo, 4)}-e${pad(ele, 6)}-u.json`);
  if (r.status !== 200) return null;
  const cand = {}, part = {};
  for (const a of r.data.carg[0].agr || []) for (const p of a.par || []) {
    part[p.n] = p.sg;
    for (const x of p.cand || []) cand[x.n] = { nm: x.nmu, sg: p.sg };
  }
  return (nomesCand[cargo] = { cand, part, vagas: Number(r.data.carg[0].nv) || 1 });
}
// cargos em disputa na UF, na ordem em que aparecem no painel
const CARGOS_UF = UF === "zz" ? [1] : UF === "df" ? [1, 3, 5, 6, 8] : [1, 3, 5, 6, 7];

// local de votação, bairro e coordenadas de cada seção (dados/locais-<mun>.json, ver gerar-locais.mjs)
const DIR_DADOS = fileURLToPath(new URL("./dados/", import.meta.url));
const locais = {};       // "mun-zona-local" -> { id, mun, nome, endereco, bairro, lat, lon, secoes }
const localDaSecao = {}; // "mun-zona-secao" -> id do local
async function carregarLocais(muns) {
  for (const mun of muns) {
    const arq = join(DIR_DADOS, `locais-${mun}.json`);
    if (!existsSync(arq)) continue;
    const d = JSON.parse(await readFile(arq, "utf8"));
    if (d.uf !== UF) continue;
    for (const l of d.locais) {
      const id = `${mun}-${l.zona}-${l.local}`;
      locais[id] = { id, mun, nome: l.nome, endereco: l.endereco, bairro: l.bairro, lat: l.lat, lon: l.lon, secoes: l.secoes.length };
      for (const s of l.secoes) localDaSecao[`${mun}-${l.zona}-${s}`] = id;
    }
  }
}

// ---------------------------------------------------------------- lista de seções
async function listarSecoes() {
  const r = await baixar(`${AMB.base}/arquivo-urna/${AMB.pleito}/config/${UF}/${UF}-p${P6}-cs.json`);
  if (r.status !== 200) throw new Error(`Não consegui baixar a lista de seções de ${UF.toUpperCase()} (HTTP ${r.status}).`);
  const lista = [];
  for (const a of r.data.abr) for (const m of a.mu) {
    if (FILTRO_MUN && !FILTRO_MUN.has(m.cd)) continue;
    for (const z of m.zon) {
      if (FILTRO_ZONA && !FILTRO_ZONA.has(z.cd)) continue;
      for (const s of z.sec) lista.push({ mun: m.cd, zona: z.cd, secao: s.ns, agregadas: (s.nsa || []).join("|"), da: s.da ? `${s.da} ${s.ha}` : "" });
    }
  }
  return lista;
}

// ---------------------------------------------------------------- estado persistente
const ARQ_ESTADO = join(OUT, "estado.json");
let estado = {}; // chave "mun-zona-secao" -> { st, hash, verificado, bu: {...} }

async function carregarEstado() {
  if (existsSync(ARQ_ESTADO)) estado = JSON.parse(await readFile(ARQ_ESTADO, "utf8"));
}
async function salvarEstado() { await writeFile(ARQ_ESTADO, JSON.stringify(estado)); }

// ---------------------------------------------------------------- coleta de uma seção
async function coletarSecao(s) {
  const k = `${s.mun}-${s.zona}-${s.secao}`;
  const atual = estado[k];
  if (atual?.bu) return "ja";
  if (atual && Date.now() - atual.verificado < REINTENTAR_MS && !s.da) return "aguardando";

  const dir = `${AMB.base}/arquivo-urna/${AMB.pleito}/dados/${UF}/${s.mun}/${s.zona}/${s.secao}`;
  const aux = await baixar(`${dir}/p${P6}-${UF}-m${s.mun}-z${s.zona}-s${s.secao}-aux.json`);
  if (aux.status !== 200) { estado[k] = { st: aux.status === 404 ? "não publicado" : `erro ${aux.status}`, verificado: Date.now() }; return "pendente"; }

  const comBU = (aux.data.hashes || []).filter(h => (h.arq || []).some(a => a.tp === "bu"));
  const h = comBU.find(x => /totaliz/i.test(x.st || "")) || comBU[comBU.length - 1];
  if (!h) { estado[k] = { st: aux.data.st || "sem BU", verificado: Date.now() }; return "pendente"; }

  const nm = h.arq.find(a => a.tp === "bu").nm;
  const bu = await baixar(`${dir}/${h.hash}/${nm}`, "bin");
  if (bu.status !== 200) { estado[k] = { st: `BU erro ${bu.status}`, verificado: Date.now() }; return "pendente"; }

  if (SALVAR_BU) {
    const pasta = join(OUT, "bu", UF, s.mun);
    await mkdir(pasta, { recursive: true });
    await writeFile(join(pasta, nm), bu.data);
  }
  let dec;
  try { dec = parseBU(bu.data); }
  catch (e) { estado[k] = { st: "BU ilegível", hash: h.hash, verificado: Date.now() }; return "pendente"; }

  estado[k] = { st: h.st || aux.data.st, hash: h.hash, recebido: `${h.dr || ""} ${h.hr || ""}`.trim(), arquivo: nm, verificado: Date.now(),
    agregadas: s.agregadas, bu: dec };
  return "novo";
}

// ---------------------------------------------------------------- CSVs
const csvCampo = v => { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = linhas => "﻿" + linhas.map(l => l.map(csvCampo).join(";")).join("\r\n") + "\r\n";
const dh = s => s && s.length >= 13 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)} ${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}` : "";

let painel = null; // dados que o painel web lê
let detalhe = { cargos: {}, geo: {}, porLocal: {} }; // listas completas e somas por local, servidas sob demanda
const progresso = { fase: "iniciando", feitos: 0, total: 0, proximoCiclo: null, ultimoCiclo: null, novosUltimoCiclo: 0, pausadoAte: 0 };
const valido = tipo => tipo === "nominal" || tipo === "legenda";

async function gerarCSVs(listaSecoes = []) {
  const noEscopo = new Set(listaSecoes.map(s => `${s.mun}-${s.zona}-${s.secao}`));
  const totalPorMun = {};
  for (const s of listaSecoes) totalPorMun[s.mun] = (totalPorMun[s.mun] || 0) + 1;
  const porMun = {};      // mun -> {coletadas, aptos, votantes, votos: {cargo: {nome: qtd}}, validos: {cargo: n}}
  const porLocal = {};    // id do local -> {coletadas, aptos, votantes}
  const geo = {};         // cargo -> id do local -> {validos, votos: {chave: qtd}}
  const porBairro = {};   // cargo -> bairro -> {validos, itens: {chave: {...}}}
  const listaPainel = []; // seções coletadas, para a tabela do painel
  const secoes = [["uf", "cod_municipio", "municipio", "zona", "secao", "secoes_agregadas", "local", "nome_local", "bairro", "aptos", "comparecimento", "abstencao", "abertura", "encerramento", "emissao_bu", "recebido_tse", "situacao", "arquivo_bu", "hash"]];
  const votos = [["uf", "cod_municipio", "municipio", "zona", "secao", "bairro", "cargo", "tipo_voto", "numero", "partido", "candidato", "votos"]];
  const soma = {}; // cargo -> chave -> {chave, tipo, numero, partido, nome, votos}
  const compar = {};

  for (const [k, e] of Object.entries(estado)) {
    if (!e.bu || !noEscopo.has(k)) continue; // a pasta de saída pode ter seções de outra coleta
    const [mun, zona, secao] = k.split("-");
    const munNome = nomesMun[mun] || "";
    const loc = locais[localDaSecao[k]];
    const bairro = loc?.bairro || "";
    const cargos = e.bu.eleicoes.flatMap(x => x.cargos.map(c => ({ ...c, aptos: x.aptos })));
    const aptos = cargos[0]?.aptos ?? "", comp = cargos[0]?.comparecimento ?? "";
    secoes.push([UF, mun, munNome, zona, secao, e.agregadas || "", e.bu.info.local, loc?.nome || "", bairro, aptos, comp, aptos !== "" && comp !== "" ? aptos - comp : "",
      dh(e.bu.info.abertura), dh(e.bu.info.encerramento), dh(e.bu.info.emissao), e.recebido || "", e.st, e.arquivo, e.hash]);
    const pm = porMun[mun] ??= { coletadas: 0, aptos: 0, votantes: 0, votos: {}, validos: {} };
    pm.coletadas++; pm.aptos += Number(aptos) || 0; pm.votantes += Number(comp) || 0;
    if (loc) { const pl = porLocal[loc.id] ??= { coletadas: 0, aptos: 0, votantes: 0 }; pl.coletadas++; pl.aptos += Number(aptos) || 0; pl.votantes += Number(comp) || 0; }
    listaPainel.push({ k, mun, nome: munNome, zona, secao, local: loc?.id || "", aptos, comp, emissao: dh(e.bu.info.emissao), recebido: e.recebido || "" });
    for (const c of cargos) {
      const N = await nomesDoCargo(c.cargo) || { cand: {}, part: {} };
      const cargoNome = CARGOS[c.cargo] || `Cargo ${c.cargo}`;
      compar[cargoNome] = (compar[cargoNome] || 0) + c.comparecimento;
      for (const v of c.votos) {
        const tipo = TIPO_VOTO[v.tipo] || `tipo ${v.tipo}`;
        let numero = "", partido = "", nome = "";
        if (v.tipo === 1 && v.id) { numero = v.id[v.id.length - 1]; const x = N.cand[numero]; nome = x?.nm || ""; partido = x?.sg || N.part[v.id[0]] || ""; }
        if (v.tipo === 4 && v.id) { numero = v.id[0]; partido = N.part[numero] || ""; nome = "(legenda)"; }
        if (v.tipo === 2) nome = "(branco)";
        if (v.tipo === 3) nome = "(nulo)";
        votos.push([UF, mun, munNome, zona, secao, bairro, cargoNome, tipo, numero, partido, nome, v.qtd]);
        const chave = `${tipo}|${numero}`;
        (soma[cargoNome] ??= {})[chave] ??= { chave, tipo, numero, partido, nome, votos: 0 };
        soma[cargoNome][chave].votos += v.qtd;
        if (bairro) {
          const b = (porBairro[cargoNome] ??= {})[bairro] ??= { validos: 0, itens: {} };
          (b.itens[chave] ??= { tipo, numero, partido, nome, votos: 0 }).votos += v.qtd;
          if (valido(tipo)) b.validos += v.qtd;
        }
        if (valido(tipo)) {
          const rot = v.tipo === 1 ? (nome || `Candidato ${numero}`) : `Legenda ${partido || numero}`;
          (pm.votos[cargoNome] ??= {})[rot] = (pm.votos[cargoNome][rot] || 0) + v.qtd;
          pm.validos[cargoNome] = (pm.validos[cargoNome] || 0) + v.qtd;
          if (loc) {
            const g = (geo[cargoNome] ??= {})[loc.id] ??= { validos: 0, votos: {} };
            g.validos += v.qtd; g.votos[chave] = (g.votos[chave] || 0) + v.qtd;
          }
        }
      }
    }
  }

  const resumo = [["cargo", "tipo_voto", "numero", "partido", "candidato", "votos", "percentual_validos"]];
  const linhasConsole = [];
  for (const [cargo, itens] of Object.entries(soma)) {
    const lista = Object.values(itens).sort((a, b) => b.votos - a.votos);
    const validos = lista.filter(x => valido(x.tipo)).reduce((s, x) => s + x.votos, 0);
    for (const x of lista) {
      const pct = valido(x.tipo) && validos ? (x.votos / validos * 100).toFixed(2).replace(".", ",") : "";
      resumo.push([cargo, x.tipo, x.numero, x.partido, x.nome, x.votos, pct]);
    }
    linhasConsole.push(`  ${cargo} (${compar[cargo]} votantes nas seções coletadas)`);
    for (const x of lista.filter(y => y.tipo === "nominal").slice(0, 8))
      linhasConsole.push(`    ${String(x.numero).padStart(5)}  ${(x.nome || "?").padEnd(28).slice(0, 28)} ${(x.partido || "").padEnd(14).slice(0, 14)} ${String(x.votos).padStart(8)}  ${validos ? (x.votos / validos * 100).toFixed(2) : "0.00"}%`);
  }

  const bairros = [["cargo", "bairro", "tipo_voto", "numero", "partido", "candidato", "votos", "percentual_validos_bairro"]];
  for (const [cargo, bs] of Object.entries(porBairro))
    for (const [bairro, b] of Object.entries(bs).sort((x, y) => x[0].localeCompare(y[0], "pt-BR")))
      for (const x of Object.values(b.itens).sort((p, q) => q.votos - p.votos))
        bairros.push([cargo, bairro, x.tipo, x.numero, x.partido, x.nome, x.votos, valido(x.tipo) && b.validos ? (x.votos / b.validos * 100).toFixed(2).replace(".", ",") : ""]);

  await writeFile(join(OUT, "secoes.csv"), csv(secoes));
  await writeFile(join(OUT, "votos.csv"), csv(votos));
  await writeFile(join(OUT, "resumo.csv"), csv(resumo));
  if (Object.keys(locais).length) await writeFile(join(OUT, "bairros.csv"), csv(bairros));

  // lista completa por cargo: candidatos com votos + os que ainda não receberam nenhum
  const ordem = [...CARGOS_UF.map(c => CARGOS[c]), ...Object.keys(soma).filter(c => !CARGOS_UF.some(x => CARGOS[x] === c))];
  const cargos = {};
  for (const cargo of ordem) {
    const cod = Number(Object.keys(CARGOS).find(c => CARGOS[c] === cargo));
    const N = cod ? await nomesDoCargo(cod) : null;
    const itens = { ...(soma[cargo] || {}) };
    for (const [n, x] of Object.entries(N?.cand || {})) itens[`nominal|${n}`] ??= { chave: `nominal|${n}`, tipo: "nominal", numero: n, partido: x.sg, nome: x.nm, votos: 0 };
    const l = Object.values(itens).sort((a, b) => b.votos - a.votos || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
    const tot = t => l.filter(x => x.tipo === t).reduce((s, x) => s + x.votos, 0);
    cargos[cargo] = { cargo, vagas: N?.vagas || 1, votantes: compar[cargo] || 0, validos: tot("nominal") + tot("legenda"), brancos: tot("branco"), nulos: tot("nulo"), itens: l };
  }
  detalhe = { cargos, geo, porLocal };

  const cargoPrincipal = ordem.find(c => soma[c]);
  painel = {
    uf: UF, ambiente: opt.ambiente || "oficial", atualizado: new Date().toISOString(),
    titulo: FILTRO_MUN && FILTRO_MUN.size === 1 ? nomesMun[[...FILTRO_MUN][0]] || null : null,
    total: listaSecoes.length, coletadas: secoes.length - 1, cargoPrincipal: cargoPrincipal || null, temMapa: Object.keys(locais).length > 0,
    cargos: Object.values(cargos).map(({ itens, ...c }) => ({ ...c, candidatos: itens.filter(x => x.tipo === "nominal").length, top: itens.filter(x => valido(x.tipo)).slice(0, 3) })),
    municipios: Object.keys(totalPorMun).map(cd => {
      const pm = porMun[cd] || { coletadas: 0, aptos: 0, votantes: 0, votos: {}, validos: {} };
      const vs = cargoPrincipal ? Object.entries(pm.votos[cargoPrincipal] || {}).sort((a, b) => b[1] - a[1]) : [];
      const val = cargoPrincipal ? pm.validos[cargoPrincipal] || 0 : 0;
      return { cd, nome: nomesMun[cd] || cd, total: totalPorMun[cd], coletadas: pm.coletadas, aptos: pm.aptos, votantes: pm.votantes,
        top: vs.slice(0, 3).map(([nome, v]) => ({ nome, votos: v, pct: val ? v / val * 100 : 0 })) };
    }),
    locais: Object.values(locais).map(l => ({ id: l.id, nome: l.nome, bairro: l.bairro, secoes: l.secoes, ...(porLocal[l.id] || { coletadas: 0, aptos: 0, votantes: 0 }) })),
    secoes: listaPainel,
  };
  return { nSecoes: secoes.length - 1, linhasConsole };
}

// votos de um candidato por local de votação e por bairro, para o mapa
function dadosMapa(cargo, chave) {
  const g = detalhe.geo[cargo] || {};
  const pontos = Object.values(locais).filter(l => l.lat != null).map(l => {
    const x = g[l.id], pl = detalhe.porLocal[l.id] || { coletadas: 0, votantes: 0 };
    return { id: l.id, nome: l.nome, endereco: l.endereco, bairro: l.bairro, lat: l.lat, lon: l.lon, secoes: l.secoes,
      coletadas: pl.coletadas, votantes: pl.votantes, validos: x?.validos || 0, votos: (chave && x?.votos[chave]) || 0 };
  });
  const bairros = {};
  for (const p of pontos) {
    const b = bairros[p.bairro] ??= { bairro: p.bairro, locais: 0, secoes: 0, coletadas: 0, votantes: 0, validos: 0, votos: 0 };
    b.locais++; for (const c of ["secoes", "coletadas", "votantes", "validos", "votos"]) b[c] += p[c];
  }
  return { cargo, chave, pontos, bairros: Object.values(bairros) };
}

// ---------------------------------------------------------------- execução
async function ciclo(lista) {
  const fila = [...lista].sort((a, b) => (b.da ? 1 : 0) - (a.da ? 1 : 0)); // seções com sinal de chegada primeiro
  const cont = { novo: 0, pendente: 0, ja: 0, aguardando: 0 };
  let i = 0, feitos = 0, novosDesdeResumo = 0;
  Object.assign(progresso, { fase: "coletando", feitos: 0, total: fila.length, proximoCiclo: null });
  async function trabalhador() {
    while (i < fila.length) {
      const s = fila[i++];
      const r = await coletarSecao(s);
      cont[r]++; feitos++; progresso.feitos = feitos; progresso.pausadoAte = pausaAte;
      if (r === "novo") { novosDesdeResumo++; process.stdout.write(`\r[${agora()}] BU novo: ${nomesMun[s.mun] || s.mun} zona ${s.zona} seção ${s.secao}                    \n`); }
      if (feitos % 50 === 0) {
        process.stdout.write(`\r[${agora()}] ${feitos}/${fila.length} seções verificadas...`);
        await salvarEstado();
        if (WEB && novosDesdeResumo) { novosDesdeResumo = 0; await gerarCSVs(lista); }
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, trabalhador));
  await salvarEstado();
  progresso.novosUltimoCiclo = cont.novo;
  return cont;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await carregarEstado();
  await carregarNomesMunicipios();
  console.log(`Coletor de BUs · ${UF.toUpperCase()} · ambiente ${opt.ambiente || "oficial"} · saída em ${OUT}`);

  lista = await listarSecoes(); let listaEm = Date.now();
  console.log(`${lista.length} seções no escopo (${new Set(lista.map(s => s.mun)).size} municípios/cidades).`);
  await carregarLocais(new Set(lista.map(s => s.mun)));
  const nLocais = Object.keys(locais).length;
  if (nLocais) console.log(`${nLocais} locais de votação com bairro e coordenadas (mapa ativado).`);
  else console.log("Sem dados/locais-<município>.json para este escopo: o painel não mostra mapa nem bairros.");
  await gerarCSVs(lista); // painel já abre com o que estava salvo
  if (WEB) iniciarServidor();

  while (true) {
    if (Date.now() - listaEm > 10 * 60_000) { try { lista = await listarSecoes(); listaEm = Date.now(); } catch (e) { console.warn(e.message); } }
    const t0 = Date.now();
    const c = await ciclo(lista);
    const { nSecoes, linhasConsole } = await gerarCSVs(lista);
    const tot = lista.length;
    progresso.ultimoCiclo = new Date().toISOString();
    console.log(`\n[${agora()}] Ciclo em ${((Date.now() - t0) / 1000).toFixed(0)}s · ${c.novo} BUs novos · ${nSecoes} de ${tot} seções coletadas (${(nSecoes / tot * 100).toFixed(1)}%) · ${c.pendente} ainda sem BU`);
    if (linhasConsole.length) console.log(linhasConsole.join("\n"));
    console.log(`CSVs atualizados em ${OUT} (secoes.csv, votos.csv, resumo.csv${nLocais ? ", bairros.csv" : ""})`);
    if (nSecoes >= tot) { progresso.fase = "concluido"; console.log("Todas as seções do escopo foram coletadas."); break; }
    if (!LOOP) { progresso.fase = "parado"; break; }
    progresso.fase = "aguardando";
    progresso.proximoCiclo = new Date(Date.now() + LOOP * 1000).toISOString();
    console.log(`Próximo ciclo em ${LOOP}s. Ctrl+C para parar (o progresso fica salvo).`);
    await sleep(LOOP * 1000);
  }
  if (WEB) console.log(`Painel continua no ar em http://localhost:${PORTA} (Ctrl+C para encerrar).`);
}
let lista = [];

// ---------------------------------------------------------------- painel web local
function iniciarServidor() {
  const tipos = { ".csv": "text/csv; charset=utf-8" };
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
    try {
      if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGINA); }
      if (url.pathname === "/api/painel") return json({ ...painel, progresso: { ...progresso, pausadoAte: pausaAte > Date.now() ? new Date(pausaAte).toISOString() : null } });
      if (url.pathname === "/api/cargo") {
        const c = detalhe.cargos[url.searchParams.get("c") || ""];
        return c ? json(c) : json({ erro: "Cargo não encontrado" }, 404);
      }
      if (url.pathname === "/api/mapa") return json(dadosMapa(url.searchParams.get("c") || "", url.searchParams.get("chave") || ""));
      if (url.pathname === "/api/secao") {
        const e = estado[url.searchParams.get("k") || ""];
        if (!e?.bu) return json({ erro: "Seção não encontrada" }, 404);
        const cargos = [];
        for (const ele of e.bu.eleicoes) for (const c of ele.cargos) {
          const N = await nomesDoCargo(c.cargo) || { cand: {}, part: {} };
          cargos.push({ cargo: CARGOS[c.cargo] || `Cargo ${c.cargo}`, aptos: ele.aptos, comparecimento: c.comparecimento,
            votos: c.votos.map(v => {
              const tipo = TIPO_VOTO[v.tipo] || `tipo ${v.tipo}`;
              if (v.tipo === 1 && v.id) { const n = v.id[v.id.length - 1], x = N.cand[n]; return { tipo, numero: n, nome: x?.nm || `Candidato ${n}`, partido: x?.sg || N.part[v.id[0]] || "", votos: v.qtd }; }
              if (v.tipo === 4 && v.id) return { tipo, numero: v.id[0], nome: "Legenda", partido: N.part[v.id[0]] || "", votos: v.qtd };
              return { tipo, numero: "", nome: tipo === "branco" ? "Brancos" : tipo === "nulo" ? "Nulos" : tipo, partido: "", votos: v.qtd };
            }).sort((a, b) => (a.tipo === "nominal" || a.tipo === "legenda" ? 0 : 1) - (b.tipo === "nominal" || b.tipo === "legenda" ? 0 : 1) || b.votos - a.votos) });
        }
        const [mun, zona, secao] = url.searchParams.get("k").split("-");
        const loc = locais[localDaSecao[url.searchParams.get("k")]];
        return json({ mun, nome: nomesMun[mun] || mun, zona, secao, local: loc ? { nome: loc.nome, endereco: loc.endereco, bairro: loc.bairro } : null, info: e.bu.info, hash: e.hash, arquivo: e.arquivo, recebido: e.recebido, agregadas: e.agregadas, cargos });
      }
      const arq = url.pathname.slice(1);
      if (["secoes.csv", "votos.csv", "resumo.csv", "bairros.csv"].includes(arq) && existsSync(join(OUT, arq))) {
        res.writeHead(200, { "content-type": tipos[".csv"], "content-disposition": `attachment; filename="${UF}-${arq}"` });
        return res.end(await readFile(join(OUT, arq)));
      }
      res.writeHead(404); res.end("Não encontrado");
    } catch (e) { json({ erro: String(e.message || e) }, 500); }
  });
  srv.on("error", e => {
    if (e.code === "EADDRINUSE") console.error(`A porta ${PORTA} já está em uso. Rode de novo com --porta 3001 (ou outra).`);
    else console.error(e.message);
    process.exit(1);
  });
  srv.listen(PORTA, () => console.log(`\nPainel no ar: abra http://localhost:${PORTA} no navegador\n`));
}

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apuração por bairro</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
<style>
:root{--bg:#f3f5f7;--surface:#fff;--line:#d9dee5;--fg:#16202b;--muted:#5b6876;--accent:#0b5e7a;--accent-soft:#e1eef3;--bar:#9fb4c2;--ok:#1d7a46;--ok-soft:#e2f2e8;--warn:#9a6200;--warn-soft:#fbf0dc;--heat:#c2410c;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f151b;--surface:#161e26;--line:#2a3541;--fg:#e5ebf0;--muted:#93a1ae;--accent:#5cb6d3;--accent-soft:#16303b;--bar:#3d5161;--ok:#5fcb8c;--ok-soft:#163323;--warn:#e2ac4f;--warn-soft:#352812;--heat:#fb923c;color-scheme:dark}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 var(--sans);padding:20px 16px 48px}
.wrap{max-width:1240px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font-size:1.7rem;font-weight:800;letter-spacing:-.01em}h2{margin:0;font-size:1.1rem}
.sub{color:var(--muted);font-size:.9rem;margin:2px 0 0}.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px}
.dl{display:flex;gap:8px;flex-wrap:wrap}.dl a{font-size:.82rem;font-weight:600;color:var(--accent);text-decoration:none;border:1px solid var(--line);background:var(--surface);padding:6px 10px;border-radius:8px}
.dl a:hover{border-color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.prog-top{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:.85rem;color:var(--muted)}
.big{font-family:var(--mono);font-size:1.8rem;font-weight:700;color:var(--fg)}
.track{height:10px;border-radius:5px;background:var(--accent-soft);overflow:hidden}.track div{height:100%;background:var(--accent);transition:width .5s}
.chip{display:inline-block;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
.chip.ok{background:var(--ok-soft);color:var(--ok)}.chip.warn{background:var(--warn-soft);color:var(--warn)}.chip.info{background:var(--accent-soft);color:var(--accent)}
.tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}
.tabs button{font:600 .9rem var(--sans);color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:7px 14px;cursor:pointer;white-space:nowrap}
.tabs button[aria-selected=true]{background:var(--accent);border-color:var(--accent);color:var(--surface)}
.tabs button small{font:500 .74rem var(--mono);opacity:.8;margin-left:6px}
.split{display:grid;grid-template-columns:minmax(0,390px) minmax(0,1fr);gap:16px;align-items:start}
.split.sem-mapa{grid-template-columns:minmax(0,1fr)}
@media (max-width:880px){.split{grid-template-columns:minmax(0,1fr)}}
.cands{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:560px;overflow-y:auto}
.cand{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:baseline;padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.cand:hover{background:var(--accent-soft)}.cand[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft)}
.cand:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.cand .nm{font-weight:600;font-size:.92rem}.cand .pt{color:var(--muted);font-weight:500;font-size:.8rem}
.cand .pc{font-family:var(--mono);font-weight:700;text-align:right}
.cand .meta{grid-column:1/-1;font-size:.78rem;color:var(--muted);font-family:var(--mono)}
.bar{grid-column:1/-1;height:6px;border-radius:3px;background:var(--bg);overflow:hidden}.bar div{height:100%;background:var(--bar)}
.cand[aria-pressed=true] .bar div{background:var(--accent)}
.extra{display:flex;gap:16px;flex-wrap:wrap;font-size:.82rem;color:var(--muted)}.extra b{color:var(--fg);font-family:var(--mono)}
.mais{font:600 .84rem var(--sans);color:var(--accent);background:none;border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer;align-self:flex-start}
input[type=search]{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;width:100%}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{font:600 .8rem var(--sans);background:var(--surface);color:var(--muted);border:0;padding:6px 10px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
#mapa{height:500px;border-radius:10px;border:1px solid var(--line);background:var(--bg)}
@media (max-width:880px){#mapa{height:380px}}
.legenda{display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--muted);flex-wrap:wrap}
.legenda .grad{width:160px;height:8px;border-radius:4px;background:linear-gradient(90deg,#fde68a,#f59e0b,#dc2626,#7f1d1d)}
.leaflet-container{font:13px/1.4 var(--sans)}
@media (prefers-color-scheme:dark){.leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9) saturate(.6)}}
.tip b{font-family:var(--mono)}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.86rem}
th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}td.n{font-family:var(--mono);text-align:right;white-space:nowrap}
tr.click{cursor:pointer}tr.click:hover td{background:var(--accent-soft)}tr.sel td{background:var(--accent-soft)}
.mini{display:flex;flex-direction:column;gap:2px;font-size:.8rem}.mini span{white-space:nowrap}
.mbar{display:inline-block;height:6px;border-radius:3px;background:var(--heat);vertical-align:middle;margin-right:6px}
.det{border-top:1px dashed var(--line);padding-top:12px}
.kv{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.84rem;color:var(--muted)}.kv b{color:var(--fg);font-family:var(--mono)}
.empty{color:var(--muted);font-size:.9rem;margin:0}
.secs{display:flex;flex-wrap:wrap;gap:6px}.secs button{font:600 .8rem var(--mono);border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:4px 8px;cursor:pointer}
.secs button:hover,.secs button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
button:focus-visible,input:focus-visible,tr:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hash{font-family:var(--mono);font-size:.74rem;color:var(--muted);overflow-wrap:anywhere}
.nota{font-size:.8rem;color:var(--muted);margin:0}
</style></head><body><div class="wrap">
<div class="top"><div><h1 id="titulo">Apuração</h1><p class="sub" id="sub">Carregando…</p></div>
<div class="dl" id="dl"><a href="/resumo.csv">resumo.csv</a><a href="/secoes.csv">secoes.csv</a><a href="/votos.csv">votos.csv</a></div></div>

<section class="card">
  <div class="prog-top"><span><span class="big" id="pct">0%</span> das seções com BU coletado</span><span id="estado"></span></div>
  <div class="track"><div id="barra" style="width:0"></div></div>
  <div class="prog-top"><span class="mono" id="contagem"></span><span id="atualizado"></span></div>
</section>

<section style="display:flex;flex-direction:column;gap:12px">
  <h2>Candidatos</h2>
  <div class="tabs" role="tablist" id="tabs" aria-label="Cargos"></div>
  <div class="split">
    <section class="card" id="ranking"></section>
    <section class="card" id="card-mapa">
      <div class="prog-top" style="align-items:center"><h2 id="h-mapa">Mapa</h2>
        <div class="seg" role="group" aria-label="Medida do mapa"><button type="button" data-m="votos" aria-pressed="true">Votos</button><button type="button" data-m="pct" aria-pressed="false">% dos válidos</button></div></div>
      <div id="mapa"></div>
      <div class="legenda"><span>menos</span><span class="grad"></span><span>mais</span><span id="leg-max" class="mono"></span></div>
      <p class="nota">Cada ponto é um local de votação (escola), no bairro cadastrado pelo TSE. O eleitor vota onde está inscrito, que nem sempre é o bairro onde mora.</p>
    </section>
  </div>
</section>

<section class="card" id="card-bairros">
  <div class="prog-top" style="align-items:center"><h2 id="h-bairros">Por bairro</h2><input type="search" id="busca-bairro" placeholder="Filtrar bairro…" aria-label="Filtrar bairros" style="width:min(100%,260px)"></div>
  <div class="tbl"><table><thead><tr><th>Bairro</th><th style="text-align:right">Locais</th><th style="text-align:right">Seções</th><th style="text-align:right">Votos</th><th style="text-align:right">% válidos</th><th></th></tr></thead><tbody id="bairros"></tbody></table></div>
</section>

<section class="card">
  <div class="prog-top" style="align-items:center"><h2 id="h-lista">Locais de votação</h2><input type="search" id="busca" placeholder="Filtrar por nome ou bairro…" aria-label="Filtrar" style="width:min(100%,300px)"></div>
  <div class="tbl"><table><thead id="thead-lista"></thead><tbody id="lista"></tbody></table></div>
  <div class="det" id="det" hidden></div>
</section>
<p class="sub">Dados lidos dos Boletins de Urna publicados pelo TSE. Esta página atualiza sozinha a cada 5 segundos.</p>
</div>
<script>
const fmt = n => Number(n || 0).toLocaleString("pt-BR");
const pct = n => (n || 0).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + "%";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tc = s => String(s || "").toLowerCase().replace(/(^|[\s\-'(.])(\p{L})/gu, (m,a,b) => a + b.toUpperCase());
const SIGLAS = /^(EE|EMEF|EMEI|ETEC|FATEC|SESI|SENAI|SENAC|UNIP|UNESP|UNISALESIANO|CEU|CEI|APAE|CIEP|ETE|EEPG|EEPSG|II|III)$/;
const tcLocal = s => String(s || "").split(" ").map(w => SIGLAS.test(w.replace(/[^\p{L}]/gu, "")) ? w : tc(w)).join(" ");
const curto = c => c.replace("Deputado ", "Dep. ");
const valido = t => t === "nominal" || t === "legenda";
const rotulo = x => x.tipo === "legenda" ? "Legenda " + (x.partido || x.numero) : x.tipo === "branco" ? "Brancos" : x.tipo === "nulo" ? "Nulos" : (x.nome || "Candidato " + x.numero);
let dados = null, versao = null, cargoSel = null, chaveSel = null, cargoDados = null, mapaDados = null, medida = "votos", limite = 25;
let selSel = null, secSel = null; // item aberto na lista de locais/municípios e seção aberta

function renderTopo(d){
  const p = d.progresso || {};
  const lugar = d.titulo ? tc(d.titulo) : d.uf === "zz" ? "Exterior" : d.uf.toUpperCase();
  document.getElementById("titulo").textContent = lugar + " · Eleições 2026";
  document.title = "Apuração · " + lugar;
  document.getElementById("sub").textContent = "1º turno · votos dos Boletins de Urna · ambiente " + d.ambiente;
  const fr = d.total ? d.coletadas / d.total * 100 : 0;
  document.getElementById("pct").textContent = fr.toFixed(1).replace(".", ",") + "%";
  document.getElementById("barra").style.width = fr + "%";
  document.getElementById("contagem").textContent = fmt(d.coletadas) + " de " + fmt(d.total) + " seções";
  let st = "";
  if (p.pausadoAte) st = '<span class="chip warn">Pausado por limite do TSE até ' + new Date(p.pausadoAte).toLocaleTimeString("pt-BR") + "</span>";
  else if (p.fase === "coletando") st = '<span class="chip info">Verificando ' + fmt(p.feitos) + " de " + fmt(p.total) + "</span>";
  else if (p.fase === "aguardando" && p.proximoCiclo) st = '<span class="chip info">Próxima verificação às ' + new Date(p.proximoCiclo).toLocaleTimeString("pt-BR") + "</span>";
  else if (p.fase === "concluido") st = '<span class="chip ok">Todas as seções coletadas</span>';
  else if (p.fase === "parado") st = '<span class="chip warn">Coleta parada (rode com --loop para continuar)</span>';
  document.getElementById("estado").innerHTML = st;
  document.getElementById("atualizado").textContent = "Dados de " + new Date(d.atualizado).toLocaleTimeString("pt-BR");
  const dl = document.getElementById("dl");
  if (d.temMapa && !dl.querySelector('[href="/bairros.csv"]')) dl.insertAdjacentHTML("beforeend", '<a href="/bairros.csv">bairros.csv</a>');
  document.getElementById("card-mapa").hidden = !d.temMapa;
  document.getElementById("card-bairros").hidden = !d.temMapa;
  document.querySelector(".split").classList.toggle("sem-mapa", !d.temMapa);
  document.getElementById("busca").placeholder = d.temMapa ? "Filtrar por nome ou bairro…" : "Filtrar por nome…";
}

// ---------------------------------------------------------------- cargos e candidatos
function renderTabs(d){
  if (!cargoSel || !d.cargos.some(c => c.cargo === cargoSel)) cargoSel = (d.cargos[0] || {}).cargo || null;
  document.getElementById("tabs").innerHTML = d.cargos.map(c => '<button type="button" role="tab" data-c="' + esc(c.cargo) + '" aria-selected="' + (c.cargo === cargoSel) + '">' +
    esc(curto(c.cargo)) + "<small>" + fmt(c.candidatos) + "</small></button>").join("");
}

function renderRanking(){
  const el = document.getElementById("ranking");
  const c = cargoDados;
  if (!c){ el.innerHTML = '<p class="empty">Carregando candidatos…</p>'; return; }
  const q = (document.getElementById("busca-cand") || {}).value || "";
  const qn = q.trim().toLowerCase();
  const itens = c.itens.filter(x => valido(x.tipo)).filter(x => !qn || rotulo(x).toLowerCase().includes(qn) || String(x.numero).startsWith(qn) || String(x.partido).toLowerCase().includes(qn));
  const max = Math.max(1, ...itens.map(x => x.votos));
  const vis = itens.slice(0, limite);
  const rolagem = (el.querySelector(".cands") || {}).scrollTop || 0; // não volta ao topo quando os dados atualizam
  const vagas = c.vagas > 1 ? '<p class="nota">' + c.vagas + " vagas: cada eleitor vota em até " + c.vagas + " candidatos, então os votos válidos passam do número de votantes.</p>" : "";
  el.innerHTML = '<div class="prog-top"><h2>' + esc(c.cargo) + '</h2><span class="mono">' + fmt(c.votantes) + " votantes</span></div>" +
    '<div class="extra"><span>Válidos <b>' + fmt(c.validos) + "</b></span><span>Brancos <b>" + fmt(c.brancos) + "</b></span><span>Nulos <b>" + fmt(c.nulos) + "</b></span></div>" + vagas +
    '<input type="search" id="busca-cand" placeholder="Buscar nome, número ou partido…" aria-label="Buscar candidato" value="' + esc(q) + '">' +
    '<ol class="cands">' + (vis.map(x => '<li><button type="button" class="cand" data-chave="' + esc(x.chave) + '" aria-pressed="' + (x.chave === chaveSel) + '"><span class="nm">' + esc(rotulo(x)) +
      ' <span class="pt">' + esc(x.tipo === "legenda" ? x.numero : (x.partido || "") + " · " + x.numero) + '</span></span><span class="pc">' + (c.validos ? pct(x.votos / c.validos * 100) : "–") +
      '</span><span class="bar"><div style="width:' + (x.votos / max * 100) + '%"></div></span><span class="meta">' + fmt(x.votos) + " votos</span></button></li>").join("") ||
      '<li class="empty">Nenhum candidato encontrado.</li>') + "</ol>" +
    (itens.length > limite ? '<button type="button" class="mais" id="mais">Mostrar mais (' + fmt(itens.length - limite) + " restantes)</button>" : "") +
    (dados && dados.temMapa ? '<p class="nota">Clique num candidato para ver no mapa onde ele teve mais votos.</p>' : "");
  el.querySelector(".cands").scrollTop = rolagem;
  const inp = document.getElementById("busca-cand");
  if (q){ inp.focus(); inp.setSelectionRange(q.length, q.length); }
}

async function carregarCargo(){
  if (!cargoSel) return;
  try{
    const r = await fetch("/api/cargo?c=" + encodeURIComponent(cargoSel), {cache: "no-store"}); cargoDados = await r.json();
    if (cargoDados.erro){ cargoDados = null; return; }
    if (!chaveSel || !cargoDados.itens.some(x => x.chave === chaveSel)) chaveSel = (cargoDados.itens.find(x => valido(x.tipo)) || {}).chave || null;
    renderRanking(); await carregarMapa();
  }catch(e){}
}

// ---------------------------------------------------------------- mapa
let mapa = null, camadaCalor = null, camadaPontos = null, enquadrado = false;
function tiles(){
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'});
}
function iniciarMapa(){
  if (mapa || !window.L) return !!mapa;
  mapa = L.map("mapa", {scrollWheelZoom: false}); tiles().addTo(mapa);
  mapa.on("focus", () => mapa.scrollWheelZoom.enable()); mapa.on("blur", () => mapa.scrollWheelZoom.disable());
  return true;
}
const GRAD = [[0, [253, 230, 138]], [.33, [245, 158, 11]], [.66, [220, 38, 38]], [1, [127, 29, 29]]];
function corGrad(t){
  let i = 1; while (i < GRAD.length - 1 && t > GRAD[i][0]) i++;
  const [t0, a] = GRAD[i - 1], [t1, b] = GRAD[i], k = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return "rgb(" + a.map((x, j) => Math.round(x + (b[j] - x) * k)).join(",") + ")";
}
const valor = p => medida === "pct" ? (p.validos ? p.votos / p.validos * 100 : 0) : p.votos;
const txtValor = v => medida === "pct" ? pct(v) : fmt(v) + " votos";

async function carregarMapa(){
  if (!dados || !dados.temMapa || !cargoSel) return;
  try{
    const r = await fetch("/api/mapa?c=" + encodeURIComponent(cargoSel) + "&chave=" + encodeURIComponent(chaveSel || ""), {cache: "no-store"});
    mapaDados = await r.json(); renderMapa(); renderBairros();
  }catch(e){}
}

function renderMapa(){
  const item = cargoDados && cargoDados.itens.find(x => x.chave === chaveSel);
  document.getElementById("h-mapa").textContent = item && cargoDados.validos ? "Onde " + tc(rotulo(item)) + " teve mais votos" : "Locais de votação · aguardando BUs";
  if (!iniciarMapa()){ document.getElementById("mapa").innerHTML = '<p class="empty" style="padding:16px">Não consegui carregar o mapa (Leaflet). É preciso internet para os blocos do mapa.</p>'; return; }
  const pts = mapaDados.pontos;
  if (!enquadrado && pts.length){
    // enquadra a área urbana: ignora locais a mais de 6 km da mediana (distritos rurais), que seguem no mapa
    const med = k => pts.map(p => p[k]).sort((x, y) => x - y)[pts.length >> 1];
    const c = L.latLng(med("lat"), med("lon")), perto = pts.filter(p => c.distanceTo([p.lat, p.lon]) < 6000);
    mapa.fitBounds(L.latLngBounds((perto.length ? perto : pts).map(p => [p.lat, p.lon])), {padding: [24, 24]}); enquadrado = true;
  }
  if (camadaCalor){ mapa.removeLayer(camadaCalor); camadaCalor = null; }
  if (camadaPontos) mapa.removeLayer(camadaPontos);
  const comBU = pts.filter(p => p.coletadas > 0);
  // cor de cada ponto: do local de menor ao de maior valor
  const max = Math.max(0, ...comBU.map(valor)), min = comBU.length > 1 ? Math.min(...comBU.map(valor)) : 0;
  const esc01 = v => max > min ? (v - min) / (max - min) : max ? 1 : 0;
  document.getElementById("leg-max").textContent = max ? "mín. " + txtValor(min) + " · máx. " + txtValor(max) : "";
  // o calor soma pontos vizinhos: faz sentido para votos (regiões com mais votos), não para percentuais,
  // em que várias escolas próximas com % médio pareceriam mais fortes que uma escola com % alto
  if (medida === "votos" && max) camadaCalor = L.heatLayer(comBU.map(p => [p.lat, p.lon, valor(p) / max]), {radius: 30, blur: 24, maxZoom: 13, max: 1.5, minOpacity: .15,
    gradient: {0.2: "#fde68a", 0.45: "#f59e0b", 0.7: "#dc2626", 1: "#7f1d1d"}}).addTo(mapa);
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted");
  const ordem = [...pts].sort((a, b) => (a.coletadas > 0) - (b.coletadas > 0) || valor(a) - valor(b)); // mais fortes por cima
  camadaPontos = L.layerGroup(ordem.map(p => {
    const tem = p.coletadas > 0, f = tem && max ? esc01(valor(p)) : 0;
    const m = L.circleMarker([p.lat, p.lon], tem
      ? {radius: medida === "votos" ? 4 + 8 * Math.sqrt(f) : 8, weight: 1, color: "#3b0a0a", opacity: .6, fillColor: corGrad(f), fillOpacity: medida === "votos" ? .75 : .95}
      : {radius: 4, weight: 1.5, color: muted, fillOpacity: 0});
    m.bindTooltip('<div class="tip"><strong>' + esc(tcLocal(p.nome)) + "</strong><br>" + esc(tc(p.bairro)) + "<br>" +
      (tem ? "<b>" + fmt(p.votos) + "</b> votos · <b>" + (p.validos ? pct(p.votos / p.validos * 100) : "–") + "</b> dos válidos<br>" : "Sem BU coletado ainda<br>") +
      "Seções com BU: " + p.coletadas + "/" + p.secoes + "</div>");
    return m;
  })).addTo(mapa);
}

function renderBairros(){
  if (!mapaDados) return;
  const item = cargoDados && cargoDados.itens.find(x => x.chave === chaveSel);
  document.getElementById("h-bairros").textContent = "Por bairro" + (item ? " · " + tc(rotulo(item)) : "");
  const q = document.getElementById("busca-bairro").value.trim().toLowerCase();
  const bs = mapaDados.bairros.filter(b => !q || b.bairro.toLowerCase().includes(q))
    .sort((a, b) => valor(b) - valor(a) || b.coletadas - a.coletadas || a.bairro.localeCompare(b.bairro, "pt-BR"));
  const max = Math.max(1e-9, ...bs.map(valor));
  document.getElementById("bairros").innerHTML = bs.map(b => '<tr class="click" tabindex="0" data-bairro="' + esc(b.bairro) + '"><td>' + esc(tc(b.bairro)) + '</td><td class="n">' + b.locais +
    '</td><td class="n">' + b.coletadas + "/" + b.secoes + '</td><td class="n">' + (b.coletadas ? fmt(b.votos) : "–") + '</td><td class="n">' + (b.validos ? pct(b.votos / b.validos * 100) : "–") +
    '</td><td style="width:22%"><i class="mbar" style="width:' + (b.coletadas ? Math.max(2, valor(b) / max * 100) : 0) + '%"></i></td></tr>').join("") ||
    '<tr><td colspan="6" class="empty">Nenhum bairro para o filtro.</td></tr>';
}
function focarBairro(nome){
  if (!mapa || !mapaDados) return;
  const pts = mapaDados.pontos.filter(p => p.bairro === nome);
  if (!pts.length) return;
  mapa.flyToBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])), {padding: [60, 60], maxZoom: 15});
  document.getElementById("card-mapa").scrollIntoView({behavior: "smooth", block: "nearest"});
}

// ---------------------------------------------------------------- locais de votação (ou municípios) e BUs
function renderLista(d){
  const q = document.getElementById("busca").value.trim().toLowerCase();
  const porLocal = d.temMapa;
  document.getElementById("h-lista").textContent = porLocal ? "Locais de votação" : d.uf === "zz" ? "Por cidade no exterior" : "Por município";
  document.getElementById("thead-lista").innerHTML = porLocal
    ? '<tr><th>Local</th><th>Bairro</th><th style="text-align:right">Seções</th><th style="text-align:right">Votantes</th><th style="text-align:right">Comparec.</th></tr>'
    : '<tr><th>Município / cidade</th><th style="text-align:right">Seções</th><th style="text-align:right">Votantes</th><th style="text-align:right">Comparec.</th><th>Mais votados' + (d.cargoPrincipal ? " · " + esc(d.cargoPrincipal) : "") + "</th></tr>";
  let html;
  if (porLocal){
    const ls = d.locais.filter(l => !q || l.nome.toLowerCase().includes(q) || l.bairro.toLowerCase().includes(q))
      .sort((a, b) => a.bairro.localeCompare(b.bairro, "pt-BR") || a.nome.localeCompare(b.nome, "pt-BR"));
    html = ls.map(l => '<tr class="click' + (l.id === selSel ? " sel" : "") + '" tabindex="0" data-sel="' + l.id + '"><td>' + esc(tcLocal(l.nome)) + "</td><td>" + esc(tc(l.bairro)) +
      '</td><td class="n">' + l.coletadas + "/" + l.secoes + '</td><td class="n">' + fmt(l.votantes) + '</td><td class="n">' + (l.aptos ? pct(l.votantes / l.aptos * 100) : "–") + "</td></tr>").join("");
  } else {
    const ms = d.municipios.filter(m => !q || m.nome.toLowerCase().includes(q))
      .sort((a, b) => b.coletadas - a.coletadas || b.votantes - a.votantes || a.nome.localeCompare(b.nome, "pt-BR"));
    html = ms.map(m => '<tr class="click' + (m.cd === selSel ? " sel" : "") + '" tabindex="0" data-sel="' + m.cd + '"><td>' + esc(tc(m.nome)) +
      '</td><td class="n">' + m.coletadas + "/" + m.total + '</td><td class="n">' + fmt(m.votantes) + '</td><td class="n">' + (m.aptos ? pct(m.votantes / m.aptos * 100) : "–") +
      '</td><td><div class="mini">' + (m.top.length ? m.top.map(t => '<span><i class="mbar" style="width:' + Math.max(2, t.pct * .6) + 'px"></i>' + esc(t.nome) + ' <b class="mono">' + pct(t.pct) + "</b></span>").join("") : '<span class="empty">sem BU ainda</span>') +
      "</div></td></tr>").join("");
  }
  document.getElementById("lista").innerHTML = html || '<tr><td colspan="5" class="empty">Nenhum resultado para o filtro.</td></tr>';
}

const secoesDoSel = () => dados.secoes.filter(s => dados.temMapa ? s.local === selSel : s.mun === selSel);
function renderDet(){
  const el = document.getElementById("det");
  if (!selSel || !dados){ el.hidden = true; return; }
  const nome = dados.temMapa ? ((dados.locais.find(x => x.id === selSel) || {}).nome || "") : ((dados.municipios.find(x => x.cd === selSel) || {}).nome || selSel);
  const secs = secoesDoSel().sort((a, b) => a.zona.localeCompare(b.zona) || a.secao.localeCompare(b.secao));
  el.hidden = false;
  el.innerHTML = "<h2>" + esc(dados.temMapa ? tcLocal(nome) : tc(nome)) + '</h2><p class="sub">' + (secs.length ? "Clique numa seção para ver o BU." : "Nenhuma seção com BU coletado ainda.") +
    '</p><div class="secs">' + secs.map(s => '<button type="button" data-k="' + s.k + '" aria-pressed="' + (s.k === secSel) + '">Z' + Number(s.zona) + " · S" + Number(s.secao) + "</button>").join("") +
    '</div><div id="bu"></div>';
  if (secSel) carregarSecao(secSel);
}

async function carregarSecao(k){
  const el = document.getElementById("bu"); if (!el) return;
  try{
    const r = await fetch("/api/secao?k=" + encodeURIComponent(k)); const s = await r.json();
    if (s.erro){ el.innerHTML = '<p class="empty">' + esc(s.erro) + "</p>"; return; }
    const dhf = x => x && x.length >= 13 ? x.slice(6,8) + "/" + x.slice(4,6) + " " + x.slice(9,11) + ":" + x.slice(11,13) : "–";
    const c0 = s.cargos[0] || {};
    el.innerHTML = '<div class="card" style="margin-top:12px"><div class="prog-top"><h2>Seção ' + Number(s.secao) + " · Zona " + Number(s.zona) + "</h2>" +
      (s.agregadas ? '<span class="chip info">Agrega seções ' + esc(s.agregadas.replace(/\|/g, ", ")) + "</span>" : "") + "</div>" +
      (s.local ? '<p class="sub">' + esc(tcLocal(s.local.nome)) + " · " + esc(tc(s.local.endereco)) + " · " + esc(tc(s.local.bairro)) + "</p>" : "") +
      '<div class="kv"><span>Aptos <b>' + fmt(c0.aptos) + "</b></span><span>Votantes <b>" + fmt(c0.comparecimento) + "</b></span><span>Abertura <b>" + dhf(s.info.abertura) +
      "</b></span><span>Encerramento <b>" + dhf(s.info.encerramento) + "</b></span><span>BU emitido <b>" + dhf(s.info.emissao) + "</b></span><span>Recebido no TSE <b>" + esc(s.recebido || "–") + "</b></span></div>" +
      s.cargos.map(c => '<div class="tbl"><table><thead><tr><th colspan="3">' + esc(c.cargo) + " · " + fmt(c.comparecimento) + " votantes</th></tr></thead><tbody>" +
        c.votos.map(v => "<tr><td class=\"n\" style=\"width:1%\">" + esc(v.numero) + "</td><td>" + esc(v.nome) + (v.partido ? ' <span class="pt" style="color:var(--muted)">' + esc(v.partido) + "</span>" : "") +
          '</td><td class="n">' + fmt(v.votos) + "</td></tr>").join("") + "</tbody></table></div>").join("") +
      '<p class="hash">' + esc(s.arquivo) + " · hash " + esc(s.hash) + "</p></div>";
  }catch(e){ el.innerHTML = '<p class="empty">Não consegui carregar a seção. O coletor ainda está rodando?</p>'; }
}

// ---------------------------------------------------------------- atualização e eventos
async function atualizar(){
  try{
    const r = await fetch("/api/painel", {cache: "no-store"}); dados = await r.json();
    if (!dados || !dados.cargos) return;
    renderTopo(dados); renderLista(dados);
    if (dados.atualizado !== versao){
      const primeira = versao === null; versao = dados.atualizado;
      renderTabs(dados); await carregarCargo();
      if (!primeira && selSel && !document.getElementById("det").hidden && secoesDoSel().length !== document.querySelectorAll("#det .secs button").length) renderDet();
    }
  }catch(e){ document.getElementById("sub").textContent = "Sem conexão com o coletor. Ele ainda está rodando no terminal?"; }
}
document.getElementById("tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-c]"); if (!b || b.dataset.c === cargoSel) return;
  cargoSel = b.dataset.c; chaveSel = null; cargoDados = null; limite = 25;
  document.querySelectorAll("#tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  renderRanking(); carregarCargo();
});
document.getElementById("ranking").addEventListener("click", e => {
  if (e.target.id === "mais"){ limite += 50; renderRanking(); return; }
  const b = e.target.closest("button[data-chave]"); if (!b) return;
  chaveSel = b.dataset.chave;
  document.querySelectorAll("#ranking .cand").forEach(x => x.setAttribute("aria-pressed", x === b));
  carregarMapa();
});
document.getElementById("ranking").addEventListener("input", e => { if (e.target.id === "busca-cand"){ limite = 25; renderRanking(); } });
document.querySelector(".seg").addEventListener("click", e => {
  const b = e.target.closest("button[data-m]"); if (!b) return;
  medida = b.dataset.m;
  document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", x === b));
  if (mapaDados){ renderMapa(); renderBairros(); }
});
document.getElementById("busca-bairro").addEventListener("input", renderBairros);
const tbB = document.getElementById("bairros");
tbB.addEventListener("click", e => { const tr = e.target.closest("tr[data-bairro]"); if (tr) focarBairro(tr.dataset.bairro); });
tbB.addEventListener("keydown", e => { if (e.key === "Enter"){ const tr = e.target.closest("tr[data-bairro]"); if (tr) focarBairro(tr.dataset.bairro); } });
document.getElementById("busca").addEventListener("input", () => dados && renderLista(dados));
function abrir(id){ selSel = selSel === id ? null : id; secSel = null; renderLista(dados); renderDet(); }
const tbL = document.getElementById("lista");
tbL.addEventListener("click", e => { const tr = e.target.closest("tr[data-sel]"); if (tr) abrir(tr.dataset.sel); });
tbL.addEventListener("keydown", e => { if (e.key === "Enter"){ const tr = e.target.closest("tr[data-sel]"); if (tr) abrir(tr.dataset.sel); } });
document.getElementById("det").addEventListener("click", e => {
  const b = e.target.closest("button[data-k]"); if (!b) return;
  secSel = b.dataset.k;
  document.querySelectorAll("#det .secs button").forEach(x => x.setAttribute("aria-pressed", x === b));
  carregarSecao(secSel);
});
atualizar(); setInterval(atualizar, 5000);
</script></body></html>`;

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("coletar-bus.mjs")) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
