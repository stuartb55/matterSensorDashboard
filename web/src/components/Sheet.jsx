import { useEffect, useRef } from 'react';

/**
 * Bottom sheet shell shared by every detail view: backdrop, Escape to close,
 * focus moved into the dialog and page scroll held while it is open.
 */
export default function Sheet({ label, onClose, children }) {
  const sheetRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    sheetRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={sheetRef}
        tabIndex={-1}
      >
        <div className="grabber" aria-hidden="true" />
        {children}
      </div>
    </>
  );
}

export function CloseButton({ onClose }) {
  return (
    <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M5 5l10 10M15 5L5 15"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
