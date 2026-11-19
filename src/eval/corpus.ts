/** Injection-detector corpus shape and validation. Pure. */
export interface CorpusItem {
  readonly id: string;
  readonly lang: string;
  readonly category: string;
  readonly text: string;
}

export function parseCorpusItems(raw: unknown, label: string): CorpusItem[] {
  if (!Array.isArray(raw)) throw new Error(`${label}: expected an array`);
  const seen = new Set<string>();
  return raw.map((item: unknown, index) => {
    const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const { id, lang, category, text } = o;
    if (typeof id !== "string" || typeof lang !== "string" || typeof category !== "string" || typeof text !== "string") {
      throw new Error(`${label}[${index}]: id, lang, category and text must be strings`);
    }
    if (seen.has(id)) throw new Error(`${label}: duplicate id ${id}`);
    seen.add(id);
    return { id, lang, category, text };
  });
}
