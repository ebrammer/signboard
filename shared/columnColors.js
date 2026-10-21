(function initializeColumnColors(root, factory) {
  const helpers = factory();
  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }
  if (root) root.SignboardColumnColors = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createColumnColors() {
  const DEFAULT_COLOR = '#64748b';
  const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  function normalizeIdentityKey(value) {
    if (typeof value !== 'string') return '';
    const name = value.trim().toLowerCase();
    if (!name || UNSAFE_KEYS.has(name) || /[\\/\u0000-\u001f\u007f]/.test(name)) return '';
    return name;
  }

  function normalizeColumnIdentity(value) {
    if (typeof value !== 'string') return '';
    return normalizeIdentityKey(value.trim().replace(/^\d+-/, ''));
  }

  function normalizeHexColor(value) {
    if (typeof value !== 'string') return '';
    const hex = value.trim().toLowerCase().replace(/^#/, '');
    if (/^[a-f0-9]{3}$/.test(hex)) return `#${Array.from(hex, (digit) => digit + digit).join('')}`;
    return /^[a-f0-9]{6}$/.test(hex) ? `#${hex}` : '';
  }

  function normalizeColumnColors(value) {
    const normalized = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
    // Accept dictionaries only; do not turn inherited properties into saved settings.
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return normalized;
    for (const key of Object.keys(value)) {
      // Stored keys are canonical; a leading number can be part of the list title.
      const identity = normalizeIdentityKey(key);
      const color = normalizeHexColor(value[key]);
      if (identity && color) normalized[identity] = color;
    }
    return normalized;
  }

  function getColumnColor(listName, overrides, completed = false) {
    const identity = normalizeColumnIdentity(listName);
    const colors = normalizeColumnColors(overrides);
    if (Object.prototype.hasOwnProperty.call(colors, identity)) return colors[identity];
    if (completed === true) return '#15803d';
    const displayName = /^\d+-/.test(String(listName).trim())
      ? identity.replace(/(?:-stock|-[^-]{5})$/i, '')
      : identity;
    const words = displayName.replace(/[^a-z0-9]+/g, ' ').trim();
    if (/\bblocked\b/.test(words)) return '#b91c1c';
    if (/\b(?:waiting|review)\b|\bon hold\b/.test(words)) return '#b45309';
    if (/\b(?:doing|active)\b|\bin progress\b/.test(words)) return '#2563eb';
    return DEFAULT_COLOR;
  }

  function channels(hex) {
    return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  }

  function toHex(rgb) {
    return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
  }

  function mix(left, right, amount) {
    return left.map((value, index) => value * (1 - amount) + right[index] * amount);
  }

  function luminance(rgb) {
    const linear = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function getColumnPalette(hex, dark = false) {
    const base = channels(normalizeHexColor(hex) || DEFAULT_COLOR);
    let header = toHex(base);
    if (1.05 / (luminance(base) + 0.05) < 4.5) {
      // Find the lightest scaled shade that keeps white header labels readable.
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const amount = (low + high) / 2;
        const candidate = channels(toHex(mix(base, [0, 0, 0], amount)));
        if (1.05 / (luminance(candidate) + 0.05) >= 4.5) high = amount;
        else low = amount;
      }
      header = toHex(mix(base, [0, 0, 0], high));
    }
    return {
      header,
      headerText: '#ffffff',
      body: toHex(mix(dark ? [30, 30, 30] : [247, 247, 247], base, dark ? 0.12 : 0.09)),
      border: toHex(mix(dark ? [64, 64, 64] : [212, 212, 212], base, 0.22)),
    };
  }

  return { normalizeColumnIdentity, normalizeColumnColors, getColumnColor, getColumnPalette };
});
