import { useState, useEffect, useRef, useCallback } from 'react';
import type { LogEvent, LogSourceSnapshot } from '../../shared/contracts';
import type { LogLevelFilter } from '../../shared/api';
import {
  UI_EVENT_LIMIT,
  UI_TEXT_BUDGET_BYTES,
  EVENT_PREVIEW_BYTES,
  PAGE_EVENT_LIMIT,
} from '../../shared/budgets';
import { isSafeRegexPattern } from '../../shared/validate';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

let globalRequestSeq = 0;
function nextRequestId(prefix: string) {
  globalRequestSeq += 1;
  return `${prefix}-${Date.now()}-${globalRequestSeq}`;
}

function truncateUtf8(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.byteLength <= maxBytes) return bytes;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--;
  }
  if (cut > 0) {
    const lead = bytes[cut]!;
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    if (cut + seqLen <= maxBytes) {
      cut += seqLen;
    }
  }
  return bytes.subarray(0, cut);
}

function sanitizeLogEvent(event: LogEvent): { event: LogEvent; bytes: number } {
  if (event.text === null || event.text === undefined) {
    return { event, bytes: 0 };
  }

  const rawBytes = textEncoder.encode(event.text);
  if (rawBytes.byteLength > EVENT_PREVIEW_BYTES) {
    const truncatedBytes = truncateUtf8(rawBytes, EVENT_PREVIEW_BYTES);
    const text = textDecoder.decode(truncatedBytes);
    const bytes = textEncoder.encode(text).byteLength;
    return {
      event: { ...event, text, displayTruncated: true },
      bytes,
    };
  }

  return { event, bytes: rawBytes.byteLength };
}

function computeTotalBytes(events: LogEvent[]): number {
  let bytes = 0;
  for (const e of events) {
    if (e.text) {
      bytes += textEncoder.encode(e.text).byteLength;
    }
  }
  return bytes;
}

export type UiLogLevelFilter = 'all' | 'error' | 'warn' | 'info';

export function useLogBuffer(taskId: string | null, sources: LogSourceSnapshot[] = []) {
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [events, publishEvents] = useState<LogEvent[]>([]);
  const [isScrollLocked, setIsScrollLocked] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMode, setSearchModeState] = useState<'literal' | 'regex'>('literal');
  const [searchCaseSensitive, setSearchCaseSensitiveState] = useState<boolean>(false);
  const [levelFilter, setLevelFilterState] = useState<UiLogLevelFilter>('all');
  const [searchResults, publishSearchResults] = useState<LogEvent[] | null>(null);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isWrapLines, setIsWrapLines] = useState<boolean>(true);

  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [truncatedByBudget, setTruncatedByBudget] = useState<boolean>(false);
  const [searchContinuation, setSearchContinuation] = useState<string | null>(null);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState<boolean>(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [initialFetchError, setInitialFetchError] = useState<string | null>(null);

  const eventsRef = useRef<LogEvent[]>([]);
  const bytesRef = useRef<number>(0);
  const isScrollLockedRef = useRef<boolean>(false);
  const activeSearchRequestIdRef = useRef<string | null>(null);
  const activePageRequestIdRef = useRef<string | null>(null);
  const activeEarlierRequestIdRef = useRef<string | null>(null);

  const searchModeRef = useRef<'literal' | 'regex'>(searchMode);
  const searchCaseRef = useRef<boolean>(searchCaseSensitive);
  const levelFilterRef = useRef<UiLogLevelFilter>(levelFilter);
  const searchQueryRef = useRef<string>(searchQuery);
  searchModeRef.current = searchMode;
  searchCaseRef.current = searchCaseSensitive;
  levelFilterRef.current = levelFilter;
  searchQueryRef.current = searchQuery;

  const epochCounterRef = useRef<number>(0);
  const currentEpochRef = useRef<{
    taskId: string | null;
    sourceId: string | null;
    generation: string | null;
    epochId: number;
  }>({ taskId: null, sourceId: null, generation: null, epochId: 0 });

  isScrollLockedRef.current = isScrollLocked;

  const searchResultsRef = useRef<LogEvent[] | null>(null);
  const [residentEvicted, setResidentEvicted] = useState(false);

  const commitResident = useCallback((target: 'live' | 'search', incoming: LogEvent[] | null) => {
    let live = target === 'live' ? (incoming ?? []) : eventsRef.current;
    let search = target === 'search' ? incoming : searchResultsRef.current;
    const canonical = new Map<string, LogEvent>();
    const other = target === 'live' ? search : live;
    for (const ev of other ?? []) canonical.set(ev.eventId, ev);
    for (const ev of incoming ?? []) canonical.set(ev.eventId, ev);
    const ids = (list: LogEvent[]) => [...new Set(list.map((ev) => ev.eventId))];
    let liveIds = ids(live);
    let searchIds = search === null ? null : ids(search);
    const activeIds = searchIds ?? liveIds;
    const activeSet = new Set(activeIds);
    const evictionOrder = [...liveIds.filter((id) => !activeSet.has(id)), ...activeIds];
    const retained = new Set([...liveIds, ...(searchIds ?? [])]);
    let bytes = computeTotalBytes([...retained].map((id) => canonical.get(id)!));
    let evicted = false;
    for (const id of evictionOrder) {
      if (retained.size <= UI_EVENT_LIMIT && bytes <= UI_TEXT_BUDGET_BYTES) break;
      if (!retained.delete(id)) continue;
      bytes -= textEncoder.encode(canonical.get(id)?.text ?? '').byteLength;
      evicted = true;
    }
    liveIds = liveIds.filter((id) => retained.has(id));
    searchIds = searchIds?.filter((id) => retained.has(id)) ?? null;
    live = liveIds.map((id) => canonical.get(id)!);
    search = searchIds?.map((id) => canonical.get(id)!) ?? null;
    eventsRef.current = live;
    searchResultsRef.current = search;
    bytesRef.current = computeTotalBytes(live);
    publishEvents(live);
    publishSearchResults(search);
    if (evicted) setResidentEvicted(true);
  }, []);

  const setEvents = useCallback((value: LogEvent[]) => commitResident('live', value), [commitResident]);
  const setSearchResults = useCallback(
    (value: LogEvent[] | null | ((prev: LogEvent[] | null) => LogEvent[])) => {
      commitResident('search', typeof value === 'function' ? value(searchResultsRef.current) : value);
    },
    [commitResident],
  );

  const taskSources = sources.filter((s) => s.taskId === taskId);
  const activeSource = taskSources.find((s) => s.sourceId === activeSourceId) ?? taskSources[0] ?? null;
  const effectiveSourceId = activeSource?.sourceId ?? null;
  const currentGeneration = activeSource?.generation ?? null;

  useEffect(() => {
    if (effectiveSourceId !== activeSourceId) {
      setActiveSourceId(effectiveSourceId);
    }
  }, [effectiveSourceId, activeSourceId]);

  useEffect(() => {
    return () => {
      if (activeSearchRequestIdRef.current) {
        Promise.resolve(window.monitor.cancelRequest(activeSearchRequestIdRef.current)).catch(() => {});
        activeSearchRequestIdRef.current = null;
      }
      if (activePageRequestIdRef.current) {
        Promise.resolve(window.monitor.cancelRequest(activePageRequestIdRef.current)).catch(() => {});
        activePageRequestIdRef.current = null;
      }
    };
  }, [taskId]);

  useEffect(() => {
    epochCounterRef.current += 1;
    const epochId = epochCounterRef.current;
    currentEpochRef.current = {
      taskId,
      sourceId: effectiveSourceId,
      generation: currentGeneration,
      epochId,
    };

    if (activeSearchRequestIdRef.current) {
      Promise.resolve(window.monitor.cancelRequest(activeSearchRequestIdRef.current)).catch(() => {});
      activeSearchRequestIdRef.current = null;
    }
    if (activePageRequestIdRef.current) {
      Promise.resolve(window.monitor.cancelRequest(activePageRequestIdRef.current)).catch(() => {});
      activePageRequestIdRef.current = null;
    }
    if (activeEarlierRequestIdRef.current) {
      Promise.resolve(window.monitor.cancelRequest(activeEarlierRequestIdRef.current)).catch(() => {});
      activeEarlierRequestIdRef.current = null;
    }
    setIsLoadingEarlier(false);
    setPagingError(null);
    setSearchError(null);
    setInitialFetchError(null);
    setResidentEvicted(false);

    setEvents([]);
    eventsRef.current = [];
    bytesRef.current = 0;
    setUnreadCount(0);
    setSearchResults(null);
    setSearchQuery('');
    setIsSearching(false);
    setSearchContinuation(null);
    setNextBefore(null);
    setTruncatedByBudget(false);

    if (!effectiveSourceId) {
      setIsLoadingInitial(false);
      return;
    }
    setIsLoadingInitial(true);

    const pageRequestId = nextRequestId('page');
    activePageRequestIdRef.current = pageRequestId;

    window.monitor
      .getLogs({
        requestId: pageRequestId,
        sourceId: effectiveSourceId,
        before: null,
        limit: PAGE_EVENT_LIMIT,
      })
      .then((page) => {
        if (currentEpochRef.current.epochId !== epochId || activePageRequestIdRef.current !== pageRequestId) return;
        setNextBefore(page.nextBefore);
        setTruncatedByBudget(page.truncatedByBudget);

        const sanitizedPage = page.events
          .filter(
            (e) =>
              e.taskId === currentEpochRef.current.taskId &&
              e.sourceId === currentEpochRef.current.sourceId &&
              (!currentEpochRef.current.generation || e.generation === currentEpochRef.current.generation),
          )
          .map((e) => sanitizeLogEvent(e).event)
          .reverse();

        const liveEvents = eventsRef.current;
        const liveMap = new Map(liveEvents.map((e) => [e.eventId, e]));
        const merged: LogEvent[] = [];
        const seen = new Set<string>();

        for (const pe of sanitizedPage) {
          if (liveMap.has(pe.eventId)) merged.push(liveMap.get(pe.eventId)!);
          else merged.push(pe);
          seen.add(pe.eventId);
        }
        for (const le of liveEvents) {
          if (!seen.has(le.eventId)) merged.push(le);
        }

        let totalBytes = computeTotalBytes(merged);
        if (merged.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) setResidentEvicted(true);
        while (merged.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) {
          const dropped = merged.shift();
          if (dropped?.text) totalBytes -= textEncoder.encode(dropped.text).byteLength;
        }

        setEvents(merged);
      })
      .catch((err: any) => {
        if (currentEpochRef.current.epochId !== epochId || activePageRequestIdRef.current !== pageRequestId) return;
        const msg = err?.message || String(err);
        if (/cancelled|abort/i.test(msg)) return;
        setInitialFetchError('读取初始日志失败: ' + msg);
      })
      .finally(() => {
        if (currentEpochRef.current.epochId === epochId && activePageRequestIdRef.current === pageRequestId) {
          setIsLoadingInitial(false);
          activePageRequestIdRef.current = null;
        }
      });

    const unsubscribe = window.monitor.subscribe((update) => {
      if (update.kind !== 'logs' || update.sourceId !== effectiveSourceId) return;
      if (currentEpochRef.current.epochId !== epochId) return;

      const current = [...eventsRef.current];
      let totalBytes = bytesRef.current;
      let newArrivedCount = 0;

      for (const raw of update.events) {
        if (taskId && raw.taskId !== taskId) continue;
        if (effectiveSourceId && raw.sourceId !== effectiveSourceId) continue;
        if (currentGeneration && raw.generation !== currentGeneration) continue;
        const { event, bytes } = sanitizeLogEvent(raw);
        const existingIndex = current.findIndex((e) => e.eventId === event.eventId);

        if (existingIndex >= 0) {
          const oldBytes = textEncoder.encode(current[existingIndex]?.text ?? '').byteLength;
          totalBytes = totalBytes - oldBytes + bytes;
          current[existingIndex] = event;
        } else {
          current.push(event);
          totalBytes += bytes;
          newArrivedCount += 1;
        }
      }

      if (current.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) setResidentEvicted(true);
      while (current.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) {
        const dropped = current.shift();
        if (dropped?.text) totalBytes -= textEncoder.encode(dropped.text).byteLength;
      }

      setEvents(current);

      if (isScrollLockedRef.current && newArrivedCount > 0) {
        setUnreadCount((c) => c + newArrivedCount);
      }
    });

    return () => {
      unsubscribe();
      if (activePageRequestIdRef.current === pageRequestId) {
        Promise.resolve(window.monitor.cancelRequest(pageRequestId)).catch(() => {});
        activePageRequestIdRef.current = null;
      }
      if (activeEarlierRequestIdRef.current) {
        Promise.resolve(window.monitor.cancelRequest(activeEarlierRequestIdRef.current)).catch(() => {});
        activeEarlierRequestIdRef.current = null;
      }
    };
  }, [taskId, effectiveSourceId, currentGeneration, setEvents, setSearchResults]);

  const loadEarlierLogs = useCallback(async () => {
    if (!nextBefore || !effectiveSourceId || isLoadingEarlier) return;

    setIsLoadingEarlier(true);
    setPagingError(null);
    const requestId = nextRequestId('page-earlier');
    activeEarlierRequestIdRef.current = requestId;
    const pageEpochId = currentEpochRef.current.epochId;
    try {
      const page = await window.monitor.getLogs({
        requestId,
        sourceId: effectiveSourceId,
        before: nextBefore,
        limit: PAGE_EVENT_LIMIT,
      });

      if (currentEpochRef.current.epochId !== pageEpochId || activeEarlierRequestIdRef.current !== requestId) return;

      setNextBefore(page.nextBefore);
      setTruncatedByBudget(page.truncatedByBudget);

      const sanitizedEarlier = page.events
        .filter(
          (e) =>
            e.taskId === currentEpochRef.current.taskId &&
            e.sourceId === currentEpochRef.current.sourceId &&
            (!currentEpochRef.current.generation || e.generation === currentEpochRef.current.generation),
        )
        .map((e) => sanitizeLogEvent(e).event)
        .reverse();

      const current = [...eventsRef.current];
      const existingIds = new Set(current.map((e) => e.eventId));
      const prepended = sanitizedEarlier.filter((e) => !existingIds.has(e.eventId));

      const merged = [...prepended, ...current];
      let totalBytes = computeTotalBytes(merged);

      if (merged.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) setResidentEvicted(true);
      while (merged.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) {
        const dropped = merged.pop();
        if (dropped?.text) totalBytes -= textEncoder.encode(dropped.text).byteLength;
      }

      setEvents(merged);
    } catch (err: any) {
      if (currentEpochRef.current.epochId !== pageEpochId || activeEarlierRequestIdRef.current !== requestId) return;
      const msg = err?.message || '未知错误';
      if (msg.includes('STALE_CONTINUATION')) {
        setNextBefore(null);
        setPagingError('历史日志位置已过期，请从最新位置重新加载');
      } else {
        setPagingError('加载历史日志失败: ' + msg);
      }
    } finally {
      if (activeEarlierRequestIdRef.current === requestId) {
        setIsLoadingEarlier(false);
        activeEarlierRequestIdRef.current = null;
      }
    }
  }, [nextBefore, effectiveSourceId, isLoadingEarlier, setEvents]);

  const cancelEarlierLogs = useCallback(() => {
    if (activeEarlierRequestIdRef.current) {
      Promise.resolve(window.monitor.cancelRequest(activeEarlierRequestIdRef.current)).catch(() => {});
      activeEarlierRequestIdRef.current = null;
    }
    setIsLoadingEarlier(false);
  }, []);

  const reloadFromLatest = useCallback(() => {
    setPagingError(null);
    setInitialFetchError(null);
    setNextBefore(null);
    if (!effectiveSourceId) return;

    const atRequest = new WeakSet(eventsRef.current);
    setIsLoadingInitial(true);
    const epochId = currentEpochRef.current.epochId;
    const pageRequestId = nextRequestId('page-reload');
    activePageRequestIdRef.current = pageRequestId;

    window.monitor
      .getLogs({
        requestId: pageRequestId,
        sourceId: effectiveSourceId,
        before: null,
        limit: PAGE_EVENT_LIMIT,
      })
      .then((page) => {
        if (currentEpochRef.current.epochId !== epochId || activePageRequestIdRef.current !== pageRequestId) return;
        setNextBefore(page.nextBefore);
        setTruncatedByBudget(page.truncatedByBudget);
        const sanitizedPage = page.events
          .filter(
            (e) =>
              e.taskId === currentEpochRef.current.taskId &&
              e.sourceId === currentEpochRef.current.sourceId &&
              (!currentEpochRef.current.generation || e.generation === currentEpochRef.current.generation),
          )
          .map((e) => sanitizeLogEvent(e).event)
          .reverse();

        const pageIds = new Set(sanitizedPage.map((e) => e.eventId));
        const liveEvents = eventsRef.current.filter((e) => pageIds.has(e.eventId) || !atRequest.has(e));
        const liveMap = new Map(liveEvents.map((e) => [e.eventId, e]));
        const merged: LogEvent[] = [];
        const seen = new Set<string>();

        for (const pe of sanitizedPage) {
          if (liveMap.has(pe.eventId)) merged.push(liveMap.get(pe.eventId)!);
          else merged.push(pe);
          seen.add(pe.eventId);
        }
        for (const le of liveEvents) {
          if (!seen.has(le.eventId)) merged.push(le);
        }

        let totalBytes = computeTotalBytes(merged);
        if (merged.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) setResidentEvicted(true);
        while (merged.length > UI_EVENT_LIMIT || totalBytes > UI_TEXT_BUDGET_BYTES) {
          const dropped = merged.shift();
          if (dropped?.text) totalBytes -= textEncoder.encode(dropped.text).byteLength;
        }

        setEvents(merged);
      })
      .catch((err: any) => {
        if (currentEpochRef.current.epochId !== epochId || activePageRequestIdRef.current !== pageRequestId) return;
        const msg = err?.message || String(err);
        if (/cancelled|abort/i.test(msg)) return;
        setInitialFetchError('读取初始日志失败: ' + msg);
      })
      .finally(() => {
        if (currentEpochRef.current.epochId === epochId && activePageRequestIdRef.current === pageRequestId) {
          setIsLoadingInitial(false);
          activePageRequestIdRef.current = null;
        }
      });
  }, [effectiveSourceId, setEvents]);

  const runSearch = useCallback(
    async (
      query: string,
      opts?: { mode?: 'literal' | 'regex'; caseSensitive?: boolean; level?: UiLogLevelFilter },
    ) => {
      const mode = opts?.mode ?? searchModeRef.current;
      const caseSensitive = opts?.caseSensitive ?? searchCaseRef.current;
      const level = opts?.level ?? levelFilterRef.current;

      setSearchQuery(query);
      setPagingError(null);
      setSearchError(null);
      if (!query.trim() || !effectiveSourceId) {
        if (activeSearchRequestIdRef.current) {
          Promise.resolve(window.monitor.cancelRequest(activeSearchRequestIdRef.current)).catch(() => {});
          activeSearchRequestIdRef.current = null;
        }
        setSearchResults(null);
        setIsSearching(false);
        setSearchContinuation(null);
        return;
      }

      if (mode === 'regex' && !isSafeRegexPattern(query)) {
        setSearchError('正则表达式语法无效或过于复杂');
        setIsSearching(false);
        return;
      }

      if (activeSearchRequestIdRef.current) {
        Promise.resolve(window.monitor.cancelRequest(activeSearchRequestIdRef.current)).catch(() => {});
      }

      const requestId = nextRequestId('search');
      activeSearchRequestIdRef.current = requestId;
      setIsSearching(true);
      const searchEpochId = currentEpochRef.current.epochId;

      const reqPayload: {
        requestId: string;
        sourceIds: string[];
        literal: string;
        continuation: string | null;
        mode?: 'literal' | 'regex';
        caseSensitive?: boolean;
        level?: LogLevelFilter | null;
      } = {
        requestId,
        sourceIds: [effectiveSourceId],
        literal: query,
        continuation: null,
      };
      if (mode === 'regex') reqPayload.mode = 'regex';
      if (caseSensitive) reqPayload.caseSensitive = true;
      if (level !== 'all') reqPayload.level = level;

      try {
        const page = await window.monitor.searchLogs(reqPayload);

        if (
          !page.cancelled &&
          activeSearchRequestIdRef.current === requestId &&
          currentEpochRef.current.epochId === searchEpochId
        ) {
          const sanitized = page.events
            .filter(
              (e) =>
                e.taskId === currentEpochRef.current.taskId &&
                e.sourceId === currentEpochRef.current.sourceId &&
                (!currentEpochRef.current.generation || e.generation === currentEpochRef.current.generation),
            )
            .map((e) => sanitizeLogEvent(e).event);
          setSearchResults(sanitized);
          setSearchContinuation(page.continuation);
        }
      } catch (err: any) {
        if (
          activeSearchRequestIdRef.current === requestId &&
          currentEpochRef.current.epochId === searchEpochId
        ) {
          const msg = err?.message || '未知错误';
          if (msg.includes('STALE_CONTINUATION')) {
            setSearchContinuation(null);
            setSearchError('搜索分页位置已过期，请重新开始搜索');
          } else {
            setSearchError('日志搜索失败: ' + msg);
          }
        }
      } finally {
        if (activeSearchRequestIdRef.current === requestId) {
          setIsSearching(false);
        }
      }
    },
    [effectiveSourceId, setSearchResults],
  );

  const executeSearch = useCallback(
    async (query: string) => runSearch(query),
    [runSearch],
  );

  const setSearchMode = useCallback(
    (mode: 'literal' | 'regex') => {
      setSearchModeState(mode);
      searchModeRef.current = mode;
      if (searchQueryRef.current.trim()) {
        void runSearch(searchQueryRef.current, { mode });
      }
    },
    [runSearch],
  );

  const setSearchCaseSensitive = useCallback(
    (caseSensitive: boolean) => {
      setSearchCaseSensitiveState(caseSensitive);
      searchCaseRef.current = caseSensitive;
      if (searchQueryRef.current.trim()) {
        void runSearch(searchQueryRef.current, { caseSensitive });
      }
    },
    [runSearch],
  );

  const setLevelFilter = useCallback(
    (level: UiLogLevelFilter) => {
      setLevelFilterState(level);
      levelFilterRef.current = level;
      if (searchQueryRef.current.trim()) {
        void runSearch(searchQueryRef.current, { level });
      }
    },
    [runSearch],
  );

  const loadMoreSearchResults = useCallback(async () => {
    if (!searchContinuation || !effectiveSourceId || !searchQuery || isSearching) return;

    const requestId = nextRequestId('search-more');
    activeSearchRequestIdRef.current = requestId;
    setIsSearching(true);
    const searchEpochId = currentEpochRef.current.epochId;

    const reqPayload: {
      requestId: string;
      sourceIds: string[];
      literal: string;
      continuation: string | null;
      mode?: 'literal' | 'regex';
      caseSensitive?: boolean;
      level?: LogLevelFilter | null;
    } = {
      requestId,
      sourceIds: [effectiveSourceId],
      literal: searchQuery,
      continuation: searchContinuation,
    };
    if (searchModeRef.current === 'regex') reqPayload.mode = 'regex';
    if (searchCaseRef.current) reqPayload.caseSensitive = true;
    if (levelFilterRef.current !== 'all') reqPayload.level = levelFilterRef.current;

    try {
      const page = await window.monitor.searchLogs(reqPayload);

      if (
        !page.cancelled &&
        activeSearchRequestIdRef.current === requestId &&
        currentEpochRef.current.epochId === searchEpochId
      ) {
        const sanitized = page.events
          .filter(
            (e) =>
              e.taskId === currentEpochRef.current.taskId &&
              e.sourceId === currentEpochRef.current.sourceId &&
              (!currentEpochRef.current.generation || e.generation === currentEpochRef.current.generation),
          )
          .map((e) => sanitizeLogEvent(e).event);
        setSearchResults((prev) => {
          const curr = prev ? [...prev] : [];
          for (const ev of sanitized) {
            const index = curr.findIndex((e) => e.eventId === ev.eventId);
            if (index >= 0) curr[index] = ev;
            else curr.push(ev);
          }
          return curr;
        });
        setSearchContinuation(page.continuation);
      }
    } catch (err: any) {
      if (
        activeSearchRequestIdRef.current === requestId &&
        currentEpochRef.current.epochId === searchEpochId
      ) {
        const msg = err?.message || '未知错误';
        if (msg.includes('STALE_CONTINUATION')) {
          setSearchContinuation(null);
          setSearchError('搜索分页位置已过期，请重新开始搜索');
        } else {
          setSearchError('加载更多搜索结果失败: ' + msg);
        }
      }
    } finally {
      if (activeSearchRequestIdRef.current === requestId) {
        setIsSearching(false);
      }
    }
  }, [searchContinuation, effectiveSourceId, searchQuery, isSearching, setSearchResults]);

  const clearSearch = useCallback(() => {
    if (activeSearchRequestIdRef.current) {
      Promise.resolve(window.monitor.cancelRequest(activeSearchRequestIdRef.current)).catch(() => {});
      activeSearchRequestIdRef.current = null;
    }
    setSearchQuery('');
    setSearchResults(null);
    setIsSearching(false);
    setSearchContinuation(null);
    setSearchError(null);
  }, [setSearchResults]);

  const restartSearch = useCallback(() => {
    if (searchQuery.trim()) {
      void executeSearch(searchQuery);
    }
  }, [searchQuery, executeSearch]);

  const resumeAutoScroll = useCallback(() => {
    setIsScrollLocked(false);
    setUnreadCount(0);
  }, []);

  const toggleScrollLock = useCallback(() => {
    setIsScrollLocked((prev) => {
      const next = !prev;
      if (!next) setUnreadCount(0);
      return next;
    });
  }, []);

  const activeEvents = searchResults !== null ? searchResults : events;
  const resident = new Map([...events, ...(searchResults ?? [])].map((e) => [e.eventId, e]));
  const totalCount = resident.size;
  const totalBytes = computeTotalBytes([...resident.values()]);

  return {
    sources: taskSources,
    activeSource,
    activeSourceId: effectiveSourceId,
    setActiveSourceId,
    events: activeEvents,
    totalBufferedCount: totalCount,
    totalBufferedBytes: totalBytes,
    isScrollLocked,
    setIsScrollLocked,
    unreadCount,
    resumeAutoScroll,
    toggleScrollLock,
    searchQuery,
    searchMode,
    setSearchMode,
    searchCaseSensitive,
    setSearchCaseSensitive,
    levelFilter,
    setLevelFilter,
    executeSearch,
    restartSearch,
    clearSearch,
    cancelEarlierLogs,
    initialFetchError,
    isLoadingInitial,
    residentEvicted,
    searchResults,
    isSearching,
    isWrapLines,
    setIsWrapLines,
    nextBefore,
    truncatedByBudget,
    loadEarlierLogs,
    searchContinuation,
    loadMoreSearchResults,
    isLoadingEarlier,
    pagingError,
    searchError,
    reloadFromLatest,
  };
}
