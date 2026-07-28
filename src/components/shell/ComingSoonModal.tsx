"use client";

import { AppModal } from "@/components/ui/AppModal";

export function ComingSoonModal({
  open,
  title = "준비 중입니다",
  message,
  onClose,
}: {
  open: boolean;
  title?: string;
  message: string;
  onClose: () => void;
}) {
  return (
    <AppModal open={open} title={title} onClose={onClose} footer={null}>
      <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
    </AppModal>
  );
}
