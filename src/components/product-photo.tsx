"use client";

import { useRef, useState, type ReactNode } from "react";
import { ImageIcon, Package } from "lucide-react";
import { productPhotoTypes } from "@/lib/product-photo";

export function ProductPhoto({ src, className, fallback }: { src?: string; className?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState<string>();
  if (!src || src === failed) return fallback;
  return <img className={className} alt="" src={src} loading="lazy" decoding="async" onError={() => setFailed(src)} />;
}

export function ProductPhotoField({ src, disabled, preparing, onChoose, onRemove }: {
  src?: string; disabled: boolean; preparing: boolean;
  onChoose: (file: File) => void; onRemove: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return <div className="product-photo-field">
    <div className="product-thumbnail" aria-hidden="true">
      <ProductPhoto src={src} fallback={<Package size={20} />} />
    </div>
    <div>
      <strong>Item photo</strong>
      <small>JPG, PNG or WebP up to 12 MB</small>
      <input ref={picker} type="file" hidden aria-label="Item photo file" accept={productPhotoTypes.join(",")}
        disabled={disabled} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onChoose(file);
        }} />
      <div className="product-photo-actions">
        <button type="button" className="console-button small" disabled={disabled} onClick={() => picker.current?.click()}>
          <ImageIcon size={14} /> {preparing ? "Preparing…" : src ? "Change photo" : "Add photo"}
        </button>
        {src && <button type="button" className="text-action" disabled={disabled} onClick={onRemove}>Remove photo</button>}
      </div>
    </div>
  </div>;
}
