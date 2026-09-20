import { useEffect, useRef, useState, type JSX } from "react";
import { REVIEW_LABELS, REVIEW_ORDER, type ReviewStatus } from "../domain/review";

export function ReviewBeforeNavigateDialog({ initialStatus, onConfirm, onCancel }: {
  initialStatus: ReviewStatus;
  onConfirm: (status: ReviewStatus, suppress: boolean) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<ReviewStatus | null>(initialStatus);
  const [suppress, setSuppress] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="confirm-backdrop">
    <div ref={dialog} className="confirm-dialog review-navigation-dialog" role="dialog" aria-modal="true"
      aria-labelledby="review-navigation-title" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
        if (event.key === "Tab") {
          const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])];
          if (!controls.length) { event.preventDefault(); return; }
          const index = controls.indexOf(document.activeElement as HTMLElement);
          event.preventDefault();
          controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
        }
      }}>
      <h2 id="review-navigation-title">请选择审核意见</h2>
      <p>当前图片仍为待审核，请选择审核意见后继续翻页。</p>
      <fieldset disabled={busy}>
        <legend>审核意见</legend>
        <div className="review-navigation-options">
          {REVIEW_ORDER.map(value => <label key={value} className={`review-choice is-${value}`}>
            <input type="radio" name="navigation-review" value={value} checked={status === value} onChange={() => setStatus(value)} />
            {REVIEW_LABELS[value]}
          </label>)}
        </div>
        <label className="review-suppress"><input type="checkbox" checked={suppress} onChange={e => setSuppress(e.target.checked)} />本次会话不再提示</label>
      </fieldset>
      <div className="confirm-actions">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" disabled={busy || status === null} onClick={async () => {
          if (!status) return;
          setBusy(true);
          try { await onConfirm(status, suppress); } finally { setBusy(false); }
        }}>{busy ? "正在保存…" : "确认并翻页"}</button>
      </div>
    </div>
  </div>;
}
