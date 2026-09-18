export interface WorldLocation {
  region: string;
  country: string;
  area: string;
  detail: string;
}

export function formatWorldLocation(loc: WorldLocation | null | undefined): string {
  if (!loc) return "";
  return [loc.region, loc.country, loc.area, loc.detail].filter(Boolean).join(" > ");
}

export function formatWorldLocationDash(loc: WorldLocation | null | undefined): string {
  if (!loc) return "";
  return [loc.region, loc.country, loc.area, loc.detail].filter(Boolean).join("-");
}

export function parseWorldLocationFromDash(raw: string): WorldLocation | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const parts = s.split("-");
  if (parts.length < 4) {
    const padded = [...parts];
    while (padded.length < 4) padded.push("");
    return {
      region: padded[0] ?? "",
      country: padded[1] ?? "",
      area: padded[2] ?? "",
      detail: padded[3] ?? "",
    };
  }
  return {
    region: parts[0] ?? "",
    country: parts[1] ?? "",
    area: parts[2] ?? "",
    detail: parts[3] ?? "",
  };
}

export function isWorldLocationEqual(
  a: WorldLocation | null | undefined,
  b: WorldLocation | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.region === b.region &&
    a.country === b.country &&
    a.area === b.area &&
    a.detail === b.detail
  );
}

export function isEmptyWorldLocation(loc: WorldLocation | null | undefined): boolean {
  if (!loc) return true;
  return !loc.region && !loc.country && !loc.area && !loc.detail;
}
