"use client";

import { useEffect, useRef, useState } from "react";
import { createAssetIconLoader } from "@/lib/asset-icon-client.mjs";

const loader = createAssetIconLoader();

export function AssetAvatar({ symbol }: { symbol: string }) {
  const container = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<{ symbol: string; src: string; loaded: boolean } | null>(null);
  const current = image?.symbol === symbol ? image : null;

  useEffect(() => {
    let active = true, requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void loader.load(symbol).then((src) => {
        if (active) setImage(src ? { symbol, src, loaded: false } : null);
      });
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "undefined") load();
    else if (container.current) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); load(); }
      }, { rootMargin: "80px" });
      observer.observe(container.current);
    }
    return () => { active = false; observer?.disconnect(); };
  }, [symbol]);

  return (
    <span ref={container} className={`asset-avatar${current?.loaded ? " has-image" : ""}`} aria-hidden="true">
      {!current?.loaded && symbol.trim().toUpperCase().slice(0, 1)}
      {current && <img src={current.src} alt="" width={25} height={25} draggable={false}
        className={current.loaded ? "" : "asset-avatar-image-loading"}
        onLoad={() => setImage((value) => value?.symbol === symbol && value.src === current.src ? { ...value, loaded: true } : value)}
        onError={() => {
          loader.reportFailure(symbol, current.src);
          setImage((value) => value?.symbol === symbol && value.src === current.src ? null : value);
        }} />}
    </span>
  );
}
