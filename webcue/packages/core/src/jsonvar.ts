// juce::var coercion, reproduced.
//
// Cue::fromVar is deliberately TOLERANT: a missing key coerces to 0, false or
// "" rather than failing, and an unrecognised enum string falls back to a
// default instead of being rejected. A strict schema parse would be wrong here
// — it would refuse files the desktop app opens without complaint, which is the
// opposite of what a compatibility layer is for.
//
// So these mirror juce::var's conversions rather than validating.

export function asDouble(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'boolean') return v ? 1 : 0;

  if (typeof v === 'string') {
    // juce::var::operator double() on a string parses a leading number and
    // yields 0 when there isn't one.
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
  }

  return fallback;
}

export function asInt(v: unknown, fallback = 0): number {
  if (v === undefined || v === null) return fallback;
  return Math.trunc(asDouble(v, fallback));
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== '0';
  if (v === undefined || v === null) return fallback;
  return fallback;
}

export function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined || v === null) return fallback;
  return fallback;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function clamp(lower: number, upper: number, value: number): number {
  return value < lower ? lower : value > upper ? upper : value;
}
