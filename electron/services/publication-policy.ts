export const MIN_PUBLICATION_YEAR = 2025

export function isEligiblePublicationYear(year: unknown): year is number {
  return Number.isInteger(year) && Number(year) >= MIN_PUBLICATION_YEAR
}

export function getConfiguredMinYear(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? MIN_PUBLICATION_YEAR), 10)
  return Math.max(MIN_PUBLICATION_YEAR, Number.isFinite(parsed) ? parsed : MIN_PUBLICATION_YEAR)
}
