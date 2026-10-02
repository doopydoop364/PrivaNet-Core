import { statSync } from 'node:fs';
import type { JobType } from '@privanet/protocol';
import type { PrivaNode } from './daemon.js';
import type { ResourceEngine } from './resource-engine.js';
import type { TransferMeter } from './transfer-meter.js';
import type { ResourcePolicy } from './resource-policy.js';
import { activePause, localStateStamp, makePause, readLocalState, updateLocalState } from './local-state.js';
import type { ActivePause, LocalState, PauseRequest } from './local-state.js';
import { PolicyError, policyFilePath, resolvePolicy, removePolicyFile, savePolicyFile } from './policy-store.js';
import type { ResolvedPolicy } from './policy-store.js';
import { applyPreset, detectPreset } from './presets.js';
import type { PresetId } from './presets.js';
import { policyFindings } from './config-check.js';
import { ResourceHistory } from './history.js';

export interface LocalControlOptions {
  stateDir: string; envPolicyFile?: string | undefined; node: PrivaNode; engine: ResourceEngine; transfer?: TransferMeter | undefined;
  history?: ResourceHistory | undefined; clock?: () => number; log?: (entry: { event: string; code?: string }) => void;
  /** Used to decide when the machine has rebooted (a "until reboot" pause); injectable for tests. */
  bootTime?: () => number;
  /** Called after a change has been applied, so the status snapshot can be republished at once. */
  onChange?: () => void;
}
const policyStamp = (stateDir: string): string => { try { const stat = statSync(policyFilePath(stateDir)); return `${stat.mtimeMs}:${stat.size}`; } catch { return 'none'; } };

/**
 * Applies the owner's saved choices to the running node. The control panel, the CLI and a hand edit all end up in the same two files (policy.json and local-state.json),
 * and this class notices a change (the files' stamps are polled once a second, as the DRAIN file is) and applies it: the engine gets the new policy and pause, the transfer
 * meter its new limits, the node its capability set. A file that cannot be understood never replaces what is already in force: the last good values stay, and the
 * problem is reported. Timed pauses end here by themselves.
 */
export class LocalControl {
  private local: LocalState = { version: 1, disabledCapabilities: [] };
  private localProblem: string | undefined;
  private resolved: ResolvedPolicy | undefined;
  private startupFetch = '';
  private stamps = { local: '', policy: '' };
  private timer: NodeJS.Timeout | undefined;
  private pauseNow: ActivePause | undefined;
  private readonly clock: () => number;
  constructor(private readonly options: LocalControlOptions) { this.clock = options.clock ?? Date.now; }

  /** First read, before the node starts working. A local-state file that cannot be read holds the node paused (never silently un-paused). */
  async init(initial: ResolvedPolicy): Promise<void> {
    this.resolved = initial; this.startupFetch = JSON.stringify(initial.policy.fetch);
    await this.reloadLocal(); this.stamps = { local: localStateStamp(this.options.stateDir), policy: policyStamp(this.options.stateDir) };
    this.applyPause();
    await this.options.history?.load();
  }
  start(): void { this.timer = setInterval(() => { void this.sync().catch(() => undefined); }, 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async reloadLocal(): Promise<void> {
    const read = await readLocalState(this.options.stateDir);
    if (read.kind === 'error') { this.localProblem = read.code; this.options.log?.({ event: 'node.local_state_invalid', code: read.code }); }
    else { this.local = read.state; this.localProblem = undefined; }
    this.options.node.setDisabledCapabilities(this.local.disabledCapabilities);
  }
  private applyPause(): void {
    const now = this.clock();
    this.pauseNow = this.localProblem ? { kind: 'indefinite' } : activePause(this.local.pause, now, this.options.bootTime?.());
    this.options.engine.setOwnerPause(this.pauseNow);
  }
  private async reloadPolicy(): Promise<void> {
    const next = await resolvePolicy(this.options.stateDir, this.options.envPolicyFile).catch(() => undefined);
    if (!next) return;
    if (next.problem && this.resolved) { this.resolved = { ...this.resolved, problem: next.problem }; this.options.log?.({ event: 'node.policy_invalid', code: next.problem.code }); return; }
    this.resolved = next; this.options.engine.setPolicy(next.policy);
    this.options.transfer?.setLimits({ ratePerSec: next.policy.maxBandwidthBytesPerSec, monthlyBytes: next.policy.monthlyTransferBytes });
    this.options.log?.({ event: 'node.policy_applied' });
  }
  /** One pass: pick up changed files, end an expired pause, record history. Called every second, and directly after a change made through this object. */
  async sync(): Promise<void> {
    const stamps = { local: localStateStamp(this.options.stateDir), policy: policyStamp(this.options.stateDir) };
    const changed = stamps.local !== this.stamps.local || stamps.policy !== this.stamps.policy;
    if (stamps.local !== this.stamps.local) { await this.reloadLocal(); this.stamps.local = stamps.local; }
    if (stamps.policy !== this.stamps.policy) { await this.reloadPolicy(); this.stamps.policy = stamps.policy; }
    const before = this.pauseNow?.kind; this.applyPause();
    if (changed || before !== this.pauseNow?.kind) this.options.onChange?.();
    if (this.options.history) {
      const report = this.options.engine.report; const state = this.options.engine.state; const usage = this.options.transfer?.usage();
      await this.options.history.record({ contribution: report.contribution, pressure: report.pressure, permittedMemoryBytes: report.memoryBudgetBytes, permittedCpuPercent: report.cpuBudgetPercent,
        ...(report.diskBudgetBytes !== undefined ? { permittedDiskBytes: report.diskBudgetBytes } : {}), measuredOwnerCpuPercent: Math.max(0, Math.min(100, state.ownerCpuPercent)),
        activeJobs: this.options.node.snapshot.activeJobs.length, ...(usage ? { transferUsedBytes: usage.usedBytes } : {}), ...(this.options.transfer ? { transferRemainingBytes: this.options.transfer.remainingBytes() } : {}) });
    }
  }

  get view() {
    const policy = this.resolved;
    return { local: this.local, localProblem: this.localProblem, pause: this.pauseNow, policy: policy?.policy, source: policy?.source, policyProblem: policy?.problem,
      preset: policy ? detectPreset(policy.policy) : 'custom' as const,
      /** Settings changed since start-up that only take effect after a restart (the web-fetch limits are built into the handler when the node starts). */
      restartRequired: policy && JSON.stringify(policy.policy.fetch) !== this.startupFetch ? ['fetch'] : [] as string[] };
  }

  // ---- changes: each validates, writes atomically, then applies at once ----
  async savePolicy(policy: ResourcePolicy, context: { jobSlots: number; capabilities: JobType[] }): Promise<{ findings: ReturnType<typeof policyFindings> }> {
    const findings = policyFindings(policy, context);
    if (findings.some(finding => finding.severity === 'error')) throw new PolicyError('POLICY_FILE_INVALID', findings.filter(finding => finding.severity === 'error').map(finding => finding.message));
    await savePolicyFile(this.options.stateDir, policy, detectPreset(policy), this.clock());
    await this.sync(); await this.reloadPolicy(); this.stamps.policy = policyStamp(this.options.stateDir); this.options.onChange?.();
    return { findings };
  }
  async choosePreset(id: PresetId, context: { jobSlots: number; capabilities: JobType[] }) {
    const current = this.resolved?.policy; if (!current) throw new Error('POLICY_NOT_READY');
    return this.savePolicy(applyPreset(current, id), context);
  }
  async resetPolicy(): Promise<void> { await removePolicyFile(this.options.stateDir); await this.reloadPolicy(); this.stamps.policy = policyStamp(this.options.stateDir); this.options.onChange?.(); }
  async pause(request: PauseRequest): Promise<void> {
    const now = this.clock();
    await updateLocalState(this.options.stateDir, state => ({ ...state, pause: makePause(request, now, this.options.bootTime?.()) }));
    await this.reloadLocal(); this.stamps.local = localStateStamp(this.options.stateDir); this.applyPause(); this.options.onChange?.();
  }
  async resume(): Promise<void> {
    await updateLocalState(this.options.stateDir, state => { const { pause: _pause, ...rest } = state; void _pause; return rest; });
    await this.reloadLocal(); this.stamps.local = localStateStamp(this.options.stateDir); this.applyPause(); this.options.onChange?.();
  }
  async setName(name: string | undefined): Promise<void> {
    await updateLocalState(this.options.stateDir, state => { const { name: _name, ...rest } = state; void _name; return name === undefined ? rest : { ...rest, name }; });
    await this.reloadLocal(); this.stamps.local = localStateStamp(this.options.stateDir); this.options.onChange?.();
  }
  async setDisabledCapabilities(disabled: JobType[]): Promise<void> {
    await updateLocalState(this.options.stateDir, state => ({ ...state, disabledCapabilities: [...new Set(disabled)] }));
    await this.reloadLocal(); this.stamps.local = localStateStamp(this.options.stateDir); this.options.onChange?.();
  }
}
