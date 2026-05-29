import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { pt_BR } from "../locales/pt-BR.ts";
import { zh_CN } from "../locales/zh-CN.ts";
import { zh_TW } from "../locales/zh-TW.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "zh-CN", "zh-TW", "pt-BR", "de"];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

class I18nManager {
  private locale: Locale = "en";
  private translations: Record<Locale, TranslationMap> = {
    en,
    "zh-CN": zh_CN,
    "zh-TW": zh_TW,
    "pt-BR": pt_BR,
    de,
  };
  private subscribers: Set<Subscriber> = new Set();

  constructor() {
    this.loadLocale();
  }

  private resolveInitialLocale(): Locale {
    const saved = localStorage.getItem("enclaws.i18n.locale");
    if (isSupportedLocale(saved)) {
      return saved;
    }
    const navLang = navigator.language;
    if (navLang.startsWith("zh")) {
      return navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
    }
    if (navLang.startsWith("pt")) {
      return "pt-BR";
    }
    if (navLang.startsWith("de")) {
      return "de";
    }
    return "en";
  }

  private loadLocale() {
    this.locale = this.resolveInitialLocale();
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    if (this.locale === locale) {
      return;
    }
    // All locales are statically imported in `translations` above, so the
    // map is always populated — no dynamic import path is needed.
    if (!this.translations[locale]) {
      return;
    }

    this.locale = locale;
    localStorage.setItem("enclaws.i18n.locale", locale);
    this.notify();
  }

  public subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify() {
    this.subscribers.forEach((sub) => sub(this.locale));
  }

  public t(key: string, params?: Record<string, string>): string {
    const keys = key.split(".");
    let value: unknown = this.translations[this.locale] || this.translations["en"];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    // Fallback to English
    if (value === undefined && this.locale !== "en") {
      value = this.translations["en"];
      for (const k of keys) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[k];
        } else {
          value = undefined;
          break;
        }
      }
    }

    if (typeof value !== "string") {
      return key;
    }

    if (params) {
      return value.replace(/\{(\w+)}/g, (_, k) => params[k] || `{${k}}`);
    }

    return value;
  }
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string>) => i18n.t(key, params);
