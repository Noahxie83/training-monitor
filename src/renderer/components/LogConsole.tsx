import { Icon } from './Icon';
import React, { useRef, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogEvent, LogSourceSnapshot } from "../../shared/contracts";
import { formatTimestamp, formatTimeOnly, formatBytes } from "../utils/format";

interface LogConsoleProps {
  sources: LogSourceSnapshot[];
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
  onSearchChange: (query: string) => void;
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

export function LogConsole({
  sources,
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
  onSearchChange,
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
  const [isAnchorEvictedState, setIsAnchorEvictedState] = useState<boolean>(false);
  const effectiveAnchorEvicted = isAnchorEvicted ?? isAnchorEvictedState;
  const anchorRef = useRef<{ eventId: string; offsetInRow: number } | null>(null);
  const hasSelectionRef = useRef<boolean>(false);
  const isScrollLockedRef = useRef<boolean>(isScrollLocked);
  isScrollLockedRef.current = isScrollLocked;
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastTailEventIdRef = useRef<string | null>(null);
  const lastMeasuredWrapLinesRef = useRef(isWrapLines);

  // Global Ctrl+F to focus search input (I14)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Do not steal focus if modal or dialog is open
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }
      const activeEl = document.activeElement;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement)?.isContentEditable;
      const isComposing = (e as any).isComposing === true || e.keyCode === 229;
      if (isComposing || isInput) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // TanStack Virtual with dynamic measurement (I5)
  const rowVirtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 25,
    getItemKey: (index) => events[index]?.eventId ?? index,
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

  // Capture visible anchor row and offset within row (I6)
  const captureAnchor = () => {
    const el = parentRef.current;
    if (!el || events.length === 0) return;
    const virtualItems = rowVirtualizer.getVirtualItems();
    if (virtualItems.length === 0) return;
    const scrollTop = el.scrollTop;
    const item =
      virtualItems.find((v) => v.start <= scrollTop && v.start + v.size > scrollTop) ||
      virtualItems[0];
    const event = events[item.index];
    if (event) {
      const offsetInRow = Math.max(0, scrollTop - item.start);
      anchorRef.current = {
        eventId: event.eventId,
        offsetInRow,
      };
      setIsAnchorEvictedState(false);
    }
  };

  const captureAnchorRef = useRef(captureAnchor);
  captureAnchorRef.current = captureAnchor;

  // Remeasure only when line wrapping changes; ordinary event updates must
  // retain measurements for mounted rows until ResizeObserver updates them.
  useEffect(() => {
    if (lastMeasuredWrapLinesRef.current === isWrapLines) return;
    lastMeasuredWrapLinesRef.current = isWrapLines;
    rowVirtualizer.measure();
    if (isScrollLocked && anchorRef.current) {
      const anchor = anchorRef.current;
      const newIndex = events.findIndex((e) => e.eventId === anchor.eventId);
      if (newIndex >= 0) {
        rowVirtualizer.scrollToIndex(newIndex, { align: "start" });
        if (anchor.offsetInRow > 0 && parentRef.current) {
          parentRef.current.scrollTop += anchor.offsetInRow;
        }
      }
    }
  }, [isWrapLines, rowVirtualizer, isScrollLocked, events]);

  // Maintain reading position when locked and new events arrive or prepend (I6)
  useEffect(() => {
    if (!isScrollLocked || !anchorRef.current) return;
    const anchor = anchorRef.current;
    const newIndex = events.findIndex((e) => e.eventId === anchor.eventId);
    if (newIndex >= 0) {
      setIsAnchorEvictedState(false);
      rowVirtualizer.scrollToIndex(newIndex, { align: "start" });
      if (anchor.offsetInRow > 0 && parentRef.current) {
        parentRef.current.scrollTop += anchor.offsetInRow;
      }
    } else {
      setIsAnchorEvictedState(true);
    }
  }, [events, isScrollLocked, rowVirtualizer]);

  // Tail-driven auto follow when unlocked and no active selection (I6)
  const currentTailId = events[events.length - 1]?.eventId ?? null;
  const currentTailText = events[events.length - 1]?.text ?? null;
  useEffect(() => {
    if (!isScrollLocked && !hasSelectionRef.current && events.length > 0) {
      rowVirtualizer.scrollToIndex(events.length - 1, { align: "end" });
    }
  }, [currentTailId, currentTailText, isScrollLocked, events.length, rowVirtualizer]);

  // User scroll detection -> engage lock if scrolled up and record anchor (I6)
  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (!isAtBottom) {
      if (!isScrollLocked) {
        setIsScrollLocked(true);
      }
      captureAnchor();
    }
  };

  // Text selection detection -> engage lock and synchronize selection state without jumping on collapse (I6)
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleSelectStart = () => {
      hasSelectionRef.current = true;
      captureAnchorRef.current();
      if (!isScrollLockedRef.current) {
        setIsScrollLocked(true);
      }
    };
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const hasText = Boolean(selection && !selection.isCollapsed && (selection.toString().length ?? 0) > 0);
      const isInViewport = Boolean(
        parentRef.current &&
        selection?.anchorNode &&
        parentRef.current.contains(selection.anchorNode)
      );

      if (hasText && isInViewport) {
        if (!hasSelectionRef.current || !isScrollLockedRef.current) captureAnchorRef.current();
        hasSelectionRef.current = true;
        if (!isScrollLockedRef.current) setIsScrollLocked(true);
      } else {
        hasSelectionRef.current = false;
        // Selection ended or collapsed: keep manual scroll lock if engaged
      }
    };
    el.addEventListener("selectstart", handleSelectStart);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      el.removeEventListener("selectstart", handleSelectStart);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [setIsScrollLocked]);

  const handleResumeClick = () => {
    setIsScrollLocked(false);
    anchorRef.current = null;
    setIsAnchorEvictedState(false);
    lastTailEventIdRef.current = null;
    if (parentRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
    if (events.length > 0) {
      rowVirtualizer.scrollToIndex(events.length - 1, { align: "end" });
    }
    onResumeAutoScroll();
  };

  // Spacebar toggle inside log container ONLY when container itself has focus (I14)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.code === "Space") {
      const active = document.activeElement;
      // ONLY toggle if the active element is the viewport itself, not child buttons
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

  // Esc in search input clears search (I2, I14)
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const isComposing = (e.nativeEvent as any).isComposing === true || e.keyCode === 229;
    if (isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (onClearSearch) {
        onClearSearch();
      } else {
        onSearchChange("");
      }
      searchInputRef.current?.blur();
    }
  };

  // Source state formatting in footer (I7)
  const isStale = activeSource?.freshness === "stale";
  const staleSuffix = isStale ? " (状态陈旧)" : "";
  let sourceStateBadge = <span className="footer-item text-muted"><Icon name="info" />待探测 / 未观测</span>;
  if (!activeSource || activeSource.state === "unobserved") {
    sourceStateBadge = <span className="footer-item text-muted"><Icon name="info" />待探测 / 未观测</span>;
  } else if (activeSource.state === "missing") {
    sourceStateBadge = <span className="footer-item text-danger"><Icon name="warning" />来源文件缺失{staleSuffix}</span>;
  } else if (activeSource.state === "reconciling") {
    sourceStateBadge = <span className="footer-item text-warning"><Icon name="refresh" />状态对齐中{staleSuffix}</span>;
  } else if (activeSource.state === "cache_full") {
    sourceStateBadge = <span className="footer-item text-warning"><Icon name="pause" />缓存已满{staleSuffix}</span>;
  } else if (activeSource.state === "catching_up") {
    sourceStateBadge = (
      <span className="footer-item text-warning">
        <Icon name="refresh" />补读中{staleSuffix}: 已读 {formatBytes(activeSource.catchupBytesRead)} / {formatBytes(activeSource.catchupBytesTotal)}
      </span>
    );
  } else if (activeSource.state === "reading") {
    if (isStale) {
      sourceStateBadge = <span className="footer-item text-warning"><Icon name="check" />实时读取中 (状态陈旧)</span>;
    } else {
      sourceStateBadge = <span className="footer-item text-info"><Icon name="check" />实时读取中</span>;
    }
  } else if (activeSource.state === "paused_budget") {
    sourceStateBadge = <span className="footer-item text-warning"><Icon name="pause" />预算暂停{staleSuffix}</span>;
  } else if (activeSource.state === "permission_error") {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" />权限错误: {activeSource.errorCode ?? "未授权"}{staleSuffix}
      </span>
    );
  } else if (activeSource.state === "read_error") {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" />读取错误: {activeSource.errorCode ?? "读取失败"}{staleSuffix}
      </span>
    );
  } else if (activeSource.state === "storage_error") {
    sourceStateBadge = (
      <span className="footer-item text-danger">
        <Icon name="warning" />存储错误: {activeSource.errorCode ?? "存储失败"}{staleSuffix}
      </span>
    );
  } else if (activeSource.state === "ready") {
    let isFullyCaughtUp = false;
    if (
      activeSource.freshness === "fresh" &&
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
      sourceStateBadge = <span className="footer-item text-success"><Icon name="check" />已补齐</span>;
    } else if (isStale) {
      sourceStateBadge = <span className="footer-item text-warning"><Icon name="check" />已就绪 (状态陈旧)</span>;
    } else {
      sourceStateBadge = <span className="footer-item text-success"><Icon name="check" />已就绪</span>;
    }
  }

  return (
    <div className="log-console-container" aria-label="训练日志控制台">
      {/* Toolbar */}
      <div className="log-toolbar" role="toolbar" aria-label="日志控制栏"><h3 className="log-toolbar-title">训练日志</h3>
        {/* Source switcher tabs if multiple sources exist */}
        {sources.length > 1 && (
          <div className="log-source-tabs" role="tablist">
            {sources.map((s) => (
              <button
                key={s.sourceId}
                type="button"
                role="tab"
                aria-selected={s.sourceId === activeSourceId}
                className={"source-tab-btn " + (s.sourceId === activeSourceId ? "is-active" : "")}
                onClick={() => onSelectSource(s.sourceId)}
              >
                {s.sourceId}
              </button>
            ))}
          </div>
        )}

        <div className="log-search-group" role="search"><Icon name="search" />
          <input
            ref={searchInputRef}
            type="text"
            className="log-search-input"
            placeholder="查找日志 (Ctrl+F)..."
            title="搜索已下载的日志"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {searchQuery && (
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={onClearSearch ?? (() => onSearchChange(""))}
              title="清空搜索 (Esc)"
            >
              <Icon name="close" />
            </button>
          )}
          {isSearching && <span className="search-spinner">...</span>}
        </div>

        {/* History / Search Pagination Buttons (I4) */}
        <div className="log-pagination-actions">
          {nextBefore && !searchQuery && onLoadEarlier && (
            <div className="log-earlier-wrap" style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={onLoadEarlier}
                disabled={isLoadingEarlier}
                title="加载更早历史日志"
              >
                {isLoadingEarlier ? "加载中..." : "↑ 加载更早日志" + (truncatedByBudget ? " (预算截断)" : "")}
              </button>
              {isLoadingEarlier && onCancelEarlier && (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={onCancelEarlier}
                  title="取消历史日志加载"
                >
                  取消加载
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
              title="加载更多搜索结果"
            >
              {isSearching ? "查找中..." : "↓ 加载更多结果"}
            </button>
          )}
        </div>

        <div className="log-toolbar-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onToggleWrapLines}
            title="切换日志换行"
          >
            <Icon name="wrap" />{isWrapLines ? "自动换行" : "不换行"}
          </button>

          <button
            type="button"
            className={"btn btn-sm " + (isScrollLocked ? "btn-warning" : "btn-secondary")}
            onClick={() => {
              if (isScrollLocked) {
                handleResumeClick();
              } else {
                onToggleScrollLock();
              }
            }}
            title="暂停或恢复日志自动滚动 (Space)"
          >
            <Icon name={isScrollLocked ? "play" : "pause"} />{isScrollLocked ? "恢复自动滚动" : "锁定自动滚动"}
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
            title="立即刷新日志 (Ctrl+R)"
          >
            <Icon name="refresh" />刷新
          </button>
        </div>
      </div>

      {pagingError && (
        <div className="log-alert-banner alert-warning" role="alert" style={{ padding: "6px 12px", margin: "4px 8px", background: "var(--color-bg-warning, rgba(234, 179, 8, 0.15))", border: "1px solid var(--color-border-warning, #eab308)", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{pagingError}</span>
          {onReloadFromLatest && (
            <button
              type="button"
              className="btn btn-secondary btn-xs ms-2"
              onClick={onReloadFromLatest}
            >
              重新从最新加载
            </button>
          )}
        </div>
      )}

      {searchError && (
        <div className="log-alert-banner alert-danger" role="alert" style={{ padding: "6px 12px", margin: "4px 8px", background: "var(--color-bg-danger, rgba(239, 68, 68, 0.15))", border: "1px solid var(--color-border-danger, #ef4444)", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{searchError}</span>
          <div style={{ display: "inline-flex", gap: "6px" }}>
            {onRestartSearch && (
              <button
                type="button"
                className="btn btn-primary btn-xs"
                onClick={onRestartSearch}
              >
                从头检索
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={onClearSearch ?? (() => onSearchChange(""))}
            >
              清除搜索
            </button>
          </div>
        </div>
      )}

      {isLoadingInitial && <div role="status">正在读取日志…</div>}
      {residentEvicted && <div role="status">较早日志已移出当前视图，可加载历史记录。</div>}
      {initialFetchError && (
        <div className="log-alert-banner alert-danger" role="alert" style={{ padding: "6px 12px", margin: "4px 8px", background: "var(--color-bg-danger, rgba(239, 68, 68, 0.15))", border: "1px solid var(--color-border-danger, #ef4444)", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{initialFetchError}</span>
          {onReloadFromLatest && (
            <button
              type="button"
              className="btn btn-secondary btn-xs ms-2"
              onClick={onReloadFromLatest}
            >
              重试
            </button>
          )}
        </div>
      )}

      {effectiveAnchorEvicted && (
        <div
          className="log-alert-banner alert-warning"
          role="alert"
          style={{
            padding: "6px 12px",
            margin: "4px 8px",
            background: "var(--color-bg-warning, rgba(234, 179, 8, 0.15))",
            border: "1px solid var(--color-border-warning, #eab308)",
            borderRadius: "4px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>当前阅读位置已被缓冲区淘汰</span>
          <div style={{ display: "inline-flex", gap: "6px" }}>
            {onLoadEarlier && (
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={onLoadEarlier}
              >
                历史重载
              </button>
            )}
            {onReloadFromLatest && (
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => { anchorRef.current = null; setIsAnchorEvictedState(false); onReloadFromLatest(); }}
              >
                重新从最新加载
              </button>
            )}
          </div>
        </div>
      )}

      {/* Viewport Wrapper with Floating Unread Banner Overlay (I6, I15) */}
      <div className="log-viewport-wrapper" style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {isScrollLocked && unreadCount > 0 && (
          <div className="log-unread-floating-banner">
            <span>有 {unreadCount} 条新日志，点击恢复自动滚动</span>
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={handleResumeClick}
            >
              恢复自动滚动
            </button>
          </div>
        )}

        {/* Log Stream Viewport */}
      <div
        ref={parentRef}
        className={"log-viewport " + (isWrapLines ? "wrap-lines" : "nowrap-lines")}
        tabIndex={0}
        role="region"
        aria-label="日志流视窗"
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >

        <div
          className="log-virtual-inner"
          style={{
            height: rowVirtualizer.getTotalSize() + "px",
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const event = events[virtualRow.index];
            if (!event) return null;

            // Render banner for special kinds
            if (event.kind === "gap_confirmed") {
              return (
                <div
                  key={event.eventId}
                  ref={rowVirtualizer.measureElement}
                  data-event-id={event.eventId}
                data-index={virtualRow.index}
                  className="log-event-row banner-gap-confirmed"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: "translateY(" + virtualRow.start + "px)",
                  }}
                >
                  <span className="log-col-time tabular-num" title={`${formatTimestamp(event.ingestedAt)}（本地时间）`}>
                    {formatTimeOnly(event.ingestedAt)}
                  </span>
                  <span className="log-col-text">
                    [确认缺口] 远端此区间数据不可得: {event.reason ?? "未提供原因"}
                  </span>
                </div>
              );
            }

            if (event.kind === "gap_unknown") {
              return (
                <div
                  key={event.eventId}
                  ref={rowVirtualizer.measureElement}
                  data-event-id={event.eventId}
                data-index={virtualRow.index}
                  className="log-event-row banner-gap-unknown"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: "translateY(" + virtualRow.start + "px)",
                  }}
                >
                  <span className="log-col-time tabular-num" title={`${formatTimestamp(event.ingestedAt)}（本地时间）`}>
                    {formatTimeOnly(event.ingestedAt)}
                  </span>
                  <span className="log-col-text">
                    [可能缺段] 无法确认是否存在未读数据: {event.reason ?? "未提供原因"}
                  </span>
                </div>
              );
            }

            if (event.kind === "cache_evicted") {
              return (
                <div
                  key={event.eventId}
                  ref={rowVirtualizer.measureElement}
                  data-event-id={event.eventId}
                data-index={virtualRow.index}
                  className="log-event-row banner-cache-evicted"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: "translateY(" + virtualRow.start + "px)",
                  }}
                >
                  <span className="log-col-time tabular-num" title={`${formatTimestamp(event.ingestedAt)}（本地时间）`}>
                    {formatTimeOnly(event.ingestedAt)}
                  </span>
                  <span className="log-col-text">
                    [历史日志已清理] {event.reason ?? "未提供原因"}
                  </span>
                </div>
              );
            }

            if (event.kind === "import_boundary") {
              return (
                <div
                  key={event.eventId}
                  ref={rowVirtualizer.measureElement}
                  data-event-id={event.eventId}
                data-index={virtualRow.index}
                  className="log-event-row banner-import-boundary"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: "translateY(" + virtualRow.start + "px)",
                  }}
                >
                  <span className="log-col-time tabular-num" title={`${formatTimestamp(event.ingestedAt)}（本地时间）`}>
                    {formatTimeOnly(event.ingestedAt)}
                  </span>
                  <span className="log-col-text">
                    [首次导入起点] 仅导入尾部数据，此前历史未导入
                  </span>
                </div>
              );
            }

            if (event.kind === "generation_started") {
              return (
                <div
                  key={event.eventId}
                  ref={rowVirtualizer.measureElement}
                  data-event-id={event.eventId}
                data-index={virtualRow.index}
                  className="log-event-row banner-generation-started"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: "translateY(" + virtualRow.start + "px)",
                  }}
                >
                  <span className="log-col-time tabular-num" title={`${formatTimestamp(event.ingestedAt)}（本地时间）`}>
                    {formatTimeOnly(event.ingestedAt)}
                  </span>
                  <span className="log-col-text">
                    [日志文件已更新]
                  </span>
                </div>
              );
            }

            // Normal line / redraw with dynamic height measurement (I5)
            return (
              <div
                key={event.eventId}
                ref={rowVirtualizer.measureElement}
                data-event-id={event.eventId}
                data-index={virtualRow.index}
                className={"log-event-row " + (event.kind === "redraw" ? "log-row-redraw" : "")}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: "translateY(" + virtualRow.start + "px)",
                }}
              >
                <span className="log-col-time tabular-num" title={`${formatTimestamp(event.ingestedAt)}（本地时间）`}>
                  {formatTimeOnly(event.ingestedAt)}
                </span>
                <span className="log-col-text">
                  {event.text}
                  {event.displayTruncated && (
                    <span className="log-truncated-tag">[已截断过长单行]</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      </div>

      <div className="log-console-footer">
        <span className="footer-item">{sourceStateBadge}</span>
        <span className="footer-item tabular-num">{totalBufferedCount.toLocaleString()} 行</span>
      </div>
    </div>
  );
}
