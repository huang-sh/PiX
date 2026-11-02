import { localHostStatus, releaseInstallReservation, releaseInstallReservations, reserveLocalHostForInstall, type InstallReservation } from "../host/client.js";
import type { HostConnectionState } from "../shared/host-protocol.js";

export function hasInstallTasks(host: HostConnectionState["host"]) {
  return Boolean(host && (host.running || host.pending || host.commands || host.remoteRunning));
}

export interface InstallPrompt { confirm: boolean; detail: string }
export interface InstallGuardOptions {
  homes: string[];
  ownerPid: number;
  show(prompt: InstallPrompt): Promise<number>;
  stopped(force: boolean): Promise<void>;
  save(reservations: InstallReservation[]): void;
  status?: typeof localHostStatus;
  reserve?: typeof reserveLocalHostForInstall;
  release?: typeof releaseInstallReservation;
}

async function inProfile<T>(home: string, action: () => Promise<T>) {
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous; }
}

/** Only live work prompts. Idle clients are closed by the host's atomic shutdown guard. */
export async function prepareInstallation(options: InstallGuardOptions): Promise<InstallReservation[] | null> {
  while (true) {
    const states: Array<{ home: string; state: HostConnectionState }> = [];
    for (const home of new Set(options.homes)) {
      const state = await inProfile(home, options.status ?? localHostStatus);
      if (state.host && !state.host.verified) throw new Error(state.error ?? "Cannot verify the running PiX host");
      states.push({ home, state: structuredClone(state) });
    }
    let force = false;
    const active = states.filter(({ state }) => hasInstallTasks(state.host));
    if (active.length) {
      const detail = active.map(({ home, state: { host } }) =>
        `${home}\nPiX ${host!.version}: running=${host!.running ?? 0}, pending=${Boolean(host!.pending)}, commands=${host!.commands ?? 0}, remote tasks=${host!.remoteRunning ?? 0}`).join("\n\n");
      const response = await options.show({ confirm: false, detail });
      if (response === 1) continue;
      if (response !== 2 || await options.show({ confirm: true, detail }) !== 1) return null;
      force = true;
    }
    const reservations: InstallReservation[] = [];
    try {
      for (const { home, state } of states) {
        reservations.push(await inProfile(home, () => (options.reserve ?? reserveLocalHostForInstall)(state.host?.id, force && hasInstallTasks(state.host), options.ownerPid)));
        options.save(reservations);
      }
      await options.stopped(force);
      return reservations;
    } catch (error) {
      try { releaseInstallReservations(reservations, options.release); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${String(error)}\n${String(cleanupError)}`, { cause: error });
      }
      options.save([]);
      // Work admitted between inspection and shutdown must get its own confirmation.
      let changed = false;
      for (const { home, state } of states) {
        const current = await inProfile(home, options.status ?? localHostStatus);
        if (current.host?.id !== state.host?.id || (!hasInstallTasks(state.host) && hasInstallTasks(current.host))) changed = true;
      }
      if (changed) continue;
      throw error;
    }
  }
}
