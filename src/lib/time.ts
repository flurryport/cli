/**
 * Server DateTimes that round-trip through the DB serialize WITHOUT a timezone
 * designator ("2026-07-08T20:05:50.297"), and JavaScript parses zone-less ISO strings
 * as LOCAL time - which inflated every relative minute we emitted by the host's UTC
 * offset (observed live: a 90-minute expiry relayed as 450 minutes on UTC-6).
 * All FlurryPORT server timestamps are UTC: normalize before any Date math or display.
 */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

export function toUtcIso(iso: string): string {
  return HAS_ZONE.test(iso) ? iso : `${iso}Z`;
}

export function utcMs(iso: string): number {
  return new Date(toUtcIso(iso)).getTime();
}
