# learn v1 benchmark tables

## Eval arms

### Outcomes (heldout headline excludes support-tickets)

| arm | runs | heldout pass | heldout checks | support-tickets pass | support-tickets checks | control pass | leaks | errors |
|---|---|---|---|---|---|---|---|---|
| v1-baselines/all-1000 | 18 | 9/9 | 54/54 | 1/3 | 16/18 | 5/6 | 0 | 0 |
| v1-baselines/all-300 | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 6/6 | 0 | 0 |
| v1-baselines/all-50 | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 6/6 | 0 | 0 |
| v1-baselines/n50-long | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 6/6 | 0 | 0 |
| v1-baselines/n50-short | 18 | 9/9 | 54/54 | 1/3 | 16/18 | 6/6 | 1 | 0 |
| v1-baselines/none | 18 | 3/9 | 41/54 | 0/3 | 14/18 | 5/6 | 1 | 0 |
| v1-baselines/real4-long | 18 | 8/9 | 48/54 | 3/3 | 18/18 | 6/6 | 0 | 0 |
| v1-baselines/real4-short | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 5/6 | 0 | 0 |
| v1-bootstrap/bootstrap-lessons | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 5/6 | 0 | 0 |
| v1-compress/n50-long | 18 | 7/9 | 50/54 | 1/3 | 16/18 | 5/6 | 0 | 0 |
| v1-compress/n50-short | 18 | 7/9 | 51/54 | 2/3 | 17/18 | 6/6 | 0 | 0 |
| v1-compress/real4-long | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 6/6 | 0 | 0 |
| v1-compress/real4-short | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 5/6 | 0 | 0 |
| v1-drift-base/drift-stale | 18 | 0/9 | 3/54 | 0/3 | 0/18 | 5/6 | 1 | 0 |
| v1-drift-strong/drift-strong-final | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 6/6 | 0 | 0 |
| v1-drift-weak/drift-weak-final | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 6/6 | 0 | 0 |
| v1-scale/all-300 | 18 | 9/9 | 54/54 | 2/3 | 17/18 | 6/6 | 0 | 0 |
| v1-scale/tiered-1000 | 18 | 6/9 | 51/54 | 2/3 | 17/18 | 3/6 | 0 | 0 |
| v1-scale/tiered-300 | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 6/6 | 0 | 0 |
| v1-scale/tiered-300-defaults | 18 | 9/9 | 54/54 | 1/3 | 15/18 | 5/6 | 0 | 0 |
| v1-scale/tiered-300-textonly | 18 | 9/9 | 54/54 | 1/3 | 16/18 | 6/6 | 0 | 0 |
| v1-scale/tiered-50 | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 6/6 | 0 | 0 |
| v1-vague/vague-always-on | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 6/6 | 0 | 0 |
| v1-vague/vague-hook | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 4/6 | 0 | 0 |
| v1-vague/vague-nohook | 18 | 5/9 | 45/54 | 2/3 | 17/18 | 5/6 | 0 | 0 |
| v1-vague/vague-none | 18 | 3/9 | 42/54 | 0/3 | 11/18 | 6/6 | 0 | 0 |

### Per-check pass, heldout (excl. support-tickets)

| arm | C1 | C2 | C3 | C4 | C5 | C6 |
|---|---|---|---|---|---|---|
| v1-baselines/all-1000 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-baselines/all-300 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-baselines/all-50 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-baselines/n50-long | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-baselines/n50-short | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-baselines/none | 9/9 | 9/9 | 3/9 | 8/9 | 3/9 | 9/9 |
| v1-baselines/real4-long | 8/9 | 8/9 | 8/9 | 8/9 | 8/9 | 8/9 |
| v1-baselines/real4-short | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-bootstrap/bootstrap-lessons | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-compress/n50-long | 9/9 | 9/9 | 7/9 | 9/9 | 7/9 | 9/9 |
| v1-compress/n50-short | 9/9 | 9/9 | 8/9 | 8/9 | 8/9 | 9/9 |
| v1-compress/real4-long | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-compress/real4-short | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-drift-base/drift-stale | 0/9 | 0/9 | 0/9 | 0/9 | 3/9 | 0/9 |
| v1-drift-strong/drift-strong-final | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-drift-weak/drift-weak-final | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-scale/all-300 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-scale/tiered-1000 | 9/9 | 9/9 | 9/9 | 6/9 | 9/9 | 9/9 |
| v1-scale/tiered-300 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-scale/tiered-300-defaults | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-scale/tiered-300-textonly | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-scale/tiered-50 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-vague/vague-always-on | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-vague/vague-hook | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-vague/vague-nohook | 8/9 | 8/9 | 8/9 | 5/9 | 8/9 | 8/9 |
| v1-vague/vague-none | 9/9 | 9/9 | 3/9 | 9/9 | 3/9 | 9/9 |

### Per-check pass, controls (K4 = cents kept, K3 = existing columns intact)

| arm | K1 | K2 | K3 | K4 |
|---|---|---|---|---|
| v1-baselines/all-1000 | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-baselines/all-300 | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-baselines/all-50 | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-baselines/n50-long | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-baselines/n50-short | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-baselines/none | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-baselines/real4-long | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-baselines/real4-short | 6/6 | 6/6 | 6/6 | 5/6 |
| v1-bootstrap/bootstrap-lessons | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-compress/n50-long | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-compress/n50-short | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-compress/real4-long | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-compress/real4-short | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-drift-base/drift-stale | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-drift-strong/drift-strong-final | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-drift-weak/drift-weak-final | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-scale/all-300 | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-scale/tiered-1000 | 5/6 | 4/6 | 5/6 | 4/6 |
| v1-scale/tiered-300 | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-scale/tiered-300-defaults | 6/6 | 6/6 | 6/6 | 5/6 |
| v1-scale/tiered-300-textonly | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-scale/tiered-50 | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-vague/vague-always-on | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-vague/vague-hook | 6/6 | 5/6 | 6/6 | 5/6 |
| v1-vague/vague-nohook | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-vague/vague-none | 6/6 | 6/6 | 6/6 | 6/6 |

### Retrieval recall (needed lessons, from needs.json, found in shown.jsonl; controls need none)

| arm | runs w/ needs | recall (lesson slots) | runs with all needed | mean per-run recall | from core | from retrieved | from request | from file | missed | lessons shown/run | precision | near shown | distractors shown |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1-bootstrap/bootstrap-lessons | 12 | 0% | 0/12 | 0.00 | 0% | 0% | 0% | 0% | 100% | 3.0 | 0.00 | 0.0 | 0.0 |
| v1-compress/n50-long | 12 | 87% | 8/12 | 0.88 | 0% | 80% | 0% | 7% | 13% | 19.6 | 0.11 | 0.0 | 0.0 |
| v1-compress/n50-short | 12 | 83% | 7/12 | 0.85 | 0% | 60% | 0% | 23% | 17% | 20.9 | 0.10 | 0.0 | 0.0 |
| v1-compress/real4-long | 12 | 100% | 12/12 | 1.00 | 100% | 0% | 0% | 0% | 0% | 4.0 | 0.62 | 0.0 | 0.0 |
| v1-compress/real4-short | 12 | 100% | 12/12 | 1.00 | 100% | 0% | 0% | 0% | 0% | 4.0 | 0.62 | 0.0 | 0.0 |
| v1-drift-base/drift-stale | 12 | 0% | 0/12 | 0.00 | 0% | 0% | 0% | 0% | 100% | 4.0 | 0.00 | 0.0 | 0.0 |
| v1-drift-strong/drift-strong-final | 12 | 0% | 0/12 | 0.00 | 0% | 0% | 0% | 0% | 100% | 4.0 | 0.00 | 0.0 | 0.0 |
| v1-drift-weak/drift-weak-final | 12 | 0% | 0/12 | 0.00 | 0% | 0% | 0% | 0% | 100% | 5.0 | 0.00 | 0.0 | 0.0 |
| v1-scale/all-300 | 12 | 100% | 12/12 | 1.00 | 100% | 0% | 0% | 0% | 0% | 300.0 | 0.01 | 14.0 | 282.0 |
| v1-scale/tiered-1000 | 12 | 80% | 6/12 | 0.78 | 0% | 70% | 0% | 10% | 20% | 37.8 | 0.05 | 7.7 | 27.7 |
| v1-scale/tiered-300 | 12 | 100% | 12/12 | 1.00 | 0% | 80% | 0% | 20% | 0% | 39.4 | 0.06 | 4.9 | 30.7 |
| v1-scale/tiered-300-defaults | 12 | 97% | 11/12 | 0.96 | 0% | 80% | 0% | 17% | 3% | 40.0 | 0.06 | 4.8 | 31.9 |
| v1-scale/tiered-300-textonly | 12 | 90% | 9/12 | 0.88 | 0% | 30% | 0% | 60% | 10% | 26.9 | 0.08 | 3.7 | 20.5 |
| v1-scale/tiered-50 | 12 | 100% | 12/12 | 1.00 | 0% | 90% | 0% | 10% | 0% | 19.4 | 0.13 | 2.8 | 12.6 |
| v1-vague/vague-always-on | 12 | 100% | 12/12 | 1.00 | 100% | 0% | 0% | 0% | 0% | 4.0 | 0.62 | 0.0 | 0.0 |
| v1-vague/vague-hook | 12 | 100% | 12/12 | 1.00 | 0% | 50% | 0% | 50% | 0% | 37.7 | 0.06 | 4.4 | 29.8 |
| v1-vague/vague-nohook | 12 | 50% | 0/12 | 0.50 | 0% | 50% | 0% | 0% | 50% | 15.0 | 0.08 | 1.2 | 12.5 |

### Lessons shown per run, by tier (mean)

| arm | core | retrieved | request | file |
|---|---|---|---|---|
| v1-bootstrap/bootstrap-lessons | 3.0 | 0.0 | 0.0 | 0.0 |
| v1-compress/n50-long | 0.0 | 15.0 | 0.0 | 4.6 |
| v1-compress/n50-short | 0.0 | 15.0 | 0.0 | 5.9 |
| v1-compress/real4-long | 4.0 | 0.0 | 0.0 | 0.0 |
| v1-compress/real4-short | 4.0 | 0.0 | 0.0 | 0.0 |
| v1-drift-base/drift-stale | 4.0 | 0.0 | 0.0 | 0.0 |
| v1-drift-strong/drift-strong-final | 4.0 | 0.0 | 0.0 | 0.0 |
| v1-drift-weak/drift-weak-final | 5.0 | 0.0 | 0.0 | 0.0 |
| v1-scale/all-300 | 300.0 | 0.0 | 0.0 | 0.0 |
| v1-scale/tiered-1000 | 0.0 | 14.2 | 0.0 | 23.6 |
| v1-scale/tiered-300 | 0.0 | 15.0 | 0.0 | 24.4 |
| v1-scale/tiered-300-defaults | 15.0 | 15.0 | 0.0 | 10.0 |
| v1-scale/tiered-300-textonly | 0.0 | 15.0 | 0.0 | 11.9 |
| v1-scale/tiered-50 | 0.0 | 15.0 | 0.0 | 4.4 |
| v1-vague/vague-always-on | 4.0 | 0.0 | 0.0 | 0.0 |
| v1-vague/vague-hook | 0.0 | 15.0 | 0.0 | 22.7 |
| v1-vague/vague-nohook | 0.0 | 15.0 | 0.0 | 0.0 |

Missed needed lessons (arm, task: ids missed in at least one run)

- v1-bootstrap/bootstrap-lessons, heldout-disputes: L-2fe6, L-8201, L-8536
- v1-bootstrap/bootstrap-lessons, heldout-invoices: L-2fe6, L-8201, L-8536
- v1-bootstrap/bootstrap-lessons, heldout-ledger-entries: L-2fe6, L-8201
- v1-bootstrap/bootstrap-lessons, heldout-support-tickets: L-8201, L-8536
- v1-compress/n50-long, heldout-disputes: L-8536
- v1-compress/n50-long, heldout-support-tickets: L-8201
- v1-compress/n50-short, heldout-disputes: L-8536
- v1-compress/n50-short, heldout-invoices: L-8201
- v1-compress/n50-short, heldout-support-tickets: L-8201
- v1-drift-base/drift-stale, heldout-disputes: L-2fe6, L-8201, L-8536
- v1-drift-base/drift-stale, heldout-invoices: L-2fe6, L-8201, L-8536
- v1-drift-base/drift-stale, heldout-ledger-entries: L-2fe6, L-8201
- v1-drift-base/drift-stale, heldout-support-tickets: L-8201, L-8536
- v1-drift-strong/drift-strong-final, heldout-disputes: L-2fe6, L-8201, L-8536
- v1-drift-strong/drift-strong-final, heldout-invoices: L-2fe6, L-8201, L-8536
- v1-drift-strong/drift-strong-final, heldout-ledger-entries: L-2fe6, L-8201
- v1-drift-strong/drift-strong-final, heldout-support-tickets: L-8201, L-8536
- v1-drift-weak/drift-weak-final, heldout-disputes: L-2fe6, L-8201, L-8536
- v1-drift-weak/drift-weak-final, heldout-invoices: L-2fe6, L-8201, L-8536
- v1-drift-weak/drift-weak-final, heldout-ledger-entries: L-2fe6, L-8201
- v1-drift-weak/drift-weak-final, heldout-support-tickets: L-8201, L-8536
- v1-scale/tiered-1000, heldout-invoices: L-8201
- v1-scale/tiered-1000, heldout-ledger-entries: L-8201
- v1-scale/tiered-1000, heldout-support-tickets: L-8201
- v1-scale/tiered-300-defaults, heldout-ledger-entries: L-8201
- v1-scale/tiered-300-textonly, heldout-support-tickets: L-8536
- v1-vague/vague-nohook, heldout-disputes: L-2fe6, L-8201
- v1-vague/vague-nohook, heldout-invoices: L-8201
- v1-vague/vague-nohook, heldout-ledger-entries: L-8201
- v1-vague/vague-nohook, heldout-support-tickets: L-8201

### Tokens per call, cache reads, cost (means per run; call = generation/step)

| arm | runs | input tok/call | output tok/call | cache read tok/call | cache read tok/run | cache write tok/run | 1st-gen input (trace) | cacheRead/gen (trace) | calls/run | tool calls/run | wall s | cost $/run | cost $ total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1-baselines/all-1000 | 18 | 9,760 | 425 | 71,314 | 1,930,365 | 0 | 58,460 | 71,230 | 26.9 | 27.2 | 143 | 0.845 | 15.22 |
| v1-baselines/all-300 | 18 | 9,463 | 420 | 45,265 | 1,198,105 | 0 | 32,521 | 45,265 | 26.3 | 27.3 | 136 | 0.718 | 12.92 |
| v1-baselines/all-50 | 18 | 8,436 | 392 | 36,385 | 1,003,585 | 0 | 23,247 | 36,279 | 26.9 | 27.6 | 132 | 0.643 | 11.57 |
| v1-baselines/n50-long | 18 | 8,814 | 419 | 35,920 | 914,661 | 0 | 24,182 | 35,920 | 25.2 | 26.3 | 140 | 0.620 | 11.15 |
| v1-baselines/n50-short | 18 | 8,345 | 394 | 36,051 | 1,031,499 | 0 | 23,451 | 36,051 | 28.1 | 28.8 | 132 | 0.669 | 12.05 |
| v1-baselines/none | 18 | 8,816 | 358 | 39,081 | 1,184,036 | 0 | 20,919 | 38,973 | 29.7 | 29.9 | 132 | 0.719 | 12.94 |
| v1-baselines/real4-long | 18 | 9,410 | 393 | 36,133 | 974,477 | 0 | 21,576 | 36,133 | 26.3 | 26.6 | 135 | 0.673 | 12.11 |
| v1-baselines/real4-short | 18 | 7,723 | 376 | 35,238 | 958,542 | 0 | 21,512 | 35,136 | 26.8 | 27.4 | 124 | 0.600 | 10.80 |
| v1-bootstrap/bootstrap-lessons | 18 | 7,931 | 358 | 32,769 | 878,175 | 0 | 21,024 | 32,691 | 26.9 | 27.5 | 117 | 0.583 | 10.50 |
| v1-compress/n50-long | 18 | 8,430 | 412 | 38,502 | 1,171,945 | 0 | 21,565 | 38,398 | 29.9 | 30.6 | 167 | 0.726 | 13.06 |
| v1-compress/n50-short | 18 | 8,933 | 394 | 38,065 | 1,134,957 | 0 | 21,339 | 38,065 | 28.9 | 30.4 | 139 | 0.726 | 13.06 |
| v1-compress/real4-long | 18 | 8,358 | 439 | 34,047 | 886,207 | 0 | 21,126 | 33,981 | 25.0 | 25.4 | 128 | 0.616 | 11.09 |
| v1-compress/real4-short | 18 | 7,730 | 408 | 34,838 | 967,120 | 0 | 21,062 | 34,727 | 26.9 | 27.9 | 141 | 0.620 | 11.16 |
| v1-drift-base/drift-stale | 18 | 7,966 | 388 | 39,818 | 1,193,640 | 0 | 21,066 | 39,713 | 29.8 | 31.1 | 147 | 0.709 | 12.77 |
| v1-drift-strong/drift-strong-final | 18 | 8,640 | 374 | 33,885 | 877,107 | 0 | 21,051 | 33,826 | 24.8 | 25.9 | 124 | 0.585 | 10.54 |
| v1-drift-weak/drift-weak-final | 18 | 7,939 | 366 | 34,218 | 963,141 | 0 | 21,064 | 34,164 | 27.8 | 28.7 | 134 | 0.624 | 11.23 |
| v1-scale/all-300 | 18 | 8,958 | 406 | 38,244 | 1,084,720 | 0 | 26,663 | 38,244 | 28.0 | 28.8 | 150 | 0.704 | 12.68 |
| v1-scale/tiered-1000 | 17 | 8,154 | 380 | 37,042 | 1,047,869 | 0 | 21,265 | 37,001 | 28.1 | 28.5 | 146 | 0.659 | 11.21 |
| v1-scale/tiered-300 | 18 | 7,547 | 422 | 38,189 | 1,076,041 | 0 | 21,269 | 38,189 | 27.4 | 28.0 | 139 | 0.647 | 11.65 |
| v1-scale/tiered-300-defaults | 18 | 7,564 | 390 | 34,470 | 1,012,727 | 0 | 21,556 | 34,393 | 29.1 | 29.1 | 138 | 0.654 | 11.77 |
| v1-scale/tiered-300-textonly | 18 | 7,749 | 400 | 35,419 | 943,074 | 0 | 21,254 | 35,419 | 26.1 | 26.8 | 137 | 0.599 | 10.79 |
| v1-scale/tiered-50 | 18 | 8,618 | 421 | 34,743 | 985,946 | 0 | 21,278 | 34,605 | 27.3 | 28.3 | 145 | 0.676 | 12.17 |
| v1-vague/vague-always-on | 18 | 7,999 | 449 | 34,500 | 878,437 | 0 | 21,074 | 34,500 | 24.9 | 26.1 | 125 | 0.596 | 10.73 |
| v1-vague/vague-hook | 17 | 8,243 | 404 | 35,348 | 988,701 | 0 | 21,269 | 35,348 | 27.7 | 28.5 | 129 | 0.659 | 11.21 |
| v1-vague/vague-nohook | 18 | 8,185 | 380 | 37,763 | 1,120,745 | 0 | 21,273 | 37,685 | 27.9 | 28.8 | 133 | 0.653 | 11.75 |
| v1-vague/vague-none | 18 | 8,254 | 390 | 36,604 | 1,115,616 | 0 | 20,928 | 36,476 | 29.6 | 30.2 | 146 | 0.706 | 12.70 |

## Topic switch

### Topic switch: request 2 outcome and retrieval (scored on request 2 only)

| arm | sessions | req2 heldout pass | req2 heldout checks | req2 control pass | same session | recall (any time) | already shown in turn 1 | added after request 2 (request/file tier) |
|---|---|---|---|---|---|---|---|---|
| v1-topic/always-on | 18 | 7/9 | 43/54 | 6/6 | 17/18 | 100% | 100% | 0% |
| v1-topic/frozen | 18 | 5/9 | 45/54 | 6/6 | 18/18 | 43% | 43% | 0% |
| v1-topic/none | 18 | 0/9 | 28/54 | 6/6 | 18/18 | - | - | - |
| v1-topic/per-request | 18 | 4/9 | 49/54 | 6/6 | 18/18 | 77% | 43% | 33% |

### Topic switch: per-turn tokens and cost (means)

| arm | turn1 input tok/call | turn2 input tok/call | turn2 cache read tok | turn2 cache write tok | turn2 tool calls | turn2 wall s | turn1 cost $ | turn2 cost $ |
|---|---|---|---|---|---|---|---|---|
| v1-topic/always-on | 9,018 | 6,873 | 979,227 | 0 | 19.8 | 104 | 0.199 | 0.485 |
| v1-topic/frozen | 8,429 | 8,556 | 1,096,610 | 0 | 23.4 | 115 | 0.173 | 0.583 |
| v1-topic/none | 7,693 | 7,299 | 953,261 | 0 | 20.8 | 113 | 0.175 | 0.464 |
| v1-topic/per-request | 9,489 | 8,507 | 1,050,520 | 0 | 21.3 | 110 | 0.193 | 0.549 |

### Drift: v1-drift-strong

| iteration | sessions | corrections | corrections/session | first-attempt LGTM | sessions w/ correction signal | approved lessons at start |
|---|---|---|---|---|---|---|
| 1 | 4 | 6 | 1.5 | 0 | 4 | 4 |
| 2 | 4 | 0 | 0.0 | 4 | 0 | 4 |

| iteration | reflect rc | reflect wall s (tokens/cost not reported by `learn reflect`) | signals |
|---|---|---|---|
| 1 | 0 | 70.2 | 5 |
| 2 | - | - | no signals |

| iteration | gate | lessons before | after | stale lessons remaining | new lessons |
|---|---|---|---|---|---|
| 1 | promote | 4 | 4 | L-5c1d,L-a37e,L-9e42,L-7b60 | 0 |

Final approved: 4 lessons; stale seed L-5c1d, L-a37e, L-9e42, L-7b60; remaining stale: L-5c1d, L-a37e, L-9e42, L-7b60; retired: none.

### Drift: v1-drift-weak

| iteration | sessions | corrections | corrections/session | first-attempt LGTM | sessions w/ correction signal | approved lessons at start |
|---|---|---|---|---|---|---|
| 1 | 4 | 6 | 1.5 | 0 | 4 | 4 |
| 2 | 4 | 6 | 1.5 | 0 | 3 | 5 |

| iteration | reflect rc | reflect wall s (tokens/cost not reported by `learn reflect`) | signals |
|---|---|---|---|
| 1 | 0 | 9.0 | 5 |
| 2 | 0 | 7.3 | 4 |

| iteration | gate | lessons before | after | stale lessons remaining | new lessons |
|---|---|---|---|---|---|
| 1 | promote | 4 | 5 | L-5c1d,L-9e42 | 3 |
| 2 | promote | 5 | 5 | none | 2 |

Final approved: 5 lessons; stale seed L-5c1d, L-a37e, L-9e42, L-7b60; remaining stale: none; retired: L-7b60, L-a37e, L-5c1d, L-9e42.

### Bootstrap: v1-bootstrap (source /Users/anandgupta/codebase/altimate-code/.claude/worktrees/rsi/experiments/rsi-workspace/harness/runs/corr-main, model google-vertex/gemini-3.1-pro-preview)

| sessions | signals | corrections | tool failures | est. input tok (dry run) | reflections | candidates added | edited | promoted lessons | input tok | output tok | est. cost $ | wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 8 | 5 | 5 | 0 | 20245 | 4 | 3 | 2 | 3 | 28017 | 6653 | 0.199544 | 53.5 |

Real lessons recovered (keyword heuristic, verify by hand): L-2fe6: L-b1b6; L-8536: L-ab7e; L-8201: L-a97a

- `L-b1b6` In staging models, convert `*_cents` columns using `{{ cents_to_dollars(...) }}` and rename them without the `_cents` suffix.
- `L-ab7e` In staging models, filter out deleted rows with `where not _is_deleted` in the `source` CTE and drop the `_is_deleted` column.
- `L-a97a` Wrap every timestamp column in `{{ to_utc('col') }}` and rename it with an `_at` suffix in both SQL and YAML.

