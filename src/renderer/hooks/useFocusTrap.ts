import { useEffect, useRef } from 'react';

export function useFocusTrap(isOpen: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;

    // Mark sibling elements outside overlay inert (I14)
    const inertElements: HTMLElement[] = [];
    const overlay = containerRef.current?.closest('.modal-overlay, .drawer-overlay') as HTMLElement | null;
    const appShell = document.querySelector('.app-shell') as HTMLElement | null;
    const rootEl = appShell ?? document.body;
    if (rootEl && overlay) {
      for (let i = 0; i < rootEl.children.length; i++) {
        const child = rootEl.children[i] as HTMLElement;
        if (child !== overlay && !child.contains(overlay)) {
          if (!child.hasAttribute('inert')) {
            child.setAttribute('inert', '');
            inertElements.push(child);
          }
        }
      }
    }

    // Focus the first focusable element or the container ONLY if focus is not already inside
    if (!containerRef.current?.contains(document.activeElement)) {
      const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );

      if (focusable && focusable.length > 0) {
        focusable[0]?.focus();
      } else {
        containerRef.current?.focus();
      }
    }

    const handleFocusIn = (e: FocusEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        const elements = containerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (elements.length > 0) {
          elements[0]?.focus();
        } else {
          containerRef.current.focus();
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const isComposing = (e as any).isComposing === true || e.keyCode === 229;
        if (isComposing) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab') {
        const elements = containerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!elements || elements.length === 0) return;

        const first = elements[0];
        const last = elements[elements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);

    return () => {
      document.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      for (const el of inertElements) {
        el.removeAttribute('inert');
      }
      const opener = previousActiveElementRef.current;
      if (opener?.isConnected && !opener.closest('[inert], [hidden]') && !opener.matches(':disabled') && opener.getAttribute('aria-disabled') !== 'true') {
        opener.focus();
      }
    };
  }, [isOpen]);

  return containerRef;
}
