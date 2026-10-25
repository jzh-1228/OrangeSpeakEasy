// 小帮手意外退出后的重拉策略，从 main.mjs 抽出来的纯逻辑（照 setup-state.mjs 的惯例，好单测）。
// 重拉带指数退避和次数上限：它要是起来就崩，越拉越稀、连崩到头就停手等人工处理，不让崩溃循环空转烧 CPU。
// "崩"是不是新的一次故障看它在上面活了多久：稳定跑过 stableMs 再崩算新故障、额度重给；刚起来就崩则接着上次计数——
// 否则一个报完 ready 立刻崩的小帮手会 1 秒一轮永远拉下去（ready 是启动早期就发的，不能拿它当"跑稳了"）。

/**
 * @param {{ baseMs?: number, maxMs?: number, maxAttempts?: number, stableMs?: number }} [options]
 *   baseMs：第一次重拉前等多久；maxMs：等待时长的上限；maxAttempts：连续意外退出最多重拉几次；
 *   stableMs：活过这么久再崩算新的一次故障（额度重给）
 * @returns {{
 *   noteExit(upMs?: number): { revive: boolean, attempt?: number, delayMs?: number },
 * }}
 *   noteExit：小帮手退出时问一声该不该重拉、等多少毫秒（revive 为 false 时不带 attempt、delayMs）；
 *   upMs 是它这次从报 ready 到退出活了多久（没报到 ready 传 0）
 */
export function createRevivePolicy({ baseMs = 1_000, maxMs = 30_000, maxAttempts = 5, stableMs = 60_000 } = {}) {
  /** 连续意外退出的次数；稳定运行后再崩清零 */
  let exits = 0;
  return {
    noteExit(upMs = 0) {
      if (upMs >= stableMs) exits = 0;
      exits += 1;
      if (exits > maxAttempts) return { revive: false };
      return { revive: true, attempt: exits, delayMs: Math.min(baseMs * 2 ** (exits - 1), maxMs) };
    },
  };
}
