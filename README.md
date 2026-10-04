# Coletor de Boletins de Urna — Eleições 2026

Script em Node.js que baixa os **Boletins de Urna (BU)** do 1º turno das Eleições 2026 direto dos arquivos públicos do TSE (`resultados.tse.jus.br`), decodifica os arquivos binários (ASN.1/DER) e gera planilhas CSV por seção, por voto e um resumo por candidato. Opcionalmente, abre um painel local no navegador para acompanhar a apuração seção a seção.

É um único arquivo (`coletar-bus.mjs`), sem dependências.

## Requisitos

- Node.js 18 ou superior (usa o `fetch` nativo)

## Uso rápido

```bash
# Exterior (UF "zz"), com painel em http://localhost:3000, repetindo a cada 2 min
node coletar-bus.mjs --uf zz --web

# Todas as seções do exterior, uma única passada, só CSV
node coletar-bus.mjs --uf zz

# Um município de SP (Araçatuba, código TSE 61557), repetindo a cada 2 min
node coletar-bus.mjs --uf sp --mun 61557 --loop 120

# Ajuda
node coletar-bus.mjs --help
```

## Opções

| Opção | Descrição |
| --- | --- |
| `--uf <sigla>` | UF a coletar (ex.: `sp`, `rj`, `zz` para exterior). **Obrigatória.** |
| `--mun <códigos>` | Códigos TSE de município/cidade, separados por vírgula (ex.: `61557`). |
| `--zona <zonas>` | Zonas eleitorais, separadas por vírgula (ex.: `11,299`). |
| `--loop <segundos>` | Repete a coleta a cada N segundos (mínimo 60). Sem isso, faz uma passada só. |
| `--concorrencia <n>` | Requisições simultâneas (padrão 3, máximo 8). |
| `--reintentar <min>` | Minutos até verificar de novo uma seção que ainda não publicou o BU (padrão 15). |
| `--out <pasta>` | Pasta de saída (padrão `./saida-bu`). |
| `--sem-bu` | Não guarda os arquivos `.bu.dat` originais, só os CSVs. |
| `--ambiente <nome>` | `oficial` (padrão) ou `simulado` (ambiente de testes do TSE). |
| `--web` | Abre o painel no navegador e repete a coleta a cada 2 min. |
| `--porta <n>` | Porta do painel (padrão 3000). |

A coleta termina sozinha quando todas as seções do escopo forem baixadas. Com `--loop` ou `--web`, pode ser interrompida a qualquer momento com `Ctrl+C`: o progresso fica salvo e a próxima execução continua de onde parou.

## Saída

Tudo vai para a pasta `saida-bu/` (ou a indicada em `--out`):

| Arquivo | Conteúdo |
| --- | --- |
| `secoes.csv` | Uma linha por seção coletada: município, zona, seção, local, aptos, comparecimento, abstenção, horários de abertura/encerramento/emissão do BU, recebimento no TSE, situação, nome do arquivo e hash. |
| `votos.csv` | Uma linha por voto registrado em cada seção: cargo, tipo (nominal, legenda, branco, nulo), número, partido, candidato e quantidade. |
| `resumo.csv` | Soma de todas as seções coletadas por cargo e candidato, com o percentual sobre os votos válidos. |
| `estado.json` | Estado da coleta (seções já baixadas e pendentes). Permite retomar sem baixar tudo de novo. |
| `bu/<uf>/<município>/*.bu.dat` | Arquivos originais dos BUs, como publicados pelo TSE (omitidos com `--sem-bu`). |

Os CSVs usam `;` como separador e UTF-8 com BOM, então abrem direto no Excel em português.

> Os totais refletem **apenas as seções já coletadas**, não o resultado oficial completo.

## Painel web

Com `--web`, o script sobe um servidor local em `http://localhost:3000` que mostra:

- progresso da coleta (seções coletadas / total) e status do próximo ciclo;
- totais por cargo, com percentual dos votos válidos;
- tabela por município, com os mais votados no cargo principal;
- detalhes de cada seção (votos por cargo, horários e hash do BU);
- links para baixar `resumo.csv`, `secoes.csv` e `votos.csv`.

Se a porta estiver ocupada, use `--porta 3001` (ou outra).

## Limites de requisição do TSE

O TSE bloqueia o IP por cerca de 10 minutos quando recebe muitas requisições por segundo ou muitos erros 404. Para evitar isso, o coletor:

- limita as requisições simultâneas (padrão 3) e mantém um intervalo mínimo entre elas;
- espera alguns minutos antes de consultar de novo uma seção que ainda não publicou o BU;
- pausa por 11 minutos se receber vários 403/429 seguidos.

Evite aumentar muito o `--concorrencia`.

## Como funciona

1. Baixa a lista de seções da UF no arquivo de configuração do TSE e aplica os filtros de município e zona.
2. Para cada seção, consulta o arquivo auxiliar (`-aux.json`) para saber se o BU já foi publicado e qual é o hash.
3. Baixa o `.bu.dat`, decodifica a estrutura ASN.1/DER e extrai identificação da seção, horários, eleitores aptos, comparecimento e votos por cargo.
4. Cruza os números com os nomes de candidatos, partidos e municípios publicados pelo TSE e gera os CSVs.
