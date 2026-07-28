"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared admin/ops modal shell:
 * - title + X
 * - optional footer 닫기
 * - ESC / backdrop click
 */
export function AppModal({
  open,
  title,
  onClose,
  children,
  footer,
  showCloseButton = true,
  className,
  zIndexClass = "z-[60]",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  showCloseButton?: boolean;
  className?: string;
  zIndexClass?: string;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 flex items-end justify-center p-4 sm:items-center",
        zIndexClass,
      )}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[2px]"
        aria-label="닫기"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative z-10 w-full max-w-md rounded-2xl border border-border/80 bg-card p-5 shadow-lg",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3">{children}</div>
        {footer != null ? (
          <div className="mt-5">{footer}</div>
        ) : showCloseButton ? (
          <div className="mt-5 flex justify-end">
            <Button type="button" size="sm" variant="secondary" onClick={onClose}>
              닫기
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
