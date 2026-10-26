import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { otherLocale, pickLocale } from "../lib/locale.js";
import { I18nContext } from "./context.js";
import en from "./en.js";
import zh from "./zh-CN.js";

const MESSAGES = { en, "zh-CN": zh };
const STORAGE_KEY = "orangespeakeasy.locale";

/** 访客上次手动选的语言。隐私模式、禁了存储时读写都可能抛错：当没选过 */
function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 记不住只是下次要再选一次，页面照常
  }
}

function initialLocale() {
  return pickLocale({
    query: new URLSearchParams(window.location.search).get("lang"),
    stored: readStored(),
    languages: navigator.languages?.length ? navigator.languages : [navigator.language],
  });
}

export function I18nProvider({ children }) {
  const [locale, setLocale] = useState(initialLocale);
  const m = MESSAGES[locale];

  // 标签页标题、<html lang>、描述跟着换：读屏软件按 lang 选发音，中文的标题字距也靠它（styles.css 的 display）
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = m.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", m.meta.description);
  }, [locale, m]);

  const switchLocale = useCallback(() => {
    setLocale((current) => {
      const next = otherLocale(current);
      store(next);
      // 网址里也带上，复制链接发给别人时是同一种语言
      const url = new URL(window.location.href);
      url.searchParams.set("lang", next);
      window.history.replaceState(null, "", url);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ locale, m, switchLocale }), [locale, m, switchLocale]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

/** @returns {{ locale: "en" | "zh-CN", m: typeof en, switchLocale: () => void }} */
export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n 要在 I18nProvider 里面用");
  return value;
}
