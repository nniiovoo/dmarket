export const CARRIERS = {
  sf: {
    name: "顺丰速运",
    url: (trackingNumber: string) =>
      `https://www.sf-express.com/cn/sc/dynamic_function/waybill/#search/bill-number/${trackingNumber}`
  },
  zto: { name: "中通快递", url: (trackingNumber: string) => `https://www.zto.com/express/expressCheck.html?txtbill=${trackingNumber}` },
  yto: { name: "圆通速递", url: (trackingNumber: string) => `https://www.yto.net.cn/Service/Search?wbno=${trackingNumber}` },
  sto: { name: "申通快递", url: (trackingNumber: string) => `https://www.sto.cn/web/index.aspx?nu=${trackingNumber}` },
  yunda: { name: "韵达速递", url: (trackingNumber: string) => `https://www.yundaex.com/cn/queryYD.php?wen=${trackingNumber}` },
  ems: { name: "EMS", url: (trackingNumber: string) => `https://www.ems.com.cn/queryList?mailNum=${trackingNumber}` },
  usps: { name: "USPS", url: (trackingNumber: string) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}` },
  ups: { name: "UPS", url: (trackingNumber: string) => `https://www.ups.com/track?tracknum=${trackingNumber}` },
  fedex: { name: "FedEx", url: (trackingNumber: string) => `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}` },
  dhl: { name: "DHL", url: (trackingNumber: string) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${trackingNumber}` },
  other: { name: "其他", url: () => "" }
} as const;

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
  return carrier && isCarrierCode(carrier) ? CARRIERS[carrier].name : carrier ?? "-";
}
