/**
 * Deterministic PII masker (Module 3, Trust Layer bridge). Pure: no I/O, no dependencies.
 *
 * Every pattern is a flat sequence of bounded, optional single-character separators between
 * digit groups, anchored by lookarounds, so matching is linear in the input length (no nested
 * quantifiers on overlapping classes). Numeric kinds are masked only after a checksum
 * (CPF, CNPJ, Luhn) or a structural rule (phone) passes.
 *
 * Application order: email, card, CNPJ, CPF, phone. Email goes first so a digit run inside an
 * address ("12345678909@x.com") cannot be split by a numeric kind and leave half the address
 * behind. Placeholders hold no digits, "@" or "+", so no later pass can re-mask them.
 */

export type PiiKind = "cpf" | "cnpj" | "email" | "phone" | "card";

export interface MaskResult {
  readonly text: string;
  readonly found: readonly PiiKind[];
}

const KIND_ORDER: readonly PiiKind[] = ["cpf", "cnpj", "email", "phone", "card"];

const PLACEHOLDER: Readonly<Record<PiiKind, string>> = {
  cpf: "[CPF]",
  cnpj: "[CNPJ]",
  email: "[EMAIL]",
  phone: "[PHONE]",
  card: "[CARD]",
};

// A numeric token must not touch a letter, digit or underscore, and must not continue a longer
// dotted/dashed/slashed numeric chain (dates, versions, other documents).
const NOT_AFTER = String.raw`(?<![\p{L}\p{N}_])(?<!\d[.\-/])`;
const NOT_BEFORE = String.raw`(?![\p{L}\p{N}_])(?![.\-/]\d)`;

const CPF_RE = new RegExp(
  `${NOT_AFTER}\\d{3}[.\\- ]?\\d{3}[.\\- ]?\\d{3}[.\\- ]?\\d{2}${NOT_BEFORE}`,
  "gu",
);
const CNPJ_RE = new RegExp(
  `${NOT_AFTER}\\d{2}[.\\- ]?\\d{3}[.\\- ]?\\d{3}[/.\\- ]?\\d{4}[.\\- ]?\\d{2}${NOT_BEFORE}`,
  "gu",
);
// 13-19 digits, single space or hyphen between digits. Not after "+" (international phone).
const CARD_RE = new RegExp(
  `${NOT_AFTER}(?<!\\+)\\d(?:[ \\-]?\\d){12,18}(?![\\p{L}\\p{N}_])(?!-\\d)`,
  "gu",
);
const EMAIL_RE =
  /(?<![\p{L}\p{N}._%+\-])[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}\-]+(?:\.[\p{L}\p{N}\-]+)*\.\p{L}{2,}/gu;
// Optional 55 country code, DDD (bare or in parentheses), 4-5 digit prefix, 4 digit line.
const BR_PHONE_RE = new RegExp(
  `${NOT_AFTER}(?:\\+?55[ .\\-]?)?(?:\\(\\d{2}\\)|\\d{2})[ .\\-]?\\d{4,5}[ \\-]?\\d{4}${NOT_BEFORE}`,
  "gu",
);
// "+" country code followed by 7-14 more digits (8-15 in total), single separators or parentheses.
const INTL_PHONE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])\\+\\d(?:(?:[ .\\-]?\\(|\\)[ .\\-]?|[ .\\-])?\\d){7,14}(?![\\p{L}\\p{N}_])`,
  "gu",
);

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

function digitAt(d: string, i: number): number {
  return d.charCodeAt(i) - 48;
}

function allSame(d: string): boolean {
  return /^(\d)\1*$/.test(d);
}

function cpfValid(d: string): boolean {
  if (d.length !== 11 || allSame(d)) return false;
  for (const t of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += digitAt(d, i) * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== digitAt(d, t)) return false;
  }
  return true;
}

const CNPJ_W1: readonly number[] = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2: readonly number[] = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function cnpjValid(d: string): boolean {
  if (d.length !== 14 || allSame(d)) return false;
  for (const [t, w] of [
    [12, CNPJ_W1],
    [13, CNPJ_W2],
  ] as const) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += digitAt(d, i) * (w[i] ?? 0);
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== digitAt(d, t)) return false;
  }
  return true;
}

function luhnValid(d: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = digitAt(d, i);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function cardValid(d: string): boolean {
  if (d.length < 13 || d.length > 19 || allSame(d) || !luhnValid(d)) return false;
  // A 14-digit run that is a valid CNPJ is a CNPJ, even if it also passes Luhn.
  return !(d.length === 14 && cnpjValid(d));
}

function brPhoneValid(m: string): boolean {
  const hasPlus = m.startsWith("+");
  let d = digitsOf(m);
  if (d.startsWith("55") && (hasPlus || d.length > 11)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/^[1-9][1-9]$/.test(d.slice(0, 2))) return false;
  const third = d.charAt(2);
  if (d.length === 11) return third === "9";
  // 10-digit landline: needs a formatting marker, a bare 10-digit run is too often an order number.
  return /[2-5]/.test(third) && (hasPlus || m.includes("(") || m.includes("-"));
}

export function maskPii(text: string): MaskResult {
  const hits = new Set<PiiKind>();
  const replaceWith = (
    input: string,
    re: RegExp,
    kind: PiiKind,
    valid: (m: string) => boolean,
  ): string =>
    input.replace(re, (m) => {
      if (!valid(m)) return m;
      hits.add(kind);
      return PLACEHOLDER[kind];
    });

  let out = text;
  out = replaceWith(out, EMAIL_RE, "email", () => true);

  out = out.replace(CARD_RE, (m) => {
    const pos: number[] = [];
    for (let i = 0; i < m.length; i++) {
      const c = m.charCodeAt(i);
      if (c >= 48 && c <= 57) pos.push(i);
    }
    // Longest valid prefix that does not end in the middle of a digit run.
    for (let n = pos.length; n >= 13; n--) {
      const end = (pos[n - 1] ?? 0) + 1;
      if (n < pos.length) {
        const next = m.charCodeAt(end);
        if (next >= 48 && next <= 57) continue;
      }
      if (cardValid(digitsOf(m.slice(0, end)))) {
        hits.add("card");
        return PLACEHOLDER.card + m.slice(end);
      }
    }
    return m;
  });

  out = replaceWith(out, CNPJ_RE, "cnpj", (m) => cnpjValid(digitsOf(m)));
  out = replaceWith(out, CPF_RE, "cpf", (m) => cpfValid(digitsOf(m)));
  out = replaceWith(out, BR_PHONE_RE, "phone", brPhoneValid);
  out = replaceWith(out, INTL_PHONE_RE, "phone", () => true);

  return { text: out, found: KIND_ORDER.filter((k) => hits.has(k)) };
}
