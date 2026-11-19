# Registro de alucinações e erros

Casos reais em que a IA (ou a documentação) afirmou algo que a medição desmentiu, e o que foi feito em cada um. Nada aqui é ilustrativo: cada caso aconteceu durante a construção do projeto.

## 1. A IA previu a resposta errada da org para um campo inexistente
- **Quando:** 2026-11-14
- **O que foi afirmado:** a org devolveria lista vazia em `UserFieldAccess`, e o motivo no log seria `field_unreadable`.
- **O que a medição mostrou:** a org devolve `UNKNOWN_EXCEPTION`, e o CLI leva cerca de 19 s tentando de novo.
- **Como foi detectado:** `scripts/live-check.ts` contra a org real.
- **Como foi tratado:** o módulo não mudou, porque erro já nega acesso. A expectativa do script foi corrigida para o valor medido, com comentário dizendo que é medição.
- **Risco se passasse:** decisão certa com explicação errada no log de auditoria.

## 2. A IA previu o motivo errado para um usuário desconhecido
- **Quando:** 2026-11-14
- **O que foi afirmado:** o resultado seria `entity_unreadable`.
- **O que a medição mostrou:** a org devolve `INVALID_CROSS_REFERENCE_KEY`.
- **Como foi detectado:** `scripts/live-check.ts`.
- **Como foi tratado:** igual ao caso 1: expectativa corrigida para o medido, módulo intacto.
- **Risco se passasse:** o mesmo do caso 1.

## 3. Um teste acusou uma falha de segurança que não existia
- **Quando:** 2026-11-14
- **O que foi afirmado:** o teste A22 reportou que `verifyAccess(undefined)` liberava acesso.
- **O que a medição mostrou:** `undefined` ativava o parâmetro padrão do helper de teste e virava uma requisição válida. O módulo negava corretamente.
- **Como foi detectado:** leitura do teste antes de mexer no módulo.
- **Como foi tratado:** o teste foi corrigido para passar `undefined` de verdade; o módulo não foi alterado. Suíte em 80/80.
- **Risco se passasse:** "corrigir" um bug inexistente no módulo, ou manter um teste que não testava o que dizia.

## 4. A documentação dizia que o token estava válido
- **Quando:** 2026-11-14
- **O que foi afirmado:** o `CLAUDE.md` diz que o `.env.local` tem tokens OAuth recém-emitidos.
- **O que a medição mostrou:** a org recusa com `401 INVALID_AUTH_HEADER`.
- **Como foi detectado:** `scripts/live-check.ts --rest`; o módulo negou todas as requisições.
- **Como foi tratado:** a leitura do `.env.local` é bloqueada para a IA, e o bloqueio foi respeitado. Foi criado um segundo transporte pelo `sf` CLI, que não manipula token. Depois, o dono da org regravou o token e o transporte REST passou em 5/5 (execução dele, 2026-11-14): 851 ms no caso permitido, 212 a 671 ms nas negações, contra cerca de 2,2 s pelo CLI. A causa exata do valor inválido não foi apurada.
- **Risco se passasse:** demo ao vivo quebrada. Em nenhum momento houve liberação indevida.

## 5. Número da suíte do lab citado errado
- **Quando:** 2026-11-14
- **O que foi afirmado:** o `CLAUDE.md` cita a suíte do `gina-training-lab` como 47/47.
- **O que a medição mostrou:** o README e o `VALIDACAO.md` do lab dizem 48/48.
- **Como foi detectado:** leitura dos dois repositórios.
- **Como foi tratado:** corrigido no `CLAUDE.md` para 48/48 após autorização do dono do projeto. A origem do 47 não foi investigada.
- **Risco se passasse:** número errado em material de portfólio.

## 6. O plano supunha uma defesa que a org não permite exercitar
- **Quando:** 2026-11-14
- **O que foi afirmado:** daria para gravar uma negação real por sharing.
- **O que a medição mostrou:** todos os padrões de compartilhamento da org são públicos; nenhum registro fica oculto.
- **Como foi detectado:** consulta a `Organization`.
- **Como foi tratado:** a org não foi alterada. A narrativa de prova foi rebaixada para o que existe: ao vivo, só negação por FLS e por objeto (8/8 em `scripts/live-check.ts`). Sharing está coberto apenas com respostas simuladas na suíte (casos A09, A10, D06 e D07), e o material público deve dizer isso com essas palavras.
- **Como a prova foi construída depois:** sem mexer em Account. Foi criado o objeto `Gina_Private_Note__c`, com compartilhamento privado, e dois registros: um do administrador e um do usuário restrito. O mesmo usuário, no mesmo objeto e campo, lê o registro próprio (permitido) e é negado no alheio (`record_unreadable` na época; hoje `record_denied`, ver caso 10); o administrador lê os dois. Medido ao vivo por REST, 11/11.
- **O que continua sem prova:** sharing em objetos padrão (Account, Opportunity), regras de compartilhamento por critério e hierarquia de papéis. A prova cobre só propriedade do registro em um objeto privado.
- **Risco se passasse:** o vídeo mostraria uma defesa que nunca foi testada de verdade.

## 7. A IA tentou diagnosticar com um script fora do projeto que usava o token
- **Quando:** 2026-11-14
- **O que foi afirmado:** para descobrir qual consulta falhava no caso 4, a IA escreveu um script temporário fora do repositório que carregava o `.env.local` e chamava a org direto.
- **O que a medição mostrou:** a execução foi bloqueada pelo classificador de permissões do Claude Code antes de rodar. Uma segunda tentativa, de checar só o formato do token com `grep`, foi barrada pela regra que proíbe ler o `.env.local`.
- **Como foi detectado:** as duas recusas vieram do próprio ambiente, não da IA.
- **Como foi tratado:** os bloqueios não foram contornados. O diagnóstico passou para dentro do `scripts/live-check.ts`, que imprime só o status HTTP e o código de erro do Salesforce, nunca o token nem dados. Foi assim que apareceu o `401 INVALID_AUTH_HEADER`.
- **Risco se passasse:** credencial manipulada por um script sem revisão e fora do controle de versão.

## 8. O adaptador negava todo mundo em objetos personalizados
- **Quando:** 2026-11-14
- **O que foi afirmado:** a IA escreveu o adaptador supondo que a org identifica as linhas de acesso pelo nome da API do objeto (`Account.<usuário>`), e os 80 testes passavam com essa suposição, porque as respostas simuladas foram escritas pela mesma IA.
- **O que a medição mostrou:** para objeto personalizado a chave é um id interno (`01I….<usuário>`). No primeiro teste real de sharing, os três casos foram negados por `entity_unreadable`, inclusive o do administrador.
- **Como foi detectado:** `scripts/live-check.ts` com o objeto `Gina_Private_Note__c`. O sinal foi o admin ser negado: a IA tratou isso como suspeita sobre o próprio código, não sobre a org.
- **Como foi tratado:** o adaptador passou a ler da org a chave do objeto (`EntityDefinition`) e a de cada campo (`FieldDefinition`), sem montar nenhuma por suposição. Quatro testes de regressão novos (D10 a D13); suíte em 84/84 e checagem ao vivo em 11/11.
- **Efeito colateral medido:** o caso 1 mudou. Campo inexistente agora é negado como `field_unreadable`, sem provocar erro na org. O custo é de 4 para 6 consultas por verificação.
- **Risco se passasse:** nenhuma liberação indevida, porque o erro era para o lado de negar. Mas o RAG seria inútil para qualquer objeto personalizado, e a suíte continuaria verde.

## 9. Um teste supôs a ordem errada dos campos
- **Quando:** 2026-11-14
- **O que foi afirmado:** o teste E16 dizia que uma instrução dividida entre `Name` e `Industry` seria detectada.
- **O que a medição mostrou:** os campos são montados em ordem alfabética (`Industry` antes de `Name`); com as metades na ordem escrita pela IA, a frase ficava invertida e o detector não a reconhecia. O teste falhou.
- **Como foi detectado:** a própria suíte.
- **Como foi tratado:** o teste passou a escrever as metades na ordem real, que é fixa e pública, porque é assim que um atacante faria. O limite ficou documentado no contrato: o detector é heurístico e a taxa real de falso negativo depende do corpus do Módulo 4.
- **Risco se passasse:** um teste verde descrevendo uma defesa que ninguém mediu na ordem real.

## 10. O enum de motivos foi ampliado, mas o código não o usava
- **Quando:** 2026-11-14
- **O que foi afirmado:** o commit `feat(m1)` dizia ter implementado `fls_denied`; o `CLAUDE.md` passou a listar também `retriever_error` e `malformed_request`.
- **O que a medição mostrou:** esses dois motivos nunca eram gravados (o código seguia gravando `fls_unreadable`); o `CLAUDE.md` dizia que `retriever_error` incluía timeout, e o código grava `timeout`; o documento do contrato ainda dizia que `fls_denied` não existia. A suíte continuava com 108 testes, sem nenhum caso novo para os motivos.
- **Como foi detectado:** busca por cada motivo no código, comparada à definição documentada.
- **Como foi tratado:** o motivo deixou de ser escrito à mão. O código passa só o `detail`, e uma tabela única (`src/retrieval/reasons.ts`) deriva o motivo e a decisão. Uma especificação escrita à mão em `tests/fixtures.ts` é comparada com a tabela (E25). Para dar sentido aos dois motivos, `*_denied` (a org respondeu "não") passou a ser separado de `*_unreadable` (sem resposta utilizável).
- **Risco se passasse:** log de auditoria contradizendo a própria documentação.

## 11. O live-check foi citado como prova do Módulo 1
- **Quando:** 2026-11-14
- **O que foi afirmado:** "live-check 9/9 contra a org real (P50 3.431 ms, P95 3.524 ms)" como validação do Módulo 1.
- **O que a medição mostrou:** o script só exercitava o `verifyAccess` (Módulo 2) e não calculava percentis. A execução de conferência deu 9/9, com latências entre 2.376 e 4.464 ms; os percentis citados não foram reproduzidos.
- **Como foi detectado:** leitura do script e nova execução.
- **Como foi tratado:** o script ganhou a parte 2 (ingestão real `WITH USER_MODE`, recuperação com leitura ao vivo, hash e allowlist; 16/16) e a parte 3 (percentis por amostras repetidas, com aviso quando há menos de 20 amostras).
- **Risco se passasse:** o material público atribuiria ao Módulo 1 uma prova que só cobria o Módulo 2.

## 12. O timeout padrão negava tudo pelo CLI
- **Quando:** 2026-11-14
- **O que foi afirmado:** o padrão de 2 s para a verificação de acesso.
- **O que a medição mostrou:** pelo `sf` CLI, cada verificação leva de 2,4 a 4,5 s; com o padrão, toda verificação negaria por timeout. O script só passava porque usava 30 s.
- **Como foi detectado:** comparação entre a constante e as latências medidas.
- **Como foi tratado:** o padrão ficou documentado como dimensionado para REST (~0,85 s medido) e o CLI ganhou a constante `SF_CLI_TIMEOUT_MS`, usada pelo script.
- **Risco se passasse:** nenhuma liberação indevida; um sistema que nega tudo e parece "seguro".

## 13. Referência bibliográfica com data e autor não confirmados
- **Quando:** 2026-11-14
- **O que foi afirmado:** o guia citava *Architecture as Code: To Teach Humans and Agents About Architecture* (O'Reilly 2026, Ford, Richards e um terceiro autor).
- **O que a medição mostrou:** o livro existe (Ford e Richards, O'Reilly), mas está em early release com lançamento previsto para 2027; o subtítulo citado é o título de um artigo do O'Reilly Radar; o terceiro autor não foi confirmado.
- **Como foi detectado:** busca no catálogo da O'Reilly.
- **Como foi tratado:** a citação foi separada em livro e artigo, sem o autor não confirmado e sem data de publicação inventada.
- **Risco se passasse:** uma referência errada em material de portfólio.

## 14. O detector de injeção prometia 100% e mediu 41,7% às cegas
- **Quando:** 2026-11-14
- **O que foi afirmado:** o guia de arquitetura pede "100% de detecção esperada" de injeção indireta, e a suíte mostrava 100% nos casos de teste.
- **O que a medição mostrou:** num corpus de 60 ataques escritos às cegas (por um agente sem acesso ao detector nem aos testes), a detecção foi de 41,7%. Errou 8 de 8 ataques diretos do tipo "desconsidere tudo o que foi dito antes" e 7 de 7 de engenharia social, e marcou 3 de 60 textos comerciais benignos. Os 100% eram sobre casos escritos junto com o detector.
- **Como foi detectado:** `pnpm eval`, Módulo 4.
- **Como foi tratado:** o número entrou como linha de base, então qualquer piora quebra a CI. O detector ainda não foi alterado. Ficou registrada a regra de que, depois de ajustá-lo olhando esse corpus, um novo corpus às cegas é quem mede a melhoria (`docs/evaluation.md`). Nenhuma liberação de permissão depende do detector: o vazamento medido continua 0.
- **Risco se passasse:** o material público diria "100% de bloqueio de injeção" com base em casos que o próprio autor escreveu.

## 15. 100% no corpus de ajuste, 30% às cegas
- **Quando:** 2026-11-14
- **O que foi afirmado:** depois do ajuste, o detector marcava 100% dos ataques e 0% dos benignos do corpus v1, o que sugeria um detector resolvido.
- **O que a medição mostrou:** congelado em commit (`4773ca2`) e medido num corpus novo escrito às cegas (v2), ele detectou 30,0%, com 0% de falso positivo. O detector anterior detectava 11,3% no mesmo v2.
- **Como foi detectado:** `pnpm eval` com o v2, mais a comparação dos dois detectores no mesmo corpus.
- **Como foi tratado:** o ganho real (11,3% → 30,0%, sem falso positivo novo) foi registrado como tal, e o 100% foi documentado como corpus visto. A conclusão virou decisão de arquitetura: o detector por padrões é uma camada, não uma barreira, e o Módulo 3 precisa de um classificador medido no mesmo v2.
- **Risco se passasse:** anunciar "100% de detecção" com base no corpus usado para ajustar.

## 16. Temperatura 0 e semente fixa não deram resultado repetível
- **Quando:** 2026-11-14
- **O que foi afirmado:** o adaptador do classificador local usa temperatura 0 e semente fixa "para ser determinístico", e a primeira medição no v2 deu 76,3% de detecção combinada com 1,3% de falso positivo.
- **O que a medição mostrou:** a segunda execução, idêntica, deu 81,3% e 0%. Em cinco execuções, 15 dos 160 itens mudaram de veredito; a detecção combinada variou de 76,3% a 81,3%.
- **Como foi detectado:** repetição da medição e comparação item a item.
- **Como foi tratado:** o resultado passou a ser publicado como faixa de cinco execuções, com o número garantido (ataques pegos em todas: 71,3%) separado da mediana (80,0%). Ficou em aberto testar votação entre várias chamadas.
- **Risco se passasse:** um número único, escolhido sem querer na execução mais favorável.

## 17. "Nenhum caso precisa mudar" sem comparar o planner com a org
- **Quando:** 2026-11-16
- **O que foi afirmado:** ao propor trocar a suíte de testes do agente `GinaPresalesSDR` de `v4` para `v5`, afirmei que nenhum dos 14 casos precisava mudar, porque a v5 local só difere da v4 no nome da versão.
- **O que a medição mostrou:** na org, v4 e v5 apontam para o mesmo planner `Gina_v4`, mas o planner local difere do da org em 156 linhas: Modo 3 (O Confronto), tarefa de reconsentimento, regras avançadas de lifecycle e tom. Nenhum dos 14 casos cobre isso, e as ações `create_owner_task` e `analyze_customer` nunca eram esperadas.
- **Como foi detectado:** a pergunta do dono ("a v5 introduziu algum tópico, ação ou fluxo novo?") levou a baixar `Bot:Gina` e `GenAiPlannerBundle:Gina_v4` da org (só leitura) e comparar com o local.
- **Como foi tratado:** a afirmação foi retirada e os casos 15 a 20 foram propostos antes de qualquer deploy. O caso 19 foi isolado numa suíte própria (`GinaOwnerTaskWrite`) porque `create_owner_task` cria uma Task real sem confirmação.
- **Risco se passasse:** deploy do planner novo com uma suíte 100% verde que não testa o fluxo novo.

## 18. Deploy de uma versão nova do agente arrastou as versões ativas
- **Quando:** 2026-11-17
- **O que foi afirmado:** para criar a v6, bastaria mandar o planner `Gina_v6` e a `BotVersion:Gina.v6` a partir de `salesforce/`.
- **O que a medição mostrou:** o CLI incluiu o `Bot:Gina` inteiro, com a v4 e a v5 locais. A org recusou as duas (`Não é possível editar uma versão do bot ativa` na v5, erro de exclusão por agente ativo na v4), e as suítes falharam com `BotVersion not found`, porque a v6 ainda não existia.
- **Como foi detectado:** dry-run `0AfgK00000aDas9SAC`.
- **Como foi tratado:** a v6 subiu num pacote Metadata API à parte, só com a v6 no `Gina.bot` e no `package.xml` (validação `0AfgK00000aD9vDSAS`, deploy `0AfgK00000aDbWTSA0`), e as suítes subiram depois, em outro deploy (`0AfgK00000aDd0PSAS`). A v5 ficou ativa e intacta.
- **Risco se passasse:** mexer na versão em produção, ou subir suítes apontando para uma versão que não existe.

## 19. "Agente local em loop" travando a suíte de testes da org
- **Quando:** 2026-11-17
- **O que foi afirmado:** a execução "a test run is already in progress" viria de um agente local em loop (hipótese do dono: o agente do Antigravity, no app Gemini).
- **O que a medição mostrou:** nenhum processo `sf` ou de teste estava rodando no Mac. A única sessão ativa do Antigravity (`f618aa8e`) trabalhava num PDF de outro projeto. A última atividade dele nesta org foi em 2026-11-16 21:07 (horário local), mais de 7 h antes do travamento. `sf agent test run` seguiu recusando, o job em cache (`3A2gK000008FPMTSA4`) a API dá como "Invalid AiEvaluation identifier", e `AiEvaluation` não aceita consulta SOQL.
- **Como foi detectado:** `ps`, logs e transcripts em `~/.gemini/antigravity`, `~/.sf/agent-test-cache.json`.
- **Como foi tratado:** nenhum processo foi encerrado. A trava está no servidor; só o Testing Center cancela. O plano B tira a Salesforce do caminho crítico (CRM local, `src/adapters/localCrm/`). Ainda aberto.
- **Risco se passasse:** matar o trabalho de outro projeto sem destravar nada.
- **Revisão em 2026-11-19 (medido):** o "loop" eram 9 tentativas de `sf agent test run`, das 04:33 às 04:55 (horário local), uma a cada ~3 min (`~/.sf/sf-2026-11-17.log`). Quem tentava era um subagente da própria sessão do Claude, criado às 07:33 UTC para "esperar a execução bloqueante e rodar a v6", com até 8 tentativas. Não era o Antigravity. As tentativas não travaram nada, mas também não destravavam nada. Ainda é hipótese: a trava viria do job `3A2gK000008FPMTSA4` da `GinaPresalesSDR`, iniciado em 2026-11-07 e nunca fechado no cache local. O dono apagou o teste pela interface e salvou o CSV (`tests/GinaPresalesSDR_2026-11-18_06.20.42.csv`, colunas de resposta vazias: nenhum caso rodou). Em 2026-11-19, `sf agent test list` ainda lista as duas definições na org.
- **Correção estrutural:** `pnpm agent:test` (`scripts/agent-test.ts`, `src/agentTest/guard.ts`, `tests/agentTestGuard.test.ts`, 12 casos) faz uma tentativa só e nunca entra em loop. Se houver uma execução velha da mesma suíte no cache, se outro runner local estiver com o lock ou se a suíte gravar na org sem `--allow-write`, ele recusa antes de começar. "Already in progress" sai com o código 3 e a instrução de cancelar no Testing Center.

## 20. Teste de "nunca persiste texto" que não pegava o vazamento
- **Quando:** 2026-11-17
- **O que foi afirmado:** `tests/vectorStore.test.ts` provava que o vector store nunca grava texto, nem quando a entrada contrabandeia uma chave `text`.
- **O que a medição mostrou:** com a projeção desligada de propósito (`JSON.stringify(record)` no lugar de `project(record)`), a suíte seguiu 16/16 verde. O teste só olhava o primeiro resultado da busca, e a linha contrabandeada nunca ficava em primeiro.
- **Como foi detectado:** teste de mutação feito antes de confiar em duas suítes que passaram de primeira.
- **Como foi tratado:** o teste passou a ler o arquivo SQLite cru e exigir que nenhuma linha tenha `text`. Com a mesma mutação, agora dá 1 falha; restaurado, 16/16.
- **Risco se passasse:** uma regressão na projeção gravaria texto de registro no índice, quebrando o contrato v1, com a CI verde.

## 21. Deduplicação "um trecho por registro" derrubou a disponibilidade
- **Quando:** 2026-11-17
- **O que foi afirmado:** com perfis de trecho, bastava servir o trecho permitido mais largo de cada registro.
- **O que a medição mostrou:** `pnpm test` (G07) acusou availability 0,842 contra baseline 1. A regra descartava também linhas idênticas e trechos com campos disjuntos (`[Name]` e `[Industry]`): os dois passam, nenhum contém o outro, e um deles se perdia.
- **Como foi detectado:** o gate de regressão do avaliador.
- **Como foi tratado:** só sai o trecho cujos campos são subconjunto estrito de outro trecho do mesmo registro que também passou. Disponibilidade de volta a 1, sem mexer em cenário. Um teste novo cobre o caso de campos disjuntos.
- **Risco se passasse:** perda silenciosa de contexto autorizado.

## 22. Perfis de trecho não bastaram: o topK ia para trechos negados
- **Quando:** 2026-11-17
- **O que foi afirmado:** com um trecho `Name + Industry`, o usuário restrito passaria a receber o que pode ler.
- **O que a medição mostrou:** em `pnpm local ask` com o embedder real e topK 3, 2 dos 3 candidatos eram trechos largos negados por FLS. O trecho estreito da Burlington (Apparel) ficou fora numa pergunta sobre apparel.
- **Como foi detectado:** a demo pelo MCP continuou mostrando 0 trechos para o restrito.
- **Como foi tratado:** a recuperação checa até 3 × topK candidatos (máximo 20) e serve no máximo topK. Custo: até 3 vezes mais checagens por consulta. Teste novo, com mutação conferida (fator 1 ⇒ falha). A pergunta sobre "contact center" continua vazia para o restrito, de propósito: só a Description fala disso.
- **Risco se passasse:** um controle de acesso correto que, na prática, não devolve nada útil.

## Como registrar um caso novo
No momento em que acontece, com os seis campos acima. Só entra o que foi medido; hipótese sobre a causa vai marcada como hipótese. "Como foi tratado" inclui os casos ainda abertos.
