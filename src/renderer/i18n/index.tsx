import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';
import type { HostRegistration, HostSnapshot } from '../../shared/contracts';

export type Locale = 'zh-CN' | 'en-US';

const DICTIONARIES: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  'en-US': enUS as unknown as Record<string, unknown>,
};

function resolvePath(dict: Record<string, unknown>, key: string): string | null {
  const parts = key.split('.');
  let current: unknown = dict;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : null;
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  const template =
    resolvePath(DICTIONARIES[locale], key) ??
    resolvePath(DICTIONARIES['zh-CN'], key) ??
    key;
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const val = params[name];
    return val === undefined || val === null ? '' : String(val);
  });
}

export function translateHostError(
  locale: Locale,
  code: string | null,
  kind: HostSnapshot['kind'],
  registration?: HostRegistration,
): string | null {
  if (!code) return null;
  if (code === 'WSL_NOT_RUNNING') {
    const distro = registration?.target.kind === 'wsl'
      ? registration.target.distribution
      : translate(locale, 'errors.wslDistroFallback');
    return translate(locale, 'errors.WSL_NOT_RUNNING', { distro });
  }
  if (code === 'SSH_HOST_KEY_UNKNOWN') {
    const target = registration?.target.kind === 'ssh'
      ? (registration.target.alias ??
        (registration.target.user ? `${registration.target.user}@${registration.target.hostname}` : registration.target.hostname) ??
        '<host>')
      : '<host>';
    return translate(locale, 'errors.SSH_HOST_KEY_UNKNOWN', { target });
  }
  if (code === 'TRANSPORT_UNAVAILABLE') {
    if (kind === 'wsl') return translate(locale, 'errors.TRANSPORT_UNAVAILABLE_WSL');
    if (kind === 'local') return translate(locale, 'errors.TRANSPORT_UNAVAILABLE_LOCAL');
    return translate(locale, 'errors.TRANSPORT_UNAVAILABLE_SSH');
  }
  const directKey = `errors.${code}`;
  if (resolvePath(DICTIONARIES[locale], directKey) !== null) {
    return translate(locale, directKey);
  }
  return translate(locale, 'errors.genericConnection', { code });
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh-CN',
  setLocale: () => {},
  t: (key, params) => translate('zh-CN', key, params),
});

export function I18nProvider({
  locale,
  documentTitle,
  onChangeLocale,
  children,
}: {
  locale: Locale;
  documentTitle?: string;
  onChangeLocale?: (next: Locale) => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      if (documentTitle) document.title = documentTitle;
    }
  }, [locale, documentTitle]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: (next) => onChangeLocale?.(next),
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, onChangeLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
