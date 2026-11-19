# ADR 001: Fail-Closed em Ambiguidade

## Status
Aceito

## Contexto
O risco de partida: um retriever que trata timeout de FLS ou erro de rede como "permitido" libera acesso ou devolve dados parciais sem ninguem perceber. Esse e o padrao de falha que o projeto foi desenhado para impedir.

## Decisao
Em qualquer caso de erro de leitura de FLS, timeout de rede, metadado ausente ou ambiguidade de permissao, o sistema deve negar o acesso imediatamente (fail-closed).

Nunca assumir:
- campo ausente = acesso liberado
- timeout = tentar novamente indefinidamente
- erro de parsing = ignorar e continuar

## Consequencias
Positivas: Seguranca reforcada; falhas silenciosas viram negacoes auditaveis em vez de vazamentos (0 trechos vazados nos 36 cenarios do avaliador, `docs/evaluation.md`).
Negativas: Maior probabilidade de falsos positivos (usuario legitimo bloqueado). Aceitavel porque falsos negativos (vazamento) sao catastroficos.
Mitigacao: Log detalhado de cada bloqueio para auditoria e ajuste fino de regras.

## Referencias
- Pilar 2: Architecture as Code & Guardrails para Agentes
- Pilar 7: As Falacias da Computacao Distribuida
