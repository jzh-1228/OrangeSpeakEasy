// 悬浮条上的声波：竖条原地不动，每个字从正中间激起一道波，一根接一根传到两边，越往边上越矮，
// 然后自己落回去。说话时字一个接一个来，中间那几根就一直在跳，看着是"中间高、两边低"的一座山在抖。
// 办法照原版（Typeless 的悬浮条也是这样：声音只在中间起波、往两边扩散、各自衰减，带一点随机），
// 参数按 OrangeSpeakEasy 自己的音量重新标定过。
// 纯计算，不碰页面：每 50 ms 喂一个音量（hear），每画一帧取一次高度（frame），时间由调用方给。

/** 声波里一共多少根竖条。单数：正中间有一根，波从那里起 */
export const WAVE_BARS = 15;

/** 伏着的高度（占声波区域高度的比例）：没声音时是一排小圆点 */
export const REST = 0.1;

/** 页面拿到的波形是 8 位的，这是它分辨得出的最小一格：真实录音里停顿就是这一格 */
const QUIET = 1 / 128;
/** 到这个音量算最响。真实录音里说话一般在 8 到 20 格（0.06–0.16） */
const LOUD = 0.19;
/** 响度到这么多才起波：三格（0.023）以上。停顿时是一两格，不起 */
const START = 0.3;
/** 一听到是在说话，至少一半的音量会起波；越响越多，最多八成：每次都起的话中间那根一直贴着顶，看不出字和字 */
const MIN_CHANCE = 0.5;
const MAX_CHANCE = 0.8;
/** 传到隔壁一根要多久。传到最边上一百来毫秒，看得出是从中间扩出去的 */
const STEP_MS = 14;
/** 落回去的快慢：每过这么久，离伏着的高度少一半。字和字之间的空隙里能落下去一截 */
const HALF_LIFE_MS = 220;
/** 每一帧随手抖一下，上下各这么多（按高出伏着的那一截算） */
const JITTER = 0.06;
/** 最边上那根最矮是中间的几成 */
const EDGE = 0.15;
/** 离伏着差这么一点就当伏着了，免得一直画看不出来的变化 */
const SETTLED = 0.01;

/** 音量有多响：按"比最小的一格响多少倍"算（对数），0–1。说话的音量挤在很低的一段，直接用会都很矮 */
function loudness(level) {
  if (level <= QUIET) return 0;
  return Math.min(1, Math.log(level / QUIET) / Math.log(LOUD / QUIET));
}

/** 一根竖条过了这么多毫秒落到多高 */
function fade(height, ms) {
  return REST + (height - REST) * 0.5 ** (ms / HALF_LIFE_MS);
}

/**
 * @param {object} options
 * @param {number} options.bars 几根竖条
 * @param {() => number} [options.random] 0–1 的随机数，测试时换成固定的
 */
export function createWave({ bars, random = Math.random }) {
  const middle = Math.floor(bars / 2);
  const between = (low, high) => low + random() * (high - low);
  /** 各根现在多高 */
  let heights = Array(bars).fill(REST);
  /** 已经激起、还没传到的波：{ bar, height, at } */
  let arrivals = [];
  /** 上一帧的时间。还没画过是 null */
  let last = null;

  return {
    /** 听到一个音量（0–1），时间是毫秒 */
    hear(level, now) {
      const loud = loudness(level);
      if (loud < START || random() >= Math.min(MAX_CHANCE, MIN_CHANCE + loud - START)) return;
      const peak = Math.min(1, (0.4 + 0.6 * loud) * between(0.9, 1.1));
      // 起点偶尔偏开一根，左右两边才不总是一模一样
      const center = middle + Math.round((random() - 0.5) * 2);
      for (let bar = 0; bar < bars; bar++) {
        const distance = Math.abs(bar - center);
        const side = Math.max(1, bar < center ? center : bars - 1 - center);
        const falloff = Math.max(EDGE, 1 - (distance / side) * between(0.65, 0.75));
        arrivals.push({
          bar,
          height: Math.min(1, Math.max(REST, peak * falloff * between(0.9, 1.1))),
          at: now + distance * STEP_MS * between(1, 1.3),
        });
      }
    },

    /** 到这一刻各根该多高（0–1），从左到右 */
    frame(now) {
      const since = last === null ? 0 : Math.max(0, now - last);
      last = now;
      heights = heights.map((height) => {
        const above = fade(height, since) - REST;
        if (above < SETTLED) return REST;
        return Math.min(1, REST + above * (1 + (random() - 0.5) * 2 * JITTER));
      });
      arrivals = arrivals.filter(({ bar, height, at }) => {
        if (at > now) return true;
        // 传到了：比现在矮的直接顶上去；比现在高的往下拉一截，新来的字才看得出来。
        // 两帧之间就到了的，按到了多久先落一点，帧快帧慢画出来都一样
        const arrived = fade(height, now - at);
        heights[bar] = Math.max(arrived, heights[bar] * 0.3 + arrived * 0.7);
        return false;
      });
      return [...heights];
    },

    /** 不画了：全部伏下去，还没传到的波也不要了 */
    reset() {
      heights = Array(bars).fill(REST);
      arrivals = [];
      last = null;
    },
  };
}
