/**
 * Concentrated-liquidity math shared by V3 and V4. Everything here is exact
 * BigInt arithmetic mirroring the Solidity libraries (TickMath, SqrtPriceMath,
 * Tick.getFeeGrowthInside); conversion to floats happens only at the edges.
 */

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** TickMath.getSqrtRatioAtTick, ported from Uniswap V3 core. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const absTick = BigInt(tick < 0 ? -tick : tick);

  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (c: bigint) => {
    ratio = (ratio * c) >> 128n;
  };
  if ((absTick & 0x2n) !== 0n) mul(0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4n) !== 0n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8n) !== 0n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10n) !== 0n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20n) !== 0n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40n) !== 0n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80n) !== 0n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100n) !== 0n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200n) !== 0n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400n) !== 0n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800n) !== 0n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000n) !== 0n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000n) !== 0n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000n) !== 0n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000n) !== 0n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000n) !== 0n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000n) !== 0n) mul(0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000n) !== 0n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000n) !== 0n) mul(0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Round up to Q96 (shift right by 32, rounding up).
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

/** Amount of token0 held between two sqrt prices for a given liquidity. */
export function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) return 0n;
  return (((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB) / sqrtA;
}

/** Amount of token1 held between two sqrt prices for a given liquidity. */
export function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/** Token amounts a position would withdraw right now. */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtA) {
    return { amount0: getAmount0ForLiquidity(sqrtA, sqrtB, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < sqrtB) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtB, liquidity),
      amount1: getAmount1ForLiquidity(sqrtA, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) };
}

/** Wrapping subtraction matching Solidity's unchecked uint256 arithmetic. */
export function subWrap(a: bigint, b: bigint): bigint {
  return (((a - b) % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
}

/** Tick.getFeeGrowthInside for one token. */
export function getFeeGrowthInside(
  feeGrowthGlobal: bigint,
  feeGrowthOutsideLower: bigint,
  feeGrowthOutsideUpper: bigint,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
): bigint {
  const below = tickCurrent >= tickLower ? feeGrowthOutsideLower : subWrap(feeGrowthGlobal, feeGrowthOutsideLower);
  const above = tickCurrent < tickUpper ? feeGrowthOutsideUpper : subWrap(feeGrowthGlobal, feeGrowthOutsideUpper);
  return subWrap(subWrap(feeGrowthGlobal, below), above);
}

/** Fees accrued since the position's last fee-growth snapshot. */
export function getUncollectedFees(
  liquidity: bigint,
  feeGrowthInsideNow: bigint,
  feeGrowthInsideLast: bigint,
): bigint {
  return (subWrap(feeGrowthInsideNow, feeGrowthInsideLast) * liquidity) / Q128;
}

/** Price of token1 per token0 as a float, adjusted for decimals. */
export function sqrtPriceToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

export function formatUnitsNumber(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}
