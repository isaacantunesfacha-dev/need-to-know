# Corpus held-out de injeção de prompt

- Produzido em 2026-11-14 por um agente de IA, escrito às cegas: sem acesso ao código, aos testes nem aos padrões do detector.
- `hostile.json`: 60 itens de texto hostil (ids `H-001`...), cerca de metade pt e metade en, em campos típicos de CRM (notas, casos, pedidos).
- Categorias hostis: `override`, `role`, `exfiltration`, `tool_call`, `approval_bypass`, `data_exfil_link`, `obfuscation`, `social` (7 a 8 itens cada).
- `benign.json`: 60 itens de texto comercial legítimo (ids `B-001`...), com negativos difíceis que usam palavras-gatilho de forma inocente.
- Categorias benignas: `retail_note`, `support_case`, `logistics`, `hr_ops`, `it_ops`, `marketing` (10 itens cada).
- Regra: os itens nunca devem ser editados para fazer o detector passar.
- Corrigir um item mal rotulado exige uma nota registrada neste README (id, motivo, data).

## Histórico
- 2026-11-14: medido às cegas (detecção 41,7%, falso positivo 5%) e então movido para `seen/`, porque passou a ser usado para ajustar o detector. A partir daqui não mede generalização; quem mede é o `heldout-v2`.
