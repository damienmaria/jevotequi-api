import type { Candidate } from '../domain/types';

/**
 * §24: deterministic, justifiable ordering.
 *
 * `candidate.id` is never a tie-breaker. A sequential id encodes insertion
 * order; UUIDv7 is time-ordered and encodes it too. The prohibition is about
 * the ordering, not the identifier format.
 */

/**
 * Locale-independent comparison on `normalizedName`.
 *
 * `String.prototype.localeCompare` depends on the runtime's ICU data, which
 * would make ordering environment-dependent and break §4. `normalizedName` is
 * produced once, at data load time, already lowercased and stripped of
 * diacritics, so a plain code-unit comparison is both stable and correct.
 */
export function compareNormalizedName(a: Candidate, b: Candidate): number {
  if (a.normalizedName < b.normalizedName) return -1;
  if (a.normalizedName > b.normalizedName) return 1;
  return 0;
}

/**
 * §24, default order outside the results: the official order published by the
 * authority, falling back to alphabetical when no official order exists.
 *
 * Candidates carrying an official order always precede those without one, so
 * that a partially filled `officialOrder` cannot produce an interleaving that
 * depends on insertion order.
 */
export function compareCandidatesDefault(a: Candidate, b: Candidate): number {
  const aHas = a.officialOrder !== null;
  const bHas = b.officialOrder !== null;

  if (aHas && bHas && a.officialOrder !== b.officialOrder) {
    return (a.officialOrder as number) - (b.officialOrder as number);
  }
  if (aHas !== bHas) return aHas ? -1 : 1;

  return compareNormalizedName(a, b);
}

/**
 * Assigns competition-style ranks over a list already sorted by descending
 * score: equal scores share a rank, and the next distinct score skips the ranks
 * consumed by the tie (1, 2, 2, 4).
 */
export function assignRanks<T>(
  sorted: readonly T[],
  scoreOf: (item: T) => number,
): number[] {
  const ranks: number[] = [];
  let currentRank = 1;

  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && scoreOf(sorted[i]) !== scoreOf(sorted[i - 1])) {
      currentRank = i + 1;
    }
    ranks.push(currentRank);
  }

  return ranks;
}
