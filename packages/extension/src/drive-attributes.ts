export function driveInterfaceFromText(text: string): string | undefined {
  return /\bSAS\b/i.test(text) ? 'SAS' : /\bSATA\b/i.test(text) ? 'SATA' : /\bNVMe\b/i.test(text) ? 'NVMe' : undefined;
}

export function driveTransferSpeedGbpsFromText(text: string): number | undefined {
  return Number(
    text.match(/\b(?:SAS|SATA)\b[^\n;]{0,40}?\b(\d+(?:\.\d+)?)\s*G(?:bps|b\/s)?\b/i)?.[1]
    ?? text.match(/\b(\d+(?:\.\d+)?)\s*G(?:bps|b\/s)?\b[^\n;]{0,40}?\b(?:SAS|SATA)\b/i)?.[1]
    ?? 0
  ) || undefined;
}

export function driveCapacityGbFromText(text: string): number | undefined {
  const match = text.match(/(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2]!.toUpperCase() === 'TB' ? value * 1000 : value;
}

export function driveTypeFromText(text: string): string {
  const driveInterface = driveInterfaceFromText(text);
  return /\bE3\.?S\b/i.test(text) ? 'E3.S NVMe'
    : /\bU\.2\b/i.test(text) ? 'U.2 NVMe'
    : /\bU\.3\b/i.test(text) ? 'U.3 NVMe'
      : /\bM\.?\s*2\b/i.test(text) ? 'M.2'
        : /\bNVMe\b/i.test(text) ? 'NVMe'
          : /\bSSD\b/i.test(text) ? driveInterface === 'SAS' ? 'SAS SSD' : driveInterface === 'SATA' ? 'SATA SSD' : 'SSD'
            : /\bHDD\b/i.test(text) ? driveInterface === 'SAS' ? 'SAS HDD' : driveInterface === 'SATA' ? 'SATA HDD' : 'HDD' : 'unknown';
}
