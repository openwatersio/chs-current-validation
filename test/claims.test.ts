import { describe, expect, test } from "vitest";
import {
  chsFit,
  compareClaims,
  measuredClaim,
  provisionalFor,
  stabilize,
  strongestSupported,
  supports,
  type Claim,
} from "../src/claims.ts";
import { NO_MARGIN, PROMOTION_MARGIN, evaluateWindow, type Evaluation } from "../src/derive.ts";
import type { ResultRow } from "../src/rows.ts";
import { year } from "./builders.ts";

/** 60 and 210-day windows that pass everything, with a worst July slack of `w60` and `w210` minutes. */
function ev(
  w60: number,
  w210: number,
  extra: { 60?: Partial<ResultRow>; 210?: Partial<ResultRow> } = {},
): Evaluation {
  return {
    60: evaluateWindow(60, year({ fit_days: 60 }, { 6: { slack_errors: [5, w60], ...extra[60] } })),
    210: evaluateWindow(
      210,
      year({ fit_days: 210 }, { 6: { slack_errors: [5, w210], ...extra[210] } }),
    ),
  };
}
const good = ev(20, 20);

describe("compareClaims", () => {
  test("orders claims by tier, then bound, then window, then provisional answer", () => {
    const claims: Claim[] = [
      { tier: "online" },
      { tier: "bounded", days: 60, bound: 40 },
      { tier: "final", days: 210 },
      { tier: "bounded", days: 210, bound: 35 },
      { tier: "final", days: 210, provisional: 10 },
      { tier: "bounded", days: 60, bound: 35 },
      { tier: "final", days: 60 },
    ];
    expect([...claims].sort(compareClaims)).toEqual([
      { tier: "final", days: 60 },
      { tier: "final", days: 210, provisional: 10 },
      { tier: "final", days: 210 },
      { tier: "bounded", days: 60, bound: 35 },
      { tier: "bounded", days: 210, bound: 35 },
      { tier: "bounded", days: 60, bound: 40 },
      { tier: "online" },
    ]);
  });
});

describe("measuredClaim", () => {
  test("takes the better tier, then the lower bound, then the shorter window", () => {
    expect(measuredClaim(ev(20, 20))).toEqual({ tier: "final", days: 60 });
    expect(measuredClaim(ev(31, 38))).toEqual({ tier: "bounded", days: 60, bound: 35 });
    expect(measuredClaim(ev(50, 50))).toEqual({ tier: "online" });
  });

  test("gives a 210-day gate the provisional answer its 60-day fit qualifies for", () => {
    expect(measuredClaim(ev(31, 20))).toEqual({ tier: "final", days: 210, provisional: 35 });
    expect(measuredClaim(ev(36, 33))).toEqual({
      tier: "bounded",
      days: 210,
      bound: 35,
      provisional: 40,
    });
  });

  test("offers no provisional answer from a 60-day fit past 45 minutes or with a disqualifier", () => {
    expect(measuredClaim(ev(45.1, 20))).toEqual({ tier: "final", days: 210 });
    expect(measuredClaim(ev(20, 33, { 60: { invented: 1 } }))).toEqual({
      tier: "bounded",
      days: 210,
      bound: 35,
    });
  });
});

describe("supports", () => {
  test("tightens the worst slack by a minute under the promotion margin", () => {
    expect(supports(ev(50, 29), { tier: "final", days: 210 }, PROMOTION_MARGIN)).toBe(true);
    expect(supports(ev(50, 29.1), { tier: "final", days: 210 }, PROMOTION_MARGIN)).toBe(false);
    expect(supports(ev(50, 29.1), { tier: "final", days: 210 }, NO_MARGIN)).toBe(true);
    expect(supports(ev(50, 39), { tier: "bounded", days: 210, bound: 40 }, PROMOTION_MARGIN)).toBe(
      true,
    );
    expect(
      supports(ev(50, 39.1), { tier: "bounded", days: 210, bound: 40 }, PROMOTION_MARGIN),
    ).toBe(false);
  });

  test("lets a final window support any bound", () => {
    expect(supports(ev(50, 10), { tier: "bounded", days: 210, bound: 35 }, PROMOTION_MARGIN)).toBe(
      true,
    );
  });

  test("checks a provisional bound against the 60-day fit", () => {
    const claim: Claim = { tier: "final", days: 210, provisional: 35 };
    expect(supports(ev(34, 20), claim, PROMOTION_MARGIN)).toBe(true);
    expect(supports(ev(34.1, 20), claim, PROMOTION_MARGIN)).toBe(false);
    expect(supports(ev(34.1, 20), claim, NO_MARGIN)).toBe(true);
    expect(supports(ev(20, 20, { 60: { slack_errors: [null] } }), claim, NO_MARGIN)).toBe(false);
  });

  test("always supports online, and never a window the recipe lacks", () => {
    expect(supports(ev(90, 90), { tier: "online" }, NO_MARGIN)).toBe(true);
    expect(supports(ev(5, 5), { tier: "final", days: 365 }, NO_MARGIN)).toBe(false);
  });

  test("supports what it measures", () => {
    for (const e of [ev(20, 20), ev(31, 20), ev(36, 33), ev(45.1, 20), ev(50, 50)]) {
      expect(supports(e, measuredClaim(e), NO_MARGIN)).toBe(true);
    }
  });
});

describe("provisionalFor", () => {
  test("never quotes less than the claim's own bound", () => {
    expect(provisionalFor(ev(31, 50)[60], 40, NO_MARGIN)).toBe(40);
    expect(provisionalFor(ev(41, 50)[60], 40, NO_MARGIN)).toBe(45);
  });
});

describe("strongestSupported", () => {
  test("finds the strongest claim every grid point supports with the margin", () => {
    expect(strongestSupported([ev(33, 28), ev(31, 33)], PROMOTION_MARGIN)).toEqual({
      tier: "bounded",
      days: 60,
      bound: 35,
    });
  });
});

describe("stabilize", () => {
  test("demotes from the first grid point that shows it", () => {
    expect(
      stabilize({ curated: { tier: "final", days: 60 }, newest: ev(31, 31), previous: good }),
    ).toEqual({ claim: { tier: "bounded", days: 60, bound: 35 }, change: "demoted" });
  });

  test("demotes a larger slack bound, a larger provisional bound and a provisional answer that no longer qualifies", () => {
    expect(
      stabilize({
        curated: { tier: "bounded", days: 60, bound: 35 },
        newest: ev(36, 50),
        previous: good,
      }).claim,
    ).toEqual({ tier: "bounded", days: 60, bound: 40 });
    const provisional: Claim = { tier: "final", days: 210, provisional: 35 };
    expect(stabilize({ curated: provisional, newest: ev(36, 20), previous: good })).toEqual({
      claim: { tier: "final", days: 210, provisional: 40 },
      change: "demoted",
    });
    expect(stabilize({ curated: provisional, newest: ev(50, 20), previous: good })).toEqual({
      claim: { tier: "final", days: 210 },
      change: "demoted",
    });
  });

  test("demotes a curated window that loses its tier while another keeps it", () => {
    expect(
      stabilize({ curated: { tier: "final", days: 60 }, newest: ev(31, 20), previous: good }),
    ).toEqual({ claim: { tier: "final", days: 210, provisional: 35 }, change: "demoted" });
  });

  test("never demotes to a claim stronger than the curated one", () => {
    expect(
      stabilize({
        curated: { tier: "bounded", days: 60, bound: 35 },
        newest: ev(36, 20),
        previous: ev(36, 33),
      }),
    ).toEqual({
      claim: { tier: "bounded", days: 210, bound: 35, provisional: 40 },
      change: "demoted",
    });
  });

  test("promotes only what two consecutive grid points support with the margin", () => {
    expect(
      stabilize({
        curated: { tier: "bounded", days: 60, bound: 40 },
        newest: ev(28, 44),
        previous: ev(33, 44),
      }),
    ).toEqual({ claim: { tier: "bounded", days: 60, bound: 35 }, change: "promoted" });
  });

  test("keeps a curated claim the margin does not clear", () => {
    expect(
      stabilize({
        curated: { tier: "bounded", days: 60, bound: 35 },
        newest: ev(29.5, 44),
        previous: ev(29.5, 44),
      }),
    ).toEqual({ claim: { tier: "bounded", days: 60, bound: 35 }, change: "kept" });
    expect(
      stabilize({
        curated: { tier: "bounded", days: 60, bound: 40 },
        newest: ev(20, 44),
        previous: ev(39.5, 44),
      }),
    ).toEqual({ claim: { tier: "bounded", days: 60, bound: 40 }, change: "kept" });
  });

  test("curates a gate afresh from what both grid points support with the margin", () => {
    expect(stabilize({ curated: undefined, newest: ev(20, 20), previous: ev(22, 22) })).toEqual({
      claim: { tier: "final", days: 60 },
      change: "fresh",
    });
    expect(stabilize({ curated: undefined, newest: ev(50, 20), previous: ev(50, 50) })).toEqual({
      claim: { tier: "online" },
      change: "fresh",
    });
  });
});

describe("chsFit", () => {
  test("carries a fitted claim's window and bounds", () => {
    expect(chsFit({ tier: "bounded", days: 210, bound: 35, provisional: 40 }, good, good)).toEqual({
      tier: "bounded",
      days: 210,
      slack_bound_minutes: 35,
      provisional_slack_minutes: 40,
    });
    expect(chsFit({ tier: "final", days: 60 }, good, good)).toEqual({ tier: "final", days: 60 });
  });

  test("gives an online claim the 210-day window's miss", () => {
    expect(chsFit({ tier: "online" }, ev(50, 50), ev(50, 50))).toEqual({
      tier: "online",
      miss: { clause: "slack_worst", value: 50 },
    });
  });

  test("takes the previous grid point's miss when the newest year alone would pass", () => {
    expect(chsFit({ tier: "online" }, ev(50, 20), ev(50, 50))).toEqual({
      tier: "online",
      miss: { clause: "slack_worst", value: 50 },
    });
  });
});
