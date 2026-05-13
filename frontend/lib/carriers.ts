// Carrier registry. 26 carriers + "other" catch-all.
//
// Each entry has:
//   name       — display name
//   url(nb)    — link to the carrier's own tracking page
//   patterns   — optional list of RegExp; tested by detectCarrier()
//   badgeColor — Tailwind bg color class for the inline CarrierBadge
//
// Detection: detectCarrier(trackingNumber) iterates this object in the
// declaration order below. Most-specific prefixes are listed first so
// e.g. "TBAxxxxxxxxxxxx" matches Amazon Logistics before any digit-only
// fallback could grab it. Ambiguous shapes (bare digits) live at the end.

export type CarrierEntry = {
  name: string;
  url: (trackingNumber: string) => string;
  patterns?: RegExp[];
  badgeColor: string;
  // Domain used by CarrierBadge to render the carrier's favicon. Cheap, no
  // SVG asset to ship, just plug into Google's favicon CDN.
  domain?: string;
};

export const CARRIERS = {
  // --- Highly specific prefixes go first ---

  sf: {
    name: "顺丰速运",
    domain: "sf-express.com",
    url: (n) => `https://www.sf-express.com/cn/sc/dynamic_function/waybill/#search/bill-number/${n}`,
    patterns: [/^SF\d{12,13}$/i],
    badgeColor: "bg-rose-600"
  },
  jd: {
    name: "京东物流",
    domain: "jdl.com",
    url: (n) => `https://www.jdl.com/orderSearch/?orderId=${n}`,
    patterns: [/^JD[A-Z0-9]{10,18}$/i],
    badgeColor: "bg-red-700"
  },
  yto: {
    name: "圆通速递",
    domain: "yto.net.cn",
    url: (n) => `https://www.yto.net.cn/Service/Search?wbno=${n}`,
    patterns: [/^YT\d{13}$/i]
    , badgeColor: "bg-sky-600"
  },
  jt: {
    name: "极兔速递",
    domain: "jtexpress.com.cn",
    url: (n) => `https://www.jtexpress.com.cn/index/waybill/trace?waybillno=${n}`,
    patterns: [/^JT\d{10,13}$/i],
    badgeColor: "bg-red-500"
  },
  spx: {
    name: "Speedx 跨境物流",
    domain: "speedx.com",
    // Speedx doesn't expose a stable public tracker; fall back to 17track
    // which handles any SPX-prefixed code.
    url: (n) => `https://t.17track.net/en#nums=${n}`,
    // SPXTH, SPXMY, SPXID, SPXSTL, SPXSG, SPXBR etc. — variable region suffix.
    patterns: [/^SPX[A-Z]{0,3}\d{12,18}$/i],
    badgeColor: "bg-orange-500"
  },
  ups: {
    name: "UPS",
    domain: "ups.com",
    url: (n) => `https://www.ups.com/track?tracknum=${n}`,
    patterns: [/^1Z[A-Z0-9]{16}$/i],
    badgeColor: "bg-amber-700"
  },
  amazon: {
    name: "Amazon Logistics",
    domain: "amazon.com",
    url: (n) => `https://track.amazon.com/tracking/${n}`,
    patterns: [/^TBA\d{12,15}$/i],
    badgeColor: "bg-orange-500"
  },
  lasership: {
    name: "LaserShip / OnTrac",
    domain: "lasership.com",
    url: (n) => `https://www.lasership.com/track/${n}`,
    patterns: [/^1LS[A-Z0-9]{10,15}$/i],
    badgeColor: "bg-blue-700"
  },
  dhlecom: {
    name: "DHL eCommerce",
    domain: "dhl.com",
    url: (n) => `https://webtrack.dhlglobalmail.com/?trackingnumber=${n}`,
    patterns: [/^GM\d{14,18}$/i],
    badgeColor: "bg-yellow-600"
  },
  dhl: {
    name: "DHL",
    domain: "dhl.com",
    url: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`,
    patterns: [/^JJD\d{15,20}$/i, /^\d{10}$/],
    badgeColor: "bg-yellow-500"
  },

  // --- Country-code suffix formats (XX + 9 digits + 2-letter country code) ---

  royalmail: {
    name: "Royal Mail",
    domain: "royalmail.com",
    url: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`,
    patterns: [/^[A-Z]{2}\d{9}GB$/i],
    badgeColor: "bg-red-600"
  },
  auspost: {
    name: "Australia Post",
    domain: "auspost.com.au",
    url: (n) => `https://auspost.com.au/mypost/track/#/details/${n}`,
    patterns: [/^[A-Z]{2}\d{9}AU$/i],
    badgeColor: "bg-red-500"
  },
  // TNT's GD...WW is more specific than EMS's generic XX...XX, so it must
  // be checked first or EMS will swallow it.
  tnt: {
    name: "TNT",
    domain: "tnt.com",
    url: (n) => `https://www.tnt.com/express/en_us/site/shipping-tools/tracking.html?searchType=con&cons=${n}`,
    patterns: [/^GD\d{9}WW$/i, /^\d{9}$/],
    badgeColor: "bg-orange-600"
  },
  ems: {
    name: "EMS",
    domain: "ems.com.cn",
    url: (n) => `https://www.ems.com.cn/queryList?mailNum=${n}`,
    // Generic intl. registered-mail format: XX-9digits-XX. Listed AFTER TNT,
    // Royal Mail, Australia Post so those more-specific suffixes win first;
    // anything else (CN/TH/JP/KR/...) lands here.
    patterns: [/^[A-Z]{2}\d{9}[A-Z]{2}$/i],
    badgeColor: "bg-emerald-600"
  },

  // --- Region-specific prefixes/lengths ---

  ontrac: {
    name: "OnTrac",
    domain: "ontrac.com",
    url: (n) => `https://www.ontrac.com/tracking/?number=${n}`,
    // Real OnTrac codes carry a C/D prefix. Bare 15-digit numbers are
    // typically FedEx and shouldn't trigger this branch.
    patterns: [/^[CD]\d{14}$/i],
    badgeColor: "bg-indigo-700"
  },
  dpd: {
    name: "DPD",
    domain: "dpd.com",
    url: (n) => `https://www.dpd.com/tracking/${n}`,
    patterns: [/^\d{14}$/],
    badgeColor: "bg-red-700"
  },
  hermes: {
    name: "Evri (Hermes)",
    domain: "evri.com",
    url: (n) => `https://www.evri.com/track/parcel/${n}/details`,
    patterns: [/^H\d{15,18}$/i, /^[A-Z]\d{18}$/i],
    badgeColor: "bg-fuchsia-700"
  },
  // USPS Tracking numbers begin with service prefixes 92/93/94 (most modern)
  // at 20 or 22 digits. Tightened to those prefixes so FedEx's 96-prefix
  // 22-digit form doesn't collide.
  usps: {
    name: "USPS",
    domain: "usps.com",
    url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
    patterns: [/^9[234]\d{18}$/, /^9[234]\d{20}$/, /^\d{20}$/],
    badgeColor: "bg-blue-600"
  },
  newgistics: {
    name: "Newgistics",
    domain: "pb.com",
    url: (n) => `https://tracking.pb.com/${n}`,
    // 23-26 digits to avoid clashing with USPS's 20/22-digit numbers above
    // and FedEx's 22-digit "96 + 20" form below.
    patterns: [/^\d{23,26}$/],
    badgeColor: "bg-slate-600"
  },
  gls: {
    name: "GLS US",
    domain: "gls-us.com",
    url: (n) => `https://gls-us.com/track/?id=${n}`,
    patterns: [/^[A-Z]?\d{8,10}$/i],
    badgeColor: "bg-amber-600"
  },
  // --- Chinese domestic, mostly bare digits — bottom of list to avoid stealing
  // matches from more specific patterns above. ---

  zto: {
    name: "中通快递",
    domain: "zto.com",
    url: (n) => `https://www.zto.com/express/expressCheck.html?txtbill=${n}`,
    patterns: [/^7[358]\d{10,12}$/, /^ZTO\d{10,12}$/i],
    badgeColor: "bg-blue-800"
  },
  sto: {
    name: "申通快递",
    domain: "sto.cn",
    url: (n) => `https://www.sto.cn/web/index.aspx?nu=${n}`,
    patterns: [/^77\d{11,13}$/, /^STO\d{10,12}$/i],
    badgeColor: "bg-emerald-700"
  },
  yunda: {
    name: "韵达速递",
    domain: "yundaex.com",
    url: (n) => `https://www.yundaex.com/cn/queryYD.php?wen=${n}`,
    patterns: [/^[13][13689]\d{11}$/],
    badgeColor: "bg-blue-500"
  },
  best: {
    name: "百世快递",
    domain: "bestlogistics.com",
    url: (n) => `https://www.bestlogistics.com/site/track.htm?codes=${n}`,
    patterns: [/^B\d{11,13}$/i, /^A\d{11,13}$/i],
    badgeColor: "bg-yellow-700"
  },
  deppon: {
    name: "德邦快递",
    domain: "deppon.com",
    url: (n) => `https://www.deppon.com/yundan/${n}`,
    patterns: [/^DPK\d{10,12}$/i],
    badgeColor: "bg-violet-700"
  },
  yamato: {
    name: "Yamato 黑猫宅急便",
    domain: "kuronekoyamato.co.jp",
    url: (n) => `http://toi.kuronekoyamato.co.jp/cgi-bin/tneko?init=yes&number00=1&number01=${n}`,
    // Hyphenated form only — bare 12 digits is overwhelmingly FedEx.
    patterns: [/^\d{4}-\d{4}-\d{4}$/],
    badgeColor: "bg-neutral-900"
  },

  // --- FedEx is the most-promiscuous numeric format. ---

  fedex: {
    name: "FedEx",
    domain: "fedex.com",
    url: (n) => `https://www.fedex.com/fedextrack/?tracknumbers=${n}`,
    patterns: [/^\d{12}$/, /^\d{15}$/, /^\d{20}$/, /^96\d{20}$/],
    badgeColor: "bg-purple-700"
  },

  other: {
    name: "其他",
    url: () => "",
    badgeColor: "bg-slate-500"
  }
} as const satisfies Record<string, CarrierEntry>;

export type CarrierCode = keyof typeof CARRIERS;

export const carrierCodes = Object.keys(CARRIERS) as CarrierCode[];

export function isCarrierCode(value: string): value is CarrierCode {
  return value in CARRIERS;
}

export function computeTrackingUrl(carrier: CarrierCode, trackingNumber: string, manualUrl?: string) {
  if (carrier === "other") {
    return manualUrl ?? "";
  }

  return CARRIERS[carrier].url(encodeURIComponent(trackingNumber));
}

export function carrierName(carrier: string | null | undefined) {
  return carrier && isCarrierCode(carrier) ? CARRIERS[carrier].name : (carrier ?? "-");
}

export function carrierBadgeColor(carrier: string | null | undefined) {
  return carrier && isCarrierCode(carrier) ? CARRIERS[carrier].badgeColor : "bg-slate-500";
}

/**
 * Resolve a small logo image for the carrier. Uses Google's public favicon
 * service so we don't have to ship 27 SVGs in the repo. `size` requests a
 * 64px square; CSS can downscale it for the badge.
 *
 * Returns `null` when the carrier code is unknown or has no domain (e.g.
 * the "other" catch-all), so callers can fall back to a text-only badge.
 */
export function carrierLogoUrl(carrier: string | null | undefined): string | null {
  if (!carrier || !isCarrierCode(carrier)) return null;
  const entry = CARRIERS[carrier] as CarrierEntry;
  if (!entry.domain) return null;
  return `https://www.google.com/s2/favicons?domain=${entry.domain}&sz=64`;
}

/**
 * Detect which carrier owns a tracking number by walking the regex registry
 * in declaration order. Returns `undefined` when nothing matches so callers
 * can fall back to "other" instead of guessing.
 *
 * Whitespace and common dash/space separators inside the number are tolerated
 * for the digit-only branches; alpha-prefix branches expect the user-typed
 * form unchanged.
 */
export function detectCarrier(trackingNumber: string): CarrierCode | undefined {
  const raw = trackingNumber.trim();

  if (raw.length === 0) {
    return undefined;
  }

  // Two candidate forms: as-typed, and stripped of all whitespace/dashes.
  // The latter helps "1Z 1234 ..." style copy-pastes and Yamato's "0000-0000-0000".
  const candidates = new Set<string>([raw, raw.replace(/[\s-]/g, "")]);

  for (const code of carrierCodes) {
    if (code === "other") continue;
    const patterns = CARRIERS[code].patterns;
    if (!patterns) continue;

    for (const pattern of patterns) {
      for (const candidate of candidates) {
        if (pattern.test(candidate)) {
          return code;
        }
      }
    }
  }

  return undefined;
}
