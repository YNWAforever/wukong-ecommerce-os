const HKD_WHOLE_FORMATTER = new Intl.NumberFormat("zh-HK", {
  style: "currency",
  currency: "HKD",
  currencyDisplay: "symbol",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const HKD_FRACTIONAL_FORMATTER = new Intl.NumberFormat("zh-HK", {
  style: "currency",
  currency: "HKD",
  currencyDisplay: "symbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const HK_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("zh-HK", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatHkd(amountHkd: number): string {
  const isWholeNumber = Number.isInteger(amountHkd);
  const formatter = isWholeNumber
    ? HKD_WHOLE_FORMATTER
    : HKD_FRACTIONAL_FORMATTER;
  return formatter.format(amountHkd);
}

export function formatHkTimestamp(date: Date): string {
  return HK_TIMESTAMP_FORMATTER.format(date);
}
