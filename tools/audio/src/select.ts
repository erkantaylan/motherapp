// Selecting an output or input that has no node yet (a RouteOption): switch the card's profile
// if the route isn't on the active one, wait for the node, make sure the route is the active
// one of its device, then make the node the default. Shared by serve mode and the CLI; how to
// wait for the graph to change is the caller's (serve mode watches pw-dump --monitor, the CLI
// polls pw-dump).
import type { AudioOps } from "./ops.ts";
import { routeNode } from "./pipewire.ts";
import type { AudioView, Device, RouteOption } from "./pipewire.ts";

/** A Bluetooth profile switch took 1-2 s on the machine; ALSA is faster. */
export const SWITCH_TIMEOUT_MS = 10_000;

export interface SelectDeps {
  ops: AudioOps;
  /**
   * Resolves with the first non-undefined `pick(view)`, checked now and after every change to
   * the graph, or with undefined after `timeoutMs`.
   */
  waitView<T>(pick: (view: AudioView) => T | undefined, timeoutMs: number): Promise<T | undefined>;
  timeoutMs?: number;
}

export async function selectRoute(opt: RouteOption, deps: SelectDeps): Promise<Device> {
  const timeout = deps.timeoutMs ?? SWITCH_TIMEOUT_MS;
  if (opt.profile !== undefined) await deps.ops.setProfile(opt.card, opt.profile);
  // The old profile's nodes are removed before the card reports the new profile (seen in a
  // pw-dump --monitor capture), and ids get reused, so "profile active + node on the right
  // card.profile.device" is the test, not "a node id we haven't seen".
  const found = await deps.waitView((v) => {
    const node = routeNode(v, opt);
    if (!node) return undefined;
    return { node, activeRoute: v.cards.find((c) => c.id === opt.card)?.routes.get(opt.device) };
  }, timeout);
  if (!found) {
    const what = opt.kind === "sink" ? "output" : "input";
    throw new Error(`${opt.title}: no ${what} appeared within ${Math.round(timeout / 1000)} s of switching the card profile`);
  }
  // WirePlumber picks a route for the new profile itself (the best available one, or the one it
  // saved); if that isn't this one, switch the port as GNOME does.
  if (found.activeRoute !== opt.route) await deps.ops.setRoute(opt.card, opt.route, opt.device);
  await deps.ops.setDefault(found.node);
  return found.node;
}
