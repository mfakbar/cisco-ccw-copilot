# Requirement extraction and live CCW evaluation

Date: 2026-08-23  
Target: authenticated `UCSC-C220-M8S` Product Configuration page, Global Asia-Pac price list (USD)

## Scope and coverage

The benchmark contains 16 natural-language cases and 362 structured assertions. The suite covers compact, spaced, hyphenated, dual-socket, single-socket, and total-core-only CPU forms; 2 through 128 cores; optional 2.0 through 3.0 GHz clock requirements; aggregate and discrete DIMM memory; single, multiple, raw, usable, ambiguous, and JBOD storage; RAID 1/5/6/10; explicit card topology and abstract port topology; SFP, QSFP, BASE-T, and Fibre Channel; mixed Ethernet/FC groups; partial-category inputs; and lead-time targets from 14 through 182 days.

The structured inputs and ground truth are in `benchmark/requirement-cases.json`.

## Extraction results

| Path | Result | Elapsed | Discrepancies |
|---|---:|---:|---:|
| Local AI, `qwen3.5:4b-q4_K_M` | 362/362 (100%) | 269.701 s | 0 |
| Deterministic grounding | 362/362 (100%) | 14 ms | 0 |

The local AI path was accurate after deterministic source grounding, but latency ranged from 5.738 to 52.229 seconds per case. Accuracy is acceptable for this suite; local-model latency remains unsuitable for a strict sub-10-second interactive SLA.

The benchmark runner now preserves the full expected assertion denominator when a provider call fails. A provider outage therefore reports `0/362`, not the misleading `0/16` produced by counting one failed call as one assertion.

## Live catalog scan

The active CCW page was scanned read-only across 13 supported categories:

- 383 raw option rows; 378 rows with a visible list price.
- 198 recommendation-relevant CPU, memory, riser, RAID/HBA, storage, NIC, FC HBA, GPU, and M.2 options were evaluated.
- The visible CCW configuration summary was identical before and after every navigation and at the end of the benchmark.
- No component approval, `Done`, quote submission, or configuration mutation was performed.

One fresh live-catalog defect was found and fixed: a SKU such as `UCS-SD19TBM1XEV-D` was previously parsed as 19 TB even though its description states 1.9 TB. Capacity parsing now ignores capacity-like digits embedded in SKU tokens. The affected 24 TB RAID5 test changed from an unsafe 3-drive result to a valid 8-drive result using 3.8 TB drives.

NIC ranking was also corrected. When an explicit connector family is requested, an exact SFP/QSFP/BASE-T match now ranks ahead of slot placement and price. The existing non-FC fallback remains available only when the catalog has no exact media match; Fibre Channel remains a hard media constraint.

## Per-case result on the active C220 M8 catalog

| Case | Live result | Interpretation |
|---|---|---|
| `cpu-2x-aggregate-memory-explicit-cards` | Unsatisfied | CPU, memory, storage, NIC, and risers found; RAID controller is 56 days versus 45-day target. |
| `cpu-spaced-x-dimm-breakdown-quad-nic` | Unsatisfied | AMD request cannot be met on this Intel C220 page; 14-day target also excludes the required components. |
| `cpu-hyphen-total-cores-abstract-ports` | Complete | Full CPU, memory, RAID6 storage, SFP NIC, and riser plan. |
| `dual-socket-multiple-raid-groups-dual-nic` | Unsatisfied | Both storage groups size correctly; RAID controller is 56 days versus 45-day target. |
| `cores-only-jbod-drive-breakdown-two-cards` | Unsatisfied | 14-day target and exact 10 x 1.92 TB NVMe / two-card 100G topology are unavailable on this page. |
| `small-cores-no-socket-jbod-base-t` | Complete | One CPU was inferred, with memory, raw JBOD, 1G BASE-T NIC, and riser. |
| `cpu-x-per-cpu-compact-dimms-quad-port` | Unsatisfied | CPU, exact DIMMs, RAID10 drives, quad-port NIC, and riser found; RAID controller misses 45-day target. |
| `cpu-spaced-x-raw-drive-set-dual-ports` | Unsatisfied | Exact 14-day CPU, memory, storage, and NIC plan is unavailable. |
| `cpu-hyphen-dimms-usable-raid-abstract-links` | Complete | Corrected live capacity parsing produces a valid eight-drive 24 TB RAID5 plan. |
| `dual-socket-mixed-raid-groups-cards-first` | Unsatisfied | Requested 128 cores at 3.0 GHz is unavailable; RAID controller also misses 45-day target. |
| `low-core-ambiguous-capacity-dual-port-card` | Unsatisfied with clarification | Raw versus usable storage is correctly skipped and clarified; the 14-day platform constraints are also unsatisfied. |
| `cores-only-dimms-raw-ssd-fc-cards` | Complete | Full CPU, exact DIMMs, 8 x 960 GB SSD JBOD, two 2-port 32G FC HBAs, and risers. |
| `keyed-two-usable-raid-groups-and-mixed-nics` | Complete | Two RAID groups, two SFP cards, one 32G FC card, and three compatible risers. RAID1 uses exactly two drives. |
| `prose-two-raid-groups-and-cards-with-fc` | Complete | Two RAID groups plus separate Ethernet and FC card groups without slot reuse. |
| `keyed-three-typed-raid-groups-and-mixed-nics` | Complete | Independent SSD, HDD RAID1, and U.3 NVMe groups plus mixed NICs. RAID1 uses exactly two drives. |
| `partial-cpu-memory-usable-storage-and-abstract-mixed-nics` | Partial, valid | CPU, memory, 4x10G Ethernet, and 4x32G FC are recommended; usable storage is skipped pending the required RAID clarification. |

Summary: 7 complete, 1 valid partial, 8 truthfully unsatisfied, 0 empty, and 0 pipeline anomalies after fixes. “Unsatisfied” means the live C220 M8 catalog or lead-time constraint cannot produce a complete valid configuration; it is not an extraction failure.

## Regression gates

- Requirement extraction: 362/362 assertions.
- Automated tests: 186/186.
- TypeScript typecheck: passed.
- ESLint: passed.
- All workspaces and the production extension bundle: built successfully.
- Live recommendation invariants: 0 anomalies across 16 cases.

Chrome must reload the unpacked `packages/extension/dist` directory before the already-installed side panel uses this rebuilt bundle. The browser automation environment cannot navigate to `chrome://extensions`, so the live benchmark used the rebuilt parser/optimizer directly against the fresh, fingerprinted CCW scan rather than claiming that the installed side panel had already reloaded.

