# UCS C240 M8 CCW recommendation validation

Date: 2026-08-23  
Model: `UCSC-C240-M8SX`  
Scope: live CCW catalog and recommendation pipeline only. Requirement extraction and Ollama were not used.

## Live CCW scan

- Scanned 24 recommendation-relevant CCW categories and 1,004 raw option rows.
- Normalized 510 selectable hardware and dependency options for recommendation testing.
- Covered 25 CPU, 9 memory, 8 riser, 3 RAID controller, 140 storage, 219 NIC, 52 Fibre Channel HBA, 45 physical GPU, 3 boot-controller, 5 boot-drive, and 1 GPU-air-duct option instances.
- Preserved all 13 C240 PCIe layout labels, 24 front-drive capacity, both rear-drive categories, MLOM/OCP, and M.2 paths.
- Restored the original `R1A Slot2 x16 FH` view after scanning.
- The selected-configuration fingerprint was unchanged before and after the scan (normalized length 730). No component was selected, approved, or submitted.

## Fixes applied

1. Classify `UCSC-GPUAD-240M8` as an accessory rather than GPU hardware.
2. Classify NVIDIA license/subscription rows before the generic word “GPU” rule, preventing software from being recommended as a GPU.
3. Parse multi-chip GPU memory such as `4X16GB` as 64 GB.
4. Include the C240 GPU air duct in the approved GPU component, together with the physical GPU.
5. Prefer a low-power compatible GPU for an explicit one-CPU C240 topology.
6. Wait for both CCW selection state and the matching breadcrumb before accepting a category’s rows, preventing stale-category scans.
7. Added a checkpointed live-catalog normalizer and a structured-ground-truth recommendation mode, so the recommendation benchmark runs without extraction or Ollama.
8. Added component/category integrity checks, including GPU accessory/license detection and RAID 1 exact-two-drive validation.

## Recommendation results

The 16 shared structured hardware cases plus 2 C240 GPU cases produced:

| Outcome | Count | Interpretation |
|---|---:|---|
| Complete | 12 | All requested categories received compatible live C240 components and dependencies. |
| Partial | 1 | CPU, memory, and mixed Ethernet/FC NICs were recommended; usable storage was skipped until RAID is clarified. |
| Unsatisfied | 5 | Four cases cannot meet the live 14-day component deadline; one 2-socket, 128-core, 3.0 GHz case has no matching live C240 CPU. |
| Empty | 0 | Every case produced either recommendations or a specific explanation. |
| Anomalies | 0 | No invalid SKU references, wrong component categories, quantity errors, total errors, legacy IDs, or RAID 1 sizing errors. |

Representative verified recommendations:

- Mixed Ethernet and FC: two `UCSC-P-I8D25GF-D` adapters plus one `UCSC-P-Q6D32GF-D`, placed without slot reuse and with C240 riser kits.
- Three typed RAID groups: SSD, HDD, and U.3 NVMe groups sized independently with one compatible controller.
- GPU-only: `UCSC-GPU-A16-D` plus `UCSC-GPUAD-240M8` and the required C240 riser kits; no NVIDIA license row is treated as hardware.
- 96 GB GPU: two `UCS-CPU-I6520P`, one `UCSC-GPU-RTXP6000`, `UCSC-GPUAD-240M8`, and all required riser kits.

Detailed machine-readable results are in `benchmark/c240-recommendation-results.json`.

## Verification

- Unit/regression tests: 190 passed across 13 files.
- Type checking: passed.
- Lint: passed.
- Workspace build: passed, including a rebuilt Chrome extension package.

## Installed-extension boundary

The rebuilt files are in `packages/extension/dist`. Chrome must reload the unpacked extension once before the open CCW tab can execute these new files. Chrome automation cannot reload `chrome://extensions`, so that final browser reload remains a manual step.
