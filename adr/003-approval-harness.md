# ADR 003: Approval Harness para Gravações no CRM

## Status
Aceito

## Contexto
Agentes autônomos baseados em LLM que possuem permissão irrestrita de escrita em bancos de dados transacionais corporativos (como o Salesforce CRM) representam um risco operacional e jurídico inaceitável. Falhas de alinhamento, alucinações de parâmetros ou ataques de injeção indireta podem induzir o modelo a:
- Conceder descontos comerciais não autorizados.
- Disparar mensagens ou e-mails em massa sem consentimento do titular (violação direta da LGPD/GDPR).
- Alterar status de oportunidades ou corromper dados cadastrais de contas.

A Gina RAG adota o princípio de aprovação humana para toda escrita: a IA acelera a qualificação e a formulação da proposta, mas nunca grava diretamente no CRM de forma autônoma.

## Decisão
Implementar o **Approval Harness (Módulo 5)** como a **única via autorizada** entre a saída do modelo de linguagem e qualquer mutação no Salesforce CRM:

### 1. Escopo de Ação Estritamente Restrito
- O único tipo de ação permitido é `create_owner_task` (criação de uma `Task` no Salesforce, atribuída exclusivamente ao proprietário humano do registro, com o prefixo obrigatório `Gina:`).
- Atualizar campos existentes, deletar registros, enviar e-mails diretamente ao cliente ou acionar ferramentas externas arbitrárias são operações inexistentes no harness.

### 2. Ciclo de Vida de Proposta e Aprovação
1. **Propor (Modelo):**
   - O modelo só pode referenciar um registro que foi efetivamente **servido ao usuário no contexto sanitizado desta requisição**.
   - A proposta só pode citar chunks que passaram com sucesso pelo pipeline de auditoria.
   - O conteúdo do texto da tarefa é submetido à detecção de injeção e mascaramento determinístico de PII.
   - A proposta é gravada em estado `pending`, associada ao hash SHA-256 do conteúdo canônico e a um prazo de validade estrito (TTL padrão de 15 minutos).
2. **Decidir (Humano):**
   - Um operador humano legítimo aprova ou rejeita explicitamente (via interface web ou CLI `pnpm approvals`).
   - O hash do conteúdo é recalculado no momento da decisão: qualquer alteração de payload invalida a ação.
   - Usuários de serviço ou automações de sistema são proibidos de aprovar (`service_user_cannot_approve`).
   - Decisões só podem ocorrer uma única vez por proposta; propostas expiradas não podem ser aprovadas.
3. **Executar (Harness):**
   - Apenas propostas `approved` avançam para a gravação na org.
   - A execução utiliza controle de concorrência por *compare-and-set* atômico, impedindo execuções concorrentes duplicadas.
   - A permissão de edição do aprovador humano no registro alvo é checada ao vivo na org (`HasEditAccess == true`); respostas nulas, indefinidas ou não booleanas resultam em negação imediata (*fail-closed*).
   - **Resiliência e Idempotência sob Timeout:** Timeouts na API de gravação deixam o estado ambíguo. Para prevenir duplicações, a reexecução busca previamente tarefas abertas contendo o marcador `#<proposalId>` no assunto antes de emitir nova inserção.

## Consequências
- **Positivas:**
  - O modelo não tem caminho próprio de escrita: toda gravação passa por uma aprovação humana vinculada ao hash do payload (testes em `tests/approval.test.ts`).
  - Apoia, mas não substitui, a análise de LGPD e as políticas de governança comercial de quem adota.
  - Trilha de auditoria com evidência de adulteração: cada gravação possui proposta rastreável, hash de integridade, carimbo de data/hora e identificação do aprovador humano.
- **Negativas:**
  - Introdução de latência humana no fechamento de ações comerciais (o agente não fecha o ciclo sem um clique humano).
  - Custo de infraestrutura para gerenciamento de estado das propostas com TTL, concorrência e idempotência.
- **Mitigação:**
  - O SDR/Owner recebe propostas estruturadas e mastigadas, permitindo aprovação em 1 clique via CLI (`pnpm approvals approve <id>`) ou painel integrado.
  - Reexecuções seguras com busca por `#<id>` eliminam a necessidade de intervenção manual no caso de timeouts de rede.

## Referências
- Pilar 1: A 1ª Lei da Arquitetura: *Trade-offs* Explícitos (Segurança & Controle vs. Autonomia Total)
- Pilar 2: *Architecture as Code* & Guardrails para Agentes
- Pilar 6: Estilo *Pipe-and-Filter* com Fronteiras Limpas (Approval Harness)
- Pilar 7: As Falácias da Computação Distribuída (Idempotência sob Timeout de Rede)
- Checklist de Auditoria: Item 6 (Portão de Aprovação Humana)
- `docs/approval-harness.md` e `docs/mcp-gateway.md`
