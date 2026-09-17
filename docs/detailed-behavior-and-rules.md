# Detailed behavior and rules

This reference describes supported behavior and implementation boundaries. New users can follow the onboarding and user journey in the [README](../README.md) without reading it first.

## Extraction and editing

- The selected LLM processes the complete RFP first. Deterministic extraction remains available as a provider-failure fallback.
- Normalization enforces supported field IDs, units, CPU topology, NIC topology, RAID meaning, and ambiguity handling.
- Source evidence can reference a PDF page, DOCX paragraph, spreadsheet range, or pasted text.
- CPU sockets, total cores, and cores per socket can independently constrain a recommendation.
- Memory capacity, DIMM count, and DIMM size can independently constrain a recommendation. Memory is normalized to GB using `1 TB = 1024 GB`.
- Drive-group capacity and an explicit drive population can both be used. Missing categories are skipped instead of blocking categories that are ready.
- Conflicting server profiles and material ambiguity require clarification rather than a silent assumption.

## Lead time and ranking

- The delivery target is evaluated against the slowest selected component.
- Components with unknown lead time are not considered compliant when a target is set.
- Lowest complete list price is considered only after compatibility, requirements, placement, and lead-time rules pass.
- Options without a numeric CCW price are excluded rather than treated as free.

## Recommendation coverage

- Recommendations cover CPU, memory, standard RAID controllers, no-RAID HBA pass-through, front-facing local storage, PCIe MLOM, riser NICs, M.2 boot controllers, M.2 drives, and applicable GPUs.
- CPU, memory, raw/RAID storage, GPU, NIC port and throughput, PCIe, C-Series, and X-Series foundation constraints are applied before price ranking.
- Explicit per-server CPU socket counts override provider inference.
- C2xx rack servers and X21x compute nodes are limited to 32 DIMM slots by the current structural rules.
- Each recommendation includes its SKU, description, quantity, physical category or slot, list-price contribution, reason, and lead time.

## Storage and boot rules

- Capacity is evaluated independently for each drive group.
- Explicit `raw` or `usable` wording wins. Aggregate capacity plus RAID defaults to usable; drive count plus capacity per drive defaults to raw.
- Usable capacity without a RAID level requires clarification.
- RAID 1 uses exactly two identical drives. RAID 1, 5, 6, and 10 overhead is included when calculating usable capacity.
- A single M.2 boot drive is treated as non-mirrored/JBOD. The default mirrored boot layout is two identical M.2 drives in RAID 1.
- M.2 boot drives use the M.2 controller. Non-M.2 RAID storage uses a compatible standard controller. No-RAID and U.2 pass-through storage use the HBA path.
- Capacity drives are recommended only in scanned front-facing bays, never rear-riser or midplane bays.
- Local-storage results show the raw-to-usable calculation, drive quantity, and placement.

## NIC and PCIe placement rules

- Explicit topology is preserved: card count, ports per card, speed per port, and media are separate constraints.
- SFP, QSFP, RJ45, BASE-T, BASET, UTP, FC, and Fibre Channel wording is recognized.
- FC HBA groups use riser slots first. Requirements that explicitly request VIC or OCP use PCIe MLOM.
- Other Ethernet groups use compatible riser slots first and fall back to PCIe MLOM only when needed.
- Eligible riser choices prefer lower physical PCIe slot numbers and reject known model-specific incompatible mixes.
- Existing scanned CPU, memory, and occupied PCIe selections participate in compatibility checks.

## Supported CCW discovery

The rack-server adapter reads supported processor, memory, standard RAID/HBA, front- and rear-facing storage, PCIe MLOM/OCP, riser-slot, and M.2 boot/drive categories. Slot-specific navigation is retained so the same SKU in different slots is not treated as one option.

Automatic M8 rack profile inference currently recognizes C220/C225 as C22x 1RU and C240/C245 as C24x 2RU. A model suffix of `0` maps to Intel and `5` maps to AMD. Riser slots are discovered from the live page rather than assumed from form factor.

A generic visible-row adapter remains as a fallback. Different generations, localized currencies, and modal workflows require validation against a disposable authenticated draft.

## Security boundaries

- Extension access is requested at runtime only for the active Cisco origin.
- The companion binds only to `127.0.0.1` and requires a random session bearer token.
- The extension does not read Cisco cookies or passwords.
- CircuIT credentials are supplied at runtime, held in memory only, sent through the local companion for the selected request, and never written to Chrome storage or the project.
- Local Ollama keeps supplied RFP text on the Mac. CircuIT sends it to Cisco's internal AI service.
- Scanning does not select components. Approval requires an explicit user action for each component.
- Quote submission and ordering always remain manual.

## Current rule gaps

The included platform limits are safe structural defaults, not a complete Cisco product catalog. Production use still requires model- and generation-specific validation for CPU/socket compatibility, DIMM population and performance, exact RAID/controller support, boot constraints, GPU thermal/power/riser combinations, VIC/riser/slot mappings, X-Series node/chassis/fabric topology, licensing, PSU redundancy, and regional CCW behavior.
