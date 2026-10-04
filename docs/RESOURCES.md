# PrivaNet Resource Management

Status: **Phase 2 (Adaptive Resource Engine) is complete as of v0.2.1.** Opaque chunk capacity and direct TLS transfer are implemented through v0.4.0-alpha.3; market and credit models remain planned.

Implemented (v0.2.0): operator policy file (hard memory/CPU ceilings, owner RAM/CPU reserve, safety margin, per-capability ceilings), an adaptive memory/CPU budget with fast-down/slow-up smoothing and enter/exit hysteresis, pressure states, weekly schedules (`FULL`/`ADAPTIVE`/`MINIMAL`/`OFF`), battery policy, minimal budget telemetry in heartbeats, job resource declarations, a resource-aware scheduler, preemption of preemptible jobs after sustained pressure, voluntary release with refund, graceful draining and a goodbye that records an expected departure.

Implemented (v0.2.1, completing the phase):

- **Disk**: a scratch-disk ceiling (`maxDiskBytes`) and an owner free-space reserve (`reserveDiskBytes`) bound `diskBudgetBytes`; free space is read from the volume holding the state directory, and unknown free space offers none. The disk-I/O class the node offers (`diskIo`) is capped by `maxDiskIo` and lowered while the owner's disk is busy (Linux `/proc/diskstats` utilisation).
- **Network**: a `TransferMeter` enforces `maxBandwidthBytesPerSec` (token bucket) and `monthlyTransferBytes` (persisted UTC-month counter); the remaining allowance is the reported `networkBudgetBytes`. Handlers call `context.transfer(bytes)` before moving data; the daemon also counts each job's control-plane bytes. With `linkBytesPerSec` configured, the host's total throughput (Linux `/proc/net/dev`) raises pressure.
- **Disk/network pressure** only ever produces `ELEVATED` (halves the budget), never `HIGH`, and uses enter/exit thresholds (75/65 percent) with the same smoothing as CPU.
- **Scheduling on the new limits**: a job is assigned only if its declared disk, disk-I/O class and network estimate fit what the node reports. Nodes that do not report a field are not blocked by it.
- **Schedule-aware placement**: the node reports `availableForMs`, the time until its schedule next sets `OFF` (omitted if none within a week). A job whose declared `expectedDurationMs` is longer is not placed on that node.
- **Checkpoint/resume** for job types registered `checkpointable`: a node-local, bounded (1 MiB, 24 h), owner-private `CheckpointStore`. Preemption or shutdown keeps the checkpoint; if the Coordinator hands the job to the *same node* again it resumes; completion or failure deletes it. Other nodes never see it.
- **Battery on macOS and Windows**: `pmset -g batt` and the WMI battery status are parsed from fixed, argument-free commands run in the background at most once a minute; failures report `UNKNOWN` (treated as mains).
- **Windows graceful stop**: `SIGBREAK`/`SIGHUP` join `SIGINT`, and on every platform a `DRAIN` file created in the state directory asks the running node to drain (the way for a service manager or script to stop it gracefully).
- **A real long-running workload**: `system.hashchain.v1` (deterministic, CPU-bound, preemptible, checkpointable; tests use it to prove preemption and resume) and its measured cost calibrated the declared estimate.

Known limits and deliberately deferred work (none block the phase):

- **Coordinator-visible limits are node-wide for disk and network.** Per-capability ceilings still apply to memory and CPU only.
- **Non-Linux disk and network load are not sampled**: those platforms are limited by the owner's caps, reserve and free space, not by observed disk/network activity. The measured disk load includes PrivaNet's own I/O, so it errs on the side of backing off.
- **The macOS and Windows battery commands run in CI but were not exercised on a real portable device**; the output parsers are unit-tested with representative outputs. The Windows console-signal handlers likewise are not testable from CI (the `DRAIN` file path is tested on all three platforms).
- **Checkpoints are node-local.** Resuming on a different node needs a data plane and integrity design and belongs with Phases 4 and 5. Only the hash-chain job is checkpointable today.
- **Measured per-job resource use and thermal signals are not collected.** Measured usage is Phase 7; thermal input is a later optimisation. Declared estimates are still hints, and hash-chain's were set from one measurement on a development machine (about 1.5 s per million iterations, declared as 30 s for the 5-million maximum, a deliberate 4x margin), not a fleet.
- The `FULL` level differs from `ADAPTIVE` only in ignoring the owner's current CPU load (the owner's RAM reserve and pressure pausing still apply).

The sections below describe the design, including parts (markets, credits, storage) that are not yet built.

## Principle

> PrivaNet consumes spare resources; it does not compete with the owner for their computer.

User workloads always take priority over PrivaNet workloads.

## Resource policy

A node operator should eventually be able to configure hard ceilings and reserves independently.

Examples:

- maximum CPU contribution
- maximum RAM contribution
- minimum RAM reserved for the owner
- maximum storage contribution
- upload/download bandwidth limits
- contribution schedules
- capability-specific limits
- reduce/disable contribution while on battery

The Coordinator must never override operator-defined hard limits.

## Choosing limits without editing files

The node's local control panel and CLI (`privanet-node policy preset|show|export|import`, [NODE_CONTROL_PANEL.md](NODE_CONTROL_PANEL.md)) change this same policy: four presets (Minimal, Balanced = the defaults, Generous, Maximum while idle) set the CPU, memory, disk, bandwidth, battery and level fields only, and any other edit is shown as "Custom". Changes apply live except `fetch` limits (restart) and job slots (environment). The panel can pause contribution for a while; a pause is the owner's own decision and is not revocation.

## Adaptive contribution

Static resource limits are useful but insufficient. A machine's spare capacity changes constantly.

For memory, a conceptual budget is:

```text
usable = available_memory - owner_reserve - safety_margin
node_budget = min(usable, configured_hard_limit)
```

This is a design model, not a final implementation formula. The production algorithm should account for OS-specific memory-pressure signals and avoid treating every byte reported as "free" as safely allocatable.

Example:

A 16 GiB machine may have roughly 12 GiB readily available while idle but only 3 GiB available while a game is running. PrivaNet should automatically reduce its eligible workload as pressure rises.

Adaptive changes should be smoothed/hysteretic. A momentary spike should not immediately destroy useful work, while sustained pressure should return resources promptly to the owner.

## CPU

CPU scheduling should consider system pressure rather than only a fixed percentage.

Potential inputs include:

- recent CPU utilization
- load/run queue
- interactive workload pressure
- thermal constraints where exposed safely
- configured CPU ceiling

Low-priority OS scheduling may complement, but should not replace, explicit resource policy.

## Memory

Potential inputs include:

- readily available memory
- memory pressure
- swap activity
- configured owner reserve
- configured hard ceiling

Memory-intensive PrivaNet work should be preempted or avoided before the host begins thrashing.

## Storage and disk I/O

Storage contribution and disk activity are separate concerns.

A node may have large storage capacity but should still be able to limit background disk I/O. (Scratch-disk and disk-I/O limits exist since v0.2.1.) **Storage contribution, 0.4.0-alpha.1:** a default-off `storage` block (`enabled`, `maxBytes`, `reserveFreeBytes`) controls the node's local chunk store ([PHASE4_DESIGN](PHASE4_DESIGN.md#15-40-alpha1-as-built-and-what-changed-from-this-design)). The store never holds more than `maxBytes` (committed data, writes in progress and leftover partial files all count), never takes the disk below `reserveFreeBytes` free (checked before, while and at the end of every write), stops accepting writes while the node is paused, draining, off-schedule, on a disabled battery policy or the owner is busy on the disk, and lowering a limit never deletes anything. Capacity alone opens no listener. **Since alpha.3**, a separate explicit `storage.transfer` opt-in enables direct pinned TLS transfer; [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md) documents all settings and administrator-environment precedence. PUT/GET/DELETE honor owner pause, drain, schedule, battery, disk, concurrency, bandwidth and monthly limits. **Since 0.4.0-alpha.2 the node tells the Coordinator how much room it has** (the heartbeat's optional `services['storage.chunk.v1']`: `capacityBytes` = your `maxBytes`, `freeBytes` = what a write would be allowed right now after quota and reserve, and the 8 MiB chunk limit), but only while storage is on, the store opened safely and is healthy, free space is known, and the node would accept a write this instant (not draining, not paused by you or by pressure, inside its schedule, no battery or busy-disk rule). The moment any of that stops being true the next heartbeat leaves the offer out and the Coordinator places nothing more on this node. The figures are hints the Coordinator may see as stale: your limits are re-checked by the node at every transfer, and a Coordinator's placement is permission to attempt, never to exceed them. No path, chunk list or inventory is ever sent. Future resource-aware scheduling may distinguish sequential/background storage tasks from latency-sensitive operations.

## Network

Operators define a bandwidth ceiling and a monthly transfer allowance (implemented in v0.2.1, see the status section). With a configured link speed the node also backs off while the host's own traffic is high (Linux only). Finer adaptive behaviour, such as per-connection shaping, is not built.

Resource accounting must measure actual useful bytes rather than advertised bandwidth.

Future direct data transfers (Phase 4 and 5, [DATA_PLANE.md](DATA_PLANE.md)) consume the same owner limits: a valid transfer authorization never overrides the bandwidth ceiling, the monthly transfer allowance, the disk limits, the schedule or a paused contribution. Authorizations describe what a transfer may do; only the owner's policy decides whether the node does it. Bytes will be metered from verified transfers, not from issued authorizations.

A node running beside the Coordinator on an always-on server is an optional, separate contribution with conservative limits, so the control plane's availability wins over contributed work; the Coordinator never depends on that node ([DATA_PLANE.md](DATA_PLANE.md#11-deployment-model)).

## Battery-powered devices

Portable systems should support policies such as:

- contribute normally on AC power
- reduce contribution on battery
- disable contribution on battery

A conservative default should avoid unexpectedly consuming significant battery power.

## Resource-aware jobs

Future typed job definitions should expose estimates/requirements such as:

```text
CPU intensity
expected RAM
expected disk space
expected disk-I/O intensity
expected network usage
preemptible: yes/no
checkpointable: yes/no
expected duration (when known)
```

These declarations are scheduler hints and policy inputs, not permission to exceed node limits. A future market will additionally need each job type to name a versioned billing/measurement unit (for example a crawl or indexing unit); that is a later additive registry field, not part of the estimate.

Scheduling should eventually require both:

```text
node supports required capability
```

and:

```text
node currently has sufficient permitted spare resources
```

## Job slots

`PRIVANODE_JOB_SLOTS` (1 to 64, default 1) lets one node run several jobs at once; the owner can also save a number with the control panel or `privanet-node slots set N` (it applies at the next start, and an explicit `PRIVANODE_JOB_SLOTS` takes priority). More slots do not raise the owner's limits: the Coordinator reserves the declared estimate of every job a node is already running against the budget it reported (memory, CPU class, disk, network) before placing another, so the node's permitted budget is a hard ceiling on concurrent work. A node with no resource engine reports no budget and is held to the small legacy budget. Slots suit I/O-bound work such as `web.fetch.v1`, where a job is mostly waiting for the network; a CPU-bound workload gains nothing from more slots than cores. How many jobs actually run at once is the smaller of the slots and what the reported budget allows: each job reserves at least its CPU class minimum (5% for `low`, which `web.fetch.v1` declares), so an owner who caps contribution at 25% CPU (the default) runs about five fetches at once however many slots are set. In a measurement with the ceiling raised to 100% one process reached about 16 concurrent fetches before the CPU reservation, not the slot count, was the limit. Each slot is a lane in the same process, so it costs far less than another node process (about 80 MiB each in measurements) and shares one identity and one set of owner limits.

## Preemption

PrivaNet workloads should be preemptible whenever the workload can safely support it.

When host resource pressure rises:

1. stop assigning additional work to the pressured node;
2. reduce or pause suitable work;
3. checkpoint checkpointable jobs;
4. return/requeue jobs when necessary;
5. release resources promptly;
6. resume/accept additional work only after pressure has remained low enough.

Not every operation can be checkpointed. Job definitions must explicitly describe their behavior.

## Heartbeat telemetry

**Implemented** (v0.2 and v0.2.1): the heartbeat carries only the *currently permitted* budget and coarse states, never raw measurements: `contribution` level, `pressure`, `power` source, permitted memory and CPU, optional per-capability memory/CPU budgets, permitted scratch disk and disk-I/O class, remaining transfer allowance, and `availableForMs` (time until the owner's schedule next turns contribution off). Configured limits, raw memory/CPU/disk/network samples and host identifiers stay on the node. The Coordinator treats all of it as an untrusted scheduling hint. See [protocol](protocol.md#resource-report-v02).

**Not collected:** raw memory or CPU figures, disk capacity, process or host inventory, thermal state, and measured per-job resource use (the last belongs to Phase 7). Telemetry should keep collecting only what the scheduler genuinely needs and avoid privacy-sensitive host information.

## Supply, pricing and the future market

Status: **planned / research** (Phase 8). See [the resource market design](RESOURCE_MARKET.md).

The budget this engine computes is the raw material for a node's *supply* of each resource class in a future market. The relationship is one-directional: the engine decides what the owner allows right now; a market can only price and match capacity inside that limit.

```text
Idle:    available RAM 12 GiB -> PrivaNet budget 8 GiB,  CPU budget 50 %
Gaming:  available RAM  3 GiB -> PrivaNet budget 0.5 GiB, CPU budget 5 %
```

- Supply is **dynamic**. A node is never required to honour previously advertised capacity if that would break hard operator limits or resource-safety rules, and releasing work under pressure is expected behaviour, not failure.
- **Advertised capacity earns nothing.** Only verified consumption is settled.
- Owners will eventually be able to state a minimum price (an *ask*) per class, or use automatic, competitive, premium or custom pricing modes, plus pricing conditions such as "day: contribute if price ≥ reference; evening: only if price ≥ 1.4 × reference". These build on the schedule levels above; a condition simply evaluates to an effective ask or "unavailable" at a given time.
- The market and the scheduler stay separate: the market decides which supply is economically eligible and at what clearing price; the scheduler (which already uses budgets and pressure, and later reliability and planned availability) chooses among them. Price never overrides an owner's limits.
- Per-class supply and ask reporting, when added, will be **additive optional heartbeat fields**; the current `ResourceReport` and job `ResourceEstimate` are deliberately class-neutral and need no change.
- Resource telemetry remains minimal. A market does not justify collecting detailed host information; verifying claimed supply is a measurement-phase problem (challenges, spot checks, two-ended accounting), not something to solve by reading more from the host.
- Treasury-funded public work (planned, Phase 9; see [TREASURY.md](TREASURY.md)) uses this same supply and these same limits. Public crawling, maintenance and bootstrap-funded jobs get no exemption from a node's budget, pressure, schedule or owner limits, and non-urgent public work is lower priority than owner and private workloads. A treasury payer changes who pays, not what a node is allowed to do.

## Planned availability

Nodes should eventually support schedules such as:

```text
Weekdays
00:00-07:00  Full
07:00-16:00  Adaptive
16:00-23:00  Minimal

Weekend
All day      Adaptive
```

Planned availability lets the scheduler avoid placing unsuitable long-running work shortly before a node intends to leave. (Implemented in v0.2.1 as `availableForMs`: see the status section.)

## Graceful draining

Expected lifecycle:

```text
ONLINE -> DRAINING -> OFFLINE_EXPECTED
```

When entering `DRAINING`, the Coordinator should:

- stop assigning new jobs;
- let suitable short jobs finish;
- checkpoint/requeue appropriate work;
- migrate or repair critical storage when necessary;
- release leases cleanly;
- record that the departure was expected.

Graceful planned shutdown should not be treated like an unexpected node disappearance when reliability is calculated.

## Implementation staging

(Design-time staging, kept for context. Core Foundation and the Adaptive Resource Engine are done as of v0.2.1; measurement against real workloads continues in Phases 3-7, and "later optimization" is not built.)

### Core Foundation

- keep job/capability/heartbeat models extensible
- implement safe static limits where needed
- do not build the entire adaptive scheduler yet

### Adaptive Resource Engine

- resource telemetry
- operator policy
- resource-aware scheduler
- preemption/draining
- schedules
- battery behavior
- measurement and tuning

### Later optimization

- workload-specific prediction
- improved checkpointing
- demand-aware scheduling
- historical resource forecasting

All later optimization must preserve the owner's hard limits and priority.

## `web.fetch.v1` estimate

Low CPU, 48 MiB memory, no disk, up to 2 MiB network, 30 s, preemptible, not checkpointable (a preempted fetch is simply retried). Owner limits and the `fetch` policy section apply as for any job.
