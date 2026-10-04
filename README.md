# Apuração de Araçatuba por bairro — Eleições 2026

Script em Node.js que baixa os **Boletins de Urna (BU)** do 1º turno das Eleições 2026 direto dos arquivos públicos do TSE (`resultados.tse.jus.br`), decodifica os arquivos binários (ASN.1/DER) e agrupa os votos de **Araçatuba (SP)** por local de votação e por bairro.

O painel local mostra:

- **Candidatos por cargo:** Presidente, Governador, Senador, Deputado Federal e Deputado Estadual, com ranking, busca por nome, número ou partido, brancos e nulos.
- **Mapa de calor de Araçatuba:** mostra onde o candidato escolhido teve mais votos, com um ponto em cada local de votação.
- **Tabela por bairro:** votos e percentual do candidato em cada bairro.
- **Locais de votação:** seções de cada escola, com o BU de cada uma.

Os dados também saem em planilhas CSV. O coletor ainda funciona para qualquer UF ou município, mas o mapa só aparece onde existe o arquivo de locais (veja [Outros municípios](#outros-municípios)).

## Requisitos

- Node.js 18 ou superior. Não há dependências para instalar.
- Internet no navegador, para carregar o mapa (Leaflet e blocos do OpenStreetMap).

## Uso rápido

```bash
# Araçatuba, com painel em http://localhost:3000, repetindo a coleta a cada 2 min
node coletar-bus.mjs --web

# Araçatuba, uma única passada, só CSV
node coletar-bus.mjs

# Outro escopo (ex.: exterior)
node coletar-bus.mjs --uf zz --web

# Ajuda
node coletar-bus.mjs --help
```

Sem `--uf`, o coletor usa `--uf sp --mun 61557` (Araçatuba). A coleta termina sozinha quando todas as seções forem baixadas. Com `--loop` ou `--web`, pode ser interrompida com `Ctrl+C`: o progresso fica salvo e a próxima execução continua de onde parou.

## Opções

| Opção | Descrição |
| --- | --- |
| `--uf <sigla>` | UF a coletar (ex.: `sp`, `rj`, `zz` para exterior). Padrão: `sp` com `--mun 61557`. |
| `--mun <códigos>` | Códigos TSE de município/cidade, separados por vírgula (ex.: `61557`). |
| `--zona <zonas>` | Zonas eleitorais, separadas por vírgula (ex.: `11,299`). |
| `--loop <segundos>` | Repete a coleta a cada N segundos (mínimo 60). Sem isso, faz uma passada só. |
| `--concorrencia <n>` | Requisições simultâneas (padrão 3, máximo 8). |
| `--reintentar <min>` | Minutos até verificar de novo uma seção que ainda não publicou o BU (padrão 15). |
| `--out <pasta>` | Pasta de saída (padrão `./saida/<uf>-<município>`, ex.: `./saida/sp-61557`). |
| `--sem-bu` | Não guarda os arquivos `.bu.dat` originais, só os CSVs. |
| `--ambiente <nome>` | `oficial` (padrão) ou `simulado` (ambiente de testes do TSE). |
| `--web` | Abre o painel no navegador e repete a coleta a cada 2 min. |
| `--porta <n>` | Porta do painel (padrão 3000). |

## O mapa e os bairros

O BU traz apenas o número do local de votação. Para ligar cada seção a uma escola, um bairro e uma coordenada, o coletor usa `dados/locais-61557.json`, gerado a partir do cadastro oficial de locais de votação do TSE. Em Araçatuba são 63 locais, 493 seções e 50 bairros, todos com latitude e longitude.

No painel:

- Clique num candidato para ver no mapa e na tabela de bairros onde ele foi melhor.
- **% dos válidos** (padrão) mostra a força do candidato em cada local, sem depender do tamanho da escola. **Votos** mostra o total absoluto.
- O calor vai do local com menor ao de maior valor. Passe o mouse num ponto para ver escola, bairro, votos, percentual e quantas seções já têm BU. Pontos vazados ainda não têm BU coletado.
- Clique num bairro da tabela para aproximar o mapa nele.

> **Atenção:** cada ponto é o **local de votação**, no bairro cadastrado pelo TSE. O eleitor vota onde está inscrito, que nem sempre é o bairro onde mora. Os totais refletem **apenas as seções já coletadas**, não o resultado oficial completo.

Para o **Senado** há 2 vagas em 2026: cada eleitor vota em até dois candidatos, então os votos válidos passam do número de votantes. Os percentuais são sobre o total de votos válidos para o cargo.

## Saída

Tudo vai para `saida/sp-61557/` (ou a pasta indicada em `--out`):

| Arquivo | Conteúdo |
| --- | --- |
| `secoes.csv` | Uma linha por seção coletada: zona, seção, local de votação, bairro, aptos, comparecimento, abstenção, horários de abertura/encerramento/emissão do BU, recebimento no TSE, situação, arquivo e hash. |
| `votos.csv` | Uma linha por voto registrado em cada seção: bairro, cargo, tipo (nominal, legenda, branco, nulo), número, partido, candidato e quantidade. |
| `bairros.csv` | Votos por cargo, bairro e candidato, com o percentual sobre os válidos do bairro. |
| `resumo.csv` | Soma de todas as seções coletadas por cargo e candidato, com o percentual sobre os válidos. |
| `paises.csv` | Só no exterior (`--uf zz`): a mesma soma do `resumo.csv`, separada por país. |
| `estado.json` | Estado da coleta (seções já baixadas e pendentes). Permite retomar sem baixar tudo de novo. |
| `bu/<uf>/<município>/*.bu.dat` | Arquivos originais dos BUs, como publicados pelo TSE (omitidos com `--sem-bu`). |

Os CSVs usam `;` como separador e UTF-8 com BOM, então abrem direto no Excel em português. O painel também tem links para baixá-los.

## Exterior

Com `--uf zz`, o painel não tem mapa, mas ganha uma tabela **Por país** (cidades, seções, votantes, comparecimento e mais votados). Clicar num país filtra a tabela de cidades. Também é gerado o `paises.csv`.

O TSE não informa o país das cidades do exterior, só o nome da cidade. O script traz uma tabela cidade → país (`PAISES_EXTERIOR`) com as 186 cidades de 2026; uma cidade que não estiver nela aparece como "Não identificado".

## Outros municípios

Para ter mapa e bairros em outro município, gere o arquivo de locais dele:

1. Baixe `eleitorado_local_votacao_2026.zip` em [dados abertos do TSE](https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip) e descompacte.
2. Rode, com o CSV da UF e o código TSE do município:

```bash
node gerar-locais.mjs eleitorado_local_votacao_2026_SP.csv 61557
```

Isso cria `dados/locais-<código>.json`, que o coletor carrega automaticamente quando o município está no escopo.

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
4. Cruza os números com os nomes de candidatos e partidos publicados pelo TSE e com o arquivo de locais (escola, bairro, coordenadas).
5. Soma por local, bairro e cargo, gera os CSVs e alimenta o painel.
