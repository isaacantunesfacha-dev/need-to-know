# Contrato do registro vetorial, v1

Fronteira entre o Módulo 1 (ingestão) e o Módulo 2 (recuperação). Código: `src/contract/vectorRecord.ts`. Testes: `tests/vectorContract.test.ts` (E01 a E26) e `tests/ingest.test.ts` (F01 a F14). Prova ao vivo: `scripts/live-check.ts`, parte 2.

## Princípio

O índice vetorial não é fonte de verdade. Ele só diz "este registro, estes campos, com este hash". O texto que vai para o LLM nunca sai do índice: a recuperação busca na org, ao vivo, exatamente os campos declarados, recalcula o hash e nega em qualquer divergência. Um chunk que mente sobre os próprios campos, seja por loop, ataque ou alucinação do Módulo 1, não consegue vazar um campo não declarado (E02).

## Campos obrigatórios

| Campo | Regra | Se falhar |
|---|---|---|
| `schemaVersion` | literal `1` | `schema_mismatch` |
| `tenantId` | id de 18 caracteres da org, igual ao da política | `tenant_mismatch` |
| `chunkId`, `recordId`, `objectName` | validados como no Módulo 2 | `malformed_candidate` |
| `fields` | lista fixada na ingestão; cada campo na allowlist do objeto | `undeclared_field` |
| `chunkHash` | sha256 de (objeto, registro, pares campo/valor ordenados); inclui o `recordId`, então não pode ser reaproveitado em outro registro (E13) | `malformed_candidate` |
| `embeddingModelId` | presente em `acceptedEmbeddingModels` | `embedding_model_rejected` |
| `sourceModifiedAt` | `SystemModstamp` da origem, ISO UTC, não posterior a `ingestedAt` | `malformed_candidate` |
| `ingestedAt` | ISO UTC | `malformed_candidate` |
| `hygiene` | `{ status: "approved", auditedBy: <id de usuário>, auditedAt }` | `hygiene_unapproved` |

O motivo do log (`reason`) sai de `src/retrieval/reasons.ts`: as recusas de política viram `fls_denied`, e uma linha que nem é um registro do contrato vira `retriever_error`.

A política (`IndexPolicy`: tenant, modelos aceitos, allowlist de campos por objeto) vem da configuração, nunca do índice. Durante uma troca de modelo de embedding (blue/green), os dois ids ficam em `acceptedEmbeddingModels` até o índice antigo ser apagado.

## Regra de negócio: auditoria de higiene antes da ingestão

O registro que o time de DBA não auditou não é nem lido do CRM: o ingestor consulta a auditoria primeiro e para ali (F02, F03). A recuperação confere de novo, então um registro escrito no índice por outro caminho também é negado (E10). A vistoria humana é a última linha de defesa; a arquitetura não depende dela para negar.

## Ordem na ingestão (`ingestRecord`)

1. Requisição, tenant e modelo de embedding conferidos antes de qualquer chamada.
2. Auditoria de higiene. Sem aprovação válida: `hygiene_unapproved`, CRM não consultado.
3. Leitura dos campos da allowlist mais o `SystemModstamp`, `WITH USER_MODE`. Coluna a mais ou a menos: `source_mismatch`.
4. Linha montada por `buildVectorRecord`, a mesma validação da recuperação.
5. Detecção de injeção: registro envenenado fica em quarentena e não entra no ranking (F07).
6. Embedding (tamanho e valores conferidos) e gravação. Cada passo tem prazo; nenhum trava.

## Ordem por chunk na recuperação

1. Contrato. Falhou: nega sem chamar a org (medido ao vivo: 0 consultas).
2. `verifyAccess` (objeto, FLS, sharing) para os campos declarados.
3. Leitura ao vivo dos campos declarados, `WITH USER_MODE`. Timeout: `timeout`; erro: `source_error`; campo a mais ou a menos: `source_mismatch`.
4. Hash ao vivo diferente do indexado: `stale_chunk` (o CRM mudou e o embedding não descreve mais o registro).
5. Detecção de injeção no texto de todos os campos juntos (pega instrução dividida entre campos, E16) e limpeza de cada valor separadamente.

## Custo medido

Cada chunk aprovado custa 7 consultas SOQL: 6 do `verifyAccess` (duas em sequência, para ler da org a chave do objeto e dos campos) e 1 da leitura ao vivo. Uma recusa pelo contrato custa 0.

Medido em 2026-11-14 contra a org de desenvolvimento, transporte `sf` CLI, 20 amostras por caminho (`scripts/live-check.ts --samples=20`):

| Caminho | mín | P50 | P95 | máx |
|---|---|---|---|---|
| `verifyAccess`, admin, permitido | 2.420 ms | 2.465 ms | 3.449 ms | 4.491 ms |
| `retrieveWithContext`, 1 chunk (acesso + leitura ao vivo) | 3.617 ms | 4.627 ms | 5.709 ms | 6.052 ms |

O CLI abre um processo Node por consulta, e isso domina o tempo. O transporte REST mediu cerca de 0,85 s no `verifyAccess` (uma execução, failure-log #4) e ainda não tem percentil próprio. `TODO: define metric`: orçamento de P95 por pergunta, definido no Módulo 4, medido por REST.

## Limites conhecidos

- Usuário de integração ≠ usuário final. `WITH USER_MODE` aplica as permissões de quem roda a consulta. Com o usuário de integração, a org aplica a visão *dele*; a visão do usuário final é garantida pelo `verifyAccess`. Para a org aplicar nativamente a visão do usuário final é preciso OAuth por usuário, o que também removeria o privilégio "View All Data" do adaptador de acesso. Registrado como dívida técnica.
- Detector heurístico. A detecção de injeção é por regex. A ordem de montagem dos campos é fixa e pública, e o E16 cobre o atacante que a conhece; a taxa real de falso negativo depende do corpus do Módulo 4.
- Ainda simulados: embedder, índice vetorial e o armazenamento da auditoria de higiene. A reindexação quando o CRM muda (outbox ou eventos) não existe; até lá, um registro alterado é negado como `stale_chunk`, nunca servido desatualizado.

## Chunk profiles (audiences)

`IndexPolicy.chunkProfiles` lists, per object, extra field sets to index as their own chunks. Each is a subset of the allowlist; the whole allowlist is always one chunk too. A user denied one field (FLS) then still gets a chunk that never contained it.

- Chunk id: the whole allowlist keeps `Object.recordId`; a profile gets `Object.recordId.p<10 hex>`, from its sorted field names.
- One hygiene audit, one snapshot and one injection scan per record, over every allowlisted field. A poisoned field quarantines the whole record, clean profiles included.
- A profile that is empty, malformed or names a field outside the allowlist makes the object unindexable (`undeclared_field`). Nothing is indexed partly.
- Retrieval checks every chunk on its own. When a chunk's fields are a strict subset of another passing chunk of the same record, only the wider one is served. Disjoint chunks and identical duplicates are all kept.
- Retrieval checks up to `OVERFETCH_FACTOR` (3) × topK candidates (max 20) and serves at most topK, so chunks the user cannot read do not use up the budget.
- A narrow chunk ranks on its own text only. A hidden field never decides what a user sees.

Open: the gateway reports `denied` counts per reason to the caller. With profiles, that count says how many hidden chunks matched the query. It is a count, not content, but it is a side channel.
