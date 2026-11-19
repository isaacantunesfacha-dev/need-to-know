/**
 * Local sanitization pass for retrieved chunks (rule 3: sanitize twice; the
 * native Trust Layer is the other pass). Pure functions, no I/O.
 *
 * Detection runs on a "full" view that keeps hidden content (comments,
 * attributes, hidden elements), so an instruction hidden from a human reader
 * still gets the chunk denied. The returned text is the "visible" view.
 */

export const MAX_CHUNK_CHARS = 20_000;

/** Unicode tag block: invisible, maps 1:1 to ASCII, classic smuggling channel. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const NON_TEXT_BLOCK =
  /<(script|style|template|noscript|iframe|object|embed|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const HIDDEN_ELEMENT =
  /<([a-z][a-z0-9]*)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?![.\d]*[1-9])|color\s*:\s*(?:white|#fff(?:fff)?\b|transparent))[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const ANY_TAG = /<\/?[a-z!?][^>]*>?/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntitiesOnce(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});?/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return " ";
      if (code >= 0xd800 && code <= 0xdfff) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Lookalike letters folded to ASCII, for detection only. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ѕ: "s", ј: "j",
  һ: "h", ԁ: "d", ո: "n", к: "k", м: "m", т: "t", в: "b", н: "h",
  ο: "o", α: "a", ε: "e", ι: "i", ν: "v", ρ: "p", τ: "t", υ: "u", κ: "k",
};

/** Lowercase, no accents, lookalikes folded, punctuation collapsed to spaces. */
function fold(text: string): string {
  const lowered = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let out = "";
  for (const ch of lowered) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/[^a-z0-9]+/g, " ").trim();
}

/*
 * Detection model (Module 4 found the old one caught 41.7% of a blind corpus):
 * signals, not single phrases. A STRONG signal flags on its own. A WEAK
 * signal is common in honest business text ("run the diagnostic tool",
 * "acesso liberado") and flags only together with a second, different weak
 * signal. Addressing the AI directly is itself a weak signal: CRM notes are
 * written for people. All patterns run on folded text (lowercase, no
 * accents, lookalikes folded, punctuation collapsed to spaces).
 */

const OVERRIDE_VERB =
  "ignore|ignorar|ignora|disregard|forget|override|bypass|abandon|abandone|abandonar|throw out|discard|descarte|descartar|desconsidere|desconsiderar|desconsidera|esqueca|esquecer|esquece|anule|anular|desobedeca|drop|scrap|supersede|substitua";
const OVERRIDE_OBJECT =
  "instructions?|instrucoes|instrucao|rules?|regras|guidelines?|diretrizes|directives?|directions|orientacoes|policies|politicas|restrictions?|restricoes|filters|filtros|configuration|configuracao|prompt|comandos|safeguards|guardrails";
const OVERRIDE_QUALIFIER =
  "previous|prior|earlier|above|before|original|old|existing|anteriores|anterior|antes|acima|antigas|originais|recebeu|received|were given|you were|your|suas|seus|do sistema|of the system|system|de seguranca|safety|security|de acesso|access|privacy|privacidade|all|todas|todos";

const EXTRACT_VERB =
  "list|liste|listar|include|inclua|incluir|dump|despeje|despejar|show|mostre|mostrar|output|print|imprima|export|exporte|exportar|quote|cite|reveal|revele|give me|me passe|me mande|send me|tell me|extract|extraia|compile|compile";

const STRONG: readonly RegExp[] = [
  // Override, in either order: "ignore previous rules", "the rules above, ignore them".
  new RegExp(`\\b(${OVERRIDE_VERB})\\b.{0,50}\\b(${OVERRIDE_QUALIFIER})\\b.{0,40}\\b(${OVERRIDE_OBJECT})\\b`),
  new RegExp(`\\b(${OVERRIDE_VERB})\\b.{0,30}\\b(${OVERRIDE_OBJECT})\\b.{0,40}\\b(${OVERRIDE_QUALIFIER})\\b`),
  new RegExp(`\\b(do not|don t|stop|nao|pare de|deixe de)\\s+(follow|following|obey|obeying|siga|seguir|obedeca|obedecer)\\b.{0,30}\\b(${OVERRIDE_OBJECT}|your|suas|seus)\\b`),
  // "everything said before", "tudo o que foi dito antes".
  /\b(ignore|disregard|forget|desconsidere|desconsiderar|esqueca|ignore|ignorar|descarte)\b.{0,20}\b(everything|whatever|anything|tudo|qualquer coisa)\b.{0,40}\b(said|written|told|above|before|earlier|dito|escrito|antes|acima)\b/,
  // "previous guidelines are void", "as regras não valem mais".
  new RegExp(`\\b(${OVERRIDE_OBJECT})\\b.{0,40}\\b(are void|is void|are null|no longer apply|no longer valid|nao valem|nao se aplicam|estao desatualizad|sao invalid|foram revogad|are obsolete|are outdated|estao obsolet)`),
  // Replacing the reader's configuration with this text.
  /\b(treat|consider|trate|considere)\b.{0,40}\b(this|these|este|esta|estes|estas)\b.{0,30}\b(note|comment|text|field|nota|comentario|texto|campo|campos)\b.{0,40}\b(as your|como sua|como seu|como suas|como a sua|only source|unica fonte|new configuration|nova configuracao)/,
  /\b(follow|obey|siga|obedeca|comply with)\b.{0,15}\b(only|somente|apenas|anything|tudo|qualquer)\b.{0,40}\b(this note|these lines|nesta nota|neste campo|nos campos|escrito|written here|the next reader|asks?|pedir|pedido)/,
  /\b(clean slate|start over with|novas? diretriz(es)? a partir|new directive)\b/,
  // Role and persona switches.
  /\b(you are now|voce agora e|voce e agora|from now on you are|from this point you are|a partir de agora voce e|daqui em diante voce e|now act as)\b.{0,40}\b(assistant|assistente|bot|ai|ia|admin|administrator|administrador|developer|desenvolvedor|system|sistema|dan|persona|root|mode|modo|no polic|sem polit|unrestricted|sem restric|sem filtro|free|livre)/,
  /\b(pretend|faca de conta|finja|imagine) (that )?(you are|you re|que voce e|que voce esta|ser)\b/,
  /\b(act as|aja como|atue como|behave as|comporte se como)\b.{0,30}\b(admin|administrator|administrador|system|sistema|developer|desenvolvedor|root|dan|gerente geral|superuser|superusuario|owner of the org)\b/,
  /\b(developer|debug|god|jailbreak|unrestricted) mode\b|\bmodo (desenvolvedor|debug|deus|irrestrito)\b/,
  /\bstay in (this|the) (persona|character|role)\b|\bmantenha (essa|esta|o) (persona|personagem|papel)\b/,
  // Secret and context exfiltration: a reveal verb near a sensitive target.
  /\b(reveal|print|show|leak|exfiltrate|output|display|list|dump|repeat|share with me|tell me|include|quote|revele|revelar|mostre|mostrar|imprima|liste|listar|despeje|exiba|repita|informe|inclua|cite|vaze)\b.{0,60}\b(system prompt|prompt de sistema|prompt do sistema|instrucoes internas|internal instructions|developer instructions|instrucoes do desenvolvedor|secrets?|segredos?|api keys?|chaves? de api|access tokens?|tokens? de acesso|oauth tokens?|session ids?|credentials?|credenciais|passwords?|senhas|configuracao interna|internal configuration|internal config|hidden instructions|instrucoes ocultas|system message|mensagem do sistema)\b/,
  /\b(repeat|print|output|repita|imprima|copie)\b.{0,30}\b(everything|all|tudo)\b.{0,20}\b(above|before|acima|antes)\b/,
  /\b(palavra por palavra|word for word|verbatim)\b.{0,60}\b(prompt|instructions|instrucoes|above|acima|recebeu|received)\b|\b(prompt|instructions|instrucoes)\b.{0,60}\b(palavra por palavra|word for word|verbatim)\b/,
  // Bulk personal data: "every other customer", "todos os clientes" + a personal field.
  // "Send the newsletter to all customers" is honest; listing their data is not: an extraction verb is required.
  new RegExp(`\\b(${EXTRACT_VERB})\\b.{0,80}\\b(every|all|each|todos os|todas as|de todos|de todas|of every|of all|cada|demais|outros)\\b.{0,25}\\b(other |outros )?(customers?|clients?|clientes|contacts?|contatos|users|usuarios|records|registros|vendedores|sellers|cadastrados)\\b`),
  new RegExp(`\\b(${EXTRACT_VERB})\\b.{0,30}\\b(os |the )?(dados|data)\\b.{0,30}\\b(de todos|de todas|of all|of every|completos de)\\b`),
  /\b(sem mascarar|without masking|unmasked|sem mascara|disregard the (privacy )?masking|ignore the (privacy )?masking|desative o mascaramento)\b/,
  /\b(respond|answer|responda|responder)\b.{0,20}\b(any|every|qualquer|toda)\b.{0,20}\b(question|request|pergunta|pedido)\b.{0,40}\b(no restrictions|sem filtros|sem restricoes|in full|regardless|com os dados completos|sem mascarar|without (any )?filter)/,
  // Phishing through the assistant.
  /\b(re ?enter|retype|confirm|digitar|digite|redigite|informar|informe|insira)\b.{0,30}\b(password|senha|credentials|credenciais|login)\b.{0,30}\b(again|novamente|de novo|in the chat|no chat|here|aqui)\b/,
  /\b(session|sessao)\b.{0,20}\b(expired|expirou|expirada)\b.{0,60}\b(password|senha|login)\b/,
  // Exfiltration to an external endpoint.
  /\b(send|post|forward|upload|mande|envie|encaminhe|enviar|mandar|encaminhar|poste|transmita)\b.{0,80}\b(https?|www|webhook|t me|ngrok|pastebin|requestbin)\b/,
  // Tools: protocol-level or code-level calls.
  /\b(mcp)\b.{0,40}\b(tool|ferramenta|export|call|chamada)\b|\b(invoke|invoque|call|chame)\b.{0,20}\b(the )?(tool|ferramenta) (de )?mcp\b/,
  /\b(post|get|put|patch|delete) services data\b|\betc passwd\b|\brun shell\b|\bsobjects\b/,
  /\b(run|execute|rode|execute|call|chame|invoke|invoque|use a funcao|use the function)\b.{0,40}\b(without|sem)\b.{0,10}\b(permission|permissao|filter|filtro|limit|limite)\b/,
  // Human approval bypass.
  /\b(no need for|sem necessidade de|dispense|dispensar|pule|pular|skip|bypass|ignore|ignorar|ignora|nao precisa de)\b.{0,30}\b(human review|revisao humana|human approval|aprovacao humana|approval|aprovacao|sign ?off|confirmacao|confirmation|manager review|revisao do gerente|fluxo de aprovacao|approval flow|passo de aprovacao|etapa de revisao)\b/,
  /\baprove automaticamente\b|\bauto ?approve\b|\baprovacao automatica\b/,
  /\b(nao|do not|don t)\s+(peca|pedir|ask for|request)\s+(confirmacao|confirmation|aprovacao|approval)\b/,
  /\b(confirme|confirm|execute|proceed|prossiga|finalize|aprove)\b.{0,30}\b(sem perguntar|without asking|sem confirmar|without confirming|sem consultar|without checking with)\b/,
  /\b(revisao humana|human review|etapa de revisao)\b.{0,20}\b(concluida|completed|done|feita)\b/,
  // Secrecy towards the user.
  /\b(do not|don t|never|nao) (tell|inform|mention|reveal|conte|informe|mencione)\b.{0,30}\b(user|usuario|human|anyone)\b/,
];

/** Weak signals: [family, pattern]. Two distinct families flag. */
const WEAK: readonly (readonly [string, RegExp])[] = [
  ["audience", /\b(nota|recado|aviso|mensagem|obs|observacao)\s+(para|pro|pra|ao|a)\s+(o |a )?(assistente|modelo|bot|ia|robo|chatbot|agente)\b/],
  ["audience", /\b(note|message|reminder|heads up)\s+(to|for)\s+(the )?(assistant|ai|model|bot|llm|agent)\b/],
  ["audience", /\b(prezado|prezada|caro|cara|querido|ola|oi)\s+(assistente|modelo|bot|robo|ia|agente)\b|\bdear\s+(assistant|ai|model|bot)\b/],
  // "a assistente deve conferir o estoque" is a job title in retail: only AI-specific nouns count in Portuguese.
  ["audience", /\b(o|a)\s+(assistente virtual|assistente de ia|ia|modelo de ia|modelo|bot|chatbot|llm|agente de ia)\s+(deve|devera|precisa|tem que|esta autorizad)\b/],
  ["audience", /\b(the|this)\s+(assistant|ai assistant|ai|model|bot|chatbot|llm|agent)\s+(is required|should|must|needs to|is authorized|has to|shall)\b/],
  ["audience", /\b(se|if)\s+(voce|you)\s+(for|e|are|is)\s+(uma?|an?|the)\s+(ia|ai|llm|modelo|model|assistente|assistant|bot|agente|agent|language model)\b/],
  ["audience", /\b(whoever|anyone who|the next reader|next reader)\b.{0,20}\b(reads?|reading)\b|\bquem (estiver )?(lendo|ler)\b|\bproximo leitor\b/],
  ["audience", /\b(atencao|attention)\s+(modelo|model|ia|ai|assistente|assistant|bot)\b/],
  ["audience", /\b(when|while|before)\s+(you )?(summariz|answer|respond|reply|generat)|\b(ao|antes de|quando for)\s+(resumir|responder|gerar)\b/],
  ["tool", /\b(call|invoke|execute|run|chame|invoque|rode|use)\b.{0,30}\b(tool|function|ferramenta|funcao|api|query|consulta|mutation|mutacao)\b/],
  ["grant", /\b(access|acesso)\b.{0,20}\b(granted|allowed|liberado|concedido)\b/],
  ["newrules", /\bnew instructions?\b|\bnovas instrucoes\b|\bnova diretriz\b|\bnew guidelines?\b/],
  ["sensitive", /\b(system prompt|prompt de sistema|prompt do sistema|api key|chave de api|token|credenciais|credentials|senhas|passwords)\b/],
  ["urgency", /\b(urgente|urgent|time sensitive|imediatamente|immediately|asap|ate o fim do dia|by end of day)\b/],
  ["authority", /\b(diretoria|diretor|director|compliance|it support|suporte de ti|gerente regional|regional manager|ceo|security team|equipe de seguranca)\b.{0,60}\b(assistente virtual|ai assistant|the assistant|ai|ia|modelo de ia|bot|chatbot|llm)\b/],
  ["unrestricted", /\bno (policies|restrictions|filters|limits)\b|\bsem (filtros|restricoes|politicas|limites)\b|\bwithout (any )?(filter|restriction)s?\b/],
  ["approve", /\b(mark|set|marque|defina|considere)\b.{0,25}\b(as approved|status approved|como aprovad|aprovado|approved)\b/],
  ["secrecy", /\b(do not|don t|nao)\s+(log|registre|registrar|escalate|escale|record)\b/],
  ["sensitive", /\b(credit card|cartao)\b.{0,15}\b(on file|cadastrado|salvo|armazenado)\b|\b(cpf|ssn)\b/],
];

/** Matched with every non-alphanumeric removed: defeats "i.g.n.o.r.e" spacing. */
const SQUASHED_NEEDLES: readonly string[] = [
  "ignorepreviousinstructions",
  "ignoreallpreviousinstructions",
  "ignoreallinstructions",
  "disregardpreviousinstructions",
  "ignoreasinstrucoes",
  "ignoreasinstrucoesanteriores",
  "revealthesystemprompt",
  "mostreopromptdosistema",
];

/**
 * Code-shaped tool calls, matched on the raw text because folding turns
 * `create_task` into two words: a tool word next to a snake_case name,
 * function-call syntax on a snake_case name, or a JSON tool-call object.
 */
const CODE_TOOL: readonly RegExp[] = [
  /\b(?:tool|function|ferramenta|fun[cç][aã]o|action|a[cç][aã]o)\s+(?:de\s+)?["'`]?[a-z][a-z0-9]*_[a-z0-9_]+/i,
  /\b[a-z][a-z0-9]*_[a-z0-9_]+["'`]?\s+(?:tool|function|ferramenta|fun[cç][aã]o)\b/i,
  // Call syntax only with an imperative before it: "erro ao chamar calc_total()" is a bug report.
  /\b(?:run|call|execute|invoke|use|rode|rodar|chame|execute|executar|invoque|use|also|tamb[eé]m)\b[^.\n]{0,25}\b[a-z][a-z0-9]*_[a-z0-9_]+\s*\(/i,
  /["']\s*(?:tool|function|tool_name|name)\s*["']\s*:\s*["'][a-z][a-z0-9_]*["']/i,
];

/** Chat-template, role and section markers, matched before punctuation is folded away. */
const ROLE_MARKERS =
  /<\|?\s*(?:im_start|im_end|system|endoftext)\s*\|?>|\[\/?INST\]|^\s*(?:system|assistant|developer)\s*:|!\[[^\]]*\]\(\s*https?:|\[\s*(?:system|admin|developer|sistema)\s*\]|^\s*#{2,}\s*(?:instruction|system|instrucao|sistema)\b/im;

/** Digits used as letters inside words ("1gn0r3") are read as letters, for detection only. */
const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };
function unleet(text: string): string {
  return text.replace(/(?<=\p{L})[0134578@$]|[0134578@$](?=\p{L})/gu, (ch) => LEET[ch] ?? ch);
}

function flagsFolded(folded: string): boolean {
  if (STRONG.some((pattern) => pattern.test(folded))) return true;
  const families = new Set<string>();
  for (const [family, pattern] of WEAK) if (pattern.test(folded)) families.add(family);
  return families.size >= 2;
}

function hasInstruction(text: string): boolean {
  if (ROLE_MARKERS.test(text) || CODE_TOOL.some((pattern) => pattern.test(text))) return true;
  const folded = fold(text);
  const leet = fold(unleet(text));
  if (flagsFolded(folded) || (leet !== folded && flagsFolded(leet))) return true;
  const squashed = folded.replace(/ /g, "");
  const squashedLeet = leet.replace(/ /g, "");
  return SQUASHED_NEEDLES.some((needle) => squashed.includes(needle) || squashedLeet.includes(needle));
}

/** Decodes long base64 runs so an encoded instruction is scanned too. */
function decodedBase64Runs(text: string): string {
  const parts: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const decoded = Buffer.from(match[0], "base64").toString("utf8");
    if (!decoded.includes("�")) parts.push(decoded);
  }
  return parts.join("\n");
}

export type SanitizeFinding = "hidden_payload" | "embedded_instruction" | "oversize_chunk";

export interface SanitizeResult {
  /** Visible text with invisible characters, hidden HTML and tags removed. */
  readonly text: string;
  readonly findings: readonly SanitizeFinding[];
}

export function sanitizeChunk(raw: string): SanitizeResult {
  if (raw.length > MAX_CHUNK_CHARS) return { text: "", findings: ["oversize_chunk"] };

  const findings: SanitizeFinding[] = [];
  if (TAG_CHARS.test(raw)) findings.push("hidden_payload");

  // Entities are decoded twice so double-encoded payloads surface.
  const decoded = decodeEntitiesOnce(decodeEntitiesOnce(raw));
  const clean = decoded.replace(INVISIBLE, "").normalize("NFKC");

  const full = clean.replace(/[<>]/g, " ");
  if (hasInstruction(clean) || hasInstruction(full) || hasInstruction(decodedBase64Runs(full))) {
    findings.push("embedded_instruction");
  }

  const text = clean
    .replace(HTML_COMMENT, " ")
    .replace(NON_TEXT_BLOCK, " ")
    .replace(HIDDEN_ELEMENT, " ")
    .replace(ANY_TAG, " ")
    // Leftover angle brackets are neutralized so text cannot forge a tag or envelope.
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\s+/g, " ")
    .trim();

  return { text, findings };
}

/** Strips invisible characters from trusted-principal input such as the query. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "").normalize("NFKC");
}
