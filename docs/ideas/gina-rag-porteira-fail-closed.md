# Gina RAG: a porteira fail-closed

## Problem Statement
Como poderíamos provar com números, e mostrar em dois minutos, que um RAG sobre Salesforce nega acesso sempre que não tem certeza?

## Recommended Direction
Gina RAG é o segundo capítulo da Gina Intell (repositório `gina-training-lab`). No lab, a Gina decide quem precisa de atenção com regras determinísticas e uma suíte 48/48. Aqui ela decide quem pode ler o quê, com o mesmo padrão: funções puras, casos adversariais nomeados e paridade com a org `minha-org-agentforce`.

A ordem é uma frente por vez, cada uma auditada antes da próxima. Primeiro os módulos de engenharia com a suíte adversarial e negações reais gravadas. Depois o mapa, que já nasce com os números medidos. Depois a Gina 3D, e por último o vídeo, que monta a gravação real com o mapa e a personagem.

Público: recrutadores / portfólio. Sem prazo; qualidade e auditoria mandam. Prova exigida: demo real gravada.

## Key Assumptions to Validate
- [x] A org permite reproduzir FLS ilegível e registro escondido por sharing. **Comprovado:** usuário restrito e objeto privado criados (abaixo); negação por FLS, por objeto e por sharing medidas ao vivo.
- [x] Dá para distinguir "campo ausente" de "campo escondido" pela API. **Comprovado:** campo inexistente não tem linha em `FieldDefinition` (`field_unreadable`); campo escondido responde `IsAccessible = false` (`field_denied`). Os dois negam.
- [x] O runner do lab (`src/utils/challengeRunner.ts`) serve para casos de retrieval. **Descartado sem portar:** a suíte usa `node:test`, sem dependências; o padrão herdado do lab é o de casos nomeados, todos verdes, não o runner.
- [ ] O Blender procedural chega a uma Gina reconhecível. Teste: um render de estúdio da cabeça comparado a `gina-head.png` antes de qualquer diorama.

## Fixtures de teste criados na org (2026-11-14)
- Usuário `gina.rag.restricted@00dgk00000cqrt7uag.test` (`005gK00009kAxU5QAK`), perfil "Minimum Access - Salesforce", sem senha definida.
- Permission set `Gina_RAG_Restricted_Test` (`0PSgK00000NmbssWAB`): leitura de Account, só o campo `Industry` além dos obrigatórios.
- Objeto `Gina_Private_Note__c` (OWD privado, fonte em `salesforce/`), com os registros `a00gK00001VUGMrQAP` (do admin) e `a00gK00001VUa3hQAD` (do usuário restrito).
- Todos os outros OWD da org são públicos (Account = Edit) e a org não será alterada.

## O que está provado ao vivo, e o que não está
Medido com `scripts/live-check.ts` (16/16, transporte `sf` CLI):
- Negação por FLS (campo escondido), por objeto, por campo inexistente, por usuário desconhecido e por timeout.
- Negação por sharing, só por **propriedade de registro em um objeto privado** (`Gina_Private_Note__c`).
- Módulo 1 de ponta a ponta: ingestão real `WITH USER_MODE`, recuperação com leitura ao vivo, hash divergente negado, campo fora da allowlist negado sem nenhuma consulta à org.

Sem prova ao vivo: sharing em objetos padrão (Account, Opportunity), regras de compartilhamento por critério e hierarquia de papéis. Na suíte isso aparece coberto por respostas simuladas, e o material público deve dizer isso com essas palavras. Simulados também na parte 2 do script: o embedder e o índice vetorial.

## MVP Scope
Dentro: `verifyAccess`, `retrieveWithContext`, contrato do registro vetorial, `ingestRecord`, log estruturado com motivo derivado do detalhe, suíte adversarial 100% verde sem rede, e uma execução real contra a org gravada em tela.
Fora desta etapa: Trust Layer, avaliador, approval harness, MCP e todo o visual.

## Not Doing (and Why)
- **Quatro frentes em paralelo:** o vídeo e o mapa precisam dos números medidos, e a prova pedida é demo real.
- **Reconstruir o que o plugin Salesforce in Claude faz:** está fora do escopo no `CLAUDE.md`.
- **Mapa com métricas ilustrativas:** só entra número que a suíte ou o live-check mediu.
- **Diorama e animação 3D antes do render de estúdio aprovado:** evita animar um modelo que ainda não parece a Gina.
- **MCP gateway agora:** vem por último, quando os módulos existirem.

## Proposta em aberto: roteador antes do RAG
Premissa: para uma loja pequena, cada chamada ao modelo custa. Se a pergunta se resolve com um dado estruturado que já está no CRM (ou num CDP), ela deve ir por consulta direta (SOQL/API), sem recuperação vetorial nem contexto longo. Desenho possível:
1. Classificador decide entre consulta direta e RAG; na dúvida, RAG (o caminho com mais controles), nunca "responder sem dado".
2. Tarefas repetitivas de classificação e extração podem usar um modelo pequeno; o modelo de fronteira fica para o que é ambíguo.
3. A qualidade dos dados no índice (contrato v1) pesa mais que o prompt.

Nada disso está decidido. `TODO: define metric`: tokens e latência por pergunta, com e sem roteador, medidos pelo Módulo 4 sobre o mesmo conjunto de perguntas. O roteador herda as mesmas portas fail-closed: a consulta direta passa pelo `verifyAccess` como qualquer outra leitura.

## Open Questions
- O vídeo final é em português, inglês ou os dois, como o showcase do lab?
- Onde fica o registro de auditoria de higiene (ledger): arquivo versionado, objeto na org ou CDP? Criar um objeto na org exige autorização do dono.
- Qual provedor de embedding? Precisa permitir modelo local (soberania e custo, pilar 1 do guia).
