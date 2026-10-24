// A claim is what a gate ships as: its tier, window, slack bound and
// provisional bound. This module decides which claims a year of evidence
// supports, and applies the design's stability rule: a demotion lands from
// the first grid point that shows it, and a promotion only once two
// consecutive grid points support it. Only the parts of a promotion that
// improve must clear their boundaries by a margin; the rest need only hold.
// A promotion never quotes a larger 60-day bound, so that quote never grows.
import {
  BAR,
  NO_MARGIN,
  PROMOTION_MARGIN,
  RECIPE_WINDOWS,
  atMost,
  disqualifier,
  failingMedian,
  missOf,
  roundUpTo5,
  windowVerdict,
  type Evaluation,
  type Margin,
  type Miss,
  type WindowEval,
} from "./derive.ts";

export type Tier = "final" | "bounded" | "online";

export interface Claim {
  tier: Tier;
  /** 60 or 210 for a fitted tier; absent online. */
  days?: number;
  /** A bounded claim's slack bound, minutes. */
  bound?: number;
  /** A 210-day claim's provisional bound for its 60-day fit, minutes. */
  provisional?: number;
}

/** A claim in slackwater-database's `chs_fit` shape, without the curated `miss_context` and `evidence`. */
export interface ChsFit {
  tier: Tier;
  days?: number;
  slack_bound_minutes?: number;
  provisional_slack_minutes?: number;
  miss?: Miss;
}

export type Change = "fresh" | "kept" | "promoted" | "demoted";

const RANK: Record<Tier, number> = { final: 0, bounded: 1, online: 2 };

/** Negative when `a` is the stronger claim: a better tier, then a lower bound, then a shorter window, then a provisional answer, smaller first. */
export function compareClaims(a: Claim, b: Claim): number {
  if (RANK[a.tier] !== RANK[b.tier]) return RANK[a.tier] - RANK[b.tier];
  if (a.tier === "online") return 0;
  const bound = (a.bound ?? 0) - (b.bound ?? 0);
  if (bound !== 0) return bound;
  const days = (a.days ?? 0) - (b.days ?? 0);
  if (days !== 0) return days;
  if (a.provisional === b.provisional) return 0;
  if (a.provisional === undefined) return 1;
  if (b.provisional === undefined) return -1;
  return a.provisional - b.provisional;
}

/**
 * The smallest provisional bound a 60-day window supports for a 210-day claim
 * whose own bound is `claimBound`, or undefined when the 60-day fit doesn't
 * qualify: it must pass every clause of the bounded tier. Under a margin the
 * raw worst must sit at least that far under the bound.
 */
export function provisionalFor(
  w60: WindowEval,
  claimBound: number | undefined,
  margin: Margin,
): number | undefined {
  if (disqualifier(w60) || failingMedian(w60, margin) || w60.worst_slack_min === null) {
    return undefined;
  }
  const p = Math.max(roundUpTo5(w60.worst_slack_min + margin.minutes), claimBound ?? 0);
  return p <= BAR.boundedWorstMin ? p : undefined;
}

/** Whether an evaluation supports a claim, with every boundary tightened by `margin`. */
export function supports(e: Evaluation, claim: Claim, margin: Margin): boolean {
  if (claim.tier === "online") return true;
  if (claim.days !== 60 && claim.days !== 210) return false;
  const w = e[claim.days];
  if (!w || disqualifier(w) || failingMedian(w, margin) || w.worst_slack_min === null) {
    return false;
  }
  const limit = claim.tier === "final" ? BAR.finalWorstMin : claim.bound;
  if (limit === undefined || !atMost(w.worst_slack_min, limit - margin.minutes)) return false;
  return supportsProvisional(e, claim, margin);
}

/** Whether the 60-day fit supports a 210-day claim's provisional answer, with its boundaries tightened by `margin`. A claim with no provisional answer needs none. */
function supportsProvisional(e: Evaluation, claim: Claim, margin: Margin): boolean {
  if (claim.provisional === undefined) return true;
  if (claim.days !== 210 || !e[60]) return false;
  const p = provisionalFor(e[60], claim.bound, margin);
  return p !== undefined && p <= claim.provisional;
}

/** The claim one grid point's year earns: the window with the better tier, then the lower bound, then the shorter window, and for a 210-day gate the provisional answer its 60-day fit qualifies for. */
export function measuredClaim(e: Evaluation): Claim {
  const best = RECIPE_WINDOWS.map((days): Claim | undefined => {
    const v = windowVerdict(e[days]);
    if (v.tier === "online") return undefined;
    return v.bound === undefined ? { tier: v.tier, days } : { tier: v.tier, days, bound: v.bound };
  })
    .filter((c): c is Claim => c !== undefined)
    .sort(compareClaims)[0];
  if (!best) return { tier: "online" };
  if (best.days === 210) {
    const p = provisionalFor(e[60], best.bound, NO_MARGIN);
    if (p !== undefined) return { ...best, provisional: p };
  }
  return best;
}

const BOUNDS = [35, 40, 45];
const PROVISIONALS = [5, 10, 15, 20, 25, 30, 35, 40, 45];

/** Every claim a gate can ship as, strongest first. */
function candidates(): Claim[] {
  const out: Claim[] = [{ tier: "online" }];
  for (const days of RECIPE_WINDOWS) {
    const fitted: Claim[] = [
      { tier: "final", days },
      ...BOUNDS.map((bound): Claim => ({ tier: "bounded", days, bound })),
    ];
    for (const claim of fitted) {
      out.push(claim);
      if (days !== 210) continue;
      for (const p of PROVISIONALS)
        if (p >= (claim.bound ?? 0)) out.push({ ...claim, provisional: p });
    }
  }
  return out.sort(compareClaims);
}

/** The bound a claim quotes for its 60-day fit: the claim itself for a 60-day gate, a 210-day gate's provisional answer, or none. */
function quote60(c: Claim): number {
  if (c.tier === "online") return Infinity;
  if (c.days === 60) return c.tier === "final" ? BAR.finalWorstMin : (c.bound ?? Infinity);
  return c.provisional ?? Infinity;
}

/** A claim without its provisional answer. */
function withoutProvisional(c: Claim): Claim {
  const { provisional: _provisional, ...main } = c;
  return main;
}

/**
 * Whether an evaluation supports promoting `base` to `c`, with the promotion
 * margin applied only to the parts that improve on `base`: the main claim, if
 * it ranks stronger than `base`'s, and the provisional answer, if it quotes a
 * smaller 60-day bound than `base` does.
 */
function supportsPromotion(e: Evaluation, c: Claim, base: Claim): boolean {
  const main = withoutProvisional(c);
  const improvesMain = compareClaims(main, withoutProvisional(base)) < 0;
  if (!supports(e, main, improvesMain ? PROMOTION_MARGIN : NO_MARGIN)) return false;
  return supportsProvisional(e, c, quote60(c) < quote60(base) ? PROMOTION_MARGIN : NO_MARGIN);
}

/**
 * The strongest claim that ranks stronger than `base`, never quotes a larger
 * 60-day bound than `base`, and that every evaluation supports with the
 * promotion margin on the parts that improve on `base`; `base` when none does.
 */
export function strongestPromotion(evals: readonly Evaluation[], base: Claim): Claim {
  return (
    candidates().find(
      (c) =>
        compareClaims(c, base) < 0 &&
        quote60(c) <= quote60(base) &&
        evals.every((e) => supportsPromotion(e, c, base)),
    ) ?? base
  );
}

/**
 * The claim a gate ships after its newest grid point. With no curated claim the
 * gate is curated afresh. A curated claim the newest year doesn't support is
 * demoted to the strongest weaker claim that year supports. A stronger claim
 * replaces it only when both the newest and previous grid points support it
 * with the promotion margin on the parts that improve, and it never quotes a
 * larger 60-day bound, which would be a demotion.
 */
export function stabilize(input: {
  curated: Claim | undefined;
  newest: Evaluation;
  previous: Evaluation;
}): { claim: Claim; change: Change } {
  const { curated, newest, previous } = input;
  if (curated && !supports(newest, curated, NO_MARGIN)) {
    // A demotion never strengthens the claim: a stronger one needs two grid
    // points with the promotion margin.
    const claim = candidates().find(
      (c) => compareClaims(c, curated) > 0 && supports(newest, c, NO_MARGIN),
    ) ?? { tier: "online" };
    return { claim, change: "demoted" };
  }
  const base: Claim = curated ?? { tier: "online" };
  const best = strongestPromotion([newest, previous], base);
  if (compareClaims(best, base) < 0) return { claim: best, change: curated ? "promoted" : "fresh" };
  return { claim: base, change: curated ? "kept" : "fresh" };
}

/**
 * The `chs_fit` a claim ships as. An online claim carries the 210-day window's
 * miss: the newest grid point's, else the previous one's, else the clause one
 * of them fails by the promotion margin, which is why the gate stays online.
 */
export function chsFit(claim: Claim, newest: Evaluation, previous: Evaluation): ChsFit {
  if (claim.tier === "online") {
    const miss =
      missOf(newest[210]) ??
      missOf(previous[210]) ??
      missOf(newest[210], PROMOTION_MARGIN) ??
      missOf(previous[210], PROMOTION_MARGIN);
    if (!miss) throw new Error("an online claim whose 210-day window fails no clause");
    return { tier: "online", miss };
  }
  return {
    tier: claim.tier,
    days: claim.days,
    ...(claim.bound !== undefined ? { slack_bound_minutes: claim.bound } : {}),
    ...(claim.provisional !== undefined ? { provisional_slack_minutes: claim.provisional } : {}),
  };
}
