import type { Lifecycle } from '../../shared/contracts';
import { translate, type Locale } from '../i18n';

export function getLifecycleBadge(lifecycle: Lifecycle, locale: Locale = 'zh-CN'): {
  text: string;
  className: string;
  pulse: boolean;
} {
  switch (lifecycle) {
    case 'running':
      return { text: translate(locale, 'lifecycle.running'), className: 'lifecycle-running', pulse: true };
    case 'queued':
      return { text: translate(locale, 'lifecycle.queued'), className: 'lifecycle-queued', pulse: false };
    case 'ready_not_training':
      return { text: translate(locale, 'lifecycle.ready_not_training'), className: 'lifecycle-ready', pulse: false };
    case 'completed':
      return { text: translate(locale, 'lifecycle.completed'), className: 'lifecycle-completed', pulse: false };
    case 'failed':
      return { text: translate(locale, 'lifecycle.failed'), className: 'lifecycle-failed', pulse: false };
    case 'stopped_unconfirmed':
      return { text: translate(locale, 'lifecycle.stopped_unconfirmed'), className: 'lifecycle-stopped', pulse: false };
    case 'unconfirmed':
      return { text: translate(locale, 'lifecycle.unconfirmed'), className: 'lifecycle-unconfirmed', pulse: false };
    case 'not_observed':
      return { text: translate(locale, 'lifecycle.not_observed'), className: 'lifecycle-not-observed', pulse: false };
    default:
      return { text: translate(locale, 'lifecycle.unknown'), className: 'lifecycle-unknown', pulse: false };
  }
}
