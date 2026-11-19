# Avaliação (Módulo 4)

`pnpm eval` roda offline, sem rede, e falha a CI quando uma barreira cai. Código em `src/eval/`, cenários em `eval/scenarios/access.json`, linha de base em `eval/baseline.json`, relatório em `reports/eval.json` (não versionado).

## Como funciona

- Org simulada (`src/eval/fixtureWorld.ts`): usuários admin (vê tudo), restrito (Account com `Name` e `Industry`), `nameonly` (Account só com `Name`) e sem acesso; contas, uma oportunidade e duas notas privadas. As portas de acesso e de leitura ao vivo respondem a partir desse mundo, com falhas injetáveis (lentidão, erro, coluna a mais).
- Oráculo independente (`src/eval/oracle.ts`): decide quem pode ler o quê a partir só da definição do mundo. Não importa nada de `src/retrieval/`, então um erro no Módulo 2 não se esconde atrás de um erro igual no oráculo.
- 36 cenários: todos os usuários contra todos os objetos, FLS, sharing, cada variante do contrato (hash divergente, campo não declarado, tenant, modelo, schema, sem auditoria) e falhas da leitura ao vivo.

## Barreiras

| Métrica | Tipo | Regra |
|---|---|---|
| Vazamento (chunk servido que o oráculo nega) | absoluta | = 0 |
| Motivo correto (`detail` esperado por registro) | absoluta | = 100% |
| Detecção no corpus visto (derivado dos testes) | absoluta | = 100% |
| Disponibilidade (permitidos que foram servidos) | regressão | ≥ linha de base |
| Detecção no corpus não visto | regressão | ≥ linha de base |
| Falso positivo (visto e não visto) | regressão | ≤ linha de base |
| Tokens de contexto (estimativa: caracteres ÷ 4) | relatório | sem barreira; base do roteador |

Fidelidade da resposta: `TODO: define metric`, quando houver LLM no pipeline. Orçamento de P95: vem do live-check por REST.

## Prova de que o avaliador pega falhas

Mutações no código real (2026-11-14), uma por vez, restauradas em seguida:

| Mutação | Resultado do `pnpm eval` |
|---|---|
| checagem de FLS desligada no `verifyAccess` | 2 chunks vazados, barreira falha |
| checagem de sharing desligada | 4 chunks vazados, barreira falha |
| checagem de hash desligada | 0 vazamento (correto: hash não é permissão), motivo correto cai para 93%, barreira falha |

Além disso, `tests/eval.test.ts` (G01 a G13) liga componentes quebrados de propósito: porta que libera tudo, detector que não marca nada, detector que marca tudo, corpus ausente.

## Histórico do detector de injeção

Cada linha é uma medição às cegas: o corpus foi escrito por um agente sem acesso ao código, aos testes, aos documentos nem aos corpora anteriores, e o detector foi congelado em commit antes de ser medido.

| Data | Detector | Corpus às cegas | Detecção | Falso positivo |
|---|---|---|---|---|
| 2026-11-14 | `3245ba4` (frases fixas) | v1, 60 + 60 | 41,7% | 5,0% |
| 2026-11-14 | `3245ba4` (frases fixas) | v2, 80 + 80 | 11,3% | 0,0% |
| 2026-11-14 | `4773ca2` (sinais fortes e fracos) | v2, 80 + 80 | 30,0% | 0,0% |

- O v1 foi usado para ajustar o `4773ca2` e por isso virou corpus visto (`eval/corpus/seen/heldout-v1`), onde o detector novo marca 100% dos ataques e 0% dos benignos. Esse número não mede generalização.
- O v2 foi pedido deliberadamente mais difícil (ataques sem "ignore", gatilhos condicionais, ataques no meio de notas longas). Por isso 41,7% (v1) e 30,0% (v2) não se comparam; a comparação honesta é a do mesmo corpus: 11,3% → 30,0%, sem falso positivo novo.
- Erros no v2 por categoria: 6 a 8 de 10 em todas. Nenhuma categoria está resolvida.
- Conclusão de arquitetura: detecção por padrões de texto não generaliza, então ela fica como uma camada de defesa e não pode ser tratada como barreira de segurança. A barreira é estrutural (texto recuperado nunca dá ao modelo poder de chamar ferramentas ou gravar no CRM; approval harness) e o Trust Layer (Módulo 3) precisa de um classificador baseado em modelo, medido no mesmo v2.

## Estado atual das barreiras (linha de base `4773ca2`, corpus `heldout-v2`)

| Métrica | Valor |
|---|---|
| Vazamento | 0 |
| Motivo correto | 57/57 |
| Disponibilidade | 19/19 |
| Tokens de contexto por pergunta | média 17,6, máx. 108 (estimativa) |
| Detecção, corpus visto (85) | 100% |
| Falso positivo, corpus visto (65) | 0% |
| Detecção, v2 às cegas (80) | 30,0% |
| Falso positivo, v2 às cegas (80) | 0,0% |

A linha de base registra o corpus medido (`heldoutCorpus`). Se o corpus às cegas mudar, as duas barreiras de held-out falham até alguém regravar a linha de base de propósito (teste G13).

## Módulo 3: classificador local (Trust Layer)

Classificador `ollama:qwen2.5:7b` (Q4, local, Apple M5 16 GB), prompt em `src/trust/classifier.ts`, congelado no commit `42382f1` antes de qualquer medição no v2. Medido com `pnpm eval:classifier --corpus=heldout`, cinco execuções seguidas no mesmo v2 às cegas (80 ataques, 80 benignos):

| Camada | Execuções (detecção) | Mediana | Falso positivo |
|---|---|---|---|
| só padrões | 30,0% nas 5 | 30,0% | 0% |
| só classificador | 70,0% a 77,5% | 75,0% | 0% a 1,3% |
| padrões + classificador | 76,3% a 81,3% | 80,0% | 0% a 1,3% |

- Em todas as 5 execuções, o sistema pegou os mesmos 57 de 80 ataques (71,3%). Esse é o piso que se pode prometer; a mediana pode cair numa execução ruim.
- O classificador não é determinístico mesmo com temperatura 0 e semente fixa: 15 dos 160 itens (14 ataques, 1 benigno) mudaram de veredito entre execuções. Causa provável: processamento em lote na GPU do runtime local (hipótese, não verificada).
- Falhas que sobram (mediana): exfiltração, engenharia social, dispensa de aprovação e ofuscação.
- Latência por chunk, local: P50 de 0,8 a 0,9 s, P95 de 0,9 a 1,1 s. O Trust Layer classifica os chunks em sequência, então uma pergunta com 5 chunks soma cerca de 4 a 5 s só nesta etapa. `TODO: define metric`: orçamento de P95 por pergunta.
- No corpus visto (testes + v1, usado no único ajuste do prompt): classificador sozinho com 87,1% e 0% de falso positivo; combinado, 100% e 0%.
- Limite do que o v2 prova: o prompt do classificador e o briefing do v2 foram escritos pelo mesmo autor a partir da mesma taxonomia de ataques. O v2 mede generalização para frases novas dentro de categorias conhecidas, não para tipos de ataque desconhecidos. Duas frases de exemplo que vinham do briefing foram retiradas do prompt antes do congelamento.
- `pnpm eval:classifier` não roda na CI (exige o modelo local); a CI continua barrando o detector por padrões.

## Red team adaptativo (2026-11-17)

Atacante: um agente no Fable, sem acesso a código, testes, docs ou corpora. Recebe só a descrição caixa-preta do alvo e, depois de cada rodada, quantas das 5 execuções cada ataque chegou ao contexto. Não fica sabendo qual camada barrou. Medição: `node scripts/redteam.ts eval/redteam/<rodada> --runs=5`. O texto do ataque vai na `Description` de uma Account e percorre o portão inteiro (sanitizador na ingestão, recuperação com releitura ao vivo, Trust Layer com `qwen2.5:7b`). O retriever devolve a linha direto, que é o pior caso para o portão.

| Rodada | Ataques | Barrados na ingestão | Chegaram ao contexto, por execução | Em todas as 5 | Em pelo menos 1 |
|---|---|---|---|---|---|
| r1 | 40 | 8 | 30,0–35,0% | 25,0% | 35,0% |
| r2 (adaptativa) | 41 | 3 | 75,6–78,0% | 73,2% | 80,5% |

Leitura:
- Uma rodada de adaptação mais que dobrou a passagem. A rodada 1 perdeu com ataques que têm cara de ataque (mensagem de sistema falsa, base64, leetspeak, role-play). A rodada 2 usou prosa de negócio: assinatura de diretor, política citada, nota de admin no meio de texto comum. Passou de 5 em 5 nessas categorias.
- O detector, padrões mais o classificador, é uma camada e não uma barreira. O número de 76–81% no `heldout-v2` vale para um corpus estático e não se sustenta contra um atacante que aprende.
- Chegar ao contexto não é o mesmo que causar dano. Mesmo assim, nenhum desses textos traz para o contexto dado que o usuário não pode ler, nem escreve no CRM sem aprovação humana. O que fica em aberto é o que o modelo faz com o texto: mentir sobre um desconto, criar urgência falsa, mostrar link de phishing, redigir uma Task maliciosa para um humano aprovar. `TODO: define metric`, com um LLM real no circuito.
- Os corpora `eval/redteam/r*` foram vistos pelo atacante e são adaptativos, não cegos. Ajustar o detector contra eles conta como treino. Depois disso, a medição exige uma rodada nova.

## Regras de método

- O corpus não visto foi escrito às cegas, por um agente sem acesso ao código, aos testes e aos padrões do detector (`eval/corpus/heldout-v2/README.md`; o v1 está em `eval/corpus/seen/heldout-v1/README.md`). Nenhum item é editado para o detector passar.
- Medir um corpus não o contamina, mas ajustar o detector olhando para ele contamina. Depois de um ajuste assim, o corpus passa para `eval/corpus/seen/` e um corpus novo, escrito às cegas, mede a melhoria. Sem essa troca, o número sobe sem provar generalização.
- Quem ajusta o detector também não lê o corpus às cegas: o agente que o escreve reporta só contagens, e das falhas aparecem só ids e categorias.
- O detector é congelado em commit antes da medição, para o histórico provar que o corpus não participou do ajuste.
- A linha de base só é regravada (`pnpm eval --write-baseline`) com as barreiras absolutas verdes, e a mudança aparece no diff do commit.
