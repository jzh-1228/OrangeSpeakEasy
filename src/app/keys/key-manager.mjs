import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { keyVendorOf, keyVendorsOf } from "../../server/modes.mjs";
import { toModelError } from "../../server/providers/errors.mjs";
import { apiKeyProblem, DEFAULT_THINKING_LEVEL, findProvider } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";

const MISSING = { state: "missing", source: null, problem: null };

/**
 * 每家模型各有一把 key。这次运行用的是哪一家（provider）由正在走的路线定：native 模式是收音频的那家，
 * local 模式是润色的那家（server/modes.mjs 的 keyVendorOf）。它的那把 key 现在是什么状态、
 * 启动时去哪找、怎么换、怎么删，都走这里；别家的 key 也在这里存、删、拿去检查，但不影响正在用的。
 * 换路线（切模式、换模型）也走这里的 switchRoute：路线当场换上，不等验证；新路线要的 key 照启动时那样去找、去装，
 * 没有、读不出、没通过的照实记在状态里。选哪条路线是用户的事，能不能用是状态，两件事分开。
 * 数据隐私模式（private）一把 key 都不要：走它时 provider 是 null，状态是 ready、source 是 none，存 key 要写明哪一家。
 * 一条路线可能要两家的 key（第一跳交给云端、润色交给另一家，server/modes.mjs 的 keyVendorsOf）：provider 是主的那家，
 * 另一家的 key 每次换路线、验证时按"环境变量优先、其次存着的"找来一起交给服务；缺了它整条路线用不了，
 * 状态里的 vendor 写着缺的是哪一家。
 *
 * 状态（current，只说正在用的那一家）里的几项：
 *   state     missing（没有）/ unreadable（存着但解不开）/ checking / rejected / ready
 *   source    env（环境变量，比如 GEMINI_API_KEY）/ stored（加密存着的）/ external（key 在单独启动的服务端那边）/
 *             none（路线不用 key：数据隐私模式）
 *   problem   给用户看的一句原因：一句还没定语言的话（msg），模型回的原话是一段字，由显示它的那一端翻
 *   cause     只在 rejected 时有：key（这把 key 不对）/ other（那一家拒绝了请求，多半是模型名或思考档位）
 *   verified  只在 ready 时有：false 表示启动时够不着那一家（没网，或者它一时不可用），先用着，还没验证
 *   vendor    只在缺的、读不出的、没通过的是路线里另一家（不是 provider）的 key 时有：{ id, name }。
 *             那一家的 key 存好了，整条路线就重新验一遍（settle）
 *
 * @param {object} options
 * @param {{ useKey: Function, setRoute: Function, verify: Function, forgetKey: Function, probe: Function } | null} options.service
 *   内置的听写服务；连的是单独启动的服务端时为 null，key 归那边管
 * @param {{ id: string, name: string, keyEnv: string } | null} options.provider 一开始用的那一家（server/vendors.mjs）；
 *   一开始走的路线不用 key 时是 null。换路线（switchRoute）时跟着换，不写厂商的存、删、检查说的都是正在用的那家
 * @param {(id: string) => object} [options.routeFor] 给不是正在用的那一家存 key 时，拿哪条路线验证。
 *   不写就是那家（收音频的）的默认模型走 native 模式
 * @param {Record<string, { load(): string | null, save(key: string): void, clear(): void }>} options.keyStores
 *   每家一个，按 id 找
 * @param {Record<string, string | undefined>} options.env
 * @param {{ info: Function, error: Function }} options.log
 * @param {() => void} options.onChange 状态每变一次调一次
 */
export function createKeyManager({
  service,
  provider: initialProvider,
  keyStores,
  env,
  log,
  onChange,
  routeFor = nativeRouteFor,
}) {
  /** 正在用的那一家；路线不用 key 时是 null */
  let provider = initialProvider ?? null;
  let current = MISSING;
  /** 正在用的那家这次运行实际在用的那把 key（检查它时要用同一把）；没有时是 null */
  let inUse = null;
  /** 排在最后的那件事做完的时候。只用来排队，不带结果也不带错误 */
  let queue = Promise.resolve();
  let reverifying = false;
  /**
   * 换过几次路线。换路线是当场的、不排队（switchRoute）：排在它前面、或者正在验的那一把是按旧路线找的，
   * 轮到它、验完了都先对一下，路线换过了就作废，不碰状态、不装进服务（stale）
   */
  let routeVersion = 0;
  const stale = () => ({ cause: "stale", problem: msg("key.routeChanged") });

  /**
   * 换 key、删 key 一件一件来。验证一把 key 要等那一家回话，这期间又来一件的话排在后面：
   * 否则先来的后到，会把后来的盖掉（比如验证途中点了删除，验证回来又把它启用了）。
   */
  function enqueue(task) {
    const result = queue.then(task);
    // 一件事出了错由它自己的调用方处理，不连累排在后面的
    queue = result.catch(() => {});
    return result;
  }

  function become(next) {
    current = next;
    onChange();
    return current;
  }

  /**
   * 服务报上来的错。不是模型层分好类的（多半是 bug）也照样能说，key 先抹掉。
   * 路线要两家的 key 时，报错的可能是另一家（第一跳交给的云端）：vendor 写着是哪家，原因前面点名它，
   * 免得用户以为是正在验的这把不对、一遍遍重填
   * @returns {{ cause: string, problem: object | string, detail: string, vendor: { id: string, name: string } | null }}
   */
  const described = (error, apiKey, who = provider, route = service?.route) => {
    const modelError = toModelError(error, { provider: who, apiKey });
    const other =
      modelError.provider && modelError.provider !== who.id && route
        ? keyVendorsOf(route).find(({ id }) => id === modelError.provider)
        : null;
    const vendor = other ? { id: other.id, name: other.name } : null;
    const problem = vendor
      ? msg("key.failedFor", { provider: vendor.name, reason: modelError.problem })
      : modelError.problem;
    return { cause: modelError.kind, problem, detail: modelError.detail, vendor };
  };

  function reject(source, cause, problem, detail, vendor = null) {
    // detail 是抹掉 key 之后的报错原文
    log.error("key_rejected", { provider: vendor?.id ?? provider?.id, source, cause, error: detail.slice(0, 300) });
    return become({ state: "rejected", source, problem, cause, ...(vendor ? { vendor } : {}) });
  }

  /** 按 id 找到那一家和它的 key 存放处。不认识就抛错 */
  function lookup(id) {
    const found = findVendor(id);
    if (!found || !keyStores[found.id]) throw new LocalizedError(msg("key.unknownProvider", { id }));
    return { found, store: keyStores[found.id] };
  }

  /**
   * 路线里除了 primary 以外那几家的 key（{ 厂商 id: key }）。缺了、读不出来、样子不对时 failure 说是哪家、为什么。
   * 不连服务（连着单独启动的服务端）时没有路线，什么都不要
   * @returns {{ keys: Record<string, string>, failure: null | { vendor: object, state: string, cause: string, problem: object } }}
   */
  function othersFor(route, primaryId) {
    const keys = {};
    for (const vendor of route ? keyVendorsOf(route) : []) {
      if (vendor.id === primaryId) continue;
      const { found, store } = lookup(vendor.id);
      const who = { id: found.id, name: found.name };
      let key;
      try {
        key = keyFor(found, store);
      } catch (error) {
        log.error("key_unreadable", { provider: found.id, error: String(error?.message ?? error) });
        const problem = msg("key.unreadableFor", { provider: found.name });
        return { keys, failure: { vendor: who, state: "unreadable", cause: "unreadable", problem } };
      }
      if (!key) {
        const problem = msg("key.noKeyFor", { provider: msg(`providers.${found.id}.name`) });
        return { keys, failure: { vendor: who, state: "missing", cause: "missing", problem } };
      }
      const shape = apiKeyProblem(key.apiKey);
      if (shape) return { keys, failure: { vendor: who, state: "rejected", cause: "key", problem: shape } };
      keys[found.id] = key.apiKey;
    }
    return { keys, failure: null };
  }

  /**
   * 拿一把 key 给正在走的路线验证，通过了才开始用。不抛错。
   * @param {{ atStartup: boolean }} options atStartup：启动时、换路线后找来的那把（存着的当初验证过）只是够不着的话
   *   照样启用，没通过就是不能用；用户新填的一把没通过的话服务里原来那把还在用，状态也回到原来的
   * @returns {Promise<null | { cause: string, problem: object | string }>} 通过了是 null，没通过是原因
   */
  function adopt(apiKey, source, { atStartup }) {
    const version = routeVersion;
    return enqueue(async () => {
      if (version !== routeVersion) return stale();
      // 排到自己了再记"原来的状态"：排队期间前一把可能刚验完
      const previous = current;
      // 路线里另一家的 key 先找齐：缺了就不必拿主的这把去验
      const others = othersFor(service.route, provider.id);
      if (others.failure) {
        const { vendor, state, cause, problem } = others.failure;
        log.error("key_rejected", { provider: vendor.id, source: null, cause, error: "路线要的另一家没有可用的 key" });
        if (atStartup) {
          // 听写时说缺的是哪一家
          service.forgetKey({ missing: vendor });
          become({ state, source: null, problem, vendor, ...(state === "rejected" ? { cause } : {}) });
        }
        return { cause, problem };
      }
      become({ state: "checking", source, problem: null });
      try {
        const { verified, stale: outdated } = await service.useKey(apiKey, {
          allowUnverified: atStartup,
          ...(Object.keys(others.keys).length > 0 ? { keys: others.keys } : {}),
        });
        if (outdated || version !== routeVersion) return stale();
        inUse = { apiKey, source };
        log.info("key_ready", { provider: provider.id, source, verified });
        become({ state: "ready", source, problem: null, verified });
        return null;
      } catch (error) {
        if (version !== routeVersion) return stale();
        const { cause, problem, detail, vendor } = described(error, apiKey);
        if (atStartup) reject(source, cause, problem, detail, vendor);
        else {
          log.error("key_rejected", {
            provider: vendor?.id ?? provider.id,
            source,
            cause,
            error: detail.slice(0, 300),
          });
          become(previous);
        }
        return { cause, problem };
      }
    });
  }

  /** 正在走的路线不用 key（数据隐私模式）：装上就能用，没有要验的 key。本机模型没下载由服务记着（localModel），不算 key 的事 */
  function adoptKeyless() {
    const version = routeVersion;
    return enqueue(async () => {
      if (version !== routeVersion) return;
      try {
        if ((await service.useKey(null)).stale || version !== routeVersion) return;
      } catch (error) {
        if (version !== routeVersion) return;
        // 不用 key 的路线装不上，多半是 bug：照实说
        const { cause, problem, detail } = described(error, null, { id: null, name: "OrangeSpeakEasy" });
        log.error("route_failed", { route: service.route.mode, cause, error: detail.slice(0, 300) });
        become({ state: "rejected", source: "none", problem, cause });
        return;
      }
      inUse = null;
      log.info("key_ready", { provider: null, source: "none", verified: true });
      become({ state: "ready", source: "none", problem: null });
    });
  }

  /**
   * 给正在走的路线找 key、装上：启动时和换路线后都走这里。这次运行手里已经有这家的那把就用它，否则环境变量优先、其次存着的；
   * 没有就是 missing（听写时说缺哪家），读不出、样子不对、没通过的照实记下；只是够不着的照样先用着
   * @returns {Promise<object>} 状态
   */
  async function resolveKey() {
    if (service.route && keyVendorsOf(service.route).length === 0) {
      await adoptKeyless();
      return current;
    }
    let found;
    try {
      found = inUse ?? keyFor(provider, keyStores[provider.id]);
    } catch (error) {
      // 换了签名或钥匙串里的密钥没了都会这样，只能请用户重新填
      log.error("key_unreadable", { provider: provider.id, error: String(error?.message ?? error) });
      return become({ state: "unreadable", source: "stored", problem: msg("key.unreadable") });
    }
    if (!found) return current.state === "missing" && !current.vendor ? current : become(MISSING);
    const { apiKey, source } = found;
    const shape = apiKeyProblem(apiKey);
    if (shape) return reject(source, "key", shape, "样子不对，没有拿去验证");
    await adopt(apiKey, source, { atStartup: true });
    return current;
  }

  /** 给不是正在用的那一家存 key：走给定的路线（没给就是 routeFor 给的）验证一次，通过了再存。不碰正在用的 */
  function saveForOther(found, store, apiKey, route) {
    return enqueue(async () => {
      // routeFor 也会抛错（比如自定义服务还没填地址）：原因照它说的
      let tried = null;
      try {
        tried = route ?? routeFor(found.id);
        await service.probe({ route: tried, apiKey });
      } catch (error) {
        const { cause, problem, detail } = described(error, apiKey, found, tried ?? undefined);
        log.error("key_rejected", { provider: found.id, source: "stored", cause, error: detail.slice(0, 300) });
        return { ok: false, problem };
      }
      return storeKey(store, apiKey);
    });
  }

  function storeKey(store, apiKey) {
    try {
      store.save(apiKey);
    } catch (error) {
      // 验证过了但存不下来：正在用的话这次运行照样能用，下次启动要重填，如实告诉用户
      log.error("key_save_failed", { error: String(error?.message ?? error) });
      return { ok: false, problem: msg("key.notSaved", { reason: problemOf(error) }) };
    }
    return { ok: true };
  }

  /**
   * 正在走的这条路线重新验一遍，状态照结果写：路线里另一家的 key 刚存好时用（之前缺它、或它那把没通过）。
   * 正在用的那家的 key 还是这次运行手里那把，没有了就照环境变量、存着的找
   */
  async function settle() {
    if (!provider) return current;
    let found;
    try {
      found = inUse ?? keyFor(provider, keyStores[provider.id]);
    } catch (error) {
      log.error("key_unreadable", { provider: provider.id, error: String(error?.message ?? error) });
      service.forgetKey();
      return become({ state: "unreadable", source: "stored", problem: msg("key.unreadable") });
    }
    if (!found) {
      service.forgetKey();
      return become(MISSING);
    }
    await adopt(found.apiKey, found.source, { atStartup: true });
    return current;
  }

  /** 那一家这次该用哪把 key：环境变量优先（从终端临时给一把时用），其次是存着的。读不出来会抛错 */
  function keyFor(found, store) {
    const fromEnv = env[found.keyEnv]?.trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env" };
    const stored = store.load();
    return stored ? { apiKey: stored, source: "stored" } : null;
  }

  /** 一把刚填的 key：去掉首尾空白；空的、样子不对的直接说原因（不交给服务） */
  function typed(value) {
    if (typeof value !== "string" || value.trim() === "") return { problem: msg("key.empty") };
    const apiKey = value.trim();
    const shape = apiKeyProblem(apiKey);
    return shape ? { problem: shape } : { apiKey };
  }

  const manager = {
    get current() {
      return current;
    },

    /** 正在用的那一家 */
    get provider() {
      return provider;
    },

    /**
     * 启动时给正在用的那一家找 key。
     * 只是够不着的话照样启用：存着的那把当初验证过才存的，不该因为开机时没网就让人重新填。
     */
    async loadAtStartup() {
      if (!service) return become({ state: "ready", source: "external", problem: null });
      return resolveKey();
    },

    /**
     * 验证并保存一把新的 key。没通过时原因在返回值里，原来的状态不变。
     * @param {unknown} value
     * @param {{ provider?: string, route?: object }} [options] provider：给哪一家存，默认是正在用的那一家。
     *   route：给别家存时拿哪条路线验证，不写就是 routeFor 给的（要换成某家的某个模型、先存它的 key 时用）
     * @returns {Promise<{ ok: true } | { ok: false, problem: object | string }>}
     */
    async save(value, { provider: id = provider?.id, route } = {}) {
      if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: msg("key.empty") };
      if (!service) return { ok: false, problem: msg("key.external") };
      // 走的路线不用 key：没有"正在用的那家"可以默认
      if (id === undefined) return { ok: false, problem: msg("key.whichVendor") };
      let target;
      try {
        target = lookup(id);
      } catch (error) {
        return { ok: false, problem: problemOf(error) };
      }
      const { apiKey, problem } = typed(value);
      if (problem) return { ok: false, problem };

      if (target.found.id !== provider?.id) {
        const saved = await saveForOther(target.found, target.store, apiKey, route);
        // 正在走的路线卡在这一家（第一跳交给它，缺它的 key 或它那把没通过）：存好了就把整条路线重新验一遍
        if (saved.ok && current.vendor?.id === target.found.id) await settle();
        return saved;
      }
      const failure = await adopt(apiKey, "stored", { atStartup: false });
      if (failure) return { ok: false, problem: failure.problem };
      return storeKey(target.store, apiKey);
    },

    /**
     * 换一条路线（切模式、换模型都是它）：当场换上，不验证、不拦着，也不排在正在验的 key 后面。
     * 新路线要的那家成了正在用的，它的 key 照启动时那样去找、去装（resolveKey），有没有、通没通过都记在状态里，
     * 听写时照实说；按旧路线排着的、正在验的那几把作废（routeVersion）。
     * 路线由调用方按各自那一层拼好（app/modes.mjs），设置也由调用方去改：这里只管这次运行走哪条、用哪把
     * @param {object} route
     * @returns {{ ok: true, settled: Promise<object> } | { ok: false, problem: object }}
     *   返回时已经换上了；settled 是找 key、验 key 有了结论（状态）。只有连着单独启动的服务端时换不了
     */
    switchRoute(route) {
      if (!service) return { ok: false, problem: msg("key.externalModel") };
      const next = keyVendorOf(route) ?? null;
      if (next?.id !== provider?.id) {
        log.info("provider_switched", { from: provider?.id ?? null, to: next?.id ?? null });
        // 还是同一家（换的是它的模型）：接着用这次运行手里那把，中途存过新的就是新的，不换回环境变量里的
        inUse = null;
      }
      routeVersion += 1;
      service.setRoute(route);
      provider = next;
      // 先不通知：下面找 key 的每一条路都会落到一个状态上再通知，免得界面先闪一下"缺 key"
      current = { state: "checking", source: null, problem: null };
      return { ok: true, settled: resolveKey() };
    },

    /** @param {{ provider?: string }} [options] 删哪一家的，默认是正在用的那一家（路线不用 key 时要写明） */
    forget({ provider: id = provider?.id } = {}) {
      return enqueue(() => {
        if (id === undefined) throw new LocalizedError(msg("key.whichVendor"));
        const { found, store } = lookup(id);
        store.clear();
        log.info("key_forgotten", { provider: found.id });
        if (!service) return;
        if (found.id === provider?.id) {
          service.forgetKey();
          inUse = null;
          become(MISSING);
          return;
        }
        // 删的是正在走的路线里另一家的：那一跳没了 key，整条路线都用不了
        const inRoute = service.route && keyVendorsOf(service.route).some(({ id }) => id === found.id);
        if (!inRoute || keyFor(found, store)) return;
        service.forgetKey({ missing: { id: found.id, name: found.name } });
        become({
          state: "missing",
          source: null,
          problem: msg("key.noKeyFor", { provider: msg(`providers.${found.id}.name`) }),
          vendor: { id: found.id, name: found.name },
        });
      });
    },

    /**
     * 某条路线现在能不能用：拿它要的那家的 key 发一个最小的请求。不抛错，不改变正在用的。
     * @param {object} route server/modes.mjs 说的路线
     * @returns {Promise<{ ok: true, source: string, ms: number } | { ok: false, cause: string, problem: object | string }>}
     *   cause：missing（没有这家的 key）/ unreadable / key / unavailable / other
     */
    async check(route) {
      if (!service) return { ok: false, cause: "other", problem: msg("key.externalModel") };
      if (keyVendorsOf(route).length === 0) {
        const startedAt = performance.now();
        try {
          await service.probe({ route, apiKey: null });
        } catch (error) {
          const { cause, problem } = described(error, null, { id: null, name: "OrangeSpeakEasy" });
          return { ok: false, cause, problem };
        }
        return { ok: true, source: "none", ms: Math.round(performance.now() - startedAt) };
      }
      let target;
      try {
        target = lookup(keyVendorOf(route).id);
      } catch (error) {
        return { ok: false, cause: "other", problem: problemOf(error) };
      }
      const { found, store } = target;
      let key;
      try {
        // 正在用的那家：查这次运行实际在用的那把（中途存过新的，就不是环境变量里那把了）
        key = found.id === provider?.id && inUse ? inUse : keyFor(found, store);
      } catch (error) {
        log.error("key_unreadable", { provider: found.id, error: String(error?.message ?? error) });
        return { ok: false, cause: "unreadable", problem: msg("key.unreadableFor", { provider: found.name }) };
      }
      if (!key) {
        return { ok: false, cause: "missing", problem: msg("key.noKeyForCli", { provider: found.name, id: found.id }) };
      }
      const shape = apiKeyProblem(key.apiKey);
      if (shape) return { ok: false, cause: "key", problem: shape };
      const others = othersFor(route, found.id);
      if (others.failure) {
        const { vendor, cause } = others.failure;
        const problem =
          cause === "missing"
            ? msg("key.noKeyForCli", { provider: vendor.name, id: vendor.id })
            : others.failure.problem;
        return { ok: false, cause, problem };
      }
      const startedAt = performance.now();
      try {
        await service.probe({
          route,
          apiKey: key.apiKey,
          ...(Object.keys(others.keys).length > 0 ? { keys: others.keys } : {}),
        });
      } catch (error) {
        const { cause, problem, detail } = described(error, key.apiKey);
        log.warn("model_check_failed", { provider: found.id, cause, error: detail.slice(0, 300) });
        return { ok: false, cause, problem };
      }
      const ms = Math.round(performance.now() - startedAt);
      log.info("model_checked", { provider: found.id, source: key.source, ms });
      return { ok: true, source: key.source, ms };
    },

    /**
     * 某一家现在该用哪把 key，给语音以外的功能用（划词翻译选的那一家）：同一家只有一把，和语音那边共用。
     * 正在用的那家给这次运行实际在用的那把（中途存过新的就是新的）；别家环境变量优先、其次存着的
     * @param {string} id 厂商 id
     * @returns {{ apiKey: string, source: "env" | "stored" } | null} 没有是 null；不认识的厂商、存着的解不开会抛错
     */
    keyOf(id) {
      const { found, store } = lookup(id);
      if (found.id === provider?.id && inUse) return inUse;
      return keyFor(found, store);
    },

    /**
     * 每家的 key 在哪：env（环境变量）/ stored（存着的）/ null（没有）。不解密，给命令行列模型用：
     * 装成应用的那个各存各的，命令行从文件看不到它的
     * @returns {Record<string, "env" | "stored" | null>}
     */
    sources() {
      return Object.fromEntries(
        Object.entries(keyStores).map(([id, store]) => {
          const { keyEnv } = findVendor(id);
          return [id, env[keyEnv]?.trim() ? "env" : store.exists() ? "stored" : null];
        }),
      );
    },

    /** 启动时够不着那一家、还没验证的那把，再验一次。别的情况什么都不做 */
    async reverify() {
      const checked = current;
      if (reverifying || checked.state !== "ready" || checked.verified !== false) return;
      reverifying = true;
      try {
        await service.verify();
        if (current !== checked) return;
        log.info("key_ready", { provider: provider.id, source: checked.source, verified: true });
        become({ ...checked, verified: true });
      } catch (error) {
        const { cause, problem, detail, vendor } = described(error);
        // 还是够不着就继续先用着；期间状态被别处换过（比如存了一把新的）也不再插手
        if (cause === "unavailable" || current !== checked) return;
        service.forgetKey(vendor ? { missing: vendor } : {});
        // 是另一家的 key 不对时，正在用的这把没问题，留着：那一家存好后 settle 接着用
        if (!vendor) inUse = null;
        reject(checked.source, cause, problem, detail, vendor);
      } finally {
        reverifying = false;
      }
    },
  };
  return manager;
}

/** 不说走哪条路线时：那家（收音频的）的默认模型走原生链路 */
function nativeRouteFor(id) {
  const provider = findProvider(id);
  if (!provider) throw new LocalizedError(msg("key.unknownProvider", { id }));
  return {
    mode: "native",
    model: { provider: provider.id, model: provider.defaultModel },
    thinkingLevel: provider.thinkingLevels ? DEFAULT_THINKING_LEVEL : null,
  };
}
