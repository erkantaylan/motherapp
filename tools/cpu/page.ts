/// <reference lib="dom" />
// The CPU tool's custom page (a light-DOM custom element, docs/extension-contract.md § 6),
// combining two directions of the user's mockup (2026-10-23): the Die map (a drawn package,
// cores as a live clock/heat map, details on hover or tap) and the Tuning console (target vs
// actual per CCX, the two profiles side by side, a clock/temperature timeline built here from
// the state updates while the page is open, and the tool's event log). On top, the profile
// selector Stock | Underclock | Overclock. On AMD it only shows cpu.json's `active` (applying
// needs the SMU, a later step). On Intel (`profiles.kind` "limits") it applies the profile
// (the useProfile action), and the Limits card shows each limit now, at stock and in both
// profiles, with the profiles editable in place (saveProfile).
// The CCX profiles, the per-CCX table and the SMU placeholders are AMD Ryzen (family 0x17) only
// (`cpu.tuning`); other CPUs, Intel hybrids included, get the core grid, cores, timeline,
// sensors and log. The package drawing needs 2 CCD × 2 CCX; any other shape gets the grid.
// Styled with the theme variables (an unlayered <style> scoped by `.mcpu`) and Bootstrap 6's
// switch and badge classes. Shared logic comes from ./src/view.ts, which imports nothing.
import type { JsonValue } from "@motherapp/protocol";
import type { PageContext } from "@motherapp/protocol/page";
import {
  axisRange,
  compareProfiles,
  dieLayout,
  gridGroups,
  formatCpuList,
  formatDelta,
  formatTemp,
  heatFraction,
  nearestSample,
  profileSummary,
  pushSample,
  rankNumbers,
  rankOrder,
  targetFor,
} from "./src/view.ts";
import type { CpuEvent, ProfileKey, ProfileView, Sample } from "./src/view.ts";

// ---- state shapes (see src/model.ts polledState / profilesState) ----

interface Temp {
  label: string;
  value: number;
}
interface CpuS {
  model?: string;
  vendor?: string;
  tuning?: boolean;
  cores?: number;
  threads?: number;
  driver?: string;
  governor?: string;
  epp?: string;
  boost?: boolean;
  maxMHz?: number;
  cappedMHz?: number;
  minMHz?: number;
  pkgTemp?: Temp;
  hidden?: string[];
  /** Package power from RAPL, W. */
  powerW?: number;
  powerNote?: string;
}
interface CcxS {
  index: number;
  name: string;
  ccd?: number;
  cpus: number[];
  cores: number[];
  slots: number;
  avgMHz?: number;
  maxMHz?: number;
  fastCore?: number;
  temp?: Temp;
}
interface CoreS {
  key: number;
  order: number;
  name: string;
  ccx: number;
  threads: { cpu: number; mhz?: number }[];
  mhz?: number;
  rank?: number;
  kind?: "P" | "E";
  temp?: Temp;
}
interface SensorS {
  key: string;
  order: number;
  chip: string;
  label: string;
  name: string;
  description: string;
  kind: "temp" | "fan";
  value: number;
  unit: string;
}
type LimitKey = "maxMHz" | "eMaxMHz" | "turbo" | "governor" | "epp" | "pl1W" | "pl2W";
type LVal = number | boolean | string;
interface ProfileS extends ProfileView {
  order: number;
  detail?: string;
  /** Intel: what the profile sets (absent = stock). */
  values?: Partial<Record<LimitKey, LVal>>;
}
interface LimitRowS {
  order: number;
  label: string;
  now?: LVal;
  stock?: LVal;
  min?: number;
  max?: number;
  writable: boolean;
}
interface LimitsS {
  supported?: boolean;
  hybrid?: boolean;
  access?: "full" | "partial" | "none";
  accessText?: string;
  /** thermald is running and will undo PL1. */
  thermaldText?: string;
  rows?: Partial<Record<LimitKey, LimitRowS>>;
  governors?: string[];
  epps?: string[];
  stockFrom?: "snapshot" | "now";
  stockAt?: number;
  drift?: string[];
}
interface ProfilesS {
  /** "limits" on Intel; absent on AMD. */
  kind?: "limits";
  active?: "underclock" | "overclock";
  applyOnStart?: boolean;
  file?: string;
  list?: { underclock?: ProfileS; overclock?: ProfileS };
  problems?: string;
}

type Sel = { kind: "core"; key: number } | { kind: "ccx"; index: number } | { kind: "iod" };
type Order = "layout" | "rank";

const WINDOW_MS = 180_000;
const SAMPLE_MS = 1000;
const NO_SMU = "—, needs the SMU (later step)";
const AMD_ONLY = "Profiles and per-CCX tuning are for AMD Ryzen (Zen 2) only.";
const PIDS = ["underclock", "overclock"] as const;
type Pid = (typeof PIDS)[number];
const UNIT: Partial<Record<LimitKey, string>> = { maxMHz: "MHz", eMaxMHz: "MHz", pl1W: "W", pl2W: "W" };
const ORDER_KEY = "motherapp.cpu.order";
const OPEN_KEY = "motherapp.cpu.open";

const STYLE = `
.mcpu-cq { container-type: inline-size; }
.mcpu { display: grid; gap: 20px; color: var(--fg); min-width: 0; }
/* Narrow: one column, the Live card where the timeline used to be (after the console). */
.mcpu-main { display: contents; }
.mcpu-main > .mcpu-after { order: 2; }
.mcpu-rail { order: 1; min-width: 0; }
/* Wide (a "wide" page on a big screen): the Live card becomes a sticky column on the right. */
@container (min-width: 1240px) {
  .mcpu { grid-template-columns: minmax(0, 1fr) minmax(360px, 420px); column-gap: 24px; align-items: start; }
  .mcpu-main { display: grid; gap: 20px; align-content: start; min-width: 0; }
  .mcpu-rail { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; }
  .mcpu-rail .mcpu-plot { height: 130px; }
}
.mcpu-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 12px 16px 0; }
.mcpu-tile { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; min-width: 0; }
.mcpu-tile .v { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap; }
.mcpu-tile .v small { font-size: 0.875rem; font-weight: 500; color: var(--muted); margin-inline-start: 2px; }
.mcpu-tile .s { font-size: 0.75rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.2em; }
.mcpu *, .mcpu *::before, .mcpu *::after { box-sizing: border-box; }
.mcpu .num { font-variant-numeric: tabular-nums; }
.mcpu .muted { color: var(--muted); }
.mcpu .small { font-size: 0.8125rem; }
.mcpu h3 { margin: 0; font-size: 1rem; font-weight: 600; }
.mcpu p { margin: 0; }
.mcpu-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; min-width: 0; }
.mcpu-pad { padding: 16px; }
.mcpu-stack { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.mcpu-rowb { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.mcpu-sub { color: var(--muted); font-size: 0.875rem; }
.mcpu-status { color: var(--warn); font-size: 0.875rem; }
.mcpu-status:empty { display: none; }
.mcpu-lbl { font-size: 0.75rem; color: var(--muted); font-weight: 500; letter-spacing: .02em; }
.mcpu-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mcpu-note { font-size: 0.8125rem; color: var(--muted); display: flex; gap: 6px; align-items: flex-start; text-wrap: pretty; }
.mcpu-note svg { flex: none; margin-top: 3px; }
.mcpu-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg); }
.mcpu-seg button { font: inherit; font-size: 0.875rem; min-height: 40px; padding: 6px 14px; border: 0; background: transparent; color: var(--fg); cursor: pointer; }
.mcpu-seg button + button { border-inline-start: 1px solid var(--border); }
.mcpu-seg button:hover:not(:disabled) { background: var(--surface); }
.mcpu-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
.mcpu-seg button:disabled { cursor: not-allowed; }
.mcpu-seg button:disabled:not([aria-pressed="true"]) { color: var(--muted); }
.mcpu button:focus-visible, .mcpu summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mcpu-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; padding: 12px 16px; }
.mcpu-toolbar .mcpu-psum { flex: 1 1 100%; font-size: 0.875rem; }
.mcpu-login { display: inline-flex; align-items: center; gap: 10px; min-height: 40px; font-size: 0.875rem; }
.mcpu-login .switch { margin: 0; }
.mcpu-badge-sm { font-size: 0.75rem; }
.mcpu-live { transition: opacity .2s; }
.mcpu [hidden] { display: none !important; }
.mcpu-amdnote { font-size: 0.875rem; color: var(--muted); }
.mcpu-stale .mcpu-live { opacity: .6; }

/* die map */
.mcpu-d2 { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.mcpu-d2main { flex: 999 1 480px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.mcpu-d2side { flex: 1 1 260px; min-width: 0; position: sticky; top: 16px; }
.mcpu-pkg { margin: 0 auto; width: 100%; max-width: 660px; padding: 16px; border-radius: 14px; display: flex; flex-direction: column; gap: 14px;
  background: color-mix(in oklch, var(--ok) 14%, var(--bg)); border: 1px solid color-mix(in oklch, var(--ok) 40%, var(--bg)); }
.mcpu-pkg-label { font-size: 0.75rem; opacity: .85; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.mcpu-dies { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.mcpu-die { background: color-mix(in oklch, var(--fg) 12%, var(--bg)); border: 1px solid color-mix(in oklch, var(--fg) 28%, var(--bg));
  border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mcpu-die-h { display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 600; gap: 2px 6px; flex-wrap: wrap; }
.mcpu-ccx { display: grid; grid-template-columns: minmax(0, 1fr) 46px minmax(0, 1fr); gap: 4px; }
.mcpu-cell { font: inherit; border: 0; border-radius: 4px; padding: 4px; min-height: 58px; display: flex; flex-direction: column; justify-content: center;
  cursor: pointer; min-width: 0; color: var(--fg); transition: background .5s, color .5s; }
.mcpu-cell-top { display: flex; justify-content: space-between; gap: 2px; font-size: 0.6875rem; line-height: 1.2; opacity: .9; }
.mcpu-cell .rb { font-weight: 700; }
.mcpu-cell .rb[data-on="false"] { visibility: hidden; }
.mcpu-cell .cv { font-size: 0.9375rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; text-align: center; }
.mcpu-slot { border-radius: 4px; border: 1px dashed color-mix(in oklch, var(--fg) 35%, var(--bg)); display: grid; place-content: center; text-align: center;
  font-size: 0.6875rem; line-height: 1.25; color: var(--muted); min-height: 58px; padding: 2px; min-width: 0; }
.mcpu-l3 { font: inherit; border: 1px solid color-mix(in oklch, var(--fg) 28%, var(--bg)); border-radius: 4px; background: color-mix(in oklch, var(--fg) 5%, var(--bg));
  color: var(--fg); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; padding: 4px 2px;
  font-size: 0.6875rem; line-height: 1.2; text-align: center; min-width: 0; grid-column: 2; }
.mcpu-l3 strong { font-size: 0.75rem; }
.mcpu-iod { font: inherit; width: 100%; border: 1px solid color-mix(in oklch, var(--fg) 28%, var(--bg)); border-radius: 6px;
  background: color-mix(in oklch, var(--fg) 12%, var(--bg)); color: var(--fg); padding: 12px; cursor: pointer; display: flex; flex-wrap: wrap;
  justify-content: space-between; align-items: center; gap: 6px 16px; text-align: start; font-size: 0.8125rem; }
.mcpu-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 4px; }
.mcpu [data-sel="true"] { box-shadow: inset 0 0 0 2px var(--fg), inset 0 0 0 4px var(--bg); }
.mcpu-legend { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 0.75rem; color: var(--muted); }
.mcpu-legend .lt { margin: 0 6px; }
.mcpu-legend .sw { width: 24px; height: 12px; border-radius: 3px; display: inline-block; }
.mcpu-kvr { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 0.875rem; }
.mcpu-kvr span:last-child { text-align: end; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.mcpu-detail-body { min-height: 360px; }
.mcpu-sheet-toggle { display: none; }
.mcpu-spacer { display: none; }

/* console */
.mcpu-d3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 16px; align-items: start; }
.mcpu-sec-h { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 16px;
  border-bottom: 1px solid var(--border); min-height: 56px; }
.mcpu-sec-h.mid { border-top: 1px solid var(--border); }
.mcpu-gt { font-size: 0.875rem; }
.mcpu-gt-row { display: grid; grid-template-columns: minmax(72px, 1.3fr) repeat(4, minmax(0, 1fr)); gap: 8px; padding: 8px 16px; align-items: baseline;
  border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.mcpu-gt-head { font-size: 0.75rem; color: var(--muted); border-top: 0; }
.mcpu-gt-row > *:not(:first-child) { text-align: end; }
.mcpu-gt-row > .mcpu-gt-sub { grid-column: 1 / -1; font-size: 0.75rem; color: var(--muted); text-align: start; margin-top: -4px; overflow-wrap: anywhere; }
.mcpu-gt-cores .mcpu-gt-row { grid-template-columns: 28px minmax(0, 1.2fr) minmax(0, 0.8fr) minmax(0, 0.7fr) minmax(0, 0.9fr) minmax(0, 1fr); }
.mcpu-gt-cores .mcpu-gt-row > *:nth-child(2), .mcpu-gt-cores .mcpu-gt-row > *:nth-child(3) { text-align: start; }
.mcpu-dl { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; }
.mcpu-pc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); gap: 12px; padding: 12px 16px; }
.mcpu-pc { border-radius: 8px; display: flex; flex-direction: column; border: 1px solid var(--border); min-width: 0; }
.mcpu-pc[data-unset="true"] { border-style: dashed; }
.mcpu-pc[data-active="true"] { border: 2px solid var(--accent); background: color-mix(in oklch, var(--accent) 8%, var(--bg)); }
.mcpu-pc-h { padding: 10px 12px; display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.mcpu-pc-r { display: flex; justify-content: space-between; gap: 8px; padding: 6px 12px; border-top: 1px solid var(--border); font-size: 0.875rem;
  font-variant-numeric: tabular-nums; }
.mcpu-pc-r[data-hl="true"] { background: color-mix(in oklch, var(--accent) 16%, var(--bg)); }

/* Intel limits */
.mcpu-lt-wrap { overflow-x: auto; }
.mcpu-lt { min-width: 600px; font-size: 0.875rem; }
.mcpu-lt-row { display: grid; grid-template-columns: minmax(150px, 1.4fr) repeat(2, minmax(80px, 0.8fr)) repeat(2, minmax(130px, 1fr)); gap: 8px;
  padding: 8px 16px; align-items: center; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.mcpu-lt-head { font-size: 0.75rem; color: var(--muted); border-top: 0; }
.mcpu-lt-row [data-hl="true"] { color: var(--accent); font-weight: 600; }
.mcpu-lt-row [data-active="true"] { font-weight: 600; }
.mcpu-in { width: 100%; min-height: 36px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg);
  font: inherit; min-width: 0; }
.mcpu-in:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.mcpu-in[data-dirty="true"] { border-color: var(--accent); }
.mcpu-in:disabled { opacity: .6; }
.mcpu-btn { min-height: 36px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--fg);
  cursor: pointer; font: inherit; font-size: 0.875rem; white-space: nowrap; }
.mcpu-btn:hover:not(:disabled) { border-color: var(--accent); }
.mcpu-btn:disabled { opacity: .5; cursor: default; }
.mcpu-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.mcpu-acts { display: flex; gap: 6px; flex-wrap: wrap; }
.mcpu-lt-foot { padding: 10px 16px 14px; display: flex; flex-direction: column; gap: 8px; }
.mcpu-msg { font-size: 0.875rem; }
.mcpu-msg:empty { display: none; }
.mcpu-msg[data-kind="err"] { color: var(--danger, var(--warn)); }
.mcpu-msg[data-kind="warn"] { color: var(--warn); }
.mcpu-drift { padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border); font-size: 0.875rem; color: var(--warn); }
.mcpu-access { padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 0.875rem; color: var(--warn); }
.mcpu-status code, .mcpu-access code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }

/* timeline */
.mcpu-tl { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 10px; cursor: crosshair; touch-action: pan-y; }
.mcpu-plot { position: relative; height: 150px; border-inline-start: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.mcpu-plot.short { height: 100px; }
.mcpu-plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.mcpu-gl { position: absolute; left: 0; right: 0; border-top: 1px dashed color-mix(in oklch, var(--fg) 18%, var(--bg)); }
.mcpu-gl span { position: absolute; left: 4px; top: -9px; font-size: 0.6875rem; color: var(--muted); background: var(--bg); padding: 0 3px; line-height: 16px; }
.mcpu-band { position: absolute; left: 0; right: 0; background: color-mix(in oklch, var(--accent) 12%, var(--bg));
  border-top: 1px dashed var(--accent); border-bottom: 1px dashed var(--accent); }
.mcpu-band span { position: absolute; right: 4px; bottom: 100%; font-size: 0.6875rem; color: var(--accent); white-space: nowrap; }
.mcpu-mk { position: absolute; top: 0; bottom: 0; border-inline-start: 2px solid var(--fg); opacity: .7; }
.mcpu-mk span { position: absolute; top: 2px; white-space: nowrap; font-size: 0.6875rem; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; padding: 0 4px; color: var(--fg); }
.mcpu-xh { position: absolute; top: 0; bottom: 0; border-inline-start: 1px solid var(--muted); pointer-events: none; }
.mcpu-axis { display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--muted); }
.mcpu-read { min-height: 2.6em; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }

/* collapsed sections, log */
.mcpu-det > summary { cursor: pointer; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; font-weight: 600;
  list-style: none; min-height: 44px; }
.mcpu-det > summary::-webkit-details-marker { display: none; }
.mcpu-det > summary::before { content: ''; width: 7px; height: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
  transform: rotate(-45deg); margin-inline-end: 4px; align-self: center; transition: transform .15s; }
.mcpu-det[open] > summary::before { transform: rotate(45deg); }
.mcpu-det > summary .small { font-weight: 400; }
.mcpu-li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border);
  font-size: 0.875rem; min-width: 0; }
.mcpu-li > span { min-width: 0; overflow-wrap: anywhere; }
.mcpu-li .num { text-align: end; flex: none; }
.mcpu-log .mcpu-li { justify-content: flex-start; align-items: baseline; }
.mcpu-log .lt { min-width: 76px; flex: none; }

@media (max-width: 720px) {
  .mcpu-gt-row { padding: 8px 12px; gap: 6px; }
  .mcpu-ccx { grid-template-columns: minmax(0, 1fr) 38px minmax(0, 1fr); }
  .mcpu-l3 { font-size: 0.625rem; padding: 4px 0; }
  .mcpu-l3 strong { font-size: 0.6875rem; }
  .mcpu-cell .cv { font-size: 0.8125rem; }
  .mcpu-pkg { padding: 10px; }
  .mcpu-dies { gap: 8px; }
  .mcpu-die { padding: 6px; }
  .mcpu-d2side { position: fixed; top: auto; left: 0; right: 0; bottom: 0; z-index: 5; max-height: 55vh; overflow: auto; border-radius: 16px 16px 0 0;
    border-bottom: 0; box-shadow: 0 -6px 24px rgba(0, 0, 0, .28); transform: translateY(calc(100% - 64px)); transition: transform .2s ease; }
  .mcpu-d2side[data-open="true"] { transform: none; }
  .mcpu-sheet-toggle { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%; min-height: 64px; padding: 8px 16px; border: 0;
    border-bottom: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; font-size: 0.875rem; cursor: pointer;
    position: sticky; top: 0; z-index: 1; }
  .mcpu-grab { width: 36px; height: 4px; border-radius: 2px; background: var(--border); }
  .mcpu-detail-body { min-height: 0; }
  .mcpu-detail-body h3 { display: none; }
  .mcpu-spacer { display: block; height: 72px; }
}
@media (prefers-reduced-motion: reduce) { .mcpu-cell, .mcpu-d2side, .mcpu-live { transition: none; } }
`;

const INFO_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:1.5px;stroke-linecap:round"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7.2v4M8 4.8v.1"></path></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" role="img" aria-label="on target" style="fill:none;stroke:var(--ok);stroke-width:2px;stroke-linecap:round;stroke-linejoin:round"><path d="M3 8.5l3 3 7-7"></path></svg>';
const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...kids);
  return e;
}

function note(text: string): HTMLParagraphElement {
  const p = el("p", "mcpu-note");
  p.innerHTML = INFO_ICON; // static markup, no user text
  p.append(el("span", "", text));
  return p;
}

/** Like put, with `backticked` parts as <code> ("run `motherapp install`"). */
function setCodeText(node: HTMLElement, text: string): void {
  if (node.dataset.text === text) return;
  node.dataset.text = text;
  node.replaceChildren(...text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? el("code", "", part) : document.createTextNode(part))));
}

/** Sets text only when it changed, so unchanged nodes aren't touched every second. */
function put(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = <T>(v: JsonValue | undefined): T => (isObj(v) ? (v as unknown as T) : ({} as T));
const mhzText = (v: number | undefined) => (v === undefined ? "—" : String(v));
const short = (name: string) => name.replace(/^Core /, "C");
/** coretemp's "Package id 0" reads badly next to a number. */
const tempLabel = (label: string | undefined) => (label === undefined ? "Tctl" : label.replace(/^Package id \d+$/, "Package"));
const pad2 = (n: number) => String(n).padStart(2, "0");

function clock(ts: number): string {
  const d = new Date(ts);
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${t}`;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // private window or blocked storage: the choice just isn't remembered
  }
}

function heatStyle(node: HTMLElement, f: number): void {
  const p = Math.round(f * 100);
  node.style.background = `color-mix(in oklch, var(--accent) ${p}%, var(--surface))`;
  node.style.color = f >= 0.6 ? "var(--accent-fg)" : "var(--fg)";
}

/** What the page derives from one state snapshot. */
interface View {
  cpu: CpuS;
  ccx: CcxS[];
  cores: Map<number, CoreS>;
  sensors: SensorS[];
  profiles: ProfilesS;
  activeKey: ProfileKey;
  active: ProfileView | undefined;
  rankNo: Map<number, number>;
  lo: number;
  hi: number;
  stale: boolean;
  tuning: boolean;
  amd: boolean;
  /** Intel limits: the selector applies, the Limits card shows. */
  intel: boolean;
  limits: LimitsS;
}

interface CellRefs {
  btn: HTMLButtonElement;
  rb: HTMLElement;
  cv: HTMLElement;
}

export default class CpuPage extends HTMLElement {
  ctx?: PageContext;
  private off: (() => void)[] = [];
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private order: Order = loadJson<string>(ORDER_KEY, "layout") === "rank" ? "rank" : "layout";
  private openSecs = loadJson<Record<string, boolean>>(OPEN_KEY, {});
  private sel: Sel = { kind: "ccx", index: 0 };
  private sheetOpen = false;
  private samples: Sample[] = [];
  private hoverTs: number | undefined;
  private view: View | undefined;
  private topoSig = "";
  private profSig = "";
  private eventsSig = "";
  private sensorsSig = "";

  // static structure
  private root = el("div", "mcpu");
  private sub = el("p", "mcpu-sub");
  private status = el("p", "mcpu-status");
  private amdNote = el("p", "mcpu-amdnote", AMD_ONLY);
  private toolbar = el("section", "mcpu-card mcpu-toolbar");
  private mapTitle = el("h3");
  private targetCard = el("section", "mcpu-card");
  private profilesCard = el("section", "mcpu-card");
  private coreGroupHead = el("span");
  private coreLastHead = el("span");
  private profBtns = new Map<ProfileKey, HTMLButtonElement>();
  private login = document.createElement("input");
  private profSummary = el("p", "mcpu-psum");
  private profProblems = el("p", "mcpu-status");
  private toolbarNote = el("div");
  private actMsg = el("p", "mcpu-msg");
  private busy = false;
  private limitsCard = el("section", "mcpu-card");
  private limAccess = el("div", "mcpu-access");
  private limThermald = el("div", "mcpu-access");
  private limDrift = el("div", "mcpu-drift");
  private limDriftText = el("span");
  private limTable = el("div", "mcpu-lt");
  private limNote = el("p", "mcpu-note");
  private limMsg = el("p", "mcpu-msg");
  private limSig = "";
  private limCells = new Map<LimitKey, { now: HTMLElement; stock: HTMLElement; inputs: Map<Pid, HTMLInputElement | HTMLSelectElement> }>();
  private limActs = new Map<Pid, { save: HTMLButtonElement; revert: HTMLButtonElement }>();
  /** Edited, unsaved profile inputs (raw input text per setting), kept across re-renders. */
  private drafts = new Map<Pid, Partial<Record<LimitKey, string>>>();
  private orderSegs: HTMLElement[] = [];
  private pkg = el("div", "mcpu-pkg");
  private legend = el("div", "mcpu-legend");
  private side = el("aside", "mcpu-d2side mcpu-card");
  private sheetToggle = el("button", "mcpu-sheet-toggle");
  private sheetTitle = el("span");
  private sheetHint = el("span", "small muted");
  private detailTitle = el("h3");
  private detailSub = el("div", "small muted");
  private detailRows = el("div");
  private ccxTable = el("div", "mcpu-gt");
  private coreTable = el("div", "mcpu-gt mcpu-gt-cores");
  private pcGrid = el("div", "mcpu-pc-grid");
  private pcNote = el("p", "mcpu-note");
  private tlFill = el("span", "small muted num");
  private tl = el("div", "mcpu-tl");
  private clockPlot = el("div", "mcpu-plot");
  private powerPlot = el("div", "mcpu-plot");
  private powerLabel = el("span", "mcpu-lbl", "Package power, W");
  private powerNote = el("p", "mcpu-status");
  private tileW = el("div", "v");
  private tileT = el("div", "v");
  private tileC = el("div", "v");
  private tileWs = el("div", "s");
  private tileTs = el("div", "s");
  private tileCs = el("div", "s");
  private tempPlot = el("div", "mcpu-plot short");
  private tlRead = el("div", "mcpu-read");
  private tempLabel = el("span", "mcpu-lbl", "Tctl, °C");
  private board = el("details", "mcpu-card mcpu-det");
  private boardSum = el("span", "small muted num");
  private boardBody = el("div");
  private details = el("details", "mcpu-card mcpu-det");
  private detailsBody = el("div");
  private log = el("div");

  // per-topology references
  private cells = new Map<number, CellRefs>();
  private l3s = new Map<number, { btn: HTMLButtonElement; val: HTMLElement }>();
  private dieTemps = new Map<number, HTMLElement>();
  private iod: { btn: HTMLButtonElement; temp: HTMLElement } | undefined;
  private ccxRows = new Map<number, { tgt: HTMLElement; act: HTMLElement; dl: HTMLElement; temp: HTMLElement; sub: HTMLElement }>();
  private coreRows = new Map<number, { row: HTMLElement; no: HTMLElement; rank: HTMLElement; mhz: HTMLElement; tgt: HTMLElement }>();
  private sensorVals = new Map<string, HTMLElement>();

  connectedCallback(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const style = el("style");
    style.textContent = STYLE;
    this.build();
    this.replaceChildren(style, el("div", "mcpu-cq", undefined, this.root));
    for (const k of ["cpu", "ccx", "cores", "sensors", "limits", "profiles", "events", "status"]) this.off.push(ctx.subscribe(k, () => this.schedule()));
    this.sample();
    this.timer = setInterval(() => {
      this.sample();
      this.schedule();
    }, SAMPLE_MS);
  }

  disconnectedCallback(): void {
    this.off.forEach((f) => f());
    this.off = [];
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  // ---- structure ----

  private build(): void {
    const head = el("div", "mcpu-stack", undefined, this.sub, this.status, this.amdNote);
    head.style.gap = "4px";

    // profile selector
    const seg = el("div", "mcpu-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-labelledby", "mcpu-plbl");
    for (const [k, label] of [
      ["stock", "Stock"],
      ["underclock", "Underclock"],
      ["overclock", "Overclock"],
    ] as const) {
      const b = el("button", "", label);
      b.type = "button";
      b.disabled = true;
      b.title = "Switching profiles comes in a later step.";
      b.addEventListener("click", () => void this.run("useProfile", { id: k }, this.actMsg));
      seg.append(b);
      this.profBtns.set(k, b);
    }
    const plbl = el("span", "mcpu-lbl", "Profile");
    plbl.id = "mcpu-plbl";
    this.login.type = "checkbox";
    this.login.id = "mcpu-login";
    this.login.setAttribute("role", "switch");
    this.login.setAttribute("switch", "");
    this.login.disabled = true;
    this.login.addEventListener("change", () => void this.run("setApplyOnStart", { value: this.login.checked }, this.actMsg));
    const loginLabel = el("label", "", "Apply at login");
    loginLabel.htmlFor = this.login.id;
    const toolbar = this.toolbar;
    toolbar.append(
      el("div", "mcpu-ctl", undefined, plbl, seg),
      el("div", "mcpu-login", undefined, el("div", "switch", undefined, this.login), loginLabel),
      this.profSummary,
      this.toolbarNote,
      this.actMsg,
      this.profProblems,
    );
    this.toolbarNote.style.flex = "1 1 100%";
    this.actMsg.style.flex = "1 1 100%";
    this.actMsg.setAttribute("aria-live", "polite");
    toolbar.setAttribute("aria-label", "Profile");

    // Intel limits
    const reapply = el("button", "mcpu-btn", "Re-apply");
    reapply.type = "button";
    reapply.addEventListener("click", () => void this.run("reapply", {}, this.limMsg));
    this.limDrift.append(this.limDriftText, reapply);
    this.limMsg.setAttribute("aria-live", "polite");
    this.limitsCard.append(
      el("div", "mcpu-sec-h", undefined, el("h3", "", "Limits"), el("span", "small muted", "now · stock · the two profiles")),
      this.limAccess,
      this.limThermald,
      this.limDrift,
      el("div", "mcpu-lt-wrap mcpu-live", undefined, this.limTable),
      el("div", "mcpu-lt-foot", undefined, this.limNote, this.limMsg),
    );
    this.limitsCard.setAttribute("aria-label", "Limits");

    // die map
    const mapHead = el(
      "div",
      "mcpu-rowb",
      undefined,
      this.mapTitle,
      this.orderControl("mcpu-ob1"),
    );
    this.sheetToggle.type = "button";
    this.sheetToggle.append(el("span", "mcpu-grab"), this.sheetTitle, this.sheetHint);
    this.sheetToggle.addEventListener("click", () => {
      this.sheetOpen = !this.sheetOpen;
      this.renderSheet();
    });
    const detailBody = el("div", "mcpu-pad mcpu-detail-body", undefined, this.detailTitle, this.detailSub, this.detailRows);
    this.detailSub.style.marginBottom = "6px";
    detailBody.setAttribute("aria-live", "polite");
    this.side.setAttribute("aria-label", "Details");
    this.side.append(this.sheetToggle, detailBody);
    const map = el(
      "section",
      "mcpu-stack",
      undefined,
      mapHead,
      el("div", "mcpu-d2", undefined, el("div", "mcpu-d2main mcpu-live", undefined, this.pkg, this.legend), this.side),
    );
    map.setAttribute("aria-label", "Die map");

    // tuning console
    const target = this.targetCard;
    target.append(
      el("div", "mcpu-sec-h", undefined, el("h3", "", "Target vs actual")),
      el("div", "mcpu-live", undefined, this.ccxTable),
      el("div", "", undefined, note("Actual = the fastest core of the CCX (a core's clock is its busier thread). Δ = actual − target. A CCX only holds its target under load, so idle CCXs show large gaps.")),
    );
    (target.children[2] as HTMLElement).style.padding = "10px 16px 14px";
    const coresCard = el(
      "section",
      "mcpu-card",
      undefined,
      el("div", "mcpu-sec-h", undefined, el("h3", "", "Cores"), this.orderControl("mcpu-ob2")),
      el("div", "mcpu-live", undefined, this.coreTable),
    );
    const profiles = this.profilesCard;
    profiles.append(
      el("div", "mcpu-sec-h", undefined, el("h3", "", "Profiles"), el("span", "small muted", "side by side")),
      this.pcGrid,
      el("div", "", undefined, this.pcNote),
    );
    (profiles.children[2] as HTMLElement).style.padding = "0 16px 14px";
    const console_ = el("div", "mcpu-d3", undefined, target, profiles, coresCard);

    // timeline
    this.tl.append(
      el("div", "mcpu-stack", undefined, this.powerLabel, this.powerPlot),
      el("div", "mcpu-stack", undefined, this.tempLabel, this.tempPlot),
      el("div", "mcpu-stack", undefined, el("span", "mcpu-lbl", "Fastest core, MHz"), this.clockPlot),
      el("div", "mcpu-axis", undefined, el("span", "", "−3 min"), el("span", "", "−2 min"), el("span", "", "−1 min"), el("span", "", "now")),
      this.tlRead,
    );
    for (const s of this.tl.querySelectorAll<HTMLElement>(".mcpu-stack")) s.style.gap = "4px";
    const hover = (e: PointerEvent) => {
      const r = this.powerPlot.getBoundingClientRect();
      if (r.width <= 0) return;
      const fr = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.hoverTs = Date.now() - WINDOW_MS + fr * WINDOW_MS;
      this.renderTimeline();
    };
    this.tl.addEventListener("pointermove", hover);
    this.tl.addEventListener("pointerdown", hover);
    this.tl.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return; // a tap keeps its readout
      this.hoverTs = undefined;
      this.renderTimeline();
    });
    const tile = (label: string, v: HTMLElement, sub: HTMLElement) => el("div", "mcpu-tile", undefined, el("div", "mcpu-lbl", label), v, sub);
    this.powerNote.style.padding = "8px 16px 0";
    const timeline = el(
      "section",
      "mcpu-card mcpu-rail",
      undefined,
      el("div", "mcpu-sec-h", undefined, el("h3", "", "Live"), this.tlFill),
      el("div", "mcpu-live", undefined, el("div", "mcpu-tiles", undefined, tile("Package power", this.tileW, this.tileWs), tile("Package temp", this.tileT, this.tileTs), tile("Fastest core", this.tileC, this.tileCs)), this.powerNote, this.tl),
    );
    timeline.setAttribute("aria-label", "Live power, temperature and clock");

    // collapsed sections
    const sum = (d: HTMLDetailsElement, id: string, title: string, extra?: HTMLElement) => {
      const s = el("summary", "", title);
      if (extra) s.append(extra);
      d.append(s);
      d.open = this.openSecs[id] === true;
      d.addEventListener("toggle", () => {
        this.openSecs[id] = d.open;
        saveJson(OPEN_KEY, this.openSecs);
      });
    };
    sum(this.board, "board", "Board sensors", this.boardSum);
    this.board.append(el("div", "mcpu-live", undefined, this.boardBody));
    sum(this.details, "details", "Details");
    this.details.append(this.detailsBody);

    const log = el(
      "section",
      "mcpu-card mcpu-log",
      undefined,
      el("div", "mcpu-sec-h", undefined, el("h3", "", "Event log"), el("span", "small muted", "newest first · since the tool started")),
      this.log,
    );

    for (const n of [this.board, this.details, log]) n.classList.add("mcpu-after");
    const main = el("div", "mcpu-main", undefined, head, toolbar, this.limitsCard, map, console_, this.board, this.details, log);
    this.root.append(main, timeline, el("div", "mcpu-spacer"));
  }

  private orderControl(id: string): HTMLElement {
    const lbl = el("span", "mcpu-lbl", "Order by");
    lbl.id = id;
    const seg = el("div", "mcpu-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-labelledby", id);
    for (const [k, label] of [
      ["layout", "Layout"],
      ["rank", "Rank"],
    ] as const) {
      const b = el("button", "", label);
      b.type = "button";
      b.dataset.order = k;
      b.addEventListener("click", () => {
        if (this.order === k) return;
        this.order = k;
        saveJson(ORDER_KEY, k);
        this.render();
      });
      seg.append(b);
    }
    this.orderSegs.push(seg);
    return el("div", "mcpu-ctl", undefined, lbl, seg);
  }

  // ---- data ----

  private readView(): View {
    const ctx = this.ctx!;
    const cpu = obj<CpuS>(ctx.get("cpu"));
    const ccx = Object.values(obj<Record<string, CcxS>>(ctx.get("ccx")))
      .filter((c) => isObj(c) && Array.isArray(c.cores))
      .sort((a, b) => a.index - b.index);
    const cores = new Map<number, CoreS>();
    for (const [k, v] of Object.entries(obj<Record<string, CoreS>>(ctx.get("cores")))) {
      if (isObj(v) && Array.isArray(v.threads)) cores.set(Number(k), { ...v, key: Number(k) });
    }
    const sensors = Object.entries(obj<Record<string, SensorS>>(ctx.get("sensors")))
      .filter(([, v]) => isObj(v))
      .map(([k, v]) => ({ ...v, key: k }))
      .sort((a, b) => a.order - b.order);
    const profiles = obj<ProfilesS>(ctx.get("profiles"));
    const activeKey: ProfileKey = profiles.active ?? "stock";
    const active = activeKey === "stock" ? undefined : profiles.list?.[activeKey];
    const ranked = [...cores.values()].map((c) => (c.rank === undefined ? { key: c.key } : { key: c.key, rank: c.rank }));
    const hi = cpu.maxMHz ?? Math.max(4000, ...[...cores.values()].map((c) => c.mhz ?? 0));
    const lo = Math.min(cpu.minMHz ?? 1500, hi - 500);
    const tuning = cpu.tuning === true;
    const limits = obj<LimitsS>(ctx.get("limits"));
    const intel = !tuning && profiles.kind === "limits" && limits.supported === true;
    const shows = tuning || intel;
    return {
      cpu,
      ccx,
      cores,
      sensors,
      profiles,
      activeKey: shows ? activeKey : "stock",
      active: tuning ? active : undefined,
      rankNo: rankNumbers(ranked),
      lo,
      hi,
      stale: ctx.isStale("cores"),
      tuning,
      amd: cpu.vendor === "AMD",
      intel,
      limits,
    };
  }

  /** The cores of `c` in layout order. */
  private coresOf(v: View, c: CcxS): CoreS[] {
    return c.cores.map((k) => v.cores.get(k)).filter((x): x is CoreS => x !== undefined);
  }

  private dies(v: View): { ccd: number; ccx: CcxS[] }[] | undefined {
    const shape = v.ccx.map((c) => (c.ccd === undefined ? { index: c.index, cores: c.cores.length, slots: c.slots } : { index: c.index, ccd: c.ccd, cores: c.cores.length, slots: c.slots }));
    const layout = v.amd ? dieLayout(shape) : undefined;
    return layout?.map((d) => ({ ccd: d.ccd, ccx: d.ccx.map((i) => v.ccx.find((c) => c.index === i)!) }));
  }

  /** The group a core is shown in: its CCX on AMD, P-/E-core on an Intel hybrid. */
  private groupOf(v: View, c: CoreS): string {
    if (c.kind) return `${c.kind}-core`;
    return v.ccx.find((y) => y.index === c.ccx)?.name ?? "";
  }

  private sample(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.isStale("cores")) return; // no fresh numbers: leave a gap
    const cores = Object.values(obj<Record<string, CoreS>>(ctx.get("cores")));
    const mhz = Math.max(...cores.map((c) => (isObj(c) && typeof c.mhz === "number" ? c.mhz : 0)));
    const cpu = obj<CpuS>(ctx.get("cpu"));
    const t = cpu.pkgTemp;
    const s: Sample = { ts: Date.now() };
    if (mhz > 0) s.mhz = mhz;
    if (t) s.temp = t.value;
    if (typeof cpu.powerW === "number") s.w = cpu.powerW;
    pushSample(this.samples, s, WINDOW_MS);
  }

  // ---- rendering ----

  private render(): void {
    if (!this.ctx) return;
    const v = this.readView();
    this.view = v;
    this.root.classList.toggle("mcpu-stale", v.stale);
    this.renderHead(v);
    this.toolbar.hidden = !v.tuning && !v.intel;
    this.targetCard.hidden = !v.tuning;
    this.profilesCard.hidden = !v.tuning;
    this.limitsCard.hidden = !v.intel;
    this.amdNote.hidden = v.tuning || v.intel || v.cores.size === 0;
    for (const seg of this.orderSegs) (seg.parentElement as HTMLElement).hidden = v.rankNo.size === 0;
    if (v.tuning) this.renderProfiles(v);
    if (v.intel) {
      this.renderIntelToolbar(v);
      this.renderLimits(v);
    }
    const sig = JSON.stringify([v.tuning, v.amd, v.cpu.model, v.ccx.map((c) => [c.index, c.name, c.ccd, c.cores, c.slots]), [...v.cores.values()].map((c) => [c.key, c.name, c.ccx, c.kind])]);
    if (sig !== this.topoSig) {
      this.topoSig = sig;
      this.buildMap(v);
      this.buildTables(v);
      if (this.sel.kind === "core" && !v.cores.has(this.sel.key)) this.sel = { kind: "ccx", index: v.ccx[0]?.index ?? 0 };
      if (this.sel.kind === "ccx" && !v.ccx.some((c) => this.sel.kind === "ccx" && c.index === this.sel.index)) this.sel = { kind: "iod" };
      // Only AMD has CCX boxes to hover; elsewhere start on the first core.
      const first = [...v.cores.values()].sort((x, y) => x.order - y.order)[0];
      if (this.sel.kind === "ccx" && !this.l3s.has(this.sel.index)) this.sel = first ? { kind: "core", key: first.key } : { kind: "iod" };
    }
    for (const seg of this.orderSegs) for (const b of seg.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.order === this.order));
    this.renderMap(v);
    this.renderDetail(v);
    this.renderTables(v);
    this.renderTimeline();
    this.renderBoard(v);
    this.renderDetails(v);
    this.renderLog();
  }

  private renderHead(v: View): void {
    const c = v.cpu;
    const parts: string[] = [];
    if (c.model) parts.push(c.model);
    if (c.cores) parts.push(`${c.cores} cores / ${c.threads} threads`);
    const shape = this.shapeText(v);
    if (shape) parts.push(shape);
    put(this.sub, parts.join(" · "));
    const st = this.ctx!.get("status");
    put(this.status, typeof st === "string" ? st : "");
  }

  /** "2 CCD × 2 CCX × 3 cores" when the shape is regular. */
  private shapeText(v: View): string {
    const kinds = [...v.cores.values()].filter((c) => c.kind);
    if (kinds.length) {
      const p = kinds.filter((c) => c.kind === "P").length;
      return `${p} P-cores + ${kinds.length - p} E-cores`;
    }
    if (!v.amd) return "";
    const dies = this.dies(v) ?? this.ccdGroups(v);
    const per = new Set(v.ccx.map((c) => c.cores.length));
    if (per.size !== 1) return v.ccx.length ? `${v.ccx.length} CCX` : "";
    const n = [...per][0]!;
    if (dies.length && new Set(dies.map((d) => d.ccx.length)).size === 1) return `${dies.length} CCD × ${dies[0]!.ccx.length} CCX × ${n} cores`;
    return `${v.ccx.length} CCX × ${n} cores`;
  }

  /** CCXs grouped by CCD (empty when the CCD isn't known). */
  private ccdGroups(v: View): { ccd: number; ccx: CcxS[] }[] {
    if (!v.ccx.length || v.ccx.some((c) => c.ccd === undefined)) return [];
    const by = new Map<number, CcxS[]>();
    for (const c of v.ccx) by.set(c.ccd!, [...(by.get(c.ccd!) ?? []), c]);
    return [...by.entries()].map(([ccd, ccx]) => ({ ccd, ccx }));
  }

  // ---- Intel limits ----

  /** Runs an action, showing its result (or error) in `out`; one at a time. */
  private async run(name: string, args: Record<string, JsonValue>, out: HTMLElement): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx || this.busy) return false;
    this.busy = true;
    out.dataset.kind = "";
    put(out, "Working…");
    this.schedule();
    try {
      const r = obj<{ text?: string; problems?: string[] }>(await ctx.action(name, args));
      const problems = Array.isArray(r.problems) ? r.problems : [];
      out.dataset.kind = problems.length ? "warn" : "";
      put(out, [r.text ?? "Done.", ...problems].join(" "));
      return true;
    } catch (e) {
      out.dataset.kind = "err";
      put(out, (e as Error).message || String(e));
      return false;
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  private renderIntelToolbar(v: View): void {
    const list = v.profiles.list ?? {};
    const none = v.limits.access === "none";
    for (const [k, b] of this.profBtns) {
      b.setAttribute("aria-pressed", String(k === v.activeKey));
      const p = k === "stock" ? undefined : list[k];
      const empty = k !== "stock" && (!p?.values || Object.keys(p.values).length === 0);
      b.disabled = this.busy || none || empty;
      b.title = none ? "motherapp has no write access to the CPU limits yet (see Limits)." : empty ? "Nothing set in this profile yet: set values in Limits first." : "";
    }
    this.login.disabled = this.busy;
    this.login.checked = v.profiles.applyOnStart !== false;
    const p = v.activeKey === "stock" ? undefined : list[v.activeKey];
    const what = p ? `${p.name}: ${p.detail ?? ""}. Everything else at stock.` : "Stock: the limits as they were before motherapp changed anything.";
    const login = v.profiles.applyOnStart === false ? "Not applied at login." : p ? "Applied again when the tool starts (at login)." : "Apply at login is on; with stock there is nothing to apply.";
    put(this.profSummary, `${what} ${login}`);
    put(this.profProblems, v.profiles.problems ?? "");
    this.setNote(this.toolbarNote, "Picking a profile applies it at once. A profile changes only what it sets; everything else goes back to stock.");
  }

  private setNote(box: HTMLElement, text: string): void {
    if (box.dataset.text === text) return;
    box.dataset.text = text;
    box.replaceChildren(note(text));
  }

  /** Display text for a limit value. */
  private lText(k: LimitKey, val: LVal | undefined): string {
    if (val === undefined) return "—";
    if (k === "turbo") return val ? "on" : "off";
    const u = UNIT[k];
    return u ? `${val} ${u}` : String(val);
  }

  private renderLimits(v: View): void {
    const l = v.limits;
    const rows = Object.entries(l.rows ?? {})
      .filter(([, r]) => isObj(r))
      .map(([k, r]) => ({ key: k as LimitKey, ...(r as LimitRowS) }))
      .sort((a, b) => a.order - b.order);
    const list = v.profiles.list ?? {};
    const sig = JSON.stringify([rows.map((r) => [r.key, r.label, r.min, r.max, r.writable]), l.governors, l.epps, PIDS.map((id) => [list[id]?.name, list[id]?.values]), v.activeKey]);
    if (sig !== this.limSig) {
      this.limSig = sig;
      this.buildLimits(v, rows);
    }
    this.limAccess.hidden = !l.accessText;
    if (l.accessText) setCodeText(this.limAccess, l.accessText);
    this.limThermald.hidden = !l.thermaldText;
    if (l.thermaldText) setCodeText(this.limThermald, l.thermaldText);
    const drift = l.drift ?? [];
    this.limDrift.hidden = drift.length === 0;
    put(this.limDriftText, drift.length ? `Changed outside this profile: ${drift.join(", ")}.` : "");
    for (const b of this.limDrift.querySelectorAll("button")) b.disabled = this.busy || l.access === "none";
    for (const r of rows) {
      const c = this.limCells.get(r.key);
      if (!c) continue;
      put(c.now, this.lText(r.key, r.now));
      c.now.dataset.hl = String(r.now !== undefined && r.stock !== undefined && r.now !== r.stock);
      put(c.stock, this.lText(r.key, r.stock));
    }
    for (const id of PIDS) {
      const a = this.limActs.get(id);
      if (!a) continue;
      const dirty = this.drafts.has(id);
      a.save.disabled = this.busy || !dirty;
      a.revert.disabled = this.busy || !dirty;
    }
    const stockWhen = l.stockFrom === "snapshot" && l.stockAt ? `the values before motherapp first changed them this boot (${clock(l.stockAt)})` : "the current values, since motherapp hasn't changed anything this boot";
    this.setNote(
      this.limNote,
      `Stock = ${stockWhen}. In a profile, leave a field empty (or "stock") to keep it at stock. Saving the active profile applies it at once. Highlighted "now" values differ from stock.`,
    );
  }

  private buildLimits(v: View, rows: (LimitRowS & { key: LimitKey })[]): void {
    const l = v.limits;
    const list = v.profiles.list ?? {};
    this.limCells.clear();
    this.limActs.clear();
    const head = el("div", "mcpu-lt-row mcpu-lt-head", undefined, el("span", "", "Setting"), el("span", "", "Now"), el("span", "", "Stock"));
    for (const id of PIDS) {
      const h = el("span", "", list[id]?.name ?? id);
      h.dataset.active = String(v.activeKey === id);
      if (v.activeKey === id) h.append(" ", el("span", "badge badge-subtle theme-primary mcpu-badge-sm", "Active"));
      head.append(h);
    }
    const out: HTMLElement[] = [head];
    for (const r of rows) {
      const now = el("span");
      const stock = el("span", "muted");
      const lbl = el("span", "", r.label + (UNIT[r.key] ? `, ${UNIT[r.key]}` : ""));
      if (!r.writable) lbl.append(el("span", "small muted", " (no access)"));
      const row = el("div", "mcpu-lt-row", undefined, lbl, now, stock);
      const inputs = new Map<Pid, HTMLInputElement | HTMLSelectElement>();
      for (const id of PIDS) {
        const saved = list[id]?.values?.[r.key];
        const draft = this.drafts.get(id)?.[r.key];
        const inp = this.limInput(r, l, saved);
        if (draft !== undefined) inp.value = draft;
        inp.dataset.dirty = String(draft !== undefined && draft !== this.inputText(r.key, saved));
        inp.setAttribute("aria-label", `${list[id]?.name ?? id}: ${r.label}`);
        inp.addEventListener(inp instanceof HTMLSelectElement ? "change" : "input", () => {
          const d = { ...(this.drafts.get(id) ?? {}) };
          d[r.key] = inp.value;
          const changed = Object.entries(d).some(([k, val]) => val !== this.inputText(k as LimitKey, list[id]?.values?.[k as LimitKey]));
          if (changed) this.drafts.set(id, d);
          else this.drafts.delete(id);
          inp.dataset.dirty = String(inp.value !== this.inputText(r.key, list[id]?.values?.[r.key]));
          this.schedule();
        });
        inputs.set(id, inp);
        row.append(inp);
      }
      this.limCells.set(r.key, { now, stock, inputs });
      out.push(row);
    }
    const foot = el("div", "mcpu-lt-row", undefined, el("span"), el("span"), el("span"));
    for (const id of PIDS) {
      const save = el("button", "mcpu-btn primary", "Save");
      const revert = el("button", "mcpu-btn", "Revert");
      save.type = revert.type = "button";
      save.addEventListener("click", () => void this.saveProfile(id));
      revert.addEventListener("click", () => {
        this.drafts.delete(id);
        this.limSig = "";
        this.schedule();
      });
      this.limActs.set(id, { save, revert });
      foot.append(el("div", "mcpu-acts", undefined, save, revert));
    }
    out.push(foot);
    this.limTable.replaceChildren(...out);
  }

  /** The input text for a saved value ("" = stock). */
  private inputText(k: LimitKey, val: LVal | undefined): string {
    if (val === undefined) return "";
    if (k === "turbo") return val ? "on" : "off";
    return String(val);
  }

  private limInput(r: LimitRowS & { key: LimitKey }, l: LimitsS, saved: LVal | undefined): HTMLInputElement | HTMLSelectElement {
    const choices = r.key === "turbo" ? ["on", "off"] : r.key === "governor" ? (l.governors ?? []) : r.key === "epp" ? (l.epps ?? []) : undefined;
    if (choices) {
      const sel = el("select", "mcpu-in");
      sel.append(el("option", "", "stock"));
      (sel.lastChild as HTMLOptionElement).value = "";
      for (const c of choices) {
        const o = el("option", "", c);
        o.value = c;
        sel.append(o);
      }
      const want = this.inputText(r.key, saved);
      // a saved value this CPU doesn't list still shows
      if (want && !choices.includes(want)) {
        const o = el("option", "", want);
        o.value = want;
        sel.append(o);
      }
      sel.value = want;
      return sel;
    }
    const inp = el("input", "mcpu-in num");
    inp.type = "number";
    inp.inputMode = "numeric";
    inp.step = r.key === "maxMHz" || r.key === "eMaxMHz" ? "100" : "1";
    if (r.min !== undefined) inp.min = String(r.min);
    if (r.max !== undefined) inp.max = String(r.max);
    inp.placeholder = "stock";
    inp.value = this.inputText(r.key, saved);
    return inp;
  }

  private async saveProfile(id: Pid): Promise<void> {
    const values: Record<string, JsonValue> = {};
    for (const [k, c] of this.limCells) {
      const raw = c.inputs.get(id)?.value.trim() ?? "";
      if (raw === "") continue;
      if (k === "turbo") values[k] = raw === "on";
      else if (k === "governor" || k === "epp") values[k] = raw;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n)) {
          this.limMsg.dataset.kind = "err";
          put(this.limMsg, `${this.view?.limits.rows?.[k]?.label ?? k}: "${raw}" isn't a whole number.`);
          return;
        }
        values[k] = n;
      }
    }
    if (await this.run("saveProfile", { id, values }, this.limMsg)) {
      this.drafts.delete(id);
      this.limSig = "";
      this.schedule();
    }
  }

  private renderProfiles(v: View): void {
    this.setNote(this.toolbarNote, "Switching profiles comes in a later step. The selector shows the active profile from cpu.json.");
    for (const [k, b] of this.profBtns) b.setAttribute("aria-pressed", String(k === v.activeKey));
    this.login.checked = v.profiles.applyOnStart !== false;
    const login = v.profiles.applyOnStart === false ? "Apply at login is off." : v.activeKey === "stock" ? "Apply at login is on, but with stock there is nothing to re-apply." : "Apply at login is on: this profile will be re-applied when the tool starts, once applying exists.";
    put(this.profSummary, `${profileSummary(v.activeKey, v.active, { driver: v.cpu.driver, maxMHz: v.cpu.maxMHz })} ${login}`);
    put(this.profProblems, v.profiles.problems ?? "");

    const sig = JSON.stringify([v.profiles.list, v.activeKey, v.ccx.length]);
    if (sig === this.profSig) return;
    this.profSig = sig;
    const u = v.profiles.list?.underclock;
    const o = v.profiles.list?.overclock;
    const rows = compareProfiles(u, o, v.ccx.length);
    const card = (key: "underclock" | "overclock", p: ProfileS | undefined, side: "a" | "b") => {
      const unset = !p?.ccx && p?.vcore === undefined;
      const c = el("div", "mcpu-pc");
      c.dataset.unset = String(unset);
      c.dataset.active = String(v.activeKey === key);
      const h = el("div", "mcpu-pc-h", undefined, el("strong", "", p?.name ?? key));
      if (v.activeKey === key) h.append(el("span", "badge badge-subtle theme-primary mcpu-badge-sm", "Active"));
      c.append(h);
      if (unset) {
        const n = el("div", "small muted", "Values not set yet: they come from tuning.");
        n.style.padding = "0 12px 10px";
        c.append(n);
      }
      for (const r of rows) {
        const row = el("div", "mcpu-pc-r", undefined, el("span", "muted", r.label), el("span", "", side === "a" ? r.a : r.b));
        row.dataset.hl = String(side === "a" ? r.hlA : r.hlB);
        c.append(row);
      }
      return c;
    };
    this.pcGrid.replaceChildren(card("underclock", u, "a"), card("overclock", o, "b"));
    const both = !!u?.ccx && !!o?.ccx;
    const below = (p: ProfileS | undefined) => {
      if (!p?.ccx) return "";
      const best = Math.max(...p.ccx);
      return p.ccx.map((f, i) => (f < best ? `CCX${i + 1} ${formatDelta(f - best)}` : "")).filter(Boolean).join(", ");
    };
    let text = "Rows where the two profiles differ get highlighted once both have values.";
    if (both) text = "Highlighted: rows where the two profiles differ, and CCXs a profile sets below its own best CCX.";
    else {
      const one = o?.ccx ? o : u?.ccx ? u : undefined;
      const other = one === o ? u : o;
      const b = below(one);
      if (one && b) text = `Highlighted: ${one.name} targets below its best CCX (${b} MHz). Once ${other?.name ?? "the other profile"} has values, rows that differ between the two get highlighted too.`;
    }
    this.pcNote.innerHTML = INFO_ICON;
    this.pcNote.append(el("span", "", text));
  }

  private buildMap(v: View): void {
    this.cells.clear();
    this.l3s.clear();
    this.dieTemps.clear();
    const label = el("div", "mcpu-pkg-label", undefined, el("span", "", `${v.cpu.model ?? "CPU"} package`), el("span", "", "schematic, not to scale"));
    const dies = this.dies(v);
    const hover = (node: HTMLElement, sel: Sel) => {
      const pick = () => this.select(sel);
      node.addEventListener("mouseenter", pick);
      node.addEventListener("focus", pick);
      node.addEventListener("click", () => {
        this.select(sel);
        if (window.matchMedia("(max-width: 720px)").matches && !this.sheetOpen) {
          this.sheetOpen = true;
          this.renderSheet();
        }
      });
    };
    const cell = (c: CoreS): HTMLButtonElement => {
      const rb = el("span", "rb");
      const cv = el("span", "cv");
      const b = el("button", "mcpu-cell", undefined, el("span", "mcpu-cell-top", undefined, el("span", "", short(c.name)), rb), cv);
      b.type = "button";
      hover(b, { kind: "core", key: c.key });
      this.cells.set(c.key, { btn: b, rb, cv });
      return b;
    };
    const kids: HTMLElement[] = [label];
    if (dies) {
      const row = el("div", "mcpu-dies");
      for (const d of dies) {
        const t = el("span", "num");
        this.dieTemps.set(d.ccd, t);
        const die = el("div", "mcpu-die", undefined, el("div", "mcpu-die-h", undefined, el("span", "", `CCD${d.ccd}`), t));
        for (const c of d.ccx) {
          const cs = this.coresOf(v, c);
          const slots = Math.max(c.slots, cs.length);
          const rows = Math.ceil(slots / 2);
          const grid = el("div", "mcpu-ccx");
          grid.style.gridTemplateRows = `repeat(${rows}, auto)`;
          const place = (node: HTMLElement, i: number) => {
            node.style.gridColumn = i < rows ? "1" : "3";
            node.style.gridRow = String((i % rows) + 1);
            grid.append(node);
          };
          cs.forEach((core, i) => place(cell(core), i));
          for (let i = cs.length; i < slots; i++) {
            // One tile per disabled slot, drawn neutrally: which physical slot is fused off
            // isn't known (Linux numbers the enabled cores only).
            const s = el("div", "mcpu-slot");
            if (i === cs.length) s.append(el("span", "", `${cs.length} of ${slots}`), el("span", "", "active"));
            s.title = `${slots - cs.length} of this CCX's ${slots} core slots ${slots - cs.length === 1 ? "is" : "are"} disabled. Which one isn't known yet: Linux numbers only the enabled cores.`;
            place(s, i);
          }
          const val = el("span", "num");
          const l3 = el("button", "mcpu-l3", undefined, el("strong", "", c.name), el("span", "", "L3"), val);
          l3.type = "button";
          l3.style.gridRow = `1 / span ${rows}`;
          hover(l3, { kind: "ccx", index: c.index });
          this.l3s.set(c.index, { btn: l3, val });
          grid.append(l3);
          die.append(grid);
        }
        row.append(die);
      }
      kids.push(row);
    } else {
      // Not the 2 CCD × 2 CCX shape (another Ryzen, an Intel CPU): a plain grid per CCX, per
      // P-/E-core type, or one for the whole CPU.
      const groups = gridGroups([...v.cores.values()], v.ccx, v.amd);
      for (const g of groups) {
        let head: HTMLElement;
        if (g.ccx !== undefined) {
          const val = el("span", "num");
          const b = el("button", "mcpu-l3", undefined, el("strong", "", g.title), val);
          b.type = "button";
          b.style.flexDirection = "row";
          b.style.justifyContent = "space-between";
          b.style.padding = "4px 8px";
          hover(b, { kind: "ccx", index: g.ccx });
          this.l3s.set(g.ccx, { btn: b, val });
          head = b;
        } else {
          head = el("div", "mcpu-die-h", undefined, el("span", "", `${g.title} (${g.keys.length})`));
        }
        const grid = el("div", "mcpu-grid");
        for (const k of g.keys) {
          const core = v.cores.get(k);
          if (core) grid.append(cell(core));
        }
        kids.push(el("div", "mcpu-die", undefined, head, grid));
      }
    }
    const temp = el("span", "num");
    const iod = el("button", "mcpu-iod", undefined, el("strong", "", dies ? "I/O die" : "Package"), temp);
    if (v.tuning) iod.append(el("span", "muted", "Vcore — · PPT — (need the SMU)"));
    put(this.mapTitle, "");
    this.mapTitle.append(dies ? "Die map " : "Cores ", el("span", "small muted", dies ? "· hover or tap a core, CCX or the I/O die" : "· hover or tap a core for its numbers"));
    (this.mapTitle.lastChild as HTMLElement).style.fontWeight = "400";
    iod.type = "button";
    hover(iod, { kind: "iod" });
    this.iod = { btn: iod, temp };
    kids.push(iod);
    this.pkg.replaceChildren(...kids);

    const steps = 7;
    this.legend.replaceChildren(el("span", "lt", `${v.lo} idle`));
    for (let i = 0; i < steps; i++) {
      const sw = el("span", "sw");
      heatStyle(sw, heatFraction(v.lo + ((v.hi - v.lo) * i) / (steps - 1), v.lo, v.hi));
      this.legend.append(sw);
    }
    this.legend.append(el("span", "lt", `${v.hi} MHz boost`));
    this.legend.setAttribute("aria-hidden", "true");
  }

  private select(sel: Sel): void {
    if (JSON.stringify(sel) === JSON.stringify(this.sel)) return;
    this.sel = sel;
    if (this.view) {
      this.renderMap(this.view);
      this.renderDetail(this.view);
    }
  }

  private renderMap(v: View): void {
    const rankMode = this.order === "rank";
    for (const [key, r] of this.cells) {
      const c = v.cores.get(key);
      if (!c) continue;
      put(r.cv, mhzText(c.mhz));
      const no = v.rankNo.get(key);
      put(r.rb, no === undefined ? "" : `#${no}`);
      r.rb.dataset.on = String(rankMode && no !== undefined);
      heatStyle(r.btn, heatFraction(c.mhz, v.lo, v.hi));
      r.btn.dataset.sel = String(this.sel.kind === "core" && this.sel.key === key);
      r.btn.setAttribute("aria-label", `${c.name}, ${mhzText(c.mhz)} MHz${c.rank !== undefined ? `, rank ${c.rank}${no ? ` (#${no})` : ""}` : ""}`);
    }
    for (const c of v.ccx) {
      const r = this.l3s.get(c.index);
      if (!r) continue;
      put(r.val, mhzText(c.maxMHz));
      r.btn.dataset.sel = String(this.sel.kind === "ccx" && this.sel.index === c.index);
      r.btn.setAttribute("aria-label", `${c.name}, fastest core ${mhzText(c.maxMHz)} MHz, ${c.cores.length} of ${Math.max(c.slots, c.cores.length)} cores active`);
    }
    for (const [ccd, t] of this.dieTemps) {
      const temp = v.ccx.find((c) => c.ccd === ccd)?.temp;
      put(t, temp ? `${temp.label} ${formatTemp(temp.value)}` : "");
    }
    if (this.iod) {
      const t = v.cpu.pkgTemp;
      put(this.iod.temp, t ? `${tempLabel(t.label)} ${formatTemp(t.value)}` : "no package temperature");
      this.iod.btn.dataset.sel = String(this.sel.kind === "iod");
    }
  }

  private targetText(v: View, index: number): string {
    if (v.activeKey === "stock") return "—";
    const t = targetFor(v.active, index);
    return t === undefined ? "not set" : `${t} MHz`;
  }

  private profileLabel(v: View): string {
    return v.activeKey === "stock" ? "Stock" : (v.active?.name ?? v.activeKey);
  }

  private renderDetail(v: View): void {
    const rows: [string, string][] = [];
    let title = "";
    let sub = "";
    let brief = "";
    const s = this.sel;
    if (s.kind === "core") {
      const c = v.cores.get(s.key);
      const x = c ? v.ccx.find((y) => y.index === c.ccx) : undefined;
      if (c && x) {
        title = c.name;
        brief = `${mhzText(c.mhz)} MHz`;
        sub = [this.groupOf(v, c), x.ccd !== undefined ? `CCD${x.ccd}` : "", `cpu${c.threads.length > 1 ? "s" : ""} ${c.threads.map((t) => t.cpu).join(" and ")}`].filter(Boolean).join(" · ");
        rows.push([c.threads.length > 1 ? "Core clock (busier thread)" : "Core clock", `${mhzText(c.mhz)} MHz`]);
        for (const t of c.threads) rows.push([`cpu ${t.cpu}`, `${mhzText(t.mhz)} MHz`]);
        const no = v.rankNo.get(c.key);
        rows.push(["Preferred-core rank", c.rank === undefined ? "—" : `${c.rank}${no ? ` (#${no} of ${v.rankNo.size})` : ""}`]);
        if (c.temp) rows.push([`Core temperature (${c.temp.label})`, formatTemp(c.temp.value)]);
        else if (x.temp) rows.push([`Die temperature (${x.temp.label})`, formatTemp(x.temp.value)]);
        if (v.tuning) rows.push([`CCX target (${this.profileLabel(v)})`, this.targetText(v, x.index)]);
      }
    } else if (s.kind === "ccx") {
      const x = v.ccx.find((y) => y.index === s.index);
      if (x) {
        const cs = this.coresOf(v, x);
        const fast = x.fastCore !== undefined ? v.cores.get(x.fastCore) : undefined;
        const slots = Math.max(x.slots, cs.length);
        title = x.name;
        brief = `fastest ${mhzText(x.maxMHz)} MHz`;
        sub = [x.ccd !== undefined ? `CCD${x.ccd}` : "", `cpus ${formatCpuList(x.cpus)}`].filter(Boolean).join(" · ");
        rows.push(["Fastest core", x.maxMHz === undefined ? "—" : `${x.maxMHz} MHz${fast ? ` (${fast.name})` : ""}`]);
        if (v.tuning) {
          rows.push([`Target (${this.profileLabel(v)})`, this.targetText(v, x.index)]);
          const t = targetFor(v.active, x.index);
          rows.push(["Δ actual − target", t !== undefined && x.maxMHz !== undefined ? `${formatDelta(x.maxMHz - t)} MHz` : "—"]);
        }
        rows.push(["Cores active", slots > cs.length ? `${cs.length} of ${slots} (which slot is disabled isn't known yet)` : `${cs.length}`]);
        rows.push(["Cores", cs.map((c) => `${short(c.name)} ${mhzText(c.mhz)}`).join(" · ")]);
        if (x.avgMHz !== undefined) rows.push(["Average of its threads", `${x.avgMHz} MHz`]);
        if (x.temp) rows.push([`Die temperature (${x.temp.label})`, formatTemp(x.temp.value)]);
      }
    } else {
      const t = v.cpu.pkgTemp;
      title = this.dies(v) ? "I/O die" : "Package";
      brief = t ? `${tempLabel(t.label)} ${formatTemp(t.value)}` : "";
      sub = v.tuning ? "Package temperature and what still needs the SMU" : "Package temperature and sensors";
      rows.push([t ? `${t.label} (what fans react to)` : "Package temperature", t ? formatTemp(t.value) : "—"]);
      const ccd = v.sensors.filter((x) => /^Tccd\d+$/.test(x.label));
      if (ccd.length) rows.push([ccd.map((x) => x.label).join(" / "), ccd.map((x) => (Number.isInteger(x.value) ? x.value : x.value.toFixed(1))).join(" / ") + " °C"]);
      if (v.tuning) rows.push(["Vcore", NO_SMU], ["Package power (PPT)", NO_SMU], ["SMU overclock mode", NO_SMU]);
      // Board sensors and the cpufreq settings have their own sections below; keep this short
      // so the panel's height doesn't change with the selection.
      if (!v.tuning) rows.push(["Driver · governor · EPP", [v.cpu.driver, v.cpu.governor, v.cpu.epp].map((x) => x ?? "—").join(" · ")]);
    }
    put(this.detailTitle, title);
    put(this.detailSub, sub);
    const kids = rows.map(([k, val]) => el("div", "mcpu-kvr", undefined, el("span", "muted", k), el("span", "", val)));
    const now = JSON.stringify(rows);
    if (this.detailRows.dataset.sig !== now) {
      this.detailRows.dataset.sig = now;
      this.detailRows.replaceChildren(...kids);
    }
    this.sheetTitle.replaceChildren(el("strong", "", title), document.createTextNode(brief ? ` · ${brief}` : ""));
    this.renderSheet();
  }

  private renderSheet(): void {
    this.side.dataset.open = String(this.sheetOpen);
    this.sheetToggle.setAttribute("aria-expanded", String(this.sheetOpen));
    put(this.sheetHint, this.sheetOpen ? "tap to close" : "tap for details");
  }

  private buildTables(v: View): void {
    this.ccxRows.clear();
    const head = el("div", "mcpu-gt-row mcpu-gt-head", undefined, ...["CCX", "Target", "Actual", "Δ", "Die"].map((t) => el("span", "", t)));
    const rows: HTMLElement[] = [head];
    for (const c of v.ccx) {
      const r = { tgt: el("span"), act: el("strong"), dl: el("span", "mcpu-dl"), temp: el("span"), sub: el("span", "mcpu-gt-sub") };
      this.ccxRows.set(c.index, r);
      const name = el("span", "", undefined, el("strong", "", c.name));
      if (c.ccd !== undefined) name.append(" ", el("span", "small muted", `CCD${c.ccd}`));
      rows.push(el("div", "mcpu-gt-row", undefined, name, r.tgt, el("span", "", undefined, r.act), r.dl, r.temp, r.sub));
    }
    this.ccxTable.replaceChildren(...rows);

    this.coreRows.clear();
    const hybrid = [...v.cores.values()].some((c) => c.kind);
    const group = v.amd ? "CCX" : hybrid ? "Type" : "L3";
    const last = v.tuning ? "Target" : "Temp";
    const chead = el("div", "mcpu-gt-row mcpu-gt-head", undefined, ...["#", "Core", group, "Rank", "Clock", last].map((t) => el("span", "", t)));
    this.coreTable.replaceChildren(chead);
    for (const c of v.cores.values()) {
      const r = { no: el("span", "muted"), rank: el("span"), mhz: el("span"), tgt: el("span"), row: el("div", "mcpu-gt-row") };
      r.row.append(r.no, el("span", "", undefined, el("strong", "", c.name)), el("span", "", this.groupOf(v, c)), r.rank, r.mhz, r.tgt);
      this.coreRows.set(c.key, r);
    }
  }

  private renderTables(v: View): void {
    for (const c of v.ccx) {
      const r = this.ccxRows.get(c.index);
      if (!r) continue;
      const t = targetFor(v.active, c.index);
      put(r.tgt, v.activeKey === "stock" ? "—" : t === undefined ? "not set" : String(t));
      put(r.act, mhzText(c.maxMHz));
      const d = t !== undefined && c.maxMHz !== undefined ? c.maxMHz - t : undefined;
      const dText = d === undefined ? "—" : formatDelta(d);
      const ok = d !== undefined && Math.abs(d) <= 50;
      if (r.dl.dataset.v !== `${dText}|${ok}`) {
        r.dl.dataset.v = `${dText}|${ok}`;
        r.dl.textContent = dText;
        if (ok) r.dl.insertAdjacentHTML("beforeend", CHECK_ICON);
      }
      put(r.temp, c.temp ? formatTemp(c.temp.value) : "—");
      const cs = this.coresOf(v, c);
      put(r.sub, `cpus ${formatCpuList(c.cpus)} · ${cs.map((k) => `${short(k.name)} ${mhzText(k.mhz)}`).join(" · ")}`);
    }
    const keys =
      this.order === "rank"
        ? rankOrder([...v.cores.values()].map((c) => (c.rank === undefined ? { key: c.key } : { key: c.key, rank: c.rank })))
        : [...v.cores.values()].sort((a, b) => a.order - b.order).map((c) => c.key);
    let i = 1; // children[0] is the header
    for (const k of keys) {
      const r = this.coreRows.get(k);
      const c = v.cores.get(k);
      if (!r || !c) continue;
      put(r.no, String(v.rankNo.get(k) ?? ""));
      put(r.rank, c.rank === undefined ? "—" : String(c.rank));
      put(r.mhz, mhzText(c.mhz));
      const t = targetFor(v.active, c.ccx);
      if (!v.tuning) put(r.tgt, c.temp ? formatTemp(c.temp.value) : "—");
      else put(r.tgt, v.activeKey === "stock" ? "—" : t === undefined ? "not set" : String(t));
      if (this.coreTable.children[i] !== r.row) this.coreTable.insertBefore(r.row, this.coreTable.children[i] ?? null);
      i++;
    }
  }

  private renderTimeline(): void {
    const v = this.view;
    const now = Date.now();
    const start = now - WINDOW_MS;
    const s = this.samples.filter((x) => x.ts >= start);
    const span = s.length ? (now - s[0]!.ts) / 1000 : 0;
    put(this.tlFill, span < WINDOW_MS / 1000 - 2 ? `collecting: ${Math.round(span)} s of the last 3 min, while this page is open` : "last 3 min, 1 s steps");
    const x = (ts: number) => ((ts - start) / WINDOW_MS) * 600;
    const mhz = s.filter((p) => p.mhz !== undefined).map((p) => p.mhz!);
    const temps = s.filter((p) => p.temp !== undefined).map((p) => p.temp!);
    const watts = s.filter((p) => p.w !== undefined).map((p) => p.w!);
    // PL1/PL2 as a band on the power chart, when they're in a sensible range for the axis
    const rows = v?.limits.rows;
    const pl = [rows?.pl1W?.now, rows?.pl2W?.now].filter((x): x is number => typeof x === "number");
    const plShown = pl.length === 2 && Math.max(...pl) <= Math.max(400, ...watts) ? pl : [];
    const [wLo, wHi] = axisRange([...watts, ...plShown], [0, 100], 50, 50);
    const lo = v ? Math.floor(v.lo / 500) * 500 : 1500;
    const hi = v ? Math.ceil(v.hi / 500) * 500 : 5000;
    const [cLo, cHi] = axisRange(mhz, [lo, hi], 1000, 500);
    const [tLo, tHi] = axisRange(temps, [30, 70], 20, 10);
    put(this.tempLabel, `${tempLabel(v?.cpu.pkgTemp?.label)}, °C`);
    const events = this.events().filter((e) => e.ts >= start && e.kind !== "start");
    const hover = this.hoverTs;

    const plot = (box: HTMLElement, field: "mhz" | "temp" | "w", a: number, b: number, grid: number, color: string, band?: [number, number, string]) => {
      const top = (val: number) => `${((1 - (val - a) / (b - a)) * 100).toFixed(2)}%`;
      const kids: Element[] = [];
      for (let g = Math.ceil(a / grid) * grid; g < b; g += grid) {
        if (g <= a) continue;
        const gl = el("div", "mcpu-gl", undefined, el("span", "", String(g)));
        gl.style.top = top(g);
        kids.push(gl);
      }
      if (band) {
        const bd = el("div", "mcpu-band", undefined, el("span", "", band[2]));
        bd.style.top = top(band[1]);
        bd.style.height = `calc(${top(band[0])} - ${top(band[1])})`;
        kids.push(bd);
      }
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 600 120");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      // Break the line where samples are missing (the page was hidden or the values stale).
      let seg: string[] = [];
      let last = -Infinity;
      const flush = () => {
        if (seg.length > 1) {
          const pl = document.createElementNS(SVG_NS, "polyline");
          pl.setAttribute("points", seg.join(" "));
          pl.setAttribute("style", `fill:none;stroke:${color};stroke-width:2px;stroke-linejoin:round;vector-effect:non-scaling-stroke`);
          svg.append(pl);
        }
        seg = [];
      };
      for (const p of s) {
        const val = p[field];
        if (val === undefined || p.ts - last > 3 * SAMPLE_MS) flush();
        if (val !== undefined) seg.push(`${x(p.ts).toFixed(1)},${(120 - ((Math.min(b, Math.max(a, val)) - a) / (b - a)) * 120).toFixed(1)}`);
        last = p.ts;
      }
      flush();
      kids.push(svg);
      for (const e of events) {
        const mk = el("div", "mcpu-mk");
        mk.style.left = `${((e.ts - start) / WINDOW_MS) * 100}%`;
        mk.title = `${clock(e.ts)} ${e.text}`;
        if (field === "w") {
          const x = ((e.ts - start) / WINDOW_MS) * 100;
          const lab = el("span", "", e.kind === "config" ? "cpu.json" : e.kind === "problem" ? "cpu.json!" : e.kind);
          // keep the label inside the plot: right of the line, or left of it near "now"
          if (x > 70) lab.style.right = "4px";
          else lab.style.left = "4px";
          mk.append(lab);
        }
        kids.push(mk);
      }
      if (hover !== undefined) {
        const xh = el("div", "mcpu-xh");
        xh.style.left = `${((hover - start) / WINDOW_MS) * 100}%`;
        kids.push(xh);
      }
      box.replaceChildren(...kids);
    };
    const t = v?.active?.ccx;
    const band: [number, number, string] | undefined =
      t && t.length ? [Math.min(...t), Math.max(...t), `${v!.active!.name} targets ${Math.min(...t)}–${Math.max(...t)}`] : undefined;
    plot(this.clockPlot, "mhz", cLo, cHi, 1000, "var(--accent)", band);
    plot(this.tempPlot, "temp", tLo, tHi, 10, "var(--warn)");
    const plBand: [number, number, string] | undefined = plShown.length ? [Math.min(...plShown), Math.max(...plShown), plShown[0] === plShown[1] ? `PL1 = PL2 ${plShown[0]} W` : `PL1 ${plShown[0]} W · PL2 ${plShown[1]} W`] : undefined;
    plot(this.powerPlot, "w", Math.max(0, wLo), wHi, wHi - wLo > 200 ? 100 : 50, "var(--ok)", plBand);
    this.renderTiles(v, s);

    let read = "Hover or tap the chart for values.";
    if (hover !== undefined) {
      const ago = Math.max(0, Math.round((now - hover) / 1000));
      const p = nearestSample(s, hover, 1500);
      const when = ago === 0 ? "now" : `−${ago} s`;
      if (p) {
        read = `${when}: ${p.w === undefined ? "— W" : `${p.w} W`} · fastest core ${mhzText(p.mhz)} MHz · ${tempLabel(v?.cpu.pkgTemp?.label)} ${p.temp === undefined ? "—" : formatTemp(p.temp)}`;
        const ev = events.find((e) => Math.abs(e.ts - hover) <= 2000);
        if (ev) read += ` · ${ev.text}`;
      } else read = `${when}: no sample (the page wasn't open or the values weren't fresh).`;
    }
    put(this.tlRead, read);
  }

  /** The big numbers on top of the Live card, with the 3-minute peak under each. */
  private renderTiles(v: View | undefined, s: Sample[]): void {
    const cpu = v?.cpu ?? {};
    const fresh = !!this.ctx && !this.ctx.isStale("cpu");
    const big = (box: HTMLElement, val: number | undefined, unit: string, digits = 0) => {
      const text = val === undefined || !fresh ? "—" : val.toFixed(digits);
      if (box.dataset.v === text + unit) return;
      box.dataset.v = text + unit;
      box.replaceChildren(text, el("small", "", unit));
    };
    const peak = (k: "w" | "temp" | "mhz") => {
      const xs = s.filter((p) => p[k] !== undefined).map((p) => p[k]!);
      return xs.length ? Math.max(...xs) : undefined;
    };
    big(this.tileW, cpu.powerW, "W", cpu.powerW !== undefined && cpu.powerW < 100 ? 1 : 0);
    big(this.tileT, cpu.pkgTemp?.value, "°C");
    const fast = Math.max(0, ...[...(v?.cores.values() ?? [])].map((c) => c.mhz ?? 0));
    big(this.tileC, fast || undefined, "MHz");
    const pw = peak("w");
    const pt = peak("temp");
    const pc = peak("mhz");
    // the 3-minute peak, as far as this page has seen
    put(this.tileWs, pw === undefined ? "" : `peak ${Math.round(pw)} W`);
    put(this.tileTs, pt === undefined ? "" : `peak ${formatTemp(pt)}`);
    put(this.tileCs, pc === undefined ? "" : `peak ${pc} MHz`);
    setCodeText(this.powerNote, cpu.powerNote ?? "");
    this.powerNote.hidden = !cpu.powerNote;
  }

  private events(): CpuEvent[] {
    const raw = this.ctx?.get("events");
    return Array.isArray(raw) ? (raw as unknown as CpuEvent[]).filter((e) => isObj(e) && typeof e.ts === "number" && typeof e.text === "string") : [];
  }

  private renderBoard(v: View): void {
    const board = v.sensors.filter((s) => s.chip !== "k10temp" && s.chip !== "zenpower" && s.chip !== "coretemp");
    const fmt = (s: SensorS) => (s.kind === "temp" ? formatTemp(s.value) : `${s.value} RPM`);
    put(this.boardSum, board.length ? board.map((s) => `${s.label} ${fmt(s)}`).join(" · ") : "none found");
    const sig = JSON.stringify([board.map((s) => [s.key, s.name, s.description]), v.cpu.hidden ?? []]);
    if (sig !== this.sensorsSig) {
      this.sensorsSig = sig;
      this.sensorVals.clear();
      const rows: HTMLElement[] = board.map((s) => {
        const val = el("span", "num");
        this.sensorVals.set(s.key, val);
        return el("div", "mcpu-li", undefined, el("span", "", undefined, el("strong", "", s.name), el("br"), el("span", "small muted", s.description)), val);
      });
      if (!board.length) rows.push(el("div", "mcpu-li muted", "No board sensors (ASUS EC) found."));
      for (const h of v.cpu.hidden ?? []) rows.push(el("div", "mcpu-li small muted", `Hidden: ${h}`));
      this.boardBody.replaceChildren(...rows);
    }
    for (const s of board) {
      const n = this.sensorVals.get(s.key);
      if (n) put(n, fmt(s));
    }
  }

  private renderDetails(v: View): void {
    const c = v.cpu;
    const ranks = [...v.cores.values()].filter((k) => k.rank !== undefined).map((k) => k.rank!);
    const slots = v.ccx.map((x) => Math.max(x.slots, x.cores.length));
    const disabled = v.ccx.reduce((n, x, i) => n + slots[i]! - x.cores.length, 0);
    const shape = this.shapeText(v);
    const rows: [string, string][] = [
      ["CPU", [c.model, c.cores ? `${c.cores} cores / ${c.threads} threads` : ""].filter(Boolean).join(", ") || "—"],
      ["Topology", shape ? `${shape}${disabled && v.amd ? ` (${slots[0]} slots per CCX, ${disabled} disabled in all; which ones isn't known yet)` : ""}` : "—"],
      ["Driver", c.driver ?? "—"],
      ["Governor", c.governor ?? "—"],
      ["EPP", c.epp ?? "—"],
      ["Boost", c.boost === undefined ? "unknown" : `${c.boost ? "on" : "off"}${c.maxMHz ? `, up to ${c.maxMHz} MHz` : ""}${c.cappedMHz ? `, capped at ${c.cappedMHz} MHz` : ""}`],
      ["Lowest normal clock", c.minMHz === undefined ? "—" : `${c.minMHz} MHz`],
      ["Preferred-core ranks", ranks.length ? `${Math.min(...ranks)}–${Math.max(...ranks)}, higher is better` : "—"],
      [
        "Ranks by core",
        ranks.length
          ? [...v.cores.values()]
              .sort((a, b) => a.order - b.order)
              .map((k) => `${short(k.name)} ${k.rank ?? "—"}`)
              .join(" · ")
          : "—",
      ],
      ...v.sensors
        .filter((s) => s.chip === "k10temp" || s.chip === "zenpower" || (s.chip === "coretemp" && /^Package id/.test(s.label)))
        .map((s): [string, string] => [`${s.name} (${s.description})`, formatTemp(s.value)]),
    ];
    if (v.tuning) rows.push(["Vcore", NO_SMU], ["Package power (PPT)", NO_SMU], ["SMU overclock mode", NO_SMU], ["Profiles file", v.profiles.file ?? "—"]);
    else if (v.intel) rows.push(["Profiles file", v.profiles.file ?? "—"], ["Stock values", v.limits.stockFrom === "snapshot" && v.limits.stockAt ? `as they were before motherapp first changed them (${clock(v.limits.stockAt)})` : "the current values (nothing changed this boot)"]);
    else rows.push(["Profiles", AMD_ONLY]);
    const sig = JSON.stringify(rows);
    if (this.detailsBody.dataset.sig === sig) return;
    this.detailsBody.dataset.sig = sig;
    this.detailsBody.replaceChildren(...rows.map(([k, val]) => el("div", "mcpu-li", undefined, el("span", "muted", k), el("span", "num", val))));
  }

  private renderLog(): void {
    const ev = this.events();
    const sig = ev.length ? `${ev.length}:${ev[ev.length - 1]!.ts}:${new Date().toDateString()}` : "0";
    if (sig === this.eventsSig) return;
    this.eventsSig = sig;
    const rows = [...ev].reverse().map((e) => el("div", "mcpu-li", undefined, el("span", "lt small muted num", clock(e.ts)), el("span", "", e.text)));
    if (!rows.length) rows.push(el("div", "mcpu-li muted", "Nothing yet."));
    this.log.replaceChildren(...rows);
  }
}
