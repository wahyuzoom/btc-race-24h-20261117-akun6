// main.ts — BTC race bot, akun 6 (wahyuzoom / steady-gecko-37).
// Competition: btc-race-24h-20261117-0603. Strategy: dip-buy 1.5% + trailing
// exit 1%, stop-loss 1.5%, cooldown 60 bar, time stop 240 bar. Dev-window
// backtest (17 Nov dev bars, 1,440 bars): +$13.92, 5 trades.
//
// How it trades: the harness sends one JSON line per minute (hello, then a batch
// per bar, then done). On each batch we look at the bar's close and answer with
// orders. We track the rolling peak close over all history. When flat and the
// close has fallen 1.5% from the peak, we buy with all cash (after a 60-bar
// cooldown since our last sell). When holding, we track the highest close since
// entry and sell everything when the close falls 1% below that high (trailing
// stop), or 1.5% below the average entry price (hard stop, highest priority),
// or after 240 bars if the position is not profitable (time stop). One asset
// (CBBTC), long-only, full size, at most one open position. Deterministic: no
// clock, no randomness, no environment, no network — the same bars always
// produce the same orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DROP = 0.015; // buy when the close is 1.5% below the rolling peak
const TRAIL = 0.01; // sell when the close is 1% below the high since entry
const STOP = 0.015; // sell when the close is 1.5% below the entry price
const COOLDOWN = 60; // bars to wait after a sell before buying again
const MAX_HOLD = 240; // bars after entry before the time stop can fire
const MAX_SLIPPAGE_BPS = 100; // 1% past the latest close, as the kit baselines use

// Rolling peak of closes. Closes are exact integers below 2^53, so float math
// on them is exact, matching the backtester.
let peak = 0;
// Highest close since the current entry (0 when flat).
let hi = 0;
// Batch seq of the last sell decision (-1e9 before any sell), for the cooldown.
let lastSellSeq = -1e9;
// Batch seq of the buy decision that opened the current position, or null.
let entrySeq: number | null = null;

// Average entry price of the current position, in price-scale units, from the
// position's cost (fees included) divided by its quantity.
function entryPrice(state: BarsState): number | null {
  const pos = state.positions.get(SYMBOL);
  if (!pos || pos.qty === 0n) return null;
  const sym = state.symbols.get(SYMBOL);
  if (!sym) return null;
  const cost = Number(pos.cost);
  const qty = Number(pos.qty);
  const quoteScale = state.hello.capital.quote_scale;
  return (cost * 10 ** (sym.qty_scale + sym.price_scale)) / (qty * 10 ** quoteScale);
}

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    // Warm-up batches trade nothing: any order decided on one is rejected.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);
    if (c > peak) peak = c;
    const seq = state.seq;

    const pos = state.positions.get(SYMBOL);
    const held = pos ? pos.qty : 0n;

    if (held === 0n) {
      // Flat: reset the trailing high, respect the cooldown, buy the dip.
      hi = 0;
      if (seq - lastSellSeq < COOLDOWN) return [];
      if (c <= peak * (1 - DROP)) {
        entrySeq = seq;
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: state.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // Holding: track the high since entry, then check the exits in order.
    if (c > hi) hi = c;
    const entry = entryPrice(state);
    if (entry === null) return [];
    const sellAll = (): OrderInput[] => {
      lastSellSeq = seq;
      return [
        {
          side: 'sell',
          symbol: SYMBOL,
          qty: held,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    };
    // Hard stop first (highest priority), then the trailing stop, then the
    // time stop (only when the position is not profitable).
    if (c <= entry * (1 - STOP)) return sellAll();
    if (c <= hi * (1 - TRAIL)) return sellAll();
    if (entrySeq !== null && seq - entrySeq >= MAX_HOLD && c <= entry) {
      return sellAll();
    }
    return [];
  },
});
