// GNOME accelerator strings ("<Control><Shift>F9", "<Super>m"): parsing, comparing, labels,
// and turning a browser KeyboardEvent into one. Used by the service and by page.ts in the
// browser, so it imports nothing and touches neither DOM nor Node APIs.
//
// How a key press becomes a keysym name (the key part of the accelerator):
// 1. Modifier keys alone (Control, Shift, Alt, Meta/Super, AltGraph, CapsLock, …) don't finish
//    the capture; Escape without modifiers cancels it.
// 2. Keys that aren't characters (F1–F35, arrows, Home, Page_Up, Return, space, media keys,
//    …) map by `KeyboardEvent.key` through NAMED_KEYS. The numeric keypad maps by
//    `KeyboardEvent.code` (Numpad1 → KP_1, or KP_End with NumLock off), as GNOME tells them apart.
// 3. A character key uses the character the current layout gives without Shift, because GNOME
//    matches the keysym in the active layout and its settings store `<Shift>1`, not
//    `<Shift>exclam`. Without Shift that is `key` itself. With Shift, `key` is the shifted
//    character, so the unshifted one comes from `navigator.keyboard.getLayoutMap()` when the
//    browser has it (Chromium); otherwise letters are lowercased and everything else falls back
//    to the US meaning of `code` (Digit1 → 1, Minus → minus).
// 4. The character becomes a keysym name: a–z and 0–9 stand for themselves, punctuation and
//    common Latin letters use their X keysym names (comma, ccedilla, idotless, …), anything
//    else is written as U+XXXX (`U00E9`), which xkbcommon accepts.
//
// Limits: AltGr (third-level) characters can't be bound by character. Dead keys and keys the
// browser reports as "Unidentified" fall back to `code` (US meaning). Combinations GNOME or
// the browser already grab (Super+A, Ctrl+W, an existing shortcut such as Ctrl+F9) may never
// reach the page; type those into the text field instead. With Turkish Q, Shift+ı reports "I",
// which lowercases to "i", not "ı", unless the browser has getLayoutMap().

export type Mod = "Control" | "Shift" | "Alt" | "Super" | "Meta" | "Hyper";

/** Writing order for accelerators this tool creates. */
export const MOD_ORDER: readonly Mod[] = ["Control", "Shift", "Alt", "Super", "Meta", "Hyper"];

const MOD_ALIASES: Record<string, Mod> = {
  control: "Control",
  ctrl: "Control",
  ctl: "Control",
  primary: "Control", // GTK's "primary" is Control on Linux
  shift: "Shift",
  shft: "Shift",
  alt: "Alt",
  mod1: "Alt",
  super: "Super",
  mod4: "Super",
  meta: "Meta",
  hyper: "Hyper",
};

const MOD_LABEL: Record<Mod, string> = { Control: "Ctrl", Shift: "Shift", Alt: "Alt", Super: "Super", Meta: "Meta", Hyper: "Hyper" };

export interface Accel {
  mods: Mod[]; // in MOD_ORDER, no duplicates
  key: string; // keysym name as written ("F9", "m", "Page_Up")
}

/** Parses "<Control><Shift>F9". Returns null for "", "disabled" and anything malformed. */
export function parseAccel(s: string): Accel | null {
  const t = s.trim();
  const m = /^((?:<[A-Za-z0-9_]+>)*)([A-Za-z0-9_]+)$/.exec(t);
  if (!m || t === "disabled") return null;
  const mods = new Set<Mod>();
  for (const [, name] of m[1]!.matchAll(/<([A-Za-z0-9_]+)>/g)) {
    const mod = MOD_ALIASES[name!.toLowerCase()];
    if (!mod) return null;
    mods.add(mod);
  }
  return { mods: MOD_ORDER.filter((x) => mods.has(x)), key: m[2]! };
}

export function formatAccel(a: Accel): string {
  return MOD_ORDER.filter((m) => a.mods.includes(m)).map((m) => `<${m}>`).join("") + a.key;
}

/**
 * Comparison key: modifiers in a fixed order with aliases folded (<Primary> = <Control> = <Ctrl>,
 * <Mod4> = <Super>), key name case-folded (GTK and mutter lowercase the keyval when parsing).
 * null when the string isn't a binding.
 */
export function normalizeAccel(s: string): string | null {
  const a = parseAccel(s);
  return a ? formatAccel({ mods: a.mods, key: a.key.toLowerCase() }) : null;
}

/** Why a binding can't be used, or null when it can. */
export function bindingProblem(s: string): string | null {
  if (s.trim() === "") return "Press a key combination or type one, e.g. <Control><Shift>F9.";
  const a = parseAccel(s);
  if (!a) {
    const bad = /<([^<>]*)>/g;
    for (const [, name] of s.matchAll(bad)) {
      if (!MOD_ALIASES[name!.toLowerCase()]) return `Unknown modifier <${name}>. Use <Control>, <Shift>, <Alt> or <Super>.`;
    }
    return `"${s}" isn't a GNOME accelerator. Write it like <Control><Shift>F9 or <Super>m.`;
  }
  return null;
}

/** A binding that would swallow normal typing: no modifier (or Shift only) on a character key. */
export function bindingWarning(s: string): string | null {
  const a = parseAccel(s);
  if (!a) return null;
  const typing = a.key.length === 1 || Object.values(CHAR_KEYSYMS).includes(a.key) || /^U[0-9A-Fa-f]{4,6}$/.test(a.key) || a.key === "space";
  if (typing && a.mods.every((m) => m === "Shift")) return `${accelLabel(s)} alone would stop you typing that character anywhere.`;
  return null;
}

// ---- labels ----

const KEY_LABEL: Record<string, string> = {
  Return: "Enter",
  BackSpace: "Backspace",
  Page_Up: "Page Up",
  Page_Down: "Page Down",
  space: "Space",
  Print: "Print Screen",
  Scroll_Lock: "Scroll Lock",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** "Ctrl+Shift+F9" for "<Control><Shift>F9"; the input itself when it doesn't parse. */
export function accelLabel(s: string): string {
  const a = parseAccel(s);
  if (!a) return s;
  return [...a.mods.map((m) => MOD_LABEL[m]), keyLabel(a.key)].join("+");
}

function keyLabel(k: string): string {
  if (KEY_LABEL[k]) return KEY_LABEL[k]!;
  const ch = CHAR_FROM_KEYSYM[k];
  if (ch) return ch.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  const u = /^U([0-9A-Fa-f]{4,6})$/.exec(k);
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16)).toUpperCase();
  if (k.startsWith("KP_")) return `Keypad ${keyLabel(k.slice(3))}`;
  if (k.startsWith("XF86")) return k.slice(4).replace(/([a-z])([A-Z])/g, "$1 $2");
  return k.replace(/_/g, " ");
}

// ---- KeyboardEvent → accelerator ----

/** The KeyboardEvent fields this needs (so tests don't need a DOM). */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?(k: string): boolean;
}

export type Capture =
  | { kind: "accel"; accel: string; label: string }
  | { kind: "pending"; label: string } // only modifiers so far
  | { kind: "cancel" }
  | { kind: "error"; message: string };

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "Super", "Hyper", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Symbol", "SymbolLock"]);

/** Non-character keys by `KeyboardEvent.key`. */
export const NAMED_KEYS: Record<string, string> = {
  Enter: "Return",
  Tab: "Tab",
  " ": "space",
  Backspace: "BackSpace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  PrintScreen: "Print",
  Pause: "Pause",
  ContextMenu: "Menu",
  Help: "Help",
  AudioVolumeMute: "XF86AudioMute",
  AudioVolumeUp: "XF86AudioRaiseVolume",
  AudioVolumeDown: "XF86AudioLowerVolume",
  MicrophoneToggle: "XF86AudioMicMute",
  MediaPlayPause: "XF86AudioPlay",
  MediaPlay: "XF86AudioPlay",
  MediaPause: "XF86AudioPause",
  MediaStop: "XF86AudioStop",
  MediaTrackNext: "XF86AudioNext",
  MediaTrackPrevious: "XF86AudioPrev",
  BrightnessUp: "XF86MonBrightnessUp",
  BrightnessDown: "XF86MonBrightnessDown",
  LaunchMail: "XF86Mail",
  LaunchApplication1: "XF86MyComputer",
  LaunchApplication2: "XF86Calculator",
  BrowserHome: "XF86HomePage",
  BrowserSearch: "XF86Search",
  BrowserBack: "XF86Back",
  BrowserForward: "XF86Forward",
  BrowserRefresh: "XF86Reload",
  Eject: "XF86Eject",
  Sleep: "XF86Sleep",
  PowerOff: "XF86PowerOff",
};

/** Keypad keys by `KeyboardEvent.code`; with NumLock off they report navigation keys. */
const NUMPAD: Record<string, string> = {
  NumpadAdd: "KP_Add",
  NumpadSubtract: "KP_Subtract",
  NumpadMultiply: "KP_Multiply",
  NumpadDivide: "KP_Divide",
  NumpadEnter: "KP_Enter",
  NumpadEqual: "KP_Equal",
  NumpadComma: "KP_Separator",
};
const NUMPAD_NAV: Record<string, string> = {
  Home: "KP_Home",
  End: "KP_End",
  PageUp: "KP_Page_Up",
  PageDown: "KP_Page_Down",
  ArrowUp: "KP_Up",
  ArrowDown: "KP_Down",
  ArrowLeft: "KP_Left",
  ArrowRight: "KP_Right",
  Insert: "KP_Insert",
  Delete: "KP_Delete",
  Clear: "KP_Begin",
};

/** X keysym names of characters that aren't a–z / 0–9. */
export const CHAR_KEYSYMS: Record<string, string> = {
  "`": "grave",
  "~": "asciitilde",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  "-": "minus",
  _: "underscore",
  "=": "equal",
  "+": "plus",
  "[": "bracketleft",
  "]": "bracketright",
  "{": "braceleft",
  "}": "braceright",
  "\\": "backslash",
  "|": "bar",
  ";": "semicolon",
  ":": "colon",
  "'": "apostrophe",
  '"': "quotedbl",
  ",": "comma",
  ".": "period",
  "<": "less",
  ">": "greater",
  "/": "slash",
  "?": "question",
  "§": "section",
  "°": "degree",
  "£": "sterling",
  "€": "EuroSign",
  "µ": "mu",
  "²": "twosuperior",
  "½": "onehalf",
  "¨": "diaeresis",
  "´": "acute",
  ß: "ssharp",
  à: "agrave",
  á: "aacute",
  â: "acircumflex",
  ä: "adiaeresis",
  å: "aring",
  æ: "ae",
  ç: "ccedilla",
  è: "egrave",
  é: "eacute",
  ê: "ecircumflex",
  ë: "ediaeresis",
  ì: "igrave",
  í: "iacute",
  î: "icircumflex",
  ï: "idiaeresis",
  ñ: "ntilde",
  ò: "ograve",
  ó: "oacute",
  ô: "ocircumflex",
  ö: "odiaeresis",
  ø: "oslash",
  ù: "ugrave",
  ú: "uacute",
  û: "ucircumflex",
  ü: "udiaeresis",
  ğ: "gbreve",
  ı: "idotless",
  ş: "scedilla",
};
const CHAR_FROM_KEYSYM: Record<string, string> = Object.fromEntries(Object.entries(CHAR_KEYSYMS).map(([c, k]) => [k, c]));

/** The unshifted US-layout character of a `code`, for keys a layout map can't tell us about. */
export function usCharFromCode(code: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1]!.toLowerCase();
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1]!;
  const US: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    IntlBackslash: "<",
  };
  return US[code] ?? null;
}

/** Lowercase of one letter; "İ" (Turkish dotted capital) is "i". */
function lowerLetter(ch: string): string {
  if (ch === "İ") return "i";
  const l = ch.toLowerCase();
  return [...l].length === 1 ? l : ch;
}

/** Keysym name for one character, or null when it isn't one character. */
export function keysymForChar(ch: string): string | null {
  if ([...ch].length !== 1) return null;
  if (/^[a-z0-9]$/.test(ch)) return ch;
  if (CHAR_KEYSYMS[ch]) return CHAR_KEYSYMS[ch]!;
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || cp === 0x7f) return null;
  return `U${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function keyName(ev: KeyLike, layoutChar: string | undefined): string | { error: string } {
  if (ev.code.startsWith("Numpad")) {
    if (NUMPAD[ev.code]) return NUMPAD[ev.code]!;
    const d = /^Numpad([0-9])$/.exec(ev.code);
    if (d && /^[0-9]$/.test(ev.key)) return `KP_${d[1]}`;
    if (ev.code === "NumpadDecimal" && (ev.key === "." || ev.key === ",")) return "KP_Decimal";
    if (NUMPAD_NAV[ev.key]) return NUMPAD_NAV[ev.key]!;
  }
  if (/^F([1-9]|[12][0-9]|3[0-5])$/.test(ev.key)) return ev.key;
  if (NAMED_KEYS[ev.key]) return NAMED_KEYS[ev.key]!;
  if (ev.getModifierState?.("AltGraph")) return { error: "AltGr combinations can't be bound by character. Type the accelerator instead." };
  if ([...ev.key].length === 1) {
    let ch = ev.key;
    if (ev.shiftKey) ch = layoutChar ?? (/\p{L}/u.test(ch) ? ch : usCharFromCode(ev.code) ?? ch);
    ch = lowerLetter(ch); // Shift or CapsLock
    const k = keysymForChar(ch);
    if (k) return k;
  }
  // "Dead", "Unidentified", "Process", …: fall back to the key's position
  const ch = layoutChar ?? usCharFromCode(ev.code);
  const k = ch ? keysymForChar(lowerLetter(ch)) : null;
  if (k) return k;
  return { error: `Can't map this key (key "${ev.key}", code "${ev.code}"). Type the accelerator instead.` };
}

function modsOf(ev: KeyLike): Mod[] {
  const m: Mod[] = [];
  if (ev.ctrlKey) m.push("Control");
  if (ev.shiftKey) m.push("Shift");
  if (ev.altKey) m.push("Alt");
  if (ev.metaKey) m.push("Super");
  return m;
}

/**
 * One keydown during capture. `layoutChar` is what `navigator.keyboard.getLayoutMap()` says
 * the event's `code` produces without modifiers, when the browser offers it.
 */
export function captureKey(ev: KeyLike, layoutChar?: string): Capture {
  const mods = modsOf(ev);
  if (MODIFIER_KEYS.has(ev.key)) {
    // the modifier being pressed may not be in the flags yet
    const extra: Mod | undefined = ev.key === "Control" ? "Control" : ev.key === "Shift" ? "Shift" : ev.key === "Alt" ? "Alt" : ev.key === "Meta" || ev.key === "OS" || ev.key === "Super" ? "Super" : undefined;
    const all = MOD_ORDER.filter((m) => mods.includes(m) || m === extra);
    return { kind: "pending", label: all.length ? all.map((m) => MOD_LABEL[m]).join("+") + "+…" : "…" };
  }
  if (ev.key === "Escape" && mods.length === 0) return { kind: "cancel" };
  const k = keyName(ev, layoutChar);
  if (typeof k !== "string") return { kind: "error", message: k.error };
  const accel = formatAccel({ mods, key: k });
  return { kind: "accel", accel, label: accelLabel(accel) };
}
