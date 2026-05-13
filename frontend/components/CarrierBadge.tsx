"use client";

import { useState } from "react";

import { carrierBadgeColor, carrierLogoUrl, carrierName, type CarrierCode } from "@/lib/carriers";

// Pill badge that identifies a carrier. Renders the carrier's favicon (via
// Google's public favicon service) alongside the name. If the favicon fails
// to load — common for self-hosted carriers behind a strict firewall — we
// fall back silently to a colored-text-only pill.
export function CarrierBadge({
  code,
  size = "sm"
}: {
  code: CarrierCode | string | null | undefined;
  size?: "sm" | "md";
}) {
  const [imgFailed, setImgFailed] = useState(false);

  if (!code) {
    return null;
  }

  const name = carrierName(code);
  const color = carrierBadgeColor(code);
  const logo = carrierLogoUrl(code);
  const padding = size === "md" ? "px-2.5 py-1 text-sm" : "px-2 py-0.5 text-xs";
  const logoSize = size === "md" ? "h-5 w-5" : "h-4 w-4";

  const showLogo = logo && !imgFailed;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded font-medium text-white ${padding} ${color}`}>
      {showLogo ? (
        // 16-20px favicon; not worth the next/image pipeline overhead.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          aria-hidden
          className={`${logoSize} flex-none rounded-sm bg-white object-contain p-0.5`}
          onError={() => setImgFailed(true)}
        />
      ) : null}
      {name}
    </span>
  );
}
