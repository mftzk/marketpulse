import { createHash } from "node:crypto";

import type { EventType } from "@/lib/core/event-types";

/**
 * Deduplication (§6.6). Pure functions.
 *
 * Article fingerprint: `sha256(ticker|provider|url-or-headline|published_date_hour)`
 * for raw storage. Event clustering: two classifications belong to the same
 * canonical event when they share the same primary ticker AND the same
 * event_type AND `|published_at delta| ≤ 90 min` AND
 * (`tokenJaccard(headline) ≥ 0.45` OR `trigramSimilarity(headline) ≥ 0.6`).
 *
 * Token normalisation: lowercase, strip punctuation/stopwords, drop number-only
 * tokens, keep cashtags. Canonical event = the member with the highest
 * `(source_quality, -age)`; its headline/summary come from that member;
 * `article_count` = cluster size; every member is linked with its similarity;
 * `is_primary` goes to the earliest article.
 */

export interface DedupeClassification {
  /** Primary ticker (uppercase) or null. */
  ticker: string | null;
  eventType: EventType;
  headline: string;
  summary: string | null;
  publishedAt: Date;
  sourceQuality: number;
  /** Identity of the member (article id or index). */
  id: string;
}

export interface EventCluster {
  /** Canonical member id. */
  canonicalId: string;
  ticker: string | null;
  eventType: EventType;
  headline: string;
  summary: string | null;
  articleCount: number;
  members: { id: string; similarity: number; isPrimary: boolean; publishedAt: Date }[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "by",
  "at",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "its",
  "it",
  "that",
  "this",
  "these",
  "those",
  "after",
  "before",
  "into",
  "over",
  "under",
  "new",
  "says",
  "said",
  "reports",
  "reported",
  "amid",
]);

function stripPunctuation(text: string): string {
  return text.replace(/[^\p{L}\p{N}$]+/gu, " ");
}

/**
 * Normalises a headline into a set of tokens: lowercase, punctuation stripped,
 * stopwords removed, number-only tokens dropped, cashtags preserved.
 */
export function normalizeTokens(text: string): string[] {
  const cleaned = stripPunctuation(text.toLowerCase());
  return cleaned
    .split(/\s+/)
    .filter((token) => {
      if (token.length === 0) {
        return false;
      }
      if (STOPWORDS.has(token)) {
        return false;
      }
      if (/^\d+$/.test(token)) {
        return false;
      }
      return true;
    });
}

/** Jaccard similarity over token sets (0..1). */
export function tokenJaccard(a: string, b: string): number {
  const setA = new Set(normalizeTokens(a));
  const setB = new Set(normalizeTokens(b));
  if (setA.size === 0 && setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(text: string): string[] {
  const tokens = normalizeTokens(text).join(" ");
  const padded = `  ${tokens} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    out.push(padded.slice(i, i + 3));
  }
  return out;
}

/** Trigram (character) similarity (0..1). */
export function trigramSimilarity(a: string, b: string): number {
  const triA = trigrams(a);
  const triB = trigrams(b);
  if (triA.length === 0 || triB.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const tri of triA) {
    counts.set(tri, (counts.get(tri) ?? 0) + 1);
  }
  let intersection = 0;
  for (const tri of triB) {
    const remaining = counts.get(tri) ?? 0;
    if (remaining > 0) {
      intersection += 1;
      counts.set(tri, remaining - 1);
    }
  }
  return (2 * intersection) / (triA.length + triB.length);
}

/** Raw article fingerprint: sha256 hex of the given components. */
export function articleFingerprint(components: string[]): string {
  return createHash("sha256").update(components.join("|")).digest("hex");
}

function sameEvent(a: DedupeClassification, b: DedupeClassification): boolean {
  if (a.ticker === null || b.ticker === null || a.ticker !== b.ticker) {
    return false;
  }
  if (a.eventType !== b.eventType) {
    return false;
  }
  const delta = Math.abs(a.publishedAt.getTime() - b.publishedAt.getTime());
  if (delta > 90 * 60_000) {
    return false;
  }
  return tokenJaccard(a.headline, b.headline) >= 0.45 || trigramSimilarity(a.headline, b.headline) >= 0.6;
}

/**
 * Groups classifications into canonical event clusters. Members are ordered so
 * the canonical member (highest `(source_quality, -age)`) determines the
 * cluster headline/summary; `is_primary` marks the earliest article.
 */
export function clusterEvents(entries: DedupeClassification[]): EventCluster[] {
  const clusters: EventCluster[] = [];

  for (const entry of entries) {
    let target: EventCluster | null = null;
    for (const cluster of clusters) {
      const representative = cluster.members
        .map((m) => entries.find((e) => e.id === m.id))
        .find((e) => e !== undefined);
      if (representative && sameEvent(representative, entry)) {
        target = cluster;
        break;
      }
    }

    if (target === null) {
      clusters.push({
        canonicalId: entry.id,
        ticker: entry.ticker,
        eventType: entry.eventType,
        headline: entry.headline,
        summary: entry.summary,
        articleCount: 1,
        members: [{ id: entry.id, similarity: 1, isPrimary: true, publishedAt: entry.publishedAt }],
      });
      continue;
    }

    const canonical = entries.find((e) => e.id === target?.canonicalId);
    const representative = canonical ?? entries.find((e) => e.id === target?.members[0].id);
    const similarity =
      representative !== undefined
        ? Math.max(tokenJaccard(representative.headline, entry.headline), trigramSimilarity(representative.headline, entry.headline))
        : 0;

    target.members.push({
      id: entry.id,
      similarity,
      isPrimary: false,
      publishedAt: entry.publishedAt,
    });

    // Canonical = highest (source_quality, then -age).
    let best = canonical ?? representative;
    for (const member of target.members) {
      const candidate = entries.find((e) => e.id === member.id);
      if (!candidate) {
        continue;
      }
      if (
        !best ||
        candidate.sourceQuality > best.sourceQuality ||
        (candidate.sourceQuality === best.sourceQuality &&
          candidate.publishedAt.getTime() > best.publishedAt.getTime())
      ) {
        best = candidate;
      }
    }
    if (best) {
      target.canonicalId = best.id;
      target.headline = best.headline;
      target.summary = best.summary;
      target.ticker = best.ticker;
      target.eventType = best.eventType;
    }
  }

  for (const cluster of clusters) {
    cluster.articleCount = cluster.members.length;
    const sorted = [...cluster.members].sort(
      (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
    );
    const earliestId = sorted[0]?.id;
    cluster.members = sorted.map((m) => ({ ...m, isPrimary: m.id === earliestId }));
  }

  return clusters;
}

/**
 * Dedupe cache bucket for a ticker/event-type pair: the hour bucket of the
 * publication time (used to short-circuit repeat classification).
 */
export function dedupeBucket(publishedAt: Date): string {
  const d = new Date(publishedAt);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
