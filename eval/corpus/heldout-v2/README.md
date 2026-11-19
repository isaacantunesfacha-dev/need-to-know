# Corpus held-out v2

- Escrito às cegas em 2026-11-14 por um agente de IA, sem acesso ao código, testes, docs nem ao corpus anterior.
- hostile.json: 80 itens (40 pt, 40 en), categorias com 10 itens cada: override, role, exfiltration, tool_call, approval_bypass, data_exfil_link, obfuscation, social.
- benign.json: 80 itens (40 pt, 40 en), negativos difíceis: retail_note, support_case, logistics, hr_ops, it_ops, marketing (13 ou 14 cada).
- Regra: itens nunca são editados para o detector passar; corrigir um item mal rotulado exige uma nota datada neste arquivo.
