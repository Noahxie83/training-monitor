import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer, measureElement as defaultMeasureElement } from '@tanstack/react-virtual';
import type { LogEvent, LogSourceSnapshot } from '../../shared/contracts';
import type { UiLogLevelFilter } from '../hooks/useLogBuffer';
import { isSafeRegexPattern } from '../../shared/validate';
import { classifyLogLevel, parseAnsiSegments } from '../utils/ansi';
import { formatBytes, formatTimeOnly, formatTimestamp, friendlySourceName } from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface LogConsoleProps {
  sources: LogSourceSnapshot[];
  sourcePathById?: Record<string, string>;
  activeSource: LogSourceSnapshot | null;
  activeSourceId: string | null;
  onSelectSource: (sourceId: string) => void;
  events: LogEvent[];
  totalBufferedCount: number;
  totalBufferedBytes: number;
  isScrollLocked: boolean;
  setIsScrollLocked: (locked: boolean) => void;
  unreadCount: number;
  onResumeAutoScroll: () => void;
  onToggleScrollLock: () => void;
  searchQuery: string;
  searchMode?: 'literal' | 'regex';
  searchCaseSensitive?: boolean;
  levelFilter?: UiLogLevelFilter;
  onSearchChange: (query: string) => void;
  onSearchModeChange?: (mode: 'literal' | 'regex') => void;
  onSearchCaseSensitiveChange?: (caseSensitive: boolean) => void;
  onLevelFilterChange?: (level: UiLogLevelFilter) => void;
  onClearSearch?: () => void;
  isSearching: boolean;
  isWrapLines: boolean;
  onToggleWrapLines: () => void;
  onRefresh: () => void;
  nextBefore?: string | null;
  truncatedByBudget?: boolean;
  onLoadEarlier?: () => void;
  searchContinuation?: string | null;
  onLoadMoreSearch?: () => void;
  isLoadingEarlier?: boolean;
  onCancelEarlier?: () => void;
  activeGeneration?: string | null;
  pagingError?: string | null;
  searchError?: string | null;
  onRestartSearch?: () => void;
  initialFetchError?: string | null;
  isLoadingInitial?: boolean;
  residentEvicted?: boolean;
  onReloadFromLatest?: () => void;
  isAnchorEvicted?: boolean;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHighlightRegex(
  query: string,
  mode: 'literal' | 'regex',
  caseSensitive: boolean,
): { regex: RegExp | null; invalid: boolean } {
  const trimmed = query.trim();
  if (!trimmed) return { regex: null, invalid: false };
  const flags = caseSensitive ? 'g' : 'gi';
  if (mode === 'regex') {
    if (!isSafeRegexPattern(trimmed)) return { regex: null, invalid: true };
    try {
      return { regex: new RegExp(trimmed, flags), invalid: false };
    } catch {
      return { regex: null, invalid: true };
    }
  }
  return { regex: new RegExp(escapeRegExp(trimmed), flags), invalid: false };
}

function renderHighlightedChunk(
  text: string,
  regex: RegExp | null,
  isActiveRow: boolean,
): React.ReactNode {
  if (!regex || !text) return text;
  const localRe = new RegExp(regex.source, regex.flags);
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = localRe.exec(text)) !== null && guard < 200) {
    guard += 1;
    if (match[0].length === 0) {
      localRe.lastIndex += 1;
      continue;
    }
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    parts.push(
      <mark
        key={`${match.index}-${guard}`}
        className={`log-mark ${isActiveRow && guard === 1 ? 'log-mark-active' : ''}`}
      >
        {match[0]}
      </mark>,
    );
    lastIdx = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function renderLogLineContent(
  event: LogEvent,
  highlightRegex: RegExp | null,
  isActiveMatchRow: boolean,
): React.ReactNode {
  const sourceText = event.rawAnsi ?? event.text ?? '';
  if (!sourceText) return null;
  const hasAnsiEsc = sourceText.includes('\x1B');
  if (!hasAnsiEsc) {
    return renderHighlightedChunk(sourceText, highlightRegex, isActiveMatchRow);
  }
  const segments = parseAnsiSegments(sourceText);
  return segments.map((seg, idx) => {
    const style: React.CSSProperties = {};
    if (seg.fg) style.color = seg.fg;
    if (seg.bg) style.backgroundColor = seg.bg;
    if (seg.bold) style.fontWeight = 600;
    if (seg.dim) style.opacity = 0.65;
    if (seg.italic) style.fontStyle = 'italic';
    if (seg.underline) style.textDecoration = 'underline';
    const hasStyle = Object.keys(style).length > 0;
    const content = renderHighlightedChunk(seg.text, highlightRegex, isActiveMatchRow);
    return hasStyle ? (
      <span key={idx} style={style}>
        {content}
      </span>
    ) : (
      <React.Fragment key={idx}>{content}</React.Fragment>
    );
  });
}

export function LogConsole({
  sources,
  sourcePathById,
  activeSource,
  activeSourceId,
  onSelectSource,
  events,
  totalBufferedCount,
  isScrollLocked,
  setIsScrollLocked,
  unreadCount,
  onResumeAutoScroll,
  onToggleScrollLock,
  searchQuery,
  searchMode = 'literal',
  searchCaseSensitive = false,
  levelFilter: controlledLevelFilter,
  onSearchChange,
  onSearchModeChange,
  onSearchCaseSensitiveChange,
  onLevelFilterChange,
  onClearSearch,
  isSearching,
  isWrapLines,
  onToggleWrapLines,
  onRefresh,
  nextBefore,
  truncatedByBudget,
  onLoadEarlier,
  searchContinuation,
  onLoadMoreSearch,
  isLoadingEarlier,
  onCancelEarlier,
  pagingError,
  searchError,
  onRestartSearch,
  initialFetchError,
  isLoadingInitial,
  residentEvicted,
  onReloadFromLatest,
  isAnchorEvicted,
}: LogConsoleProps) {
  const { t } = useI18n();
  const [localMode, setLocalMode] = useState<'literal' | 'regex'>(searchMode);
  const [localCase, setLocalCase] = useState<boolean>(searchCaseSensitive);
  const [localLevel, setLocalLevel] = useState<UiLogLevelFilter>(controlledLevelFilter ?? 'all');
  const [clearedEventIds, setClearedEventIds] = useState<Set<string> | null>(null);
  const [activeMatchCursor, setActiveMatchCursor] = useState<number>(0);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const effectiveMode = onSearchModeChange ? searchMode : localMode;
  const effectiveCase = onSearchCaseSensitiveChange ? searchCaseSensitive : localCase;
  const effectiveLevel = onLevelFilterChange ? (controlledLevelFilter ?? 'all') : localLevel;

  const [isAnchorEvictedState, setIsAnchorEvictedState] = useState<boolean>(false);
  const effectiveAnchorEvicted = isAnchorEvicted ?? isAnchorEvictedState;
  const anchorRef = useRef<{ eventId: string; offsetInRow: number } | null>(null);
  const previousScroll = useRef({ top: 0, maximum: 0 });
  const hasSelectionRef = useRef<boolean>(false);
  const isScrollLockedRef = useRef<boolean>(isScrollLocked);
  isScrollLockedRef.current = isScrollLocked;
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastMeasuredWrapLinesRef = useRef(isWrapLines);

  // Reset local cleared-view mask on source change
  useEffect(() => {
    setClearedEventIds(null);
  }, [activeSourceId]);

  const { regex: highlightRegex, invalid: regexInvalid } = useMemo(
    () => buildHighlightRegex(searchQuery, effectiveMode, effectiveCase),
    [searchQuery, effectiveMode, effectiveCase],
  );

  // Filter displayed events by cleared-view watermark & level pills
  const visibleEvents = useMemo(() => {
    let list = events;
    if (clearedEventIds && clearedEventIds.size > 0) {
      list = list.filter((e) => !clearedEventIds.has(e.eventId));
    }
    if (effectiveLevel !== 'all') {
      list = list.filter((e) => {
        if (e.kind !== 'line' && e.kind !== 'redraw') return true;
        const level = classifyLogLevel(e.text);
        if (effectiveLevel === 'error') return level === 'error';
        if (effectiveLevel === 'warn') return level === 'warn';
        if (effectiveLevel === 'info') return level === 'info';
        return true;
      });
    }
    return list;
  }, [events, clearedEventIds, effectiveLevel]);

  // Track matching row indices for Prev / Next match navigation
  const matchedRowIndices = useMemo(() => {
    if (!highlightRegex) return [];
    const indices: number[] = [];
    for (let i = 0; i < visibleEvents.length; i += 1) {
      const text = visibleEvents[i]?.text;
      if (!text) continue;
      highlightRegex.lastIndex = 0;
      if (highlightRegex.test(text)) indices.push(i);
    }
    return indices;
  }, [visibleEvents, highlightRegex]);

  useEffect(() => {
    if (matchedRowIndices.length === 0) {
      setActiveMatchCursor(0);
    } else if (activeMatchCursor >= matchedRowIndices.length) {
      setActiveMatchCursor(0);
    }
  }, [matchedRowIndices.length, activeMatchCursor]);

  // Global Ctrl+F to focus search input (I14)
  useLayoutEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const activeEl = document.activeElement;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement)?.isContentEditable;
      const isComposing = (e as any).isComposing === true || e.keyCode === 229;
      if (isComposing || isInput) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // TanStack Virtual with dynamic measurement (I5)
  const rowVirtualizer = useVirtualizer({
    count: visibleEvents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    anchorTo: isScrollLocked ? 'start' : 'end',
    overscan: 25,
    getItemKey: (index) => visibleEvents[index]?.eventId ?? index,
    measureElement: (element, entry, instance) => {
      const height = defaultMeasureElement(element, entry, instance);
      return height > 0 ? height : 24;
    },
    initialRect: { width: 1000, height: 600 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (!el) return;
      const handler = () => {
        const rect = el.getBoundingClientRect();
        cb({ width: Math.round(rect.width) || 1000, height: Math.round(rect.height) || 600 });
      };
      handler();
      const RO = instance.targetWindow?.ResizeObserver;
      if (!RO) return () => {};
      const ro = new RO(handler);
      ro.observe(el);
      return () => ro.unobserve(el);
    },
  });

  const rowVirtualizerRef = useRef(rowVirtualizer);
  rowVirtualizerRef.current = rowVirtualizer;

  const captureAnchor = () => {
    const el = parentRef.current;
    if (!el || visibleEvents.length === 0) return;
    const virtualItems = rowVirtualizerRef.current.getVirtualItems();
    if (virtualItems.length === 0) return;
    const scrollTop = el.scrollTop;
    const item =
      virtualItems.find((v) => v.start <= scrollTop && v.start + v.size > scrollTop) || virtualItems[0];
    const event = visibleEvents[item!.index];
    if (event) {
      const offsetInRow = Math.max(0, scrollTop - item!.start);
      anchorRef.current = { eventId: event.eventId, offsetInRow };
      setIsAnchorEvictedState(false);
    }
  };

  const captureAnchorRef = useRef(captureAnchor);
  captureAnchorRef.current = captureAnchor;

  useEffect(() => {
    if (lastMeasuredWrapLinesRef.current === isWrapLines) return;
    lastMeasuredWrapLinesRef.current = isWrapLines;
    rowVirtualizerRef.current.measure();
    if (isScrollLocked && anchorRef.current) {
      const anchor = anchorRef.current;
      const newIndex = visibleEvents.findIndex((e) => e.eventId === anchor.eventId);
      if (newIndex >= 0) {
        rowVirtualizerRef.current.scrollToIndex(newIndex, { align: 'start' });
        if (anchor.offsetInRow > 0 && parentRef.current) {
          parentRef.current.scrollTop += anchor.offsetInRow;
        }
      }
    }
  }, [isWrapLines, isScrollLocked, visibleEvents]);

  useEffect(() => {
    if (!isScrollLocked || !anchorRef.current) return;
    const anchor = anchorRef.current;
    const newIndex = visibleEvents.findIndex((e) => e.eventId === anchor.eventId);
    if (newIndex >= 0) {
      setIsAnchorEvictedState(false);
      rowVirtualizerRef.current.scrollToIndex(newIndex, { align: 'start' });
      if (anchor.offsetInRow > 0 && parentRef.current) {
        parentRef.current.scrollTop += anchor.offsetInRow;
      }
    } else {
      setIsAnchorEvictedState(true);
    }
  }, [visibleEvents, isScrollLocked]);

  const currentTailId = visibleEvents[visibleEvents.length - 1]?.eventId ?? null;
  const currentTailText = visibleEvents[visibleEvents.length - 1]?.text ?? null;
  const totalRowHeight = rowVirtualizer.getTotalSize();
  const viewportHeight = rowVirtualizer.scrollRect?.height;
  useLayoutEffect(() => {
    if (!isScrollLocked && !hasSelectionRef.current && visibleEvents.length > 0) {
      rowVirtualizerRef.current.scrollToEnd();
    }
  }, [currentTailId, currentTailText, isScrollLocked, totalRowHeight, viewportHeight, visibleEvents.length]);

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const { scrollTop: top, scrollHeight, clientHeight } = el;
    const maximum = scrollHeight - clientHeight;
    const previous = previousScroll.current;
    previousScroll.current = { top, maximum };
    if (maximum - top < 30) return;
    if (!isScrollLocked) {
      // Filtering and remeasurement may dispatch scroll while the layout changes.
      if (maximum !== previous.maximum || top >= previous.top) return;
      setIsScrollLocked(true);
    }
    captureAnchor();
  };

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleSelectStart = () => {
      hasSelectionRef.current = true;
      captureAnchorRef.current();
      if (!isScrollLockedRef.current) setIsScrollLocked(true);
    };
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const hasText = Boolean(selection && !selection.isCollapsed && (selection.toString().length ?? 0) > 0);
      const isInViewport = Boolean(
        parentRef.current && selection?.anchorNode && parentRef.current.contains(selection.anchorNode),
      );
      if (hasText && isInViewport) {
        if (!hasSelectionRef.current || !isScrollLockedRef.current) captureAnchorRef.current();
        hasSelectionRef.current = true;
        if (!isScrollLockedRef.current) setIsScrollLocked(true);
      } else {
        hasSelectionRef.current = false;
      }
    };
    el.addEventListener('selectstart', handleSelectStart);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      el.removeEventListener('selectstart', handleSelectStart);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [setIsScrollLocked]);

  const handleResumeClick = () => {
    setIsScrollLocked(false);
    anchorRef.current = null;
    setIsAnchorEvictedState(false);
    if (parentRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
    if (visibleEvents.length > 0) {
      rowVirtualizer.scrollToIndex(visibleEvents.length - 1, { align: 'end' });
    }
    onResumeAutoScroll();
  };

  const navigateMatch = (delta: number) => {
    if (matchedRowIndices.length === 0) return;
    const nextCursor = (activeMatchCursor + delta + matchedRowIndices.length) % matchedRowIndices.length;
    setActiveMatchCursor(nextCursor);
    const targetRow = matchedRowIndices[nextCursor]!;
    setIsScrollLocked(true);
    rowVirtualizer.scrollToIndex(targetRow, { align: 'center' });
  };

  const handleExportLogs = async () => {
    if (!activeSourceId && visibleEvents.length === 0) return;
    try {
      if (activeSourceId && window.monitor?.exportLogs) {
        const res = await window.monitor.exportLogs({
          sourceIds: [activeSourceId],
          ...(searchQuery.trim() ? { literal: searchQuery } : {}),
          ...(effectiveMode === 'regex' ? { mode: 'regex' } : {}),
          ...(effectiveCase ? { caseSensitive: true } : {}),
          ...(effectiveLevel !== 'all' ? { level: effectiveLevel } : {}),
        });
        setExportNotice(t('logs.exportSuccess', { count: res.exportedCount }));
        setTimeout(() => setExportNotice(null), 2500);
        return;
      }
      // Browser / fallback export
      const lines = visibleEvents.map((e) => `${formatTimestamp(e.ingestedAt)} ${e.text ?? ''}`).join('\n');
      const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeSourceId || 'training'}.log`;
      a.click();
      URL.revokeObjectURL(url);
      setExportNotice(t('logs.exportSuccess', { count: visibleEvents.length }));
      setTimeout(() => setExportNotice(null), 2500);
    } catch {
      setExportNotice(t('logs.exportFailed'));
      setTimeout(() => setExportNotice(null), 2500);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.code === 'Space') {
      const active = document.activeElement;
      if (active === parentRef.current) {
        const isComposing = (e.nativeEvent as any).isComposing === true || e.nativeEvent.keyCode === 229;
        const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0;
        if (!isComposing && !hasSelection) {
          e.preventDefault();
          onToggleScrollLock();
        }
      }
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const isComposing = (e.nativeEvent as any).isComposing === true || e.keyCode === 229;
    if (isComposing) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (onClearSearch) onClearSearch();
      else onSearchChange('');
      searchInputRef.current?.blur();
    } else if (e.key === 'Enter' && matchedRowIndices.length > 0) {
      e.preventDefault();
      navigateMatch(e.shiftKey ? -1 : 1);
    }
  };

  // Source state formatting in footer (I7) — clean i18n copy, zero internal jargon
  const isStale = activeSource?.freshness === 'stale';
  const staleSuffix = isStale ? t('logs.sourceState.staleSuffix') : '';
  let sourceStateBadge = (
    <span className="footer-item text-muted">
      <Icon name="info" size={13} />
      <span>{t('logs.sourceState.unobserved')}</span>
    </span>
  );
  if (!activeSource || activeSource.state === 'unobserved') {
    sourceStateBadge = (
      <span className="footer-item text-muted">
        <Icon name="info" size={13} />
        <span>{t('logs.sourceState.unobserved')}</span>
      </span>
    );
  } else if (activeSource.state === 'missing') {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" size={13} />
        <span>
          {t('logs.sourceState.missing')}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'reconciling') {
    sourceStateBadge = (
      <span className="footer-item text-warning">
        <Icon name="refresh" size={13} />
        <span>
          {t('logs.sourceState.reconciling')}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'cache_full') {
    sourceStateBadge = (
      <span className="footer-item text-warning">
        <Icon name="pause" size={13} />
        <span>
          {t('logs.sourceState.cache_full')}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'catching_up') {
    sourceStateBadge = (
      <span className="footer-item text-warning">
        <Icon name="refresh" size={13} />
        <span>
          {t('logs.sourceState.catching_up', {
            read: formatBytes(activeSource.catchupBytesRead, t('app.unknown')),
            total: formatBytes(activeSource.catchupBytesTotal, t('app.unknown')),
          })}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'reading') {
    sourceStateBadge = (
      <span className={`footer-item ${isStale ? 'text-warning' : 'text-info'}`}>
        <Icon name="check" size={13} />
        <span>
          {t('logs.sourceState.reading')}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'paused_budget') {
    sourceStateBadge = (
      <span className="footer-item text-warning">
        <Icon name="pause" size={13} />
        <span>
          {t('logs.sourceState.paused_budget')}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'permission_error') {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" size={13} />
        <span>
          {t('logs.sourceState.permission_error', { code: activeSource.errorCode ?? 'EACCES' })}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'read_error') {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" size={13} />
        <span>
          {t('logs.sourceState.read_error', { code: activeSource.errorCode ?? 'IO' })}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'storage_error') {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" size={13} />
        <span>
          {t('logs.sourceState.storage_error', { code: activeSource.errorCode ?? 'STORAGE' })}
          {staleSuffix}
        </span>
      </span>
    );
  } else if (activeSource.state === 'ready') {
    let isFullyCaughtUp = false;
    if (
      activeSource.freshness === 'fresh' &&
      activeSource.committedOffset !== null &&
      activeSource.maxObservedOffset !== null
    ) {
      try {
        isFullyCaughtUp = BigInt(activeSource.committedOffset) >= BigInt(activeSource.maxObservedOffset);
      } catch {
        isFullyCaughtUp = false;
      }
    }
    if (isFullyCaughtUp) {
      sourceStateBadge = (
        <span className="footer-item text-success">
          <Icon name="check" size={13} />
          <span>{t('logs.sourceState.caughtUp')}</span>
        </span>
      );
    } else {
      sourceStateBadge = (
        <span className={`footer-item ${isStale ? 'text-warning' : 'text-success'}`}>
          <Icon name="check" size={13} />
          <span>
            {t('logs.sourceState.ready')}
            {staleSuffix}
          </span>
        </span>
      );
    }
  }

  const activeMatchRowIndex =
    matchedRowIndices.length > 0 ? matchedRowIndices[activeMatchCursor] ?? -1 : -1;

  const setLevel = (level: UiLogLevelFilter) => {
    if (onLevelFilterChange) onLevelFilterChange(level);
    else setLocalLevel(level);
  };

  return (
    <div className="log-console-container" aria-label={t('logs.ariaLabel')}>
      {/* Toolbar */}
      <div className="log-toolbar" role="toolbar" aria-label={t('logs.toolbarAria')}>
        <div className="log-toolbar-left">
          <h3 className="log-toolbar-title">
            <Icon name="terminal" size={13} className="text-muted" />
            <span>{t('logs.title')}</span>
          </h3>

          {sources.length > 1 && (
            <div className="log-source-tabs" role="tablist">
              {sources.map((s) => {
                const display = friendlySourceName(s.sourceId, s.resolvedPath, sourcePathById?.[s.sourceId]);
                const tooltip = s.resolvedPath || sourcePathById?.[s.sourceId] || s.sourceId;
                return (
                  <button
                    key={s.sourceId}
                    type="button"
                    role="tab"
                    aria-selected={s.sourceId === activeSourceId}
                    className={`source-tab-btn ${s.sourceId === activeSourceId ? 'is-active' : ''}`}
                    title={`${display} (${tooltip})`}
                    onClick={() => onSelectSource(s.sourceId)}
                  >
                    {display}
                  </button>
                );
              })}
            </div>
          )}

          <div className="log-level-filters" role="group" aria-label="Log level filter">
            {(
              [
                ['all', t('logs.levelAll')],
                ['error', t('logs.levelError')],
                ['warn', t('logs.levelWarn')],
                ['info', t('logs.levelInfo')],
              ] as const
            ).map(([lv, label]) => (
              <button
                key={lv}
                type="button"
                className={`log-level-btn level-${lv} ${effectiveLevel === lv ? 'is-active' : ''}`}
                aria-pressed={effectiveLevel === lv}
                onClick={() => setLevel(lv)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className={`log-search-group ${regexInvalid ? 'is-invalid' : ''}`} role="search">
          <Icon name="search" size={13} />
          <input
            ref={searchInputRef}
            type="text"
            className="log-search-input"
            placeholder={t('logs.searchPlaceholder')}
            title={t('logs.searchTitle')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <button
            type="button"
            className={`log-search-toggle ${effectiveCase ? 'is-active' : ''}`}
            aria-pressed={effectiveCase}
            title={t('logs.caseToggleTitle')}
            onClick={() => {
              const next = !effectiveCase;
              if (onSearchCaseSensitiveChange) onSearchCaseSensitiveChange(next);
              else setLocalCase(next);
            }}
          >
            Aa
          </button>
          <button
            type="button"
            className={`log-search-toggle ${effectiveMode === 'regex' ? 'is-active' : ''}`}
            aria-pressed={effectiveMode === 'regex'}
            title={t('logs.regexToggleTitle')}
            onClick={() => {
              const next = effectiveMode === 'regex' ? 'literal' : 'regex';
              if (onSearchModeChange) onSearchModeChange(next);
              else setLocalMode(next);
            }}
          >
            .*
          </button>
          {searchQuery && !regexInvalid && (
            <>
              <span className="log-match-counter">
                {matchedRowIndices.length > 0
                  ? t('logs.matchCounter', { current: activeMatchCursor + 1, total: matchedRowIndices.length })
                  : '0 / 0'}
              </span>
              <button
                type="button"
                className="log-search-nav-btn"
                aria-label={t('logs.prevMatchAria')}
                disabled={matchedRowIndices.length === 0}
                onClick={() => navigateMatch(-1)}
              >
                <Icon name="chevronUp" size={13} />
              </button>
              <button
                type="button"
                className="log-search-nav-btn"
                aria-label={t('logs.nextMatchAria')}
                disabled={matchedRowIndices.length === 0}
                onClick={() => navigateMatch(1)}
              >
                <Icon name="chevronDown" size={13} />
              </button>
            </>
          )}
          {searchQuery && (
            <button
              type="button"
              className="log-search-nav-btn"
              onClick={onClearSearch ?? (() => onSearchChange(''))}
              title={t('logs.clearSearchTitle')}
              aria-label={t('logs.clearSearchTitle')}
            >
              <Icon name="close" size={12} />
            </button>
          )}
          {isSearching && <Icon name="refresh" size={12} className="is-spinning text-muted" />}
        </div>

        {/* Pagination actions */}
        <div className="log-pagination-actions">
          {nextBefore && !searchQuery && onLoadEarlier && (
            <div className="log-earlier-wrap">
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={onLoadEarlier}
                disabled={isLoadingEarlier}
                title={t('logs.loadEarlier')}
              >
                <Icon name="chevronUp" size={12} />
                <span>
                  {isLoadingEarlier
                    ? t('logs.loadingEarlier')
                    : truncatedByBudget
                      ? t('logs.loadEarlierBudget')
                      : t('logs.loadEarlier')}
                </span>
              </button>
              {isLoadingEarlier && onCancelEarlier && (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={onCancelEarlier}
                >
                  {t('logs.cancelEarlier')}
                </button>
              )}
            </div>
          )}

          {searchContinuation && searchQuery && onLoadMoreSearch && (
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={onLoadMoreSearch}
              disabled={isSearching}
            >
              <Icon name="chevronDown" size={12} />
              <span>{isSearching ? t('logs.searching') : t('logs.loadMoreSearch')}</span>
            </button>
          )}
        </div>

        {/* Toolbar actions */}
        <div className="log-toolbar-actions">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onToggleWrapLines}
            title={t('logs.wrapTitle')}
          >
            <Icon name="wrap" size={13} />
            <span className="btn-label">{isWrapLines ? t('logs.wrapOn') : t('logs.wrapOff')}</span>
          </button>

          <button
            type="button"
            className={`btn btn-xs ${isScrollLocked ? 'btn-warning' : 'btn-ghost'}`}
            onClick={() => {
              if (isScrollLocked) handleResumeClick();
              else onToggleScrollLock();
            }}
            title={t('logs.lockScrollTitle')}
            aria-label={isScrollLocked ? t('logs.resumeScroll') : t('logs.lockScroll')}
          >
            <Icon name={isScrollLocked ? 'play' : 'pause'} size={13} />
            <span className="btn-label">{isScrollLocked ? t('logs.resumeScroll') : t('logs.lockScroll')}</span>
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => void handleExportLogs()}
            title={t('logs.exportLogsTitle')}
            aria-label={t('logs.exportLogsTitle')}
          >
            <Icon name="download" size={13} />
            <span className="btn-label">{t('logs.exportLogs')}</span>
          </button>

          {clearedEventIds ? (
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => setClearedEventIds(null)}
            >
              <span>{t('logs.restoreView')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setClearedEventIds(new Set(events.map((e) => e.eventId)))}
              title={t('logs.clearViewTitle')}
              aria-label={t('logs.clearViewTitle')}
              disabled={visibleEvents.length === 0}
            >
              <Icon name="trash" size={13} />
            </button>
          )}

          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onRefresh}
            title={t('logs.refreshTitle')}
            aria-label={t('logs.refreshTitle')}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      {/* Banners (modular CSS classes, zero inline styles, zero undefined CSS vars) */}
      {pagingError && (
        <div className="log-alert-banner alert-warning" role="alert">
          <span>{pagingError}</span>
          {onReloadFromLatest && (
            <button type="button" className="btn btn-secondary btn-xs" onClick={onReloadFromLatest}>
              {t('logs.reloadLatest')}
            </button>
          )}
        </div>
      )}

      {(searchError || regexInvalid) && (
        <div className="log-alert-banner alert-danger" role="alert">
          <span>{searchError || t('logs.regexInvalid')}</span>
          <div className="log-alert-actions">
            {onRestartSearch && !regexInvalid && (
              <button type="button" className="btn btn-primary btn-xs" onClick={onRestartSearch}>
                {t('logs.restartSearch')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={onClearSearch ?? (() => onSearchChange(''))}
            >
              {t('logs.clearSearchBtn')}
            </button>
          </div>
        </div>
      )}

      {isLoadingInitial && (
        <div className="log-status-notice" role="status">
          {t('logs.loadingInitial')}
        </div>
      )}
      {residentEvicted && (
        <div className="log-status-notice" role="status">
          {t('logs.residentEvicted')}
        </div>
      )}

      {initialFetchError && (
        <div className="log-alert-banner alert-danger" role="alert">
          <span>{initialFetchError}</span>
          {onReloadFromLatest && (
            <button type="button" className="btn btn-secondary btn-xs" onClick={onReloadFromLatest}>
              {t('app.retry')}
            </button>
          )}
        </div>
      )}

      {effectiveAnchorEvicted && (
        <div className="log-alert-banner alert-warning" role="alert">
          <span>{t('logs.anchorEvicted')}</span>
          <div className="log-alert-actions">
            {onLoadEarlier && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={onLoadEarlier}>
                {t('logs.historyReload')}
              </button>
            )}
            {onReloadFromLatest && (
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => {
                  anchorRef.current = null;
                  setIsAnchorEvictedState(false);
                  onReloadFromLatest();
                }}
              >
                {t('logs.reloadLatest')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Terminal Stream Viewport */}
      <div className="log-viewport-wrapper">
        {isScrollLocked && unreadCount > 0 && (
          <div className="log-unread-floating-banner">
            <span>{t('logs.unreadJump', { count: unreadCount })}</span>
            <button type="button" className="btn btn-primary btn-xs" onClick={handleResumeClick}>
              <Icon name="chevronDown" size={12} />
              <span>{t('logs.resumeScroll')}</span>
            </button>
          </div>
        )}

        <div
          ref={parentRef}
          className={`log-viewport ${isWrapLines ? 'wrap-lines' : 'nowrap-lines'}`}
          tabIndex={0}
          role="region"
          aria-label={t('logs.viewportAria')}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
        >
          {visibleEvents.length === 0 ? (
            <div className="log-viewport-empty">
              <Icon name={searchQuery || effectiveLevel !== 'all' ? 'filter' : 'terminal'} size={20} />
              <span>
                {isLoadingInitial
                  ? t('logs.emptyLoading')
                  : clearedEventIds
                    ? t('logs.emptyCleared')
                    : searchQuery || effectiveLevel !== 'all'
                      ? t('logs.emptyNoMatches')
                      : t('logs.emptyNoEvents')}
              </span>
              {clearedEventIds && (
                <button type="button" className="btn btn-secondary btn-xs" onClick={() => setClearedEventIds(null)}>
                  {t('logs.restoreView')}
                </button>
              )}
            </div>
          ) : (
            <div
              className="log-virtual-inner"
              style={{
                height: `${totalRowHeight}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const event = visibleEvents[virtualRow.index];
                if (!event) return null;

                const rowStyle: React.CSSProperties = {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                };
                const timeTitle = `${formatTimestamp(event.ingestedAt)}${t('logs.localTimeSuffix')}`;

                if (event.kind === 'gap_confirmed') {
                  return (
                    <div
                      key={event.eventId}
                      ref={rowVirtualizer.measureElement}
                      data-event-id={event.eventId}
                      data-index={virtualRow.index}
                      className="log-event-row banner-gap-confirmed"
                      style={rowStyle}
                    >
                      <span className="log-col-time tabular-num" title={timeTitle}>
                        {formatTimeOnly(event.ingestedAt)}
                      </span>
                      <span className="log-col-text">
                        {t('logs.bannerGapConfirmed', { reason: event.reason ?? t('logs.noReason') })}
                      </span>
                    </div>
                  );
                }

                if (event.kind === 'gap_unknown') {
                  return (
                    <div
                      key={event.eventId}
                      ref={rowVirtualizer.measureElement}
                      data-event-id={event.eventId}
                      data-index={virtualRow.index}
                      className="log-event-row banner-gap-unknown"
                      style={rowStyle}
                    >
                      <span className="log-col-time tabular-num" title={timeTitle}>
                        {formatTimeOnly(event.ingestedAt)}
                      </span>
                      <span className="log-col-text">
                        {t('logs.bannerGapUnknown', { reason: event.reason ?? t('logs.noReason') })}
                      </span>
                    </div>
                  );
                }

                if (event.kind === 'cache_evicted') {
                  return (
                    <div
                      key={event.eventId}
                      ref={rowVirtualizer.measureElement}
                      data-event-id={event.eventId}
                      data-index={virtualRow.index}
                      className="log-event-row banner-cache-evicted"
                      style={rowStyle}
                    >
                      <span className="log-col-time tabular-num" title={timeTitle}>
                        {formatTimeOnly(event.ingestedAt)}
                      </span>
                      <span className="log-col-text">
                        {t('logs.bannerCacheEvicted', { reason: event.reason ?? t('logs.noReason') })}
                      </span>
                    </div>
                  );
                }

                if (event.kind === 'import_boundary') {
                  return (
                    <div
                      key={event.eventId}
                      ref={rowVirtualizer.measureElement}
                      data-event-id={event.eventId}
                      data-index={virtualRow.index}
                      className="log-event-row banner-import-boundary"
                      style={rowStyle}
                    >
                      <span className="log-col-time tabular-num" title={timeTitle}>
                        {formatTimeOnly(event.ingestedAt)}
                      </span>
                      <span className="log-col-text">{t('logs.bannerImportBoundary')}</span>
                    </div>
                  );
                }

                if (event.kind === 'generation_started') {
                  return (
                    <div
                      key={event.eventId}
                      ref={rowVirtualizer.measureElement}
                      data-event-id={event.eventId}
                      data-index={virtualRow.index}
                      className="log-event-row banner-generation-started"
                      style={rowStyle}
                    >
                      <span className="log-col-time tabular-num" title={timeTitle}>
                        {formatTimeOnly(event.ingestedAt)}
                      </span>
                      <span className="log-col-text">{t('logs.bannerGenerationStarted')}</span>
                    </div>
                  );
                }

                const hasAnsi = Boolean((event.rawAnsi ?? event.text ?? '').includes('\x1B'));
                const level = hasAnsi ? 'info' : classifyLogLevel(event.text);
                const levelClass =
                  level === 'error' ? 'log-level-error' : level === 'warn' ? 'log-level-warn' : '';
                const isActiveMatchRow = virtualRow.index === activeMatchRowIndex;

                return (
                  <div
                    key={event.eventId}
                    ref={rowVirtualizer.measureElement}
                    data-event-id={event.eventId}
                    data-index={virtualRow.index}
                    className={`log-event-row ${event.kind === 'redraw' ? 'log-row-redraw' : ''} ${levelClass}`.trim()}
                    style={rowStyle}
                  >
                    <span className="log-col-time tabular-num" title={timeTitle}>
                      {formatTimeOnly(event.ingestedAt)}
                    </span>
                    <span className="log-col-text">
                      {renderLogLineContent(event, highlightRegex, isActiveMatchRow)}
                      {event.displayTruncated && (
                        <span className="log-truncated-tag">[{t('logs.truncatedTag')}]</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="log-console-footer">
        <span className="footer-item">{sourceStateBadge}</span>
        <div className="footer-right">
          {exportNotice && <span className="text-success">{exportNotice}</span>}
          <span className="footer-item tabular-num">
            {t('logs.linesCount', { count: totalBufferedCount.toLocaleString('en-US') })}
          </span>
        </div>
      </div>
    </div>
  );
}
