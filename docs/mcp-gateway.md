# Gateway MCP e canal humano de aprovação

Com o gateway, o ciclo do Módulo 5 fica completo: o modelo consulta e propõe pelo MCP, e uma pessoa aprova fora desse canal. Código: `src/mcp/` (núcleo e protocolo), `scripts/mcp-server.ts` (servidor), `scripts/approvals.ts` (canal humano), `src/approval/fileStore.ts` (aprovações compartilhadas). Testes: `tests/gateway.test.ts` (W01 a W14).

## Ferramentas que o modelo vê

| Ferramenta | O que faz |
|---|---|
| `gina_retrieve` | recuperação completa: contrato, `verifyAccess`, leitura ao vivo, sanitização, Trust Layer. Devolve o contexto no envelope e um `retrievalId` |
| `gina_propose_owner_task` | cria um pedido de aprovação `pending`; não grava nada no CRM |
| `gina_approval_status` | lê o status de um pedido |

## Três decisões de segurança

1. A identidade não vem do modelo. O usuário é fixado quando o servidor sobe (`GINA_USER_ID`). Nenhuma ferramenta recebe `userId`; um `userId` colocado nos argumentos é ignorado (W02 e teste ao vivo).
2. O modelo não aprova. Não existe ferramenta de aprovar ou executar (W01, W03). A aprovação é feita por uma pessoa com `pnpm approvals`, que exige o hash mostrado por `show`.
3. O servidor lembra o que serviu. A proposta cita um `retrievalId`; a lista de chunks servidos vem da memória do servidor, não do cliente (W04, W05). Um chunk negado pelo Trust Layer nunca foi servido, então não vira tarefa (W06).

## Protocolo

JSON-RPC 2.0 por stdio, escrito à mão (`initialize`, `ping`, `tools/list`, `tools/call`). O SDK oficial traz uma pilha HTTP inteira (express, hono, cors, jose) que um servidor stdio local não usa. Custo: mudanças de protocolo precisam ser acompanhadas aqui. O stdout carrega só JSON-RPC; todo log vai para o stderr.

## Teste ao vivo (2026-11-14, sf CLI, `minha-org-agentforce`)

Servidor real como o usuário restrito, cliente JSON-RPC por stdio:
- ingestão real de uma conta com auditoria de higiene aprovada; `gina_retrieve` com um `userId` do admin nos argumentos foi servido como o restrito, com 1 chunk, envelope presente e cerca de 9,9 s (CLI + classificador local);
- `gina_propose_owner_task` ficou `pending`; um `retrievalId` inventado voltou `unknown_retrieval`; `gina_approve` voltou `unknown_tool`; o stdout não teve nenhuma linha fora do JSON-RPC.

No canal humano, com o mesmo pedido, um hash diferente do mostrado deu `hash_mismatch`, o usuário de serviço deu `service_user_cannot_approve`, o admin com o hash certo aprovou e uma segunda aprovação deu `already_decided`. O `preview` mostrou a `Task` sem gravar, e `execute` sem `--live-write` foi recusado. Nenhuma tarefa foi criada na org.

## Como usar

```bash
# auditoria de higiene, escrita por pessoas (local, fora do git)
mkdir -p .gina && echo '{ "<recordId>": { "status": "approved", "auditedBy": "<userId>", "auditedAt": "<ISO>" } }' > .gina/hygiene.json
GINA_USER_ID=<seu userId> GINA_INDEX_RECORDS=Account:<id> pnpm mcp      # servidor MCP (stdio)
pnpm approvals list | show <id> | approve <id> --as <userId> --hash <hash> | preview <id>
```

Simulados (e o servidor diz isso no log): o embedder e o índice vetorial. O resto é real.

## Limites

- `execute --live-write` cria a `Task` de verdade e nunca foi rodado: exige autorização explícita do dono.
- O servidor guarda as recuperações em memória (15 min, até 200); reiniciar o servidor invalida propostas pendentes de recuperações antigas, não os pedidos já criados.
- Um cliente MCP comprometido ainda pode propor tarefas; ele só não consegue aprová-las nem executá-las.
