import React, { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { translate, type Locale } from '../i18n';
import { Icon } from './Icon';

type Surface = 'main' | 'gpu';
type Theme = 'light' | 'dark';

interface BoundaryState {
  error: Error | null;
  componentStack: string;
}

const MAX_DIAGNOSTIC_LENGTH = 8_000;

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ErrorScreen({ error, componentStack, surface }: { error: Error; componentStack: string; surface: Surface }) {
  const [presentation, setPresentation] = useState<{ locale: Locale; theme: Theme }>(() => {
    const { lang, dataset } = document.documentElement;
    return {
      locale: lang === 'en-US' ? 'en-US' : 'zh-CN',
      theme: dataset.theme === 'light' || dataset.theme === 'dark' ? dataset.theme : systemTheme(),
    };
  });
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  // The application may fail before it has loaded the user's language and theme.
  useEffect(() => {
    let active = true;
    async function loadPresentation() {
      try {
        const preferences = await window.monitor?.getPreferences();
        if (!active || !preferences) return;
        setPresentation({
          locale: preferences.locale === 'en-US' ? 'en-US' : 'zh-CN',
          theme: preferences.theme === 'system' ? systemTheme() : preferences.theme,
        });
      } catch {
        // Keep the last applied appearance when the preferences bridge is unavailable.
      }
    }
    void loadPresentation();
    return () => {
      active = false;
    };
  }, []);

  const { locale, theme } = presentation;
  const t = (key: string) => translate(locale, key);
  const title = t(surface === 'gpu' ? 'app.gpuMonitorTitle' : 'app.title');
  const message = error.message || t('recovery.unknownError');
  const details = [title, error.stack || message, componentStack].filter(Boolean).join('\n\n');
  const diagnostic = details.length <= MAX_DIAGNOSTIC_LENGTH
    ? details
    : `${details.slice(0, MAX_DIAGNOSTIC_LENGTH)}\n…`;

  async function copyDiagnostic() {
    try {
      if (window.desktop?.copyDiagnosticText) {
        await window.desktop.copyDiagnosticText(diagnostic);
      } else {
        await navigator.clipboard.writeText(diagnostic);
      }
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <div className="app-shell" data-theme={theme} lang={locale}>
      <header className="app-header">
        <span className="header-brand">{title}</span>
      </header>
      <main className="recovery-view">
        <section className="recovery-card" aria-labelledby="recovery-heading">
          <div className="recovery-icon"><Icon name="alertCircle" size={22} /></div>
          <div role="alert">
            <h1 id="recovery-heading">{t('recovery.title')}</h1>
            <p className="recovery-description">{t('recovery.description')}</p>
            <p className="recovery-message">{message}</p>
          </div>
          <div className="recovery-actions">
            <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
              <Icon name="refresh" />{t('recovery.reload')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void copyDiagnostic()}>
              <Icon name="copy" />{t('recovery.copy')}
            </button>
          </div>
          {copyStatus === 'copied' && <p role="status">{t('recovery.copied')}</p>}
          {copyStatus === 'failed' && (
            <div>
              <p role="status">{t('recovery.copyFailed')}</p>
              <textarea
                className="recovery-message"
                aria-label={t('recovery.diagnostic')}
                readOnly
                rows={4}
                value={diagnostic}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode; surface: Surface }, BoundaryState> {
  state: BoundaryState = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(typeof error === 'string' ? error : '') };
  }

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  render() {
    const { error, componentStack } = this.state;
    return error
      ? <ErrorScreen error={error} componentStack={componentStack} surface={this.props.surface} />
      : this.props.children;
  }
}
