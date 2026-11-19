import assert from "node:assert/strict";
import { test } from "node:test";

import { maskPii } from "../src/trust/pii.ts";

let counter = 0;
function t(name: string, fn: () => void): void {
  counter += 1;
  test(`P${String(counter).padStart(2, "0")} ${name}`, fn);
}

// Independent generators (test-side re-implementation of the public algorithms).
function genCpf(base9: string): string {
  const d = base9.split("").map(Number);
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += (d[i] ?? 0) * (len + 1 - i);
    d.push(((sum * 10) % 11) % 10);
  }
  return d.join("");
}

function genCnpj(base12: string): string {
  const d = base12.split("").map(Number);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const w of [w1, w2]) {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += (d[i] ?? 0) * (w[i] ?? 0);
    const r = sum % 11;
    d.push(r < 2 ? 0 : 11 - r);
  }
  return d.join("");
}

function luhnOk(s: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = Number(s[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function genCard(prefix: string, length: number): string {
  for (let c = 0; c < 10; c++) {
    const candidate = prefix + "0".repeat(length - prefix.length - 1) + String(c);
    if (luhnOk(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

function fmtCpf(d: string): string {
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function fmtCnpj(d: string): string {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

const CPF = genCpf("123456789"); // 12345678909
const CPF2 = genCpf("987654321"); // 98765432100
const CNPJ = genCnpj("123456780001"); // 12345678000195
const VISA = "4111111111111111"; // Luhn-valid test PAN
const group4 = (s: string): string => s.match(/.{1,4}/g)!.join(" ");

function unchanged(input: string): void {
  const r = maskPii(input);
  assert.equal(r.text, input);
  assert.deepEqual(r.found, []);
}

t("generators agree with the well-known valid numbers", () => {
  assert.equal(CPF, "12345678909");
  assert.equal(CNPJ, "12345678000195");
  assert.ok(luhnOk(VISA));
});

// ---- CPF ----
t("CPF formatted with dots and dash", () => {
  assert.deepEqual(maskPii("123.456.789-09"), { text: "[CPF]", found: ["cpf"] });
});
t("CPF bare 11 digits", () => {
  assert.deepEqual(maskPii("12345678909"), { text: "[CPF]", found: ["cpf"] });
});
t("CPF separated by spaces", () => {
  assert.deepEqual(maskPii("123 456 789 09"), { text: "[CPF]", found: ["cpf"] });
});
t("CPF generated for another base", () => {
  assert.deepEqual(maskPii(fmtCpf(CPF2)), { text: "[CPF]", found: ["cpf"] });
});
t("CPF with wrong check digits is left alone", () => {
  unchanged("123.456.789-10");
  unchanged("12345678900");
  unchanged("123 456 789 08");
});
t("CPF all-same-digit sequences are rejected", () => {
  unchanged("111.111.111-11");
  unchanged("00000000000");
  unchanged("999.999.999-99");
});

// ---- CNPJ ----
t("CNPJ formatted", () => {
  assert.deepEqual(maskPii("12.345.678/0001-95"), { text: "[CNPJ]", found: ["cnpj"] });
});
t("CNPJ bare 14 digits", () => {
  assert.deepEqual(maskPii(CNPJ), { text: "[CNPJ]", found: ["cnpj"] });
});
t("CNPJ generated for another base", () => {
  const c = genCnpj("987654320001");
  assert.deepEqual(maskPii(fmtCnpj(c)), { text: "[CNPJ]", found: ["cnpj"] });
});
t("CNPJ with wrong check digits is left alone", () => {
  unchanged("12.345.678/0001-96");
  unchanged("12345678000100");
});
t("CNPJ all-same digits rejected", () => {
  unchanged("11.111.111/1111-11");
  unchanged("00000000000000");
});
t("CNPJ is masked as a whole, never as CPF fragments", () => {
  const r = maskPii(`CNPJ ${fmtCnpj(CNPJ)}`);
  assert.equal(r.text, "CNPJ [CNPJ]");
  assert.deepEqual(r.found, ["cnpj"]);
});

// ---- Card ----
t("card with spaces", () => {
  assert.deepEqual(maskPii("4111 1111 1111 1111"), { text: "[CARD]", found: ["card"] });
});
t("card with hyphens", () => {
  assert.deepEqual(maskPii("4111-1111-1111-1111"), { text: "[CARD]", found: ["card"] });
});
t("card contiguous 16 digits", () => {
  assert.deepEqual(maskPii(VISA), { text: "[CARD]", found: ["card"] });
});
t("card Amex 15 digits grouped 4-6-5", () => {
  assert.deepEqual(maskPii("3782 822463 10005"), { text: "[CARD]", found: ["card"] });
});
t("card 13 and 19 digits", () => {
  const c13 = genCard("4222", 13);
  const c19 = genCard("6304", 19);
  assert.equal(c13.length, 13);
  assert.equal(c19.length, 19);
  assert.deepEqual(maskPii(c13), { text: "[CARD]", found: ["card"] });
  assert.deepEqual(maskPii(group4(c19)), { text: "[CARD]", found: ["card"] });
});
t("card failing Luhn is left alone", () => {
  unchanged("4111 1111 1111 1112");
  unchanged("4111111111111110");
  unchanged("1234567890123456");
});
t("card with 12 or 20 digits is not a card", () => {
  const c12 = genCard("4111", 12);
  assert.ok(luhnOk(c12));
  unchanged(c12);
  const c20 = genCard("4111", 20);
  unchanged(c20);
});
t("14-digit run valid as both CNPJ and Luhn is a CNPJ", () => {
  let found: string | undefined;
  for (let i = 0; i < 2000 && found === undefined; i++) {
    const c = genCnpj(String(100000000000 + i * 7919).slice(0, 12));
    if (luhnOk(c)) found = c;
  }
  assert.ok(found, "need a CNPJ that also passes Luhn");
  assert.deepEqual(maskPii(found), { text: "[CNPJ]", found: ["cnpj"] });
});

// ---- Email ----
t("email simple", () => {
  assert.deepEqual(maskPii("maria@loja.com"), { text: "[EMAIL]", found: ["email"] });
});
t("email with plus tag", () => {
  assert.deepEqual(maskPii("maria.silva+crm@loja.com.br"), { text: "[EMAIL]", found: ["email"] });
});
t("email with subdomains and uppercase", () => {
  assert.deepEqual(maskPii("JOAO_99@mail.eu.exemplo.com.br"), { text: "[EMAIL]", found: ["email"] });
});
t("email before sentence-ending period", () => {
  assert.equal(maskPii("Write to ana@loja.com.").text, "Write to [EMAIL].");
});
t("email whose local part looks like a CPF is masked whole", () => {
  const r = maskPii(`${CPF}@loja.com`);
  assert.equal(r.text, "[EMAIL]");
  assert.deepEqual(r.found, ["email"]);
});
t("text with @ but no address is left alone", () => {
  unchanged("meet @ 5pm, @maria says hi, user@ host, a@b");
});

// ---- Phone ----
t("phone +55 with DDD and hyphen", () => {
  assert.deepEqual(maskPii("+55 11 91234-5678"), { text: "[PHONE]", found: ["phone"] });
});
t("phone with parenthesised DDD, mobile and landline", () => {
  assert.deepEqual(maskPii("(11) 91234-5678"), { text: "[PHONE]", found: ["phone"] });
  assert.deepEqual(maskPii("(21) 3456-7890"), { text: "[PHONE]", found: ["phone"] });
});
t("phone bare 11 digits", () => {
  assert.deepEqual(maskPii("11912345678"), { text: "[PHONE]", found: ["phone"] });
});
t("phone with country code and no plus, bare and spaced", () => {
  assert.deepEqual(maskPii("5511912345678"), { text: "[PHONE]", found: ["phone"] });
  assert.deepEqual(maskPii("11 91234 5678"), { text: "[PHONE]", found: ["phone"] });
});
t("phone landline with +55 and spaces", () => {
  assert.deepEqual(maskPii("+55 21 3456 7890"), { text: "[PHONE]", found: ["phone"] });
});
t("phone international formats", () => {
  for (const p of ["+1 202 555 0143", "+44 20 7946 0958", "+351 912 345 678", "+1 (202) 555-0143", "+49-30-123456"]) {
    assert.deepEqual(maskPii(p), { text: "[PHONE]", found: ["phone"] }, p);
  }
});
t("international with fewer than 8 or more than 15 digits is left alone", () => {
  unchanged("+1 234 567");
  unchanged("+1234567890123456");
});
t("0800 numbers are not personal", () => {
  unchanged("0800 123 4567");
  unchanged("Ligue 0800 123 4567 para suporte");
  unchanged("08001234567");
});

// ---- Must not mask ----
t("dates are not masked", () => {
  unchanged("Entrega em 14/11/2026");
  unchanged("14-11-2026 e 2026-11-14");
  unchanged("14.11.2026");
});
t("times are not masked", () => {
  unchanged("Atendimento das 09:30 às 18:45:10");
});
t("money is not masked", () => {
  unchanged("Total R$ 1.234,56");
  unchanged("Total R$ 12.345.678,90");
  unchanged("USD 1,234,567.89");
});
t("order numbers are not masked", () => {
  unchanged("Pedido #4471");
  unchanged("Order #20261114 shipped");
  unchanged("Pedido nº 12345");
});
t("CEP is not masked", () => {
  unchanged("CEP 01310-100");
  unchanged("Av. Paulista, 1000, 01310-100, São Paulo");
});
t("invoice numbers failing CPF, CNPJ and Luhn are not masked", () => {
  assert.ok(!luhnOk("1234567890123456") && !luhnOk("12345678000197"));
  unchanged("NF 12345678901");
  unchanged("NF-e 12345678000197");
  unchanged("Nota 1234567890123456");
});
t("10-digit bare run is not a phone", () => {
  unchanged("Protocolo 2134567890");
});
t("digits glued to letters are not PII", () => {
  unchanged("ABC12345678909");
  unchanged("12345678909X");
  unchanged("ref_12345678909");
  unchanged("SKU12.345.678/0001-95");
  unchanged(`ABC${VISA}`);
});
t("numeric chains longer than the document are not partially masked", () => {
  unchanged("1.123.456.789-09");
  unchanged("123.456.789-09.5");
});

// ---- Combination, context, ordering ----
t("multiple PII kinds in one text", () => {
  const input = `CPF ${fmtCpf(CPF)}, CNPJ ${fmtCnpj(CNPJ)}, e-mail ana@loja.com, tel (11) 91234-5678, cartão ${group4(VISA)}.`;
  const r = maskPii(input);
  assert.equal(r.text, "CPF [CPF], CNPJ [CNPJ], e-mail [EMAIL], tel [PHONE], cartão [CARD].");
  assert.deepEqual(r.found, ["cpf", "cnpj", "email", "phone", "card"]);
});
t("repeated occurrences of the same kind are all masked", () => {
  const r = maskPii(`${fmtCpf(CPF)} e ${fmtCpf(CPF2)} e ${CPF}`);
  assert.equal(r.text, "[CPF] e [CPF] e [CPF]");
  assert.deepEqual(r.found, ["cpf"]);
});
t("PII adjacent to punctuation", () => {
  assert.equal(maskPii(`(CPF: ${fmtCpf(CPF)}).`).text, "(CPF: [CPF]).");
  assert.equal(maskPii(`"${CPF}",`).text, '"[CPF]",');
  assert.equal(maskPii("<ana@loja.com>;").text, "<[EMAIL]>;");
  assert.equal(maskPii("tel:(11) 91234-5678!").text, "tel:[PHONE]!");
  assert.equal(maskPii(`${fmtCpf(CPF)},${fmtCnpj(CNPJ)}`).text, "[CPF],[CNPJ]");
});
t("PII across line breaks and tabs", () => {
  const r = maskPii(`Nome: Ana\nCPF: ${CPF}\r\nEmail:\tana@loja.com\n\n+55 11 91234-5678\n`);
  assert.equal(r.text, "Nome: Ana\nCPF: [CPF]\r\nEmail:\t[EMAIL]\n\n[PHONE]\n");
});
t("card groups do not span line breaks", () => {
  const r = maskPii("4111 1111\n1111 1111");
  assert.equal(r.text, "4111 1111\n1111 1111");
});
t("found is unique and in stable canonical order", () => {
  const a = maskPii(`${VISA} ana@loja.com (11) 91234-5678 ${CPF} ${CPF2} +1 202 555 0143`);
  assert.deepEqual(a.found, ["cpf", "email", "phone", "card"]);
  const b = maskPii(`${CPF} (11) 91234-5678 ana@loja.com ${VISA}`);
  assert.deepEqual(b.found, a.found);
});
t("empty and PII-free text", () => {
  assert.deepEqual(maskPii(""), { text: "", found: [] });
  unchanged("Cliente pediu troca do tamanho M para G.");
});
t("existing placeholders are never re-masked", () => {
  unchanged("[CPF] [CNPJ] [EMAIL] [PHONE] [CARD]");
  assert.equal(maskPii(`[CPF] ${CPF}`).text, "[CPF] [CPF]");
});
t("idempotence", () => {
  const samples = [
    `CPF ${fmtCpf(CPF)} CNPJ ${fmtCnpj(CNPJ)}`,
    `${VISA} ${group4(VISA)} ${CPF}${CPF2}`,
    "ana@loja.com ana+x@a.b.co (11) 91234-5678 +1 (202) 555-0143",
    "Pedido #4471 em 14/11/2026 total R$ 1.234,56 CEP 01310-100",
    `ABC${CPF} 0800 123 4567 4111 1111 1111 1112`,
    `${CPF} 12 ${VISA} 5 itens`,
    "",
  ];
  for (const s of samples) {
    const once = maskPii(s);
    const twice = maskPii(once.text);
    assert.equal(twice.text, once.text, s);
    assert.deepEqual(twice.found, []);
  }
});

// ---- Performance (linear time) ----
t("20,000-char adversarial inputs finish in under 200 ms each", () => {
  const n = 20_000;
  const cases: Record<string, string> = {
    digits: "1".repeat(n),
    digitsAndSeparators: "1 2-3.4/5 ".repeat(n / 10),
    dashedDigits: "12-".repeat(n / 3),
    dottedDigits: "123.".repeat(n / 4),
    spacedDigits: "4 ".repeat(n / 2),
    localPart: "a".repeat(n),
    localPartAt: `${"a.".repeat(n / 2 - 1)}@`,
    domainDots: `a@${"b.".repeat(n / 2 - 2)}1`,
    manyAt: "a@".repeat(n / 2),
    plusRuns: "+1 ".repeat(n / 3),
    plusDigits: `+${"1 ".repeat(n / 2 - 1)}`,
    parens: "(1)".repeat(n / 3),
    validLookalikes: `${CPF} `.repeat(Math.floor(n / 12)),
  };
  for (const [name, input] of Object.entries(cases)) {
    const start = performance.now();
    const r = maskPii(input);
    const ms = performance.now() - start;
    assert.ok(ms < 200, `${name}: ${ms.toFixed(1)} ms`);
    assert.equal(typeof r.text, "string");
  }
});

// ---- Small-retail CRM sentences ----
t("Portuguese CRM note", () => {
  const input = `Cliente Ana Souza (CPF ${fmtCpf(CPF)}) pediu 2ª via da nota fiscal 12345678901 do pedido #4471, pago em 14/11/2026 no valor de R$ 1.234,56. Contato: ana.souza+loja@exemplo.com.br ou (11) 91234-5678. CEP 01310-100.`;
  assert.equal(
    maskPii(input).text,
    "Cliente Ana Souza (CPF [CPF]) pediu 2ª via da nota fiscal 12345678901 do pedido #4471, pago em 14/11/2026 no valor de R$ 1.234,56. Contato: [EMAIL] ou [PHONE]. CEP 01310-100.",
  );
});
t("Portuguese CRM note with company and card", () => {
  const input = `Faturar para ${fmtCnpj(CNPJ)}; cartão final ${group4(VISA)}. SAC 0800 123 4567, WhatsApp +55 11 91234-5678.`;
  const r = maskPii(input);
  assert.equal(r.text, "Faturar para [CNPJ]; cartão final [CARD]. SAC 0800 123 4567, WhatsApp [PHONE].");
  assert.deepEqual(r.found, ["cnpj", "phone", "card"]);
});
t("English CRM note", () => {
  const input = `Customer John Doe called from +1 202 555 0143 about order #20261114 (total $1,234.56, 11/14/2026). Reply to john.doe+orders@shop.example.co.uk. Tax ID ${CPF}.`;
  const r = maskPii(input);
  assert.equal(
    r.text,
    "Customer John Doe called from [PHONE] about order #20261114 (total $1,234.56, 11/14/2026). Reply to [EMAIL]. Tax ID [CPF].",
  );
  assert.deepEqual(r.found, ["cpf", "email", "phone"]);
});
t("English CRM note without PII is untouched", () => {
  unchanged("Loyalty tier upgraded to Gold on 2026-11-14 after 12 purchases; next visit expected in 30 days.");
});
