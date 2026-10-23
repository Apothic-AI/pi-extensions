import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { DEFAULT_STAMP_SETTINGS, formatStampLabel } from "../src/format.js";

const timestamp = Date.UTC(2026, 6, 30, 0, 1, 2);
const Original = Intl.DateTimeFormat;

function spyOnFormatter() {
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function Formatter(locales, options) {
    return new Original(locales, options);
  } as typeof Intl.DateTimeFormat);
}

test("formatter construction stays bounded across stamp, date-key and localized renders", () => {
  const construct = spyOnFormatter();
  const settings = { ...DEFAULT_STAMP_SETTINGS, locale: "en-US", timeZone: "UTC" };
  for (let index = 0; index < 100; index++) {
    assert.ok(formatStampLabel(timestamp + index * 1000, timestamp - 86_400_000, settings));
    assert.ok(formatStampLabel(timestamp, timestamp - 86_400_000, { ...settings, locale: "invariant" }));
  }
  assert.ok(construct.mock.calls.length <= 3, String(construct.mock.calls.length));
});

test("formatter LRU evicts old combinations and retains the current one", () => {
  const construct = spyOnFormatter();
  const first = {
    ...DEFAULT_STAMP_SETTINGS,
    locale: "en-US",
    timeZone: "Pacific/Honolulu",
    dateContext: "never",
  } as const;
  const label = formatStampLabel(timestamp, undefined, first);
  const warmed = construct.mock.calls.length;
  assert.equal(formatStampLabel(timestamp, undefined, first), label);
  assert.equal(construct.mock.calls.length, warmed);
  for (const locale of ["fr-FR", "de-DE", "ja-JP", "zh-TW"]) {
    for (const timeZone of [
      "UTC",
      "Asia/Taipei",
      "Asia/Tokyo",
      "Europe/Paris",
      "America/New_York",
      "Pacific/Honolulu",
      "Australia/Sydney",
      "Europe/London",
      "Asia/Kolkata",
    ]) {
      assert.ok(formatStampLabel(timestamp, undefined, { ...first, locale, timeZone }));
    }
  }
  const filled = construct.mock.calls.length;
  assert.equal(formatStampLabel(timestamp, undefined, first), label);
  assert.equal(construct.mock.calls.length, filled + 1);
  assert.equal(formatStampLabel(timestamp, undefined, first), label);
  assert.equal(construct.mock.calls.length, filled + 1);
});

test("explicit environment changes invalidate locale and time-zone cache keys immediately", () => {
  const settings = { ...DEFAULT_STAMP_SETTINGS, locale: "system", dateContext: "always" } as const;
  const render = (systemLocale: string, localTimeZone: string) =>
    formatStampLabel(timestamp, undefined, settings, { systemLocale, localTimeZone });
  assert.match(render("en-US", "UTC") ?? "", /00:01:02/u);
  assert.match(render("en-US", "Pacific/Honolulu") ?? "", /14:01:02/u);
  assert.notEqual(render("en-US", "UTC"), render("fr-FR", "UTC"));
  assert.match(render("en-US", "UTC") ?? "", /00:01:02/u);
});

test("local formatting follows TZ environment changes during process lifetime", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    assert.equal(formatStampLabel(timestamp, undefined, DEFAULT_STAMP_SETTINGS), "00:01:02");
    process.env.TZ = "Pacific/Honolulu";
    assert.equal(formatStampLabel(timestamp, undefined, DEFAULT_STAMP_SETTINGS), "14:01:02");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("system defaults refresh after locale environment changes and bounded OS-default probes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  let locale = "en-US";
  let timeZone = "UTC";
  const construct = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function Formatter(locales, options) {
    const formatter = new Original(locales, options);
    if (locales === undefined && options === undefined) {
      const resolved = formatter.resolvedOptions();
      vi.spyOn(formatter, "resolvedOptions").mockReturnValue({ ...resolved, locale, timeZone });
    }
    return formatter;
  } as typeof Intl.DateTimeFormat);
  const previous = process.env.LC_TIME;
  try {
    process.env.LC_TIME = "cache-test-1";
    const settings = { ...DEFAULT_STAMP_SETTINGS, locale: "system", dateContext: "always" } as const;
    const initial = formatStampLabel(timestamp, undefined, settings);
    assert.ok(initial);
    const warmed = construct.mock.calls.length;
    for (let i = 0; i < 100; i++) assert.equal(formatStampLabel(timestamp, undefined, settings), initial);
    assert.equal(construct.mock.calls.length, warmed);
    locale = "fr-FR";
    process.env.LC_TIME = "cache-test-2";
    const french = formatStampLabel(timestamp, undefined, settings);
    assert.notEqual(french, initial);
    timeZone = "Pacific/Honolulu";
    assert.equal(formatStampLabel(timestamp, undefined, settings), french);
    vi.advanceTimersByTime(60_000);
    assert.match(formatStampLabel(timestamp, undefined, settings) ?? "", /14:01:02/u);
  } finally {
    if (previous === undefined) delete process.env.LC_TIME;
    else process.env.LC_TIME = previous;
  }
});
