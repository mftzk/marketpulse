/** Parse only explicit fiscal labels from the article; missing periods stay null. */
export function fiscalPeriodFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ");
  const quarterFirst = normalized.match(/\bQ([1-4])\s*(?:FY\s*)?(20\d{2})\b/i);
  if (quarterFirst) return `${quarterFirst[2]}-Q${quarterFirst[1]}`;
  const yearFirst = normalized.match(/\b(20\d{2})\s*[-/]?\s*Q([1-4])\b/i);
  if (yearFirst) return `${yearFirst[1]}-Q${yearFirst[2]}`;
  const year = normalized.match(/\bFY\s*(20\d{2})\b/i);
  return year ? `${year[1]}-FY` : null;
}
