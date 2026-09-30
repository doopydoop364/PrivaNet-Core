# Trusted multi-node validation

Status: implemented and measured for v0.3.0-alpha.4. Scope: **trusted** nodes only, meaning nodes an administrator enrolled with an enrollment token (owner-run machines). Untrusted public nodes, public enrollment and anything in Phase 10 are out of scope and unchanged.

The question this answers: with several PrivaNodes on one Coordinator, does the platform stay correct, recover from failure, and scale without surprises, and what breaks first?

## Method

Real processes, as an operator would run them: one Coordinator and N PrivaNodes on loopback, each node with its own state directory, identity, credential, owner policy and job-slot count, enrolled through the admin CLI and driven only through the admin CLI and `@privanet/sdk`. The harness is `tests/cluster-rig.ts`. The scenarios are in `tests/multinode.cluster.ts` (`npm run test:multinode`, deliberately not part of `npm test`: they kill and pause real processes and take about two minutes) and the measurement driver is `tests/cluster-measure.ts`. The deterministic `system.hashchain.v1` job makes every result independently verifiable: each test recomputes the digest itself, so a wrong, duplicated or corrupted result fails.

In-process tests already cover the single-Coordinator rules (lease fencing, expiry, revocation, quota); the value here is the cross-process behaviour.

## Scenario matrix

| Scenario | Pass criterion | Proof |
| --- | --- | --- |
| Spread over 4 nodes | 40 jobs, each result exactly the recomputed digest, each job completed once, every node did some | `work spreads over every enrolled node ...` |
| Crash mid-job (`SIGKILL`) | job finishes on another node, correct digest, `attempts >= 2`, exactly one node reported a result, crashed node leaves `ONLINE` | `a crashed node ...` |
| Coordinator restart with nodes waiting and jobs running | no job lost, every result correct, all nodes back `ONLINE`, no operator action | `a Coordinator restart ...` |
| Drain one node | the others carry on, all 12 jobs correct and completed once | `draining one node ...` |
| Restart a node | identity file byte-identical, back `ONLINE`, no duplicate node record, takes work | `a restarted node keeps its identity ...` |
| Zombie node (`SIGSTOP`, lease expires, job moves, `SIGCONT`) | result and attempt count unchanged after the zombie wakes; only one completion is ever accepted; the zombie is told it lost the lease | `a zombie node ...` (POSIX only) |
| Mixed cluster | a node without a capability never gets the job; a node whose owner policy allows 20 MiB never holds two 16 MiB jobs at once; a 6-slot node never exceeds 6 | `owner limits and capabilities hold per node ...` |
| Revoke a node mid-job | job finishes elsewhere, the revoked node completes nothing and is refused | `revoking a node mid-job ...` |

## Findings

Ordered by the priority the work was done in: correctness and security, multi-node reliability, recovery, deployment readiness, performance.

**Correctness and security: no defect found.** Cross-process fencing held in every scenario: a paused-then-resumed node cannot renew, complete or duplicate a job whose lease moved; a revoked node completes nothing; owner limits and capability routing hold per node in a heterogeneous cluster; results were never wrong across every run (including the churn run below).

**Recovery: works as designed, with numbers.**

- *Crash failover:* the job is requeued at lease expiry and re-leased within about 50 ms. Measured crash-to-re-lease: 1,341 ms for a 1,500 ms lease, 4,954 ms for 5,000 ms, 15,020 ms for 15,000 ms. The lease TTL is the failover time; choose `PRIVANET_LEASE_MS` accordingly (nodes renew, so a long lease costs nothing while a node is healthy). The re-leased job restarts from the beginning: checkpoints are node-local, so only the same node resumes from one.
- *Coordinator restart:* with 8 and with 24 nodes waiting, a 2 s outage led to the first job completing 0.1 to 0.3 s after the Coordinator was back and every node `ONLINE` about 6.5 s after. Nodes reauthenticate on their own.
- *Churn:* 60 s, 4 nodes, 35 `SIGKILL`s with an immediate restart while jobs were submitted continuously: 2,618 submitted, 2,618 completed, 0 wrong results, 2 jobs needed a retry (the known window where a job is leased to a connection that just died; the lease expires and the job is retried). About one kill in 17 costs one retry, and the cost is one lease TTL of delay for that job.

**Deployment readiness.**

- *Enrollment tokens.* The admin CLI issued tokens that expire after 60 s, fixed. A fleet whose nodes are held back by the per-address authentication limit (below) saw `INVALID_ENROLLMENT` because their tokens expired while they waited. `PRIVANET_ENROLLMENT_TTL_MS` (default unchanged, 60 s; maximum 24 h) now sets it. A node with an expired token keeps retrying and logs `node.connection_failed` with code `INVALID_ENROLLMENT`.
- *Per-address authentication limit.* The default 120 requests per minute per connecting address is shared by every node and application behind one address. Enrolling costs three of those requests and reauthenticating two. Measured: 45 nodes started at once against the default limit all enrolled in 70 s; 12 nodes against a limit of 20 in 67 s. So the limit delays a large simultaneous start (about 40 enrollments a minute) but does not break it, provided the tokens outlive the delay. Behind a reverse proxy the address is the proxy's: see [deployment.md](deployment.md).
- *Revoked nodes.* A revoked node that is left running keeps retrying every 30 s at the default poll interval (two authentication requests a minute, each counted against the shared limit) and logs `UNAUTHORIZED_NODE`. Stop revoked nodes. No change was made: at that rate it takes about 60 forgotten nodes to matter.

**Performance: the Coordinator, not the nodes, is the limit, and one defect showed up only with many job slots.**

- *Defect found by measurement:* every submitted job woke every held-open lease request, and every woken request ran a full transaction plus two scans and JSON parses of the pending jobs. The cost of a job therefore grew with the number of waiting lanes (nodes times `PRIVANODE_JOB_SLOTS`). At 4 nodes with 32 slots (128 lanes) throughput halved, and at 8 nodes with 64 slots (512 lanes, the default waiter cap) the SDK's own requests timed out because the Coordinator was saturated. A CPU profile of the Coordinator showed it about 87 % busy with the nodes mostly idle, dominated by SQLite transaction and statement work.
- *Fixes (v0.3.0-alpha.4):* a work event now wakes at most one waiting lane per capable node (lanes of one node ask the scheduler the same question about the same node, so waking the rest only repeated the work), prepared SQL statements are cached, and `lease()` reuses the pending-job list its own expiry sweep already read instead of reading and parsing it twice. No wire change and no behaviour change; an idle lease attempt fell from 60 µs to 13 µs and authentication from 26 µs to 9.5 µs.
- *Worst case:* if the lane that was woken cannot take the job (for example the owner's limits are full), the job waits for another event or the end of that node's wait (default 5 s, at most 8 s) rather than being offered to a second lane of the same node. It is never lost, and a lane that finishes a job polls at once.

### Throughput (indicative)

Synthetic `system.echo.v1` jobs, 64 in flight, one machine with 4 CPUs running the Coordinator, all nodes and the client together, Node 22 (the project targets 24.4 or newer, so treat absolute numbers as a lower bound and the comparisons as the result), single runs. Echo jobs measure the control plane; real jobs are dominated by their own work.

| nodes x slots | before (jobs/min) | after (jobs/min) |
| --- | --- | --- |
| 1 x 1 | 8,711 | see below |
| 4 x 1 | 13,036 | 16,116 |
| 4 x 16 | 10,397 | 15,288 |
| 4 x 32 | 5,680 | 13,141 |
| 8 x 64 | timed out | 8,687 |

Work spread evenly: with 8 nodes the per-node completions were 248 to 254 of 2,000.

## Not covered, and why

- **Untrusted nodes, public enrollment, result verification by redundancy:** Phase 10, deliberately not started.
- **Windows and macOS for the kill and pause scenarios:** the scenarios use `SIGKILL` and `SIGSTOP` on POSIX; the zombie scenario is skipped on Windows and the suite is not in the default `npm test`. The single-node process test (drain file, restarts) stays in the default suite on all three systems.
- **Real networks:** everything ran on loopback. Latency, packet loss, NAT and TLS-terminating proxies are not exercised; the deployment findings above come from the Coordinator's code and its authentication limit, not from a proxy in front of it.
- **More than about 25 real node processes on one host, and Coordinator failover:** the Coordinator is a single process on SQLite by design ([deployment.md](deployment.md)).
- **Data plane, storage, treasury, credits, market:** not part of this work.

## Reproduce

```text
npm run test:multinode                                   # the scenarios above
node tests/dist/cluster-measure.js throughput            # MEASURE_NODES=1,2,4,8 MEASURE_SLOTS=1 MEASURE_JOBS=3000
node tests/dist/cluster-measure.js failover              # MEASURE_LEASES=1500,5000,15000
node tests/dist/cluster-measure.js restart               # MEASURE_NODES=8
node tests/dist/cluster-measure.js churn                 # MEASURE_SECONDS=60 MEASURE_NODES=4
MEASURE_PROFILE=/tmp/prof node tests/dist/cluster-measure.js throughput   # CPU profiles of every process
```
