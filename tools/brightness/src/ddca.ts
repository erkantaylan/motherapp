// koffi bindings for the part of libddcutil 1.4 (soname libddcutil.so.4, Ubuntu 24.04 package
// libddcutil4) the brightness tool uses. Types and prototypes are copied from the 1.4.1
// headers (ddcutil_types.h, ddcutil_c_api.h, ddcutil_status_codes.h in libddcutil-dev
// 1.4.1-1build2), not from memory. The 2.x library (libddcutil.so.5) changed the API
// (ddca_init and friends) and is deliberately not loaded here.
//
// Every call is synchronous and can block for seconds on a slow or absent monitor, so this
// module is only imported by the worker thread (ddcWorker.ts), never by the serve loop.
import { createRequire } from "node:module";

export const SONAME = "libddcutil.so.4";
export const VCP_BRIGHTNESS = 0x10;

/** DDCRC_* codes from ddcutil_status_codes.h (RCRANGE_DDC_START = 3000). */
export const DDCRC = {
  OK: 0,
  DDC_DATA: -3001,
  NULL_RESPONSE: -3002,
  RETRIES: -3007,
  REPORTED_UNSUPPORTED: -3005,
  DETERMINED_UNSUPPORTED: -3012,
  ARG: -3013,
  INVALID_DISPLAY: -3020,
  VERIFY: -3023,
  NOT_FOUND: -3024,
  LOCKED: -3025,
  ALREADY_OPEN: -3026,
} as const;

/** One detected display, decoded from DDCA_Display_Info. */
export interface DdcaDisplay {
  dispno: number;
  /** DDCA_IO_I2C = 0, DDCA_IO_USB = 2. */
  ioMode: number;
  bus: number;
  mfg: string;
  model: string;
  serial: string;
  productCode: number;
  /** EDID bytes 12..15 (binary serial number), 0 when unset. */
  binarySerial: number;
  /** Opaque DDCA_Display_Ref (a pointer, as a BigInt). Valid until the next redetect. */
  dref: bigint;
}

export interface DdcaValue {
  current: number;
  max: number;
}

export class DdcaError extends Error {
  readonly status: number;
  readonly rcName: string;
  constructor(op: string, status: number, rcName: string, desc: string, detail?: string) {
    super(`${op}: ${rcName}${desc ? ` (${desc})` : ""}${detail && detail !== desc ? `: ${detail}` : ""}`);
    this.name = "DdcaError";
    this.status = status;
    this.rcName = rcName;
  }
}

export interface Ddca {
  version: string;
  listDisplays(): DdcaDisplay[];
  redetect(): void;
  open(dref: bigint): bigint;
  close(dh: bigint): void;
  getVcp(dh: bigint, code: number): DdcaValue;
  setVcp(dh: bigint, code: number, value: number): void;
}

/** Loads libddcutil.so.4 and binds the functions. Throws if the library or koffi is missing. */
export function loadDdca(soname = SONAME): Ddca {
  // koffi is a native addon; require it lazily so the CLI fallback works without it.
  const require = createRequire(import.meta.url);
  const koffi = require("koffi") as typeof import("koffi");
  const lib = koffi.load(soname);

  // typedef struct { uint8_t major, minor; } DDCA_MCCS_Version_Spec;
  const MccsVersion = koffi.struct("DDCA_MCCS_Version_Spec", { major: "uint8_t", minor: "uint8_t" });
  // typedef struct { int iAdapterIndex; int iDisplayIndex; } DDCA_Adlno;
  const Adlno = koffi.struct("DDCA_Adlno", { iAdapterIndex: "int", iDisplayIndex: "int" });
  // typedef struct { DDCA_IO_Mode io_mode; union { int i2c_busno; DDCA_Adlno adlno; int hiddev_devno; } path; } DDCA_IO_Path;
  const IoPath = koffi.struct("DDCA_IO_Path", {
    io_mode: "int",
    path: koffi.union({ i2c_busno: "int", adlno: Adlno, hiddev_devno: "int" }),
  });
  // DDCA_Display_Info (DDCA_EDID_MFG_ID_FIELD_SIZE 4, MODEL_NAME 14, SN_ASCII 14). `OLD` is
  // not defined in the shipped header, so vcp_version_id is absent.
  const DisplayInfo = koffi.struct("DDCA_Display_Info", {
    marker: koffi.array("char", 4, "Array"),
    dispno: "int",
    path: IoPath,
    usb_bus: "int",
    usb_device: "int",
    mfg_id: koffi.array("char", 4, "String"),
    model_name: koffi.array("char", 14, "String"),
    sn: koffi.array("char", 14, "String"),
    product_code: "uint16_t",
    edid_bytes: koffi.array("uint8_t", 128, "Array"),
    vcp_version: MccsVersion,
    dref: "void *",
  });
  // typedef struct { int ct; DDCA_Display_Info info[]; } DDCA_Display_Info_List;
  const infoOffset = Math.ceil(koffi.sizeof("int") / DisplayInfo.alignment) * DisplayInfo.alignment;
  // typedef struct { uint8_t mh, ml, sh, sl; } DDCA_Non_Table_Vcp_Value;
  koffi.struct("DDCA_Non_Table_Vcp_Value", { mh: "uint8_t", ml: "uint8_t", sh: "uint8_t", sl: "uint8_t" });

  const f = {
    versionString: lib.func("const char *ddca_ddcutil_version_string(void)"),
    rcName: lib.func("const char *ddca_rc_name(int status_code)"),
    rcDesc: lib.func("const char *ddca_rc_desc(int status_code)"),
    getErrorDetail: lib.func("void *ddca_get_error_detail(void)"),
    freeErrorDetail: lib.func("void ddca_free_error_detail(void *erec)"),
    setFout: lib.func("void ddca_set_fout(void *fout)"),
    setFerr: lib.func("void ddca_set_ferr(void *ferr)"),
    enableReportDdcErrors: lib.func("bool ddca_enable_report_ddc_errors(bool onoff)"),
    enableVerify: lib.func("bool ddca_enable_verify(bool onoff)"),
    getInfoList: lib.func("int ddca_get_display_info_list2(bool include_invalid_displays, _Out_ void **dlist_loc)"),
    freeInfoList: lib.func("void ddca_free_display_info_list(void *dlist)"),
    redetect: lib.func("int ddca_redetect_displays(void)"),
    open: lib.func("int ddca_open_display2(void *dref, bool wait, _Out_ void **dh_loc)"),
    close: lib.func("int ddca_close_display(void *dh)"),
    getNonTable: lib.func("int ddca_get_non_table_vcp_value(void *dh, uint8_t feature_code, _Out_ DDCA_Non_Table_Vcp_Value *valrec)"),
    setNonTable: lib.func("int ddca_set_non_table_vcp_value(void *dh, uint8_t feature_code, uint8_t hi_byte, uint8_t lo_byte)"),
  };

  // These settings are per thread; the worker makes every call from this one thread.
  // Nothing may reach the process's stdout: it is the JSON-RPC channel to the core.
  f.setFout(null);
  f.enableReportDdcErrors(false);
  // Skip the read-back after each write (it doubles the time of a set); the tool re-reads
  // in the background once the writes settle.
  f.enableVerify(false);

  // DDCA_Error_Detail: char marker[4]; int status_code; char *detail; ...
  const detailOffset = 8;
  const check = (op: string, rc: number): void => {
    if (rc === 0) return;
    let detail: string | undefined;
    const erec = f.getErrorDetail() as bigint | null;
    if (erec) {
      try {
        const p = koffi.decode(erec, detailOffset, "void *") as bigint | null;
        if (p) detail = koffi.decode(p, "const char *") as string;
      } finally {
        f.freeErrorDetail(erec);
      }
    }
    throw new DdcaError(op, rc, (f.rcName(rc) as string | null) ?? `status ${rc}`, (f.rcDesc(rc) as string | null) ?? "", detail);
  };

  const str = (s: unknown) => (typeof s === "string" ? s.replace(/\0.*$/s, "").trim() : "");

  return {
    version: str(f.versionString()),
    listDisplays() {
      const out: [bigint | null] = [null];
      check("ddca_get_display_info_list2", f.getInfoList(false, out) as number);
      const list = out[0];
      if (!list) return [];
      try {
        const ct = koffi.decode(list, "int") as number;
        const result: DdcaDisplay[] = [];
        for (let i = 0; i < ct; i++) {
          const d = koffi.decode(list, infoOffset + i * DisplayInfo.size, DisplayInfo) as {
            dispno: number;
            path: { io_mode: number; path: { i2c_busno: number } };
            mfg_id: string;
            model_name: string;
            sn: string;
            product_code: number;
            edid_bytes: number[];
            dref: bigint;
          };
          const e = d.edid_bytes;
          result.push({
            dispno: d.dispno,
            ioMode: d.path.io_mode,
            bus: d.path.path.i2c_busno,
            mfg: str(d.mfg_id),
            model: str(d.model_name),
            serial: str(d.sn),
            productCode: d.product_code,
            binarySerial: ((e[12]! | (e[13]! << 8) | (e[14]! << 16) | (e[15]! << 24)) >>> 0),
            dref: d.dref,
          });
        }
        return result;
      } finally {
        f.freeInfoList(list);
      }
    },
    redetect() {
      check("ddca_redetect_displays", f.redetect() as number);
    },
    open(dref) {
      const out: [bigint | null] = [null];
      check("ddca_open_display2", f.open(dref, false, out) as number);
      if (!out[0]) throw new Error("ddca_open_display2 returned no handle");
      return out[0];
    },
    close(dh) {
      check("ddca_close_display", f.close(dh) as number);
    },
    getVcp(dh, code) {
      const v = { mh: 0, ml: 0, sh: 0, sl: 0 };
      check("ddca_get_non_table_vcp_value", f.getNonTable(dh, code, v) as number);
      return { current: (v.sh << 8) | v.sl, max: (v.mh << 8) | v.ml };
    },
    setVcp(dh, code, value) {
      const n = Math.max(0, Math.min(0xffff, Math.round(value)));
      check("ddca_set_non_table_vcp_value", f.setNonTable(dh, code, n >> 8, n & 0xff) as number);
    },
  };
}
