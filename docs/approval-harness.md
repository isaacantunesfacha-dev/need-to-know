# Approval Harness (Módulo 5)

O harness é o único caminho entre a saída do modelo e uma gravação no CRM. Código: `src/approval/harness.ts`, adaptadores em `src/adapters/salesforceApproval.ts`, testes em `tests/approval.test.ts` (H01 a H20).

## Paridade com a Gina Intell

No lab, a única escrita permitida é uma `Task` idempotente, com prefixo `Gina:`, atribuída a uma pessoa: a tarefa é o pedido de aprovação, e nada é enviado ao cliente. O Gina RAG mantém isso: o único tipo de ação é `create_owner_task`. Atualizar campo, apagar, mandar e-mail ou chamar ferramenta não existem (H02).

## Fluxo

1. Propor (o modelo): leitura estrita; a ação só pode mirar um registro que foi servido a este usuário nesta resposta e só pode citar chunks servidos (H03, H04). O texto da tarefa passa pelo detector de injeção (H05) e pelo mascaramento de PII (H06). Fica `pending`, com o hash do conteúdo exato e um prazo (15 min por padrão).
2. Decidir (uma pessoa): aprova ou rejeita o conteúdo que viu (o hash precisa bater e é recalculado, H08), antes do prazo (H09), uma única vez (H10). O usuário de serviço nunca aprova (H07).
3. Executar: só `approved`, um executor por vez por compare-and-set (H12). A permissão de edição do aprovador no registro é conferida ao vivo na hora (H13); qualquer resposta que não seja `true` ou `false` literal nega. Se já existe uma tarefa aberta deste pedido, ela é reaproveitada.

## O caso difícil: timeout na gravação

Um timeout na criação da tarefa é ambíguo: a org pode ter criado. O pedido fica `failed`, e a reexecução do mesmo pedido procura antes a tarefa aberta pelo marcador no assunto (`#<id>`), então não duplica (H14). Uma proposta nova teria outro id e poderia duplicar; por isso a reexecução é do mesmo pedido.

## Prova

- Mutações no código real, uma por vez: sem a checagem de origem, o H03 falha; sem o compare-and-set, o H12 cria duas tarefas; sem a busca de idempotência, o H14 duplica; sem a trava do usuário de serviço, o H07 falha.
- Ao vivo (`scripts/live-check.ts`, parte 2b, somente leitura): o admin tem `HasEditAccess=true` na conta e o usuário restrito tem `false`, como previsto antes da medição. Nenhuma tarefa é criada pelo script.

## Limites

- A criação real de `Task` na org (`createTaskWriter`) está implementada e testada com respostas simuladas, mas nunca rodou contra a org: gravar exige autorização explícita do dono.
- O armazenamento de aprovações é em memória (`createMemoryApprovalStore`). Em produção, precisa de um armazenamento com compare-and-set real e retenção.
- O canal humano de aprovação (onde a pessoa vê a tarefa e decide) ainda não existe; vem com o gateway MCP.
