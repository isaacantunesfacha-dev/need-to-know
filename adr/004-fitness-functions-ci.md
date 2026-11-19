# ADR 004: Fitness Functions Arquiteturais no CI/CD

## Status
Aceito

## Contexto
Em sistemas RAG empresariais integrados a ecossistemas complexos como o Salesforce, regressões de governança, falhas de *fail-closed* e vazamentos de permissões (FLS/Sharing) ocorrem frequentemente de forma silenciosa quando:
- Ajustes de prompt afetam indiretamente as regras de recusa.
- Funções de busca ou re-ranking alteram o formato ou o tamanho dos chunks.
- Modelos de embedding são atualizados sem migração formal do índice.
- Refatorações de código introduzem exceções não tratadas ou caches espúrios.

A prática predominante de validar agentes conversacionais por "inspeção visual de demonstrações" ou aprovação subjetiva ("parece bom") viola frontalmente os princípios de *Architecture as Code* e engenharia de software (Richards & Ford). Sem barreiras automáticas e mensuráveis no pipeline de integração contínua (CI), a integridade arquitetural se deteriora rapidamente.

## Decisão
Estabelecer uma suíte automatizada de **Fitness Functions Arquiteturais (Módulo 4)** executada offline via `pnpm eval`, tornando obrigatório que qualquer Pull Request passe por barreiras determinísticas antes de ser integrado:

### 1. Barreiras Absolutas (Hard Gates - Tolerância Zero)
O pipeline de CI quebra imediatamente se qualquer uma destas condições for violada:
- **Vazamento de Dados (FLS / Sharing Leakage):** Deve ser identicamente **0** em todos os 36 cenários da org simulada, comparados contra o oráculo independente (`src/eval/oracle.ts`).
- **Acurácia de Motivo de Negação:** Deve ser de **100% (57/57)**. Toda recusa deve retornar o detalhe esperado e mapear sem exceção para uma razão canônica da taxonomia (`fls_denied`, `fls_unreadable`, `timeout`, `injection_detected`, etc.).
- **Detecção no Corpus Visto:** Taxa de acerto (TPR) de **100%** nos ataques conhecidos da suíte de regressão.

### 2. Barreiras de Regressão (Regression Gates)
Monitoradas continuamente contra a linha de base congelada em `eval/baseline.json`:
- **Disponibilidade:** A proporção de chunks autorizados servidos deve ser $\ge$ linha de base (19/19 - 100%).
- **Detecção no Corpus Não Visto (Held-out v2 às cegas):** $\ge$ linha de base de 30,0% para o detector por padrões (gate de CI). O classificador local (`pnpm eval:classifier`, 76,3–81,3% em 5 execuções) precisa do modelo e fica fora da CI: é medido, não bloqueia merge.
- **Taxa de Falsos Positivos (FPR):** $\le$ linha de base de 0,0% no detector por padrões (gate de CI); 0–1,3% no classificador local, medido fora da CI.

### 3. Protocolo de Governança de Corpus Cego (Blind Evaluation)
- O corpus não visto (`eval/corpus/heldout-v2/`) é gerado por agente independente, sem acesso prévio ao código-fonte, aos testes ou à lista de termos do detector.
- Nenhum item de teste pode ser editado para "fazer o detector passar".
- Engenheiros ajustando detectores recebem apenas contagens numéricas e categorias de falhas (ex: `exfiltration`, `role`), nunca o texto integral do payload.
- Se o detector for ajustado visando cobrir o corpus cego, este corpus é automaticamente promovido para `eval/corpus/seen/`, e um novo corpus cego deve ser gerado antes de qualquer nova medição.
- A linha de base só pode ser regravada (`pnpm eval --write-baseline`) com aprovação explícita e todas as barreiras absolutas em verde.

### 4. Execução Offline e Isolamento do Oráculo
- O oráculo de avaliação (`src/eval/oracle.ts`) não importa nenhuma função de `src/retrieval/`, prevenindo conascência de implementação e viés compartilhado.
- A suíte de testes adversariais e de fronteira (316 em 2026-11-19) (`pnpm test:adversarial`) roda 100% em memória, sem dependência de rede, completando a execução em menos de 1 segundo.

## Consequências
- **Positivas:**
  - Nenhum commit entra se algum dos cenários simulados do avaliador vazar um trecho de FLS ou sharing. O gate cobre esses cenários, não todos os casos possíveis.
  - Eliminação da subjetividade e do "parece bom" no processo de revisão de código.
  - Histórico transparente da evolução de robustez contra injeção e conformidade do pipeline.
- **Negativas:**
  - Custo de manutenção da org simulada (`fixtureWorld.ts`) e de oráculos independentes ao adicionar novos objetos ou recursos.
  - Desaceleração de alterações experimentais que não venham acompanhadas de seus respectivos casos de teste.
- **Mitigação:**
  - O design do avaliador foi projetado com execução extremamente rápida (< 1s), fornecendo feedback instantâneo no ciclo local do desenvolvedor (`pnpm eval`).

## Referências
- Pilar 8: Funções de Aptidão Arquitetural (*Fitness Functions*)
- Pilar 5: Conascência e o Acoplamento Silencioso
- Checklist de Auditoria: Item 5 (Teste Adversarial)
- `docs/evaluation.md`, `docs/failure-log.md` e `eval/baseline.json`
