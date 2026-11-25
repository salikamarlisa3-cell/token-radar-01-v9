# Token Launch Radar — Research Desk v9

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/salikamarlisa3-cell/token-radar-01-v9/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/salikamarlisa3-cell/token-radar-01-v9/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A launch radar for the make.fun **token-radar-01** bounty: it prices every pre-token protocol in the
competition snapshot and ranks them as a research desk would — a fitted value model, a verdict and a farm
plan per name, and the evidence printed on the page.

**v9 changes presentation, not the model.** The comparables model is v8's, untouched — same multiples,
same factors, same board, byte for byte. What v9 adds is the honesty apparatus around the numbers:

- **A per-row uncertainty interval.** Under every price sits its P25–P75 band, fitted from the model's own
  leave-one-out residuals on the snapshot's 128 usable comparables (P10 ×0.043, P25 ×0.155, P75 ×4.119,
  P90 ×11.297). Walk-forward, the bands covered 52.3% and 79.7% of held-out protocols against nominal
  50% and 80% — they mean what they say.
- **A completeness ledger.** A strip on the board and a full table in the methodology account for all
  758 protocols in the snapshot — priced as comparables, ranked, or set aside with the reason named —
  computed from the data at build time and summing exactly to the snapshot total.

## The model

`implied value = TVL × comparable multiple (category) × momentum factor × maturity factor`

- **Comparable multiple** — the median market-cap-to-TVL multiple of the snapshot's own tokened protocols
  in the same category, shrunk toward the global median (×0.21) with k = 2 and capped at the 95th
  percentile of observed multiples (×5.13). The cap exists because one category rests on a single
  comparable at ~×400; without it that one observation priced a board row at 133× TVL. Held-out accuracy
  is identical with and without the cap (×4.449) — it binds only where held-out tests are blind.
- **Maturity** — min(1.4, 1 + 0.35 × log10(1 + age/365)); unrecorded listing dates are priced at the
  median comparable age (1000 days) and the substitution is shown.
- **Momentum** — banded, not linear: ×1.15 at +35% or more 7-day TVL change, ×0.88 at −35% or less,
  ×1.00 inside the band.

Every term was fitted by 10-fold cross-validation on the 128 usable comparables and kept or dropped by
held-out ablation: global median alone ×5.168 → + category multiples ×4.794 → + maturity ×4.478 →
linear momentum ×4.715 (**dropped**) → banded momentum ×4.449 (**final**) → concentration dampener
×4.574 (**dropped**). Held out, the model prices a typical comparable within ×4.45 of its actual cap,
with a disclosed ×1.36 hot bias, 23% within 2× and 53% within 5×.

## Run it

```
node main.ts   # reads /input/snapshot.json, writes /output/{board.json, dashboard/, screenshots/, dossier.json}
```

Deterministic: no clock, no randomness, fixed `en-US` formatting — two runs are byte-identical.
