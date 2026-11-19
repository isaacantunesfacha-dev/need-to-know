# ADR 002: Sanitização Dupla e Defesa Contra Injeção Indireta de Prompt

## Status
Aceito

## Contexto
Em arquiteturas RAG corporativas conectadas ao Salesforce, os dados recuperados de bases vetoriais, notas e campos de CRM constituem um vetor primário de ataque: **Indirect Prompt Injection**. Textos inseridos por usuários ou terceiros podem carregar instruções hostis destinadas a sequestrar o fluxo de controle do LLM.

Os vetores de ataque identificados incluem:
- Caracteres Unicode invisíveis e tags de esteganografia (`U+E0000`–`U+E007F`).
- Marcadores zero-width e caracteres bidirecionais de ofuscação (`U+200B`–`U+200F`, `U+202A`–`U+202E`).
- Injeções embutidas em comentários HTML ou tags com `display:none`.
- Diretivas de escape e exfiltração em markdown (ex: `![img](https://evil.com/...)`).
- **Ataques fatiados entre campos:** a instrução hostil é distribuída intencionalmente entre múltiplos campos (por exemplo, metade em `Account.Name` e metade em `Account.Industry`), burlando filtros aplicados a campos isolados.

Medições empíricas no corpus v2 às cegas demonstraram que filtros puramente baseados em expressões regulares fixas alcançam apenas **30,0% de detecção**, evidenciando que heurísticas sintáticas simples não generalizam e não podem atuar como barreira isolada de segurança.

## Decisão
Implementar uma política mandatória de **Sanitização Dupla** em duas camadas sequenciais no pipeline, tratando todo texto recuperado como dado estritamente passivo e potencialmente hostil:

### 1. Camada Sintática e Estrutural Local (Módulo 1 & Módulo 2)
- **No Clean Ingestor (`src/ingest/ingestRecord.ts`):** Quarentena imediata de registros com texto envenenado antes de qualquer geração de embedding. Registros infectados não são indexados.
- **No Fail-Closed Retriever (`src/retrieval/`):**
  - Remoção determinística de sequências invisíveis Unicode (`U+E0000`–`U+E007F`), zero-width (`U+200B`–`U+200F`) e overrides bidi (`U+202A`–`U+202E`).
  - Stripping de HTML oculto e normalização de caracteres de controle.
  - **Inspeção unificada multideclaração:** todos os campos recuperados são concatenados e inspecionados em conjunto antes de qualquer entrega, neutralizando ataques fatiados entre campos.
  - Qualquer indício de instrução embutida resulta em negação imediata (*fail-closed*) com motivo `injection_detected` e detalhe `embedded_instruction`.

### 2. Camada Semântica e Mascaramento de PII no Trust Layer (Módulo 3)
- **No Trust Layer Bridge (`src/trust/`):**
  - Execução de classificador semântico local (`qwen2.5:7b` via Ollama) operando em envelope isolado protegido por nonce impossível de ser fechado pelo chunk. O classificador identifica tentativas complexas de engenharia social, exfiltração de dados e bypass de aprovação humana. A combinação de padrões sintáticos + classificador eleva a detecção para **76,3%–81,3%** (mediana **80,0%**, piso determinístico de 71,3%) no corpus cego v2.
  - Mascaramento determinístico de PII (CPF, CNPJ, e-mail, telefone, cartões de crédito validados pelo algoritmo de Luhn) antes de qualquer injeção no contexto do LLM.
  - Se o classificador falhar, expirar ou retornar formato ambíguo, a camada nega imediatamente sob `safety_unverified` (*fail-closed*).

## Consequências
- **Positivas:**
  - Mitigação de técnicas comuns de esteganografia e injeção invisível via Unicode.
  - Neutralização de injeções distribuídas entre múltiplos campos do CRM.
  - Proteção estrita de dados sensíveis (LGPD) através de mascaramento determinístico de PII.
  - Isolamento estrito: o texto recuperado nunca concede autoridade de execução de ferramentas ao modelo.
- **Negativas:**
  - Acréscimo de latência: a sanitização local é uma passada em memória (latência não medida em separado: `TODO: define metric`), enquanto o classificador local adiciona P50 de 0,8–0,9 s e P95 de 0,9–1,1 s por chunk (impactando consultas com múltiplos chunks).
  - Risco residual de falsos positivos em notas comerciais contendo sintaxe de código legítima (mantido em $\le 1,3\%$ no classificador e 0,0% no detector por padrões).
- **Mitigação:**
  - A sanitização sintática e remoção de Unicode rodam de forma síncrona e ultrarrápida.
  - O classificador semântico possui timeout rígido com fail-closed determinístico.
  - Toda decisão de bloqueio gera log estruturado com `{ decision: "deny", reason: "injection_detected", detail, userId, recordId, latencyMs }`.

## Referências
- Pilar 2: *Architecture as Code* & Guardrails para Agentes (Imutabilidade de Instruções)
- Pilar 6: Estilo *Pipe-and-Filter* com Fronteiras Limpas
- Checklist de Auditoria: Item 2 (Higienização Dupla)
- `docs/evaluation.md`, `docs/contract/vector-record-v1.md` e `docs/failure-log.md`
