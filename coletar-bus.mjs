#!/usr/bin/env node
// Coletor de Boletins de Urna (BU) das Eleições 2026 - 1º turno
// Lê os arquivos públicos do TSE (resultados.tse.jus.br), baixa os BUs que já foram
// publicados, decodifica (ASN.1/DER) e gera CSVs por seção, por voto e um resumo.
//
// Uso:  node coletar-bus.mjs --uf zz --web               (exterior, com painel em http://localhost:3000)
//       node coletar-bus.mjs --uf zz                     (todas as seções do exterior, uma passada, só CSV)
//       node coletar-bus.mjs --uf sp --mun 61557 --loop 120   (Araçatuba, repetindo a cada 2 min)
//       node coletar-bus.mjs --help
//
// Requer Node 18+ e nenhuma dependência.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

  --uf <sigla>          UF a coletar (ex.: sp, rj, zz para exterior). Obrigatório.
  --mun <códigos>       Códigos TSE de município/cidade separados por vírgula (ex.: 61557).
  --zona <zonas>        Zonas separadas por vírgula (ex.: 11,299).
  --loop <segundos>     Repete a coleta a cada N segundos (mínimo 60). Sem isso, faz uma passada.
  --concorrencia <n>    Requisições simultâneas (padrão 3, máximo 8).
  --reintentar <min>    Minutos até tentar de novo uma seção que ainda não publicou (padrão 15).
  --out <pasta>         Pasta de saída (padrão ./saida-bu).
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
if (opt.help || !opt.uf) { console.log(AJUDA); process.exit(opt.help ? 0 : 1); }

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
const OUT = opt.out || "./saida-bu";
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
  return (nomesCand[cargo] = { cand, part });
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
const progresso = { fase: "iniciando", feitos: 0, total: 0, proximoCiclo: null, ultimoCiclo: null, novosUltimoCiclo: 0, pausadoAte: 0 };

async function gerarCSVs(listaSecoes = []) {
  const totalPorMun = {};
  for (const s of listaSecoes) totalPorMun[s.mun] = (totalPorMun[s.mun] || 0) + 1;
  const porMun = {};      // mun -> {coletadas, aptos, votantes, votos: {cargo: {nome: qtd}}, validos: {cargo: n}}
  const listaPainel = []; // seções coletadas, para a tabela do painel
  const secoes = [["uf", "cod_municipio", "municipio", "zona", "secao", "secoes_agregadas", "local", "aptos", "comparecimento", "abstencao", "abertura", "encerramento", "emissao_bu", "recebido_tse", "situacao", "arquivo_bu", "hash"]];
  const votos = [["uf", "cod_municipio", "municipio", "zona", "secao", "cargo", "tipo_voto", "numero", "partido", "candidato", "votos"]];
  const soma = {}; // cargo -> chave -> {numero, partido, nome, tipo, votos}
  const compar = {};

  for (const [k, e] of Object.entries(estado)) {
    if (!e.bu) continue;
    const [mun, zona, secao] = k.split("-");
    const munNome = nomesMun[mun] || "";
    const cargos = e.bu.eleicoes.flatMap(x => x.cargos.map(c => ({ ...c, aptos: x.aptos })));
    const aptos = cargos[0]?.aptos ?? "", comp = cargos[0]?.comparecimento ?? "";
    secoes.push([UF, mun, munNome, zona, secao, e.agregadas || "", e.bu.info.local, aptos, comp, aptos !== "" && comp !== "" ? aptos - comp : "",
      dh(e.bu.info.abertura), dh(e.bu.info.encerramento), dh(e.bu.info.emissao), e.recebido || "", e.st, e.arquivo, e.hash]);
    const pm = porMun[mun] ??= { coletadas: 0, aptos: 0, votantes: 0, votos: {}, validos: {} };
    pm.coletadas++; pm.aptos += Number(aptos) || 0; pm.votantes += Number(comp) || 0;
    listaPainel.push({ k, mun, nome: munNome, zona, secao, aptos, comp, emissao: dh(e.bu.info.emissao), recebido: e.recebido || "" });
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
        votos.push([UF, mun, munNome, zona, secao, cargoNome, tipo, numero, partido, nome, v.qtd]);
        const chave = `${tipo}|${numero}`;
        (soma[cargoNome] ??= {})[chave] ??= { tipo, numero, partido, nome, votos: 0 };
        soma[cargoNome][chave].votos += v.qtd;
        if (v.tipo === 1 || v.tipo === 4) {
          const rot = v.tipo === 1 ? (nome || `Candidato ${numero}`) : `Legenda ${partido || numero}`;
          (pm.votos[cargoNome] ??= {})[rot] = (pm.votos[cargoNome][rot] || 0) + v.qtd;
          pm.validos[cargoNome] = (pm.validos[cargoNome] || 0) + v.qtd;
        }
      }
    }
  }

  const resumo = [["cargo", "tipo_voto", "numero", "partido", "candidato", "votos", "percentual_validos"]];
  const linhasConsole = [];
  for (const [cargo, itens] of Object.entries(soma)) {
    const lista = Object.values(itens).sort((a, b) => b.votos - a.votos);
    const validos = lista.filter(x => x.tipo === "nominal" || x.tipo === "legenda").reduce((s, x) => s + x.votos, 0);
    for (const x of lista) {
      const pct = (x.tipo === "nominal" || x.tipo === "legenda") && validos ? (x.votos / validos * 100).toFixed(2).replace(".", ",") : "";
      resumo.push([cargo, x.tipo, x.numero, x.partido, x.nome, x.votos, pct]);
    }
    linhasConsole.push(`  ${cargo} (${compar[cargo]} votantes nas seções coletadas)`);
    for (const x of lista.filter(y => y.tipo === "nominal").slice(0, 8))
      linhasConsole.push(`    ${String(x.numero).padStart(5)}  ${(x.nome || "?").padEnd(28).slice(0, 28)} ${(x.partido || "").padEnd(14).slice(0, 14)} ${String(x.votos).padStart(8)}  ${validos ? (x.votos / validos * 100).toFixed(2) : "0.00"}%`);
  }

  await writeFile(join(OUT, "secoes.csv"), csv(secoes));
  await writeFile(join(OUT, "votos.csv"), csv(votos));
  await writeFile(join(OUT, "resumo.csv"), csv(resumo));

  const cargoPrincipal = Object.keys(soma).sort((a, b) => Object.values(CARGOS).indexOf(a) - Object.values(CARGOS).indexOf(b))[0];
  painel = {
    uf: UF, ambiente: opt.ambiente || "oficial", atualizado: new Date().toISOString(),
    total: listaSecoes.length, coletadas: secoes.length - 1, cargoPrincipal: cargoPrincipal || null,
    cargos: Object.entries(soma).map(([cargo, itens]) => {
      const l = Object.values(itens).sort((a, b) => b.votos - a.votos);
      const validos = l.filter(x => x.tipo === "nominal" || x.tipo === "legenda").reduce((s, x) => s + x.votos, 0);
      return { cargo, votantes: compar[cargo], validos, itens: l };
    }),
    municipios: Object.keys(totalPorMun).map(cd => {
      const pm = porMun[cd] || { coletadas: 0, aptos: 0, votantes: 0, votos: {}, validos: {} };
      const vs = cargoPrincipal ? Object.entries(pm.votos[cargoPrincipal] || {}).sort((a, b) => b[1] - a[1]) : [];
      const val = cargoPrincipal ? pm.validos[cargoPrincipal] || 0 : 0;
      return { cd, nome: nomesMun[cd] || cd, total: totalPorMun[cd], coletadas: pm.coletadas, aptos: pm.aptos, votantes: pm.votantes,
        top: vs.slice(0, 3).map(([nome, v]) => ({ nome, votos: v, pct: val ? v / val * 100 : 0 })) };
    }),
    secoes: listaPainel,
  };
  return { nSecoes: secoes.length - 1, linhasConsole };
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
    console.log(`CSVs atualizados em ${OUT} (secoes.csv, votos.csv, resumo.csv)`);
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
        return json({ mun, nome: nomesMun[mun] || mun, zona, secao, info: e.bu.info, hash: e.hash, arquivo: e.arquivo, recebido: e.recebido, agregadas: e.agregadas, cargos });
      }
      const arq = url.pathname.slice(1);
      if (["secoes.csv", "votos.csv", "resumo.csv"].includes(arq) && existsSync(join(OUT, arq))) {
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
<title>Coletor de BUs</title>
<style>
:root{--bg:#f3f5f7;--surface:#fff;--line:#d9dee5;--fg:#16202b;--muted:#5b6876;--accent:#0b5e7a;--accent-soft:#e1eef3;--bar:#9fb4c2;--ok:#1d7a46;--ok-soft:#e2f2e8;--warn:#9a6200;--warn-soft:#fbf0dc;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f151b;--surface:#161e26;--line:#2a3541;--fg:#e5ebf0;--muted:#93a1ae;--accent:#5cb6d3;--accent-soft:#16303b;--bar:#3d5161;--ok:#5fcb8c;--ok-soft:#163323;--warn:#e2ac4f;--warn-soft:#352812;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 var(--sans);padding:20px 16px 48px}
.wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:16px;align-items:start}
.cands{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.cand{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:baseline}
.cand .nm{font-weight:600;font-size:.92rem}.cand .pt{color:var(--muted);font-weight:500;font-size:.8rem}
.cand .pc{font-family:var(--mono);font-weight:700;text-align:right}
.cand .meta{grid-column:1/-1;font-size:.78rem;color:var(--muted);font-family:var(--mono)}
.bar{grid-column:1/-1;height:6px;border-radius:3px;background:var(--bg);overflow:hidden}.bar div{height:100%;background:var(--bar)}
.cand:first-child .bar div{background:var(--accent)}
.extra{display:flex;gap:16px;flex-wrap:wrap;font-size:.82rem;color:var(--muted);border-top:1px solid var(--line);padding-top:8px}.extra b{color:var(--fg);font-family:var(--mono)}
input[type=search]{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;width:min(100%,320px)}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.86rem}
th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}td.n{font-family:var(--mono);text-align:right;white-space:nowrap}
tr.click{cursor:pointer}tr.click:hover td{background:var(--accent-soft)}tr.sel td{background:var(--accent-soft)}
.mini{display:flex;flex-direction:column;gap:2px;font-size:.8rem}.mini span{white-space:nowrap}
.mbar{display:inline-block;height:6px;border-radius:3px;background:var(--accent);vertical-align:middle;margin-right:6px}
.det{border-top:1px dashed var(--line);padding-top:12px}
.kv{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.84rem;color:var(--muted)}.kv b{color:var(--fg);font-family:var(--mono)}
.empty{color:var(--muted);font-size:.9rem}
.secs{display:flex;flex-wrap:wrap;gap:6px}.secs button{font:600 .8rem var(--mono);border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:4px 8px;cursor:pointer}
.secs button:hover,.secs button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
button:focus-visible,input:focus-visible,tr:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hash{font-family:var(--mono);font-size:.74rem;color:var(--muted);overflow-wrap:anywhere}
</style></head><body><div class="wrap">
<div class="top"><div><h1 id="titulo">Coletor de BUs</h1><p class="sub" id="sub">Carregando…</p></div>
<div class="dl"><a href="/resumo.csv">resumo.csv</a><a href="/secoes.csv">secoes.csv</a><a href="/votos.csv">votos.csv</a></div></div>

<section class="card">
  <div class="prog-top"><span><span class="big" id="pct">0%</span> das seções com BU coletado</span><span id="estado"></span></div>
  <div class="track"><div id="barra" style="width:0"></div></div>
  <div class="prog-top"><span class="mono" id="contagem"></span><span id="atualizado"></span></div>
</section>

<div class="grid" id="cargos"></div>

<section class="card">
  <div class="prog-top" style="align-items:center"><h2 id="h-mun">Por município</h2><input type="search" id="busca" placeholder="Filtrar por nome…" aria-label="Filtrar municípios"></div>
  <div class="tbl"><table><thead><tr><th>Município / cidade</th><th style="text-align:right">Seções</th><th style="text-align:right">Votantes</th><th style="text-align:right">Comparec.</th><th id="th-top">Mais votados</th></tr></thead><tbody id="muns"></tbody></table></div>
  <div class="det" id="det" hidden></div>
</section>
<p class="sub">Dados lidos dos Boletins de Urna publicados pelo TSE. Esta página atualiza sozinha a cada 5 segundos.</p>
</div>
<script>
const fmt = n => Number(n || 0).toLocaleString("pt-BR");
const pct = n => (n || 0).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + "%";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tc = s => String(s || "").toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m,a,b) => a + b.toUpperCase());
let dados = null, munSel = null, secSel = null;

function renderTopo(d){
  const p = d.progresso || {};
  document.getElementById("titulo").textContent = "Coletor de BUs · " + (d.uf === "zz" ? "Exterior" : d.uf.toUpperCase());
  document.getElementById("sub").textContent = "Eleições 2026, 1º turno · ambiente " + d.ambiente;
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
}

function renderCargos(d){
  const el = document.getElementById("cargos");
  if (!d.cargos.length){ el.innerHTML = '<section class="card"><p class="empty">Nenhum BU coletado ainda. Assim que as seções transmitirem, os votos aparecem aqui.</p></section>'; return; }
  el.innerHTML = d.cargos.map(c => {
    const val = c.itens.filter(x => x.tipo === "nominal" || x.tipo === "legenda");
    const max = Math.max(1, ...val.map(x => x.votos));
    const br = c.itens.filter(x => x.tipo === "branco").reduce((s, x) => s + x.votos, 0);
    const nu = c.itens.filter(x => x.tipo === "nulo").reduce((s, x) => s + x.votos, 0);
    const lim = 15;
    return '<section class="card"><div class="prog-top"><h2>' + esc(c.cargo) + '</h2><span class="mono">' + fmt(c.votantes) + ' votantes</span></div><ol class="cands">' +
      val.slice(0, lim).map(x => '<li class="cand"><span class="nm">' + esc(x.tipo === "legenda" ? "Legenda " + x.partido : x.nome || "Candidato " + x.numero) +
        ' <span class="pt">' + esc(x.tipo === "legenda" ? x.numero : x.partido + " · " + x.numero) + '</span></span><span class="pc">' + pct(c.validos ? x.votos / c.validos * 100 : 0) +
        '</span><div class="bar"><div style="width:' + (x.votos / max * 100) + '%"></div></div><span class="meta">' + fmt(x.votos) + ' votos</span></li>').join("") +
      "</ol>" + (val.length > lim ? '<p class="empty">Mostrando ' + lim + " de " + val.length + " (lista completa em resumo.csv)</p>" : "") +
      '<div class="extra"><span>Válidos <b>' + fmt(c.validos) + "</b></span><span>Brancos <b>" + fmt(br) + "</b></span><span>Nulos <b>" + fmt(nu) + "</b></span></div></section>";
  }).join("");
}

function renderMuns(d){
  const q = document.getElementById("busca").value.trim().toLowerCase();
  document.getElementById("h-mun").textContent = d.uf === "zz" ? "Por cidade no exterior" : "Por município";
  document.getElementById("th-top").textContent = d.cargoPrincipal ? "Mais votados · " + d.cargoPrincipal : "Mais votados";
  const ms = d.municipios.filter(m => !q || m.nome.toLowerCase().includes(q))
    .sort((a, b) => b.coletadas - a.coletadas || b.votantes - a.votantes || a.nome.localeCompare(b.nome, "pt-BR"));
  document.getElementById("muns").innerHTML = ms.map(m => '<tr class="click' + (m.cd === munSel ? " sel" : "") + '" tabindex="0" data-mun="' + m.cd + '"><td>' + esc(tc(m.nome)) +
    '</td><td class="n">' + m.coletadas + "/" + m.total + '</td><td class="n">' + fmt(m.votantes) + '</td><td class="n">' + (m.aptos ? pct(m.votantes / m.aptos * 100) : "–") +
    '</td><td><div class="mini">' + (m.top.length ? m.top.map(t => '<span><i class="mbar" style="width:' + Math.max(2, t.pct * .6) + 'px"></i>' + esc(t.nome) + ' <b class="mono">' + pct(t.pct) + "</b></span>").join("") : '<span class="empty">sem BU ainda</span>') +
    "</div></td></tr>").join("") || '<tr><td colspan="5" class="empty">Nenhum resultado para o filtro.</td></tr>';
}

function renderDet(){
  const el = document.getElementById("det");
  if (!munSel || !dados){ el.hidden = true; return; }
  const m = dados.municipios.find(x => x.cd === munSel);
  const secs = dados.secoes.filter(s => s.mun === munSel).sort((a, b) => a.zona.localeCompare(b.zona) || a.secao.localeCompare(b.secao));
  el.hidden = false;
  el.innerHTML = "<h2>" + esc(tc(m ? m.nome : munSel)) + '</h2><p class="sub">' + (secs.length ? "Clique numa seção para ver o BU." : "Nenhuma seção com BU coletado ainda.") +
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
      '<div class="kv"><span>Aptos <b>' + fmt(c0.aptos) + "</b></span><span>Votantes <b>" + fmt(c0.comparecimento) + "</b></span><span>Abertura <b>" + dhf(s.info.abertura) +
      "</b></span><span>Encerramento <b>" + dhf(s.info.encerramento) + "</b></span><span>BU emitido <b>" + dhf(s.info.emissao) + "</b></span><span>Recebido no TSE <b>" + esc(s.recebido || "–") + "</b></span></div>" +
      s.cargos.map(c => '<div class="tbl"><table><thead><tr><th colspan="3">' + esc(c.cargo) + " · " + fmt(c.comparecimento) + " votantes</th></tr></thead><tbody>" +
        c.votos.map(v => "<tr><td class=\"n\" style=\"width:1%\">" + esc(v.numero) + "</td><td>" + esc(v.nome) + (v.partido ? ' <span class="pt" style="color:var(--muted)">' + esc(v.partido) + "</span>" : "") +
          '</td><td class="n">' + fmt(v.votos) + "</td></tr>").join("") + "</tbody></table></div>").join("") +
      '<p class="hash">' + esc(s.arquivo) + " · hash " + esc(s.hash) + "</p></div>";
  }catch(e){ el.innerHTML = '<p class="empty">Não consegui carregar a seção. O coletor ainda está rodando?</p>'; }
}

async function atualizar(){
  try{
    const r = await fetch("/api/painel", {cache: "no-store"}); dados = await r.json();
    if (!dados || !dados.municipios) return;
    renderTopo(dados); renderCargos(dados); renderMuns(dados);
    if (munSel && !document.getElementById("det").hidden){
      const atuais = new Set(dados.secoes.filter(s => s.mun === munSel).map(s => s.k));
      const botoes = document.querySelectorAll("#det .secs button").length;
      if (atuais.size !== botoes) renderDet();
    }
  }catch(e){ document.getElementById("sub").textContent = "Sem conexão com o coletor. Ele ainda está rodando no terminal?"; }
}
document.getElementById("busca").addEventListener("input", () => dados && renderMuns(dados));
function abrirMun(cd){ munSel = munSel === cd ? null : cd; secSel = null; renderMuns(dados); renderDet(); }
document.getElementById("muns").addEventListener("click", e => { const tr = e.target.closest("tr[data-mun]"); if (tr) abrirMun(tr.dataset.mun); });
document.getElementById("muns").addEventListener("keydown", e => { if (e.key === "Enter"){ const tr = e.target.closest("tr[data-mun]"); if (tr) abrirMun(tr.dataset.mun); } });
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
