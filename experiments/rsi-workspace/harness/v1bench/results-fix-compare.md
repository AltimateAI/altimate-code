> Historical results from before harness hardening. These metrics were not rerun or silently recomputed; interrupted turns, topic-session mismatches, and earlier file-hook confounding may affect them. Use the corrected drivers for new comparisons.

# learn v1 benchmark tables

## Eval arms

### Outcomes (heldout headline excludes support-tickets)

| arm | runs | heldout pass | heldout checks | support-tickets pass | support-tickets checks | control pass | leaks | errors |
|---|---|---|---|---|---|---|---|---|
| v1-fix-scale/tiered-1000 | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 5/6 | 0 | 0 |
| v1-fix-scale/tiered-300 | 18 | 9/9 | 54/54 | 2/3 | 16/18 | 6/6 | 0 | 0 |
| v1-fix-vague/vague-hook | 18 | 9/9 | 54/54 | 3/3 | 18/18 | 5/6 | 0 | 0 |
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
| v1-fix-scale/tiered-1000 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-fix-scale/tiered-300 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| v1-fix-vague/vague-hook | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
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
| v1-fix-scale/tiered-1000 | 5/6 | 5/6 | 5/6 | 5/6 |
| v1-fix-scale/tiered-300 | 6/6 | 6/6 | 6/6 | 6/6 |
| v1-fix-vague/vague-hook | 6/6 | 6/6 | 6/6 | 5/6 |
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

The no-lesson baseline below is derived from its arm definition and `needs.json`: 12 runs need
30 lesson slots in total, and none can be shown. This adds the omitted comparison without rerunning or rescoring outcomes.

| arm | runs w/ needs | recall (lesson slots) | runs with all needed | mean per-run recall | from core | from retrieved | from request | from file | missed | lessons shown/run | precision | near shown | distractors shown |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1-fix-scale/tiered-1000 | 12 | 100% | 12/12 | 1.00 | 0% | 70% | 0% | 30% | 0% | 40.0 | 0.06 | 10.1 | 26.0 |
| v1-fix-scale/tiered-300 | 12 | 100% | 12/12 | 1.00 | 0% | 80% | 0% | 20% | 0% | 38.6 | 0.06 | 5.3 | 29.3 |
| v1-fix-vague/vague-hook | 12 | 100% | 12/12 | 1.00 | 0% | 50% | 0% | 50% | 0% | 38.6 | 0.06 | 4.8 | 29.8 |
| v1-scale/all-300 | 12 | 100% | 12/12 | 1.00 | 100% | 0% | 0% | 0% | 0% | 300.0 | 0.01 | 14.0 | 282.0 |
| v1-scale/tiered-1000 | 12 | 80% | 6/12 | 0.78 | 0% | 70% | 0% | 10% | 20% | 37.8 | 0.05 | 7.7 | 27.7 |
| v1-scale/tiered-300 | 12 | 100% | 12/12 | 1.00 | 0% | 80% | 0% | 20% | 0% | 39.4 | 0.06 | 4.9 | 30.7 |
| v1-scale/tiered-300-defaults | 12 | 97% | 11/12 | 0.96 | 0% | 80% | 0% | 17% | 3% | 40.0 | 0.06 | 4.8 | 31.9 |
| v1-scale/tiered-300-textonly | 12 | 90% | 9/12 | 0.88 | 0% | 30% | 0% | 60% | 10% | 26.9 | 0.08 | 3.7 | 20.5 |
| v1-scale/tiered-50 | 12 | 100% | 12/12 | 1.00 | 0% | 90% | 0% | 10% | 0% | 19.4 | 0.13 | 2.8 | 12.6 |
| v1-vague/vague-always-on | 12 | 100% | 12/12 | 1.00 | 100% | 0% | 0% | 0% | 0% | 4.0 | 0.62 | 0.0 | 0.0 |
| v1-vague/vague-hook | 12 | 100% | 12/12 | 1.00 | 0% | 50% | 0% | 50% | 0% | 37.7 | 0.06 | 4.4 | 29.8 |
| v1-vague/vague-nohook | 12 | 50% | 0/12 | 0.50 | 0% | 50% | 0% | 0% | 50% | 15.0 | 0.08 | 1.2 | 12.5 |
| v1-vague/vague-none | 12 | 0% | 0/12 | 0.00 | 0% | 0% | 0% | 0% | 100% | 0.0 | - | 0.0 | 0.0 |

### Lessons shown per run, by tier (mean)

| arm | core | retrieved | request | file |
|---|---|---|---|---|
| v1-fix-scale/tiered-1000 | 0.0 | 15.0 | 0.0 | 25.0 |
| v1-fix-scale/tiered-300 | 0.0 | 15.0 | 0.0 | 23.6 |
| v1-fix-vague/vague-hook | 0.0 | 15.0 | 0.0 | 23.6 |
| v1-scale/all-300 | 300.0 | 0.0 | 0.0 | 0.0 |
| v1-scale/tiered-1000 | 0.0 | 14.2 | 0.0 | 23.6 |
| v1-scale/tiered-300 | 0.0 | 15.0 | 0.0 | 24.4 |
| v1-scale/tiered-300-defaults | 15.0 | 15.0 | 0.0 | 10.0 |
| v1-scale/tiered-300-textonly | 0.0 | 15.0 | 0.0 | 11.9 |
| v1-scale/tiered-50 | 0.0 | 15.0 | 0.0 | 4.4 |
| v1-vague/vague-always-on | 4.0 | 0.0 | 0.0 | 0.0 |
| v1-vague/vague-hook | 0.0 | 15.0 | 0.0 | 22.7 |
| v1-vague/vague-nohook | 0.0 | 15.0 | 0.0 | 0.0 |
| v1-vague/vague-none | 0.0 | 0.0 | 0.0 | 0.0 |

Missed needed lessons (arm, task: ids missed in at least one run)

- v1-scale/tiered-1000, heldout-invoices: L-8201
- v1-scale/tiered-1000, heldout-ledger-entries: L-8201
- v1-scale/tiered-1000, heldout-support-tickets: L-8201
- v1-scale/tiered-300-defaults, heldout-ledger-entries: L-8201
- v1-scale/tiered-300-textonly, heldout-support-tickets: L-8536
- v1-vague/vague-nohook, heldout-disputes: L-2fe6, L-8201
- v1-vague/vague-nohook, heldout-invoices: L-8201
- v1-vague/vague-nohook, heldout-ledger-entries: L-8201
- v1-vague/vague-nohook, heldout-support-tickets: L-8201
- v1-vague/vague-none, heldout-disputes: L-2fe6, L-8201, L-8536
- v1-vague/vague-none, heldout-invoices: L-2fe6, L-8201, L-8536
- v1-vague/vague-none, heldout-ledger-entries: L-2fe6, L-8201
- v1-vague/vague-none, heldout-support-tickets: L-8201, L-8536

### Tokens per call, cache reads, cost (means per run; call = generation/step)

| arm | runs | input tok/call | output tok/call | cache read tok/call | cache read tok/run | cache write tok/run | 1st-gen input (trace) | cacheRead/gen (trace) | calls/run | tool calls/run | wall s | cost $/run | cost $ total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1-fix-scale/tiered-1000 | 18 | 8,056 | 443 | 36,451 | 974,325 | 0 | 21,446 | 36,331 | 26.0 | 26.6 | 124 | 0.629 | 11.32 |
| v1-fix-scale/tiered-300 | 18 | 8,798 | 449 | 40,232 | 1,089,707 | 0 | 21,464 | 40,127 | 26.0 | 26.3 | 140 | 0.685 | 12.33 |
| v1-fix-vague/vague-hook | 18 | 8,233 | 441 | 38,035 | 1,115,257 | 0 | 21,449 | 37,977 | 28.7 | 28.9 | 154 | 0.711 | 12.79 |
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
| v1-fix-topic/per-request | 18 | 7/9 | 49/54 | 6/6 | 18/18 | 60% | 43% | 17% |
| v1-topic/always-on | 18 | 7/9 | 43/54 | 6/6 | 17/18 | 100% | 100% | 0% |
| v1-topic/frozen | 18 | 5/9 | 45/54 | 6/6 | 18/18 | 43% | 43% | 0% |
| v1-topic/none | 18 | 0/9 | 28/54 | 6/6 | 18/18 | - | - | - |
| v1-topic/per-request | 18 | 4/9 | 49/54 | 6/6 | 18/18 | 77% | 43% | 33% |

### Topic switch: per-turn tokens and cost (means)

| arm | turn1 input tok/call | turn2 input tok/call | turn2 cache read tok | turn2 cache write tok | turn2 tool calls | turn2 wall s | turn1 cost $ | turn2 cost $ |
|---|---|---|---|---|---|---|---|---|
| v1-fix-topic/per-request | 9,151 | 8,090 | 963,366 | 0 | 20.6 | 106 | 0.203 | 0.525 |
| v1-topic/always-on | 9,018 | 6,873 | 979,227 | 0 | 19.8 | 104 | 0.199 | 0.485 |
| v1-topic/frozen | 8,429 | 8,556 | 1,096,610 | 0 | 23.4 | 115 | 0.173 | 0.583 |
| v1-topic/none | 7,693 | 7,299 | 953,261 | 0 | 20.8 | 113 | 0.175 | 0.464 |
| v1-topic/per-request | 9,489 | 8,507 | 1,050,520 | 0 | 21.3 | 110 | 0.193 | 0.549 |
