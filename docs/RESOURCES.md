# PrivaNet Resource Management

Status: **the v0.2 core is implemented; the rest is planned.**

Implemented in v0.2: operator policy file (hard memory/CPU ceilings, owner RAM/CPU reserve, safety margin, per-capability ceilings), an adaptive memory/CPU budget with fast-down/slow-up smoothing and enter/exit hysteresis, pressure states, weekly schedules (`FULL`/`ADAPTIVE`/`MINIMAL`/`OFF`), battery policy (Linux power detection only; other systems report `UNKNOWN` and are treated as mains), minimal budget telemetry in heartbeats, job resource declarations, a resource-aware scheduler, preemption of preemptible jobs after sustained pressure, voluntary release with refund, graceful draining and a goodbye that records an expected departure.

Not yet implemented: disk capacity/disk-I/O awareness, bandwidth and monthly transfer limits, network-pressure awareness, checkpoint/resume, thermal signals, using the schedule to plan long-running placement (the Coordinator sees only the current level), measured job resource use, and calibration on real workloads. Only `system.echo.v1` exists, so preemption is proven with test handlers, not real workloads. The `FULL` level differs from `ADAPTIVE` only in ignoring the owner's current CPU load (the owner's RAM reserve and pressure pausing still apply).

The sections below describe the design, including parts not yet built.

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

A node may have large storage capacity but should still be able to limit background disk I/O. Future resource-aware scheduling may distinguish sequential/background storage tasks from latency-sensitive operations.

## Network

Operators should be able to define bandwidth ceilings/reserves. Future adaptive behavior may reduce PrivaNet traffic when the owner's applications are actively using the connection.

Resource accounting must measure actual useful bytes rather than advertised bandwidth.

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

These declarations are scheduler hints and policy inputs, not permission to exceed node limits.

Scheduling should eventually require both:

```text
node supports required capability
```

and:

```text
node currently has sufficient permitted spare resources
```

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

The Core Foundation should leave room for future heartbeat/resource fields without requiring the complete adaptive scheduler now.

Possible future telemetry includes:

- configured limits
- currently permitted budget
- available memory / memory pressure
- CPU pressure
- disk capacity and pressure
- network policy/state
- power state
- planned availability

Telemetry should collect only what the scheduler genuinely needs and should avoid unnecessary privacy-sensitive host information.

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

Planned availability lets the scheduler avoid placing unsuitable long-running work shortly before a node intends to leave.

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
