#!/usr/bin/env node
// Gera dados/locais-<município>.json a partir do cadastro de locais de votação do TSE.
// Esse arquivo liga cada seção ao seu local de votação (escola), bairro e coordenadas,
// e é o que o coletor usa para montar o mapa.
//
// Fonte: https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip
// (descompacte e use o CSV da UF, ex.: eleitorado_local_votacao_2026_SP.csv)
//
// Uso:  node gerar-locais.mjs eleitorado_local_votacao_2026_SP.csv 61557 [outros códigos...]

import { readFile, writeFile, mkdir } from "node:fs/promises";

const [arq, ...muns] = process.argv.slice(2);
if (!arq || !muns.length) {
  console.log("Uso: node gerar-locais.mjs <eleitorado_local_votacao_2026_UF.csv> <cód. município TSE> [...]");
  process.exit(1);
}

// CSV do TSE: latin1, separado por ";", campos entre aspas
function linhasCSV(txt) {
  const out = [];
  let campo = "", linha = [], aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) {
      if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ";") { linha.push(campo); campo = ""; }
    else if (c === "\n") { linha.push(campo.replace(/\r$/, "")); out.push(linha); linha = []; campo = ""; }
    else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); out.push(linha); }
  return out;
}

const [cab, ...linhas] = linhasCSV(new TextDecoder("latin1").decode(await readFile(arq)));
const col = Object.fromEntries(cab.map((n, i) => [n, i]));
const v = (l, n) => l[col[n]];
const num = s => Number(String(s).replace(",", "."));
const pad = (s, n) => String(s).padStart(n, "0");

await mkdir(new URL("./dados/", import.meta.url), { recursive: true });
for (const mun of muns.map(m => pad(m, 5))) {
  const locais = {};
  let uf = "", nome = "";
  for (const l of linhas) {
    if (pad(v(l, "CD_MUNICIPIO"), 5) !== mun) continue;
    uf = v(l, "SG_UF").toLowerCase(); nome = v(l, "NM_MUNICIPIO");
    const zona = pad(v(l, "NR_ZONA"), 4), local = String(v(l, "NR_LOCAL_VOTACAO"));
    const k = `${zona}-${local}`; // o número do local se repete entre zonas
    const lat = num(v(l, "NR_LATITUDE")), lon = num(v(l, "NR_LONGITUDE"));
    locais[k] ??= {
      zona, local, nome: v(l, "NM_LOCAL_VOTACAO"), endereco: v(l, "DS_ENDERECO"), bairro: v(l, "NM_BAIRRO"),
      lat: lat === -1 ? null : lat, lon: lon === -1 ? null : lon, secoes: [],
    };
    locais[k].secoes.push(pad(v(l, "NR_SECAO"), 4));
  }
  const lista = Object.values(locais).sort((a, b) => a.zona.localeCompare(b.zona) || Number(a.local) - Number(b.local));
  if (!lista.length) { console.warn(`Município ${mun} não encontrado em ${arq}.`); continue; }
  const destino = new URL(`./dados/locais-${mun}.json`, import.meta.url);
  await writeFile(destino, JSON.stringify({ uf, mun, nome, locais: lista }, null, 1) + "\n");
  const semCoord = lista.filter(x => x.lat == null).length;
  console.log(`${nome}: ${lista.length} locais, ${lista.reduce((s, x) => s + x.secoes.length, 0)} seções, ` +
    `${new Set(lista.map(x => x.bairro)).size} bairros${semCoord ? `, ${semCoord} sem coordenadas` : ""} → dados/locais-${mun}.json`);
}
